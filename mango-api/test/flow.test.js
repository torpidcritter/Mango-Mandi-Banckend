import { closeAll, T0, adminToken, checkout, client, customerToken, line, makeBatch, resetDb, signWebhook, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { setNow } from '../src/clock.js'
import { query, tx } from '../src/db.js'
import { auditLedger } from '../src/inventory.js'
import { runMaintenance } from '../src/maintenance.js'

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

const at = (iso) => setNow(iso)
const order = async (id) => (await api.get(`/admin/v1/orders/${id}`, { token: admin })).body
const pay = (orderId, outcome = 'captured') => api.post('/v1/dev/pay', { orderId, outcome })
const move = (id, status) => api.patch(`/admin/v1/orders/${id}/status`, { status }, { token: admin })
const noDrift = async () => assert.deepEqual(await tx((c) => auditLedger(c)), [])

// Today is 2026-10-15 (10:00 IST); the earliest delivery is 2026-10-16.
// A batch's age on delivery is its age today + 1. QC ratings below match the
// default profile at today's age, so they shift nothing.

describe('staff auth', () => {
  test('login, refresh rotation, and reuse detection', async () => {
    const login = await api.post('/admin/v1/auth/login', { email: 'manager@mandimangoes.test', password: 'manager123' })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie')
    assert.match(cookie, /mango_admin_rt=.*HttpOnly/i)
    const rt1 = cookie.split(';')[0]

    const r1 = await api.post('/admin/v1/auth/refresh', undefined, { headers: { Cookie: rt1 } })
    assert.equal(r1.status, 200)
    const rt2 = r1.headers.get('set-cookie').split(';')[0]
    assert.notEqual(rt2, rt1)

    // A second tab racing with the old cookie inside the grace window still works.
    const race = await api.post('/admin/v1/auth/refresh', undefined, { headers: { Cookie: rt1 } })
    assert.equal(race.status, 200)

    // After the grace window the old cookie is a stolen token: everything is revoked.
    at(new Date(Date.parse(T0) + 10_000))
    const reuse = await api.post('/admin/v1/auth/refresh', undefined, { headers: { Cookie: rt1 } })
    assert.equal(reuse.status, 401)
    assert.equal(reuse.body.error.code, 'INVALID_TOKEN')
    const after = await api.post('/admin/v1/auth/refresh', undefined, { headers: { Cookie: rt2 } })
    assert.equal(after.status, 401)
  })

  test('wrong password, me, and manager-only actions', async () => {
    const bad = await api.post('/admin/v1/auth/login', { email: 'manager@mandimangoes.test', password: 'nope' })
    assert.equal(bad.status, 401)
    assert.equal(bad.body.error.code, 'INVALID_CREDENTIALS')
    assert.equal((await api.get('/admin/v1/summary')).status, 401)

    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    assert.deepEqual((await api.get('/admin/v1/auth/me', { token: ops })).body, { email: 'ops@mandimangoes.test', role: 'OPERATOR', twoStep: { enabled: false, required: false } })
    const b = await makeBatch({ age: 4, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    assert.equal((await api.patch(`/admin/v1/batches/${b}/status`, { status: 'CONDEMNED' }, { token: ops })).status, 403)
    assert.equal((await api.del('/admin/v1/pincodes/560034', { token: ops })).status, 403)
    assert.equal((await api.patch(`/admin/v1/batches/${b}/status`, { status: 'EXHAUSTED' }, { token: ops })).status, 204)
  })
})

describe('batches', () => {
  test('receive, QC, adjust and ledger', async () => {
    const created = await api.post(
      '/admin/v1/batches',
      { variety: 'Alphonso', pluckedOn: '2026-10-13', farm: 'Ratnagiri', lines: [{ sku: 'ALP-3', onHand: 20 }, { sku: 'ALP-5', onHand: 10 }] },
      { token: admin },
    )
    assert.equal(created.status, 201)
    assert.equal(created.body.status, 'ARRIVING')
    assert.equal(created.body.ageDays, 2)
    const id = created.body.id
    assert.equal((await api.post('/admin/v1/batches', { variety: 'Alphonso', pluckedOn: '2026-10-13', lines: [{ sku: 'BAD-3', onHand: 1 }] }, { token: admin })).body.error.code, 'INVALID_SKU')
    assert.equal((await api.post('/admin/v1/batches', { variety: 'Alphonso', pluckedOn: '2026-10-20', lines: [{ sku: 'ALP-3', onHand: 1 }] }, { token: admin })).status, 400)

    const list = (await api.get('/admin/v1/batches', { token: admin })).body
    assert.equal(list[0].latestRating, null)
    assert.equal(list[0].available, 30)

    assert.equal((await api.patch(`/admin/v1/batches/${id}/status`, { status: 'SELLING' }, { token: admin })).status, 204)
    assert.equal((await api.patch(`/admin/v1/batches/${id}/status`, { status: 'ARRIVED' }, { token: admin })).body.error.code, 'INVALID_TRANSITION')

    const qc1 = await api.post(`/admin/v1/batches/${id}/qc`, { ripenessRating: 'RAW', condition: 'GOOD' }, { token: admin })
    assert.equal(qc1.status, 201)
    assert.equal(qc1.body.warning, undefined)
    const qc2 = await api.post(`/admin/v1/batches/${id}/qc`, { ripenessRating: 'RAW', condition: 'GOOD' }, { token: admin })
    assert.match(qc2.body.warning, /already logged today/)

    const detail = (await api.get(`/admin/v1/batches/${id}`, { token: admin })).body
    const alp3 = detail.lines.find((l) => l.sku === 'ALP-3')
    assert.equal(alp3.productName, 'Alphonso 3kg Box')
    const adj = await api.patch(`/admin/v1/batches/${id}/lines/${alp3.id}`, { onHand: 18, reserveBuffer: 2, reason: 'Two crushed in unloading' }, { token: admin })
    assert.equal(adj.status, 204)
    assert.equal((await api.patch(`/admin/v1/batches/${id}/lines/${alp3.id}`, { onHand: 1 }, { token: admin })).status, 400, 'reason is required')
    const ledger = (await api.get(`/admin/v1/batches/${id}/ledger`, { token: admin })).body
    assert.deepEqual(ledger.slice(0, 2).map((e) => [e.eventType, e.delta]).sort(), [['ADJUST', -2], ['ADJUST_BUFFER', 2]])
    await noDrift()
  })
})

describe('storefront', () => {
  test('pincode gate, cutoff and catalogue stages', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } }) // ripe on 10-16
    await makeBatch({ age: 2, rating: 'RAW', lines: { 'ALP-3': 6 } }) // raw on 10-16

    assert.deepEqual((await api.get('/v1/delivery/check?pincode=110001')).body.serviceable, false)
    const check = (await api.get('/v1/delivery/check?pincode=560034')).body
    assert.equal(check.earliestDeliveryDate, '2026-10-16')
    assert.equal(check.cutoffTime, '18:00 IST')

    const cat = (await api.get('/v1/catalogue?pincode=560034')).body
    const qty = (sku, stage) => cat.items.find((i) => i.sku === sku && i.stage === stage).qty
    assert.equal(qty('ALP-3', 'RIPE'), 10)
    assert.equal(qty('ALP-3', 'RAW'), 6)
    assert.equal(qty('ALP-3', 'SEMI_RIPE'), 0)

    // Two days later the young batch is semi-ripe and the old one is past the cap.
    const later = (await api.get('/v1/catalogue?pincode=560034&delivery_date=2026-10-18')).body
    const q2 = (stage) => later.items.find((i) => i.sku === 'ALP-3' && i.stage === stage).qty
    assert.deepEqual([q2('RAW'), q2('SEMI_RIPE'), q2('RIPE')], [0, 6, 0])

    // After 18:00 IST the earliest date is D+2; closed days are skipped.
    at('2026-10-15T13:00:00Z') // 18:30 IST
    await api.put('/admin/v1/calendar/2026-10-17', { isOpen: false, note: 'Bandh' }, { token: admin })
    assert.equal((await api.get('/v1/delivery/check?pincode=560034')).body.earliestDeliveryDate, '2026-10-18')
  })

  test('in-transit stock sells after its arrival date at the forecast confidence', async () => {
    await makeBatch({ age: 0, status: 'IN_TRANSIT', rating: null, lines: { 'ALP-3': 20 } })
    const d16 = (await api.get('/v1/catalogue?pincode=560034&delivery_date=2026-10-16')).body
    assert.equal(d16.items.filter((i) => i.sku === 'ALP-3').reduce((s, i) => s + i.qty, 0), 0)
    const d18 = (await api.get('/v1/catalogue?pincode=560034&delivery_date=2026-10-18')).body
    assert.equal(d18.items.find((i) => i.sku === 'ALP-3' && i.stage === 'RAW').qty, 17)
  })
})

