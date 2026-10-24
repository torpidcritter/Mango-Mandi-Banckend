// Things the stock and order engines can't settle on their own, for Needs
// attention, the Today page and the maintenance health check:
//   - overdue orders (INV-G): paid, not delivered, and past their date, or out
//     for delivery for longer than a delivery takes;
//   - preorders that keep rolling forward (INV-H);
//   - boxes on orders cancelled or returned after they left the store (INV-F),
//     which staff put back on the shelf or write off.
import { diffDays, now, todayIST } from './clock.js'
import { getConfig } from './config.js'
import { badRequest, conflict, notFound } from './errors.js'
import { ledger, restock } from './inventory.js'
import { addEvent, MAX_DELIVERY_ATTEMPTS } from './orders.js'

/** Paid orders that still have to reach the customer. */
const UNDELIVERED = ['CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED']

/**
 * Open orders past their delivery date (IST), and orders out for delivery for
 * more than outForDeliveryAlertHours. An order whose delivery attempts are used
 * up is left out: it is already on Needs attention as "call the customer".
 */
export async function overdueOrders(c, at = now(), limit = 100) {
  const today = todayIST(at)
  const hours = getConfig().outForDeliveryAlertHours ?? 8
  const { rows } = await c.query(
    `SELECT o.id, o.number, o.status, o.delivery_date, o.customer_name, o.phone, ofd.at AS out_since
       FROM orders o
       LEFT JOIN LATERAL (
         SELECT MAX(e.created_at) AS at FROM order_events e WHERE e.order_id = o.id AND e.status = 'OUT_FOR_DELIVERY' AND e.from_status IS DISTINCT FROM e.status
       ) ofd ON o.status = 'OUT_FOR_DELIVERY'
      WHERE o.status = ANY($1)
        AND NOT (o.status = 'DELIVERY_FAILED' AND o.delivery_failures >= $5)
        AND (o.delivery_date < $2 OR (o.status = 'OUT_FOR_DELIVERY' AND ofd.at < $3))
      ORDER BY o.delivery_date, o.number LIMIT $4`,
    [UNDELIVERED, today, new Date(at.getTime() - hours * 3_600_000), limit, MAX_DELIVERY_ATTEMPTS],
  )
  return rows.map((o) => {
    const late = o.delivery_date < today ? diffDays(today, o.delivery_date) : 0
    const outHours = o.out_since ? Math.floor((at.getTime() - o.out_since.getTime()) / 3_600_000) : null
    const reason =
      late > 0
        ? `${late} ${late === 1 ? 'day' : 'days'} past its delivery date and still ${o.status.toLowerCase().replaceAll('_', ' ')}`
        : `out for delivery for ${outHours} hours with no result from the rider`
    return { id: o.id, number: o.number, status: o.status, deliveryDate: o.delivery_date, daysLate: late, outSince: o.out_since ?? null, reason }
  })
}

/**
 * Paid preorders a manager should decide on (INV-H): moved forward more than
 * maxPreorderMoves times, or now booked for a week after the season's last day.
 * The allocator keeps moving them meanwhile; nothing is cancelled on its own.
 * One a manager kept (POST /preorders/:id/keep) stays off until it moves again.
 */
export async function preordersNeedingDecision(c, limit = 100) {
  const cfg = getConfig()
  const { rows } = await c.query(
    `SELECT id, number, customer_name, sku, qty, week_start, moved_count FROM preorders
      WHERE status = 'BOOKED' AND (moved_count > $1 OR ($2::date IS NOT NULL AND week_start > $2::date))
        -- A manager chose to keep it (Keep booking): back only once it moves again.
        AND NOT (kept_moved_count IS NOT DISTINCT FROM moved_count AND kept_week_start IS NOT DISTINCT FROM week_start)
      ORDER BY booked_at, id LIMIT $3`,
    [cfg.maxPreorderMoves ?? 3, cfg.seasonEndsOn ?? null, limit],
  )
  return rows.map((p) => ({
    id: p.id, number: p.number, customerName: p.customer_name, sku: p.sku, qty: p.qty, weekStart: p.week_start, movedCount: p.moved_count,
    reason:
      cfg.seasonEndsOn && p.week_start > cfg.seasonEndsOn
        ? `booked for the week of ${p.week_start}, after the season ends on ${cfg.seasonEndsOn}`
        : `moved forward ${p.moved_count} times without stock`,
  }))
}

