// Payment fixes from the 2026-10-23 audit (PAY-B1 to PAY-B12), one block per
// finding. Razorpay is never called: a fetch stub stands in for it, and it
// enforces the rules the audit found our older stubs ignored (a refund
// receipt is an idempotency key).
import { adminToken, checkout, client, closeAll, customerToken, makeBatch, resetDb, signWebhook, startServer, T0 } from './helpers.js'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, beforeEach, describe, test } from 'node:test'
import { drainBackground } from '../src/background.js'
import { addDays, setNow, todayIST } from '../src/clock.js'
import { query } from '../src/db.js'
import { env } from '../src/env.js'
import { newId } from '../src/ids.js'
import { runMaintenance } from '../src/maintenance.js'
import { DEV_CHECKOUT_SECRET, processDueRefunds, refundDuplicatePayments, refundReceipt, replayCapturedPayments } from '../src/payments.js'
import { checkProduction } from '../src/preflight.js'
import { loadProducts } from '../src/products.js'
import { handleWhatsAppWebhook } from '../src/chat.js'

let srv
let api
let manager

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

const at = (ms) => setNow(new Date(Date.parse(T0) + ms).toISOString())
const MIN = 60_000
const order = async (id) => (await query('SELECT * FROM orders WHERE id = $1', [id])).rows[0]
/** The clock moves on in real time after setNow, so time an order's checks from when it was placed. */
const sincePlaced = async (orderId, ms) => setNow(new Date((await order(orderId)).placed_at.getTime() + ms).toISOString())
const preorder = async (id) => (await query('SELECT * FROM preorders WHERE id = $1', [id])).rows[0]
let eventSeq = 0
const hook = (event, { secret } = {}) => {
  const { raw, signature } = signWebhook(event)
  const sig = secret ? createHmac('sha256', secret).update(raw).digest('hex') : signature
  return api.raw('POST', '/webhooks/razorpay', {
    raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': `evt_t${++eventSeq}` },
  })
}
const refundFailed = (refundId, paymentId) => ({ event: 'refund.failed', payload: { refund: { entity: { id: refundId, payment_id: paymentId, status: 'failed' } } } })

/**
 * Stands in for api.razorpay.com with test keys set. `handler(method, path, body)`
 * returns a JSON body, or [status, body]; null is a 404. Every call is recorded.
 */
function stubRazorpay(handler, { delayMs = 0 } = {}) {
  const realFetch = globalThis.fetch
  const calls = []
  env.RAZORPAY_KEY_ID = 'rzp_test_x'
  env.RAZORPAY_KEY_SECRET = 'key_secret_test'
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (!u.startsWith('https://api.razorpay.com/v1')) return realFetch(url, init)
    const method = init.method ?? 'GET'
    const path = u.slice('https://api.razorpay.com/v1'.length)
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ method, path, body })
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    const out = await handler(method, path, body)
    const [status, json] = Array.isArray(out) ? out : out == null ? [404, { error: { code: 'NOT_FOUND' } }] : [200, out]
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch
      env.RAZORPAY_KEY_ID = ''
      env.RAZORPAY_KEY_SECRET = ''
    },
  }
}

/** Razorpay's refunds for a few payments, refusing a receipt it has seen before ("Duplicate receipt found"). */
function refundDesk() {
  const refunds = []
  const receipts = []
  return {
    refunds,
    receipts,
    handle(method, path, body) {
      let m = /^\/payments\/([^/]+)\/refunds$/.exec(path)
      if (m && method === 'GET') {
        return { items: refunds.filter((r) => r.payment_id === m[1]).map(({ id, status, amount }) => ({ id, status, amount })) }
      }
      m = /^\/payments\/([^/]+)\/refund$/.exec(path)
      if (m && method === 'POST') {
        if (receipts.includes(body.receipt)) {
          return [400, { error: { code: 'BAD_REQUEST_ERROR', description: 'Duplicate receipt found for this refund request' } }]
        }
        receipts.push(body.receipt)
        const r = { id: `rfnd_${refunds.length + 1}`, payment_id: m[1], amount: body.amount ?? 0, status: 'pending' }
        refunds.push(r)
        return { id: r.id, status: 'pending', amount: r.amount }
      }
      return null
    },
  }
}

