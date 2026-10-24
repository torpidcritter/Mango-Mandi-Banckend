// Preorders (playbook section 9). A customer books a SKU, ripeness and
// quantity for a delivery WEEK before the fruit exists, at a locked price,
// and pays in full by Razorpay payment link. Weekly capacity per SKU is taken
// with a conditional UPDATE so a launch-day rush cannot oversell; overflow
// joins a waitlist that is promoted in booking order as capacity frees up.
// Before a week opens to regular orders, the allocator turns each paid
// preorder into a normal confirmed order on a date with stock, so preorders
// get first claim on the fruit. A customer can cancel until packing with a
// full refund, as for any order. Weeks start on Monday.
import { addDays, now, todayIST } from './clock.js'
import { getConfig } from './config.js'
import { query, tx } from './db.js'
import { earliestDeliveryDate, orderableDates } from './delivery.js'
import { badRequest, conflict, HttpError, notFound } from './errors.js'
import { newId } from './ids.js'
import { logger } from './logger.js'
import { enqueuePreorder } from './notify.js'
import { cancelOrder, createOrder, customerCancel, LAZY_SWEEP_GATEWAY_GRACE_MS, recordDuplicatePayment, SYSTEM } from './orders.js'
import { canStartCall } from './budget.js'
import { applyCapture, claimRefund, GATEWAY_CALL_MS, createPaymentLink, fetchLinkPayments, gatewayRefund, refundReceipt } from './payments.js'
import { findProduct, sellable } from './products.js'

/** A waitlisted customer whose spot opens has this long to pay. */
export const SPOT_HOLD_HOURS = 12
export const PREORDER_STATUSES = ['PAYMENT_PENDING', 'BOOKED', 'WAITLISTED', 'CONVERTED', 'CANCELLED']

export const isMonday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1

/** The last date regular customers can book; preorders own every later date. */
export async function regularHorizon(c) {
  const dates = await orderableDates(c)
  return dates.at(-1) ?? addDays(todayIST(), getConfig().maxDaysAhead)
}

async function event(c, id, status, actor, reason = null) {
  await c.query('INSERT INTO preorder_events (id, preorder_id, status, reason, actor, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [
    newId('pev'), id, status, reason, actor.label ?? actor.id, now(),
  ])
}

/** Takes `qty` of the week's capacity, or returns false when it would overflow. `force` always takes it. */
async function reserve(c, sku, week, qty, { force = false } = {}) {
  if (force) {
    await c.query(
      `INSERT INTO preorder_capacity (sku, week_start, capacity, reserved) VALUES ($1, $2, 0, $3)
       ON CONFLICT (sku, week_start) DO UPDATE SET reserved = preorder_capacity.reserved + $3`,
      [sku, week, qty],
    )
    return true
  }
  const r = await c.query(
    'UPDATE preorder_capacity SET reserved = reserved + $3 WHERE sku = $1 AND week_start = $2 AND reserved + $3 <= capacity',
    [sku, week, qty],
  )
  return r.rowCount > 0
}

const release = (c, p) =>
  c.query('UPDATE preorder_capacity SET reserved = GREATEST(reserved - $3, 0) WHERE sku = $1 AND week_start = $2', [p.sku, p.week_start, p.qty])

async function lock(c, id) {
  const { rows } = await c.query('SELECT * FROM preorders WHERE id = $1 FOR UPDATE', [id])
  if (!rows.length) throw notFound('Preorder not found')
  return rows[0]
}

/** Weeks open for preorders: after the regular booking horizon, with capacity set. */
export async function openWeeks(c, sku = null) {
  const after = await regularHorizon(c)
  const { rows } = await c.query(
    `SELECT sku, week_start, capacity, reserved FROM preorder_capacity
      WHERE week_start > $1 AND capacity > 0 AND ($2::text IS NULL OR sku = $2) ORDER BY week_start, sku`,
    [after, sku],
  )
  return rows.map((r) => ({ sku: r.sku, weekStart: r.week_start, capacity: r.capacity, remaining: Math.max(r.capacity - r.reserved, 0) }))
}

