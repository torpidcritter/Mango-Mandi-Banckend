// P0 launch blockers, re-verified on 23 Oct (readiness round): the gaps found
// while proving the six P0 items, each with the test that failed before its fix.
import { adminToken, client, closeAll, customerToken, resetDb, signWebhook, startServer, T0, checkout, makeBatch } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { addDays, setNow, todayIST } from '../src/clock.js'
import { query } from '../src/db.js'
import { env } from '../src/env.js'
import { newId } from '../src/ids.js'
import { logger } from '../src/logger.js'
import { runMaintenance, takeLease } from '../src/maintenance.js'
import { otpDelivery } from '../src/sms.js'
import { metaOtpSender } from '../src/whatsapp.js'

let srv
let api
let admin
const cron = { headers: { Authorization: 'Bearer cron_test_secret_0123456789' } }

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
  admin = await adminToken(api)
})

const at = (ms) => setNow(new Date(Date.parse(T0) + ms).toISOString())
const MIN = 60_000
const tick = async () => (await query(`SELECT last_ok_at FROM maintenance_runs WHERE step = 'tick'`)).rows[0]?.last_ok_at ?? null

describe('P0-1: an outside uptime monitor sees a stopped scheduler within 5 minutes', () => {
  test('/ready turns 503 four minutes after the last run, says nothing else, and recovers on the next run', async () => {
    assert.equal((await api.get('/internal/maintenance', cron)).status, 200)
    const ran = (await tick()).getTime()
    setNow(new Date(ran + 240_000))
    let r = await api.get('/ready')
    assert.equal(r.status, 200, 'three missed runs are still fine')
    // A monitor checking every minute sees the next answer: 4 min + 1 s after the last run.
    setNow(new Date(ran + 241_000))
    r = await api.get('/ready')
    assert.equal(r.status, 503)
    // Public endpoint: only whether it is ready and how old the last run is.
    assert.deepEqual(Object.keys(r.body).sort(), ['maintenanceAgeSeconds', 'ready'])
    assert.deepEqual(r.body, { ready: false, maintenanceAgeSeconds: 241 })
    // The pinger comes back: the next run clears it.
    assert.equal((await api.get('/internal/maintenance', cron)).status, 200)
    r = await api.get('/ready')
    assert.equal(r.status, 200)
    assert.equal(r.body.ready, true)
  })

  test('a run that finds the lease taken records no tick; a crashed run’s lease runs out and the next run works', async () => {
    await runMaintenance()
    const first = (await tick()).getTime()
    at(5 * MIN)
    // A run that died at Vercel's limit still holds the lease (65 s).
    assert.ok(await takeLease('maintenance'))
    assert.equal((await runMaintenance()).skipped, true)
    assert.equal((await tick()).getTime(), first, 'a skipped run is not a tick, so /ready still ages')
    at(5 * MIN + 66_000)
    assert.notEqual((await runMaintenance()).skipped, true)
    assert.ok((await tick()).getTime() > first)
  })
})

/** The first Monday after the regular booking horizon. */
function openWeek() {
  let d = addDays(todayIST(), 6)
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1)
  return d
}
const book = (token, week, extra = {}) =>
  api.post(
    '/v1/preorders',
    { sku: 'ALP-3', stage: 'RIPE', qty: 2, weekStart: week, pincode: '560034', address: '12, 4th Cross, Koramangala, Bengaluru', ...extra },
    { token, headers: { 'Idempotency-Key': newId('idem') } },
  )
const preStatus = async (id) => (await query('SELECT status FROM preorders WHERE id = $1', [id])).rows[0].status
const reserved = async (week) => (await query(`SELECT reserved FROM preorder_capacity WHERE sku = 'ALP-3' AND week_start = $1`, [week])).rows[0].reserved

