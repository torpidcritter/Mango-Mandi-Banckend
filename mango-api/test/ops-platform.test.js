// Platform fixes from the 23 Oct audit (area "ops"): ledger drift pages
// through Sentry (OPS-25), preflight checks the role's time limits (OPS-29),
// notifications drain in batches within the run's budget (OPS-30), the
// per-address login-code limit fits a carrier NAT (OTP), and the Vercel error
// flush is kept alive with waitUntil (OPS-28).
import { checkout, client, closeAll, customerToken, makeBatch, resetDb, startServer, T0 } from './helpers.js'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { withBudget } from '../src/budget.js'
import { now, setNow } from '../src/clock.js'
import { query } from '../src/db.js'
import { newId } from '../src/ids.js'
import { runAudit, runMaintenance } from '../src/maintenance.js'
import { sendDueNotifications } from '../src/notify.js'
import { checkRoleTimeouts } from '../src/preflight.js'
import { otpIpLimit } from '../src/ratelimit.js'
import { onProblemForTests } from '../src/sentry.js'

let srv
let api
let problems
before(async () => {
  srv = await startServer()
  api = client(srv.base)
})
after(async () => {
  onProblemForTests(null)
  await srv.close()
  await closeAll()
})
beforeEach(async () => {
  await resetDb()
  problems = []
  onProblemForTests((message, context) => problems.push({ message, context }))
})
afterEach(() => onProblemForTests(null))

const hourLater = (h) => new Date(new Date(T0).getTime() + h * 3_600_000).toISOString()

describe('ledger drift pages through Sentry (OPS-25)', () => {
  test('runAudit with drift reports a problem, at most once an hour', async () => {
    const batch = await makeBatch({ age: 3, lines: { 'ALP-3': 10 } })
    assert.deepEqual(await runAudit(), [])
    assert.equal(problems.length, 0, 'balanced books report nothing')

    await query(`UPDATE batch_lines SET on_hand = on_hand + 2 WHERE batch_id = $1`, [batch])
    assert.equal((await runAudit()).length, 1)
    assert.equal(problems.length, 1)
    assert.match(problems[0].message, /Stock counters disagree with the ledger/)
    assert.equal(problems[0].context.lines, 1)

    // Still drifting a few minutes later: no second page within the hour.
    setNow(hourLater(0.5))
    await runAudit()
    assert.equal(problems.length, 1)
    setNow(hourLater(1.1))
    await runAudit()
    assert.equal(problems.length, 2)
  })

  test('the maintenance run reports it too', async () => {
    const batch = await makeBatch({ age: 3, lines: { 'ALP-3': 10 } })
    await query(`UPDATE batch_lines SET on_hand = on_hand - 1 WHERE batch_id = $1`, [batch])
    const out = await runMaintenance({ forceAll: true })
    assert.equal(out.drift, 1)
    assert.ok(problems.some((p) => /disagree with the ledger/.test(p.message)), JSON.stringify(problems))
  })
})