async function paidOrder(paymentId, qty = 1) {
  const cust = await customerToken(api)
  const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty }])
  assert.equal(c.status, 201, JSON.stringify(c.body))
  assert.equal((await api.post('/v1/dev/pay', { orderId: c.body.orderId, outcome: 'captured' })).body.result, 'confirmed')
  if (paymentId) await query('UPDATE orders SET payment_id = $2 WHERE id = $1', [c.body.orderId, paymentId])
  return { ...c.body, cust }
}

function openWeek() {
  let d = addDays(todayIST(), 6)
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1)
  return d
}
async function bookedPreorder(cust) {
  const week = openWeek()
  assert.equal((await api.put(`/admin/v1/preorder-capacity/${week}/ALP-3`, { capacity: 10 }, { token: manager })).status, 200)
  const b = await api.post(
    '/v1/preorders',
    { sku: 'ALP-3', stage: 'RIPE', qty: 1, weekStart: week, pincode: '560034', address: '12, 4th Cross, Koramangala, Bengaluru' },
    { token: cust.accessToken, headers: { 'Idempotency-Key': newId('idem') } },
  )
  assert.equal(b.status, 201, JSON.stringify(b.body))
  return b.body
}

describe('PAY-B2: a refund sent again carries a new receipt', () => {
  test('receipts are <number>-r<attempt>, at most 40 characters', () => {
    assert.equal(refundReceipt('ORD-1001', 1), 'ORD-1001-r1')
    assert.equal(refundReceipt('ORD-1001', 0), 'ORD-1001-r1')
    const long = refundReceipt(`dup-pay_${'x'.repeat(60)}`, 12)
    assert.equal(long.length, 40)
    assert.ok(long.endsWith('-r12'))
  })

  test('order refund: after refund.failed the next attempt is accepted by a gateway that refuses reused receipts', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const o = await paidOrder('pay_R1')
    const desk = refundDesk()
    const gw = stubRazorpay((m, p, b) => desk.handle(m, p, b))
    try {
      assert.equal((await api.post(`/v1/orders/${o.orderId}/cancel`, {}, { token: o.cust.accessToken })).status, 204)
      assert.equal((await order(o.orderId)).refund_id, 'rfnd_1')
      desk.refunds[0].status = 'failed'
      const r = await hook(refundFailed('rfnd_1', 'pay_R1'))
      assert.equal(r.body.result, 'refund_failed')
      assert.equal((await order(o.orderId)).refund_id, null)
      assert.equal(await processDueRefunds(), 1)
      const row = await order(o.orderId)
      assert.deepEqual([row.refund_id, row.refund_status, row.payment_status], ['rfnd_2', 'pending', 'REFUNDED'])
      assert.deepEqual(desk.receipts, [`${o.number}-r1`, `${o.number}-r2`])
      // The lookup still guards against paying twice: nothing more is sent.
      assert.equal(await processDueRefunds(), 0)
      assert.equal(desk.refunds.length, 2)
      assert.equal(gw.calls.filter((c) => c.method === 'POST').length, 2)
    } finally {
      gw.restore()
    }
  })

  test('preorder refund: the retry after a failure gets a new receipt', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const cust = await customerToken(api)
    const p = await bookedPreorder(cust)
    assert.equal((await api.post('/v1/dev/pay-preorder', { preorderId: p.id, outcome: 'captured' })).body.result, 'booked')
    await query(`UPDATE preorders SET payment_id = 'pay_P1' WHERE id = $1`, [p.id])
    const desk = refundDesk()
    const gw = stubRazorpay((m, path, b) => desk.handle(m, path, b))
    try {
      assert.equal((await api.post(`/v1/preorders/${p.id}/cancel`, {}, { token: cust.accessToken })).status, 204)
      assert.equal((await preorder(p.id)).refund_id, 'rfnd_1')
      desk.refunds[0].status = 'failed'
      assert.equal((await hook(refundFailed('rfnd_1', 'pay_P1'))).body.result, 'refund_failed')
      await processDueRefunds()
      assert.equal((await preorder(p.id)).refund_id, 'rfnd_2')
      assert.deepEqual(desk.receipts, [`${p.number}-r1`, `${p.number}-r2`])
    } finally {
      gw.restore()
    }
  })

  test('duplicate-payment refund: the retry after a failure gets a new receipt', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const o = await paidOrder('pay_A1')
    await query('INSERT INTO duplicate_payments (payment_id, order_id, amount, found_at) VALUES ($1, $2, $3, $4)', ['pay_D1', o.orderId, o.total, new Date(T0)])
    const desk = refundDesk()
    const gw = stubRazorpay((m, p, b) => desk.handle(m, p, b))
    try {
      assert.equal(await refundDuplicatePayments(), 1)
      desk.refunds[0].status = 'failed'
      await hook(refundFailed('rfnd_1', 'pay_D1'))
      assert.equal(await refundDuplicatePayments(), 1)
      const d = (await query(`SELECT * FROM duplicate_payments WHERE payment_id = 'pay_D1'`)).rows[0]
      assert.equal(d.refund_id, 'rfnd_2')
      assert.deepEqual(desk.receipts, ['dup-pay_D1-r1', 'dup-pay_D1-r2'])
    } finally {
      gw.restore()
    }
  })
})

