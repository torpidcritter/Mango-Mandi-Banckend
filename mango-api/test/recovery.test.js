// Recovery paths for what Needs attention raises (owner's rule: every payment,
// refund, stock discrepancy or delivery exception has an owner and a visible
// way out). One block per gap the runbooks flagged. Razorpay is never called:
// a fetch stub stands in for it where a test needs the gateway.
import { adminToken, checkout, client, closeAll, customerToken, line, makeBatch, resetDb, signWebhook, startServer, T0 } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { drainBackground } from '../src/background.js'
import { setNow } from '../src/clock.js'
import { query } from '../src/db.js'
import { env } from '../src/env.js'
import { newId } from '../src/ids.js'
import { processDueRefunds, refundDuplicatePayments } from '../src/payments.js'

let srv
let api
let manager
let ops

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
  ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
})

const MIN = 60_000
const at = (ms) => setNow(new Date(Date.parse(T0) + ms).toISOString())
const attention = async () => (await api.get('/admin/v1/attention', { token: manager })).body
const auditRows = async (action) => (await query('SELECT * FROM staff_audit WHERE action = $1 ORDER BY created_at', [action])).rows
let eventSeq = 0
const hook = (event) => {
  const { raw, signature } = signWebhook(event)
  return api.raw('POST', '/webhooks/razorpay', {
    raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': `evt_rc${++eventSeq}` },
  })
}
const strayCapture = (paymentId, kind = 'payment.captured') => ({
  event: kind, payload: { payment: { entity: { id: paymentId, order_id: 'order_elsewhere', amount: 50000, currency: 'INR', status: kind === 'payment.failed' ? 'failed' : 'captured' } } },
})

/** Stands in for api.razorpay.com: `handler(method, path, body)` returns a body or [status, body]. */
function stubRazorpay(handler) {
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

async function paidOrder(paymentId) {
  const cust = await customerToken(api)
  const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
  assert.equal(c.status, 201, JSON.stringify(c.body))
  assert.equal((await api.post('/v1/dev/pay', { orderId: c.body.orderId, outcome: 'captured' })).body.result, 'confirmed')
  await query('UPDATE orders SET payment_id = $2 WHERE id = $1', [c.body.orderId, paymentId])
  return { ...c.body, cust }
}

describe('ledger drift: a manager repairs the counters from the append-only ledger', () => {
  test('preview, then apply: counters follow the ledger, one STATUS row records it, nothing in the ledger changes', async () => {
    const batchId = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const l = await line(batchId, 'ALP-3')
    await query('UPDATE batch_lines SET on_hand = 23 WHERE id = $1', [l.id]) // a hand edit in SQL: the counter drifts
    const ledgerBefore = (await query('SELECT * FROM batch_ledger WHERE batch_id = $1 ORDER BY id', [batchId])).rows
    assert.deepEqual((await attention()).ledgerDrift.map((d) => [d.lineId, d.onHand]), [[l.id, [23, 20]]])

    const path = `/admin/v1/batches/${batchId}/lines/${l.id}/repair`
    assert.equal((await api.get(path, { token: ops })).status, 403)
    const preview = await api.get(path, { token: manager })
    assert.equal(preview.status, 200)
    assert.deepEqual(
      [preview.body.drifting, preview.body.canRepair, preview.body.before, preview.body.after],
      [true, true, { onHand: 23, reserveBuffer: 0, held: 0, committed: 0 }, { onHand: 20, reserveBuffer: 0, held: 0, committed: 0 }],
    )
    assert.equal((await api.post(path, { reason: 'hand edit on the 14th', expected: preview.body.after }, { token: ops })).status, 403)
    assert.equal((await api.post(path, { expected: preview.body.after }, { token: manager })).status, 400, 'a reason is required')
    const stale = await api.post(path, { reason: 'hand edit on the 14th', expected: { ...preview.body.after, onHand: 21 } }, { token: manager })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error.code, 'PREVIEW_CHANGED')

    const r = await api.post(path, { reason: 'hand edit on the 14th', expected: preview.body.after }, { token: manager })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.repaired, true)
    assert.equal((await line(batchId, 'ALP-3')).on_hand, 20)
    const ledgerAfter = (await query('SELECT * FROM batch_ledger WHERE batch_id = $1 ORDER BY id', [batchId])).rows
    assert.deepEqual(ledgerAfter.filter((x) => ledgerBefore.some((y) => y.id === x.id)), ledgerBefore, 'earlier ledger rows are untouched')
    const added = ledgerAfter.filter((x) => !ledgerBefore.some((y) => y.id === x.id))
    assert.equal(added.length, 1)
    assert.deepEqual([added[0].event_type, added[0].delta, added[0].sku], ['STATUS', 0, 'ALP-3'])
    assert.match(added[0].reason, /onHand 23 → 20.*hand edit on the 14th/)
    assert.deepEqual((await attention()).ledgerDrift, [])
    const audit = await auditRows('POST /batches/:id/lines/:lineId/repair')
    assert.equal(audit.length, 1)
    assert.equal(audit[0].email, 'manager@mandimangoes.test')
    assert.equal(audit[0].detail.reason, 'hand edit on the 14th')
    assert.deepEqual(audit[0].detail.before.onHand, 23)

    // A repeat is a no-op.
    const again = await api.post(path, { reason: 'hand edit on the 14th', expected: preview.body.after }, { token: manager })
    assert.equal(again.status, 200)
    assert.equal(again.body.repaired, false)
    assert.equal((await query('SELECT count(*)::int AS n FROM batch_ledger WHERE batch_id = $1', [batchId])).rows[0].n, ledgerAfter.length)
    await drainBackground()
    assert.equal((await auditRows('POST /batches/:id/lines/:lineId/repair')).length, 1)
  })

  test('a repair that would oversell is refused and changes nothing', async () => {
    const batchId = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const l = await line(batchId, 'ALP-3')
    // The ledger lost boxes the counter still has, and a buffer of 4 is reserved: the ledger can't cover it.
    await query('UPDATE batch_lines SET reserve_buffer = 4 WHERE id = $1', [l.id])
    for (const [type, delta] of [['ADJUST_BUFFER', 4], ['ADJUST', -3]]) {
      await query(`INSERT INTO batch_ledger (id, batch_id, event_type, sku, delta, actor_type, actor_id, created_at) VALUES ($1, $2, $3, 'ALP-3', $4, 'system', 'test', now())`, [
        newId('led'), batchId, type, delta,
      ])
    }
    const path = `/admin/v1/batches/${batchId}/lines/${l.id}/repair`
    const preview = (await api.get(path, { token: manager })).body
    assert.equal(preview.canRepair, false)
    assert.match(preview.problem, /2 boxes on hand but 4 are promised/)
    const r = await api.post(path, { reason: 'try anyway', expected: preview.after }, { token: manager })
    assert.equal(r.status, 409)
    assert.equal(r.body.error.code, 'CANNOT_REPAIR')
    assert.equal((await line(batchId, 'ALP-3')).on_hand, 5)
  })
})

