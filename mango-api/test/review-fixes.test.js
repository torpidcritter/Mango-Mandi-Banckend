// The fixes from the two architecture reviews: the maintenance time budget
// and lease, races (last box, webhook storm, cancel vs pack, double refund),
// payments (failed attempts, double charges), shared rate limits, cross-site
// session requests, rider scoping, delivery retries, account deletion, and
// the database environment guard.
import sharp from 'sharp'
import { adminToken, checkout, client, closeAll, customerToken, line, makeBatch, resetDb, signWebhook, startServer, T0 } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { drainBackground } from '../src/background.js'
import { withBudget } from '../src/budget.js'
import { setNow } from '../src/clock.js'
import { pool, query, tx } from '../src/db.js'
import { earliestRawDate } from '../src/delivery.js'
import { env } from '../src/env.js'
import { auditLedger } from '../src/inventory.js'
import { rebalanceAllOpen, runMaintenance, takeLease } from '../src/maintenance.js'
import { checkDatabaseEnvironment } from '../src/migrate.js'
import { linkExpiresAt, processDueRefunds, refundOrder } from '../src/payments.js'
import { PgStore } from '../src/ratelimit.js'

let srv
let api
let admin
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

const pay = (orderId) => api.post('/v1/dev/pay', { orderId, outcome: 'captured' })
const hook = (event) => {
  const { raw, signature } = signWebhook(event)
  return api.raw('POST', '/webhooks/razorpay', { raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature } })
}
const captured = (id, order) => ({ event: 'payment.captured', payload: { payment: { entity: { id, order_id: order.razorpayOrderId, amount: order.total, method: 'upi' } } } })
const order = async (id) => (await query('SELECT * FROM orders WHERE id = $1', [id])).rows[0]

async function paidOrder(cust, sku = 'ALP-3') {
  const c = await checkout(api, cust.accessToken, [{ sku, stage: 'RIPE', qty: 1 }])
  assert.equal(c.status, 201, JSON.stringify(c.body))
  await pay(c.body.orderId)
  return c.body
}

async function packedOrder(cust) {
  const o = await paidOrder(cust)
  await api.patch(`/admin/v1/orders/${o.orderId}/status`, { status: 'PROCESSING' }, { token: admin })
  assert.equal((await api.post(`/admin/v1/orders/${o.orderId}/allocate`, undefined, { token: admin })).status, 204)
  assert.equal((await api.patch(`/admin/v1/orders/${o.orderId}/status`, { status: 'PACKED' }, { token: admin })).status, 204)
  return o
}

describe('maintenance within the time limit', () => {
  test('with too little time left, steps are put off (not failed, not marked done); the run still counts', async () => {
    const out = await runMaintenance({ budgetMs: 1_000 })
    assert.notEqual(out.skipped, true)
    assert.equal(out.reconciled, null)
    assert.equal(out.expired, null)
    const { rows } = await query(`SELECT step FROM maintenance_runs WHERE last_ok_at IS NOT NULL OR last_err_at IS NOT NULL ORDER BY step`)
    assert.deepEqual(rows.map((r) => r.step), ['health', 'tick'])
    const full = await runMaintenance()
    assert.equal(full.reconciled, 0)
  })

  test('one lease at a time; a lease left by a run that died expires', async () => {
    const at = new Date(T0)
    assert.ok(await takeLease('job', 65_000, at))
    assert.equal(await takeLease('job', 65_000, at), null)
    assert.equal(await takeLease('job', 65_000, new Date(at.getTime() + 30_000)), null)
    assert.ok(await takeLease('job', 65_000, new Date(at.getTime() + 66_000)))
  })

  test('the full order re-check stops when time runs out and carries on next run', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    for (let i = 0; i < 3; i++) await paidOrder(await customerToken(api))
    const part = await withBudget(1_000, () => rebalanceAllOpen())
    assert.equal(part.partial, true)
    assert.ok((await query(`SELECT cursor FROM maintenance_runs WHERE step = 'rebalance-all'`)).rows[0].cursor)
    assert.equal(typeof (await rebalanceAllOpen()), 'number')
    assert.equal((await query(`SELECT cursor FROM maintenance_runs WHERE step = 'rebalance-all'`)).rows[0].cursor, null)
  })
})

