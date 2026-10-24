// How long finished rows are kept. Called from the maintenance cleanup step
// (cleanupExpired), which runs once a minute: each call deletes a bounded
// number of rows, and a backlog drains over a few runs.
import { query } from './db.js'
import { now, todayIST } from './clock.js'
import { env } from './env.js'
import { scrubOrderAudit } from './privacy.js'

/** Sent, failed and skipped customer messages are kept this long (the order page shows them). */
export const NOTIFICATION_RETENTION_DAYS = 180
const PRUNE_BATCH = 5_000

/**
 * Deletes finished notifications older than the retention window. PENDING
 * rows are never touched. Nothing queues a message for an event this old
 * (the longest look-back, review requests, is 72 hours), so removing a row
 * cannot cause a second send. Returns how many rows went.
 */
export async function pruneNotifications(at = now(), { days = NOTIFICATION_RETENTION_DAYS, batch = PRUNE_BATCH } = {}) {
  const r = await query(
    `DELETE FROM notifications WHERE id IN (
       SELECT id FROM notifications WHERE created_at < $1 AND status IN ('SENT', 'FAILED', 'SKIPPED') LIMIT $2)`,
    [new Date(at.getTime() - days * 86_400_000), batch],
  )
  return r.rowCount
}

/** The date `months` calendar months before `day` (YYYY-MM-DD), clamped to that month's last day. */
export function monthsBefore(day, months) {
  const [y, m, d] = day.split('-').map(Number)
  const first = new Date(Date.UTC(y, m - 1 - months, 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  first.setUTCDate(Math.min(d, last))
  return first.toISOString().slice(0, 10)
}

/**
 * SEC-05: removes the customer's details from orders finished more than
 * PII_RETENTION_MONTHS (default 12) ago: name, phone, address, gift recipient
 * and message on the order, and who took it and where the rider stood on its
 * delivery attempts. Amounts, items, tax fields and dates stay for the books.
 * Orders with money still owed back are left until it is paid. The account
 * itself is untouched (the customer can still delete it). Bounded per call;
 * the daily maintenance pass repeats until none are left. Returns the count.
 */
export async function anonymiseOldOrders(at = now(), { months = env.PII_RETENTION_MONTHS, batch = 1_000 } = {}) {
  const cutoff = monthsBefore(todayIST(at), months)
  const { rows } = await query(
    `UPDATE orders SET customer_name = NULL, phone = NULL, delivery_address = NULL,
            gift_recipient_name = NULL, gift_recipient_phone = NULL, gift_message = NULL, pii_removed_at = $3
      WHERE id IN (
        SELECT id FROM orders
         WHERE pii_removed_at IS NULL AND delivery_date < $1 AND status IN ('DELIVERED', 'CANCELLED', 'RTO')
           AND NOT (refund_requested_at IS NOT NULL AND refunded_at IS NULL)
         LIMIT $2)
      RETURNING id`,
    [cutoff, batch, at],
  )
  if (rows.length) {
    await query('UPDATE delivery_attempts SET received_by = NULL, note = NULL, lat = NULL, lng = NULL WHERE order_id = ANY($1)', [rows.map((r) => r.id)])
    await scrubOrderAudit({ query }, 'SELECT unnest($1::text[])', [rows.map((r) => r.id)])
  }
  return rows.length
}
