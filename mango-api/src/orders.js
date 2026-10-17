// Order lifecycle: placing, paying, rebalancing, packing, delivering and
// cancelling. MandiMangoes never refunds: when stock goes bad the engine swaps it,
// moves the order to the next date with stock, or flags it at-risk for ops.
import { randomInt } from 'node:crypto'
import { configVersion, getConfig } from './config.js'
import { addDays, diffDays, now } from './clock.js'
import { checkCapacity, chooseSlot, earliestDeliveryDate, nextDeliveryDay, orderableDates } from './delivery.js'
import { badRequest, conflict, HttpError, notFound, StockError } from './errors.js'
import { newId } from './ids.js'
import { allocate, commitHeld, ledger, lineInfo, pack, release, restock, sellableAs } from './inventory.js'
import { logger } from './logger.js'
import { metrics } from './metrics.js'
import { enqueue, enqueueForEvent } from './notify.js'

/** Orders that still own stock and can be rebalanced. */
export const OPEN_STATUSES = ['PAYMENT_PENDING', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED']
/** Before packing, stock is held or committed and can still be swapped. */
const SWAPPABLE_STATUSES = ['PAYMENT_PENDING', 'CONFIRMED', 'PROCESSING']

const TRANSITIONS = {
  CONFIRMED: ['PROCESSING'],
  PROCESSING: ['PACKED'],
  PACKED: ['SHIPPED'],
  SHIPPED: ['OUT_FOR_DELIVERY'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'DELIVERY_FAILED'],
  DELIVERY_FAILED: ['OUT_FOR_DELIVERY', 'RTO'],
}
const FLOW = ['PAYMENT_PENDING', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED']
const ADMIN_CANCELLABLE = ['PAYMENT_PENDING', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY']
/** Boxes not yet handed to the courier go back on the shelf when cancelled. */
const RESTOCKABLE = ['PROCESSING', 'PACKED']
const CUSTOMER_CANCELLABLE = ['PAYMENT_PENDING', 'CONFIRMED', 'PROCESSING']

export const SYSTEM = { type: 'system', id: 'system' }

export async function addEvent(c, orderId, from, to, actor, reason = null) {
  const id = newId('evt')
  await c.query(
    `INSERT INTO order_events (id, order_id, from_status, status, actor, reason, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, orderId, from, to, actor.label ?? actor.id, reason, now()],
  )
  await enqueueForEvent(c, orderId, id, from, to)
  return id
}

async function lockOrder(c, orderId) {
  const { rows } = await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId])
  if (!rows.length) throw notFound('Order not found')
  return rows[0]
}

const stockRows = async (c, orderId, states) =>
  (await c.query('SELECT * FROM order_stock WHERE order_id = $1 AND state = ANY($2) ORDER BY id', [orderId, states])).rows

const orderItems = async (c, orderId) =>
  (await c.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY sku, stage', [orderId])).rows

/**
 * Inserts an order with its items and allocates stock for every item.
 * With `allOrNothing` a shortfall throws 409 STOCK_INSUFFICIENT (and the
 * caller's transaction rolls back); otherwise the order is flagged at-risk.
 */
export async function createOrder(c, o, actor) {
  const id = newId('ord')
  const { rows } = await c.query(`SELECT 'ORD-' || nextval('order_seq') AS number`)
  const number = rows[0].number
  const subtotal = o.lines.reduce((s, l) => s + l.unitPrice * l.qty, 0)
  const discount = o.discount ?? 0
  const total = subtotal - discount
  const boxes = o.lines.reduce((s, l) => s + l.qty, 0)
  await checkCapacity(c, o.deliveryDate, boxes)
  const slotId = await chooseSlot(c, o.deliveryDate, boxes, o.slotId ?? null, { strict: Boolean(o.strictSlot) })
  await c.query(
    `INSERT INTO orders (id, number, customer_id, customer_name, phone, status, delivery_date, placed_at, pincode,
                         delivery_address, subtotal, total, payment_status, payment_method, payment_amount,
                         hold_expires_at, config_version, replacement_for, slot_id, channel,
                         discount, promo_code, gift_recipient_name, gift_recipient_phone, gift_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $20, $12, $13, $14, $15, $16, $17, $18, $19, $21, $22, $23, $24, $25)`,
    [
      id, number, o.customerId ?? null, o.customerName ?? null, o.phone ?? null, o.status, o.deliveryDate, now(),
      o.pincode ?? null, o.address ?? null, subtotal, o.paymentStatus ?? null, o.paymentMethod ?? null,
      o.paymentStatus ? total : null, o.holdExpiresAt ?? null, configVersion(), o.replacementFor ?? null, slotId, o.channel ?? 'app',
      total, discount, o.promoCode ?? null, o.gift?.recipientName ?? null, o.gift?.recipientPhone ?? null, o.gift?.message ?? null,
    ],
  )
  for (const l of [...o.lines].sort((a, b) => a.sku.localeCompare(b.sku) || a.stage.localeCompare(b.stage))) {
    await c.query(
      `INSERT INTO order_items (id, order_id, sku, quantity, stage, unit_price, line_price) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [newId('itm'), id, l.sku, l.qty, l.stage, l.unitPrice, l.unitPrice * l.qty],
    )
  }
  await addEvent(c, id, null, o.status, actor, o.eventReason ?? null)
  const order = { id, number, delivery_date: o.deliveryDate, status: o.status, slot_id: slotId }
  const state = o.status === 'PAYMENT_PENDING' ? 'held' : 'committed'
  const short = []
  for (const l of [...o.lines].sort((a, b) => a.sku.localeCompare(b.sku))) {
    const got = await allocate(c, { orderId: id, orderNumber: number, deliveryDate: o.deliveryDate, sku: l.sku, stage: l.stage, qty: l.qty, state, actor })
    if (got < l.qty) {
      if (o.allOrNothing) {
        metrics.holdFailures.inc()
        throw new StockError(l.sku)
      }
      short.push(`${l.qty - got}× ${l.sku} ${l.stage} unallocated`)
    }
  }
  if (short.length) await setRisk(c, order, short, actor)
  return order
}

async function setRisk(c, order, problems, actor) {
  const reason = problems.length ? problems.join('; ') : null
  const { rows } = await c.query('SELECT at_risk, at_risk_reason FROM orders WHERE id = $1', [order.id])
  const prev = rows[0]
  if (prev.at_risk === problems.length > 0 && prev.at_risk_reason === reason) return
  await c.query('UPDATE orders SET at_risk = $2, at_risk_reason = $3 WHERE id = $1', [order.id, problems.length > 0, reason])
  await addEvent(c, order.id, order.status, order.status, actor, reason ? `At risk: ${reason}` : 'No longer at risk')
}

/**
 * Re-checks every allocation of an order against its delivery date (age cap,
 * stage, batch health). Invalid stock is swapped to another batch with the
 * same SKU and stage, FEFO; missing stock is filled if any appeared; anything
 * left unresolved flags the order at-risk. Never cancels.
 */
export async function rebalanceOrder(c, orderId, actor = SYSTEM) {
  const o = await lockOrder(c, orderId)
  if (!OPEN_STATUSES.includes(o.status)) return null
  const cfg = getConfig()
  const swappable = SWAPPABLE_STATUSES.includes(o.status)
  const state = o.status === 'PAYMENT_PENDING' ? 'held' : 'committed'
  const problems = []
  let changed = false

  // 1. Swap stock that is no longer valid for the delivery date.
  for (const row of await stockRows(c, o.id, ['held', 'committed'])) {
    const info = await lineInfo(c, row.line_id)
    const ok = sellableAs(info, o.delivery_date, cfg, { existing: true })
    if (ok && ok.stage === row.stage) continue
    const got = swappable
      ? await allocate(c, {
          orderId: o.id, orderNumber: o.number, deliveryDate: o.delivery_date, sku: row.sku, stage: row.stage,
          qty: row.quantity, state: row.state, actor, excludeBatchIds: [row.batch_id],
        })
      : 0
    const unusable = ['CONDEMNED', 'EXHAUSTED'].includes(info.status) || info.condition === 'REJECT'
    if (unusable) await release(c, row, actor, `Rebalance ${o.number}`)
    else if (got > 0) await release(c, row, actor, `Rebalance ${o.number}`, got)
    if (got > 0) changed = true
    // A healthy batch that only drifted out of stage stays allocated until ops decide.
    if (!unusable && got < row.quantity) {
      problems.push(`${row.quantity - got}× ${row.sku} from batch ${row.batch_id} is not ${row.stage} on ${o.delivery_date}`)
    }
  }

  // 2. Fill anything missing (stock may have arrived since).
  for (const item of await orderItems(c, o.id)) {
    const rows = await stockRows(c, o.id, ['held', 'committed', 'packed'])
    const have = rows.filter((r) => r.sku === item.sku && r.stage === item.stage).reduce((s, r) => s + r.quantity, 0)
    let missing = item.quantity - have
    if (missing > 0 && swappable) {
      const got = await allocate(c, {
        orderId: o.id, orderNumber: o.number, deliveryDate: o.delivery_date, sku: item.sku, stage: item.stage, qty: missing, state, actor,
      })
      if (got > 0) changed = true
      missing -= got
    }
    if (missing > 0) problems.push(`${missing}× ${item.sku} ${item.stage} has no stock for ${o.delivery_date}`)
  }

  // 3. Packed boxes can't be swapped; they can still be condemned or too old.
  for (const row of await stockRows(c, o.id, ['packed'])) {
    const info = await lineInfo(c, row.line_id)
    if (info.status === 'CONDEMNED') problems.push(`packed ${row.sku} is from condemned batch ${row.batch_id}`)
    else if (diffDays(o.delivery_date, info.plucked_on) > cfg.maxSellableAge) {
      problems.push(`packed ${row.sku} from batch ${row.batch_id} is past the ${cfg.maxSellableAge}-day limit on ${o.delivery_date}`)
    }
  }

  await setRisk(c, o, problems, actor)
  if (changed) metrics.rebalanceSwaps.inc()
  return { id: o.id, number: o.number, changed, atRisk: problems.length > 0 }
}

/**
 * Puts an order on the first date in `dates` where every item can be
 * committed, releasing its current stock first. Returns the date, or null
 * (with the order's stock restored) if no date works.
 */
export async function placeOnFirstDateWithStock(c, o, dates, actor, why) {
  const items = await orderItems(c, o.id)
  const boxes = items.reduce((s, i) => s + i.quantity, 0)
  for (const date of dates) {
    await c.query('SAVEPOINT place')
    try {
      for (const row of await stockRows(c, o.id, ['held', 'committed'])) await release(c, row, actor, `Move ${o.number}`)
      await checkCapacity(c, date, boxes, o.id)
      const slot = await chooseSlot(c, date, boxes, o.slot_id ?? null, { excludeOrderId: o.id })
      let full = true
      for (const i of items) {
        const got = await allocate(c, {
          orderId: o.id, orderNumber: o.number, deliveryDate: date, sku: i.sku, stage: i.stage, qty: i.quantity, state: 'committed', actor,
        })
        if (got < i.quantity) {
          full = false
          break
        }
      }
      if (full) {
        await c.query('RELEASE SAVEPOINT place')
        if (slot !== (o.slot_id ?? null)) {
          await c.query('UPDATE orders SET slot_id = $2 WHERE id = $1', [o.id, slot])
          o.slot_id = slot
        }
        if (date !== o.delivery_date) {
          await c.query('UPDATE orders SET delivery_date = $2 WHERE id = $1', [o.id, date])
          await addEvent(c, o.id, o.status, o.status, actor, `${why}; moved from ${o.delivery_date} to ${date}`)
          o.delivery_date = date
        }
        return date
      }
    } catch (err) {
      if (!(err instanceof HttpError)) throw err // DATE_FULL / DATE_CLOSED: try the next date
    }
    await c.query('ROLLBACK TO SAVEPOINT place')
  }
  return null
}

/**
 * Applies a payment outcome. Idempotent: replays are no-ops. A payment that
 * lands after the hold expired still confirms the order (no refunds); its
 * stock is re-allocated, on the next date with stock if need be.
 */
export async function processPayment(c, { orderId, outcome, paymentId = null, amount = null, method = null }, actor = SYSTEM) {
  const o = await lockOrder(c, orderId)
  if (o.payment_status === 'SUCCEEDED' || o.payment_status === 'REFUNDED') return { order: o, result: 'already_paid' }

  if (outcome === 'failed') {
    if (o.status !== 'PAYMENT_PENDING') return { order: o, result: 'ignored' }
    await cancelInTx(c, o, actor, 'Payment failed', 'FAILED')
    return { order: o, result: 'cancelled' }
  }

  if (o.status === 'CANCELLED' && o.customer_cancelled_at) {
    // Paid after the customer cancelled: keep it cancelled and refund the payment.
    await c.query(
      `UPDATE orders SET payment_status = 'SUCCEEDED', payment_id = COALESCE($2, payment_id), payment_method = COALESCE($3, payment_method),
              payment_amount = COALESCE($4, payment_amount), refund_requested_at = $5 WHERE id = $1`,
      [o.id, paymentId, method, amount, now()],
    )
    await addEvent(c, o.id, 'CANCELLED', 'CANCELLED', actor, 'Payment arrived after the customer cancelled; full refund requested')
    return { order: o, result: 'refund_due' }
  }

  const lateFrom = o.status === 'CANCELLED' ? 'CANCELLED' : null
  const chosenDate = o.delivery_date
  if (o.status !== 'PAYMENT_PENDING' && !lateFrom) return { order: o, result: 'ignored' }
  await c.query(
    `UPDATE orders SET status = 'CONFIRMED', payment_status = 'SUCCEEDED', payment_id = COALESCE($2, payment_id),
            payment_method = COALESCE($3, payment_method), payment_amount = COALESCE($4, payment_amount), hold_expires_at = NULL
      WHERE id = $1`,
    [o.id, paymentId, method, amount],
  )
  await addEvent(c, o.id, o.status, 'CONFIRMED', actor, lateFrom ? 'Payment arrived after the hold expired' : 'Payment captured')
  o.status = 'CONFIRMED'
  metrics.ordersConfirmed.inc()

  // Checkpoint 3: payment confirmation. Commit the holds that are still valid.
  for (const row of await stockRows(c, o.id, ['held'])) {
    const ok = sellableAs(await lineInfo(c, row.line_id), o.delivery_date, getConfig(), { existing: true })
    if (ok && ok.stage === row.stage) await commitHeld(c, row, actor, o.number)
    else await release(c, row, actor, `Revalidate ${o.number}`)
  }
  const earliest = await earliestDeliveryDate(c)
  const stale = o.delivery_date < earliest
  const r = stale ? { atRisk: true } : await rebalanceOrder(c, o.id, actor)
  if (r?.atRisk) {
    // The stock (or the date) is gone: deliver on the next date that has stock.
    const from = stale ? earliest : o.delivery_date
    const dates = (await orderableDates(c)).filter((d) => d >= from)
    const date = await placeOnFirstDateWithStock(c, o, dates, actor, 'Stock ran out before payment')
    if (date) await setRisk(c, o, [], actor)
    else {
      if (stale) {
        await c.query('UPDATE orders SET delivery_date = $2 WHERE id = $1', [o.id, earliest])
        o.delivery_date = earliest
      }
      await rebalanceOrder(c, o.id, actor) // flags it at-risk; later rebalances fill it
    }
  }
  // Moved off the date the customer picked: say so. They can still cancel for a
  // full refund until the order is packed, and the message tells them that.
  if (o.delivery_date !== chosenDate) await enqueue(c, o.id, newId('mov'), 'DATE_MOVED')
  if (amount != null && amount !== o.total) {
    logger.warn({ orderId: o.id, amount, total: o.total }, 'captured amount differs from order total')
  }
  return { order: o, result: lateFrom ? 'confirmed_late' : 'confirmed' }
}

async function cancelInTx(c, o, actor, reason, paymentStatus = null) {
  for (const row of await stockRows(c, o.id, ['held', 'committed'])) await release(c, row, actor, `Cancel ${o.number}`)
  if (RESTOCKABLE.includes(o.status)) {
    for (const row of await stockRows(c, o.id, ['packed'])) await restock(c, row, actor, `Cancel ${o.number}`)
  }
  const pay = paymentStatus ?? (o.payment_status === 'INITIATED' ? 'CANCELLED' : o.payment_status)
  await c.query(
    `UPDATE orders SET status = 'CANCELLED', payment_status = $2, hold_expires_at = NULL, at_risk = FALSE, at_risk_reason = NULL WHERE id = $1`,
    [o.id, pay],
  )
  await addEvent(c, o.id, o.status, 'CANCELLED', actor, reason)
}

/** Admin cancel. Payment is left as it is: MandiMangoes does not refund. */
export async function cancelOrder(c, orderId, actor, reason) {
  const o = await lockOrder(c, orderId)
  if (o.status === 'CANCELLED') throw conflict('This order is already cancelled')
  if (!ADMIN_CANCELLABLE.includes(o.status)) throw badRequest(`A ${o.status} order cannot be cancelled`, 'INVALID_TRANSITION')
  await cancelInTx(c, o, actor, reason)
}

/**
 * Customer cancel, allowed until the order is packed. A paid order is
 * refunded in full: the only case where MandiMangoes refunds. The refund is requested
 * here and sent to the gateway after commit (payments.js refundOrder).
 * Returns true when a refund is due.
 */
export async function customerCancel(c, orderId, customerId, actor) {
  const o = await lockOrder(c, orderId)
  if (o.customer_id !== customerId) throw notFound('Order not found')
  if (!CUSTOMER_CANCELLABLE.includes(o.status)) {
    throw conflict('This order is already packed and can no longer be cancelled.', 'NOT_CANCELLABLE')
  }
  const paid = o.payment_status === 'SUCCEEDED'
  await cancelInTx(c, o, actor, paid ? 'Cancelled by customer; full refund requested' : 'Cancelled by customer')
  await c.query(
    `UPDATE orders SET customer_cancelled_at = $2, refund_requested_at = CASE WHEN $3 THEN $2 ELSE refund_requested_at END WHERE id = $1`,
    [o.id, now(), paid],
  )
  return paid
}

/** Admin status move. 409 when someone else already moved it. */
/** opts.reason: why a delivery failed (shown on the order and to staff). */
export async function setOrderStatus(c, orderId, to, actor, opts = {}) {
  const o = await lockOrder(c, orderId)
  if (!(TRANSITIONS[o.status] ?? []).includes(to)) {
    const stale = o.status === to || (FLOW.includes(to) && FLOW.indexOf(o.status) > FLOW.indexOf(to))
    if (stale) throw conflict('This order was just updated by someone else.')
    throw badRequest(`Cannot move an order from ${o.status} to ${to}`, 'INVALID_TRANSITION')
  }
  let reason = null
  if (to === 'PACKED') {
    if ((await stockRows(c, o.id, ['held', 'committed'])).length) {
      throw badRequest('Allocate the stock before marking the order packed', 'NOT_ALLOCATED')
    }
    if (!(await stockRows(c, o.id, ['packed'])).length) throw badRequest('This order has no packed stock', 'NOT_ALLOCATED')
  }
  if (to === 'DELIVERY_FAILED') {
    // Retry on the next delivery day (user decision): reschedule, don't refund.
    const date = await nextDeliveryDay(c)
    const boxes = (await orderItems(c, o.id)).reduce((s, i) => s + i.quantity, 0)
    const slot = await chooseSlot(c, date, boxes, o.slot_id, { excludeOrderId: o.id })
    await c.query('UPDATE orders SET delivery_date = $2, slot_id = $3 WHERE id = $1', [o.id, date, slot])
    reason = `${opts.reason ?? 'Delivery failed'}; retrying on ${date}`
  }
  if (to === 'OUT_FOR_DELIVERY') {
    // The customer gives this code to the rider (delivery-proof.js). A retry keeps the code already sent.
    await c.query('UPDATE orders SET delivery_code = COALESCE(delivery_code, $2), delivery_code_tries = 0 WHERE id = $1', [
      o.id, String(randomInt(0, 10_000)).padStart(4, '0'),
    ])
  }
  await c.query('UPDATE orders SET status = $2 WHERE id = $1', [o.id, to])
  await addEvent(c, o.id, o.status, to, actor, reason)
  if (to === 'DELIVERY_FAILED') await rebalanceOrder(c, o.id, actor)
  if (['DELIVERED', 'RTO'].includes(to)) await c.query('UPDATE orders SET at_risk = FALSE, at_risk_reason = NULL WHERE id = $1', [o.id])
}

/** Checkpoint 4 (pack time): revalidate, then committed → packed. */
export async function allocateOrder(c, orderId, actor) {
  const o = await lockOrder(c, orderId)
  if (!['CONFIRMED', 'PROCESSING'].includes(o.status)) {
    throw badRequest(`A ${o.status} order cannot be allocated`, 'INVALID_TRANSITION')
  }
  const r = await rebalanceOrder(c, o.id, actor)
  if (r.atRisk) {
    const { rows } = await c.query('SELECT at_risk_reason FROM orders WHERE id = $1', [o.id])
    throw conflict(`This order can't be packed yet: ${rows[0].at_risk_reason}`, 'AT_RISK')
  }
  const rows = await stockRows(c, o.id, ['committed'])
  if (!rows.length) throw conflict('Nothing left to allocate')
  for (const row of rows) await pack(c, row, actor, o.number)
}

/**
 * Condemn or exhaust a batch: move every order off it (swap or flag at-risk),
 * then write the remaining stock off. Returns the order numbers affected.
 */
export async function takeBatchOutOfService(c, batchId, status, actor) {
  const { rows: affected } = await c.query(
    `SELECT DISTINCT o.id, o.placed_at FROM order_stock s JOIN orders o ON o.id = s.order_id
      WHERE s.batch_id = $1 AND s.state IN ('held', 'committed', 'packed') AND o.status = ANY($2)
      ORDER BY o.placed_at`,
    [batchId, OPEN_STATUSES],
  )
  const rebalancedOrders = []
  const atRiskOrders = []
  for (const { id } of affected) {
    const r = await rebalanceOrder(c, id, actor)
    if (!r) continue
    if (r.atRisk) atRiskOrders.push(r.number)
    else if (r.changed) rebalancedOrders.push(r.number)
  }
  const { rows: lines } = await c.query('SELECT * FROM batch_lines WHERE batch_id = $1 ORDER BY id FOR UPDATE', [batchId])
  const eventType = status === 'CONDEMNED' ? 'CONDEMN' : 'RETIRE'
  for (const l of lines) {
    if (l.held || l.committed) {
      // Only possible for stock kept on a stage mismatch; it can't be sold now.
      for (const row of (await c.query(`SELECT * FROM order_stock WHERE line_id = $1 AND state IN ('held','committed')`, [l.id])).rows) {
        await release(c, row, actor, `${eventType} ${batchId}`)
      }
    }
    if (l.reserve_buffer) {
      await c.query('UPDATE batch_lines SET reserve_buffer = 0 WHERE id = $1', [l.id])
      await ledgerRow(c, batchId, 'ADJUST_BUFFER', l.sku, -l.reserve_buffer, actor, `${eventType} write-off`)
    }
    if (l.on_hand) {
      await c.query('UPDATE batch_lines SET on_hand = 0 WHERE id = $1', [l.id])
      await ledgerRow(c, batchId, eventType, l.sku, -l.on_hand, actor, `${status} write-off`)
    }
  }
  return { rebalancedOrders, atRiskOrders }
}

async function ledgerRow(c, batchId, eventType, sku, delta, actor, reason) {
  await ledger(c, { batchId, eventType, sku, delta, actorType: actor.type, actorId: actor.id, reason })
}

/** Rebalances every open order holding stock from these batches. */
export async function rebalanceBatchOrders(c, batchIds, actor = SYSTEM) {
  const { rows } = await c.query(
    `SELECT DISTINCT o.id, o.placed_at FROM order_stock s JOIN orders o ON o.id = s.order_id
      WHERE s.batch_id = ANY($1) AND s.state IN ('held', 'committed', 'packed') AND o.status = ANY($2)
      ORDER BY o.placed_at`,
    [batchIds, OPEN_STATUSES],
  )
  const out = []
  for (const { id } of rows) out.push(await rebalanceOrder(c, id, actor))
  return out.filter(Boolean)
}

/**
 * A claim approved for replacement becomes a new zero-priced order for the
 * affected items, on the earliest date with stock. If nothing is in stock it
 * is created anyway, flagged at-risk, and rebalancing fills it later.
 */
export async function createReplacement(c, claim, original, actor) {
  const items = await orderItems(c, original.id)
  const wanted = claim.affected_items?.length ? items.filter((i) => claim.affected_items.includes(i.sku)) : items
  const lines = (wanted.length ? wanted : items).map((i) => ({ sku: i.sku, stage: i.stage ?? 'RIPE', qty: i.quantity, unitPrice: 0 }))
  const dates = await orderableDates(c)
  const order = await createOrder(
    c,
    {
      customerId: original.customer_id, customerName: original.customer_name, phone: original.phone,
      pincode: original.pincode, address: original.delivery_address, deliveryDate: dates[0] ?? (await earliestDeliveryDate(c)),
      status: 'CONFIRMED', paymentMethod: 'REPLACEMENT', replacementFor: original.id, lines,
      eventReason: `Replacement for ${original.number}`,
    },
    actor,
  )
  const { rows } = await c.query('SELECT at_risk FROM orders WHERE id = $1', [order.id])
  if (rows[0].at_risk) {
    const full = { ...order, status: 'CONFIRMED' }
    const date = await placeOnFirstDateWithStock(c, full, dates.slice(1), actor, 'No stock on the first date')
    if (date) await setRisk(c, full, [], actor)
  }
  return order
}

/** Cancels PAYMENT_PENDING orders whose 10-minute hold has run out. */
export async function sweepExpiredHolds(c, at = now()) {
  const { rows } = await c.query(
    `SELECT id FROM orders WHERE status = 'PAYMENT_PENDING' AND hold_expires_at < $1 ORDER BY hold_expires_at LIMIT 200`,
    [at],
  )
  let n = 0
  for (const { id } of rows) {
    const o = await lockOrder(c, id)
    if (o.status !== 'PAYMENT_PENDING' || !(o.hold_expires_at < at)) continue
    await cancelInTx(c, o, SYSTEM, 'Payment not received before the hold expired')
    n++
  }
  return n
}

export const eatByFor = (stage, date) => addDays(date, ({ RAW: 5, SEMI_RIPE: 2, RIPE: 0 }[stage] ?? 0) + 3)
