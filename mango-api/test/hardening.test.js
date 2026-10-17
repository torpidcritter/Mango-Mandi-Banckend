// Launch hardening: no double refunds or sends, login-code fallback, and the
// Needs attention view.
import { closeAll, adminToken, checkout, client, customerToken, makeBatch, resetDb, signWebhook, startServer, T0 } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { setNow } from '../src/clock.js'
import { query } from '../src/db.js'
import { runMaintenance } from '../src/maintenance.js'
import { sendDueNotifications } from '../src/notify.js'
import { claimRefund } from '../src/payments.js'
import { otpDelivery } from '../src/sms.js'
import { metaOtpSender } from '../src/whatsapp.js'

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

async function paidOrder() {
  await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
  const cust = await customerToken(api)
  const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
  await pay(c.body.orderId)
  return c.body.orderId
}

describe('one worker per job', () => {
  test('a refund can be claimed by one worker at a time, and again after the lease', async () => {
    const id = await paidOrder()
    await query('UPDATE orders SET refund_requested_at = $2 WHERE id = $1', [id, new Date(T0)])
    const [a, b] = await Promise.all([claimRefund('orders', id), claimRefund('orders', id)])
    assert.equal([a, b].filter(Boolean).length, 1)
    assert.equal(await claimRefund('orders', id, new Date(Date.parse(T0) + 60_000)), null)
    assert.ok(await claimRefund('orders', id, new Date(Date.parse(T0) + 3 * 60_000))) // the first worker died
    await query('UPDATE orders SET refunded_at = $2 WHERE id = $1', [id, new Date(T0)])
    assert.equal(await claimRefund('orders', id, new Date(Date.parse(T0) + 10 * 60_000)), null)
  })

  test('two senders running at once send each WhatsApp message once', async () => {
    const id = await paidOrder()
    const sent = []
    const sender = async (m) => {
      sent.push(m.template)
      await new Promise((r) => setTimeout(r, 20))
      return `wamid.${sent.length}`
    }
    const [x, y] = await Promise.all([sendDueNotifications({ sender }), sendDueNotifications({ sender })])
    assert.equal(x + y, 1)
    assert.deepEqual(sent, ['mandi_order_confirmed'])
    const { rows } = await query('SELECT status FROM notifications WHERE order_id = $1', [id])
    assert.deepEqual(rows.map((r) => r.status), ['SENT'])
  })
})

describe('login codes', () => {
  test('fall back to WhatsApp when SMS fails, and the other way round', async () => {
    const calls = []
    const ok = (ch) => async (phone) => calls.push(`${ch}:${phone}`)
    const down = async () => {
      throw new Error('gateway down')
    }
    assert.equal(await otpDelivery({ sms: down, whatsapp: ok('wa') })('9000000001', '123456'), 'whatsapp')
    assert.equal(await otpDelivery({ sms: ok('sms'), whatsapp: down })('9000000002', '123456', 'whatsapp'), 'sms')
    assert.equal(await otpDelivery({ sms: ok('sms'), whatsapp: null })('9000000003', '123456', 'whatsapp'), 'sms')
    assert.deepEqual(calls, ['wa:9000000001', 'sms:9000000002', 'sms:9000000003'])
    await assert.rejects(otpDelivery({ sms: down, whatsapp: down })('9000000004', '123456'), { code: 'OTP_NOT_SENT' })
  })

  test('the WhatsApp code uses an authentication template with the copy-code button', async () => {
    let req
    const send = metaOtpSender({ token: 't', phoneNumberId: '42', apiVersion: 'v21.0', language: 'en', template: 'mandi_login_code' }, async (url, init) => {
      req = { url, body: JSON.parse(init.body) }
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 })
    })
    await send('919000000001', '654321')
    assert.equal(req.url, 'https://graph.facebook.com/v21.0/42/messages')
    assert.equal(req.body.template.name, 'mandi_login_code')
    assert.deepEqual(req.body.template.components, [
      { type: 'body', parameters: [{ type: 'text', text: '654321' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '654321' }] },
    ])
  })

  test('the OTP request says which channel the code went by', async () => {
    const r = await api.post('/v1/auth/otp/request', { phone: '9000000009', channel: 'whatsapp' })
    assert.equal(r.status, 200)
    assert.equal(r.body.channel, 'sms') // tests have no WhatsApp provider, so it lands on SMS (logged)
    assert.equal((await api.post('/v1/auth/otp/request', { phone: '9000000008', channel: 'pigeon' })).status, 400)
  })
})

describe('needs attention', () => {
  test('shows a stale loop, failed messages, stuck refunds and unmatched webhooks; a message can be retried', async () => {
    let a = (await api.get('/admin/v1/attention', { token: admin })).body
    assert.equal(a.loop.stale, true)
    assert.equal(a.loop.lastRunAt, null)

    const id = await paidOrder()
    await query(`UPDATE notifications SET status = 'FAILED', attempts = 6, last_error = 'WhatsApp 400: template not approved' WHERE order_id = $1`, [id])
    const body = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x', order_id: 'order_nope', amount: 100 } } } }
    const { raw, signature } = signWebhook(body)
    const hook = await api.raw('POST', '/webhooks/razorpay', {
      raw, headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature, 'x-razorpay-event-id': 'evt_unknown' },
    })
    assert.equal(hook.status, 200)
    await runMaintenance()
    // A refund asked for an hour ago that never went through.
    await query('UPDATE orders SET refund_requested_at = $2 WHERE id = $1', [id, new Date(Date.parse(T0) - 3_600_000)])

    a = (await api.get('/admin/v1/attention', { token: admin })).body
    assert.equal(a.loop.stale, false)
    assert.deepEqual(a.loop.failingSteps, [])
    assert.equal(a.failedMessages.length, 1)
    assert.match(a.failedMessages[0].error, /template not approved/)
    assert.equal(a.failedMessages[0].order.id, id)
    assert.doesNotMatch(a.failedMessages[0].phone, /^\d{10}$/) // masked
    assert.deepEqual(a.stuckRefunds.map((r) => [r.type, r.id]), [['order', id]])
    assert.deepEqual(a.webhookFailures.map((w) => [w.source, w.eventKey]), [['razorpay', 'evt_unknown']])

    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    assert.equal((await api.post(`/admin/v1/notifications/${a.failedMessages[0].id}/retry`, undefined, { token: ops })).status, 204)
    assert.equal((await api.post(`/admin/v1/notifications/${a.failedMessages[0].id}/retry`, undefined, { token: ops })).status, 404)
    const { rows } = await query('SELECT status, attempts FROM notifications WHERE id = $1', [a.failedMessages[0].id])
    assert.deepEqual(rows[0], { status: 'PENDING', attempts: 0 })
    setNow(T0)
  })
})
