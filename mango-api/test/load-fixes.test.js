// Fixes from the local load test (readiness-2026-10-23/LOAD-TEST.md).
import { adminToken, checkout, client, closeAll, customerToken, makeBatch, resetDb, signWebhook, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { pool, query } from '../src/db.js'

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
beforeEach(resetDb)

const hook = (event) => {
  const { raw, signature } = signWebhook(event)
  return api.raw('POST', '/webhooks/razorpay', { raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': 'evt_load_1' } })
}

// LOAD-1: at 30x the planned peak, payment webhooks that found no free
// database connection answered 500, were logged as errors and recorded as
// webhook failures, which raised the "payments could not be matched" alert
// for what was only a busy minute. Razorpay retries any non-2xx, so the
// answer is the same retryable 503 BUSY every other route gives.
test('a payment webhook that finds the pool busy answers 503 BUSY and is not recorded as a failed webhook', async () => {
  await makeBatch({ age: 6, lines: { 'ALP-3': 5 } })
  const cust = await customerToken(api, '9876511111')
  const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
  assert.equal(c.status, 201, JSON.stringify(c.body))
  const event = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_load_1', order_id: c.body.razorpayOrderId, amount: c.body.total, currency: 'INR', method: 'upi' } } } }

  const held = []
  let r
  try {
    for (let i = 0; i < pool.options.max; i++) held.push(await pool.connect())
    r = await hook(event)
  } finally {
    for (const h of held) h.release()
  }
  assert.equal(r.status, 503)
  assert.equal(r.body.error.code, 'BUSY')
  assert.equal(r.headers.get('retry-after'), '2')
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM webhook_failures')).rows[0].n, 0)

  // Razorpay's retry then goes through and confirms the order once.
  const again = await hook(event)
  assert.equal(again.status, 200)
  assert.equal((await query('SELECT status FROM orders WHERE id = $1', [c.body.orderId])).rows[0].status, 'CONFIRMED')
})

// LOAD-3: a request that waited on a locked row until the database gave up
// (lock_timeout 55P03, or statement_timeout / a cancel 57014) answered 500. It is
// the same busy minute as a full pool: a retryable 503 BUSY, and the order is
// untouched. The test cancels the waiting query rather than setting a short
// lock_timeout, because a SET does not stick to a connection through PgBouncer.
test('a request that cannot get a row lock in time answers 503 BUSY, not 500', async () => {
  await makeBatch({ age: 6, lines: { 'ALP-3': 5 } })
  const cust = await customerToken(api, '9876511112')
  const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
  assert.equal(c.status, 201, JSON.stringify(c.body))
  await query(`UPDATE orders SET status = 'CONFIRMED' WHERE id = $1`, [c.body.orderId])
  const staff = await adminToken(api)

  const holder = await pool.connect()
  let r
  try {
    await holder.query('BEGIN')
    const { rows: [me] } = await holder.query('SELECT pg_backend_pid() AS pid')
    await holder.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [c.body.orderId])
    const pending = api.patch(`/admin/v1/orders/${c.body.orderId}/status`, { status: 'PROCESSING' }, { token: staff })
    // Wait until the request is stuck on the lock, then end it as a timeout would.
    let cancelled = false
    for (let i = 0; i < 100 && !cancelled; i++) {
      const { rows } = await query(
        `SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> $1 AND datname = current_database()`,
        [me.pid],
      )
      for (const w of rows) cancelled = (await query('SELECT pg_cancel_backend($1) AS ok', [w.pid])).rows[0].ok || cancelled
      if (!cancelled) await new Promise((res) => setTimeout(res, 50))
    }
    assert.ok(cancelled, 'the request never waited on the row lock')
    r = await pending
  } finally {
    await holder.query('ROLLBACK')
    holder.release()
  }
  assert.equal(r.status, 503, JSON.stringify(r.body))
  assert.equal(r.body.error.code, 'BUSY')
  assert.equal((await query('SELECT status FROM orders WHERE id = $1', [c.body.orderId])).rows[0].status, 'CONFIRMED')
})
