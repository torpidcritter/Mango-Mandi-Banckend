// Farm Experience refunds (farm_refunds): sent and retried exactly like order
// refunds (payments.js): the row is leased before Razorpay is called, attempts
// back off, and after REFUND_MAX_ATTEMPTS a manager settles it. Each refund is
// tagged with its own id at Razorpay (notes.farmRefundId), and only refunds made
// under that tag count toward it. Farm refunds happen only when one bill was
// paid twice (online after a manager recorded a payment, or two online tries).
import { canStartCall } from '../budget.js'
import { now } from '../clock.js'
import { query, tx } from '../db.js'
import { env } from '../env.js'
import { logger } from '../logger.js'
import { metrics } from '../metrics.js'
import {
  disputeHolds, GATEWAY_CALL_MS, gatewayRefund, REFUND_LEASE_MS, REFUND_MAX_ATTEMPTS, refundBackoffMinutes, refundReceipt,
} from '../payments.js'
import { event, SYSTEM_ACTOR } from './bookings.js'
import { queueFarmMessages } from './notify.js'

const backoffSql = (col) => `LEAST(power(2, GREATEST(${col}, 1)), 60) * interval '1 minute'`

/** Takes one refund for sending, or null when it is done, backing off, given up on, held by a chargeback, or someone else has it. */
export async function claimFarmRefund(id, at = now()) {
  const { rows } = await query(
    `UPDATE farm_refunds SET refund_attempted_at = $2, refund_attempts = refund_attempts + 1,
            refund_next_attempt_at = $2::timestamptz + ${backoffSql('refund_attempts + 1')}
      WHERE id = $1 AND refunded_at IS NULL AND refund_gave_up_at IS NULL
        AND (refund_attempted_at IS NULL OR refund_attempted_at < $3)
        AND (refund_next_attempt_at IS NULL OR refund_next_attempt_at <= $2)
        AND NOT ($4 AND ${disputeHolds('farm_refunds.payment_id')})
      RETURNING *`,
    [id, at, new Date(at.getTime() - REFUND_LEASE_MS), env.REFUND_SAFETY_CHECKS],
  )
  return rows[0] ?? null
}

async function giveUp(id, attempts, why, c = { query }) {
  const { rows } = await c.query(
    `UPDATE farm_refunds SET refund_gave_up_at = $2, refund_status = 'failed', last_error = $3 WHERE id = $1 AND refunded_at IS NULL AND refund_gave_up_at IS NULL RETURNING *`,
    [id, now(), String(why ?? '').slice(0, 500)],
  )
  if (!rows.length) return false
  logger.error({ farmRefundId: id, attempts, why }, 'farm refund given up after its retries; a manager settles it')
  return true
}

/** Sends one refund. Safe to repeat. Returns the Razorpay refund id, or null when there was nothing to do. Throws on gateway errors. */
export async function sendFarmRefund(id) {
  const r = await claimFarmRefund(id)
  if (!r) return null
  let refundId
  try {
    refundId = await gatewayRefund({
      paymentId: r.payment_id, amount: r.amount, receipt: refundReceipt(r.id, r.refund_attempts), notes: { farmRefundId: r.id, bookingId: r.booking_id }, shared: true,
    })
  } catch (err) {
    metrics.refundFailures.inc({ kind: 'farm_refunds' })
    await query('UPDATE farm_refunds SET last_error = $2 WHERE id = $1', [r.id, String(err?.message ?? err).slice(0, 500)]).catch(() => {})
    if (r.refund_attempts >= REFUND_MAX_ATTEMPTS) await giveUp(r.id, r.refund_attempts, err?.message).catch(() => {})
    throw err
  }
  if (!refundId) return null
  await tx(async (c) => {
    const u = await c.query(
      `UPDATE farm_refunds SET refund_id = $2, refunded_at = $3, refund_status = 'pending', refund_checked_at = NULL, last_error = NULL WHERE id = $1 AND refunded_at IS NULL RETURNING id`,
      [r.id, refundId, now()],
    )
    if (!u.rowCount) return
    const { rows } = await c.query('SELECT * FROM farm_bookings WHERE id = $1 FOR UPDATE', [r.booking_id])
    await event(c, rows[0], { action: 'REFUND_SENT', detail: `${r.amount / 100} rupees sent back (${refundId})`, actor: SYSTEM_ACTOR })
    await queueFarmMessages(c, rows[0], 'REFUND_SENT', { tag: r.id })
  })
  return refundId
}

