// Launch base: the urgent findings of the 24 Oct 2026 backend audit
// (PAY-01, DB-04 with PAY-04, SEC-03, PLT-01, INT-02). Razorpay is never called:
// the dev gateway stands in.
import { adminToken, client, closeAll, customerToken, resetDb, signWebhook, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { addDays, now, setNow, todayIST } from '../src/clock.js'
import { DEFAULT_RULES, getConfig, loadConfig, rulesSchema, storedRulesSchema } from '../src/config.js'
import { query } from '../src/db.js'
import { newId } from '../src/ids.js'
import { cleanupExpired, runPreorderJobs } from '../src/maintenance.js'
import { devGateway } from '../src/payments.js'
import { reconcilePreorderPayments } from '../src/preorders.js'
import { onProblemForTests } from '../src/sentry.js'
import { OTP_ALERTS, otpDelivery } from '../src/sms.js'

let srv
let api
let manager
let seq = 0
before(async () => {
  srv = await startServer()
  api = client(srv.base)
})
after(async () => {
  await srv.close()
  await closeAll()
})
beforeEach(async () => {
  await resetDb()
  manager = await adminToken(api)
})

const MIN = 60_000
const DAY = 86_400_000
const later = (ms) => setNow(new Date(now().getTime() + ms).toISOString())
const pre = async (id) => (await query('SELECT * FROM preorders WHERE id = $1', [id])).rows[0]
function farWeek(extraWeeks = 2) {
  let d = addDays(todayIST(), 6 + extraWeeks * 7)
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1)
  return d
}
const book = (token, week, extra = {}) =>
  api.post(
    '/v1/preorders',
    { sku: 'ALP-3', stage: 'RIPE', qty: 2, weekStart: week, pincode: '560034', address: '12, 4th Cross, Koramangala, Bengaluru', ...extra },
    { token, headers: { 'Idempotency-Key': newId('idem') } },
  )
const hook = (event) => {
  const { raw, signature } = signWebhook(event)
  return api.raw('POST', '/webhooks/razorpay', {
    raw,
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': `evt_lb_${++seq}` },
  })
}

describe('PAY-01: a waitlist spot paid with the webhook lost', () => {
  test('a booking promoted days after it was made is still found by the payment check', async () => {
    const week = farWeek()
    assert.equal((await api.put(`/admin/v1/preorder-capacity/${week}/ALP-3`, { capacity: 2 }, { token: manager })).status, 200)
    const a = await customerToken(api)
    const held = (await book(a.accessToken, week)).body
    const b = await customerToken(api)
    const waiting = (await book(b.accessToken, week, { waitlist: true })).body
    assert.equal(waiting.status, 'WAITLISTED')
    later(4 * DAY)
    assert.equal((await api.post(`/v1/preorders/${held.id}/cancel`, {}, { token: a.accessToken })).status, 204)
    assert.equal((await runPreorderJobs()).promoted, 1)
    const promoted = await pre(waiting.id)
    assert.equal(promoted.status, 'PAYMENT_PENDING')
    assert.ok(promoted.payment_started_at, 'promotion opens a new payment window')
    // B pays the link at once; the payment_link.paid webhook is lost.
    devGateway.set(promoted.payment_link_id, { id: 'pay_wait', status: 'captured', amount: promoted.total, method: 'upi' })
    later(20 * MIN)
    assert.equal(await reconcilePreorderPayments(), 1)
    const end = await pre(waiting.id)
    assert.deepEqual([end.status, end.payment_status, end.payment_id], ['BOOKED', 'SUCCEEDED', 'pay_wait'])
  })
})

describe('DB-04 and PAY-04: payment problems stay until a manager resolves them', () => {
  const orphan = () =>
    hook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_orphan', order_id: 'order_unknown1', amount: 59900, currency: 'INR' } } } })
  const listed = async () => (await api.get('/admin/v1/attention', { token: manager })).body.webhookFailures.filter((w) => /pay_orphan/.test(w.reason)).length

  test('an unmatched captured payment is still listed and kept after 31 days', async () => {
    assert.equal((await orphan()).body.unknownOrder, true)
    assert.equal(await listed(), 1)
    later(31 * DAY)
    await cleanupExpired()
    assert.equal(await listed(), 1)
    assert.equal((await query(`SELECT count(*)::int AS n FROM webhook_failures WHERE payment_id = 'pay_orphan'`)).rows[0].n, 1)
  })

  test('once resolved it is cleaned up after 30 days; old WhatsApp failures are too', async () => {
    await orphan()
    await query(`UPDATE webhook_failures SET resolved_at = $1, resolved_by = 'test' WHERE payment_id = 'pay_orphan'`, [now()])
    await query(`INSERT INTO webhook_failures (id, source, reason, created_at) VALUES ('whf_wa', 'whatsapp', 'bad payload', $1)`, [now()])
    later(31 * DAY)
    await cleanupExpired()
    assert.equal((await query(`SELECT count(*)::int AS n FROM webhook_failures`)).rows[0].n, 0)
  })

  test('a duplicate-payment refund Razorpay never confirmed shows as unconfirmed', async () => {
    const sent = new Date(now().getTime() - 6 * DAY)
    await query(
      `INSERT INTO duplicate_payments (payment_id, amount, found_at, refund_id, refunded_at, refund_status) VALUES ('pay_dup1', 59900, $1, 'rfnd_dup1', $1, 'pending')`,
      [sent],
    )
    const att = (await api.get('/admin/v1/attention', { token: manager })).body
    const rows = JSON.stringify(att)
    assert.match(rows, /pay_dup1 \(refund sent, not confirmed by Razorpay\)/)
  })
})