describe('webhook problems: Mark resolved', () => {
  test('a manager resolves one with a note; it leaves Needs attention; a repeat answers as it is', async () => {
    await hook(strayCapture('pay_STRAY1'))
    const [w] = (await attention()).webhookFailures
    assert.match(w.reason, /order we don't have \(order_elsewhere, payment pay_STRAY1\)/)
    assert.deepEqual([w.paymentId, w.refundable], ['pay_STRAY1', true])
    const path = `/admin/v1/webhook-failures/${w.id}/resolve`
    assert.equal((await api.post(path, { note: 'another site' }, { token: ops })).status, 403)
    assert.equal((await api.post(path, {}, { token: manager })).status, 400)
    const r = await api.post(path, { note: 'test site shares the Razorpay account; webhook fixed' }, { token: manager })
    assert.equal(r.status, 200)
    assert.equal(r.body.resolvedBy, 'manager@mandimangoes.test')
    assert.deepEqual((await attention()).webhookFailures, [])
    const again = await api.post(path, { note: 'twice' }, { token: manager })
    assert.equal(again.body.already, true)
    assert.equal(again.body.note, 'test site shares the Razorpay account; webhook fixed')
    const audit = await auditRows('POST /webhook-failures/:id/resolve')
    assert.equal(audit.length, 1)
    assert.equal(audit[0].detail.note, 'test site shares the Razorpay account; webhook fixed')
    assert.equal((await api.post('/admin/v1/webhook-failures/whf_nope/resolve', { note: 'x y z' }, { token: manager })).status, 404)
  })
})

describe('a live captured payment that matches no order: a manager refunds it', () => {
  test('through the duplicate-payment machinery: leased, full refund, receipt per attempt; once', async () => {
    const refunds = []
    const gw = stubRazorpay((method, path, body) => {
      if (method === 'GET' && /\/refunds$/.test(path)) return { items: refunds }
      if (method === 'POST' && path === '/payments/pay_STRAY2/refund') {
        refunds.push({ id: `rfnd_${refunds.length + 1}`, status: 'pending', amount: 50000, receipt: body.receipt, sentAmount: body.amount })
        return { id: refunds.at(-1).id, status: 'pending' }
      }
      return null
    })
    try {
      await hook(strayCapture('pay_STRAY2'))
      const [w] = (await attention()).webhookFailures
      const path = `/admin/v1/webhook-failures/${w.id}/refund`
      assert.equal((await api.post(path, { reason: 'bought nothing' }, { token: ops })).status, 403)
      assert.equal((await api.post(path, {}, { token: manager })).status, 400)
      const r = await api.post(path, { reason: 'checked in Razorpay: bought nothing' }, { token: manager })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      await drainBackground()
      const d = (await query(`SELECT * FROM duplicate_payments WHERE payment_id = 'pay_STRAY2'`)).rows[0]
      assert.deepEqual([d.refund_id, d.refund_status, d.order_id, d.preorder_id], ['rfnd_1', 'pending', null, null])
      assert.deepEqual(refunds.map((x) => [x.receipt, x.sentAmount]), [['dup-pay_STRAY2-r1', undefined]], 'full refund, first receipt')
      assert.deepEqual((await attention()).webhookFailures, [], 'the problem is resolved with the refund')
      const again = await api.post(path, { reason: 'again' }, { token: manager })
      assert.equal(again.body.already, true)
      await refundDuplicatePayments()
      await drainBackground()
      assert.equal(gw.calls.filter((c) => c.method === 'POST').length, 1, 'never refunded twice')
      const audit = await auditRows('POST /webhook-failures/:id/refund')
      assert.deepEqual([audit.length, audit[0].target, audit[0].detail.reason], [1, 'pay_STRAY2', 'checked in Razorpay: bought nothing'])
    } finally {
      gw.restore()
    }
  })

  test('refused when the payment now belongs to an order, or the problem names no captured payment', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    await hook(strayCapture('pay_STRAY3'))
    await hook(strayCapture('pay_FAILED', 'payment.failed'))
    const hooks = (await attention()).webhookFailures
    const captured = hooks.find((w) => w.paymentId === 'pay_STRAY3')
    const failed = hooks.find((w) => /payment.failed/.test(w.reason))
    assert.deepEqual([failed.paymentId, failed.refundable], [null, false])
    const nope = await api.post(`/admin/v1/webhook-failures/${failed.id}/refund`, { reason: 'refund it' }, { token: manager })
    assert.equal(nope.body.error.code, 'NO_PAYMENT')
    await paidOrder('pay_STRAY3')
    assert.equal((await attention()).webhookFailures.find((w) => w.id === captured.id).refundable, false)
    const matched = await api.post(`/admin/v1/webhook-failures/${captured.id}/refund`, { reason: 'refund it' }, { token: manager })
    assert.equal(matched.status, 409)
    assert.equal(matched.body.error.code, 'PAYMENT_MATCHED')
    assert.equal((await query(`SELECT count(*)::int AS n FROM duplicate_payments`)).rows[0].n, 0)
  })
})