describe('races', () => {
  test('50 buyers for the last box in the last slot place: one order, nothing oversold', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 1 } })
    const slot = await api.post('/admin/v1/slots', { label: 'Morning', startsAt: '07:00', endsAt: '11:00', maxBoxes: 1 }, { token: admin })
    assert.equal(slot.status, 201, JSON.stringify(slot.body))
    const buyers = []
    for (let i = 0; i < 50; i++) buyers.push((await customerToken(api)).accessToken)
    const quotes = []
    for (const token of buyers) {
      await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 1 }, { token })
      quotes.push((await api.post('/v1/checkout/quote', { pincode: '560034', slotId: slot.body.id }, { token })).body.quoteId)
    }
    const results = await Promise.all(
      buyers.map((token, i) =>
        api.post('/v1/checkout/confirm', { quoteId: quotes[i], address: '12, 4th Cross, Koramangala' }, { token, headers: { 'Idempotency-Key': `last-${i}` } }),
      ),
    )
    const won = results.filter((r) => r.status === 201)
    assert.equal(won.length, 1, JSON.stringify(results.filter((r) => r.status !== 201 && r.status !== 409).map((r) => r.body)))
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409 && ['STOCK_INSUFFICIENT', 'SLOT_FULL'].includes(r.body.error.code)))
    assert.equal((await line(b, 'ALP-3')).held, 1)
    assert.deepEqual(await tx((c) => auditLedger(c)), [])
  })

  test('a webhook storm plus payment catch-up confirms the order once', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const c = await checkout(api, (await customerToken(api)).accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    await api.post('/v1/dev/mark-paid-at-gateway', { orderId: c.body.orderId, outcome: 'captured' })
    const event = captured('pay_storm', c.body)
    const results = await Promise.all([
      ...Array.from({ length: 20 }, () => hook(event)),
      ...Array.from({ length: 3 }, () => api.post('/v1/dev/reconcile', {})),
    ])
    assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.filter((r) => r.status !== 200).map((r) => r.body)))
    const o = await order(c.body.orderId)
    assert.equal(o.status, 'CONFIRMED')
    const confirms = await query(`SELECT COUNT(*)::int AS n FROM order_events WHERE order_id = $1 AND status = 'CONFIRMED' AND from_status = 'PAYMENT_PENDING'`, [o.id])
    assert.equal(confirms.rows[0].n, 1)
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM duplicate_payments')).rows[0].n <= 1, true)
    assert.deepEqual(await tx((c2) => auditLedger(c2)), [])
  })

  test('customer cancel and staff packing at the same moment leave the books balanced', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const cust = await customerToken(api)
    const o = await paidOrder(cust)
    await api.patch(`/admin/v1/orders/${o.orderId}/status`, { status: 'PROCESSING' }, { token: admin })
    const [cancel, pack] = await Promise.all([
      api.post(`/v1/orders/${o.orderId}/cancel`, undefined, { token: cust.accessToken }),
      api.post(`/admin/v1/orders/${o.orderId}/allocate`, undefined, { token: admin }),
    ])
    assert.equal(cancel.status, 204)
    assert.ok([204, 400, 409].includes(pack.status))
    const after = await order(o.orderId)
    assert.equal(after.status, 'CANCELLED')
    assert.ok(after.refund_requested_at)
    const l = await line(b, 'ALP-3')
    assert.deepEqual([l.on_hand, l.committed, l.held], [5, 0, 0])
    assert.deepEqual(await tx((c) => auditLedger(c)), [])
  })

  test('the cancel request and three maintenance runs send one refund', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const cust = await customerToken(api)
    const o = await paidOrder(cust)
    await query('UPDATE orders SET refund_requested_at = $2 WHERE id = $1', [o.orderId, new Date()])
    await Promise.all([refundOrder(o.orderId), processDueRefunds(), processDueRefunds(), processDueRefunds()])
    const ev = await query(`SELECT COUNT(*)::int AS n FROM order_events WHERE order_id = $1 AND reason LIKE 'Refunded in full%'`, [o.orderId])
    assert.equal(ev.rows[0].n, 1)
    assert.ok((await order(o.orderId)).refund_id)
  })

  test('two transactions that deadlock both finish: one is retried', async () => {
    const b1 = await makeBatch({ age: 5, lines: { 'ALP-3': 1 } })
    const b2 = await makeBatch({ age: 5, lines: { 'ALP-3': 1 } })
    const [l1, l2] = [(await line(b1, 'ALP-3')).id, (await line(b2, 'ALP-3')).id]
    let release
    const both = new Promise((r) => (release = r))
    let arrived = 0
    const meet = () => {
      if (++arrived === 2) release()
      return Promise.race([both, new Promise((r) => setTimeout(r, 2_000))])
    }
    const touch = (c, id) => c.query('UPDATE batch_lines SET reserve_buffer = reserve_buffer WHERE id = $1', [id])
    let runs = 0
    const work = (first, second) =>
      tx(async (c) => {
        runs++
        await touch(c, first)
        await meet()
        await touch(c, second)
        return true
      })
    assert.deepEqual(await Promise.all([work(l1, l2), work(l2, l1)]), [true, true])
    assert.equal(runs, 3)
  })
})