describe('PAY-B5: the lazy hold sweep does not cancel an order Razorpay may have been paid for', () => {
  test('S2: A pays inside the hold, its webhook is late, B checks out: A ends CONFIRMED on its date', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 1 } })
    const a = await customerToken(api)
    const ca = await checkout(api, a.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal(ca.status, 201, JSON.stringify(ca.body))
    // 9.5 minutes in, inside the 10-minute hold, A pays at Razorpay. The webhook is delayed.
    at(9.5 * MIN)
    assert.equal((await api.post('/v1/dev/mark-paid-at-gateway', { orderId: ca.body.orderId, outcome: 'captured' })).status, 200)
    // 10.5 minutes in, B wants the same last box.
    at(10.5 * MIN)
    const b = await customerToken(api)
    const cb = await checkout(api, b.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.notEqual(cb.status, 201, 'B must not get the box A paid for')
    assert.equal(cb.body.error.code, 'STOCK_INSUFFICIENT')
    assert.equal((await order(ca.body.orderId)).status, 'PAYMENT_PENDING')
    // The next maintenance run reconciles A before sweeping.
    at(13 * MIN)
    await runMaintenance({ forceAll: true })
    const o = await order(ca.body.orderId)
    assert.deepEqual([o.status, o.payment_status, o.delivery_date, o.at_risk], ['CONFIRMED', 'SUCCEEDED', ca.body.deliveryDate, false])
    const reasons = (await query('SELECT reason FROM order_events WHERE order_id = $1', [o.id])).rows.map((r) => r.reason)
    assert.ok(!reasons.some((r) => /hold expired/i.test(r ?? '')), JSON.stringify(reasons))
  })

  test('an unpaid order is swept lazily once Razorpay has been asked after its hold, or 2 minutes after it', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 1 } })
    const a = await customerToken(api)
    const ca = await checkout(api, a.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    at(10.5 * MIN)
    const b = await customerToken(api)
    assert.equal((await checkout(api, b.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])).status, 409)
    // A's own payment-status check asks Razorpay: nothing was paid.
    assert.equal((await api.get(`/v1/orders/${ca.body.orderId}/payment-status`, { token: a.accessToken })).body.orderStatus, 'PAYMENT_PENDING')
    const again = await checkout(api, b.accessToken, [], { key: newId('idem') })
    assert.equal(again.status, 201, JSON.stringify(again.body))
    assert.equal((await order(ca.body.orderId)).status, 'CANCELLED')

    // Never reconciled (the scheduler is down): swept 2 minutes after its hold ran out.
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-5': 1 } })
    const c = await customerToken(api)
    const cc = await checkout(api, c.accessToken, [{ sku: 'ALP-5', stage: 'RIPE', qty: 1 }])
    assert.equal(cc.status, 201, JSON.stringify(cc.body))
    const d = await customerToken(api)
    at(10.5 * MIN + 11.5 * MIN)
    assert.equal((await checkout(api, d.accessToken, [{ sku: 'ALP-5', stage: 'RIPE', qty: 1 }])).status, 409)
    at(10.5 * MIN + 13 * MIN)
    const late = await checkout(api, d.accessToken, [], { key: newId('idem') })
    assert.equal(late.status, 201, JSON.stringify(late.body))
    assert.equal((await order(cc.body.orderId)).status, 'CANCELLED')
  })
})

