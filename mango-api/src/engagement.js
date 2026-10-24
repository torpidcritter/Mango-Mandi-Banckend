// Messages that bring customers back: back-in-stock alerts and the reorder
// reminder a week after delivery (opt-in only).
import { canStartCall } from './budget.js'
import { addDays, istParts, now } from './clock.js'
import { query, tx } from './db.js'
import { orderableDates } from './delivery.js'
import { badRequest, conflict, notFound } from './errors.js'
import { newId } from './ids.js'
import { availabilityByDate } from './inventory.js'
import { enqueue, enqueueAlert } from './notify.js'
import { findProduct, sellable } from './products.js'
import { STAGES } from './stage.js'

export const MAX_OPEN_ALERTS = 10
export const ALERT_DAYS = 14
/** Reminder a week after delivery, sent between 10:00 and 19:00 IST. */
export const REMINDER_AFTER_DAYS = 7
const REMINDER_HOURS = [10, 19]

const alertView = (a) => ({
  id: a.id, sku: a.sku, name: findProduct(a.sku)?.name ?? a.sku, stage: a.stage, pincode: a.pincode,
  createdAt: a.created_at, expiresAt: a.expires_at, notifiedAt: a.notified_at, availableOn: a.available_on,
})

export async function listAlerts(c, customerId) {
  const { rows } = await c.query(
    `SELECT * FROM stock_alerts WHERE customer_id = $1 AND cancelled_at IS NULL AND (notified_at IS NULL AND expires_at > $2 OR notified_at > $3)
      ORDER BY created_at DESC`,
    [customerId, now(), new Date(now().getTime() - 7 * 86_400_000)],
  )
  return rows.map(alertView)
}

/** "Tell me when it's back": one per box and ripeness; asking again keeps the one already open. */
export async function createAlert(c, customerId, { sku, stage, pincode }) {
  if (!sellable(sku)) throw badRequest(`${sku} is not sold`, 'INVALID_SKU')
  if (!STAGES.includes(stage)) throw badRequest('Choose a ripeness', 'INVALID_STAGE')
  const open = await c.query(
    `SELECT * FROM stock_alerts WHERE customer_id = $1 AND notified_at IS NULL AND cancelled_at IS NULL FOR UPDATE`,
    [customerId],
  )
  const same = open.rows.find((a) => a.sku === sku && a.stage === stage)
  if (same) {
    const { rows } = await c.query('UPDATE stock_alerts SET expires_at = $2, pincode = $3 WHERE id = $1 RETURNING *', [
      same.id, new Date(now().getTime() + ALERT_DAYS * 86_400_000), pincode,
    ])
    return alertView(rows[0])
  }
  if (open.rows.length >= MAX_OPEN_ALERTS) throw conflict(`You can have ${MAX_OPEN_ALERTS} alerts at a time. Remove one first.`, 'TOO_MANY_ALERTS')
  const { rows } = await c.query(
    `INSERT INTO stock_alerts (id, customer_id, sku, stage, pincode, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [newId('alr'), customerId, sku, stage, pincode, now(), new Date(now().getTime() + ALERT_DAYS * 86_400_000)],
  )
  return alertView(rows[0])
}

export async function cancelAlert(c, customerId, id) {
  const r = await c.query('UPDATE stock_alerts SET cancelled_at = $3 WHERE id = $1 AND customer_id = $2 AND cancelled_at IS NULL AND notified_at IS NULL', [id, customerId, now()])
  if (!r.rowCount) throw notFound('Alert not found')
}

/**
 * Tells customers waiting for a box and ripeness that it can be ordered again,
 * once each, then closes the alert. Stock is checked across the days open for
 * ordering right now.
 */
export async function sendStockAlerts(at = now()) {
  const { rows: open } = await query(
    `SELECT a.*, cu.phone FROM stock_alerts a JOIN customers cu ON cu.id = a.customer_id
      WHERE a.notified_at IS NULL AND a.cancelled_at IS NULL AND a.expires_at > $1 AND cu.deleted_at IS NULL
      ORDER BY a.created_at LIMIT 500`,
    [at],
  )
  if (!open.length) return 0
  const firstWithStock = new Map()
  for (const [d, pool] of await availabilityByDate({ query }, await orderableDates({ query }, at))) {
    for (const [key, qty] of pool) if (qty > 0 && !firstWithStock.has(key)) firstWithStock.set(key, d)
  }
  let sent = 0
  for (const a of open) {
    if (!canStartCall(2_000)) break
    const date = firstWithStock.get(`${a.sku}|${a.stage}`)
    if (!date || !sellable(a.sku)) continue
    await tx(async (c) => {
      const r = await c.query('UPDATE stock_alerts SET notified_at = $2, available_on = $3 WHERE id = $1 AND notified_at IS NULL', [a.id, at, date])
      if (r.rowCount && a.phone) await enqueueAlert(c, a.id, a.phone)
    })
    sent++
  }
  await query('UPDATE stock_alerts SET cancelled_at = $1 WHERE notified_at IS NULL AND cancelled_at IS NULL AND expires_at <= $1', [at])
  return sent
}

/**
 * A week after delivery, a nudge to order again, for customers who turned
 * reminders on. Once per order, and not if they have ordered since.
 */
export async function sendReorderReminders(at = now()) {
  const hour = istParts(at).hour
  if (hour < REMINDER_HOURS[0] || hour >= REMINDER_HOURS[1]) return 0
  const due = addDays(istParts(at).date, -REMINDER_AFTER_DAYS)
  const { rows } = await query(
    `SELECT o.id, o.customer_id FROM orders o JOIN customers cu ON cu.id = o.customer_id
      WHERE o.status = 'DELIVERED' AND o.reorder_reminded_at IS NULL AND o.replacement_for IS NULL
        AND o.delivery_date = $1 AND cu.reminders_opt_in AND cu.deleted_at IS NULL AND cu.phone IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM orders n WHERE n.customer_id = o.customer_id AND n.placed_at > o.placed_at AND n.status <> 'CANCELLED')
      ORDER BY o.placed_at LIMIT 100`,
    [due],
  )
  let n = 0
  for (const o of rows) {
    if (!canStartCall(2_000)) break
    await tx(async (c) => {
      const r = await c.query('UPDATE orders SET reorder_reminded_at = $2 WHERE id = $1 AND reorder_reminded_at IS NULL', [o.id, at])
      // A customer with two deliveries that day gets one reminder.
      const other = await c.query('SELECT 1 FROM orders WHERE customer_id = $1 AND reorder_reminded_at = $2 AND id <> $3', [o.customer_id, at, o.id])
      if (r.rowCount && !other.rowCount) await enqueue(c, o.id, newId('rem'), 'REORDER_REMINDER')
    })
    n++
  }
  return n
}
