// Staff roles: packers and QC see only their own screens; managers manage
// staff; every change lands in the audit trail.
import { closeAll, adminToken, checkout, client, customerToken, makeBatch, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

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

async function paidOrder() {
  await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
  const cust = await customerToken(api)
  const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
  await api.post('/v1/dev/pay', { orderId: c.body.orderId, outcome: 'captured' })
  return c.body.orderId
}

/** Audit rows are written once the response is sent, so wait for them. */
async function auditUntil(token, pred, qs = '') {
  for (let i = 0; i < 50; i++) {
    const r = await api.get(`/admin/v1/audit${qs}`, { token })
    if (r.status === 200 && pred(r.body.items)) return r.body
    await new Promise((res) => setTimeout(res, 20))
  }
  throw new Error('audit row never appeared')
}

describe('staff roles', () => {
  test('a packer packs and delivers, and nothing else', async () => {
    const id = await paidOrder()
    const packer = await adminToken(api, 'packer@mandimangoes.test', 'packer123')
    assert.equal((await api.get('/admin/v1/auth/me', { token: packer })).body.role, 'PACKER')
    assert.equal((await api.get('/admin/v1/pack-list?date=2026-10-16', { token: packer })).status, 200)
    assert.equal((await api.get('/admin/v1/manifest?date=2026-10-16', { token: packer })).status, 200)
    assert.equal((await api.get(`/admin/v1/orders/${id}`, { token: packer })).status, 200)
    assert.equal((await api.post(`/admin/v1/orders/${id}/allocate`, {}, { token: packer })).status, 204)
    assert.equal((await api.patch(`/admin/v1/orders/${id}/status`, { status: 'PROCESSING' }, { token: packer })).status, 204)
    assert.equal((await api.patch(`/admin/v1/orders/${id}/status`, { status: 'PACKED' }, { token: packer })).status, 204)

    for (const [method, path, body] of [
      ['get', '/admin/v1/orders'],
      ['get', '/admin/v1/batches'],
      ['get', '/admin/v1/claims'],
      ['get', '/admin/v1/attention'],
      ['get', '/admin/v1/pincodes'],
      ['post', `/admin/v1/orders/${id}/cancel`, { reason: 'no' }],
      ['post', `/admin/v1/orders/${id}/reschedule`, { deliveryDate: '2026-10-18' }],
      ['patch', `/admin/v1/orders/${id}/status`, { status: 'CANCELLED' }],
      ['patch', `/admin/v1/orders/${id}/status`, { status: 'RTO' }],
    ]) {
      const r = await api[method](path, ...(body ? [body, { token: packer }] : [{ token: packer }]))
      assert.equal(r.status, 403, `${method} ${path} ${JSON.stringify(body ?? '')}`)
    }
  })

  test('QC receives batches and logs QC, and sees no orders', async () => {
    await makeBatch({ age: 1, rating: 'RAW', lines: { 'ALP-3': 5 } })
    const qc = await adminToken(api, 'qc@mandimangoes.test', 'qc123')
    const list = await api.get('/admin/v1/batches', { token: qc })
    assert.equal(list.status, 200)
    const batchId = (list.body.items ?? list.body)[0].id
    assert.equal((await api.get(`/admin/v1/batches/${batchId}`, { token: qc })).status, 200)
    assert.equal((await api.get(`/admin/v1/batches/${batchId}/ledger`, { token: qc })).status, 200)
    assert.equal((await api.patch(`/admin/v1/batches/${batchId}/status`, { status: 'CONDEMNED' }, { token: qc })).status, 403)
    for (const path of ['/admin/v1/orders', '/admin/v1/pack-list?date=2026-10-16', '/admin/v1/analytics', '/admin/v1/config']) {
      assert.equal((await api.get(path, { token: qc })).status, 403, path)
    }
  })

  test('operators keep their access but cannot manage staff or read the audit trail', async () => {
    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    assert.equal((await api.get('/admin/v1/orders', { token: ops })).status, 200)
    assert.equal((await api.get('/admin/v1/staff', { token: ops })).status, 403)
    assert.equal((await api.get('/admin/v1/audit', { token: ops })).status, 403)
  })
})

describe('staff management and the audit trail', () => {
  test('a manager adds, changes and removes staff; the new role applies and every change is logged', async () => {
    const add = await api.post('/admin/v1/staff', { email: 'Ravi@MandiMangoes.test', role: 'PACKER', password: 'long-enough-1' }, { token: manager })
    assert.equal(add.status, 201)
    assert.equal(add.body.email, 'ravi@mandimangoes.test')
    assert.equal((await api.post('/admin/v1/staff', { email: 'ravi@mandimangoes.test', role: 'QC', password: 'long-enough-1' }, { token: manager })).status, 409)
    assert.equal((await api.post('/admin/v1/staff', { email: 'x@mandimangoes.test', role: 'QC', password: 'short' }, { token: manager })).status, 400)

    let ravi = await adminToken(api, 'ravi@mandimangoes.test', 'long-enough-1')
    assert.equal((await api.get('/admin/v1/batches', { token: ravi })).status, 403)
    assert.equal((await api.patch(`/admin/v1/staff/${add.body.id}`, { role: 'QC' }, { token: manager })).status, 200)
    ravi = await adminToken(api, 'ravi@mandimangoes.test', 'long-enough-1')
    assert.equal((await api.get('/admin/v1/batches', { token: ravi })).status, 200)

    const me = (await api.get('/admin/v1/staff', { token: manager })).body.find((s) => s.email === 'manager@mandimangoes.test')
    assert.equal((await api.patch(`/admin/v1/staff/${me.id}`, { role: 'OPERATOR' }, { token: manager })).status, 400)
    assert.equal((await api.del(`/admin/v1/staff/${me.id}`, { token: manager })).status, 400)
    assert.equal((await api.del(`/admin/v1/staff/${add.body.id}`, { token: manager })).status, 204)
    assert.equal((await api.post('/admin/v1/auth/login', { email: 'ravi@mandimangoes.test', password: 'long-enough-1' })).status, 401)

    const log = await auditUntil(manager, (items) => items.some((a) => a.action === 'DELETE /staff/:id'))
    const add1 = log.items.find((a) => a.action === 'POST /staff')
    assert.equal(add1.email, 'manager@mandimangoes.test')
    assert.equal(add1.target, add.body.id)
    assert.equal(add1.detail.password, '[removed]')
    assert.ok(log.items.some((a) => a.action === 'auth.login' && a.email === 'ravi@mandimangoes.test'))
    assert.ok(!log.items.some((a) => a.action === 'POST /staff' && a.detail.role === 'QC'), 'refused changes are not logged')
    assert.ok(log.staff.some((s) => s.email === 'qc@mandimangoes.test' && s.role === 'QC'))
  })

  test('order steps are logged against the order, and the trail filters by person and target', async () => {
    const id = await paidOrder()
    const packer = await adminToken(api, 'packer@mandimangoes.test', 'packer123')
    await api.post(`/admin/v1/orders/${id}/allocate`, {}, { token: packer })
    await api.patch(`/admin/v1/orders/${id}/status`, { status: 'PROCESSING' }, { token: packer })
    const log = await auditUntil(manager, (items) => items.length === 2, `?staff=packer@mandimangoes.test&target=${id}`)
    assert.deepEqual(log.items.map((a) => a.action), ['PATCH /orders/:id/status', 'POST /orders/:id/allocate'])
    assert.deepEqual(log.items[0].detail, { status: 'PROCESSING' })
    assert.equal(log.items[0].role, 'PACKER')
  })
})