describe('PAY-B1: the webhook answers before any gateway call', () => {
  test('a capture after a cancel is refunded after the 200, not before it', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal((await api.post(`/v1/orders/${c.body.orderId}/cancel`, {}, { token: cust.accessToken })).status, 204)
    const desk = refundDesk()
    const c2 = await checkout(api, (await customerToken(api)).accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    // Each Razorpay call takes 1.5 s; the refund is two calls.
    const gw = stubRazorpay((m, p, b) => desk.handle(m, p, b) ?? (p.endsWith('/capture') ? { id: 'pay_L2', status: 'captured' } : null), { delayMs: 1500 })
    try {
      const t = Date.now()
      const r = await hook({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_L1', order_id: c.body.razorpayOrderId, amount: c.body.total, currency: 'INR', method: 'upi' } } },
      })
      const ms = Date.now() - t
      assert.equal(r.body.result, 'refund_due')
      assert.ok(ms < 1000, `webhook took ${ms} ms`)
      assert.equal((await order(c.body.orderId)).refund_id, null)
      await drainBackground()
      const o = await order(c.body.orderId)
      assert.deepEqual([o.status, o.payment_status, o.refund_id], ['CANCELLED', 'REFUNDED', 'rfnd_1'])

      // payment.authorized: the capture call also happens after the answer.
      const t2 = Date.now()
      const r2 = await hook({
        event: 'payment.authorized',
        payload: { payment: { entity: { id: 'pay_L2', order_id: c2.body.razorpayOrderId, amount: c2.body.total, currency: 'INR' } } },
      })
      assert.ok(Date.now() - t2 < 1000)
      assert.equal(r2.body.result, 'capture_queued')
      await drainBackground()
      assert.ok(gw.calls.some((x) => x.method === 'POST' && x.path === '/payments/pay_L2/capture'))
    } finally {
      gw.restore()
    }
  })

  test('a refund that fails in the background is left for maintenance', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    await api.post(`/v1/orders/${c.body.orderId}/cancel`, {}, { token: cust.accessToken })
    let down = true
    const desk = refundDesk()
    const gw = stubRazorpay((m, p, b) => (down ? [503, { error: { code: 'SERVER_ERROR' } }] : desk.handle(m, p, b)))
    try {
      const r = await hook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_M1', order_id: c.body.razorpayOrderId, amount: c.body.total, currency: 'INR' } } } })
      assert.equal(r.status, 200)
      await drainBackground()
      assert.equal((await order(c.body.orderId)).refunded_at, null)
      down = false
      at(3 * MIN) // past the refund lease
      assert.equal(await processDueRefunds(), 1)
      assert.equal((await order(c.body.orderId)).refund_id, 'rfnd_1')
    } finally {
      gw.restore()
    }
  })
})