describe('P0-3: Book ahead obeys the unpaid limit (INV-02), on the web and in WhatsApp', () => {
  test('a second unpaid booking is refused with a pointer to the first; cancelling or expiry lifts it', async () => {
    const week = openWeek()
    assert.equal((await api.put(`/admin/v1/preorder-capacity/${week}/ALP-3`, { capacity: 40 }, { token: admin })).status, 200)
    const cust = await customerToken(api)
    const one = await book(cust.accessToken, week)
    assert.equal(one.status, 201, JSON.stringify(one.body))
    const two = await book(cust.accessToken, week)
    assert.equal(two.status, 409, JSON.stringify(two.body))
    assert.equal(two.body.error.code, 'UNPAID_PREORDER_EXISTS')
    assert.equal(two.body.error.preorderId, one.body.id)
    assert.equal(await reserved(week), 2, 'the refused booking took no capacity')

    assert.equal((await api.post(`/v1/preorders/${one.body.id}/cancel`, {}, { token: cust.accessToken })).status < 300, true)
    const three = await book(cust.accessToken, week)
    assert.equal(three.status, 201, JSON.stringify(three.body))
    // A booking whose hold has run out doesn't count.
    at(11 * MIN)
    const four = await book(cust.accessToken, week)
    assert.equal(four.status, 201, JSON.stringify(four.body))
    // Other customers are not affected.
    assert.equal((await book((await customerToken(api)).accessToken, week)).status, 201)
  })

  test('two bookings at once by the same customer: exactly one', async () => {
    const week = openWeek()
    await api.put(`/admin/v1/preorder-capacity/${week}/ALP-3`, { capacity: 40 }, { token: admin })
    const cust = await customerToken(api)
    const rs = await Promise.all([book(cust.accessToken, week), book(cust.accessToken, week)])
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409], JSON.stringify(rs.map((r) => r.body)))
    const n = (await query(`SELECT count(*)::int AS n FROM preorders WHERE customer_id = $1`, [cust.customer.id])).rows[0].n
    assert.equal(n, 1)
  })

  test('WhatsApp Book ahead refuses a second unpaid booking too', async () => {
    const week = openWeek()
    await api.put(`/admin/v1/preorder-capacity/${week}/ALP-3`, { capacity: 40 }, { token: admin })
    const cust = await customerToken(api, '9812300002')
    assert.equal((await book(cust.accessToken, week)).status, 201)
    const { handleInbound } = await import('../src/chat.js')
    let seq = 0
    const say = (input) =>
      handleInbound({ waId: '919812300002', name: 'Asha', messageId: `wamid.pre.${++seq}`, input: typeof input === 'string' ? { text: input } : input }, { send: async () => {} })
    await say('hi')
    await say({ id: 'BOOK' })
    await say({ id: `week:${week}|ALP-3` })
    await say({ id: 'prestage:RIPE' })
    await say({ id: 'qty:2' })
    await say('560034')
    await say('12, 4th Cross, Koramangala, Bengaluru')
    const replies = await say({ id: 'PREPAY' })
    assert.match(replies.map((r) => r.text ?? '').join(' '), /already have an unpaid booking/)
    const n = (await query(`SELECT count(*)::int AS n FROM preorders WHERE customer_id = $1`, [cust.customer.id])).rows[0].n
    assert.equal(n, 1)
  })
})