describe('preorder needing a decision: Keep booking', () => {
  test('clears it without cancelling, recorded; back on the list once it moves again', async () => {
    await customerToken(api)
    const customer = (await query('SELECT id, phone FROM customers LIMIT 1')).rows[0]
    const add = async (moved) => {
      const id = newId('pre')
      await query(
        `INSERT INTO preorders (id, number, customer_id, phone, sku, stage, qty, unit_price, total, week_start, pincode, delivery_address,
                                status, payment_status, moved_count, created_at, booked_at)
         VALUES ($1, $2, $3, $4, 'ALP-3', 'RIPE', 1, 100, 100, '2026-11-02', '560034', 'x', 'BOOKED', 'SUCCEEDED', $5, now(), now())`,
        [id, `PRE-${moved}`, customer.id, customer.phone, moved],
      )
      return id
    }
    const stuck = await add(4)
    const fine = await add(1)
    assert.deepEqual((await attention()).preorderDecisions.map((p) => p.id), [stuck])
    const path = `/admin/v1/preorders/${stuck}/keep`
    assert.equal((await api.post(path, { reason: 'customer happy to wait' }, { token: ops })).status, 403)
    assert.equal((await api.post(path, {}, { token: manager })).status, 400)
    const r = await api.post(path, { reason: 'customer happy to wait' }, { token: manager })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual((await attention()).preorderDecisions, [])
    const p = (await query('SELECT * FROM preorders WHERE id = $1', [stuck])).rows[0]
    assert.deepEqual([p.status, p.payment_status, p.refund_requested_at], ['BOOKED', 'SUCCEEDED', null], 'not cancelled, not refunded')
    const events = (await query('SELECT * FROM preorder_events WHERE preorder_id = $1', [stuck])).rows
    assert.equal(events.length, 1)
    assert.match(events[0].reason, /Kept by a manager after moving 4 times.*customer happy to wait/)
    assert.equal((await api.post(path, { reason: 'again' }, { token: manager })).body.already, true)
    assert.equal((await query('SELECT count(*)::int AS n FROM preorder_events WHERE preorder_id = $1', [stuck])).rows[0].n, 1)
    assert.equal((await auditRows('POST /preorders/:id/keep')).length, 1)

    const notDue = await api.post(`/admin/v1/preorders/${fine}/keep`, { reason: 'no need' }, { token: manager })
    assert.equal(notDue.body.error.code, 'NO_DECISION_NEEDED')

    // The allocator moves it again: a new reason, so it needs a decision again.
    await query(`UPDATE preorders SET week_start = '2026-11-09', moved_count = moved_count + 1 WHERE id = $1`, [stuck])
    assert.deepEqual((await attention()).preorderDecisions.map((x) => x.id), [stuck])
  })
})