const sign = (secret, rzp, pid) => createHmac('sha256', secret).update(`${rzp}|${pid}`).digest('hex')

describe('PAY-B3 / OPS-24: the shop hands Checkout’s reply to the API, which confirms at once', () => {
  test('dev gateway: a signed reply confirms the order; bad or foreign replies are refused', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    const rzp = c.body.razorpayOrderId
    await api.post('/v1/dev/mark-paid-at-gateway', { orderId: c.body.orderId, outcome: 'captured' })
    const url = `/v1/orders/${c.body.orderId}/verify-payment`
    const reply = (over = {}) => ({ razorpay_payment_id: 'pay_cx1', razorpay_order_id: rzp, razorpay_signature: sign(DEV_CHECKOUT_SECRET, rzp, 'pay_cx1'), ...over })

    const bad = await api.post(url, reply({ razorpay_signature: sign('wrong', rzp, 'pay_cx1') }), { token: cust.accessToken })
    assert.deepEqual([bad.status, bad.body.error.code], [400, 'BAD_SIGNATURE'])
    const other = await api.post(url, reply({ razorpay_order_id: 'order_other', razorpay_signature: sign(DEV_CHECKOUT_SECRET, 'order_other', 'pay_cx1') }), { token: cust.accessToken })
    assert.deepEqual([other.status, other.body.error.code], [400, 'PAYMENT_MISMATCH'])
    const stranger = await customerToken(api)
    assert.equal((await api.post(url, reply(), { token: stranger.accessToken })).status, 404)
    assert.equal((await order(c.body.orderId)).status, 'PAYMENT_PENDING')

    const ok = await api.post(url, reply(), { token: cust.accessToken })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.deepEqual(ok.body, { status: 'SUCCEEDED', orderStatus: 'CONFIRMED' })
    // Rate-limited per order.
    let last
    for (let i = 0; i < 6; i++) last = await api.post(url, reply(), { token: cust.accessToken })
    assert.equal(last.status, 429)
  })

  test('with keys: the signature is checked with the key secret, then the payment is fetched and checked like a webhook', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    const cust2 = await customerToken(api)
    const c2 = await checkout(api, cust2.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    const rzp = c.body.razorpayOrderId
    const amounts = { [rzp]: c.body.total, [c2.body.razorpayOrderId]: 100 } // the second was paid short
    const gw = stubRazorpay((m, p) => {
      const hit = /^\/orders\/([^/]+)\/payments$/.exec(p)
      return hit ? { items: [{ id: `pay_${hit[1].slice(-6)}`, status: 'captured', amount: amounts[hit[1]], currency: 'INR' }] } : null
    })
    try {
      const url = `/v1/orders/${c.body.orderId}/verify-payment`
      // Signed with the dev stand-in: refused once real keys are set.
      const dev = await api.post(url, { razorpay_payment_id: 'pay_1', razorpay_order_id: rzp, razorpay_signature: sign(DEV_CHECKOUT_SECRET, rzp, 'pay_1') }, { token: cust.accessToken })
      assert.equal(dev.status, 400)
      const ok = await api.post(url, { razorpay_payment_id: 'pay_1', razorpay_order_id: rzp, razorpay_signature: sign('key_secret_test', rzp, 'pay_1') }, { token: cust.accessToken })
      assert.deepEqual(ok.body, { status: 'SUCCEEDED', orderStatus: 'CONFIRMED' })
      assert.ok(gw.calls.some((x) => x.path === `/orders/${rzp}/payments`))

      // A valid signature doesn't confirm a payment Razorpay says is short.
      const short = await api.post(
        `/v1/orders/${c2.body.orderId}/verify-payment`,
        { razorpay_payment_id: 'pay_2', razorpay_order_id: c2.body.razorpayOrderId, razorpay_signature: sign('key_secret_test', c2.body.razorpayOrderId, 'pay_2') },
        { token: cust2.accessToken },
      )
      assert.deepEqual(short.body, { status: 'INITIATED', orderStatus: 'PAYMENT_PENDING' })
      assert.equal((await query('SELECT count(*)::int AS n FROM duplicate_payments WHERE order_id = $1', [c2.body.orderId])).rows[0].n, 1)
    } finally {
      gw.restore()
    }
  })

  test('payment-status asks Razorpay a minute after checkout, at most every 30 seconds', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    const rzp = c.body.razorpayOrderId
    let paid = false
    const gw = stubRazorpay((m, p) =>
      p === `/orders/${rzp}/payments` ? { items: paid ? [{ id: 'pay_S1', status: 'captured', amount: c.body.total, currency: 'INR' }] : [] } : null,
    )
    const status = async () => (await api.get(`/v1/orders/${c.body.orderId}/payment-status`, { token: cust.accessToken })).body
    const asked = () => gw.calls.filter((x) => x.path === `/orders/${rzp}/payments`).length
    try {
      await sincePlaced(c.body.orderId, 30_000)
      assert.deepEqual(await status(), { status: 'INITIATED', orderStatus: 'PAYMENT_PENDING' })
      assert.equal(asked(), 0) // too soon: the webhook normally comes first
      await sincePlaced(c.body.orderId, 61_000)
      await status()
      assert.equal(asked(), 1)
      await sincePlaced(c.body.orderId, 75_000)
      await status()
      assert.equal(asked(), 1) // throttled
      paid = true
      await sincePlaced(c.body.orderId, 95_000)
      assert.deepEqual(await status(), { status: 'SUCCEEDED', orderStatus: 'CONFIRMED' })
      assert.equal(asked(), 2)
    } finally {
      gw.restore()
    }
  })
})

