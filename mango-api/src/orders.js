// Order lifecycle: placing, paying, rebalancing, packing, delivering and
// cancelling. When stock goes bad the engine swaps it, moves the order to the
// next date with stock, or flags it at-risk for ops. Problems with delivered
// fruit end in a replacement, never a refund. Money goes back in two cases
// only: the customer cancels a paid order before packing, or a manager cancels
// a paid order we can't deliver.
import { randomInt } from 'node:crypto'
import { configVersion, getConfig } from './config.js'
import { addDays, diffDays, now, todayIST } from './clock.js'
import { checkCapacity, chooseSlot, earliestDeliveryDate, firstOpenDay, nextDeliveryDay, orderableDates } from './delivery.js'
import { badRequest, conflict, forbidden, HttpError, notFound, StockError } from './errors.js'
import { newId } from './ids.js'
import { allocate, commitHeld, ledger, lineInfo, pack, release, restock, sellableAs } from './inventory.js'
import { logger } from './logger.js'
import { metrics } from './metrics.js'
import { enqueue, enqueueForEvent } from './notify.js'

/** Orders that still own stock and can be rebalanced. */
export const OPEN_STATUSES = ['PAYMENT_PENDING', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED']
/** Before packing, stock is held or committed and can still be swapped. */
const SWAPPABLE_STATUSES = ['PAYMENT_PENDING', 'CONFIRMED', 'PROCESSING']

const FLOW = ['PAYMENT_PENDING', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED']
const ADMIN_CANCELLABLE = ['PAYMENT_PENDING', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY']
/**
 * Boxes not yet handed to the rider go back on the shelf when cancelled.
 * Allocate packs stock without moving the order on, so a CONFIRMED or
 * PROCESSING order can already have packed boxes (INV-1).
 */
const RESTOCKABLE = ['PAYMENT_PENDING', 'CONFIRMED', 'PROCESSING', 'PACKED']
const CUSTOMER_CANCELLABLE = ['PAYMENT_PENDING', 'CONFIRMED', 'PROCESSING']
/** A paid order a manager may cancel with a full refund: anything not yet delivered, including failed and returned deliveries. */
export const MANAGER_REFUNDABLE = [...ADMIN_CANCELLABLE, 'DELIVERY_FAILED', 'RTO']

/**
 * Every status change an order can make, in one place. Staff moves follow
 * TRANSITIONS (setOrderStatus); a payment confirms a pending order, or one
 * whose hold ran out (a late payment); a cancel takes anything not yet
 * delivered. assertTransition guards each write, so no path can skip a step.
 */
export const ORDER_TRANSITIONS = Object.freeze({
  PAYMENT_PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['PACKED', 'CANCELLED'],
  PACKED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['OUT_FOR_DELIVERY', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'DELIVERY_FAILED', 'CANCELLED'],
  DELIVERY_FAILED: ['OUT_FOR_DELIVERY', 'RTO', 'CANCELLED'],
  RTO: ['CANCELLED'],
  CANCELLED: ['CONFIRMED'],
  DELIVERED: [],
})

/**
 * The moves staff make with a status change (setOrderStatus), derived from
 * ORDER_TRANSITIONS (INV-I): everything except cancelling (its own endpoint,
 * cancelOrder) and confirming (only a payment confirms an order).
 */
export const STAFF_TRANSITIONS = Object.freeze(
  Object.fromEntries(Object.entries(ORDER_TRANSITIONS).map(([from, tos]) => [from, tos.filter((to) => to !== 'CANCELLED' && to !== 'CONFIRMED')])),
)
const TRANSITIONS = STAFF_TRANSITIONS

export function assertTransition(from, to) {
  if (!(ORDER_TRANSITIONS[from] ?? []).includes(to)) {
    throw new HttpError(409, 'INVALID_TRANSITION', `An order cannot go from ${from} to ${to}`)
  }
}

export const SYSTEM = { type: 'system', id: 'system' }
/** The event reason on orders cancelled because the hold ran out; the shop's order view keys off it. */
export const HOLD_EXPIRED_REASON = 'Payment not received before the hold expired'
/** Missed deliveries before an order stops being rescheduled automatically. */
export const MAX_DELIVERY_ATTEMPTS = 3

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
  await sweepExpiredHoldsFor(c, [...new Set(o.lines.map((l) => l.sku))])
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

/**
 * One customer can't hold the shop's stock with unpaid orders (INV-02). Locks
 * the customer row, so two checkouts by the same customer queue here and the
 * second sees the first's order. Orders whose hold has run out don't count:
 * they're cancelled lazily and their stock is free. Call it inside the
 * transaction that creates the order, before stock is taken.
 */
export async function checkUnpaidLimit(c, customerId, boxes, at = now()) {
  if (!customerId) return
  await c.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [customerId])
  const { rows } = await c.query(
    `SELECT o.id, o.number, o.hold_expires_at,
            COALESCE((SELECT sum(s.quantity) FROM order_stock s WHERE s.order_id = o.id AND s.state = 'held'), 0)::int AS boxes
       FROM orders o
      WHERE o.customer_id = $1 AND o.status = 'PAYMENT_PENDING' AND (o.hold_expires_at IS NULL OR o.hold_expires_at >= $2)
      ORDER BY o.placed_at DESC`,
    [customerId, at],
  )
  const cfg = getConfig()
  if (rows.length >= cfg.maxUnpaidOrders) {
    throw new HttpError(409, 'UNPAID_ORDER_EXISTS', `You have an unpaid order (${rows[0].number}). Pay for it or cancel it first.`, {
      orderId: rows[0].id,
      number: rows[0].number,
      holdExpiresAt: rows[0].hold_expires_at,
    })
  }
  const held = rows.reduce((t, r) => t + r.boxes, 0)
  if (held + boxes > cfg.maxHeldBoxes) {
    throw new HttpError(409, 'HOLD_LIMIT', `You can reserve up to ${cfg.maxHeldBoxes} boxes at a time. Reduce the quantity.`, { maxHeldBoxes: cfg.maxHeldBoxes })
  }
}

async function setRisk(c, order, problems, actor) {
  const reason = problems.length ? problems.join('; ') : null
  const { rows } = await c.query('SELECT at_risk, at_risk_reason FROM orders WHERE id = $1', [order.id])
  const prev = rows[0]
  if (prev.at_risk === problems.length > 0 && prev.at_risk_reason === reason) return
  await c.query('UPDATE orders SET at_risk = $2, at_risk_reason = $3 WHERE id = $1', [order.id, problems.length > 0, reason])
  await addEvent(c, order.id, order.status, order.status, actor, reason ? `At risk: ${reason}` : 'No longer at risk')
  if (prev.at_risk && !problems.length) await releaseHeldConfirmation(c, order.id)
}

/** last_error on a confirmation held back because the order has no stock yet (INV-B), and once it has gone out after all. */
export const CONFIRMATION_HELD = 'held: paid with no stock for its date; sent once stock is found'
const CONFIRMATION_RELEASED = 'held, then sent again once stock was found'

/**
 * INV-B: a late payment that finds no stock on any date is confirmed and
 * flagged at-risk. Its "confirmed for <date>" message would promise a date the
 * shop can't keep, so it is held (SKIPPED with CONFIRMATION_HELD); the shop's
 * order page says we're finding stock. There is no WhatsApp template for "we're
 * finding stock" yet.
 */
async function holdConfirmation(c, orderId, eventId) {
  await c.query(`UPDATE notifications SET status = 'SKIPPED', last_error = $2 WHERE event_id = $1 AND status = 'PENDING'`, [eventId, CONFIRMATION_HELD])
}

/** Once the order has its stock, the held confirmation goes out with the date it will really come (a fresh row, same kinds). */
async function releaseHeldConfirmation(c, orderId) {
  const { rows } = await c.query(
    `UPDATE notifications SET last_error = $3 WHERE order_id = $1 AND status = 'SKIPPED' AND last_error = $2 RETURNING kind`,
    [orderId, CONFIRMATION_HELD, CONFIRMATION_RELEASED],
  )
  if (!rows.length) return
  const eventId = newId('cnf')
  for (const kind of new Set(rows.map((r) => r.kind))) {
    await enqueue(c, orderId, eventId, kind, kind === 'RIPENESS_GUIDE' ? { delayMs: 60_000 } : {})
  }
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
 *
 * Boxes already packed for the order (allocate packs a CONFIRMED order
 * without moving it on) stay with it on its own date. For another date they
 * go back on the shelf and the order is allocated afresh, so it is packed
 * again for the new date: one box consumed per box ordered (INV-1).
 */
export async function placeOnFirstDateWithStock(c, o, dates, actor, why) {
  const items = await orderItems(c, o.id)
  const boxes = items.reduce((s, i) => s + i.quantity, 0)
  for (const date of dates) {
    await c.query('SAVEPOINT place')
    let unpacked = false
    try {
      for (const row of await stockRows(c, o.id, ['held', 'committed'])) await release(c, row, actor, `Move ${o.number}`)
      let packed = await stockRows(c, o.id, ['packed'])
      if (packed.length && date !== o.delivery_date) {
        for (const row of packed) await restock(c, row, actor, `Move ${o.number}: unpacked for ${date}`)
        packed = []
        unpacked = true
      }
      await checkCapacity(c, date, boxes, o.id)
      const slot = await chooseSlot(c, date, boxes, o.slot_id ?? null, { excludeOrderId: o.id })
      let full = true
      for (const i of items) {
        const have = packed.filter((r) => r.sku === i.sku && r.stage === i.stage).reduce((n, r) => n + r.quantity, 0)
        const need = i.quantity - have
        if (need <= 0) continue
        const got = await allocate(c, {
          orderId: o.id, orderNumber: o.number, deliveryDate: date, sku: i.sku, stage: i.stage, qty: need, state: 'committed', actor,
        })
        if (got < need) {
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
          const repack = unpacked ? '; its packed boxes went back to stock, pack it again' : ''
          await addEvent(c, o.id, o.status, o.status, actor, `${why}; moved from ${o.delivery_date} to ${date}${repack}`)
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
 * Moves a not-yet-packed order to another open delivery date (and optionally
 * a slot), taking stock for that date. Used by staff and by customers who
 * change their own delivery day. Returns the previous date.
 */
export async function moveOrderToDate(c, orderId, { deliveryDate, slotId = null, statuses, actor, why, customerId = null }) {
  const { rows } = await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId])
  const o = rows[0]
  if (!o || (customerId && o.customer_id !== customerId)) throw notFound('Order not found')
  if (!statuses.includes(o.status)) throw badRequest(`A ${o.status} order cannot be moved to another day`, 'INVALID_TRANSITION')
  if (!(await orderableDates(c)).includes(deliveryDate)) throw badRequest(`${deliveryDate} is not an open delivery date`, 'INVALID_DATE')
  if (slotId) {
    const { rows: q } = await c.query('SELECT COALESCE(SUM(quantity), 0)::int AS n FROM order_items WHERE order_id = $1', [o.id])
    o.slot_id = await chooseSlot(c, deliveryDate, q[0].n, slotId, { strict: true, excludeOrderId: o.id })
    await c.query('UPDATE orders SET slot_id = $2 WHERE id = $1', [o.id, o.slot_id])
  }
  const from = o.delivery_date
  const date = await placeOnFirstDateWithStock(c, o, [deliveryDate], actor, why)
  if (!date) throw conflict(`Not enough stock for this order on ${deliveryDate}`, 'STOCK_INSUFFICIENT')
  await rebalanceOrder(c, o.id, actor)
  return from
}

/**
 * Records a second payment captured for something already paid: a double
 * charge. The payment is refunded (refundDuplicatePayments); the order isn't.
 * Returns true the first time a payment is seen.
 */
export async function recordDuplicatePayment(c, { orderId = null, preorderId = null, paymentId, amount }) {
  const r = await c.query(
    `INSERT INTO duplicate_payments (payment_id, order_id, preorder_id, amount, found_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [paymentId, orderId, preorderId, amount, now()],
  )
  if (r.rowCount) logger.warn({ orderId, preorderId, paymentId }, 'second payment on an already paid order; refunding it')
  return r.rowCount > 0
}

/**
 * Applies a payment outcome. Idempotent: replays are no-ops. A payment that
 * lands after the hold expired still confirms the order (no refunds); its
 * stock is re-allocated, on the next date with stock if need be.
 *
 * outcome 'failed' is one failed attempt at Razorpay: the customer can try
 * again on the same payment page, so the hold stays and only the sweeper
 * cancels the order when it runs out. 'abandoned' is ours: the payment could
 * not even be started, so the order is cancelled at once.
 */
export async function processPayment(c, { orderId, outcome, paymentId = null, amount = null, method = null }, actor = SYSTEM) {
  const o = await lockOrder(c, orderId)
  if (o.payment_status === 'SUCCEEDED' || o.payment_status === 'REFUNDED') {
    if (outcome === 'captured' && paymentId && o.payment_id && paymentId !== o.payment_id) {
      if (await recordDuplicatePayment(c, { orderId: o.id, paymentId, amount })) {
        await addEvent(c, o.id, o.status, o.status, actor, `A second payment (${paymentId}) was taken for this paid order; it is being refunded`)
        return { order: o, result: 'duplicate_payment' }
      }
    }
    return { order: o, result: 'already_paid' }
  }

  if (outcome === 'abandoned') {
    if (o.status !== 'PAYMENT_PENDING') return { order: o, result: 'ignored' }
    await cancelInTx(c, o, actor, 'Payment could not be started', 'FAILED')
    return { order: o, result: 'cancelled' }
  }
  if (outcome === 'failed') {
    if (o.status !== 'PAYMENT_PENDING') return { order: o, result: 'ignored' }
    await addEvent(c, o.id, o.status, o.status, actor, 'A payment attempt failed; the customer can try again until the hold ends')
    return { order: o, result: 'attempt_failed' }
  }

  if (o.status === 'CANCELLED' && (o.customer_cancelled_at || o.staff_cancelled_at)) {
    // Paid after the customer or staff cancelled: keep it cancelled and refund the payment.
    await c.query(
      `UPDATE orders SET payment_status = 'SUCCEEDED', payment_id = COALESCE($2, payment_id), payment_method = COALESCE($3, payment_method),
              payment_amount = COALESCE($4, payment_amount), refund_requested_at = $5 WHERE id = $1`,
      [o.id, paymentId, method, amount, now()],
    )
    await addEvent(c, o.id, 'CANCELLED', 'CANCELLED', actor, `Payment arrived after the ${o.customer_cancelled_at ? 'customer' : 'shop'} cancelled; full refund requested`)
    return { order: o, result: 'refund_due' }
  }

  const lateFrom = o.status === 'CANCELLED' ? 'CANCELLED' : null
  // A hold that ran out stops counting against the day's capacity (INV-A), so
  // its day may have filled up even though the sweep hasn't cancelled it yet.
  const holdLapsed = o.status === 'PAYMENT_PENDING' && o.hold_expires_at != null && o.hold_expires_at < now()
  const chosenDate = o.delivery_date
  if (o.status !== 'PAYMENT_PENDING' && !lateFrom) return { order: o, result: 'ignored' }
  assertTransition(o.status, 'CONFIRMED')
  await c.query(
    `UPDATE orders SET status = 'CONFIRMED', payment_status = 'SUCCEEDED', payment_id = COALESCE($2, payment_id),
            payment_method = COALESCE($3, payment_method), payment_amount = COALESCE($4, payment_amount), hold_expires_at = NULL
      WHERE id = $1`,
    [o.id, paymentId, method, amount],
  )
  const confirmEvent = await addEvent(c, o.id, o.status, 'CONFIRMED', actor, lateFrom ? 'Payment arrived after the hold expired' : 'Payment captured')
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
  // A late payment: while the order was cancelled its boxes left the day's
  // capacity, so check the day still has room before re-allocating on it (INV-5).
  const full = !stale && (lateFrom || holdLapsed) && !(await hasRoom(c, o))
  const r = stale || full ? { atRisk: true } : await rebalanceOrder(c, o.id, actor)
  if (r?.atRisk) {
    // The stock (or the date) is gone: deliver on the next date that has stock.
    const from = stale ? earliest : o.delivery_date
    const dates = (await orderableDates(c)).filter((d) => d >= from)
    const date = await placeOnFirstDateWithStock(c, o, dates, actor, full ? 'The day filled up before payment' : 'Stock ran out before payment')
    if (date) await setRisk(c, o, [], actor)
    else if (full) await setRisk(c, o, [`${o.delivery_date} is fully booked and no later date has stock; move it by hand`], actor)
    else {
      if (stale) {
        await c.query('UPDATE orders SET delivery_date = $2 WHERE id = $1', [o.id, earliest])
        o.delivery_date = earliest
      }
      await rebalanceOrder(c, o.id, actor) // flags it at-risk; later rebalances fill it
    }
  }
  // INV-B: no stock on any date. Don't tell the customer a date we can't keep:
  // the confirmation waits until stock is found (setRisk sends it then).
  const stuck = (await c.query('SELECT at_risk FROM orders WHERE id = $1', [o.id])).rows[0].at_risk
  if (stuck) await holdConfirmation(c, o.id, confirmEvent)
  // Moved off the date the customer picked: say so. They can still cancel for a
  // full refund until the order is packed, and the message tells them that.
  else if (o.delivery_date !== chosenDate) await enqueue(c, o.id, newId('mov'), 'DATE_MOVED')
  if (amount != null && amount !== o.total) {
    logger.warn({ orderId: o.id, amount, total: o.total }, 'captured amount differs from order total')
  }
  return { order: o, result: lateFrom ? 'confirmed_late' : 'confirmed' }
}

/** Whether the order's delivery date still has capacity for it (closed or full: false). */
async function hasRoom(c, o) {
  const boxes = (await orderItems(c, o.id)).reduce((n, i) => n + i.quantity, 0)
  try {
    await checkCapacity(c, o.delivery_date, boxes, o.id)
    return true
  } catch (err) {
    if (err instanceof HttpError) return false
    throw err
  }
}

async function cancelInTx(c, o, actor, reason, paymentStatus = null) {
  for (const row of await stockRows(c, o.id, ['held', 'committed'])) await release(c, row, actor, `Cancel ${o.number}`)
  if (RESTOCKABLE.includes(o.status)) {
    for (const row of await stockRows(c, o.id, ['packed'])) await restock(c, row, actor, `Cancel ${o.number}`)
  }
  assertTransition(o.status, 'CANCELLED')
  const pay = paymentStatus ?? (o.payment_status === 'INITIATED' ? 'CANCELLED' : o.payment_status)
  await c.query(
    `UPDATE orders SET status = 'CANCELLED', payment_status = $2, hold_expires_at = NULL, at_risk = FALSE, at_risk_reason = NULL WHERE id = $1`,
    [o.id, pay],
  )
  await addEvent(c, o.id, o.status, 'CANCELLED', actor, reason)
}

/**
 * Staff cancel. An unpaid order is simply cancelled (any staff who can open
 * orders). A paid order can only be cancelled by a manager, and only with a
 * full refund (`refund: true` confirms it): a customer who paid for fruit we
 * can't deliver (at-risk, a short truck, three missed deliveries, returned)
 * gets their money back. The refund is requested here and sent after commit
 * (payments.js refundOrder). Returns true when a refund is due.
 */
export async function cancelOrder(c, orderId, actor, reason, { manager = false, refund = false } = {}) {
  const o = await lockOrder(c, orderId)
  if (o.status === 'CANCELLED') throw conflict('This order is already cancelled')
  const paid = o.payment_status === 'SUCCEEDED'
  if (paid) {
    if (!manager) throw forbidden('Only a manager can cancel a paid order, because it is refunded in full')
    if (!MANAGER_REFUNDABLE.includes(o.status)) throw badRequest(`A ${o.status} order cannot be cancelled`, 'INVALID_TRANSITION')
    if (!refund) throw conflict('This order is paid: cancelling it refunds the customer in full. Confirm the refund to go ahead.', 'REFUND_REQUIRED')
  } else if (!ADMIN_CANCELLABLE.includes(o.status)) {
    throw badRequest(`A ${o.status} order cannot be cancelled`, 'INVALID_TRANSITION')
  }
  await cancelInTx(c, o, actor, paid ? `Cancelled by a manager with a full refund: ${reason}` : reason)
  await c.query(
    `UPDATE orders SET staff_cancelled_at = $2, refund_requested_at = CASE WHEN $3 THEN $2 ELSE refund_requested_at END WHERE id = $1`,
    [o.id, now(), paid],
  )
  return paid
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
    const why =
      o.status === 'CANCELLED' ? 'This order is already cancelled.'
        : o.status === 'DELIVERED' ? 'This order has been delivered and can no longer be cancelled.'
          : 'This order is already packed and can no longer be cancelled.'
    throw conflict(why, 'NOT_CANCELLABLE')
  }
  const paid = o.payment_status === 'SUCCEEDED'
  await cancelInTx(c, o, actor, paid ? 'Cancelled by customer; full refund requested' : 'Cancelled by customer')
  await c.query(
    `UPDATE orders SET customer_cancelled_at = $2, refund_requested_at = CASE WHEN $3 THEN $2 ELSE refund_requested_at END WHERE id = $1`,
    [o.id, now(), paid],
  )
  return paid
}

/**
 * The first open day from `from` on that still has room for `boxes`
 * (a failed delivery's retry). If every day in the next two weeks is full it
 * falls back to `from`: the retry still has to go out, and ops see the day
 * over capacity on the Planning page.
 */
async function firstDayWithRoom(c, from, boxes, orderId) {
  let d = await firstOpenDay(c, from)
  for (let i = 0; i < 14; i++) {
    try {
      await checkCapacity(c, d, boxes, orderId)
      return d
    } catch (err) {
      if (!(err instanceof HttpError)) throw err
    }
    d = await firstOpenDay(c, addDays(d, 1))
  }
  return firstOpenDay(c, from)
}

/**
 * Before boxes leave: packed stock from a condemned batch, or past the age
 * cap, must not go out (ORD-2), and an order whose delivery attempts are used
 * up is not sent again on its own (ORD-4). A manager can override both, after
 * checking the boxes or calling the customer (opts.override).
 */
async function checkDispatchable(c, o, opts) {
  if (opts.override) return
  if (o.status === 'DELIVERY_FAILED' && o.delivery_failures >= MAX_DELIVERY_ATTEMPTS) {
    throw conflict(
      `Order ${o.number} has failed ${o.delivery_failures} deliveries. Call the customer; a manager can then send it again.`,
      'ATTEMPTS_USED_UP',
    )
  }
  if (o.status === 'DELIVERY_FAILED') {
    // OPS-01: the retry goes on another day. Sending it straight back out and
    // reporting another miss would burn the customer's attempts in minutes.
    const { rows } = await c.query(
      `SELECT created_at FROM delivery_attempts WHERE order_id = $1 AND outcome = 'FAILED' ORDER BY created_at DESC LIMIT 1`,
      [o.id],
    )
    if (rows[0] && todayIST(rows[0].created_at) === todayIST()) {
      throw conflict(`Order ${o.number} was missed today. It goes out again on its new day; a manager can send it today.`, 'SAME_DAY_RETRY')
    }
  }
  const r = await rebalanceOrder(c, o.id, opts.actor ?? SYSTEM)
  if (r?.atRisk) {
    const { rows } = await c.query('SELECT at_risk_reason FROM orders WHERE id = $1', [o.id])
    throw conflict(`Order ${o.number} can't go out: ${rows[0].at_risk_reason}. A manager can send it anyway.`, 'AT_RISK')
  }
}

/**
 * Admin status move. 409 when someone else already moved it.
 * opts.reason: why a delivery failed (shown on the order and to staff).
 * opts.proof: DELIVERED comes with the customer's code or a photo (delivery-proof.js).
 * opts.override: a manager's override, with opts.reason: DELIVERED without
 * proof, or dispatching despite at-risk stock or used-up attempts.
 */
export async function setOrderStatus(c, orderId, to, actor, opts = {}) {
  const o = await lockOrder(c, orderId)
  if (!(TRANSITIONS[o.status] ?? []).includes(to)) {
    const stale = o.status === to || (FLOW.includes(to) && FLOW.indexOf(o.status) > FLOW.indexOf(to))
    if (stale) throw conflict('This order was just updated by someone else.')
    throw badRequest(`Cannot move an order from ${o.status} to ${to}`, 'INVALID_TRANSITION')
  }
  let reason = null
  if (to === 'DELIVERED' && !opts.proof) {
    // ORD-3: a delivery is proven by the customer's code or a photo; only a manager may skip that, saying why.
    if (!opts.override) {
      throw forbidden("Record the delivery with the customer's code or a photo. Only a manager can mark it delivered without proof.")
    }
    if (!opts.reason?.trim()) throw badRequest('Say why this order is being marked delivered without proof', 'REASON_REQUIRED')
    reason = `Marked delivered without proof by a manager: ${opts.reason.trim()}`
  }
  if (to === 'SHIPPED' || to === 'OUT_FOR_DELIVERY') {
    await checkDispatchable(c, o, { ...opts, actor })
  }
  if (opts.override && to !== 'DELIVERED' && opts.reason?.trim()) reason = `Manager override: ${opts.reason.trim()}`
  if (to === 'PACKED') {
    if ((await stockRows(c, o.id, ['held', 'committed'])).length) {
      throw badRequest('Allocate the stock before marking the order packed', 'NOT_ALLOCATED')
    }
    if (!(await stockRows(c, o.id, ['packed'])).length) throw badRequest('This order has no packed stock', 'NOT_ALLOCATED')
  }
  let attemptsUsedUp = false
  let retryStuck = false
  if (to === 'DELIVERY_FAILED') {
    const failures = o.delivery_failures + 1
    await c.query('UPDATE orders SET delivery_failures = $2 WHERE id = $1', [o.id, failures])
    if (failures >= MAX_DELIVERY_ATTEMPTS) {
      // Not rescheduled again on its own: Needs attention asks staff to call the customer first.
      attemptsUsedUp = true
      reason = `${opts.reason ?? 'Delivery failed'}; ${failures} attempts failed, call the customer before sending it again`
    } else {
      // Retry on the next delivery day with room (user decision): reschedule, don't refund.
      const boxes = (await orderItems(c, o.id)).reduce((s, i) => s + i.quantity, 0)
      const date = await firstDayWithRoom(c, await nextDeliveryDay(c), boxes, o.id)
      const slot = await chooseSlot(c, date, boxes, o.slot_id, { excludeOrderId: o.id })
      await c.query('UPDATE orders SET delivery_date = $2, slot_id = $3 WHERE id = $1', [o.id, date, slot])
      reason = `${opts.reason ?? 'Delivery failed'}; retrying on ${date}`
      // INV-E: ripe boxes may be too old by the retry day. Swap them for younger stock, or stop and ask a manager.
      const repack = await repackForRetry(c, o, date, actor)
      if (repack.result === 'repacked') reason += `; ${repack.boxes} boxes were too old for ${date} and were swapped for younger stock: pack the new boxes before it goes out`
      if (repack.result === 'stuck') {
        retryStuck = true
        reason = `${opts.reason ?? 'Delivery failed'}; the boxes would be past the ${getConfig().maxSellableAge}-day limit on ${date} and no younger stock is free. A manager decides: send a replacement, move the date or cancel with a refund`
      }
    }
  }
  if (to === 'OUT_FOR_DELIVERY') {
    // The customer gives this code to the rider (delivery-proof.js). A retry keeps the code already sent.
    await c.query('UPDATE orders SET delivery_code = COALESCE(delivery_code, $2), delivery_code_tries = 0 WHERE id = $1', [
      o.id, String(randomInt(0, 10_000)).padStart(4, '0'),
    ])
  }
  assertTransition(o.status, to)
  await c.query('UPDATE orders SET status = $2 WHERE id = $1', [o.id, to])
  const eventId = await addEvent(c, o.id, o.status, to, actor, reason)
  if (attemptsUsedUp) {
    // The usual message promises a retry date; staff call instead.
    await c.query(`UPDATE notifications SET status = 'SKIPPED', last_error = 'delivery attempts used up: staff call the customer' WHERE event_id = $1`, [eventId])
  }
  if (retryStuck) {
    // The usual message promises a retry date the boxes can't make; a manager decides first (INV-E).
    await c.query(`UPDATE notifications SET status = 'SKIPPED', last_error = 'retry needs a manager: stock too old for the retry date' WHERE event_id = $1`, [eventId])
  }
  if (to === 'DELIVERY_FAILED') await rebalanceOrder(c, o.id, actor)
  if (['DELIVERED', 'RTO'].includes(to)) await c.query('UPDATE orders SET at_risk = FALSE, at_risk_reason = NULL WHERE id = $1', [o.id])
}

/**
 * INV-E: after a missed delivery, packed boxes that would be past the age cap
 * on the retry date are swapped for younger stock of the same SKU and stage:
 * the fresh boxes are taken and packed for the retry, and the old ones go back
 * on the shelf when the rider returns them (too old to sell, they retire with
 * their batch). All or nothing. Returns { result: 'ok' } when nothing is too
 * old, { result: 'repacked', boxes }, or { result: 'stuck' } when there is no
 * younger stock (nothing changes; the order goes at-risk for a manager).
 */
async function repackForRetry(c, o, date, actor) {
  const cfg = getConfig()
  const old = []
  for (const row of await stockRows(c, o.id, ['packed'])) {
    const info = await lineInfo(c, row.line_id)
    if (diffDays(date, info.plucked_on) > cfg.maxSellableAge) old.push(row)
  }
  if (!old.length) return { result: 'ok' }
  await c.query('SAVEPOINT repack')
  for (const row of old) {
    const got = await allocate(c, {
      orderId: o.id, orderNumber: o.number, deliveryDate: date, sku: row.sku, stage: row.stage, qty: row.quantity, state: 'committed', actor,
      excludeBatchIds: [row.batch_id],
    })
    if (got < row.quantity) {
      await c.query('ROLLBACK TO SAVEPOINT repack')
      return { result: 'stuck' }
    }
  }
  for (const row of old) await restock(c, row, actor, `${o.number}: back from a missed delivery, too old for the retry on ${date}`)
  for (const row of await stockRows(c, o.id, ['committed'])) await pack(c, row, actor, `${o.number} (re-packed for the retry on ${date})`)
  await c.query('RELEASE SAVEPOINT repack')
  return { result: 'repacked', boxes: old.reduce((n, r) => n + r.quantity, 0) }
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
 *
 * The batch's lines are locked first (INV-6): an allocation still in flight
 * either lands before the lock, and its order is in the list below, or waits
 * for this transaction and then sees the batch out of service
 * (inventory.js allocate re-checks after taking the line).
 */
/**
 * INV-03: locks the open orders that hold stock on these batches, oldest first.
 * Payments lock an order and then its batch lines, so batch operations (condemn,
 * retire, QC, status) call this before locking the batch or its lines; taking
 * locks in the same order means they wait instead of deadlocking.
 */
export async function lockBatchOrders(c, batchIds) {
  await c.query(
    `SELECT o.id FROM orders o
      WHERE o.status = ANY($2)
        AND o.id IN (SELECT s.order_id FROM order_stock s WHERE s.batch_id = ANY($1) AND s.state IN ('held', 'committed', 'packed'))
      ORDER BY o.placed_at, o.id FOR UPDATE OF o`,
    [batchIds, OPEN_STATUSES],
  )
}

export async function takeBatchOutOfService(c, batchId, status, actor, why = null) {
  await lockBatchOrders(c, [batchId])
  const { rows: lines } = await c.query('SELECT * FROM batch_lines WHERE batch_id = $1 ORDER BY id FOR UPDATE', [batchId])
  const { rows: affected } = await c.query(
    `SELECT DISTINCT o.id, o.placed_at FROM order_stock s JOIN orders o ON o.id = s.order_id
      WHERE s.batch_id = $1 AND s.state IN ('held', 'committed', 'packed') AND o.status = ANY($2)
      ORDER BY o.placed_at, o.id`,
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
  const eventType = status === 'CONDEMNED' ? 'CONDEMN' : 'RETIRE'
  const writeOff = why ? `${status} write-off: ${why}` : `${status} write-off`
  for (const stale of lines) {
    const l = (await c.query('SELECT * FROM batch_lines WHERE id = $1', [stale.id])).rows[0]
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
      await ledgerRow(c, batchId, eventType, l.sku, -l.on_hand, actor, writeOff)
    }
  }
  return { rebalancedOrders, atRiskOrders }
}

/**
 * A short arrival (INV-3): fewer boxes turned up than were counted (in-transit
 * stock is sold ahead of arrival), so on_hand has to drop below what is
 * already promised. The reserve buffer goes first; then the youngest orders
 * on the line give their boxes back, and each one is re-filled from another
 * batch for the same day or, failing that, moved to the next open date with
 * stock, the way a late payment is (the customer gets a DATE_MOVED message).
 * An order that fits nowhere stays at-risk for ops. Returns what happened.
 */
export async function recordShortArrival(c, { batchId, lineId, onHand, reason, reasonCode = null, check = null }, actor) {
  const affectedIds = async () =>
    (
      await c.query(
        `SELECT DISTINCT o.id, o.placed_at FROM order_stock s JOIN orders o ON o.id = s.order_id
          WHERE s.line_id = $1 AND s.state IN ('held', 'committed') ORDER BY o.placed_at, o.id`,
        [lineId],
      )
    ).rows.map((r) => r.id)
  // Orders before the line, the same order payments take locks in.
  const locked = new Map()
  for (const id of await affectedIds()) locked.set(id, await lockOrder(c, id))
  const { rows } = await c.query(
    `SELECT l.*, b.status FROM batch_lines l JOIN batches b ON b.id = l.batch_id WHERE l.id = $1 AND l.batch_id = $2 FOR UPDATE OF l`,
    [lineId, batchId],
  )
  if (!rows.length) throw notFound('Batch line not found')
  const l = rows[0]
  if (['EXHAUSTED', 'CONDEMNED'].includes(l.status)) throw badRequest(`This batch is ${l.status}`, 'INVALID_TRANSITION')
  if (onHand >= l.on_hand) throw badRequest('A short arrival lowers the count; use an adjustment to raise it', 'NOT_SHORT')
  // INV-C: the caller may refuse a drop this big without a manager; a manager's note goes in the reason.
  const note = check ? await check(c, l, onHand - l.on_hand) : null
  // Anything allocated between the first read and the line lock.
  for (const id of await affectedIds()) if (!locked.has(id)) locked.set(id, await lockOrder(c, id))

  const why = `${reasonCode === 'COUNT' ? 'Count' : 'Short arrival'}: ${reason}${note ? ` (${note})` : ''}`
  const buffer = Math.min(l.reserve_buffer, Math.max(0, onHand - l.held - l.committed))
  let over = l.held + l.committed - onHand
  const released = new Set()
  if (over > 0) {
    const { rows: stock } = await c.query(
      `SELECT s.* FROM order_stock s JOIN orders o ON o.id = s.order_id
        WHERE s.line_id = $1 AND s.state IN ('held', 'committed') ORDER BY o.placed_at DESC, o.id DESC, s.id DESC`,
      [lineId],
    )
    for (const row of stock) {
      if (over <= 0) break
      const qty = Math.min(over, row.quantity)
      await release(c, row, actor, `${why} (${locked.get(row.order_id).number})`, qty)
      released.add(row.order_id)
      over -= qty
    }
  }
  await c.query('UPDATE batch_lines SET on_hand = $2, reserve_buffer = $3 WHERE id = $1', [l.id, onHand, buffer])
  await ledger(c, { batchId, eventType: 'ADJUST', sku: l.sku, delta: onHand - l.on_hand, actorType: actor.type, actorId: actor.id, reason: why, reasonCode })
  if (buffer !== l.reserve_buffer) {
    await ledger(c, { batchId, eventType: 'ADJUST_BUFFER', sku: l.sku, delta: buffer - l.reserve_buffer, actorType: actor.type, actorId: actor.id, reason: why, reasonCode })
  }

  const out = { refilled: [], moved: [], atRisk: [] }
  const open = await orderableDates(c)
  for (const id of [...locked.keys()].filter((k) => released.has(k))) {
    const o = locked.get(id)
    const r = await rebalanceOrder(c, id, actor)
    if (!r?.atRisk) {
      out.refilled.push(o.number)
      continue
    }
    if (!['CONFIRMED', 'PROCESSING'].includes(o.status)) {
      // Unpaid: payment re-checks and moves it (processPayment).
      out.atRisk.push(o.number)
      continue
    }
    const fresh = (await c.query('SELECT * FROM orders WHERE id = $1', [id])).rows[0]
    const date = await placeOnFirstDateWithStock(c, fresh, open.filter((d) => d >= fresh.delivery_date), actor, why)
    if (date) {
      await setRisk(c, fresh, [], actor)
      if (date !== o.delivery_date) {
        await enqueue(c, id, newId('mov'), 'DATE_MOVED')
        out.moved.push({ number: o.number, deliveryDate: date })
      } else out.refilled.push(o.number)
    } else {
      await rebalanceOrder(c, id, actor)
      out.atRisk.push(o.number)
    }
  }
  return out
}

async function ledgerRow(c, batchId, eventType, sku, delta, actor, reason) {
  await ledger(c, { batchId, eventType, sku, delta, actorType: actor.type, actorId: actor.id, reason })
}

/** Rebalances every open order holding stock from these batches. */
export async function rebalanceBatchOrders(c, batchIds, actor = SYSTEM) {
  const { rows } = await c.query(
    `SELECT DISTINCT o.id, o.placed_at FROM order_stock s JOIN orders o ON o.id = s.order_id
      WHERE s.batch_id = ANY($1) AND s.state IN ('held', 'committed', 'packed') AND o.status = ANY($2)
      ORDER BY o.placed_at, o.id`,
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
  const tryDates = dates.length ? dates : [await earliestDeliveryDate(c)]
  // OPS-04: a full or closed day moves the replacement to the next day with room, as a retry does.
  let order = null
  for (const [i, deliveryDate] of tryDates.entries()) {
    await c.query('SAVEPOINT replacement_day')
    try {
      order = await createOrder(
        c,
        {
          customerId: original.customer_id, customerName: original.customer_name, phone: original.phone,
          pincode: original.pincode, address: original.delivery_address, deliveryDate,
          status: 'CONFIRMED', paymentMethod: 'REPLACEMENT', replacementFor: original.id, lines,
          eventReason: `Replacement for ${original.number}`,
        },
        actor,
      )
      await c.query('RELEASE SAVEPOINT replacement_day')
      break
    } catch (err) {
      await c.query('ROLLBACK TO SAVEPOINT replacement_day')
      const dayProblem = err instanceof HttpError && ['DATE_FULL', 'DATE_CLOSED', 'SLOT_FULL'].includes(err.code)
      if (!dayProblem) throw err
      if (i === tryDates.length - 1) {
        throw conflict('Every delivery day open for booking is full or closed. Open more room in the calendar, then approve the replacement.', 'NO_DELIVERY_DAY')
      }
    }
  }
  const { rows } = await c.query('SELECT at_risk FROM orders WHERE id = $1', [order.id])
  if (rows[0].at_risk) {
    const full = { ...order, status: 'CONFIRMED' }
    const date = await placeOnFirstDateWithStock(c, full, dates.slice(1), actor, 'No stock on the first date')
    if (date) await setRisk(c, full, [], actor)
  }
  return order
}

/**
 * Cancels PAYMENT_PENDING orders whose 10-minute hold has run out. Each order
 * gets its own savepoint: one that fails to cancel (a drifted counter, a bad
 * notification) is logged, flagged at-risk for ops and skipped, instead of
 * rolling back the whole batch and blocking every hold behind it (INV-2).
 * Orders flagged that way go to the back of the queue.
 */
export async function sweepExpiredHolds(c, at = now()) {
  const { rows } = await c.query(
    `SELECT id FROM orders WHERE status = 'PAYMENT_PENDING' AND hold_expires_at < $1 ORDER BY at_risk, hold_expires_at LIMIT 200`,
    [at],
  )
  let n = 0
  for (const { id } of rows) {
    await c.query('SAVEPOINT sweep_one')
    try {
      const o = await lockOrder(c, id)
      if (o.status === 'PAYMENT_PENDING' && o.hold_expires_at < at) {
        await cancelInTx(c, o, SYSTEM, HOLD_EXPIRED_REASON)
        n++
      }
      await c.query('RELEASE SAVEPOINT sweep_one')
    } catch (err) {
      await c.query('ROLLBACK TO SAVEPOINT sweep_one')
      logger.error({ err, orderId: id }, 'could not cancel an order whose hold expired; skipping it')
      metrics.maintenanceErrors.inc({ step: 'sweep-order' })
      const reason = `Hold expired but the order could not be cancelled: ${String(err?.message ?? err).slice(0, 200)}`
      await c.query('UPDATE orders SET at_risk = TRUE, at_risk_reason = $2 WHERE id = $1 AND at_risk_reason IS DISTINCT FROM $2', [id, reason])
    }
  }
  return n
}

/**
 * Lazy hold expiry (INV-01): before an order takes stock, cancel the unpaid
 * orders whose hold has already run out and that hold the same SKUs, so their
 * boxes come back even if the scheduled sweep is late or down. Bounded, and
 * SKIP LOCKED so a buyer never waits on an order another transaction (a
 * payment webhook, another buyer) is working on; that order stays for the
 * scheduled sweep. Same lock order as the sweep: order row, then stock lines.
 *
 * PAY-B5: an order that has a Razorpay order or payment link may have been
 * paid inside its hold while the webhook is late. It is left alone until a
 * reconcile (the maintenance run, or the order page's payment-status check)
 * has asked Razorpay about it after its hold ran out, or for 2 minutes after
 * the hold, whichever comes first. The 2 minutes cover a slow webhook and the
 * next every-minute maintenance run, and keep stock from staying held when the
 * scheduler is down; a payment that lands even later is still honoured as a
 * late payment.
 */
export const LAZY_SWEEP_GATEWAY_GRACE_MS = 2 * 60_000
export async function sweepExpiredHoldsFor(c, skus, at = now(), limit = 20) {
  if (!skus.length) return 0
  const { rows } = await c.query(
    `SELECT id FROM orders
      WHERE status = 'PAYMENT_PENDING' AND hold_expires_at < $1
        AND id IN (SELECT order_id FROM order_stock WHERE state = 'held' AND sku = ANY($2))
        AND ((razorpay_order_id IS NULL AND payment_link_id IS NULL) OR reconcile_checked_at >= hold_expires_at OR hold_expires_at < $4)
      ORDER BY hold_expires_at LIMIT $3
      FOR UPDATE SKIP LOCKED`,
    [at, skus, limit, new Date(at.getTime() - LAZY_SWEEP_GATEWAY_GRACE_MS)],
  )
  let n = 0
  for (const { id } of rows) {
    await c.query('SAVEPOINT lazy_expiry')
    try {
      const o = (await c.query('SELECT * FROM orders WHERE id = $1', [id])).rows[0]
      if (o.status === 'PAYMENT_PENDING' && o.hold_expires_at < at) {
        await cancelInTx(c, o, SYSTEM, HOLD_EXPIRED_REASON)
        n++
      }
      await c.query('RELEASE SAVEPOINT lazy_expiry')
    } catch (err) {
      // Leave it for the scheduled sweep, which flags it for ops.
      await c.query('ROLLBACK TO SAVEPOINT lazy_expiry')
      logger.error({ err, orderId: id }, 'lazy hold expiry could not cancel an order; leaving it for the sweep')
    }
  }
  if (n) metrics.lazyExpiries.inc(n)
  return n
}

export { eatByFor } from './ripeness.js'