describe('preflight --online checks the role time limits (OPS-29)', () => {
  const fake = (values) => async (sql) => {
    const name = sql.replace(/^SHOW\s+/i, '').trim()
    return { rows: [{ [name]: values[name] }] }
  }

  test('through the pooler, a missing limit is an error', async () => {
    const r = await checkRoleTimeouts(fake({ statement_timeout: '0', idle_in_transaction_session_timeout: '30s' }), { pooled: true })
    assert.equal(r.errors.length, 1)
    assert.match(r.errors[0], /statement_timeout is not set.*ALTER ROLE <app role> SET statement_timeout = '10s'/)
    assert.deepEqual(r.ok, ['idle_in_transaction_session_timeout is 30s'])
    const both = await checkRoleTimeouts(fake({ statement_timeout: '0ms', idle_in_transaction_session_timeout: undefined }), { pooled: true })
    assert.equal(both.errors.length, 2)
  })

  test('both set passes; a direct connection only warns', async () => {
    assert.deepEqual(await checkRoleTimeouts(fake({ statement_timeout: '10s', idle_in_transaction_session_timeout: '30s' }), { pooled: true }), {
      errors: [],
      warnings: [],
      ok: ['statement_timeout is 10s', 'idle_in_transaction_session_timeout is 30s'],
    })
    const direct = await checkRoleTimeouts(fake({ statement_timeout: '0', idle_in_transaction_session_timeout: '0' }), { pooled: false })
    assert.equal(direct.errors.length, 0)
    assert.equal(direct.warnings.length, 2)
  })

  test('it reads the settings from the real database', async () => {
    const r = await checkRoleTimeouts(query, { pooled: true })
    assert.equal(r.errors.length + r.ok.length, 2)
  })

  test('the CLI runs it with --online', async () => {
    const cli = await readFile(new URL('../src/preflight-cli.js', import.meta.url), 'utf8')
    assert.match(cli, /if \(online\) \{\s*\n\s*\/\/ OPS-29[^\n]*\n\s*try \{\s*\n\s*const t = await checkRoleTimeouts\(query, \{ pooled: isPooledUrl\(env\.DATABASE_URL\) \}\)/)
  })
})

describe('notifications drain in batches (OPS-30)', () => {
  /** One paid order, and `n` due messages about it in all. */
  async function dueMessages(n) {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const o = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal(o.status, 201, JSON.stringify(o.body))
    await api.post('/v1/dev/pay', { orderId: o.body.orderId, outcome: 'captured' })
    const { rows } = await query(`SELECT COUNT(*)::int AS n, MIN(phone) AS phone FROM notifications WHERE status = 'PENDING'`)
    for (let i = rows[0].n; i < n; i++) {
      await query(
        `INSERT INTO notifications (id, order_id, event_id, kind, phone, next_attempt_at, created_at) VALUES ($1, $2, $3, 'ORDER_CONFIRMED', $4, $5, $5)`,
        [newId('ntf'), o.body.orderId, newId('evt'), rows[0].phone, new Date(T0)],
      )
    }
  }
  const pending = async () => (await query(`SELECT COUNT(*)::int AS n FROM notifications WHERE status = 'PENDING'`)).rows[0].n

  test('a burst bigger than one batch goes out in one run', async () => {
    await dueMessages(130)
    let calls = 0
    const sent = await withBudget(45_000, () => sendDueNotifications({ sender: async () => (calls++, 'wamid.x') }))
    assert.equal(sent, 130)
    assert.equal(calls, 130)
    assert.equal(await pending(), 0)
  })

  test('a message that fails is not retried within the same run', async () => {
    await dueMessages(60)
    let calls = 0
    const sent = await sendDueNotifications({ sender: async () => { calls++; throw new Error('Meta is down') } })
    assert.equal(sent, 0)
    assert.equal(calls, 60, 'each message tried once')
    assert.equal(await pending(), 60, 'all wait for their retry')
  })

  test('with too little time left nothing is claimed for long', async () => {
    await dueMessages(60)
    let calls = 0
    // Less than one WhatsApp call's worth of time: the batch is handed straight back.
    const sent = await withBudget(5_000, () => sendDueNotifications({ sender: async () => (calls++, 'wamid.x') }))
    assert.equal(sent, 0)
    assert.equal(calls, 0)
    const due = await query(`SELECT COUNT(*)::int AS n FROM notifications WHERE status = 'PENDING' AND next_attempt_at <= $1`, [now()])
    assert.equal(due.rows[0].n, 60, 'the next run sends them straight away')
  })
})

describe('login codes per address (carrier NAT)', () => {
  test('production allows 200 per 15 minutes, configurable', () => {
    assert.equal(otpIpLimit({ NODE_ENV: 'production' }), 200)
    assert.equal(otpIpLimit({ NODE_ENV: 'development' }), 300)
    assert.equal(otpIpLimit({ NODE_ENV: 'production', OTP_IP_LIMIT: 500 }), 500)
  })

  test('the login-code route uses it', async () => {
    const src = await readFile(new URL('../src/customer.js', import.meta.url), 'utf8')
    assert.match(src, /sharedLimiter\('otp-ip', \{ windowMs: OTP_IP_WINDOW_MS, limit: otpIpLimit\(\) \}\)/)
  })
})

describe('the Vercel error flush (OPS-28)', () => {
  test('goes through background(), which hands it to waitUntil', async () => {
    const src = await readFile(new URL('../src/app.js', import.meta.url), 'utf8')
    assert.doesNotMatch(src, /res\.on\('finish', \(\) => void flushErrors\(\)\)/)
    assert.equal(src.match(/if \(onVercel\) background\(flushErrors\(\)\)/g)?.length, 2)
  })
})