describe('PAY-B4: a retry starts the payment a crashed first try never stored', () => {
  test('after 15 s the replay creates the Razorpay order instead of 409 until the hold ends', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const cust = await customerToken(api)
    const token = cust.accessToken
    await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 1 }, { token })
    const q = await api.post('/v1/checkout/quote', { pincode: '560034' }, { token })
    const body = { quoteId: q.body.quoteId, address: '12, 4th Cross, Koramangala, Bengaluru' }
    const confirm = () => api.post('/v1/checkout/confirm', body, { token, headers: { 'Idempotency-Key': 'crash-1' } })
    const first = await confirm()
    assert.equal(first.status, 201)
    // The instance died between the commit and storing the Razorpay order.
    await query('UPDATE orders SET razorpay_order_id = NULL WHERE id = $1', [first.body.orderId])
    const soon = await confirm()
    assert.deepEqual([soon.status, soon.body.error?.code], [409, 'PAYMENT_STARTING'])
    await sincePlaced(first.body.orderId, 16_000)
    const retry = await confirm()
    assert.equal(retry.status, 200, JSON.stringify(retry.body))
    assert.equal(retry.body.orderId, first.body.orderId)
    assert.match(retry.body.razorpayOrderId, /^order_dev_/)
    assert.equal(retry.body.status, 'PAYMENT_PENDING')
    const again = await confirm()
    assert.equal(again.body.razorpayOrderId, retry.body.razorpayOrderId)
    assert.equal((await order(first.body.orderId)).razorpay_order_id, retry.body.razorpayOrderId)
  })
})

