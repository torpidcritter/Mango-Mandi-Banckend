// Deleting a customer account (DPDP Act).
import { checkout, closeAll, client, customerToken, makeBatch, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { query } from '../src/db.js'

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
beforeEach(() => resetDb())

describe('deleting an account', () => {
  test('not while an order is open; after that, personal details are gone but the order amounts stay', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api, '9876501234')
    const o = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal(o.status, 201, JSON.stringify(o.body))
    const created = (await query('SELECT privacy_accepted_at FROM customers WHERE id = $1', [cust.customer.id])).rows[0]
    assert.ok(created.privacy_accepted_at)

    const blocked = await api.del('/v1/me', { token: cust.accessToken })
    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.error.code, 'OPEN_ORDERS')

    // An unpaid order lapses; cancel it to finish it.
    assert.equal((await api.post(`/v1/orders/${o.body.orderId}/cancel`, undefined, { token: cust.accessToken })).status, 204)
    await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 2 }, { token: cust.accessToken })
    assert.equal((await api.del('/v1/me', { token: cust.accessToken })).status, 204)

    const c = (await query('SELECT phone, name, email, deleted_at FROM customers WHERE id = $1', [cust.customer.id])).rows[0]
    assert.deepEqual({ ...c, deleted_at: Boolean(c.deleted_at) }, { phone: null, name: null, email: null, deleted_at: true })
    const order = (await query('SELECT phone, delivery_address, total FROM orders WHERE id = $1', [o.body.orderId])).rows[0]
    assert.equal(order.phone, null)
    assert.equal(order.delivery_address, null)
    assert.ok(order.total > 0)
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM carts WHERE customer_id = $1', [cust.customer.id])).rows[0].n, 0)
    assert.equal((await api.get('/v1/me', { token: cust.accessToken })).status, 401)

    // The same number can make a new, empty account.
    const again = await customerToken(api, '9876501234')
    assert.notEqual(again.customer.id, cust.customer.id)
    assert.equal((await api.get('/v1/orders', { token: again.accessToken })).body.length, 0)
  })
})
