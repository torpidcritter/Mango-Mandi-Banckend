import { closeAll, client, customerToken, line, makeBatch, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { query, tx } from '../src/db.js'
import { auditLedger } from '../src/inventory.js'

let srv
before(async () => {
  await resetDb()
  srv = await startServer()
})
after(async () => {
  await srv.close()
  await closeAll()
})

test('30 buyers racing for 10 boxes across two batches: exactly 10 win, nothing oversold', async () => {
  const api = client(srv.base)
  const a = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 6 } })
  const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 4 } })
  const buyers = []
  for (let i = 0; i < 30; i++) buyers.push((await customerToken(api)).accessToken)

  // Quotes first (they don't hold stock), then every confirm at once.
  const quotes = []
  for (const token of buyers) {
    await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 1 }, { token })
    quotes.push((await api.post('/v1/checkout/quote', { pincode: '560034' }, { token })).body.quoteId)
  }
  const results = await Promise.all(
    buyers.map((token, i) =>
      api.post('/v1/checkout/confirm', { quoteId: quotes[i], address: '12, 4th Cross, Koramangala' }, { token, headers: { 'Idempotency-Key': `race-${i}` } }),
    ),
  )
  const codes = results.map((r) => r.status)
  assert.equal(codes.filter((s) => s === 201).length, 10, JSON.stringify(results.filter((r) => r.status !== 201 && r.status !== 409).map((r) => r.body)))
  assert.equal(codes.filter((s) => s === 409).length, 20)
  assert.ok(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'STOCK_INSUFFICIENT'))
  assert.equal((await line(a, 'ALP-3')).held + (await line(b, 'ALP-3')).held, 10)
  assert.deepEqual(await tx((c) => auditLedger(c)), [])
})

test('a retried confirm with the same key never creates a second order', async () => {
  const api = client(srv.base)
  await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'BAD-3': 5 } })
  const { accessToken: token, customer } = await customerToken(api)
  await api.post('/v1/cart/items', { sku: 'BAD-3', stage: 'RIPE', qty: 1 }, { token })
  const quoteId = (await api.post('/v1/checkout/quote', { pincode: '560034' }, { token })).body.quoteId
  const send = () => api.post('/v1/checkout/confirm', { quoteId, address: '12, 4th Cross, Koramangala' }, { token, headers: { 'Idempotency-Key': 'same' } })
  const tries = await Promise.all([1, 2, 3, 4, 5].map(send))
  // A retry that lands while the first is still starting the payment is told to wait (PAY-6), never given an order to pay with nothing to pay.
  const answered = tries.filter((r) => !(r.status === 409 && r.body.error.code === 'PAYMENT_STARTING'))
  assert.ok(answered.every((r) => (r.status === 200 || r.status === 201) && r.body.razorpayOrderId), JSON.stringify(tries.map((r) => [r.status, r.body])))
  assert.equal(answered.filter((r) => r.status === 201).length, 1)
  const later = await send()
  assert.equal(later.status, 200)
  assert.equal(new Set([...answered, later].map((r) => r.body.orderId)).size, 1)
  assert.equal((await query('SELECT count(*)::int AS n FROM orders WHERE customer_id = $1', [customer.id])).rows[0].n, 1)
})