describe('PAY-B10: a product taken off sale after the quote is not sold on it', () => {
  test('confirm answers 409 PRODUCT_UNAVAILABLE naming the box, and places nothing', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const cust = await customerToken(api)
    const token = cust.accessToken
    await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 1 }, { token })
    const q = await api.post('/v1/checkout/quote', { pincode: '560034' }, { token })
    assert.equal(q.status, 200, JSON.stringify(q.body))
    await query(`UPDATE products SET active = FALSE WHERE sku = 'ALP-3'`)
    await loadProducts()
    try {
      const r = await api.post('/v1/checkout/confirm', { quoteId: q.body.quoteId, address: '12, 4th Cross, Koramangala, Bengaluru' }, { token, headers: { 'Idempotency-Key': 'hidden-1' } })
      assert.equal(r.status, 409)
      assert.equal(r.body.error.code, 'PRODUCT_UNAVAILABLE')
      assert.equal(r.body.error.sku, 'ALP-3')
      assert.match(r.body.error.message, /is no longer sold$/)
      assert.equal((await query('SELECT count(*)::int AS n FROM orders WHERE customer_id = $1', [cust.customer.id])).rows[0].n, 0)
    } finally {
      await query(`UPDATE products SET active = TRUE WHERE sku = 'ALP-3'`)
      await loadProducts()
    }
  })
})

describe('PAY-B11: a payment’s own notes never pick the booking it pays', () => {
  test('payment.captured naming a booking only in its notes is not applied; the link payment is', async () => {
    const cust = await customerToken(api)
    const p = await bookedPreorder(cust)
    const row = await preorder(p.id)
    const forged = await hook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_N1', amount: row.total, currency: 'INR', notes: { preorderId: p.id } } } } })
    assert.equal(forged.body.ignored, true, JSON.stringify(forged.body))
    assert.equal((await preorder(p.id)).status, 'PAYMENT_PENDING')
    const linked = await hook({
      event: 'payment_link.paid',
      payload: { payment_link: { entity: { id: row.payment_link_id, notes: { preorderId: p.id } } }, payment: { entity: { id: 'pay_N2', amount: row.total, currency: 'INR' } } },
    })
    assert.equal(linked.body.result, 'booked')
    // A link we never made, with a payment noting the booking, matches nothing.
    const p2 = await bookedPreorder(await customerToken(api))
    const stray = await hook({
      event: 'payment_link.paid',
      payload: { payment_link: { entity: { id: 'plink_unknown' } }, payment: { entity: { id: 'pay_N3', amount: row.total, currency: 'INR', notes: { preorderId: p2.id } } } },
    })
    assert.equal(stray.body.unknownOrder, true)
    assert.equal((await preorder(p2.id)).status, 'PAYMENT_PENDING')
  })
})

describe('PAY-B12: disputes are recorded; the old webhook secret works during a rotation', () => {
  test('payment.dispute.* shows in Needs attention until it is closed', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const o = await paidOrder('pay_X1')
    const dispute = (event, status) => ({
      event,
      payload: {
        payment: { entity: { id: 'pay_X1' } },
        dispute: { entity: { id: 'disp_1', payment_id: 'pay_X1', amount: o.total, currency: 'INR', reason_code: 'chargeback', respond_by: 1_760_600_000, status } },
      },
    })
    const r = await hook(dispute('payment.dispute.created', 'open'))
    assert.equal(r.body.result, 'dispute_recorded')
    let att = await api.get('/admin/v1/attention', { token: manager })
    assert.equal(att.body.disputes.length, 1)
    assert.deepEqual([att.body.disputes[0].id, att.body.disputes[0].order.id, att.body.disputes[0].status, att.body.disputes[0].amount], ['disp_1', o.orderId, 'open', o.total])
    // Nothing automated: the order is still paid and confirmed.
    assert.deepEqual([(await order(o.orderId)).status, (await order(o.orderId)).payment_status], ['CONFIRMED', 'SUCCEEDED'])
    await hook(dispute('payment.dispute.won', 'won'))
    att = await api.get('/admin/v1/attention', { token: manager })
    assert.equal(att.body.disputes.length, 0)
  })

  test('RAZORPAY_WEBHOOK_SECRET_PREVIOUS is accepted only while set', async () => {
    const event = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_old', order_id: 'order_none', amount: 1 } } } }
    assert.equal((await hook(event, { secret: 'whsec_old' })).status, 400)
    env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS = 'whsec_old'
    try {
      assert.equal((await hook(event, { secret: 'whsec_old' })).status, 200)
      assert.equal((await hook(event, { secret: 'whsec_other' })).status, 400)
    } finally {
      env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS = ''
    }
    const w = checkProduction({ ...env, RAZORPAY_WEBHOOK_SECRET_PREVIOUS: 'whsec_old', NODE_ENV: 'production' }, { vercel: false }).warnings
    assert.ok(w.some((x) => /RAZORPAY_WEBHOOK_SECRET_PREVIOUS is set/.test(x)), JSON.stringify(w))
  })
})