export function preorderView(p) {
  return {
    id: p.id, number: p.number, status: p.status, sku: p.sku, productName: findProduct(p.sku)?.name ?? p.sku, stage: p.stage,
    qty: p.qty, unitPrice: p.unit_price, total: p.total, weekStart: p.week_start, pincode: p.pincode, address: p.delivery_address, slotId: p.slot_id,
    customerName: p.customer_name, phone: p.phone, channel: p.channel,
    paymentStatus: p.payment_status, paymentUrl: p.status === 'PAYMENT_PENDING' ? p.payment_link_url : null, holdExpiresAt: p.hold_expires_at,
    orderId: p.order_id, movedCount: p.moved_count, createdAt: p.created_at, bookedAt: p.booked_at,
    refund: p.refund_requested_at ? { requestedAt: p.refund_requested_at, refundedAt: p.refunded_at, id: p.refund_id, status: p.refund_status ?? null } : null,
  }
}

/**
 * INV-02 for Book ahead: one customer can't hold a week's capacity with unpaid
 * bookings, on the web or in WhatsApp. Same rules as orders (maxUnpaidOrders,
 * maxHeldBoxes), counted over bookings only: an unpaid order and an unpaid
 * booking don't block each other. Locks the customer row, so two bookings by
 * the same customer at once queue here. A booking whose hold has run out
 * doesn't count.
 */
async function checkUnpaidPreorders(c, customerId, qty, at = now()) {
  if (!customerId) return
  await c.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [customerId])
  const { rows } = await c.query(
    `SELECT id, number, qty, hold_expires_at FROM preorders
      WHERE customer_id = $1 AND status = 'PAYMENT_PENDING' AND (hold_expires_at IS NULL OR hold_expires_at >= $2)
      ORDER BY created_at DESC`,
    [customerId, at],
  )
  const cfg = getConfig()
  if (rows.length >= cfg.maxUnpaidOrders) {
    throw new HttpError(409, 'UNPAID_PREORDER_EXISTS', `You have an unpaid booking (${rows[0].number}). Pay for it or cancel it first.`, {
      preorderId: rows[0].id,
      number: rows[0].number,
      holdExpiresAt: rows[0].hold_expires_at,
    })
  }
  if (rows.reduce((t, r) => t + r.qty, 0) + qty > cfg.maxHeldBoxes) {
    throw new HttpError(409, 'HOLD_LIMIT', `You can reserve up to ${cfg.maxHeldBoxes} boxes at a time. Reduce the quantity.`, { maxHeldBoxes: cfg.maxHeldBoxes })
  }
}

/**
 * Lazy hold expiry for Book ahead (as INV-01 for orders): before a booking
 * takes a week's capacity, unpaid bookings for that box and week whose hold ran
 * out give theirs back, so a late or stopped maintenance job doesn't keep the
 * week full. As PAY-B5: a booking is left alone until Razorpay has been asked
 * about it after its hold, or for 2 minutes after the hold. A payment that
 * lands later still books (processPreorderPayment takes the capacity back).
 * Bounded and SKIP LOCKED, like the order sweep.
 */
async function expireWeekHolds(c, sku, week, at = now(), limit = 20) {
  const { rows } = await c.query(
    `SELECT * FROM preorders
      WHERE status = 'PAYMENT_PENDING' AND sku = $1 AND week_start = $2 AND hold_expires_at < $3
        AND (reconcile_checked_at >= hold_expires_at OR hold_expires_at < $4)
      ORDER BY hold_expires_at LIMIT $5
      FOR UPDATE SKIP LOCKED`,
    [sku, week, at, new Date(at.getTime() - LAZY_SWEEP_GATEWAY_GRACE_MS), limit],
  )
  for (const p of rows) await cancelExpiredHold(c, p)
  return rows.length
}

async function cancelExpiredHold(c, p) {
  await release(c, p)
  await c.query(`UPDATE preorders SET status = 'CANCELLED', payment_status = 'CANCELLED', hold_expires_at = NULL WHERE id = $1`, [p.id])
  await event(c, p.id, 'CANCELLED', SYSTEM, 'Not paid in time')
}

/**
 * Books a preorder. With capacity: PAYMENT_PENDING with a hold, paid by link.
 * Without: WAITLISTED when the customer asked for it, else 409 PREORDER_FULL.
 */
