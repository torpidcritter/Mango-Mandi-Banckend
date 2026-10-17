// Maintenance, once a minute: Vercel Cron calls /internal/maintenance, and a
// long-running server (local, Docker) runs it on a timer. A transaction-scoped
// advisory lock makes overlapping or repeated calls skip instead of running
// twice; it works through Neon's transaction pooler, unlike a session lock.
// Nothing is kept in memory between runs (serverless instances come and go):
// when the hourly and daily passes last ran is read from maintenance_runs.
// Order matters: payments are reconciled before the hold sweeper, so a paid
// order is never cancelled for non-payment.
import { dropPhoto } from './photos.js'
import { addDays, todayIST } from './clock.js'
import { getConfig, loadConfig } from './config.js'
import { pool, query, tx } from './db.js'
import { auditLedger } from './inventory.js'
import { logger } from './logger.js'
import { metrics } from './metrics.js'
import { allocatePreorders, expirePreorderHolds, promoteWaitlist, reconcilePreorderPayments, retryMissingLinks } from './preorders.js'
import { OPEN_STATUSES, rebalanceOrder, SYSTEM, sweepExpiredHolds, takeBatchOutOfService } from './orders.js'
import { sendDueNotifications } from './notify.js'
import { processDueRefunds, reconcilePendingPayments } from './payments.js'
import { now } from './clock.js'

const MAINTENANCE_LOCK = 427714202
const TICK_MS = 60_000
const HOURLY_MS = 3_600_000

let timer = null
const DAILY_MS = 24 * HOURLY_MS

/** Asks the next run to re-check every open order (after a rules change). */
export async function triggerRebalanceAll() {
  await markRun('rebalance-requested')
}

const markRun = (name) =>
  query(`INSERT INTO maintenance_runs (step, last_ok_at) VALUES ($1, $2) ON CONFLICT (step) DO UPDATE SET last_ok_at = $2`, [name, now()])

/** When each step last succeeded, in ms since the epoch (0 = never). */
async function lastRuns() {
  const { rows } = await query('SELECT step, last_ok_at FROM maintenance_runs')
  return Object.fromEntries(rows.map((r) => [r.step, r.last_ok_at ? r.last_ok_at.getTime() : 0]))
}

/** Runs one step, recording success or failure in maintenance_runs for the Needs attention view. */
async function step(name, fn) {
  try {
    const out = await fn()
    await query(
      `INSERT INTO maintenance_runs (step, last_ok_at) VALUES ($1, $2) ON CONFLICT (step) DO UPDATE SET last_ok_at = $2`,
      [name, now()],
    ).catch(() => {})
    return out
  } catch (err) {
    metrics.maintenanceErrors.inc({ step: name })
    logger.error({ err, step: name }, 'maintenance step failed')
    await query(
      `INSERT INTO maintenance_runs (step, last_err_at, last_error) VALUES ($1, $2, $3)
       ON CONFLICT (step) DO UPDATE SET last_err_at = $2, last_error = $3`,
      [name, now(), String(err?.message ?? err).slice(0, 500)],
    ).catch(() => {})
    return null
  }
}

export async function cleanupExpired(at = now()) {
  const day = 86_400_000
  await query('DELETE FROM otps WHERE expires_at < $1', [new Date(at.getTime() - HOURLY_MS)])
  await query('DELETE FROM quotes WHERE expires_at < $1', [at])
  await query('DELETE FROM idempotency_keys WHERE created_at < $1', [new Date(at.getTime() - 7 * day)])
  await query('DELETE FROM processed_webhooks WHERE created_at < $1', [new Date(at.getTime() - 30 * day)])
  await query('DELETE FROM wa_inbound WHERE received_at < $1', [new Date(at.getTime() - 7 * day)])
  await query('DELETE FROM webhook_failures WHERE created_at < $1', [new Date(at.getTime() - 30 * day)])
  await query('DELETE FROM refresh_sessions WHERE expires_at < $1', [new Date(at.getTime() - day)])
  // Claim photos uploaded but never sent with a claim.
  const loose = await query('DELETE FROM claim_photos WHERE claim_id IS NULL AND created_at < $1 RETURNING blob_path', [new Date(at.getTime() - day)])
  for (const row of loose.rows) await dropPhoto(row)
}

/** Batches at the retirement age leave the storefront (status EXHAUSTED). */
export async function retireBatches() {
  const cutoff = addDays(todayIST(), -getConfig().retireAge)
  const { rows } = await query(`SELECT id FROM batches WHERE status NOT IN ('EXHAUSTED', 'CONDEMNED') AND plucked_on <= $1`, [cutoff])
  for (const { id } of rows) {
    await tx(async (c) => {
      const { rows: b } = await c.query('SELECT status FROM batches WHERE id = $1 FOR UPDATE', [id])
      if (['EXHAUSTED', 'CONDEMNED'].includes(b[0].status)) return
      await c.query(`UPDATE batches SET status = 'EXHAUSTED' WHERE id = $1`, [id])
      const r = await takeBatchOutOfService(c, id, 'EXHAUSTED', SYSTEM)
      logger.info({ batchId: id, ...r }, 'batch retired at age limit')
    })
  }
  return rows.length
}