describe('PAY-B9: a restore replay flags refunds made at Razorpay that the database lost', () => {
  test('a paid order refunded at the gateway after the restore point is listed in Needs attention, once', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const o = await paidOrder('pay_G1')
    const known = await paidOrder('pay_G2')
    await query(`UPDATE orders SET payment_status = 'REFUNDED', refund_id = 'rfnd_K2', status = 'CANCELLED' WHERE id = $1`, [known.orderId])
    const gw = stubRazorpay((m, p) => {
      if (p.startsWith('/refunds?')) {
        return { items: [
          { id: 'rfnd_G1', payment_id: 'pay_G1', amount: o.total, status: 'processed' },
          { id: 'rfnd_K2', payment_id: 'pay_G2', amount: known.total, status: 'processed' },
          { id: 'rfnd_F1', payment_id: 'pay_G1', amount: o.total, status: 'failed' },
        ] }
      }
      if (p.startsWith('/payments?')) return { items: [] }
      if (/^\/orders\/[^/]+\/payments$/.test(p)) return { items: [] }
      return null
    })
    try {
      const from = new Date(Date.parse(T0) - 60 * MIN)
      const out = await replayCapturedPayments({ from })
      assert.deepEqual(out.refundedAtGateway.map((r) => r.refundId), ['rfnd_G1'])
      assert.ok(gw.calls.some((c) => c.method === 'GET' && c.path.startsWith(`/refunds?from=${Math.floor(from / 1000)}&to=`)))
      const att = await api.get('/admin/v1/attention', { token: manager })
      const flagged = att.body.webhookFailures.filter((w) => /refunded its payment pay_G1/.test(w.reason))
      assert.equal(flagged.length, 1)
      assert.match(flagged[0].reason, new RegExp(o.number))
      // The order itself is left for staff.
      assert.equal((await order(o.orderId)).payment_status, 'SUCCEEDED')
      assert.equal((await replayCapturedPayments({ from })).refundedAtGateway.length, 0)
    } finally {
      gw.restore()
    }
  })
})

describe('PAY-B7: WhatsApp Pay stays off by default and is never silent', () => {
  test('preflight warns when WHATSAPP_PAYMENT_CONFIG is set', () => {
    const base = { ...env, NODE_ENV: 'production' }
    const has = (e) => checkProduction(e, { vercel: false }).warnings.some((w) => /WHATSAPP_PAYMENT_CONFIG is set/.test(w))
    assert.equal(has(base), false)
    assert.equal(has({ ...base, WHATSAPP_PAYMENT_CONFIG: 'mandi-pay' }), true)
  })

  test('a captured WhatsApp payment whose reference matches no order is recorded', async () => {
    await handleWhatsAppWebhook({
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1', type: 'payment', status: 'captured', payment: { reference_id: 'ORD-99999', amount: { value: 1000, offset: 100 }, currency: 'INR', transaction: { id: 'txn_1' } } }] } }] }],
    })
    const rows = (await query(`SELECT * FROM webhook_failures WHERE source = 'whatsapp'`)).rows
    assert.equal(rows.length, 1)
    assert.match(rows[0].reason, /txn_1.*ORD-99999.*matches no order/)
  })
})