export async function bookPreorder(c, b, actor) {
  const p = sellable(b.sku)
  if (!p) throw badRequest(`Unknown SKU ${b.sku}`, 'INVALID_SKU')
  if (!isMonday(b.weekStart)) throw badRequest('weekStart must be a Monday', 'INVALID_WEEK')
  const weeks = await openWeeks(c, b.sku)
  if (!weeks.some((w) => w.weekStart === b.weekStart)) throw badRequest('Preorders are not open for that week', 'INVALID_WEEK')
  const { rows: pin } = await c.query('SELECT 1 FROM pincodes WHERE pincode = $1 AND active', [b.pincode])
  if (!pin.length) throw badRequest('We do not deliver to this pincode yet', 'NOT_SERVICEABLE')
  if (b.slotId) {
    const { rows } = await c.query('SELECT 1 FROM delivery_slots WHERE id = $1 AND active', [b.slotId])
    if (!rows.length) throw badRequest('That delivery slot is not available', 'SLOT_INVALID')
  }
  await checkUnpaidPreorders(c, b.customerId, b.qty)
  await expireWeekHolds(c, b.sku, b.weekStart)
  const got = await reserve(c, b.sku, b.weekStart, b.qty)
  if (!got && !b.waitlist) throw conflict('That week is fully booked. Join the waitlist to get the next free spot.', 'PREORDER_FULL')
  const id = newId('pre')
  const number = (await c.query(`SELECT 'PRE-' || nextval('preorder_seq') AS n`)).rows[0].n
  const status = got ? 'PAYMENT_PENDING' : 'WAITLISTED'
  await c.query(
    `INSERT INTO preorders (id, number, customer_id, customer_name, phone, sku, stage, qty, unit_price, total, week_start, pincode,
                            delivery_address, slot_id, channel, status, hold_expires_at, payment_status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      id, number, b.customerId, b.name ?? null, b.phone, b.sku, b.stage, b.qty, p.price, p.price * b.qty, b.weekStart, b.pincode,
      b.address, b.slotId ?? null, b.channel ?? 'app', status,
      got ? new Date(now().getTime() + getConfig().holdMinutes * 60_000) : null, got ? 'INITIATED' : null, now(),
    ],
  )
  await event(c, id, status, actor, got ? null : 'Week full: joined the waitlist')
  return (await c.query('SELECT * FROM preorders WHERE id = $1', [id])).rows[0]
}

/** Creates the payment link for an unpaid preorder that has none yet. */
export async function ensurePaymentLink(id) {
  const { rows } = await query(`SELECT * FROM preorders WHERE id = $1 AND status = 'PAYMENT_PENDING'`, [id])
  const p = rows[0]
  if (!p || p.payment_link_url) return p ?? null
  const link = await createPaymentLink({
    amount: p.total, number: p.number, preorderId: p.id, name: p.customer_name, phone: p.phone,
    description: `MandiMangoes preorder ${p.number}`,
    holdUntil: p.hold_expires_at,
  })
  const up = await query('UPDATE preorders SET payment_link_id = $2, payment_link_url = $3 WHERE id = $1 AND payment_link_url IS NULL RETURNING *', [
    p.id, link.id, link.url,
  ])
  return up.rows[0] ?? (await query('SELECT * FROM preorders WHERE id = $1', [id])).rows[0]
}

/**
 * Finds the booking a Razorpay payment link was paid for. PAY-B11: only what
 * Razorpay itself sends for the link counts (the link's id, or the notes we
 * set on the link when we made it); a payment's own notes can be set by
 * whoever opens Checkout, so they are never trusted, as for orders.
 */
export async function findPreorderId(c, _entity, link) {
  if (!link?.id && !link?.notes?.preorderId) return null
  const noted = typeof link?.notes?.preorderId === 'string' ? link.notes.preorderId : null
  const { rows } = await c.query(
    'SELECT id FROM preorders WHERE payment_link_id = $1 OR (id = $2 AND payment_link_id IS NOT NULL) ORDER BY (payment_link_id = $1) DESC NULLS LAST LIMIT 1',
    [link?.id ?? null, noted],
  )
  return rows[0]?.id ?? null
}

/**
 * Applies a payment. Paid in time: BOOKED. Paid after the hold expired: still
 * booked (late payments are honoured), taking capacity even if the week has
 * filled. Paid after the customer cancelled: refunded. Replays are no-ops.
 */
export async function processPreorderPayment(c, { preorderId, outcome, paymentId = null, amount = null, method = null }, actor = SYSTEM) {
  const p = await lock(c, preorderId)
  if (p.payment_status === 'SUCCEEDED' || p.payment_status === 'REFUNDED') {
    const second = outcome === 'captured' && paymentId && p.payment_id && paymentId !== p.payment_id
    if (second && (await recordDuplicatePayment(c, { preorderId: p.id, paymentId, amount }))) return 'duplicate_payment'
    return 'already_paid'
  }
  if (outcome !== 'captured') return 'ignored' // a link can be paid again after a failed attempt
  const paid = [paymentId, method, amount ?? p.total, now()]
  if (p.status === 'CANCELLED' && (p.customer_cancelled_at || p.staff_cancelled_at)) {
    await c.query(
      `UPDATE preorders SET payment_status = 'SUCCEEDED', payment_id = $2, payment_method = $3, paid_amount = $4, refund_requested_at = $5 WHERE id = $1`,
      [p.id, ...paid],
    )
    await event(c, p.id, 'CANCELLED', actor, `Paid after the ${p.customer_cancelled_at ? 'customer' : 'shop'} cancelled; full refund requested`)
    return 'refund_due'
  }
  if (p.status !== 'PAYMENT_PENDING' && p.status !== 'CANCELLED') return 'ignored'
  if (p.status === 'CANCELLED') await reserve(c, p.sku, p.week_start, p.qty, { force: true })
  await c.query(
    `UPDATE preorders SET status = 'BOOKED', payment_status = 'SUCCEEDED', payment_id = $2, payment_method = $3, paid_amount = $4,
            booked_at = $5, hold_expires_at = NULL WHERE id = $1`,
    [p.id, ...paid],
  )
  await event(c, p.id, 'BOOKED', actor, p.status === 'CANCELLED' ? 'Paid after the hold expired' : 'Payment captured')
  await enqueuePreorder(c, p.id, 'PREORDER_BOOKED')
  return 'booked'
}

/**
 * Customer cancel. Before conversion the preorder is cancelled and, if paid,
 * refunded in full; after conversion it is the order's normal cancel (until
 * packing, with the refund). Returns { refund: 'preorder' | 'order' | null, id }.
 */
export async function cancelPreorder(c, id, customerId, actor) {
  const p = await lock(c, id)
  if (p.customer_id !== customerId) throw notFound('Preorder not found')
  if (p.status === 'CANCELLED') throw conflict('This preorder is already cancelled')
  if (p.status === 'CONVERTED') {
    const refund = await customerCancel(c, p.order_id, customerId, actor)
    return { refund: refund ? 'order' : null, id: p.order_id }
  }
  if (p.status !== 'WAITLISTED') await release(c, p)
  const paid = p.payment_status === 'SUCCEEDED'
  await c.query(
    `UPDATE preorders SET status = 'CANCELLED', hold_expires_at = NULL, customer_cancelled_at = $2,
            payment_status = CASE WHEN payment_status = 'INITIATED' THEN 'CANCELLED' ELSE payment_status END,
            refund_requested_at = CASE WHEN $3 THEN $2 ELSE refund_requested_at END WHERE id = $1`,
    [p.id, now(), paid],
  )
  await event(c, p.id, 'CANCELLED', actor, paid ? 'Cancelled by customer; full refund requested' : 'Cancelled by customer')
  return { refund: paid ? 'preorder' : null, id: p.id }
}

/**
 * Manager cancel, for a booking we can't fill (crop failure, season end, a
 * week we close). The capacity is freed and a paid booking is refunded in
 * full; a booking already turned into an order is cancelled as a paid order
 * (also refunded). Returns { refund: 'preorder' | 'order' | null, id }.
 */
export async function staffCancelPreorder(c, id, actor, reason) {
  const p = await lock(c, id)
  if (p.status === 'CANCELLED') throw conflict('This preorder is already cancelled')
  if (p.status === 'CONVERTED') {
    const refund = await cancelOrder(c, p.order_id, actor, reason, { manager: true, refund: true })
    await event(c, p.id, 'CONVERTED', actor, `Its order was cancelled by a manager: ${reason}`)
    return { refund: refund ? 'order' : null, id: p.order_id }
  }
  if (p.status !== 'WAITLISTED') await release(c, p)
  const paid = p.payment_status === 'SUCCEEDED'
  await c.query(
    `UPDATE preorders SET status = 'CANCELLED', hold_expires_at = NULL, staff_cancelled_at = $2,
            payment_status = CASE WHEN payment_status = 'INITIATED' THEN 'CANCELLED' ELSE payment_status END,
            refund_requested_at = CASE WHEN $3 THEN $2 ELSE refund_requested_at END WHERE id = $1`,
    [p.id, now(), paid],
  )
  await event(c, p.id, 'CANCELLED', actor, paid ? `Cancelled by a manager with a full refund: ${reason}` : `Cancelled by a manager: ${reason}`)
  return { refund: paid ? 'preorder' : null, id: p.id }
}

/** Sends the full refund for a cancelled paid preorder. Safe to repeat. */
export async function refundPreorder(id) {
  const p = await claimRefund('preorders', id)
  if (!p) return null
  const refundId = await gatewayRefund({
    paymentId: p.payment_id, amount: p.paid_amount ?? p.total, receipt: refundReceipt(p.number, p.refund_attempts), notes: { preorderId: p.id },
  })
  if (!refundId) return null
  return tx(async (c) => {
    const r = await c.query(
      `UPDATE preorders SET payment_status = 'REFUNDED', refund_id = $2, refunded_at = $3, refund_status = 'pending' WHERE id = $1 AND refunded_at IS NULL RETURNING id`,
      [p.id, refundId, now()],
    )
    if (r.rowCount) {
      await event(c, p.id, 'CANCELLED', SYSTEM, `Refunded in full (${refundId})`)
      await enqueuePreorder(c, p.id, 'REFUNDED')
    }
    return refundId
  })
}

/** Unpaid preorders whose hold ran out give their capacity back. */
export async function expirePreorderHolds(c, at = now()) {
  const { rows } = await c.query(
    `SELECT * FROM preorders WHERE status = 'PAYMENT_PENDING' AND hold_expires_at < $1 ORDER BY hold_expires_at FOR UPDATE SKIP LOCKED`,
    [at],
  )
  for (const p of rows) await cancelExpiredHold(c, p)
  return rows.length
}

/**
 * Gives freed capacity to the waitlist in booking order. A promoted customer
 * gets a payment link and SPOT_HOLD_HOURS to pay.
 */
export async function promoteWaitlist() {
  const promoted = await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT p.* FROM preorders p JOIN preorder_capacity k ON k.sku = p.sku AND k.week_start = p.week_start
        WHERE p.status = 'WAITLISTED' AND k.reserved < k.capacity AND p.week_start > $1
        ORDER BY p.created_at, p.id FOR UPDATE OF p SKIP LOCKED`,
      [await regularHorizon(c)],
    )
    const ids = []
    for (const p of rows) {
      if (!(await reserve(c, p.sku, p.week_start, p.qty))) continue
      await c.query(`UPDATE preorders SET status = 'PAYMENT_PENDING', payment_status = 'INITIATED', hold_expires_at = $2, payment_started_at = $3
          WHERE id = $1`, [p.id, new Date(now().getTime() + SPOT_HOLD_HOURS * 3_600_000), now()])
      await event(c, p.id, 'PAYMENT_PENDING', SYSTEM, 'A spot opened up from the waitlist')
      ids.push(p.id)
    }
    return ids
  })
  for (const id of promoted) {
    try {
      await ensurePaymentLink(id)
      await tx((c) => enqueuePreorder(c, id, 'PREORDER_SPOT_OPEN'))
    } catch (err) {
      logger.error({ err, preorderId: id }, 'could not send the waitlist payment link; will retry')
    }
  }
  return promoted.length
}