describe('SEC-03: compressed request bodies are refused', () => {
  test('gzip on a JSON route and on a webhook gets 415 and the API stays up', async () => {
    const gz = gzipSync(Buffer.from(JSON.stringify({ phone: '9876543210' })))
    const a = await api.raw('POST', '/v1/auth/otp/request', { raw: gz, headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } })
    assert.equal(a.status, 415)
    assert.equal(a.body.error.code, 'UNSUPPORTED_ENCODING')
    const w = await api.raw('POST', '/webhooks/razorpay', { raw: gz, headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'deflate' } })
    assert.equal(w.status, 415)
    assert.equal((await api.get('/health')).status, 200)
    // A plain body still works.
    assert.equal((await api.raw('POST', '/v1/auth/otp/request', { raw: '{}', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'identity' } })).status === 415, false)
  })
})

describe('PLT-01: rules saved by a newer release still load', () => {
  test('an unknown rule key is dropped on read but refused on save', async () => {
    const newer = { ...getConfig(), someFutureRule: 5 }
    assert.equal(rulesSchema.safeParse(newer).success, false)
    assert.equal(storedRulesSchema.safeParse(newer).success, true)
    await query(`INSERT INTO app_config (version, value, changed_by) SELECT MAX(version) + 1, $1, 'newer' FROM app_config`, [newer])
    const live = await loadConfig()
    assert.equal('someFutureRule' in live.rules, false)
    assert.equal(live.rules.holdMinutes, DEFAULT_RULES.holdMinutes)
    assert.equal((await api.get('/v1/products')).status, 200)
    const save = await api.put('/admin/v1/config', { rules: newer }, { token: manager })
    assert.equal(save.status, 400)
  })

  test('the rollback copy without the new keys loads with their defaults', async () => {
    const { maxUnpaidOrders, maxHeldBoxes, outForDeliveryAlertHours, maxPreorderMoves, seasonEndsOn, ...older } = { ...getConfig(), maxUnpaidOrders: 3 }
    void [maxUnpaidOrders, maxHeldBoxes, outForDeliveryAlertHours, maxPreorderMoves, seasonEndsOn]
    await query(`INSERT INTO app_config (version, value, changed_by) SELECT MAX(version) + 1, $1, 'rollback' FROM app_config`, [older])
    const live = await loadConfig()
    assert.equal(live.rules.maxUnpaidOrders, DEFAULT_RULES.maxUnpaidOrders)
    assert.equal(live.rules.seasonEndsOn, null)
  })
})

describe('INT-02: login-code trouble reaches a person', () => {
  let problems
  beforeEach(() => {
    problems = []
    onProblemForTests((message, context) => problems.push({ message, context }))
  })
  afterEach(() => onProblemForTests(null))
  const down = () => Promise.reject(new Error('gateway down'))
  const ok = () => Promise.resolve()

  test('repeated failed sends raise one warning per window', async () => {
    const send = otpDelivery({ sms: down, whatsapp: down })
    for (let i = 0; i < OTP_ALERTS.failed.threshold + 2; i++) await assert.rejects(send(`900000001${i}`, '123456'), { code: 'OTP_NOT_SENT' })
    assert.equal(problems.length, 1)
    assert.match(problems[0].message, /Login codes are not being sent/)
    later(OTP_ALERTS.failed.windowMs + MIN)
    for (let i = 0; i < OTP_ALERTS.failed.threshold; i++) await assert.rejects(send(`900000002${i}`, '123456'), { code: 'OTP_NOT_SENT' })
    assert.equal(problems.length, 2)
  })

  test('codes going out on the backup channel raise a warning naming the failing one', async () => {
    const send = otpDelivery({ sms: down, whatsapp: ok })
    for (let i = 0; i < OTP_ALERTS.fallback.threshold; i++) assert.equal(await send(`900000003${i}`, '123456'), 'whatsapp')
    assert.equal(problems.length, 1)
    assert.match(problems[0].message, /backup channel/)
    assert.equal(problems[0].context.failingChannel, 'sms')
  })

  test('a code sent on the first channel raises nothing', async () => {
    const send = otpDelivery({ sms: ok, whatsapp: ok })
    for (let i = 0; i < 10; i++) await send(`900000004${i}`, '123456')
    assert.equal(problems.length, 0)
  })
})
