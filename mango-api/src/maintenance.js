// Maintenance, once a minute: Vercel Cron calls /internal/maintenance, and a
// long-running server (local, Docker) runs it on a timer. A lease row in
// job_leases makes overlapping or repeated calls skip instead of running
// twice; unlike a lock held in an open transaction, it doesn't pin a pooled
// connection for the whole run, and a run killed at Vercel's 60-second limit
// loses it when it expires.
// Each run has a 45-second budget (budget.js). Loops stop when time is short
// and the next run carries on, so a slow Razorpay or WhatsApp day delays work
// by a minute instead of killing the run halfway.
// Nothing is kept in memory between runs (serverless instances come and go):
// when the hourly and daily passes last ran is read from maintenance_runs.
// Order matters: payments are reconciled before the hold sweeper, so a paid
// order is never cancelled for non-payment, and the sweeper runs second so
// stock held by unpaid orders always comes back, even on a slow day.
import { dropPhoto } from './photos.js'
import { addDays, todayIST } from './clock.js'
import { getConfig, loadConfig } from './config.js'
import { randomUUID } from 'node:crypto'
import { outOfTime, withBudget } from './budget.js'
import { query, tx } from './db.js'
import { auditLedger } from './inventory.js'
import { logger } from './logger.js'
import { metrics } from './metrics.js'
import { allocatePreorders, expirePreorderHolds, promoteWaitlist, reconcilePreorderPayments, retryMissingLinks } from './preorders.js'
import { OPEN_STATUSES, rebalanceOrder, SYSTEM, sweepExpiredHolds, takeBatchOutOfService } from './orders.js'
import { sendDueNotifications } from './notify.js'
import { processDueRefunds, reconcilePendingPayments, refundDuplicatePayments } from './payments.js'
import { cronCheckIn } from './sentry.js'
import { now } from './clock.js'
import { evaluateDueCampaigns, runTemplates } from './unlock.js'

/** The run's time budget, under Vercel's 60-second limit. */
export const RUN_BUDGET_MS = 45_000
/** How long a run's lease lasts; a run is over well before (budget + one slow call). */
const LEASE_MS = 65_000
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

/** Steps that need this much time left are put off to the next run. */
const STEP_MIN_MS = 3_000

/**
 * Runs one step, recording success or failure in maintenance_runs for the
 * Needs attention view. With too little time left it is skipped (not an
 * error): the next run does it.
 */
