// SEC-R2: a forged webhook or cron call is refused before anything reads the
// database. This file's process points at a closed port, so any database read
// shows as a 503 UNAVAILABLE instead of the signature refusal.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

process.env.TEST_DATABASE_URL = 'postgres://mango:mango@127.0.0.1:1/mango_sigfirst_test'
process.env.DB_CONNECT_TIMEOUT_MS = '500'
const { client, closeAll, startServer } = await import('./helpers.js')

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

test('forged Razorpay and WhatsApp webhooks and a guessed cron secret are refused without touching the database', async () => {
  const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x', order_id: 'order_x', amount: 100 } } } })
  for (const sig of [undefined, '0'.repeat(64), 'abc']) {
    const r = await api.raw('POST', '/webhooks/razorpay', { raw, headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Razorpay-Signature': sig } : {}) } })
    assert.deepEqual([r.status, r.body.error.code], [400, 'BAD_SIGNATURE'])
  }
  for (const sig of [undefined, `sha256=${'0'.repeat(64)}`]) {
    const r = await api.raw('POST', '/webhooks/whatsapp', { raw: '{}', headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Hub-Signature-256': sig } : {}) } })
    assert.deepEqual([r.status, r.body.error.code], [401, 'BAD_SIGNATURE'])
  }
  for (const method of ['GET', 'POST']) {
    const r = await api.raw(method, '/internal/maintenance', { headers: { Authorization: 'Bearer guess' } })
    assert.deepEqual([r.status, r.body.error.code], [401, 'UNAUTHORIZED'])
  }
  // A signed one does reach the database (here: unavailable, so Razorpay retries).
  const { signWebhook } = await import('./helpers.js')
  const signed = signWebhook(JSON.parse(raw))
  const ok = await api.raw('POST', '/webhooks/razorpay', { raw: signed.raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signed.signature } })
  assert.equal(ok.status, 503)
})
