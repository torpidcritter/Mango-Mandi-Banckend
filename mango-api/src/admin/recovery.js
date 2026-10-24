// Ways out of the problems Needs attention raises (owner's rule: every payment,
// refund, stock discrepancy or delivery exception has an owner and a visible
// recovery path). Managers only. Each action needs a reason, writes its
// staff_audit row inside its own transaction (with order_events, preorder_events
// or batch_ledger where it touches those), and is safe to repeat.
//
//   GET  /batches/:id/lines/:lineId/repair   what a ledger repair would change
//   POST /batches/:id/lines/:lineId/repair   re-derive the counters from the ledger
//   POST /webhook-failures/:id/resolve       mark a webhook problem handled
//   POST /webhook-failures/:id/refund        refund a captured payment that matches no order
//   POST /preorders/:id/keep                 keep a booking that needs a decision
//   POST /refunds/:id/paid-another-way       settle a refund Razorpay can't send
//   POST /staff/sign-out-all                 end every staff session at once
import express from 'express'
import { z } from 'zod'
import { forgetStaff, requireManager } from '../auth.js'
import { background } from '../background.js'
import { now } from '../clock.js'
import { query, tx } from '../db.js'
import { asyncHandler, conflict, HttpError, notFound, parse } from '../errors.js'
import { newId } from '../ids.js'
import { auditLedger, ledger } from '../inventory.js'
import { logger } from '../logger.js'
import { addEvent } from '../orders.js'
import { knownPayment, liveGatewayRefunds, REFUND_LEASE_MS, sendDueRefunds } from '../payments.js'
import { preordersNeedingDecision } from '../stock-watch.js'

export const router = express.Router()

const reason = z.string().trim().min(3, 'Say why (at least 3 characters)').max(500)

