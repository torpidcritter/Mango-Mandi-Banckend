// Fixes from the 2026-10-19 implementation audit: the maintenance loop really
// does its work (C1), a captured payment must match what we charged (H1),
// refunds follow Razorpay's outcome (PAY-3), reconciliation reaches new
// orders first (PAY-4), and WhatsApp sends are recorded truthfully (OPS-2/3).
import { adminToken, checkout, client, closeAll, customerToken, makeBatch, resetDb, signWebhook, startServer, T0 } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { drainBackground } from '../src/background.js'
import { canStartCall, withBudget, withSlice } from '../src/budget.js'
import { setNow } from '../src/clock.js'
import { query } from '../src/db.js'
import { checkHealth, runMaintenance, SLICE } from '../src/maintenance.js'
import { recordDeliveryStatus, sendDueNotifications } from '../src/notify.js'
import { devGateway, processDueRefunds, reconcilePendingPayments, refundDuplicatePayments } from '../src/payments.js'
import { metaSender } from '../src/whatsapp.js'

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
beforeEach(async () => {
  await resetDb()
  await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
})

const later = (ms) => setNow(new Date(new Date(T0).getTime() + ms).toISOString())
const order = async (id) => (await query('SELECT * FROM orders WHERE id = $1', [id])).rows[0]
const hook = (event, eventId) => {
  const { raw, signature } = signWebhook(event)
  return api.raw('POST', '/webhooks/razorpay', {
    raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature, ...(eventId ? { 'X-Razorpay-Event-Id': eventId } : {}) },
  })
}
const capture = (entity) => ({ event: 'payment.captured', payload: { payment: { entity: { method: 'upi', currency: 'INR', ...entity } } } })

async function unpaid(qty = 1) {
  const cust = await customerToken(api)
  const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty }])
  assert.equal(c.status, 201, JSON.stringify(c.body))
  return { ...c.body, token: cust.accessToken }
}
async function paid(qty = 1) {
  const o = await unpaid(qty)
  assert.equal((await api.post('/v1/dev/pay', { orderId: o.orderId, outcome: 'captured' })).status, 200)
  return o
}

describe('the maintenance loop does the work it schedules', () => {
  test('every slice can start at least one outside call, but never past the run budget', async () => {
    for (const ms of Object.values(SLICE)) {
      await withBudget(45_000, () => withSlice(ms, async () => assert.equal(canStartCall(12_000), true, `slice ${ms}`)))
    }
    await withBudget(10_000, async () => assert.equal(canStartCall(12_000), false))
  })

  test('one run sends due messages, retries refunds, refunds double charges and reconciles a missed payment', async () => {
    const a = await paid() // its ORDER_CONFIRMED message is due
    const b = await paid()
    await query('UPDATE orders SET refund_requested_at = $2 WHERE id = $1', [b.orderId, T0])
    await query('INSERT INTO duplicate_payments (payment_id, order_id, amount, found_at) VALUES ($1, $2, $3, $4)', ['pay_twice', a.orderId, a.total, T0])
    const c = await unpaid()
    const rzp = (await order(c.orderId)).razorpay_order_id
    devGateway.set(rzp, { id: 'pay_missed_webhook', status: 'captured', amount: c.total, method: 'upi' })
    later(5 * 60_000)

    const out = await runMaintenance({ forceAll: true })
    assert.equal(out.reconciled, 1)
    assert.equal(out.refunded, 1)
    assert.equal(out.duplicates, 1)
    assert.ok(out.notified >= 2, JSON.stringify(out))
    assert.deepEqual(out.failed, [])
    assert.equal((await order(c.orderId)).status, 'CONFIRMED')
    assert.ok((await order(b.orderId)).refunded_at)
    assert.ok((await query(`SELECT refunded_at FROM duplicate_payments WHERE payment_id = 'pay_twice'`)).rows[0].refunded_at)
    const left = await query(`SELECT COUNT(*)::int AS n FROM notifications WHERE status = 'PENDING' AND next_attempt_at <= $1`, [new Date(new Date(T0).getTime() + 5 * 60_000)])
    assert.equal(left.rows[0].n, 0)
  })

  test('work left overdue is reported, and a payment found only by polling raises an alert', async () => {
    const a = await paid()
    later(30 * 60_000)
    const keys = await checkHealth({ reconciled: 1 })
    assert.ok(keys.includes('messages'), JSON.stringify(keys))
    assert.ok(keys.includes('polled'))
    await query('UPDATE notifications SET status = $2 WHERE order_id = $1', [a.orderId, 'SENT'])
    assert.deepEqual(await checkHealth({}), []) // the same alerts are not repeated within the hour either
  })
})