/**
 * Re-checks open orders. Stock and batch changes already re-check the orders
 * they touch, so the hourly pass only retries at-risk orders (cheap even in
 * peak season); every open order is re-checked after a rules change and once a
 * day as a safety net.
 */
export async function rebalanceAllOpen({ atRiskOnly = false } = {}) {
  const { rows } = await query(
    `SELECT id FROM orders o WHERE status = ANY($1)
        AND (at_risk OR (NOT $2 AND EXISTS (SELECT 1 FROM order_stock s WHERE s.order_id = o.id AND s.state IN ('held', 'committed', 'packed'))))
      ORDER BY placed_at`,
    [OPEN_STATUSES, atRiskOnly],
  )
  let touched = 0
  for (const { id } of rows) {
    const r = await step('rebalance', () => tx((c) => rebalanceOrder(c, id, SYSTEM)))
    if (r?.changed) touched++
  }
  return touched
}

export async function runAudit() {
  const drift = await tx((c) => auditLedger(c))
  metrics.ledgerDrift.set(drift.length)
  if (drift.length) logger.error({ drift: drift.slice(0, 20) }, 'ledger audit: counters disagree with their sources')
  return drift
}

/** Preorder upkeep: missed payments, expired holds, waitlist, links, then the allocator. */
export async function runPreorderJobs() {
  const reconciled = await reconcilePreorderPayments()
  const expired = await tx((c) => expirePreorderHolds(c))
  const promoted = await promoteWaitlist()
  await retryMissingLinks()
  const { converted, moved } = await allocatePreorders()
  return { reconciled, expired, promoted, converted, moved }
}

/** One maintenance run. Returns { skipped: true } when another run holds the lock. */
export async function runMaintenance({ forceAll = false } = {}) {
  await step('config', loadConfig) // every instance keeps its rules fresh
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [MAINTENANCE_LOCK])
    if (!rows[0].ok) return { skipped: true }
    const out = {}
    out.reconciled = await step('reconcile', () => reconcilePendingPayments())
    out.refunded = await step('refunds', processDueRefunds)
    out.preorders = await step('preorders', runPreorderJobs)
    out.notified = await step('notifications', () => sendDueNotifications())
    out.expired = await step('sweep', () => tx((c) => sweepExpiredHolds(c)))
    if (out.expired) metrics.holdsExpired.inc(out.expired)
    await step('cleanup', () => cleanupExpired())
    out.retired = await step('retire', retireBatches)
    const t = now().getTime()
    const last = await lastRuns()
    const lastFull = last['rebalance-all'] ?? 0
    if (forceAll || (last['rebalance-requested'] ?? 0) > lastFull || t - lastFull > DAILY_MS) {
      out.rebalanced = await step('rebalance-all', () => rebalanceAllOpen())
    } else if (t - Math.max(lastFull, last['rebalance-at-risk'] ?? 0) > HOURLY_MS) {
      out.rebalanced = await step('rebalance-at-risk', () => rebalanceAllOpen({ atRiskOnly: true }))
    }
    if (forceAll || t - (last.audit ?? 0) > HOURLY_MS) {
      out.drift = (await step('audit', runAudit))?.length ?? null
    }
    const risk = await query(`SELECT COUNT(*)::int AS n FROM orders WHERE at_risk AND status = ANY($1)`, [OPEN_STATUSES])
    out.atRisk = risk.rows[0].n
    metrics.ordersAtRisk.set(out.atRisk)
    metrics.maintenanceLastRun.set(Date.now() / 1000)
    await markRun('tick')
    return out
  } finally {
    // Ends the transaction, which releases the lock.
    await client.query('COMMIT').catch(() => {})
    client.release()
  }
}

/** How long ago the last full run finished, in seconds (null = never). Used by /ready. */
export async function lastTickAgeSeconds() {
  const { rows } = await query(`SELECT last_ok_at FROM maintenance_runs WHERE step = 'tick'`)
  return rows[0]?.last_ok_at ? Math.round((now().getTime() - rows[0].last_ok_at.getTime()) / 1000) : null
}

export function startMaintenance() {
  if (timer) return
  timer = setInterval(() => {
    runMaintenance().catch((err) => logger.error({ err }, 'maintenance tick failed'))
  }, TICK_MS)
  timer.unref()
}

export function stopMaintenance() {
  clearInterval(timer)
  timer = null
}
