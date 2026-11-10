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
import { env } from './env.js'
import { randomUUID } from 'node:crypto'
import { outOfTime, withBudget, withSlice } from './budget.js'
import { query, tx } from './db.js'
import { auditLedger } from './inventory.js'
import { withLogContext } from './log-context.js'
import { logger } from './logger.js'
import { expireIdleOperations } from './warehouse/ops.js'
import { boxCheck } from './warehouse/reports.js'
import { metrics } from './metrics.js'
import { allocatePreorders, expirePreorderHolds, promoteWaitlist, reconcilePreorderPayments, retryMissingLinks } from './preorders.js'
import { lockBatchOrders, OPEN_STATUSES, rebalanceOrder, SYSTEM, sweepExpiredHoldsEach, takeBatchOutOfService } from './orders.js'
import { sendDueMessages } from './wa/conversations.js'
import { pruneWhatsApp } from './wa/retention.js'
import { syncTemplates } from './wa/meta-admin.js'
import { chatMessenger } from './whatsapp.js'
import { sendDueNotifications } from './notify.js'
import { prunePushMessages, pushOn, sendDuePush } from './push.js'
import { sendReorderReminders, sendStockAlerts } from './engagement.js'
import { disputeHolds, processDueRefunds, reconcilePendingPayments, reconcileRecentPayments, reconcileRefunds, refundDuplicatePayments } from './payments.js'
import { cronCheckIn, reportError, reportProblem } from './sentry.js'
import { cleanupReviewPhotos, enqueueReviewRequests } from './review-jobs.js'
import { anonymiseOldOrders, monthsBefore, pruneNotifications, removeOldBillBuyers } from './retention.js'
import { auditReviewStats } from './reviews.js'
import { now } from './clock.js'
import { overdueOrders, preorderCapacityDrift } from './stock-watch.js'
import { issueMissingBills, reconcileBills } from './bills.js'
import { settleReferrals } from './referrals.js'
import { sendManagerSummaries } from './manager-summary.js'
import { rollupAndPruneFunnel } from './funnel.js'
import { isOn, refreshSwitches } from './feature-switches.js'
import { queueFollowupAlerts } from './partner/alerts.js'
import { runFarmJobs } from './farm/jobs.js'
import { runSubscriptionJobs } from './subscriptions.js'
import { pruneWebhookEvents, replayWebhookEvents } from './webhook-events.js'
import { counterProblems, stepProblems } from './alert-checks.js'

/** The run's time budget, under Vercel's 60-second limit. */
export const RUN_BUDGET_MS = 45_000
/** How long a run's lease lasts; a run is over well before (budget + one slow call). */
const LEASE_MS = 65_000
const TICK_MS = 60_000
const HOURLY_MS = 3_600_000

let timer = null
/** Steps that failed in the current run (for the Sentry check-in). */
let failedSteps = null
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

/** The most of the run each outside-calling step may use, in ms. */
export const SLICE = { reconcile: 8_000, refunds: 8_000, duplicates: 4_000, alerts: 3_000, notifications: 10_000, push: 5_000, preorders: 8_000 }

/** Steps that need this much time left are put off to the next run. */
const STEP_MIN_MS = 3_000

/**
 * Runs one step, recording success or failure in maintenance_runs for the
 * Needs attention view. With too little time left it is skipped (not an
 * error): the next run does it.
 */
