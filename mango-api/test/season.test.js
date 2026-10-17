// Phase 3 season ops: bulk reschedule, the rider manifest and analytics.
import { closeAll, adminToken, checkout, client, customerToken, makeBatch, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { query, tx } from '../src/db.js'
import { auditLedger } from '../src/inventory.js'
import { paramsFor } from '../src/notify.js'

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
const bulk = (body, token = admin) => api.post('/admin/v1/orders/bulk-reschedule', body, { token })
const order = async (id) => (await api.get(`/admin/v1/orders/${id}`, { token: admin })).body
const place = async (items, opts = {}) => {
  const cust = await customerToken(api)
  const c = await checkout(api, cust.accessToken, items, { deliveryDate: '2026-10-16', ...opts })
  assert.equal(c.status, 201, JSON.stringify(c.body))
  await pay(c.body.orderId)
  return c.body.orderId
}

describe('bulk reschedule', () => {
  test('moves a whole day, tells each customer, and lists orders with no stock on the new date', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 4 } }) // ripe on 10-16 and 10-17
    await makeBatch({ age: 4, rating: 'SEMI_RIPE', lines: { 'ALP-3': 1 } }) // semi-ripe only on 10-16
    const a = await place([{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    const b = await place([{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])
    const semi = await place([{ sku: 'ALP-3', stage: 'SEMI_RIPE', qty: 1 }])
    const body = { fromDate: '2026-10-16', toDate: '2026-10-17', reason: 'Rain' }

    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    assert.equal((await bulk(body, ops)).status, 403)
    assert.equal((await bulk({ ...body, toDate: '2026-10-16' })).body.error.code, 'INVALID_DATE')
    assert.equal((await bulk({ ...body, toDate: '2026-10-25' })).body.error.code, 'INVALID_DATE')
    assert.equal((await bulk({ ...body, reason: '' })).status, 400)

    const preview = await bulk({ ...body, dryRun: true })
    assert.equal(preview.status, 200)
    assert.equal(preview.body.matched, 3)
    assert.equal((await order(a)).deliveryDate, '2026-10-16')

    const r = await bulk(body)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.moved.map((m) => [m.id, m.deliveryDate]).sort(), [[a, '2026-10-17'], [b, '2026-10-17']].sort())
    assert.deepEqual(r.body.notMoved.map((m) => m.id), [semi])
    assert.match(r.body.notMoved[0].reason, /No stock/)

    for (const id of [a, b]) {
      const o = await order(id)
      assert.equal(o.deliveryDate, '2026-10-17')
      assert.ok(o.events.some((e) => /Rain \(moved by manager@mandimangoes\.test\); moved from 2026-10-16 to 2026-10-17/.test(e.reason ?? '')))
      assert.ok(o.notifications.some((n) => n.kind === 'DATE_MOVED'))
    }
    const kept = await order(semi)
    assert.equal(kept.deliveryDate, '2026-10-16')
    assert.ok(!kept.notifications.some((n) => n.kind === 'DATE_MOVED'))

    // Nothing left on the old day except the order that didn't fit.
    assert.equal((await bulk({ ...body, dryRun: true })).body.matched, 1)
    assert.deepEqual(await tx((c) => auditLedger(c)), [])
  })

  test('only the listed orders move, and a single reschedule also tells the customer', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 4 } })
    const a = await place([{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    const b = await place([{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    const r = await bulk({ fromDate: '2026-10-16', toDate: '2026-10-17', reason: 'Van broke down', orderIds: [a] })
    assert.deepEqual(r.body.moved.map((m) => m.id), [a])
    assert.equal((await order(b)).deliveryDate, '2026-10-16')

    const one = await api.post(`/admin/v1/orders/${b}/reschedule`, { deliveryDate: '2026-10-17' }, { token: admin })
    assert.equal(one.status, 204)
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM notifications WHERE order_id = $1 AND kind = 'DATE_MOVED'`, [b])
    assert.equal(rows[0].n, 1)
    assert.deepEqual(paramsFor({ kind: 'DATE_MOVED', customer_name: 'Asha', number: 'ORD-1', delivery_date: '2026-10-17' }), [
      'Asha', 'ORD-1', 'Sat, 17 Oct', 'during the day',
    ])
  })
})

describe('rider manifest', () => {
  test('groups the day by slot, then pincode, with boxes and packed flags', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const morning = (await api.post('/admin/v1/slots', { label: 'Morning', startsAt: '07:00', endsAt: '11:00', sort: 1 }, { token: admin })).body
    const evening = (await api.post('/admin/v1/slots', { label: 'Evening', startsAt: '16:00', endsAt: '20:00', sort: 2 }, { token: admin })).body
    const a = await place([{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }], { slotId: evening.id, pincode: '560034' })
    const b = await place([{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }], { slotId: morning.id, pincode: '560008' })
    const c = await place([{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }], { slotId: morning.id, pincode: '560008' })
    await api.patch(`/admin/v1/orders/${c}/status`, { status: 'PROCESSING' }, { token: admin })
    await api.post(`/admin/v1/orders/${c}/allocate`, undefined, { token: admin })
    assert.equal((await api.patch(`/admin/v1/orders/${c}/status`, { status: 'PACKED' }, { token: admin })).status, 204)
    const unpaid = await customerToken(api)
    await checkout(api, unpaid.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }], { deliveryDate: '2026-10-16', slotId: morning.id })

    const m = (await api.get('/admin/v1/manifest?date=2026-10-16', { token: admin })).body
    assert.equal(m.orders, 3) // the unpaid checkout is left off
    assert.equal(m.boxes, 4)
    assert.deepEqual(m.runs.map((r) => [r.slot.label, r.orders, r.boxes]), [['Morning', 2, 2], ['Evening', 1, 2]])
    const stop = m.runs[0].stops[0]
    assert.deepEqual([stop.pincode, stop.city, stop.zone], ['560008', 'Bengaluru', 'East'])
    assert.deepEqual(stop.orders.map((o) => [o.id, o.packed]).sort(), [[b, false], [c, true]].sort())
    assert.equal(m.runs[1].stops[0].orders[0].id, a)
    assert.deepEqual(m.runs[1].stops[0].orders[0].items, [{ sku: 'ALP-3', productName: m.runs[1].stops[0].orders[0].items[0].productName, stage: 'RIPE', quantity: 2 }])
    assert.equal((await api.get('/admin/v1/manifest?date=2026-10-20', { token: admin })).body.runs.length, 0)
    assert.equal((await api.get('/admin/v1/manifest?date=tomorrow', { token: admin })).status, 400)
  })
})

describe('analytics', () => {
  test('weekly sales, deliveries, wastage and at-risk, plus a per-SKU table', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const spare = await makeBatch({ age: 4, rating: 'SEMI_RIPE', lines: { 'ALP-3': 3 } })
    const a = await place([{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    await place([{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])
    await api.patch(`/admin/v1/orders/${a}/status`, { status: 'PROCESSING' }, { token: admin })
    await api.post(`/admin/v1/orders/${a}/allocate`, undefined, { token: admin })
    for (const s of ['PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED']) {
      assert.equal((await api.patch(`/admin/v1/orders/${a}/status`, { status: s }, { token: admin })).status, 204)
    }
    assert.equal((await api.patch(`/admin/v1/batches/${spare}/status`, { status: 'CONDEMNED' }, { token: admin })).status, 200)

    const r = await api.get('/admin/v1/analytics', { token: admin })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.weeks.length, 8)
    assert.equal(r.body.to, '2026-10-18')
    const w = r.body.weeks.find((x) => x.weekStart === '2026-10-12')
    assert.deepEqual(
      [w.orders, w.boxes, w.delivered, w.received, w.wasted, w.condemned, w.wastageRate],
      [2, 3, 1, 8, 3, 3, 0.375],
    )
    assert.equal(w.revenue, r.body.bySku[0].revenue)
    assert.deepEqual([r.body.bySku[0].sku, r.body.bySku[0].boxes, r.body.bySku[0].wasted], ['ALP-3', 3, 3])
    assert.equal(r.body.totals.orders, 2)

    assert.equal((await api.get('/admin/v1/analytics?from=2026-10-20&to=2026-10-01', { token: admin })).status, 400)
    const one = (await api.get('/admin/v1/analytics?from=2026-10-12&to=2026-10-18', { token: admin })).body
    assert.deepEqual(one.weeks.map((x) => x.weekStart), ['2026-10-12'])
  })
})