describe('P0-2: Book ahead frees an expired hold without the maintenance job', () => {
  test('a week filled by an unpaid booking whose hold ran out takes the next booking; a late payment still books', async () => {
    const week = openWeek()
    await api.put(`/admin/v1/preorder-capacity/${week}/ALP-3`, { capacity: 2 }, { token: admin })
    const a = await customerToken(api)
    const held = await book(a.accessToken, week)
    assert.equal(held.status, 201)
    const b = await customerToken(api)
    // Inside the hold, and inside the 2-minute grace for a late Razorpay webhook (PAY-B5): still full.
    at(11 * MIN)
    const early = await book(b.accessToken, week)
    assert.equal(early.status, 409, JSON.stringify(early.body))
    assert.equal(early.body.error.code, 'PREORDER_FULL')
    assert.equal(await preStatus(held.body.id), 'PAYMENT_PENDING')
    // Past the hold and the grace, no maintenance run: B gets the week.
    at(12.5 * MIN)
    const late = await book(b.accessToken, week)
    assert.equal(late.status, 201, JSON.stringify(late.body))
    assert.equal(late.body.status, 'PAYMENT_PENDING')
    assert.equal(await preStatus(held.body.id), 'CANCELLED')
    assert.equal(await reserved(week), 2)
    // A's payment lands late (the link is still open): honoured, as for orders.
    const p = (await query('SELECT * FROM preorders WHERE id = $1', [held.body.id])).rows[0]
    const { raw, signature } = signWebhook({
      event: 'payment_link.paid',
      payload: { payment_link: { entity: { id: p.payment_link_id, status: 'paid' } }, payment: { entity: { id: 'pay_late1', amount: p.total, currency: 'INR', method: 'upi' } } },
    })
    const r = await api.raw('POST', '/webhooks/razorpay', { raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(await preStatus(held.body.id), 'BOOKED')
  })
})

describe('P0-4: each webhook is logged with our request id and Razorpay’s ids', () => {
  test('payment.captured, its duplicate and refund.processed each leave one line naming both sides', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal(c.status, 201, JSON.stringify(c.body))
    const lines = []
    const info = logger.info
    logger.info = function (obj, msg) {
      if (msg === 'razorpay webhook') lines.push(obj)
      return info.apply(this, arguments)
    }
    const send = (body, eventId) => {
      const { raw, signature } = signWebhook(body)
      return api.raw('POST', '/webhooks/razorpay', {
        raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': eventId },
      })
    }
    try {
      const captured = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_EV1', order_id: c.body.razorpayOrderId, amount: c.body.total, currency: 'INR', method: 'upi', status: 'captured' } } } }
      const r1 = await send(captured, 'evt_A1')
      const r2 = await send(captured, 'evt_A1')
      const r3 = await send({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_EV1', payment_id: 'pay_EV1', amount: c.body.total, status: 'processed' } } } }, 'evt_A2')
      assert.deepEqual([r1.status, r2.status, r3.status], [200, 200, 200])
      assert.equal(lines.length, 3)
      assert.deepEqual(
        { ...lines[0] },
        { reqId: r1.headers.get('x-request-id'), razorpayEvent: 'payment.captured', razorpayEventId: 'evt_A1', paymentId: 'pay_EV1', razorpayOrderId: c.body.razorpayOrderId, paymentLinkId: undefined, refundId: undefined, result: 'confirmed' },
      )
      assert.equal(lines[1].reqId, r2.headers.get('x-request-id'))
      assert.equal(lines[1].result, 'duplicate')
      assert.deepEqual([lines[2].reqId, lines[2].razorpayEventId, lines[2].refundId, lines[2].paymentId], [r3.headers.get('x-request-id'), 'evt_A2', 'rfnd_EV1', 'pay_EV1'])
      assert.ok(!JSON.stringify(lines).includes(cust.customer.phone ?? '+91'), 'no personal data')

      // The sandbox kit turns those log lines (as pino writes them, with whatever prefix the log export adds) into evidence rows.
      const { webhookEvidence } = await import('../scripts/razorpay-sandbox.mjs')
      const exported = [
        '2026-10-23 10:00:00 api | not json',
        ...lines.map((o, i) => `2026-10-23 10:00:0${i} api | ${JSON.stringify({ level: 30, time: Date.parse(T0) + i * 1000, ...o, msg: 'razorpay webhook' })}`),
        JSON.stringify({ level: 30, msg: 'request', reqId: 'req_other' }),
      ].join('\n')
      const rows = webhookEvidence(exported)
      assert.deepEqual(rows.map((r) => [r.reqId, r.event, r.eventId, r.paymentId, r.refundId, r.result]), [
        [r1.headers.get('x-request-id'), 'payment.captured', 'evt_A1', 'pay_EV1', null, 'confirmed'],
        [r2.headers.get('x-request-id'), 'payment.captured', 'evt_A1', 'pay_EV1', null, 'duplicate'],
        [r3.headers.get('x-request-id'), 'refund.processed', 'evt_A2', 'pay_EV1', 'rfnd_EV1', lines[2].result],
      ])
      assert.equal(rows[0].orderId, c.body.razorpayOrderId)
    } finally {
      logger.info = info
    }
  })
})

describe('P0-5: login codes, WhatsApp first', () => {
  test('OTP_DEFAULT_CHANNEL=whatsapp sends by WhatsApp only, and SMS only when WhatsApp fails', async () => {
    const calls = []
    const sms = async (phone) => calls.push(`sms:${phone}`)
    const wa = async (phone) => calls.push(`wa:${phone}`)
    const was = env.OTP_DEFAULT_CHANNEL
    env.OTP_DEFAULT_CHANNEL = 'whatsapp'
    try {
      // No channel in the request: the deploy's default decides.
      assert.equal(await otpDelivery({ sms, whatsapp: wa })('+919000000011', '111111'), 'whatsapp')
      assert.deepEqual(calls, ['wa:+919000000011'])
    } finally {
      env.OTP_DEFAULT_CHANNEL = was
    }
  })

  test('a WhatsApp 200 without a message id is not a sent code: it goes by SMS instead', async () => {
    const opts = { token: 't', phoneNumberId: '42', apiVersion: 'v21.0', language: 'en', template: 'mandi_login_code' }
    for (const body of ['{}', '{"messages":[]}', 'not json']) {
      const wa = metaOtpSender(opts, async () => new Response(body, { status: 200 }))
      await assert.rejects(wa('+919000000012', '222222'), /message id/, body)
      const sms = []
      const via = await otpDelivery({ sms: async (p) => sms.push(p), whatsapp: wa })('+919000000012', '222222', 'whatsapp')
      assert.equal(via, 'sms')
      assert.equal(sms.length, 1)
    }
    const ok = metaOtpSender(opts, async () => new Response('{"messages":[{"id":"wamid.X"}]}', { status: 200 }))
    await ok('+919000000012', '222222')
  })
})