async function step(name, fn, { minMs = STEP_MIN_MS, sliceMs = null } = {}) {
  if (outOfTime(minMs)) {
    logger.warn({ step: name }, 'maintenance step put off to the next run: out of time')
    metrics.maintenanceSkips.inc({ step: name })
    return null
  }
  const started = Date.now()
  try {
    // Every log line the step writes names it (log-context.js).
    const out = await withLogContext({ step: name }, () => (sliceMs ? withSlice(sliceMs, fn) : fn()))
    // A step that stopped early (out of time) isn't marked done, so it runs again next time.
    if (out?.partial) return out
    // How long it took, and the run of failures (fail_count) ends.
    await query(
      `INSERT INTO maintenance_runs (step, last_ok_at, last_duration_ms, fail_count) VALUES ($1, $2, $3, 0)
       ON CONFLICT (step) DO UPDATE SET last_ok_at = $2, last_duration_ms = $3, fail_count = 0`,
      [name, now(), Date.now() - started],
    ).catch(() => {})
    return out
  } catch (err) {
    metrics.maintenanceErrors.inc({ step: name })
    logger.error({ err, step: name }, 'maintenance step failed')
    failedSteps?.add(name)
    // To Sentry too (on Vercel there is no Prometheus), at most hourly per step.
    if (env.OPS_ALERTS) {
      // INT-03 (24 Oct audit): compared with when it was last reported, not last failed,
      // so a step failing every minute is reported every hour, not once.
      const seen = await query('SELECT last_ok_at FROM maintenance_runs WHERE step = $1', [`alert-step-${name}`]).catch(() => ({ rows: [] }))
      const lastReported = seen.rows[0]?.last_ok_at
      if (!lastReported || now().getTime() - lastReported.getTime() >= HOURLY_MS) {
        reportError(err, { maintenanceStep: name })
        await markRun(`alert-step-${name}`).catch(() => {})
      }
    } else {
      const prev = await query('SELECT last_err_at FROM maintenance_runs WHERE step = $1', [name]).catch(() => ({ rows: [] }))
      const lastErr = prev.rows[0]?.last_err_at
      if (!lastErr || now().getTime() - lastErr.getTime() > HOURLY_MS) reportError(err, { maintenanceStep: name })
    }
    // fail_count: failures in a row since the step last succeeded.
    await query(
      `INSERT INTO maintenance_runs (step, last_err_at, last_error, last_duration_ms, fail_count) VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (step) DO UPDATE SET last_err_at = $2, last_error = $3, last_duration_ms = $4, fail_count = maintenance_runs.fail_count + 1`,
      [name, now(), String(err?.message ?? err).slice(0, 500), Date.now() - started],
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
  // Stored webhook bodies: 30 days (WhatsApp 7), bounded per run.
  await pruneWebhookEvents(at)
  await query('DELETE FROM wa_inbound WHERE received_at < $1', [new Date(at.getTime() - 7 * day)])
  await pruneWhatsApp(at)
  // Payment problems stay until a manager resolves them: often the only record of customer money (DB-04).
  // Once resolved, a Razorpay one is still the record of a payment or refund that matched nothing and of
  // what was done about it, so it is kept for BILL_RETENTION_MONTHS like the bills (docs/trust.md).
  // WhatsApp ones go after 30 days.
  await query(`DELETE FROM webhook_failures WHERE created_at < $1 AND source <> 'razorpay'`, [new Date(at.getTime() - 30 * day)])
  await query(`DELETE FROM webhook_failures WHERE source = 'razorpay' AND resolved_at IS NOT NULL AND created_at < $1`, [
    new Date(`${monthsBefore(todayIST(at), env.BILL_RETENTION_MONTHS)}T00:00:00+05:30`),
  ])
  await query('DELETE FROM refresh_sessions WHERE expires_at < $1', [new Date(at.getTime() - day)])
  await query('DELETE FROM rate_limits WHERE reset_at < $1', [new Date(at.getTime() - HOURLY_MS)])
  await query('DELETE FROM job_leases WHERE expires_at < $1', [new Date(at.getTime() - day)])
  // Per-minute alert counters (ops-counters.js): checkHealth reads the last 10 minutes.
  await query('DELETE FROM ops_counters WHERE bucket < $1', [new Date(at.getTime() - 7 * day)])
  // Claim photos uploaded but never sent with a claim.
  const loose = await query('DELETE FROM claim_photos WHERE claim_id IS NULL AND created_at < $1 RETURNING blob_path', [new Date(at.getTime() - day)])
  for (const row of loose.rows) await dropPhoto(row)
  // Review photos uploaded but never sent with a review (bounded per run).
  await cleanupReviewPhotos(at)
  // Finished messages older than 180 days (bounded per run; never PENDING ones).
  await pruneNotifications(at)
  // Browser notifications sent or given up on over 30 days ago (bounded per run).
  await prunePushMessages(at)
}

/** Batches at the retirement age leave the storefront (status EXHAUSTED). */
export async function retireBatches() {
  const cutoff = addDays(todayIST(), -getConfig().retireAge)
  const { rows } = await query(`SELECT id FROM batches WHERE status NOT IN ('EXHAUSTED', 'CONDEMNED') AND plucked_on <= $1`, [cutoff])
  for (const { id } of rows) {
    await tx(async (c) => {
      await lockBatchOrders(c, [id]) // orders before the batch (INV-03)
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

/**
 * The hourly stock audit. Drift pages through Sentry (OPS-25): on Vercel
 * there is no Prometheus to see the ledgerDrift gauge. At most hourly, like
 * the checkHealth alerts.
 */
export async function runAudit(at = now()) {
  const drift = await tx((c) => auditLedger(c))
  metrics.ledgerDrift.set(drift.length)
  if (drift.length) {
    logger.error({ drift: drift.slice(0, 20) }, 'ledger audit: counters disagree with their sources')
    const last = (await lastRuns())['alert-ledger-drift'] ?? 0
    if (at.getTime() - last >= HOURLY_MS) {
      reportProblem('Stock counters disagree with the ledger: stop and investigate before selling more', { lines: drift.length, sample: drift.slice(0, 5) })
      await markRun('alert-ledger-drift')
    }
  }
  // INV-06: preorder capacity counters against the bookings that hold them.
  const weeks = await preorderCapacityDrift({ query })
  if (weeks.length) {
    logger.error({ weeks: weeks.slice(0, 20) }, 'preorder audit: reserved capacity disagrees with the bookings')
    const last = (await lastRuns())['alert-preorder-capacity'] ?? 0
    if (at.getTime() - last >= HOURLY_MS) {
      reportProblem('Preorder capacity counters disagree with the bookings: check the weeks before opening more', { weeks: weeks.length, sample: weeks.slice(0, 5) })
      await markRun('alert-preorder-capacity')
    }
  }
  // Labelled boxes against the counters, per active warehouse (warehouse/reports.js boxCheck, docs/warehouse/STOCK.md).
  const boxes = env.WAREHOUSE_V2 ? await tx((c) => boxCheck(c)) : []
  if (boxes.length) {
    logger.error({ warehouses: boxes }, 'box check: labelled boxes disagree with the stock counters')
    const last = (await lastRuns())['alert-box-check'] ?? 0
    if (at.getTime() - last >= HOURLY_MS) {
      reportProblem('Labelled boxes disagree with the stock counters: open Warehouse reports and reconcile before selling more', { warehouses: boxes })
      await markRun('alert-box-check')
    }
  }
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
/** Runs in progress in this process, so a clean shutdown can wait for them (PLT-14). */
const inFlight = new Set()

export function runMaintenance(opts) {
  const run = runOnce(opts)
  inFlight.add(run)
  const done = () => inFlight.delete(run)
  run.then(done, done)
  return run
}

/**
 * PLT-14 (24 Oct 2026 audit): waits up to `ms` for this process's runs in
 * progress. Resolves true when none is left, false on the deadline (its lease
 * then expires on its own).
 */
export async function settleMaintenance(ms) {
  if (!inFlight.size) return true
  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  const settled = await Promise.race([Promise.allSettled([...inFlight]).then(() => true), deadline])
  clearTimeout(timer)
  return settled
}

async function runOnce({ forceAll = false, budgetMs = RUN_BUDGET_MS } = {}) {
  return await withBudget(budgetMs, async () => {
    await step('config', loadConfig) // every instance keeps its rules fresh
    const holder = await takeLease('maintenance')
    if (!holder) return { skipped: true }
    const checkIn = cronCheckIn('in_progress')
    failedSteps = new Set()
    try {
      const started = Date.now()
      const out = await steps(forceAll)
      out.failed = [...failedSteps]
      // One line per run with its counts: on Vercel there is no /metrics, so this is where they show.
      logger.info({ run: runCounts(out), ms: Date.now() - started }, 'maintenance run')
      // A run where a step failed is an error run, so Sentry's monitor alerts on it.
      cronCheckIn(failedSteps.size ? 'error' : 'ok', checkIn)
      return out
    } catch (err) {
      cronCheckIn('error', checkIn)
      throw err
    } finally {
      failedSteps = null
      await releaseLease('maintenance', holder).catch((err) => logger.warn({ err }, 'could not release the maintenance lease'))
    }
  })
}

/** A run's results cut to counts for its summary log line: lists become their length, nested objects keep their numbers. */
export function runCounts(out) {
  const flat = (v, deep) => {
    if (v == null || typeof v === 'number' || typeof v === 'boolean') return v
    if (Array.isArray(v)) return v.length
    if (!deep || typeof v !== 'object') return undefined
    const o = {}
    for (const [k, x] of Object.entries(v)) {
      const f = flat(x, false)
      if (f !== undefined) o[k] = f
    }
    return o
  }
  const o = {}
  for (const [k, v] of Object.entries(out)) {
    const f = k === 'failed' ? v : flat(v, true)
    if (f !== undefined) o[k] = f
  }
  return o
}

async function steps(forceAll) {
  const out = {}
  // Each step that calls out (Razorpay, WhatsApp) gets a slice of the run, so
  // a slow outside service can't starve the rest. The cheap database steps
  // (sweep, retire, audit) run early, so they always get their turn.
  out.reconciled = await step('reconcile', () => reconcilePendingPayments(), { sliceMs: SLICE.reconcile })
  // Webhooks stored but not processed 5 minutes on (a failure, an instance that died) run again, before the sweep.
  out.webhooksReplayed = await step('webhook-replay', () => replayWebhookEvents(), { sliceMs: SLICE.reconcile })
  out.expired = await step('sweep', () => sweepExpiredHoldsEach())
  if (out.expired) metrics.holdsExpired.inc(out.expired)
  out.retired = await step('retire', retireBatches)
  // Scan sessions left open past the idle limit expire (their staged scans are dropped).
  if (env.WAREHOUSE_V2) out.scanSessionsExpired = await step('warehouse-sessions', () => tx((c) => expireIdleOperations(c)))
  const t = now().getTime()
  const last = await lastRuns()
  if (forceAll || t - (last.audit ?? 0) > HOURLY_MS) {
    out.drift = (await step('audit', () => runAudit()))?.length ?? null
  }
  if (forceAll || t - (last['review-stats'] ?? 0) > HOURLY_MS) {
    out.reviewStatsDrift = (await step('review-stats', () => tx((c) => auditReviewStats(c))))?.length ?? null
  }
  out.refunded = await step('refunds', processDueRefunds, { sliceMs: SLICE.refunds })
  out.duplicates = await step('duplicate-payments', refundDuplicatePayments, { sliceMs: SLICE.duplicates })
  out.refundChecks = await step('refund-checks', () => reconcileRefunds(), { sliceMs: SLICE.duplicates })
  // PAY-08: once a day, every payment Razorpay captured in the last 3 days is matched or listed.
  if (env.PAYMENT_DAILY_RECON && (forceAll || t - (last['payment-recon'] ?? 0) > DAILY_MS)) {
    out.paymentRecon = await step('payment-recon', () => reconcileRecentPayments(), { sliceMs: SLICE.reconcile })
  }
  out.alerts = await step('stock-alerts', () => sendStockAlerts(), { sliceMs: SLICE.alerts })
  out.reminders = await step('reminders', () => sendReorderReminders(), { sliceMs: SLICE.alerts })
  out.reviewRequests = await step('review-requests', () => enqueueReviewRequests())
  // Growth (docs/growth.md): referral thank-yous once a friend's first order is delivered, and the
  // managers' evening summary. Both queue WhatsApp messages, so they run before the send step.
  if (isOn('REFERRALS')) out.referrals = await step('referrals', () => settleReferrals())
  if (isOn('MANAGER_DAILY_SUMMARY')) out.managerSummaries = await step('manager-summary', () => sendManagerSummaries())
  // Subscriptions (docs/care.md): each due delivery is set up once and its "pay for this box" reminder queued, before the messages go out.
  if (isOn('SUBSCRIPTIONS')) out.subscriptions = await step('subscriptions', () => runSubscriptionJobs())
  // Partner Network follow-ups due within the hour or overdue: one team alert each (WHATSAPP_PARTNER_UPDATES, docs/partner-network.md).
  if (isOn('PARTNER_NETWORK') && env.WHATSAPP_PARTNER_UPDATES && env.PARTNER_ALERT_PHONES.length) out.partnerFollowups = await step('partner-followups', () => queueFollowupAlerts())
  // Farm Experience (docs/farm-experience.md): visit reminders are queued before the send step.
  if (isOn('FARM_EXPERIENCE')) out.farm = await step('farm', () => runFarmJobs())
  out.notified = await step('notifications', () => sendDueNotifications(), { sliceMs: SLICE.notifications })
  // Chat and staff replies decided but not sent (an instance died, or a retry is due): docs/whatsapp/RELIABILITY.md.
  out.chatSent = await step('whatsapp-messages', () => sendDueMessages(chatMessenger), { sliceMs: SLICE.notifications })
  // Template status from Meta, once a day when the account id is set (the WhatsApp page can sync at any time).
  if (env.WHATSAPP_PROVIDER === 'meta' && env.WHATSAPP_BUSINESS_ACCOUNT_ID && (forceAll || t - (last['whatsapp-templates'] ?? 0) > DAILY_MS)) {
    out.templates = await step('whatsapp-templates', async () => (await syncTemplates()).automations.length, { sliceMs: SLICE.notifications })
  }
  // Browser notifications for the same order steps (WEB_PUSH, push.js).
  if (env.WEB_PUSH) out.pushed = await step('push', () => sendDuePush(), { sliceMs: SLICE.push })
  out.preorders = await step('preorders', runPreorderJobs, { sliceMs: SLICE.preorders })
  // Bills for preorders that just became orders, and for any payment whose bill failed (BILLS_ENABLED);
  // first, bills caught up with cancels and privacy removals another release made without them.
  // A manager may have switched bills on or off on the panel (PANEL_FEATURE_SWITCHES): read the latest first.
  await refreshSwitches().catch((err) => logger.warn({ err }, 'feature switches not re-read; using the last values read'))
  if (isOn('BILLS_ENABLED')) {
    out.bills = await step('bills', async () => {
      await reconcileBills()
      return issueMissingBills()
    })
  }
  await step('cleanup', () => cleanupExpired())
  // SEC-05: customer details leave orders finished over PII_RETENTION_MONTHS ago (bounded per run).
  // Bills keep theirs for BILL_RETENTION_MONTHS after the bill date (tax law), then lose the buyer's name and address.
  if (forceAll || t - (last.retention ?? 0) > DAILY_MS) {
    out.anonymised = await step('retention', async () => {
      const orders = await anonymiseOldOrders()
      out.billBuyersRemoved = await removeOldBillBuyers()
      return orders
    })
    // FUNNEL_ANALYTICS: finished days rolled up, events past 90 days deleted (runs even with the switch off, so old events still go).
    out.funnel = await step('funnel-retention', () => rollupAndPruneFunnel())
  }
  const lastFull = last['rebalance-all'] ?? 0
  if (forceAll || (last['rebalance-requested'] ?? 0) > lastFull || t - lastFull > DAILY_MS) {
    out.rebalanced = await step('rebalance-all', () => rebalanceAllOpen())
  } else if (t - Math.max(lastFull, last['rebalance-at-risk'] ?? 0) > HOURLY_MS) {
    out.rebalanced = await step('rebalance-at-risk', () => rebalanceAllOpen({ atRiskOnly: true }))
  }
  await step('health', () => checkHealth(out), { minMs: 0 })
  const risk = await query(`SELECT COUNT(*)::int AS n FROM orders WHERE at_risk AND status = ANY($1)`, [OPEN_STATUSES])
  out.atRisk = risk.rows[0].n
  metrics.ordersAtRisk.set(out.atRisk)
  metrics.maintenanceLastRun.set(Date.now() / 1000)
  // The run counts as a tick even if some work was put off: /ready and the
  // Needs attention card show whether the loop itself is alive.
  await markRun('tick')
  return out
}

/**
 * Alerts (to Sentry, at most hourly each) when work is piling up that the run
 * should have done: the loop can be alive and every step "ok" while doing
 * nothing, which is exactly what a tick check can't see. Also flags payments
 * found only by polling, which means Razorpay's webhooks aren't arriving.
 * With OPS_ALERTS it is also the Vercel checker for the ops/alerts.yml rules
 * (alert-checks.js, docs/alerts.md): steps failing in a row, and API errors,
 * slow answers and a busy pool from the shared ops_counters.
 */
export async function checkHealth(out = {}, at = now()) {
  const { rows } = await query(
    `SELECT (SELECT COUNT(*)::int FROM notifications WHERE status = 'PENDING' AND next_attempt_at < $1) AS messages,
            (SELECT COUNT(*)::int FROM orders WHERE refund_requested_at < $2 AND refunded_at IS NULL AND NOT ($5 AND ${disputeHolds('orders.payment_id')}))
          + (SELECT COUNT(*)::int FROM preorders WHERE refund_requested_at < $2 AND refunded_at IS NULL AND NOT ($5 AND ${disputeHolds('preorders.payment_id')}))
          + (SELECT COUNT(*)::int FROM duplicate_payments WHERE found_at < $2 AND refunded_at IS NULL
                AND NOT ($5 AND ${disputeHolds('duplicate_payments.payment_id')})) AS refunds,
            (SELECT COUNT(*)::int FROM webhook_failures WHERE source = 'razorpay' AND created_at > $3 AND resolved_at IS NULL) AS webhooks,
            (SELECT COUNT(*)::int FROM notifications WHERE status = 'FAILED' AND created_at > $4) AS failed,
            (SELECT COUNT(*)::int FROM notifications WHERE status IN ('SENT', 'FAILED') AND created_at > $4) AS done,
            (SELECT COUNT(*)::int FROM push_messages WHERE status = 'PENDING' AND next_attempt_at < $1) AS pushes,
            (SELECT COUNT(*)::int FROM push_messages WHERE status = 'FAILED' AND created_at > $4) AS push_failed,
            (SELECT COUNT(*)::int FROM push_messages WHERE status IN ('SENT', 'FAILED') AND created_at > $4) AS push_done,
            (SELECT COUNT(*)::int FROM wa_conversations WHERE status = 'WAITING' AND waiting_since < $6) AS wa_waiting,
            (SELECT COUNT(*)::int FROM wa_messages WHERE direction = 'OUT' AND status = 'QUEUED' AND next_attempt_at < $1) AS wa_overdue`,
    [
      new Date(at.getTime() - 15 * 60_000), new Date(at.getTime() - 30 * 60_000), new Date(at.getTime() - HOURLY_MS), new Date(at.getTime() - DAILY_MS),
      env.REFUND_SAFETY_CHECKS, new Date(at.getTime() - 4 * HOURLY_MS),
    ],
  )
  const h = rows[0]
  const problems = []
  if (h.messages > 0) problems.push(['messages', 'WhatsApp messages are overdue: the maintenance run is not sending them', { overdue: h.messages }])
  if (h.refunds > 0) problems.push(['refunds', 'Refunds are overdue: check the Razorpay keys and the refunds step', { overdue: h.refunds }])
  if (h.webhooks >= 3) problems.push(['webhooks', 'Razorpay payments could not be matched or were rejected: see Needs attention', { lastHour: h.webhooks }])
  if (out.reconciled > 0) problems.push(['polled', 'Payments were confirmed by polling: Razorpay webhooks may not be arriving', { reconciled: out.reconciled }])
  if ((env.OPS_ALERTS && h.failed >= 3) || (h.done >= 20 && h.failed / h.done > 0.05)) problems.push(['failing', 'WhatsApp messages failing: check the Meta token, template status and number quality', { failed: h.failed, done: h.done }])
  // A customer asked for a person on WhatsApp and nobody has answered for 4 hours.
  if (h.wa_waiting > 0) problems.push(['whatsapp-waiting', 'Customers on WhatsApp are waiting for a person: see the WhatsApp page', { waiting: h.wa_waiting }])
  if (h.wa_overdue > 0) problems.push(['whatsapp-chat-overdue', 'WhatsApp chat replies are overdue: the maintenance run is not sending them', { overdue: h.wa_overdue }])
  // Browser notifications (WEB_PUSH), watched the same way as WhatsApp messages.
  if (pushOn() && h.pushes > 0) problems.push(['push-overdue', 'Browser notifications are overdue: the maintenance run is not sending them', { overdue: h.pushes }])
  if ((env.OPS_ALERTS && h.push_failed >= 3) || (h.push_done >= 20 && h.push_failed / h.push_done > 0.05)) {
    problems.push(['push-failing', 'Browser notifications failing: check the VAPID keys and WEB_PUSH_PROVIDER', { failed: h.push_failed, done: h.push_done }])
  }
  // INV-G: a paid order past its date (or out for delivery too long) is a customer waiting with nobody told.
  const late = await overdueOrders({ query }, at)
  if (late.length) {
    problems.push(['overdue', 'Orders are past their delivery date or stuck out for delivery: see Needs attention', { overdue: late.length, orders: late.slice(0, 10).map((o) => o.number) }])
  }
  const backup = await backupStatus(at)
  if (backup?.stale) {
    problems.push(['backup', 'No backup in the last 26 hours: check the Backup workflow in GitHub Actions, or the Docker backup service (docker compose logs backup)', { lastBackupAt: backup.lastOkAt }])
  }
  if (env.OPS_ALERTS) problems.push(...(await opsProblems(at)), ...(await stepProblems(at)), ...(await counterProblems(at)))
  const last = await lastRuns()
  for (const [key, message, extra] of problems) {
    const name = `alert-${key}`
    if (at.getTime() - (last[name] ?? 0) < HOURLY_MS) continue
    logger.error(extra, message)
    reportProblem(message, extra)
    await markRun(name)
  }
  return problems.map(([key]) => key)
}

/**
 * INT-06, INT-07, INT-08 (24 Oct audit, OPS_ALERTS): messages given up on
 * without a send (older than a day after an outage, or no provider set; their
 * next_attempt_at is when that happened), and WhatsApp webhook failures,
 * which checkHealth's own query counts for Razorpay only.
 */
async function opsProblems(at) {
  const { rows } = await query(
    `SELECT (SELECT COUNT(*)::int FROM notifications WHERE status = 'SKIPPED' AND last_error = 'older than a day' AND next_attempt_at > $1) AS aged,
            (SELECT COUNT(*)::int FROM notifications WHERE status = 'SKIPPED' AND last_error = 'no WhatsApp provider configured' AND next_attempt_at > $1) AS unsent,
            (SELECT COUNT(*)::int FROM webhook_failures WHERE source = 'whatsapp' AND created_at > $1 AND resolved_at IS NULL) AS whatsapp`,
    [new Date(at.getTime() - HOURLY_MS)],
  )
  const h = rows[0]
  const out = []
  if (h.aged > 0) out.push(['messages-aged', 'WhatsApp messages were dropped unsent after waiting a day: see Needs attention and send the ones that still matter', { dropped: h.aged }])
  if (h.unsent > 0) out.push(['no-provider', 'WhatsApp messages are not being sent: no WhatsApp provider is configured (WHATSAPP_PROVIDER)', { skipped: h.unsent }])
  if (h.whatsapp >= 3) out.push(['whatsapp-webhooks', 'WhatsApp webhooks are failing or name unknown orders: see Needs attention', { lastHour: h.whatsapp }])
  return out
}

/** A nightly backup older than this is missed (a day plus slack for a slow run). */
export const BACKUP_STALE_MS = 26 * HOURLY_MS

/**
 * Each backup is recorded as the step 'backup': by the Docker backup service
 * (ops/backup.sh), or on Vercel by the GitHub backup workflow's last step
 * (ops/backup-heartbeat.sh). Checked when the deploy says backups record here
 * (BACKUP_HEARTBEAT_EXPECTED=true, on either path), or once any backup has
 * been recorded; null otherwise, so an install that records none shows no
 * false alarm.
 */
export async function backupStatus(at = now()) {
  const { rows } = await query(`SELECT last_ok_at, last_err_at, last_error FROM maintenance_runs WHERE step = 'backup'`)
  const row = rows[0]
  if (!row && !env.BACKUP_HEARTBEAT_EXPECTED) return null
  const lastOkAt = row?.last_ok_at ?? null
  return { lastOkAt, stale: !lastOkAt || at.getTime() - lastOkAt.getTime() > BACKUP_STALE_MS }
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