/** Sends refunds that are due (the maintenance loop, and right after a cancel). */
export async function processDueFarmRefunds(at = now(), { bookingId = null } = {}) {
  const { rows: spent } = await query(
    `SELECT id, refund_attempts FROM farm_refunds WHERE refunded_at IS NULL AND refund_gave_up_at IS NULL AND refund_attempts >= $1 AND refund_next_attempt_at < $2 LIMIT 20`,
    [REFUND_MAX_ATTEMPTS, at],
  )
  for (const s of spent) await giveUp(s.id, s.refund_attempts, 'no answer from the last attempt')
  const { rows } = await query(
    `SELECT id FROM farm_refunds
      WHERE refunded_at IS NULL AND refund_gave_up_at IS NULL AND (refund_next_attempt_at IS NULL OR refund_next_attempt_at <= $2)
        AND ($3::text IS NULL OR booking_id = $3) AND NOT ($1 AND ${disputeHolds('farm_refunds.payment_id')})
      ORDER BY requested_at LIMIT 50`,
    [env.REFUND_SAFETY_CHECKS, at, bookingId],
  )
  let n = 0
  for (const r of rows) {
    if (!canStartCall(GATEWAY_CALL_MS)) break
    try {
      if (await sendFarmRefund(r.id)) n++
    } catch (err) {
      logger.error({ err, farmRefundId: r.id }, 'farm refund failed; will retry')
    }
  }
  return n
}

/**
 * A refund webhook (refund.processed / refund.failed) or a reconcile check for a
 * farm refund. A failed one is reopened for another attempt after its back-off,
 * or left for a manager once attempts are spent. Returns how many rows matched.
 */
export async function applyFarmRefundOutcome(c, refundId, failed) {
  const { rows } = await c.query('SELECT * FROM farm_refunds WHERE refund_id = $1 FOR UPDATE', [refundId])
  for (const r of rows) {
    if (!failed) {
      await c.query(`UPDATE farm_refunds SET refund_status = 'processed', refund_checked_at = $2 WHERE id = $1`, [r.id, now()])
      continue
    }
    metrics.refundFailures.inc({ kind: 'farm_refunds' })
    await c.query(
      `UPDATE farm_refunds SET refund_status = 'failed', refunded_at = NULL, refund_id = NULL, refund_attempted_at = NULL, refund_checked_at = $2,
              refund_next_attempt_at = $2::timestamptz + make_interval(mins => $3) WHERE id = $1`,
      [r.id, now(), refundBackoffMinutes(r.refund_attempts)],
    )
    if (r.refund_attempts >= REFUND_MAX_ATTEMPTS) await giveUp(r.id, r.refund_attempts, `refund ${refundId} failed at Razorpay`, c)
  }
  return rows.length
}

/** A manager records a given-up refund as paid back another way (cash, bank transfer), with a reference. */
export async function settleFarmRefund(c, id, { reference, actor }) {
  const { rows } = await c.query(
    `UPDATE farm_refunds SET refunded_at = $2, refund_status = 'processed', refund_id = $3, last_error = NULL
      WHERE id = $1 AND refunded_at IS NULL RETURNING *`,
    [id, now(), `manual:${reference}`.slice(0, 120)],
  )
  if (!rows.length) return null
  const b = (await c.query('SELECT * FROM farm_bookings WHERE id = $1 FOR UPDATE', [rows[0].booking_id])).rows[0]
  await event(c, b, { action: 'REFUND_SETTLED', detail: `${rows[0].amount / 100} rupees paid back another way: ${reference}`, actor })
  return rows[0]
}