async function step(name, fn, { minMs = STEP_MIN_MS } = {}) {
  if (outOfTime(minMs)) {
    logger.warn({ step: name }, 'maintenance step put off to the next run: out of time')
    metrics.maintenanceSkips.inc({ step: name })
    return null
  }
  try {
    const out = await fn()
    // A step that stopped early (out of time) isn't marked done, so it runs again next time.
    if (out?.partial) return out
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

/**
 * Takes the maintenance lease, or returns null when another run holds it.
 * The holder id makes sure a run only ever releases its own lease.
 */
export async function takeLease(name, ms = LEASE_MS, at = now()) {
  const holder = randomUUID()
  const { rowCount } = await query(
    `INSERT INTO job_leases (name, holder, expires_at) VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET holder = $2, expires_at = $3 WHERE job_leases.expires_at <= $4`,
    [name, holder, new Date(at.getTime() + ms), at],
  )
  return rowCount ? holder : null
}

export const releaseLease = (name, holder) => query('DELETE FROM job_leases WHERE name = $1 AND holder = $2', [name, holder])

export async function cleanupExpired(at = now()) {
  const day = 86_400_000
  await query('DELETE FROM otps WHERE expires_at < $1', [new Date(at.getTime() - HOURLY_MS)])
  await query('DELETE FROM quotes WHERE expires_at < $1', [at])
  await query('DELETE FROM idempotency_keys WHERE created_at < $1', [new Date(at.getTime() - 7 * day)])
  await query('DELETE FROM processed_webhooks WHERE created_at < $1', [new Date(at.getTime() - 30 * day)])
  await query('DELETE FROM wa_inbound WHERE received_at < $1', [new Date(at.getTime() - 7 * day)])
  await query('DELETE FROM webhook_failures WHERE created_at < $1', [new Date(at.getTime() - 30 * day)])
  await query('DELETE FROM refresh_sessions WHERE expires_at < $1', [new Date(at.getTime() - day)])
  await query('DELETE FROM rate_limits WHERE reset_at < $1', [new Date(at.getTime() - HOURLY_MS)])
  await query('DELETE FROM job_leases WHERE expires_at < $1', [new Date(at.getTime() - day)])
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
 * day as a safety net. The full pass can be longer than one run: it saves
 * where it stopped and the next run carries on (returns { partial: true }).
 */
export async function rebalanceAllOpen({ atRiskOnly = false } = {}) {
  const name = atRiskOnly ? 'rebalance-at-risk' : 'rebalance-all'
  const saved = (await query('SELECT cursor FROM maintenance_runs WHERE step = $1', [name])).rows[0]?.cursor ?? null
  const from = saved ? JSON.parse(saved) : null
  const { rows } = await query(
    `SELECT id, placed_at FROM orders o WHERE status = ANY($1)
        AND (at_risk OR (NOT $2 AND EXISTS (SELECT 1 FROM order_stock s WHERE s.order_id = o.id AND s.state IN ('held', 'committed', 'packed'))))
        AND ($3::timestamptz IS NULL OR (placed_at, id) >= ($3::timestamptz, $4::text))
      ORDER BY placed_at, id`,
    [OPEN_STATUSES, atRiskOnly, from?.at ?? null, from?.id ?? ''],
  )
  let touched = 0
  for (const o of rows) {
    if (outOfTime(2_000)) {
      await query(
        `INSERT INTO maintenance_runs (step, cursor) VALUES ($1, $2) ON CONFLICT (step) DO UPDATE SET cursor = $2`,
        [name, JSON.stringify({ at: o.placed_at.toISOString(), id: o.id })],
      )
      logger.warn({ step: name, done: touched }, 'order re-check stopped for time; the next run carries on')
      return { partial: true, touched }
    }
    const r = await step('rebalance', () => tx((c) => rebalanceOrder(c, o.id, SYSTEM)), { minMs: 0 })
    if (r?.changed) touched++
  }
  if (from) await query('UPDATE maintenance_runs SET cursor = NULL WHERE step = $1', [name])
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
  if (outOfTime(STEP_MIN_MS)) return { partial: true, reconciled, expired }
  const promoted = await promoteWaitlist()
  await retryMissingLinks()
  if (outOfTime(STEP_MIN_MS)) return { partial: true, reconciled, expired, promoted }
  const { converted, moved } = await allocatePreorders()
  return { reconciled, expired, promoted, converted, moved }
}

/**
 * One maintenance run. Returns { skipped: true } when another run holds the
 * lease. `budgetMs` is the time the run may take (tests shorten it).
 */
export async function runMaintenance({ forceAll = false, budgetMs = RUN_BUDGET_MS } = {}) {
  return withBudget(budgetMs, async () => {
    await step('config', loadConfig) // every instance keeps its rules fresh
    const holder = await takeLease('maintenance')
    if (!holder) return { skipped: true }
    const checkIn = cronCheckIn('in_progress')
    try {
      const out = await steps(forceAll)
      cronCheckIn('ok', checkIn)
      return out
    } catch (err) {
      cronCheckIn('error', checkIn)
      throw err
    } finally {
      await releaseLease('maintenance', holder).catch((err) => logger.warn({ err }, 'could not release the maintenance lease'))
    }
  })
}

async function steps(forceAll) {
  const out = {}
  out.reconciled = await step('reconcile', () => reconcilePendingPayments())
  out.expired = await step('sweep', () => tx((c) => sweepExpiredHolds(c)))
  if (out.expired) metrics.holdsExpired.inc(out.expired)
  out.refunded = await step('refunds', processDueRefunds)
  out.duplicates = await step('duplicate-payments', refundDuplicatePayments)
  out.notified = await step('notifications', () => sendDueNotifications())
  out.preorders = await step('preorders', runPreorderJobs)
  out.unlock = await step('unlock-evaluate', () => evaluateDueCampaigns())
  out.unlockTemplates = await step('unlock-templates', () => runTemplates())
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
  // The run counts as a tick even if some work was put off: /ready and the
  // Needs attention card show whether the loop itself is alive.
  await markRun('tick')
  return out
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