/** The staff_audit row, written with the change itself so it can't be lost after the response. */
async function auditIn(c, req, target, detail) {
  await c.query(
    `INSERT INTO staff_audit (id, admin_id, email, role, action, target, detail, request_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [newId('aud'), req.admin.id ?? null, req.admin.email, req.admin.role, `${req.method} ${req.route.path}`, target, detail, req.id ?? null, now()],
  )
  req.audited = true
}

/** A repeat that changes nothing: answered as it is, with no audit row (the first call wrote it). */
const noop = (req, out) => {
  req.audited = true
  return out
}

// ---------------------------------------------------------------- ledger drift

const COUNTERS = ['onHand', 'reserveBuffer', 'held', 'committed']

/**
 * What a repair would do to one line: the counters now, the counters the
 * ledger and the order stock say (on hand and the reserve buffer from
 * batch_ledger, held and to-pack from order_stock), and whether the result
 * keeps the no-oversell guard. Nothing in the ledger changes.
 */
async function repairPlan(c, batchId, lineId) {
  const { rows } = await c.query('SELECT id FROM batch_lines WHERE id = $1 AND batch_id = $2', [lineId, batchId])
  if (!rows.length) throw notFound('Batch line not found')
  const [d] = await auditLedger(c, { lineId })
  if (!d) return { lineId, batchId, drifting: false, before: null, after: null, canRepair: false, problem: null }
  const before = Object.fromEntries(COUNTERS.map((k) => [k, d[k][0]]))
  const after = Object.fromEntries(COUNTERS.map((k) => [k, d[k][1]]))
  const promised = after.held + after.committed + after.reserveBuffer
  let problem = null
  if (Math.min(...Object.values(after)) < 0) problem = `The ledger adds up to a negative count (${COUNTERS.filter((k) => after[k] < 0).join(', ')}). The owner investigates this one.`
  else if (after.onHand < promised) {
    problem =
      `The ledger has ${after.onHand} boxes on hand but ${promised} are promised to orders or reserved. ` +
      'Count the shelf: record extra boxes with Adjust stock, or fewer with Short arrival, then repair.'
  }
  return { lineId, batchId, sku: d.sku, drifting: true, before, after, canRepair: !problem, problem }
}

router.get(
  '/batches/:id/lines/:lineId/repair',
  requireManager,
  asyncHandler(async (req, res) => res.json(await tx((c) => repairPlan(c, req.params.id, req.params.lineId)))),
)

const counters = z.object({ onHand: z.number().int(), reserveBuffer: z.number().int(), held: z.number().int(), committed: z.number().int() })

/**
 * Sets a drifting line's counters to what the ledger and the order stock say.
 * The ledger stays append-only: one STATUS row (delta 0, not counted in any
 * sum) records the repair, its before and after, and the reason. `expected` is
 * the preview's `after`: if the books moved since the preview, nothing changes.
 * A line that no longer drifts answers { repaired: false } (a repeat is a no-op).
 */
router.post(
  '/batches/:id/lines/:lineId/repair',
  requireManager,
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ reason, expected: counters }), req.body)
    const out = await tx(async (c) => {
      // The line first: an allocation in flight finishes before the order stock is read.
      const { rows } = await c.query('SELECT id FROM batch_lines WHERE id = $1 AND batch_id = $2 FOR UPDATE', [req.params.lineId, req.params.id])
      if (!rows.length) throw notFound('Batch line not found')
      const plan = await repairPlan(c, req.params.id, req.params.lineId)
      if (!plan.drifting) return noop(req, { repaired: false, ...plan })
      if (COUNTERS.some((k) => plan.after[k] !== b.expected[k])) {
        throw new HttpError(409, 'PREVIEW_CHANGED', 'The stock moved since the preview. Look at the new numbers and repair again.', { after: plan.after })
      }
      if (!plan.canRepair) throw conflict(plan.problem, 'CANNOT_REPAIR')
      const a = plan.after
      await c.query('UPDATE batch_lines SET on_hand = $2, reserve_buffer = $3, held = $4, committed = $5 WHERE id = $1', [
        plan.lineId, a.onHand, a.reserveBuffer, a.held, a.committed,
      ])
      const changed = COUNTERS.filter((k) => plan.before[k] !== a[k]).map((k) => `${k} ${plan.before[k]} → ${a[k]}`)
      await ledger(c, {
        batchId: plan.batchId, eventType: 'STATUS', sku: plan.sku, delta: 0, actorId: req.admin.id,
        reason: `Counters repaired from the ledger (${changed.join(', ')}): ${b.reason}`,
      })
      await auditIn(c, req, `${plan.batchId}/${plan.lineId}`, { reason: b.reason, before: plan.before, after: a })
      return { repaired: true, ...plan }
    })
    res.json(out)
  }),
)

// ---------------------------------------------------------------- webhook problems

const resolvedView = (w) => ({ id: w.id, resolvedAt: w.resolved_at, resolvedBy: w.resolved_by, note: w.resolution_note })

async function resolveHook(c, req, w, note) {
  const { rows } = await c.query(
    'UPDATE webhook_failures SET resolved_at = $2, resolved_by = $3, resolution_note = $4 WHERE id = $1 RETURNING *',
    [w.id, now(), req.admin.email, note],
  )
  return rows[0]
}

/** Marks a webhook problem handled, with a note; it leaves Needs attention. Already resolved: answers as it is. */
router.post(
  '/webhook-failures/:id/resolve',
  requireManager,
  asyncHandler(async (req, res) => {
    const { note } = parse(z.object({ note: reason }), req.body)
    const out = await tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM webhook_failures WHERE id = $1 FOR UPDATE', [req.params.id])
      if (!rows.length) throw notFound('No webhook problem with that id')
      if (rows[0].resolved_at) return noop(req, { ...resolvedView(rows[0]), already: true })
      const w = await resolveHook(c, req, rows[0], note)
      await auditIn(c, req, w.id, { note, reason: w.reason, paymentId: w.payment_id })
      return resolvedView(w)
    })
    res.json(out)
  }),
)

/**
 * Refunds, in full, a captured payment that a webhook (or a restore replay)
 * could match to no order. It goes through the same machinery as a second
 * payment: a duplicate_payments row, leased and sent by refundDuplicatePayments
 * with a new receipt per attempt, and gatewayRefund reuses any refund already
 * at Razorpay. A payment that now belongs to an order or booking is refused.
 */
router.post(
  '/webhook-failures/:id/refund',
  requireManager,
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ reason }), req.body)
    const out = await tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM webhook_failures WHERE id = $1 FOR UPDATE', [req.params.id])
      if (!rows.length) throw notFound('No webhook problem with that id')
      const w = rows[0]
      if (!w.payment_id) throw conflict('This problem names no captured payment to refund', 'NO_PAYMENT')
      const dup = await c.query('SELECT payment_id FROM duplicate_payments WHERE payment_id = $1', [w.payment_id])
      if (dup.rowCount) return noop(req, { paymentId: w.payment_id, queued: true, already: true })
      if (await knownPayment(w.payment_id, c)) {
        throw conflict(`Payment ${w.payment_id} now belongs to an order or booking: there is nothing to refund here`, 'PAYMENT_MATCHED')
      }
      await c.query('INSERT INTO duplicate_payments (payment_id, amount, found_at) VALUES ($1, NULL, $2) ON CONFLICT DO NOTHING', [w.payment_id, now()])
      await resolveHook(c, req, w, `Refund in full sent: ${b.reason}`)
      await auditIn(c, req, w.payment_id, { reason: b.reason, webhookFailure: w.id })
      return { paymentId: w.payment_id, queued: true }
    })
    // After the response, like the webhook: the maintenance loop retries anything that fails.
    if (!out.already) background(sendDueRefunds({ duplicates: true }))
    res.json(out)
  }),
)

// ---------------------------------------------------------------- preorders

/**
 * Keeps a booking that Needs attention asks a manager about (moved too often,
 * or past the season end) without cancelling it. Recorded on the booking's
 * history; it stays off the list until it moves again.
 */
router.post(
  '/preorders/:id/keep',
  requireManager,
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ reason }), req.body)
    const out = await tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM preorders WHERE id = $1 FOR UPDATE', [req.params.id])
      if (!rows.length) throw notFound('Preorder not found')
      const p = rows[0]
      if (p.kept_moved_count === p.moved_count && p.kept_week_start === p.week_start) return noop(req, { id: p.id, kept: true, already: true })
      const due = (await preordersNeedingDecision(c, 10_000)).some((x) => x.id === p.id)
      if (!due) throw conflict('This booking does not need a decision', 'NO_DECISION_NEEDED')
      await c.query('UPDATE preorders SET kept_moved_count = moved_count, kept_week_start = week_start WHERE id = $1', [p.id])
      await c.query('INSERT INTO preorder_events (id, preorder_id, status, reason, actor, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [
        newId('pev'), p.id, p.status, `Kept by a manager after moving ${p.moved_count} times (week of ${p.week_start}): ${b.reason}`, req.admin.email, now(),
      ])
      await auditIn(c, req, p.id, { reason: b.reason, movedCount: p.moved_count, weekStart: p.week_start })
      return { id: p.id, kept: true }
    })
    res.json(out)
  }),
)

// ---------------------------------------------------------------- refunds

/** Refunds younger than this are still Razorpay's to send (Needs attention lists them after it too). */
const REFUND_STUCK_MS = 30 * 60_000
const MANUAL = 'manual'

const REFUND_TABLES = {
  order: { table: 'orders', key: 'id', requested: 'refund_requested_at', attempted: 'refund_attempted_at' },
  preorder: { table: 'preorders', key: 'id', requested: 'refund_requested_at', attempted: 'refund_attempted_at' },
  payment: { table: 'duplicate_payments', key: 'payment_id', requested: 'found_at', attempted: 'attempted_at' },
}

/**
 * A refund the business rules already allow that Razorpay can never send (the
 * account closed, the bank refused for good): the manager paid the customer
 * back another way and records it here, with the reference. The refund stops
 * retrying and counts as refunded (refunded_at, so Analytics' refunds include
 * it), marked refund_status 'manual' and refund_id 'manual:<reference>'.
 * type: order, preorder, or payment (a second payment or one that matched no
 * order, by its payment id). Not while a refund attempt holds the lease, and
 * not when Razorpay already shows a refund for the payment.
 */
router.post(
  '/refunds/:id/paid-another-way',
  requireManager,
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({ type: z.enum(['order', 'preorder', 'payment']), reference: z.string().trim().min(3, 'Give the reference of the payment you made').max(100), reason }),
      req.body,
    )
    const t = REFUND_TABLES[b.type]
    const refundId = `${MANUAL}:${b.reference}`
    const at = now()
    const { rows } = await query(`SELECT * FROM ${t.table} WHERE ${t.key} = $1`, [req.params.id])
    const row = rows[0]
    if (!row || (b.type !== 'payment' && !row.refund_requested_at)) throw notFound('No refund due with that id')
    if (row.refunded_at) {
      if (row.refund_status === MANUAL && row.refund_id === refundId) return res.json(noop(req, { id: req.params.id, refundId, already: true }))
      throw conflict('This refund is already recorded as sent', 'ALREADY_REFUNDED')
    }
    if (at - row[t.requested] < REFUND_STUCK_MS) throw conflict('This refund was asked for less than 30 minutes ago. Give Razorpay time to send it.', 'REFUND_NOT_STUCK')
    // Razorpay may have taken a refund we never recorded (sent, then the save failed): that one counts, not a second payout.
    let checkNote = ''
    try {
      const live = await liveGatewayRefunds(row.payment_id)
      if (live.length) throw conflict(`Razorpay already shows refund ${live[0].id} for this payment. The next run records it; don't pay again.`, 'RAZORPAY_HAS_REFUND')
    } catch (err) {
      if (err instanceof HttpError) throw err
      logger.warn({ err, id: req.params.id }, 'could not check Razorpay before recording a refund paid another way')
      checkNote = ' (Razorpay could not be checked)'
    }
    const out = await tx(async (c) => {
      // The lease: a refund attempt that is calling Razorpay right now finishes first.
      const extra = b.type === 'payment' ? '' : `, payment_status = 'REFUNDED'`
      const upd = await c.query(
        `UPDATE ${t.table} SET refunded_at = $2, refund_id = $3, refund_status = '${MANUAL}', refund_checked_at = $2${extra}
          WHERE ${t.key} = $1 AND refunded_at IS NULL AND (${t.attempted} IS NULL OR ${t.attempted} < $4) RETURNING *`,
        [req.params.id, at, refundId, new Date(at.getTime() - REFUND_LEASE_MS)],
      )
      if (!upd.rowCount) throw conflict('A refund attempt is running or just finished. Wait two minutes and look again.', 'REFUND_IN_PROGRESS')
      const r = upd.rows[0]
      const note = `Refund paid back outside Razorpay by ${req.admin.email} (${b.reference})${checkNote}: ${b.reason}`
      const orderId = b.type === 'order' ? r.id : b.type === 'payment' ? r.order_id : null
      if (orderId) {
        const { rows: o } = await c.query('SELECT status FROM orders WHERE id = $1', [orderId])
        await addEvent(c, orderId, o[0].status, o[0].status, req.actor, b.type === 'payment' ? `Second payment ${r.payment_id}: ${note}` : note)
      }
      const preorderId = b.type === 'preorder' ? r.id : b.type === 'payment' ? r.preorder_id : null
      if (preorderId) {
        const { rows: p } = await c.query('SELECT status FROM preorders WHERE id = $1', [preorderId])
        await c.query('INSERT INTO preorder_events (id, preorder_id, status, reason, actor, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [
          newId('pev'), preorderId, p[0].status, note, req.admin.email, now(),
        ])
      }
      await auditIn(c, req, req.params.id, { type: b.type, reference: b.reference, reason: b.reason, paymentId: r.payment_id ?? null, razorpayChecked: !checkNote })
      return { id: req.params.id, refundId }
    })
    res.json(out)
  }),
)

// ---------------------------------------------------------------- staff sessions

/**
 * Signs every staff member out at once (a leaked password, a lost laptop with
 * many sessions): like a per-person change on the Staff page, each one's
 * session version moves on (access tokens stop working) and their refresh
 * sessions are revoked. keepMe (default true) leaves the caller signed in.
 */
router.post(
  '/staff/sign-out-all',
  requireManager,
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ reason, keepMe: z.boolean().default(true) }), req.body)
    const keep = b.keepMe ? req.admin.id : null
    const ids = await tx(async (c) => {
      const { rows } = await c.query('UPDATE admin_users SET session_version = session_version + 1 WHERE id IS DISTINCT FROM $1 RETURNING id', [keep])
      await c.query(
        "UPDATE refresh_sessions SET revoked_at = $2 WHERE user_type = 'admin' AND revoked_at IS NULL AND user_id IS DISTINCT FROM $1",
        [keep, now()],
      )
      await auditIn(c, req, null, { reason: b.reason, keepMe: b.keepMe, signedOut: rows.length })
      return rows.map((r) => r.id)
    })
    for (const id of ids) forgetStaff(id)
    res.json({ signedOut: ids.length, keptMe: b.keepMe })
  }),
)