describe('a captured payment must match what we charged', () => {
  test('notes naming an order do not match a checkout order, whatever the amount', async () => {
    const o = await unpaid(2)
    const r = await hook(capture({ id: 'pay_notes', order_id: null, amount: 100, notes: { orderId: o.orderId } }), 'evt_notes')
    assert.equal(r.status, 200)
    assert.equal(r.body.unknownOrder, true)
    const row = await order(o.orderId)
    assert.equal(row.status, 'PAYMENT_PENDING')
    assert.equal(row.payment_id, null)
  })

  test('a short payment on the right Razorpay order confirms nothing and is refunded', async () => {
    const o = await unpaid(2)
    const rzp = (await order(o.orderId)).razorpay_order_id
    const r = await hook(capture({ id: 'pay_short', order_id: rzp, amount: 100 }), 'evt_short')
    assert.equal(r.body.result, 'rejected')
    await drainBackground() // the refund goes out after the webhook has been answered (PAY-B1)
    assert.equal((await order(o.orderId)).status, 'PAYMENT_PENDING')
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM webhook_failures WHERE reason LIKE '%pay_short%'`)).rows[0].n, 1)
    // The money goes back like a double charge.
    assert.equal(await refundDuplicatePayments(), 0) // already refunded by the webhook itself
    assert.ok((await query(`SELECT refunded_at FROM duplicate_payments WHERE payment_id = 'pay_short'`)).rows[0].refunded_at)
    // A retry of the same event, or the same payment seen again, is not logged twice.
    await hook(capture({ id: 'pay_short', order_id: rzp, amount: 100 }), 'evt_short_2')
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM webhook_failures WHERE reason LIKE '%pay_short%'`)).rows[0].n, 1)
  })

  test('other currencies and captures without a payment id are rejected', async () => {
    const o = await unpaid()
    const rzp = (await order(o.orderId)).razorpay_order_id
    assert.equal((await hook(capture({ id: 'pay_usd', order_id: rzp, amount: o.total, currency: 'USD' }), 'evt_usd')).body.result, 'rejected')
    assert.equal((await hook(capture({ order_id: rzp, amount: o.total }), 'evt_noid')).body.result, 'rejected')
    assert.equal((await order(o.orderId)).status, 'PAYMENT_PENDING')
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM duplicate_payments')).rows[0].n, 1) // only the USD one has an id to refund
  })

  test('the full amount in rupees on the right order confirms it', async () => {
    const o = await unpaid()
    const rzp = (await order(o.orderId)).razorpay_order_id
    const r = await hook(capture({ id: 'pay_ok', order_id: rzp, amount: o.total }), 'evt_ok')
    assert.equal(r.body.result, 'confirmed')
    assert.equal((await order(o.orderId)).payment_id, 'pay_ok')
  })

  test('reconciliation applies the same check', async () => {
    const o = await unpaid()
    const rzp = (await order(o.orderId)).razorpay_order_id
    devGateway.set(rzp, { id: 'pay_poll_short', status: 'captured', amount: 1, method: 'upi' })
    later(5 * 60_000)
    assert.equal(await reconcilePendingPayments(), 0)
    assert.equal((await order(o.orderId)).status, 'PAYMENT_PENDING')
  })
})

describe('refunds follow what Razorpay reports', () => {
  test('a refund that fails at Razorpay is reopened and sent again; a processed one is marked', async () => {
    const o = await paid()
    const cancel = await api.post(`/v1/orders/${o.orderId}/cancel`, {}, { token: o.token })
    assert.ok(cancel.status < 300, JSON.stringify(cancel.body))
    const first = await order(o.orderId)
    assert.ok(first.refunded_at)
    assert.equal(first.refund_status, 'pending')

    const failed = await hook({ event: 'refund.failed', payload: { refund: { entity: { id: first.refund_id, payment_id: first.payment_id, status: 'failed' } } } }, 'evt_rf1')
    assert.equal(failed.body.result, 'refund_failed')
    const reopened = await order(o.orderId)
    assert.equal(reopened.refunded_at, null)
    assert.equal(reopened.refund_status, 'failed')
    assert.equal(reopened.payment_status, 'SUCCEEDED')

    assert.equal(await processDueRefunds(), 1)
    const again = await order(o.orderId)
    assert.ok(again.refunded_at)
    assert.notEqual(again.refund_id, first.refund_id)
    await hook({ event: 'refund.processed', payload: { refund: { entity: { id: again.refund_id, status: 'processed' } } } }, 'evt_rf2')
    assert.equal((await order(o.orderId)).refund_status, 'processed')
  })
})

