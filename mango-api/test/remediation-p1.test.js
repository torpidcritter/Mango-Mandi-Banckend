// Remediation Stage 2 (P1) regression tests, one block per audit finding.
import { adminToken, checkout, client, closeAll, customerToken, makeBatch, resetDb, startServer, T0 } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { addDays, setNow, todayIST } from '../src/clock.js'
import { query } from '../src/db.js'

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

async function paidOrder(qty = 1, opts = {}) {
  const cust = await customerToken(api)
  const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty }], opts)
  assert.equal(c.status, 201, JSON.stringify(c.body))
  await api.post('/v1/dev/pay', { orderId: c.body.orderId, outcome: 'captured' })
  return { id: c.body.orderId, date: c.body.deliveryDate, cust }
}

describe('packers see boxes, not people (SEC-02)', () => {
  test('manifest and pack list only for the run; no phone or address; no delivered or far-off orders', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const o = await paidOrder()
    const packer = await adminToken(api, 'packer@mandimangoes.test', 'packer123')

    // Outside yesterday/today/tomorrow: refused.
    const past = addDays(todayIST(), -5)
    assert.equal((await api.get(`/admin/v1/manifest?date=${past}`, { token: packer })).status, 403)
    assert.equal((await api.get(`/admin/v1/pack-list?date=${past}`, { token: packer })).status, 403)

    const run = await api.get(`/admin/v1/manifest?date=${o.date}`, { token: packer })
    assert.equal(run.status, 200)
    const stop = run.body.runs[0].stops[0].orders[0]
    assert.equal(stop.id, o.id)
    assert.equal(stop.phone, null)
    assert.equal(stop.deliveryAddress, null)
    assert.ok(stop.items.length)

    const detail = await api.get(`/admin/v1/orders/${o.id}`, { token: packer })
    assert.equal(detail.status, 200)
    assert.equal(detail.body.phone, null)
    assert.equal(detail.body.deliveryAddress, null)
    assert.equal(detail.body.payment, null)
    assert.deepEqual(detail.body.notifications, [])
    assert.ok(!JSON.stringify(detail.body).includes(o.cust.customer.phone.slice(-10)))

    // A manager still sees everything.
    const full = await api.get(`/admin/v1/orders/${o.id}`, { token: manager })
    assert.ok(full.body.phone)
    assert.ok(full.body.deliveryAddress)

    // A delivered order is gone for the packer.
    await query(`UPDATE orders SET status = 'DELIVERED' WHERE id = $1`, [o.id])
    assert.equal((await api.get(`/admin/v1/orders/${o.id}`, { token: packer })).status, 404)
    const after = await api.get(`/admin/v1/manifest?date=${o.date}`, { token: packer })
    assert.equal(after.body.runs.flatMap((r) => r.stops.flatMap((s) => s.orders)).length, 0)
  })

  test("an order beyond tomorrow can't be opened by a packer", async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const o = await paidOrder()
    await query('UPDATE orders SET delivery_date = $2 WHERE id = $1', [o.id, addDays(todayIST(), 4)])
    const packer = await adminToken(api, 'packer@mandimangoes.test', 'packer123')
    assert.equal((await api.get(`/admin/v1/orders/${o.id}`, { token: packer })).status, 404)
    assert.equal((await api.patch(`/admin/v1/orders/${o.id}/status`, { status: 'PROCESSING' }, { token: packer })).status, 404)
  })
})