/** Retries payment links (and their messages) for promoted preorders that have none yet. */
export async function retryMissingLinks() {
  const { rows } = await query(`SELECT id FROM preorders WHERE status = 'PAYMENT_PENDING' AND payment_link_url IS NULL LIMIT 20`)
  for (const { id } of rows) {
    try {
      const p = await ensurePaymentLink(id)
      if (p?.payment_link_url) await tx((c) => enqueuePreorder(c, id, 'PREORDER_SPOT_OPEN'))
    } catch (err) {
      logger.error({ err, preorderId: id }, 'payment link retry failed')
    }
  }
}

/**
 * Catches missed link payments (webhook lost) for unpaid or just-expired preorders.
 * The window starts when the payment window opened: a waitlist spot is often
 * offered days after the booking was made.
 */
export async function reconcilePreorderPayments() {
  const at = now()
  const { rows } = await query(
    `SELECT id, payment_link_id FROM preorders WHERE payment_link_id IS NOT NULL AND payment_status IN ('INITIATED', 'CANCELLED')
        AND COALESCE(payment_started_at, created_at) > $1 AND (reconcile_checked_at IS NULL OR reconcile_checked_at < $2)
      ORDER BY (payment_status = 'INITIATED') DESC, reconcile_checked_at NULLS FIRST, COALESCE(payment_started_at, created_at) DESC LIMIT 100`,
    [new Date(at.getTime() - 3 * 86_400_000), new Date(at.getTime() - 15 * 60_000)],
  )
  let n = 0
  for (const p of rows) {
    if (!canStartCall(GATEWAY_CALL_MS)) break // the next run carries on
    try {
      await query('UPDATE preorders SET reconcile_checked_at = $2 WHERE id = $1', [p.id, now()])
      const captured = (await fetchLinkPayments(p.payment_link_id)).find((x) => x.status === 'captured')
      if (!captured) continue
      const r = await tx((c) => applyCapture(c, 'preorders', p.id, captured))
      if (r === 'rejected') continue
      if (r === 'refund_due') await refundPreorder(p.id).catch(() => {})
      n++
    } catch (err) {
      logger.error({ err, preorderId: p.id }, 'preorder reconciliation failed')
    }
  }
  return n
}