describe('orders', () => {
  test('checkout → payment → pack → deliver → claim → replacement, never a refund', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])
    assert.equal(c.status, 201)
    assert.equal(c.body.status, 'PAYMENT_PENDING')
    assert.match(c.body.razorpayOrderId, /^order_dev_/)
    assert.equal(c.body.total, 2 * 189_900)
    assert.equal((await line(b, 'ALP-3')).held, 2)

    // Signed webhook confirms; the duplicate delivery is a no-op.
    const event = {
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_1', order_id: c.body.razorpayOrderId, amount: c.body.total, method: 'upi' } } },
    }
    const { raw, signature } = signWebhook(event)
    const hook = await api.raw('POST', '/webhooks/razorpay', { raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature } })
    assert.equal(hook.status, 200)
    assert.equal(hook.body.result, 'confirmed')
    const dup = await api.raw('POST', '/webhooks/razorpay', { raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature } })
    assert.equal(dup.body.duplicate, true)
    const forged = await api.raw('POST', '/webhooks/razorpay', { raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': 'a'.repeat(64) } })
    assert.equal(forged.status, 400)
    assert.equal(forged.body.error.code, 'BAD_SIGNATURE')

    let o = await order(c.body.orderId)
    assert.equal(o.status, 'CONFIRMED')
    assert.deepEqual(o.payment, { status: 'SUCCEEDED', method: 'upi', amount: 2 * 189_900, id: 'pay_1', refund: null })
    assert.equal(o.items[0].stage, 'RIPE')
    assert.equal(o.items[0].eatBy, '2026-10-19')
    assert.deepEqual(o.stock.map((s) => [s.batchId, s.state, s.quantity]), [[b, 'committed', 2]])
    assert.equal((await line(b, 'ALP-3')).committed, 2)

    assert.equal((await move(o.id, 'PROCESSING')).status, 204)
    assert.equal((await move(o.id, 'PROCESSING')).status, 409, 'a stale second click is a conflict')
    assert.equal((await move(o.id, 'PACKED')).body.error.code, 'NOT_ALLOCATED')

    const packList = (await api.get('/admin/v1/pack-list?date=2026-10-16', { token: admin })).body
    assert.equal(packList[0].items[0].picks[0].packed, false)
    assert.equal((await api.post(`/admin/v1/orders/${o.id}/allocate`, undefined, { token: admin })).status, 204)
    assert.equal((await line(b, 'ALP-3')).on_hand, 8)
    for (const s of ['PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED']) assert.equal((await move(o.id, s)).status, 204, s)

    // Claim → replacement (refunds are refused outright).
    const claim = await api.post('/v1/claims', { orderId: o.id, issueType: 'DAMAGED', description: 'Two mangoes crushed', itemSkus: ['ALP-3'] }, { token: cust.accessToken })
    assert.equal(claim.status, 201)
    const claims = (await api.get('/admin/v1/claims', { token: admin })).body
    assert.equal(claims[0].orderNumber, o.number)
    assert.equal(claims[0].customerPhone, o.phone)
    assert.equal((await api.post(`/admin/v1/claims/${claim.body.id}/review`, undefined, { token: admin })).status, 204)
    const refund = await api.post(`/admin/v1/claims/${claim.body.id}/resolve`, { resolution: 'REFUND_APPROVED' }, { token: admin })
    assert.equal(refund.body.error.code, 'NO_REFUNDS')
    assert.equal((await api.post(`/admin/v1/claims/${claim.body.id}/resolve`, { resolution: 'REPLACEMENT_APPROVED' }, { token: admin })).status, 204)
    const resolved = (await api.get('/admin/v1/claims?status=RESOLVED', { token: admin })).body[0]
    assert.equal(resolved.resolution, 'REPLACEMENT_APPROVED')
    const rep = await order(resolved.replacementOrder.id)
    assert.equal(rep.status, 'CONFIRMED')
    assert.equal(rep.total, 0)
    assert.equal(rep.replacementFor.number, o.number)
    assert.equal(rep.atRisk, false)
    assert.equal(rep.stock.reduce((s, r) => s + r.quantity, 0), 2)
    o = await order(o.id)
    assert.equal(o.payment.status, 'SUCCEEDED', 'payment is never touched')
    await noDrift()
  })

  test('idempotent confirm, and a sold-out checkout leaves nothing behind', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 3 } })
    const cust = await customerToken(api)
    const first = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }], { key: 'k-1' })
    assert.equal(first.status, 201)
    // A different body with the same key is refused, not replayed as the first order.
    const reused = await api.post('/v1/checkout/confirm', { quoteId: 'gone', address: 'anything at all here' }, { token: cust.accessToken, headers: { 'Idempotency-Key': 'k-1' } })
    assert.equal(reused.status, 422)
    assert.equal(reused.body.error.code, 'IDEMPOTENCY_KEY_REUSED')

    const other = await customerToken(api)
    const short = await checkout(api, other.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])
    assert.equal(short.status, 409)
    assert.equal(short.body.error.code, 'STOCK_INSUFFICIENT')
    assert.equal((await line(b, 'ALP-3')).held, 2)
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n, 1)
  })

  test('an expired hold is swept; a late payment still confirms on the same date', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])
    at(new Date(Date.parse(T0) + 11 * 60_000))
    await runMaintenance()
    let o = await order(c.body.orderId)
    assert.equal(o.status, 'CANCELLED')
    assert.equal((await line(b, 'ALP-3')).held, 0)

    assert.equal((await pay(o.id)).body.result, 'confirmed_late')
    o = await order(o.id)
    assert.equal(o.status, 'CONFIRMED')
    assert.equal(o.deliveryDate, '2026-10-16')
    assert.equal((await line(b, 'ALP-3')).committed, 2)
    assert.match(o.events.at(-1).reason ?? o.events.find((e) => e.status === 'CONFIRMED').reason, /after the hold expired/)
    assert.ok(!o.notifications.some((n) => n.kind === 'DATE_MOVED')) // same date: nothing to tell
    await noDrift()
  })

  test('a late payment after the stock is gone moves to the next date with stock', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 2 } }) // ripe on 10-16 only stock
    const later = await makeBatch({ age: 4, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } }) // semi on 10-16, ripe on 10-17
    const a = await customerToken(api)
    const ca = await checkout(api, a.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])
    at(new Date(Date.parse(T0) + 11 * 60_000))
    await runMaintenance()

    const b2 = await customerToken(api)
    const cb = await checkout(api, b2.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }], { deliveryDate: '2026-10-16' })
    await pay(cb.body.orderId)

    await pay(ca.body.orderId)
    const o = await order(ca.body.orderId)
    assert.equal(o.status, 'CONFIRMED')
    assert.equal(o.deliveryDate, '2026-10-17')
    assert.equal(o.atRisk, false)
    assert.deepEqual(o.stock.map((s) => s.batchId), [later])
    // The customer is told about the new date (and that they can cancel for a refund).
    assert.ok(o.notifications.some((n) => n.kind === 'DATE_MOVED'))
    await noDrift()
  })

  test('condemning a batch swaps orders to another batch or flags them at-risk, never cancels', async () => {
    const bad = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 4, 'ALP-5': 2 } })
    // Younger but QC'd ripe a day early, so it is also RIPE on 10-16; FEFO uses `bad` first.
    const spare = await makeBatch({ age: 4, rating: 'RIPE', lines: { 'ALP-3': 2 } })
    const c1 = await customerToken(api)
    const o1 = await checkout(api, c1.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])
    await pay(o1.body.orderId)
    const c2 = await customerToken(api)
    const o2 = await checkout(api, c2.accessToken, [{ sku: 'ALP-5', stage: 'RIPE', qty: 1 }])
    await pay(o2.body.orderId)
    assert.deepEqual((await order(o1.body.orderId)).stock.map((s) => s.batchId), [bad])

    const r = await api.patch(`/admin/v1/batches/${bad}/status`, { status: 'CONDEMNED' }, { token: admin })
    assert.equal(r.status, 200)
    const one = await order(o1.body.orderId)
    const two = await order(o2.body.orderId)
    assert.deepEqual(r.body.rebalancedOrders, [one.number])
    assert.deepEqual(one.stock.map((s) => s.batchId), [spare])
    assert.equal(one.atRisk, false)
    assert.deepEqual(r.body.atRiskOrders, [two.number])
    assert.equal(two.status, 'CONFIRMED')
    assert.equal(two.atRisk, true)
    assert.match(two.atRiskReason, /ALP-5 RIPE has no stock/)
    assert.equal((await line(bad, 'ALP-3')).on_hand, 0)
    const summary = (await api.get('/admin/v1/summary', { token: admin })).body
    assert.deepEqual(summary.atRiskOrders.map((x) => x.number), [two.number])

    // Packing an at-risk order is refused at the last checkpoint.
    const pack = await api.post(`/admin/v1/orders/${two.id}/allocate`, undefined, { token: admin })
    assert.equal(pack.body.error.code, 'AT_RISK')

    // New stock arrives: the nightly rebalance fills the order and clears the flag.
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-5': 3 } })
    await runMaintenance({ forceAll: true })
    assert.equal((await order(two.id)).atRisk, false)
    await noDrift()
  })

  test('a failed delivery is retried on the next delivery day', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    await pay(c.body.orderId)
    const id = c.body.orderId
    await move(id, 'PROCESSING')
    await api.post(`/admin/v1/orders/${id}/allocate`, undefined, { token: admin })
    for (const s of ['PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY']) await move(id, s)

    at('2026-10-16T08:00:00Z') // delivery day
    assert.equal((await move(id, 'DELIVERY_FAILED')).status, 204)
    let o = await order(id)
    assert.equal(o.deliveryDate, '2026-10-17')
    assert.equal(o.atRisk, false, 'age 7 on the retry date is still inside the cap')
    assert.match(o.events.at(-1).reason, /retrying on 2026-10-17/)

    // A second failure pushes the box past the 7-day cap: ops are warned.
    at('2026-10-17T08:00:00Z')
    await move(id, 'OUT_FOR_DELIVERY')
    await move(id, 'DELIVERY_FAILED')
    o = await order(id)
    assert.equal(o.deliveryDate, '2026-10-18')
    assert.equal(o.atRisk, true)
    assert.equal((await move(id, 'RTO')).status, 204)
  })

  test('customers can cancel until packing, and a paid order is refunded in full', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const cust = await customerToken(api)
    const unpaid = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal((await api.post(`/v1/orders/${unpaid.body.orderId}/cancel`, undefined, { token: cust.accessToken })).status, 204)
    assert.equal((await line(b, 'ALP-3')).held, 0)

    const paid = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    await pay(paid.body.orderId)
    assert.equal((await line(b, 'ALP-3')).committed, 1)
    assert.equal((await api.post(`/v1/orders/${paid.body.orderId}/cancel`, undefined, { token: cust.accessToken })).status, 204)
    const cancelled = (await api.get(`/v1/orders/${paid.body.orderId}`, { token: cust.accessToken })).body
    assert.equal(cancelled.status, 'CANCELLED')
    assert.equal(cancelled.paymentStatus, 'REFUNDED') // the one case MandiMangoes refunds
    assert.equal(cancelled.refundStatus, 'REFUNDED')
    assert.equal((await line(b, 'ALP-3')).committed, 0)
    const detail = (await api.get(`/admin/v1/orders/${paid.body.orderId}`, { token: admin })).body
    assert.match(detail.payment.refund.id, /^rfnd_dev_/)
    // A second payment can't revive a refunded order: it is refunded on its own.
    assert.equal((await pay(paid.body.orderId)).body.result, 'duplicate_payment')
    const dup = (await query('SELECT * FROM duplicate_payments WHERE order_id = $1', [paid.body.orderId])).rows
    assert.equal(dup.length, 1)
    assert.match(dup[0].refund_id, /^rfnd_dev_/)
    assert.equal((await api.get(`/v1/orders/${paid.body.orderId}`, { token: cust.accessToken })).body.status, 'CANCELLED')

    // Paid after the customer cancelled: stays cancelled and is refunded.
    const late = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal((await api.post(`/v1/orders/${late.body.orderId}/cancel`, undefined, { token: cust.accessToken })).status, 204)
    assert.equal((await pay(late.body.orderId)).body.result, 'refund_due')
    const lateOrder = (await api.get(`/v1/orders/${late.body.orderId}`, { token: cust.accessToken })).body
    assert.deepEqual([lateOrder.status, lateOrder.paymentStatus], ['CANCELLED', 'REFUNDED'])

    const packed = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    await pay(packed.body.orderId)
    await move(packed.body.orderId, 'PROCESSING')
    await api.post(`/admin/v1/orders/${packed.body.orderId}/allocate`, undefined, { token: admin })
    assert.equal((await move(packed.body.orderId, 'PACKED')).status, 204)
    const r = await api.post(`/v1/orders/${packed.body.orderId}/cancel`, undefined, { token: cust.accessToken })
    assert.equal(r.status, 409)
    assert.equal(r.body.error.code, 'NOT_CANCELLABLE')

    const stranger = await customerToken(api)
    assert.equal((await api.get(`/v1/orders/${packed.body.orderId}`, { token: stranger.accessToken })).status, 404)
  })

  test('batches retire at age 8 and the books balance', async () => {
    const old = await makeBatch({ age: 8, rating: 'RIPE', lines: { 'ALP-3': 4 } })
    const out = await runMaintenance({ forceAll: true })
    assert.equal(out.retired, 1)
    assert.equal(out.drift, 0)
    assert.equal((await api.get(`/admin/v1/batches/${old}`, { token: admin })).body.status, 'EXHAUSTED')
    assert.equal((await line(old, 'ALP-3')).on_hand, 0)
  })
})