describe('missed deliveries need a reason, an attempt and another day (OPS-01, OPS-02)', () => {
  async function outForDelivery() {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const o = await paidOrder()
    await api.post(`/admin/v1/orders/${o.id}/allocate`, {}, { token: manager })
    for (const status of ['PROCESSING', 'PACKED']) await api.patch(`/admin/v1/orders/${o.id}/status`, { status }, { token: manager })
    setNow(`${o.date}T04:00:00Z`)
    assert.equal((await api.post(`/admin/v1/orders/${o.id}/dispatch`, {}, { token: manager })).status, 204)
    return o
  }

  test('a bare DELIVERY_FAILED status is refused for every role; the report needs its attempt', async () => {
    const o = await outForDelivery()
    const packer = await adminToken(api, 'packer@mandimangoes.test', 'packer123')
    for (const token of [packer, manager]) {
      const r = await api.patch(`/admin/v1/orders/${o.id}/status`, { status: 'DELIVERY_FAILED' }, { token })
      assert.equal(r.status, 400)
      assert.equal(r.body.error.code, 'USE_DELIVERY_REPORT')
    }
    const noAttempt = await api.post(`/admin/v1/orders/${o.id}/delivery`, { outcome: 'FAILED', reason: 'NOT_HOME' }, { token: packer })
    assert.equal(noAttempt.body.error.code, 'ATTEMPT_REQUIRED')
    const detail = await api.get(`/admin/v1/orders/${o.id}`, { token: packer })
    assert.equal(detail.body.attempt, 1)
    assert.equal((await api.post(`/admin/v1/orders/${o.id}/delivery`, { outcome: 'FAILED', reason: 'NOT_HOME', attempt: 1 }, { token: packer })).status, 200)
    const rows = (await query('SELECT reason FROM delivery_attempts WHERE order_id = $1', [o.id])).rows
    assert.deepEqual(rows, [{ reason: 'NOT_HOME' }])
  })

  test('a missed order cannot be sent straight back out the same day, except by a manager', async () => {
    const o = await outForDelivery()
    const packer = await adminToken(api, 'packer@mandimangoes.test', 'packer123')
    assert.equal((await api.post(`/admin/v1/orders/${o.id}/delivery`, { outcome: 'FAILED', reason: 'NOT_HOME', attempt: 1 }, { token: packer })).status, 200)
    const again = await api.post(`/admin/v1/orders/${o.id}/dispatch`, {}, { token: packer })
    assert.equal(again.status, 409)
    assert.equal(again.body.error.code, 'SAME_DAY_RETRY')
    const viaPatch = await api.patch(`/admin/v1/orders/${o.id}/status`, { status: 'OUT_FOR_DELIVERY' }, { token: packer })
    assert.equal(viaPatch.body.error.code, 'SAME_DAY_RETRY')
    const ok = await api.post(`/admin/v1/orders/${o.id}/dispatch`, { override: true, reason: 'Customer called, home now' }, { token: manager })
    assert.equal(ok.status, 204)
    // Three quick misses can no longer happen in minutes: attempts stay at 1.
    assert.equal((await query('SELECT delivery_failures FROM orders WHERE id = $1', [o.id])).rows[0].delivery_failures, 1)
  })
})