describe('payments', () => {
  test('a failed attempt keeps the hold, so the customer can try again and pay', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const c = await checkout(api, (await customerToken(api)).accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    const failed = { event: 'payment.failed', payload: { payment: { entity: { id: 'pay_fail', order_id: c.body.razorpayOrderId, amount: c.body.total } } } }
    assert.equal((await hook(failed)).body.result, 'attempt_failed')
    assert.equal((await order(c.body.orderId)).status, 'PAYMENT_PENDING')
    assert.equal((await line(b, 'ALP-3')).held, 1)
    assert.equal((await hook(captured('pay_ok', c.body))).body.result, 'confirmed')
    assert.equal((await order(c.body.orderId)).status, 'CONFIRMED')
  })

  test('a second payment for a paid order is refunded; the order is untouched', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const c = await checkout(api, (await customerToken(api)).accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal((await hook(captured('pay_a', c.body))).body.result, 'confirmed')
    assert.equal((await hook(captured('pay_b', c.body))).body.result, 'duplicate_payment')
    await drainBackground() // the refund goes out after the webhook has been answered (PAY-B1)
    const dup = (await query('SELECT * FROM duplicate_payments')).rows
    assert.equal(dup.length, 1)
    assert.equal(dup[0].payment_id, 'pay_b')
    assert.match(dup[0].refund_id, /^rfnd_dev_/)
    const o = await order(c.body.orderId)
    assert.deepEqual([o.status, o.payment_status, o.payment_id], ['CONFIRMED', 'SUCCEEDED', 'pay_a'])
  })

  test('payment links close 16 minutes after they are made', () => {
    const at = new Date(T0)
    assert.equal(linkExpiresAt(at) - Math.floor(at.getTime() / 1000), 16 * 60)
  })
})