/** Orders cancelled or returned after dispatch whose boxes nobody has booked back in or written off yet (INV-F). */
export async function returnedStockPending(c, limit = 100) {
  const { rows } = await c.query(
    `SELECT o.id, o.number, o.status, SUM(s.quantity)::int AS boxes FROM order_stock s JOIN orders o ON o.id = s.order_id
      WHERE s.state = 'packed' AND o.status IN ('CANCELLED', 'RTO')
      GROUP BY o.id, o.number, o.status ORDER BY o.number LIMIT $1`,
    [limit],
  )
  return rows.map((r) => ({ id: r.id, number: r.number, status: r.status, boxes: r.boxes }))
}

/** Reason codes a write-off of returned boxes may carry. */
export const WRITE_OFF_REASONS = ['DAMAGED', 'THEFT_LOSS', 'OTHER']

/**
 * Books the boxes of an order cancelled or returned after it left the store
 * (INV-F). RESTOCK puts them back on the shelf (a RESTOCK row, reason
 * RETURN_RESTOCK) when their batch is still on sale. WRITE_OFF records that
 * they came back unusable or never came back: a RESTOCK and an ADJUST of the
 * same size, so on-hand stays as it is and the loss shows in the ledger with
 * its reason. Either way the order no longer holds the boxes.
 */
export async function bookReturnedStock(c, orderId, { action, reasonCode = null, reason }, actor) {
  const { rows } = await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId])
  const o = rows[0]
  if (!o) throw notFound('Order not found')
  if (!['CANCELLED', 'RTO'].includes(o.status)) {
    throw badRequest('Only boxes on a cancelled or returned order can be booked back in or written off', 'INVALID_TRANSITION')
  }
  const { rows: packed } = await c.query(
    `SELECT s.*, b.status AS batch_status FROM order_stock s JOIN batches b ON b.id = s.batch_id
      WHERE s.order_id = $1 AND s.state = 'packed' ORDER BY s.id`,
    [o.id],
  )
  if (!packed.length) throw conflict('This order has no boxes waiting to be booked', 'NOTHING_TO_BOOK')
  // Lines in id order, after the order: the lock order every stock change uses.
  await c.query('SELECT id FROM batch_lines WHERE id = ANY($1) ORDER BY id FOR UPDATE', [[...new Set(packed.map((r) => r.line_id))]])
  const boxes = packed.reduce((n, r) => n + r.quantity, 0)
  const why = reason.trim()
  if (action === 'RESTOCK') {
    const closed = packed.find((r) => ['EXHAUSTED', 'CONDEMNED'].includes(r.batch_status))
    if (closed) throw badRequest(`Batch ${closed.batch_id} is ${closed.batch_status}; write these boxes off instead`, 'BATCH_CLOSED')
    for (const row of packed) await restock(c, row, actor, `Returned from ${o.number}: ${why}`, 'RETURN_RESTOCK')
    await addEvent(c, o.id, o.status, o.status, actor, `${boxes} returned ${boxes === 1 ? 'box' : 'boxes'} put back in stock: ${why}`)
  } else {
    const code = reasonCode ?? 'DAMAGED'
    for (const row of packed) {
      await c.query(`UPDATE order_stock SET state = 'released' WHERE id = $1`, [row.id])
      const base = { batchId: row.batch_id, sku: row.sku, actorType: actor.type, actorId: actor.id }
      await ledger(c, { ...base, eventType: 'RESTOCK', delta: row.quantity, reason: `Returned from ${o.number}`, reasonCode: 'RETURN_RESTOCK' })
      await ledger(c, { ...base, eventType: 'ADJUST', delta: -row.quantity, reason: `Write-off of boxes returned from ${o.number}: ${why}`, reasonCode: code })
    }
    await addEvent(c, o.id, o.status, o.status, actor, `${boxes} ${boxes === 1 ? 'box' : 'boxes'} from this order written off (${code.toLowerCase().replace('_', ' or ')}): ${why}`)
  }
  return { boxes }
}