describe('refund outcomes are checked, not assumed (PAY-02)', () => {
  test('a refund whose webhook never matched is polled: a failure reopens it and a new refund goes out', async () => {
    const { env } = await import('../src/env.js')
    const { reconcileRefunds, processDueRefunds } = await import('../src/payments.js')
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const o = await paidOrder()
    await query(`UPDATE orders SET payment_id = 'pay_R1' WHERE id = $1`, [o.id])
    const refunds = new Map() // refund id -> status at "Razorpay"
    let posts = 0
    const realFetch = globalThis.fetch
    env.RAZORPAY_KEY_ID = 'rzp_test_x'
    env.RAZORPAY_KEY_SECRET = 'secret'
    globalThis.fetch = async (url, init) => {
      const u = String(url)
      if (!u.startsWith('https://api.razorpay.com/')) return realFetch(url, init)
      const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (u.endsWith('/payments/pay_R1/refunds')) return json({ items: [...refunds].map(([id, status]) => ({ id, status, amount: 100 })) })
      if (u.endsWith('/payments/pay_R1/refund')) {
        posts++
        const id = `rfnd_${posts}`
        refunds.set(id, 'pending')
        return json({ id })
      }
      return json({})
    }
    try {
      assert.equal((await api.post(`/v1/orders/${o.id}/cancel`, {}, { token: o.cust.accessToken })).status, 204)
      await processDueRefunds()
      let row = (await query('SELECT refund_id, refund_status, refunded_at FROM orders WHERE id = $1', [o.id])).rows[0]
      assert.deepEqual([row.refund_id, row.refund_status], ['rfnd_1', 'pending'])

      // Razorpay fails it; the webhook is lost. Too soon to poll: nothing changes.
      refunds.set('rfnd_1', 'failed')
      assert.equal(await reconcileRefunds(), 0)
      // 31 minutes on, the poll finds the failure and reopens the refund.
      setNow(new Date(Date.parse(T0) + 31 * 60_000).toISOString())
      assert.equal(await reconcileRefunds(), 1)
      row = (await query('SELECT refund_id, refund_status, refunded_at FROM orders WHERE id = $1', [o.id])).rows[0]
      assert.deepEqual([row.refund_id, row.refund_status, row.refunded_at], [null, 'failed', null])
      // The next run sends a new one (the failed one doesn't count as paid).
      setNow(new Date(Date.parse(T0) + 34 * 60_000).toISOString())
      await processDueRefunds()
      row = (await query('SELECT refund_id, refund_status FROM orders WHERE id = $1', [o.id])).rows[0]
      assert.deepEqual([row.refund_id, row.refund_status], ['rfnd_2', 'pending'])
      assert.equal(posts, 2)
      // Processed: recorded; checked again only after an hour.
      refunds.set('rfnd_2', 'processed')
      setNow(new Date(Date.parse(T0) + 70 * 60_000).toISOString())
      assert.equal(await reconcileRefunds(), 1)
      assert.equal((await query('SELECT refund_status FROM orders WHERE id = $1', [o.id])).rows[0].refund_status, 'processed')
    } finally {
      globalThis.fetch = realFetch
      env.RAZORPAY_KEY_ID = ''
      env.RAZORPAY_KEY_SECRET = ''
    }
  })

  test('Needs attention lists a refund Razorpay has not confirmed after 5 days', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const o = await paidOrder()
    await query(
      `UPDATE orders SET status = 'CANCELLED', refund_requested_at = $2, refunded_at = $2, refund_id = 'rfnd_old', refund_status = 'pending' WHERE id = $1`,
      [o.id, new Date(Date.parse(T0) - 6 * 86_400_000)],
    )
    const att = await api.get('/admin/v1/attention', { token: manager })
    assert.ok(att.body.stuckRefunds.some((r) => r.id === o.id && /not confirmed by Razorpay/.test(r.number)), JSON.stringify(att.body.stuckRefunds))
  })
})

describe('a replacement goes on the next day with room (OPS-04)', () => {
  test('earliest day full: the replacement lands on a later day; every day full: a clear 409', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const o = await paidOrder()
    await api.post(`/admin/v1/orders/${o.id}/allocate`, {}, { token: manager })
    for (const status of ['PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY']) {
      assert.equal((await api.patch(`/admin/v1/orders/${o.id}/status`, { status }, { token: manager })).status, 204, status)
    }
    const done = await api.patch(`/admin/v1/orders/${o.id}/status`, { status: 'DELIVERED', override: true, reason: 'Confirmed by phone' }, { token: manager })
    assert.equal(done.status, 204)
    const claim = await api.post('/v1/claims', { orderId: o.id, issueType: 'DAMAGED', description: 'Two mangoes crushed', itemSkus: ['ALP-3'] }, { token: o.cust.accessToken })
    assert.equal(claim.status, 201, JSON.stringify(claim.body))
    await api.post(`/admin/v1/claims/${claim.body.id}/review`, undefined, { token: manager })

    const { orderableDates } = await import('../src/delivery.js')
    const dates = await orderableDates({ query })
    for (const d of dates) assert.equal((await api.put(`/admin/v1/calendar/${d}`, { isOpen: true, maxBoxes: 0 }, { token: manager })).status, 204)
    const none = await api.post(`/admin/v1/claims/${claim.body.id}/resolve`, { resolution: 'REPLACEMENT_APPROVED' }, { token: manager })
    assert.equal(none.status, 409)
    assert.equal(none.body.error.code, 'NO_DELIVERY_DAY')

    // Open the second day: the replacement goes there.
    await api.del(`/admin/v1/calendar/${dates[1]}`, { token: manager })
    const ok = await api.post(`/admin/v1/claims/${claim.body.id}/resolve`, { resolution: 'REPLACEMENT_APPROVED' }, { token: manager })
    assert.equal(ok.status, 204, JSON.stringify(ok.body))
    const { rows } = await query('SELECT delivery_date, total FROM orders WHERE replacement_for = $1', [o.id])
    assert.deepEqual(rows.map((r) => [r.delivery_date, r.total]), [[dates[1], 0]])
  })
})