describe('reconciliation reaches new orders first', () => {
  test('abandoned checkouts are polled with a back-off and never crowd out orders still waiting', async () => {
    const old = await unpaid()
    later(20 * 60_000) // the sweeper cancels it
    await runMaintenance({ forceAll: true })
    assert.equal((await order(old.orderId)).status, 'CANCELLED')
    const fresh = await unpaid()
    devGateway.set((await order(fresh.orderId)).razorpay_order_id, { id: 'pay_fresh', status: 'captured', amount: fresh.total, method: 'upi' })
    later(23 * 60_000)
    assert.equal(await reconcilePendingPayments(), 1)
    assert.equal((await order(fresh.orderId)).status, 'CONFIRMED')
    // The abandoned order was checked once and is left alone for 15 minutes.
    const checked = (await order(old.orderId)).reconcile_checked_at
    later(24 * 60_000)
    await reconcilePendingPayments()
    assert.equal((await order(old.orderId)).reconcile_checked_at.getTime(), checked.getTime())
  })
})

describe('WhatsApp sends are recorded truthfully', () => {
  const ok = (body, status = 200) => async () => ({ ok: status < 300, status, json: async () => body })

  test('a 200 without a message id is retried; a request Meta refuses is not', async () => {
    const send = metaSender({ apiVersion: 'v21.0', phoneNumberId: '1', token: 't', language: 'en' }, ok({}))
    await assert.rejects(send({ phone: '+919800000000', template: 'x', params: [] }), /without a message id/)
    const refused = metaSender({ apiVersion: 'v21.0', phoneNumberId: '1', token: 't', language: 'en' }, ok({ error: { message: 'Template not found' } }, 404))
    await assert.rejects(refused({ phone: '+919800000000', template: 'x', params: [] }), (err) => err.permanent === true)
    const busy = metaSender({ apiVersion: 'v21.0', phoneNumberId: '1', token: 't', language: 'en' }, ok({}, 429))
    await assert.rejects(busy({ phone: '+919800000000', template: 'x', params: [] }), (err) => !err.permanent)
  })

  test('a permanent refusal fails at once; a message about an order that moved on is skipped', async () => {
    const o = await paid()
    const permanent = Object.assign(new Error('WhatsApp 404: Template not found'), { permanent: true })
    assert.equal(await sendDueNotifications({ sender: async () => { throw permanent } }), 0)
    assert.equal((await query('SELECT status FROM notifications WHERE order_id = $1', [o.orderId])).rows[0].status, 'FAILED')

    await query(`UPDATE notifications SET status = 'PENDING', kind = 'OUT_FOR_DELIVERY', next_attempt_at = $2 WHERE order_id = $1`, [o.orderId, T0])
    let calls = 0
    assert.equal(await sendDueNotifications({ sender: async () => { calls++; return 'wamid.1' } }), 0)
    assert.equal(calls, 0) // the order is CONFIRMED, not out for delivery: no stale delivery code
    assert.equal((await query('SELECT status, last_error FROM notifications WHERE order_id = $1', [o.orderId])).rows[0].status, 'SKIPPED')
  })

  test('a failed delivery report from Meta turns SENT into FAILED', async () => {
    const o = await paid()
    assert.equal(await sendDueNotifications({ sender: async () => 'wamid.report' }), 1)
    assert.equal(await recordDeliveryStatus({ id: 'wamid.report', status: 'delivered' }), 1)
    assert.equal(await recordDeliveryStatus({ id: 'wamid.report', status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] }), 1)
    const n = (await query('SELECT status, delivery_status, last_error FROM notifications WHERE order_id = $1', [o.orderId])).rows[0]
    assert.equal(n.status, 'FAILED')
    assert.match(n.last_error, /131026/)
  })
})

describe('limited promo codes', () => {
  test('a checkout swept for non-payment keeps its use for half an hour, since a late payment revives it', async () => {
    const admin = await adminToken(api)
    assert.equal((await api.post('/admin/v1/promos', { code: 'ONCE', kind: 'PERCENT', value: 10, maxUses: 1 }, { token: admin })).status, 201)
    const a = await customerToken(api)
    await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 1 }, { token: a.accessToken })
    const q = await api.post('/v1/checkout/quote', { pincode: '560034', promoCode: 'ONCE' }, { token: a.accessToken })
    assert.equal(q.status, 200, JSON.stringify(q.body))
    const c = await api.post('/v1/checkout/confirm', { quoteId: q.body.quoteId, address: '12, 4th Cross, Koramangala, Bengaluru' }, { token: a.accessToken, headers: { 'Idempotency-Key': 'promo-once-1' } })
    assert.equal(c.status, 201)
    later(12 * 60_000)
    await runMaintenance({ forceAll: true }) // the hold runs out: cancelled, unpaid
    assert.equal((await order(c.body.orderId)).status, 'CANCELLED')

    const b = await customerToken(api)
    await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 1 }, { token: b.accessToken })
    const soon = await api.post('/v1/checkout/quote', { pincode: '560034', promoCode: 'ONCE' }, { token: b.accessToken })
    assert.equal(soon.body.error?.code, 'PROMO_USED_UP')
    later(45 * 60_000)
    assert.equal((await api.post('/v1/checkout/quote', { pincode: '560034', promoCode: 'ONCE' }, { token: b.accessToken })).status, 200)
  })
})