describe('sign-in protection', () => {
  test('rate limits counted in Postgres are shared between instances', async () => {
    const a = new PgStore('t')
    const b = new PgStore('t')
    a.init({ windowMs: 60_000 })
    b.init({ windowMs: 60_000 })
    assert.equal((await a.increment('1.2.3.4')).totalHits, 1)
    assert.equal((await b.increment('1.2.3.4')).totalHits, 2)
    await b.resetKey('1.2.3.4')
    assert.equal((await a.increment('1.2.3.4')).totalHits, 1)
  })

  test('login codes pause when the daily SMS budget is used up', async () => {
    const limit = env.OTP_DAILY_LIMIT
    env.OTP_DAILY_LIMIT = 2
    try {
      assert.equal((await api.post('/v1/auth/otp/request', { phone: '9876500001' })).status, 200)
      assert.equal((await api.post('/v1/auth/otp/request', { phone: '9876500002' })).status, 200)
      const third = await api.post('/v1/auth/otp/request', { phone: '9876500003' })
      assert.equal(third.status, 503)
      assert.equal(third.body.error.code, 'OTP_PAUSED')
    } finally {
      env.OTP_DAILY_LIMIT = limit
    }
  })

  test('another site cannot use the session cookie to refresh or log out', async () => {
    const evil = { headers: { Origin: 'https://evil.example', 'X-Session': 'cookie' } }
    const r = await api.post('/v1/auth/token/refresh', {}, evil)
    assert.equal(r.status, 403)
    assert.equal(r.body.error.code, 'CROSS_SITE')
    assert.equal((await api.post('/admin/v1/auth/logout', undefined, evil)).status, 403)
    // The shop's own origin gets through to the token check.
    const own = await api.post('/v1/auth/token/refresh', {}, { headers: { Origin: env.CUSTOMER_ORIGIN.split(',')[0], 'X-Session': 'cookie' } })
    assert.equal(own.status, 401)
  })

  test('a database that waits too long for a free connection answers 503, not a hang', async () => {
    const held = []
    try {
      for (let i = 0; i < pool.options.max; i++) held.push(await pool.connect())
      const r = await api.get('/v1/delivery/check?pincode=560034')
      assert.equal(r.status, 503)
      assert.equal(r.body.error.code, 'BUSY')
      assert.equal(r.headers.get('retry-after'), '2')
    } finally {
      for (const c of held) c.release()
    }
  })
})

