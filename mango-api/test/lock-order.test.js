// INV-03: condemning, retiring or QC-ing a batch while its customers pay must
// not deadlock. Batch operations lock the orders on the batch first (oldest
// first), the same order payments take locks in, then the batch and its lines.
import { adminToken, checkout, client, closeAll, customerToken, makeBatch, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { metrics } from '../src/metrics.js'

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

const deadlocks = async () => (await metrics.dbRetries.get()).values.filter((v) => v.labels.code === '40P01').reduce((s, v) => s + v.value, 0)

async function holders(n) {
  const out = []
  for (let i = 0; i < n; i++) {
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal(c.status, 201, JSON.stringify(c.body))
    out.push(c.body.orderId)
  }
  return out
}

for (const op of ['condemn', 'qc']) {
  test(`${op} while every holder pays at once: first try succeeds, no deadlock`, async () => {
    const before = await deadlocks()
    for (let round = 0; round < 4; round++) {
      await resetDb()
      manager = await adminToken(api)
      // The older batch is taken first (FEFO); the younger one can refill orders.
      const a = await makeBatch({ age: 6, rating: 'SEMI_RIPE', lines: { 'ALP-3': 8 } })
      await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 8 } })
      const ids = await holders(8)
      const batchCall =
        op === 'condemn'
          ? () => api.patch(`/admin/v1/batches/${a}/status`, { status: 'CONDEMNED', reason: 'rot found' }, { token: manager })
          : () => api.post(`/admin/v1/batches/${a}/qc`, { ripenessRating: 'RIPE', condition: 'GOOD' }, { token: manager })
      const results = await Promise.all([
        ...ids.slice(0, 4).map((orderId) => api.post('/v1/dev/pay', { orderId, outcome: 'captured' })),
        batchCall(),
        ...ids.slice(4).map((orderId) => api.post('/v1/dev/pay', { orderId, outcome: 'captured' })),
      ])
      const batch = results[4]
      assert.ok(batch.status === 200 || batch.status === 201, `round ${round}: ${batch.status} ${JSON.stringify(batch.body)}`)
      for (const r of results) assert.ok(r.status < 400, `${r.status} ${JSON.stringify(r.body)}`)
    }
    assert.equal((await deadlocks()) - before, 0, 'deadlocks were retried')
  })
}
