// Farm Experience maintenance (docs/farm-experience.md), from the maintenance loop:
//   - unpaid bookings whose hold ran out give their mangoes back (EXPIRED), once
//     Razorpay was asked about them after the hold or GATEWAY_GRACE_MS has passed;
//   - a reminder two days before each confirmed visit (WHATSAPP_FARM_UPDATES).
// Payments still unpaid are reconciled with orders (payments.js), and refunds are
// sent by processDueRefunds.
import { addDays, now, todayIST } from '../clock.js'
import { query, tx } from '../db.js'
import { env } from '../env.js'
import { expireHold, GATEWAY_GRACE_MS } from './bookings.js'
import { queueFarmMessages } from './notify.js'

export async function runFarmJobs(at = now()) {
  let expired = 0
  for (let i = 0; i < 10; i++) {
    const n = await tx(async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM farm_bookings b
          WHERE status = 'PAYMENT_PENDING' AND hold_expires_at < $1
            AND (hold_expires_at < $2 OR EXISTS (SELECT 1 FROM farm_booking_payments p WHERE p.booking_id = b.id AND p.kind = 'BOOKING' AND p.reconcile_checked_at >= b.hold_expires_at))
          ORDER BY hold_expires_at LIMIT 50 FOR UPDATE SKIP LOCKED`,
        [at, new Date(at.getTime() - GATEWAY_GRACE_MS)],
      )
      for (const b of rows) await expireHold(c, b)
      return rows.length
    })
    expired += n
    if (n < 50) break
  }
  let reminded = 0
  if (env.WHATSAPP_FARM_UPDATES) {
    const day = addDays(todayIST(at), 2)
    const { rows } = await query(`SELECT * FROM farm_bookings WHERE visit_date = $1 AND status IN ('CONFIRMED', 'PREPARING', 'READY_FOR_VISIT')`, [day])
    for (const b of rows) reminded += await tx((c) => queueFarmMessages(c, b, 'REMINDER', { tag: `reminder:${b.visit_date}` }))
  }
  return { expired, reminded }
}