describe('riders and deliveries', () => {
  let rider
  beforeEach(async () => {
    await api.post('/admin/v1/staff', { email: 'ravi@mandimangoes.test', role: 'RIDER', password: 'long-enough-1' }, { token: admin })
    rider = await adminToken(api, 'ravi@mandimangoes.test', 'long-enough-1')
  })

  test('riders can only act on orders on their run', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const notPacked = await paidOrder(await customerToken(api))
    assert.equal((await api.post(`/admin/v1/orders/${notPacked.orderId}/dispatch`, undefined, { token: rider })).status, 404)
    assert.equal((await api.get(`/admin/v1/orders/${notPacked.orderId}/delivery-photos/x`, { token: rider })).status, 404)
    assert.equal((await api.get('/admin/v1/manifest?date=2026-11-30', { token: rider })).status, 403)
    const packed = await packedOrder(await customerToken(api))
    assert.equal((await api.post(`/admin/v1/orders/${packed.orderId}/dispatch`, undefined, { token: rider })).status, 204)
    // Staff are not limited.
    assert.equal((await api.get('/admin/v1/manifest?date=2026-11-30', { token: admin })).status, 200)
  })

  test('after 3 missed deliveries the order waits for a call instead of another automatic retry', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const o = await packedOrder(await customerToken(api))
    for (let i = 1; i <= 3; i++) {
      // Each retry is on a later day (OPS-01).
      if (i > 1) setNow(new Date(Date.parse(T0) + (i - 1) * 86_400_000).toISOString())
      assert.equal((await api.post(`/admin/v1/orders/${o.orderId}/dispatch`, undefined, { token: admin })).status, 204)
      const r = await api.post(`/admin/v1/orders/${o.orderId}/delivery`, { outcome: 'FAILED', reason: 'NOT_HOME', attempt: i }, { token: admin })
      assert.equal(r.status, 200, JSON.stringify(r.body))
    }
    const after = await order(o.orderId)
    assert.deepEqual([after.status, after.delivery_failures], ['DELIVERY_FAILED', 3])
    const last = (await query(`SELECT id, reason FROM order_events WHERE order_id = $1 AND status = 'DELIVERY_FAILED' ORDER BY created_at DESC, id DESC LIMIT 1`, [o.orderId])).rows[0]
    assert.match(last.reason, /call the customer/)
    const msg = (await query('SELECT status FROM notifications WHERE event_id = $1', [last.id])).rows[0]
    assert.equal(msg.status, 'SKIPPED')
    const attention = (await api.get('/admin/v1/attention', { token: admin })).body
    assert.deepEqual(attention.failedDeliveries.map((d) => [d.id, d.attempts]), [[o.orderId, 3]])
  })

  test('deleting an account also removes gift details, chat records and delivery photos', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const cust = await customerToken(api, '9876512345')
    const o = await packedOrder(cust)
    await query(`UPDATE orders SET gift_recipient_name = 'Asha', gift_recipient_phone = '+919876500099', gift_message = 'Happy Diwali' WHERE id = $1`, [o.orderId])
    await api.post(`/admin/v1/orders/${o.orderId}/dispatch`, undefined, { token: rider })
    const jpeg = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#fa0' } }).jpeg().toBuffer()
    const photo = await api.raw('POST', `/admin/v1/orders/${o.orderId}/delivery-photos`, { token: rider, headers: { 'Content-Type': 'image/jpeg' }, raw: jpeg })
    assert.equal(photo.status, 201)
    const done = await api.post(`/admin/v1/orders/${o.orderId}/delivery`, { outcome: 'DELIVERED', photoId: photo.body.id, receivedBy: 'Security guard' }, { token: rider })
    assert.equal(done.status, 200, JSON.stringify(done.body))
    await query(`INSERT INTO wa_inbound (message_id, phone, received_at) VALUES ('wamid.1', '+919876512345', NOW())`)

    assert.equal((await api.del('/v1/me', { token: cust.accessToken })).status, 204)
    const after = await order(o.orderId)
    assert.deepEqual([after.gift_recipient_name, after.gift_recipient_phone, after.gift_message], [null, null, null])
    const p = (await query('SELECT bytes, blob_path, removed_at FROM delivery_photos WHERE id = $1', [photo.body.id])).rows[0]
    assert.deepEqual([p.bytes, p.blob_path, Boolean(p.removed_at)], [null, null, true])
    assert.equal((await query('SELECT received_by FROM delivery_attempts WHERE order_id = $1', [o.orderId])).rows[0].received_by, null)
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM wa_inbound WHERE phone = '+919876512345'`)).rows[0].n, 0)
  })
})

describe('environments', () => {
  test('a preview or development deployment refuses a production database, and the other way round', async () => {
    assert.equal(await checkDatabaseEnvironment({ query }, 'test'), 'test')
    await query(`UPDATE app_meta SET value = 'production' WHERE key = 'environment'`)
    await assert.rejects(checkDatabaseEnvironment({ query }, 'preview'), /belongs to production/)
    assert.equal(await checkDatabaseEnvironment({ query }, 'production'), 'production')
    await query(`UPDATE app_meta SET value = 'preview' WHERE key = 'environment'`)
    await assert.rejects(checkDatabaseEnvironment({ query }, 'production'), /belongs to preview/)
    assert.equal(await checkDatabaseEnvironment({ query }, 'development'), 'preview')
  })

  test('the 18:00 IST cutoff: 17:59 orders get tomorrow, 18:00 the day after', () => {
    setNow(T0)
    assert.equal(earliestRawDate(new Date('2026-10-15T12:29:59Z')), '2026-10-16') // 17:59:59 IST
    assert.equal(earliestRawDate(new Date('2026-10-15T12:30:00Z')), '2026-10-17') // 18:00:00 IST
    assert.equal(earliestRawDate(new Date('2026-10-15T18:29:59Z')), '2026-10-17') // 23:59:59 IST
    assert.equal(earliestRawDate(new Date('2026-10-15T18:30:00Z')), '2026-10-17') // 00:00 IST on the 16th, before the cutoff
  })
})
