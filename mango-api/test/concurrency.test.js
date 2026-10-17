import { closeAll, checkout, client, customerToken, line, makeBatch, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { tx } from '../src/db.js'
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
  const { accessToken: token } = await customerToken(api)
  await api.post('/v1/cart/items', { sku: 'BAD-3', stage: 'RIPE', qty: 1 }, { token })
  const quoteId = (await api.post('/v1/checkout/quote', { pincode: '560034' }, { token })).body.quoteId
  const tries = await Promise.all(
    [1, 2, 3, 4, 5].map(() => api.post('/v1/checkout/confirm', { quoteId, address: '12, 4th Cross, Koramangala' }, { token, headers: { 'Idempotency-Key': 'same' } })),
  )
  assert.ok(tries.every((r) => r.status === 200 || r.status === 201), JSON.stringify(tries.map((r) => [r.status, r.body])))
  assert.equal(new Set(tries.map((r) => r.body.orderId)).size, 1)
})
