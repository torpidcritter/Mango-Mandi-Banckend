// OPS-08: with the database unreachable, requests get a retryable 503 with
// Retry-After, not a 500. This file's process points at a closed port.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

process.env.TEST_DATABASE_URL = 'postgres://mango:mango@127.0.0.1:1/mango_outage_test'
process.env.DB_CONNECT_TIMEOUT_MS = '1000'
const { client, closeAll, startServer } = await import('./helpers.js')
const { isDbUnavailable } = await import('../src/db.js')

let srv
let api
before(async () => {
  srv = await startServer()
  api = client(srv.base)
})
after(async () => {
  await srv.close()
  await closeAll()
})

test('shop and staff requests answer 503 UNAVAILABLE with Retry-After', async () => {
  for (const path of ['/v1/catalogue?pincode=400001', '/admin/v1/orders']) {
    const res = await fetch(`${srv.base}${path}`)
    assert.equal(res.status, 503, path)
    assert.equal(res.headers.get('retry-after'), '5')
    assert.equal((await res.json()).error.code, 'UNAVAILABLE')
  }
  const login = await api.post('/admin/v1/auth/login', { email: 'manager@mandimangoes.test', password: 'manager123' })
  assert.equal(login.status, 503)
})

test('connection-class errors are recognised; ordinary errors are not', () => {
  for (const e of [{ code: 'ECONNREFUSED' }, { code: 'ECONNRESET' }, { code: '57P01' }, { code: '08006' }, new Error('Connection terminated due to connection timeout')]) {
    assert.equal(isDbUnavailable(e), true, JSON.stringify(e.code ?? e.message))
  }
  for (const e of [{ code: '23505' }, { code: '40001' }, new Error('boom'), null]) assert.equal(isDbUnavailable(e), false)
})