describe('a refund that can never go through: Paid back another way', () => {
  test('a manager records it with a reference; retries stop; it stays counted as refunded', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const o = await paidOrder('pay_CLOSED1')
    let gatewayRefunds = []
    // The customer's bank account is closed: Razorpay refuses every refund.
    const gw = stubRazorpay((method, path) => {
      if (method === 'GET' && path === '/payments/pay_CLOSED1/refunds') return { items: gatewayRefunds }
      if (method === 'POST') return [400, { error: { code: 'BAD_REQUEST_ERROR', description: 'refund not allowed' } }]
      return null
    })
    try {
      assert.equal((await api.post(`/v1/orders/${o.orderId}/cancel`, {}, { token: o.cust.accessToken })).status, 204)
      const path = `/admin/v1/refunds/${o.orderId}/paid-another-way`
      const body = { type: 'order', reference: 'NEFT UTR 1234567890', reason: 'card account closed; paid by bank transfer' }
      const early = await api.post(path, body, { token: manager })
      assert.equal(early.body.error.code, 'REFUND_NOT_STUCK', 'Razorpay gets its 30 minutes first')

      at(40 * MIN)
      await processDueRefunds()
      const stuck = (await attention()).stuckRefunds.find((r) => r.id === o.orderId)
      assert.equal(stuck.state, 'unsent')
      assert.equal((await api.post(path, body, { token: ops })).status, 403)
      assert.equal((await api.post(path, { ...body, reference: '' }, { token: manager })).status, 400)
      // A refund attempt holds the lease (it just ran): wait for it.
      const busy = await api.post(path, body, { token: manager })
      assert.equal(busy.body.error.code, 'REFUND_IN_PROGRESS')
      at(45 * MIN)
      // Razorpay shows a refund we never recorded: that one counts, no second payout.
      gatewayRefunds = [{ id: 'rfnd_LATE', status: 'pending', amount: o.total }]
      const has = await api.post(path, body, { token: manager })
      assert.equal(has.body.error.code, 'RAZORPAY_HAS_REFUND')
      gatewayRefunds = []

      const r = await api.post(path, body, { token: manager })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const row = (await query('SELECT * FROM orders WHERE id = $1', [o.orderId])).rows[0]
      assert.deepEqual([row.payment_status, row.refund_status, row.refund_id], ['REFUNDED', 'manual', 'manual:NEFT UTR 1234567890'])
      assert.ok(row.refunded_at, 'refunded_at set: Analytics counts it with the other refunds')
      const ev = (await query('SELECT reason FROM order_events WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1', [o.orderId])).rows[0]
      assert.match(ev.reason, /paid back outside Razorpay by manager@mandimangoes.test \(NEFT UTR 1234567890\): card account closed/)
      assert.ok(!(await attention()).stuckRefunds.some((x) => x.id === o.orderId))
      const posts = gw.calls.filter((c) => c.method === 'POST').length
      at(60 * MIN)
      await processDueRefunds()
      assert.equal(gw.calls.filter((c) => c.method === 'POST').length, posts, 'no more retries')
      assert.equal((await api.post(path, body, { token: manager })).body.already, true)
      const other = await api.post(path, { ...body, reference: 'another ref' }, { token: manager })
      assert.equal(other.body.error.code, 'ALREADY_REFUNDED')
      const audit = await auditRows('POST /refunds/:id/paid-another-way')
      assert.deepEqual([audit.length, audit[0].target, audit[0].detail.reference], [1, o.orderId, 'NEFT UTR 1234567890'])
      const detail = (await api.get(`/admin/v1/orders/${o.orderId}`, { token: manager })).body
      assert.deepEqual([detail.payment.refund.id, detail.payment.refund.status], ['manual:NEFT UTR 1234567890', 'manual'])
    } finally {
      gw.restore()
    }
  })

  test('a second payment Razorpay won\'t refund, by its payment id', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const o = await paidOrder('pay_FIRST')
    await query('INSERT INTO duplicate_payments (payment_id, order_id, amount, found_at, last_error) VALUES ($1, $2, $3, $4, $5)', [
      'pay_SECOND', o.orderId, o.total, new Date(T0), 'refund not allowed',
    ])
    at(40 * MIN)
    const stuck = (await attention()).stuckRefunds.find((r) => r.paymentId === 'pay_SECOND')
    assert.match(stuck.number, /\(second payment\)/)
    const r = await api.post('/admin/v1/refunds/pay_SECOND/paid-another-way', { type: 'payment', reference: 'UPI 998877', reason: 'paid back by UPI' }, { token: manager })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const d = (await query(`SELECT * FROM duplicate_payments WHERE payment_id = 'pay_SECOND'`)).rows[0]
    assert.deepEqual([d.refund_status, d.refund_id], ['manual', 'manual:UPI 998877'])
    assert.equal(await refundDuplicatePayments(), 0, 'not retried')
    const ev = (await query('SELECT reason FROM order_events WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1', [o.orderId])).rows[0]
    assert.match(ev.reason, /^Second payment pay_SECOND: Refund paid back outside Razorpay/)
    assert.equal((await query('SELECT payment_status FROM orders WHERE id = $1', [o.orderId])).rows[0].payment_status, 'SUCCEEDED', 'the order stays paid once')
  })
})

