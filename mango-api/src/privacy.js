// Account deletion (DPDP Act). Used by DELETE /v1/me, and after a database
// restore to re-apply deletions made since the restore point
// (ops/reapply-deletions.js), so a restore never brings a deleted account back.
import { now } from './clock.js'
import { conflict, notFound } from './errors.js'

/**
 * Anything still in progress for the customer: an open order or booking, or
 * money still owed back to them (a refund or a second payment not yet
 * refunded). The account can't be deleted until these finish, because we'd
 * lose the phone number we need to reach them.
 */
export async function hasOpenBusiness(c, customerId) {
  const { rowCount } = await c.query(
    `SELECT 1 FROM orders WHERE customer_id = $1
        AND (status NOT IN ('DELIVERED', 'CANCELLED', 'RTO') OR (refund_requested_at IS NOT NULL AND refunded_at IS NULL))
     UNION ALL
     SELECT 1 FROM preorders WHERE customer_id = $1
        AND (status IN ('PAYMENT_PENDING', 'BOOKED', 'WAITLISTED') OR (refund_requested_at IS NOT NULL AND refunded_at IS NULL))
     UNION ALL
     SELECT 1 FROM duplicate_payments d
       LEFT JOIN orders o ON o.id = d.order_id LEFT JOIN preorders p ON p.id = d.preorder_id
      WHERE d.refunded_at IS NULL AND (o.customer_id = $1 OR p.customer_id = $1)
     LIMIT 1`,
    [customerId],
  )
  return rowCount > 0
}

/**
 * Removes the customer's name, phone, email, addresses, notes and photos from
 * the account, its orders, bookings and claims. Orders keep their amounts for
 * the books. Returns the stored photos to drop after commit. `force` skips the
 * open-business check (re-applying a deletion that already happened once).
 */
export async function eraseCustomer(c, customerId, { force = false, deletedAt = now() } = {}) {
  const { rows } = await c.query('SELECT id, phone FROM customers WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [customerId])
  if (!rows.length) throw notFound('Customer not found')
  const me = rows[0]
  if (!force && (await hasOpenBusiness(c, me.id))) throw conflict('You have an order or booking that is not finished yet. Cancel it, or wait until it is delivered, then delete your account.', 'OPEN_ORDERS')
  await c.query(
    `UPDATE orders SET customer_name = NULL, phone = NULL, delivery_address = NULL,
            gift_recipient_name = NULL, gift_recipient_phone = NULL, gift_message = NULL WHERE customer_id = $1`,
    [me.id],
  )
  await c.query(
    `UPDATE delivery_attempts SET received_by = NULL, note = NULL, lat = NULL, lng = NULL
      WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`,
    [me.id],
  )
  const deliveryPics = await c.query(
    `SELECT blob_path FROM delivery_photos WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1) AND removed_at IS NULL FOR UPDATE`,
    [me.id],
  )
  await c.query(
    `UPDATE delivery_photos SET removed_at = $2, bytes = NULL, blob_path = NULL
      WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1) AND removed_at IS NULL`,
    [me.id, now()],
  )
  await c.query(`UPDATE preorders SET customer_name = NULL, phone = '', delivery_address = '' WHERE customer_id = $1`, [me.id])
  await c.query(`UPDATE claims SET description = '(removed when the account was deleted)', photo_url = NULL WHERE customer_id = $1`, [me.id])
  await c.query(
    `UPDATE notifications SET phone = '', status = CASE WHEN status = 'PENDING' THEN 'SKIPPED' ELSE status END
      WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`,
    [me.id],
  )
  const pics = await c.query('DELETE FROM claim_photos WHERE customer_id = $1 RETURNING blob_path', [me.id])
  await c.query('DELETE FROM customer_addresses WHERE customer_id = $1', [me.id])
  // Neighborhood Unlock keeps the count but forgets who.
  await c.query('UPDATE unlock_participants SET customer_id = NULL, order_id = NULL WHERE customer_id = $1', [me.id])
  await c.query('UPDATE stock_alerts SET cancelled_at = COALESCE(cancelled_at, $2) WHERE customer_id = $1', [me.id, now()])
  await c.query(
    `UPDATE notifications SET phone = '', status = CASE WHEN status = 'PENDING' THEN 'SKIPPED' ELSE status END
      WHERE stock_alert_id IN (SELECT id FROM stock_alerts WHERE customer_id = $1)`,
    [me.id],
  )
  await c.query('UPDATE order_ratings SET comment = NULL WHERE customer_id = $1', [me.id])
  await c.query('DELETE FROM carts WHERE customer_id = $1', [me.id])
  await c.query('DELETE FROM quotes WHERE customer_id = $1', [me.id])
  await c.query('DELETE FROM wa_sessions WHERE customer_id = $1', [me.id])
  if (me.phone) {
    await c.query('DELETE FROM otps WHERE phone = $1', [me.phone])
    await c.query('DELETE FROM wa_inbound WHERE phone = $1', [me.phone])
    await c.query(`DELETE FROM rate_limits WHERE key LIKE $1`, [`otp-phone-day:${me.phone}:%`])
  }
  await c.query("UPDATE refresh_sessions SET revoked_at = $2 WHERE user_id = $1 AND user_type = 'customer' AND revoked_at IS NULL", [me.id, now()])
  await c.query('UPDATE customers SET phone = NULL, name = NULL, email = NULL, google_sub = NULL, reminders_opt_in = FALSE, deleted_at = $2 WHERE id = $1', [me.id, deletedAt])
  return [...pics.rows, ...deliveryPics.rows]
}