describe('customer auth', () => {
  test('OTP verify, wrong codes lock out, refresh rotates', async () => {
    const phone = '9876543210'
    const req = await api.post('/v1/auth/otp/request', { phone: '+91 98765 43210' })
    assert.equal(req.body.sent, true)
    assert.match(req.body.devCode, /^\d{6}$/)
    const wrong = req.body.devCode === '000000' ? '111111' : '000000'
    assert.equal((await api.post('/v1/auth/otp/verify', { phone, code: wrong })).body.error.code, 'OTP_INVALID')
    const ok = await api.post('/v1/auth/otp/verify', { phone, code: req.body.devCode })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.expiresIn, 900)
    const r = await api.post('/v1/auth/token/refresh', { refreshToken: ok.body.refreshToken })
    assert.equal(r.status, 200)
    assert.notEqual(r.body.refreshToken, ok.body.refreshToken)

    const again = await api.post('/v1/auth/otp/request', { phone })
    for (let i = 0; i < 5; i++) await api.post('/v1/auth/otp/verify', { phone, code: wrong })
    assert.equal((await api.post('/v1/auth/otp/verify', { phone, code: again.body.devCode })).body.error.code, 'OTP_LOCKED')
    assert.equal((await api.post('/v1/auth/otp/request', { phone: '12345' })).status, 400)
  })
})