describe('Sign out all staff', () => {
  test('ends every other staff session and access token; the manager can stay signed in', async () => {
    const packer = await adminToken(api, 'packer@mandimangoes.test', 'packer123')
    assert.equal((await api.get('/admin/v1/auth/me', { token: ops })).status, 200)
    assert.equal((await api.post('/admin/v1/staff/sign-out-all', { reason: 'laptop stolen' }, { token: ops })).status, 403)
    assert.equal((await api.post('/admin/v1/staff/sign-out-all', {}, { token: manager })).status, 400)
    const r = await api.post('/admin/v1/staff/sign-out-all', { reason: 'laptop stolen' }, { token: manager })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(r.body.signedOut >= 2)
    assert.equal((await api.get('/admin/v1/auth/me', { token: ops })).status, 401)
    assert.equal((await api.get('/admin/v1/auth/me', { token: packer })).status, 401)
    assert.equal((await api.get('/admin/v1/auth/me', { token: manager })).status, 200, 'kept signed in')
    const me = (await query(`SELECT id FROM admin_users WHERE email = 'manager@mandimangoes.test'`)).rows[0].id
    const open = await query(`SELECT user_id FROM refresh_sessions WHERE user_type = 'admin' AND revoked_at IS NULL`)
    assert.ok(open.rows.every((s) => s.user_id === me), 'only the manager keeps a refresh session')
    const audit = await auditRows('POST /staff/sign-out-all')
    assert.deepEqual([audit.length, audit[0].detail.reason, audit[0].detail.keepMe], [1, 'laptop stolen', true])

    const all = await api.post('/admin/v1/staff/sign-out-all', { reason: 'rotate everything', keepMe: false }, { token: manager })
    assert.equal(all.status, 200)
    assert.equal((await api.get('/admin/v1/auth/me', { token: manager })).status, 401)
    assert.equal((await query(`SELECT count(*)::int AS n FROM refresh_sessions WHERE user_type = 'admin' AND revoked_at IS NULL`)).rows[0].n, 0)
  })
})