describe('big stock increases need a manager (INV-04)', () => {
  test('an operator can correct a few boxes, not add hundreds; a manager can, and the ledger says so', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const lineId = (await query('SELECT id FROM batch_lines WHERE batch_id = $1', [b])).rows[0].id
    const operator = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    const patch = (token, onHand) => api.patch(`/admin/v1/batches/${b}/lines/${lineId}`, { onHand, reason: 'recount' }, { token })
    assert.equal((await patch(operator, 25)).status, 204, 'up to 20 boxes is a correction')
    const big = await patch(operator, 100_000)
    assert.equal(big.status, 403)
    assert.equal(big.body.error.code, 'MANAGER_APPROVAL_NEEDED')
    assert.equal((await query('SELECT on_hand FROM batch_lines WHERE id = $1', [lineId])).rows[0].on_hand, 25)
    assert.equal((await patch(manager, 200)).status, 204)
    const last = (await query(`SELECT reason FROM batch_ledger WHERE batch_id = $1 AND event_type = 'ADJUST' ORDER BY created_at DESC, id DESC LIMIT 1`, [b])).rows[0]
    assert.match(last.reason, /large increase of 175, by a manager/)
    // INV-C: a small drop is a correction; a big one needs a manager too.
    assert.equal((await patch(operator, 190)).status, 204)
    assert.equal((await patch(operator, 150)).status, 403)
  })
})

describe('a waitlist spot gets a link that lasts as long as the spot (PAY-01)', () => {
  test("the promoted customer's link closes after the 12-hour hold, not after 16 minutes", async () => {
    const { env } = await import('../src/env.js')
    const { newId } = await import('../src/ids.js')
    const { now } = await import('../src/clock.js')
    const { runPreorderJobs } = await import('../src/maintenance.js')
    let week = addDays(todayIST(), 6)
    while (new Date(`${week}T00:00:00Z`).getUTCDay() !== 1) week = addDays(week, 1)
    await api.put(`/admin/v1/preorder-capacity/${week}/ALP-3`, { capacity: 2 }, { token: manager })
    const book = (token, extra = {}) =>
      api.post('/v1/preorders', { sku: 'ALP-3', stage: 'RIPE', qty: 2, weekStart: week, pincode: '560034', address: '12, 4th Cross, Koramangala, Bengaluru', ...extra },
        { token, headers: { 'Idempotency-Key': newId('idem') } })

    const links = []
    const realFetch = globalThis.fetch
    env.RAZORPAY_KEY_ID = 'rzp_test_x'
    env.RAZORPAY_KEY_SECRET = 'secret'
    globalThis.fetch = async (url, init) => {
      const u = String(url)
      if (!u.startsWith('https://api.razorpay.com/')) return realFetch(url, init)
      if (u.endsWith('/payment_links') && init?.method === 'POST') {
        const body = JSON.parse(init.body)
        links.push(body)
        return new Response(JSON.stringify({ id: `plink_${links.length}`, short_url: `https://rzp.io/i/${links.length}` }), { status: 200 })
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 })
    }
    try {
      const a = await customerToken(api)
      assert.ok([200, 201].includes((await book(a.accessToken)).status))
      const b = await customerToken(api)
      const waiting = await book(b.accessToken, { waitlist: true })
      assert.equal(waiting.body.status, 'WAITLISTED')
      setNow(new Date(now().getTime() + 11 * 60_000).toISOString())
      const jobs = await runPreorderJobs()
      assert.equal(jobs.promoted, 1)
      const p = (await query('SELECT hold_expires_at, payment_link_id FROM preorders WHERE id = $1', [waiting.body.id])).rows[0]
      const link = links.find((l) => l.notes?.preorderId === waiting.body.id)
      assert.ok(link, 'a link was created for the promoted spot')
      assert.ok(link.expire_by >= Math.floor(p.hold_expires_at.getTime() / 1000), `link closes at ${link.expire_by}, spot held until ${p.hold_expires_at.toISOString()}`)
    } finally {
      globalThis.fetch = realFetch
      env.RAZORPAY_KEY_ID = ''
      env.RAZORPAY_KEY_SECRET = ''
    }
  })
})