describe('ops tools', () => {
  test('orders list filters, summary, coverage, rules and reschedule', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 3 } })
    await makeBatch({ age: 4, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } }) // ripe from 10-17
    const cust = await customerToken(api, '9000000001')
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])
    await pay(c.body.orderId)

    const list = (await api.get('/admin/v1/orders?status=CONFIRMED&q=90000', { token: admin })).body
    assert.equal(list.total, 1)
    assert.equal(list.items[0].itemCount, 2)
    assert.equal((await api.get('/admin/v1/orders?q=ORD-9', { token: admin })).body.total, 0)
    assert.equal((await api.get('/admin/v1/orders?from=2026-10-16', { token: admin })).body.total, 0)

    const s = (await api.get('/admin/v1/summary', { token: admin })).body
    assert.equal(s.orders.CONFIRMED, 1)
    assert.ok(s.lowStock.some((l) => l.sku === 'BAD-3' && l.available === 0))
    assert.deepEqual(s.batchesNearLimit.map((b) => b.ageDays), [5])

    const grid = (await api.get('/admin/v1/coverage', { token: admin })).body
    const ripe = (d) => grid.find((g) => g.date === d).stock.find((x) => x.sku === 'ALP-3' && x.stage === 'RIPE').qty
    assert.equal(ripe('2026-10-16'), 1)
    assert.equal(ripe('2026-10-17'), 6)

    const resched = await api.post(`/admin/v1/orders/${c.body.orderId}/reschedule`, { deliveryDate: '2026-10-17' }, { token: admin })
    assert.equal(resched.status, 204)
    assert.equal((await order(c.body.orderId)).deliveryDate, '2026-10-17')

    const cfg = (await api.get('/admin/v1/config', { token: admin })).body
    assert.equal(cfg.version, 1)
    const bad = await api.put('/admin/v1/config', { rules: { ...cfg.rules, retireAge: 5 } }, { token: admin })
    assert.equal(bad.status, 400)
    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    assert.equal((await api.put('/admin/v1/config', { rules: { ...cfg.rules, cutoffHourIST: 17 } }, { token: ops })).status, 403)
    const saved = await api.put('/admin/v1/config', { rules: { ...cfg.rules, cutoffHourIST: 17 } }, { token: admin })
    assert.equal(saved.body.version, 2)
    await noDrift()
  })
})