async function attempt(c, fn) {
  await c.query('SAVEPOINT pre_alloc')
  try {
    const v = await fn()
    await c.query('RELEASE SAVEPOINT pre_alloc')
    return v
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT pre_alloc')
    if (err instanceof HttpError) return null
    throw err
  }
}

/**
 * The allocator. Each paid preorder becomes a confirmed order on the first
 * date in its week that has stock, trying dates up to one day past the
 * regular booking horizon (so preorders claim stock before regular shoppers
 * can). A week that passes without stock moves the preorder to the next week
 * and tells the customer. Returns { converted, moved }.
 */
export async function allocatePreorders() {
  return await tx(async (c) => {
    const horizon = addDays(await regularHorizon(c), 1)
    const earliest = await earliestDeliveryDate(c)
    const { rows } = await c.query(
      `SELECT * FROM preorders WHERE status = 'BOOKED' AND week_start <= $1 ORDER BY booked_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT 200`,
      [horizon],
    )
    let converted = 0
    let moved = 0
    for (const p of rows) {
      const last = addDays(p.week_start, 6)
      let order = null
      for (let d = p.week_start < earliest ? earliest : p.week_start; d <= last && d <= horizon && !order; d = addDays(d, 1)) {
        order = await attempt(c, () =>
          createOrder(
            c,
            {
              customerId: p.customer_id, customerName: p.customer_name, phone: p.phone, pincode: p.pincode, address: p.delivery_address,
              deliveryDate: d, slotId: p.slot_id, strictSlot: false, status: 'CONFIRMED', paymentStatus: 'SUCCEEDED',
              paymentMethod: p.payment_method ?? 'preorder', allOrNothing: true, channel: p.channel,
              lines: [{ sku: p.sku, stage: p.stage, qty: p.qty, unitPrice: p.unit_price }], eventReason: `From preorder ${p.number}`,
            },
            SYSTEM,
          ),
        )
      }
      if (order) {
        await c.query('UPDATE orders SET preorder_id = $2, payment_id = $3, payment_amount = $4 WHERE id = $1', [order.id, p.id, p.payment_id, p.paid_amount ?? p.total])
        await c.query(`UPDATE preorders SET status = 'CONVERTED', order_id = $2 WHERE id = $1`, [p.id, order.id])
        await event(c, p.id, 'CONVERTED', SYSTEM, `Delivering on ${order.delivery_date} as ${order.number}`)
        converted++
      } else if (last < earliest) {
        const next = addDays(p.week_start, 7)
        await release(c, p)
        await reserve(c, p.sku, next, p.qty, { force: true })
        await c.query('UPDATE preorders SET week_start = $2, moved_count = moved_count + 1 WHERE id = $1', [p.id, next])
        await event(c, p.id, 'BOOKED', SYSTEM, `No stock in the week of ${p.week_start}; moved to the week of ${next}`)
        await enqueuePreorder(c, p.id, 'PREORDER_MOVED')
        moved++
      }
    }
    return { converted, moved }
  })
}
