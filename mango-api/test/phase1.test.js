// Delivery slots and WhatsApp order updates.
import { closeAll, adminToken, checkout, client, customerToken, makeBatch, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { now, setNow } from '../src/clock.js'
import { query } from '../src/db.js'
import { paramsFor, sendDueNotifications } from '../src/notify.js'
import { metaSender } from '../src/whatsapp.js'

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
const move = (id, status) => api.patch(`/admin/v1/orders/${id}/status`, { status }, { token: admin })
const addSlot = async (body) => {
  const r = await api.post('/admin/v1/slots', body, { token: admin })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body
}
const notes = async (orderId) =>
  (await query('SELECT kind, status FROM notifications WHERE order_id = $1 ORDER BY created_at, kind', [orderId])).rows.map((n) => `${n.kind}:${n.status}`)

describe('delivery slots', () => {
  test('checkout needs a slot once slots exist, and a full slot refuses more boxes', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    // No slots yet: checkout works without one.
    const plain = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal(plain.status, 201)
    assert.equal(plain.body.slotId, null)

    const morning = await addSlot({ label: 'Morning', startsAt: '07:00', endsAt: '11:00', maxBoxes: 3, sort: 1 })
    const evening = await addSlot({ label: 'Evening', startsAt: '16:00', endsAt: '20:00', sort: 2 })
    const check = await api.get('/v1/delivery/check?pincode=560034')
    assert.deepEqual(check.body.slots.map((s) => s.label), ['Morning', 'Evening'])

    const none = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal(none.body.error.code, 'SLOT_REQUIRED')
    const ok = await checkout(api, cust.accessToken, [], { slotId: morning.id })
    assert.equal(ok.status, 201)
    assert.equal(ok.body.slotId, morning.id)

    const left = await api.get(`/v1/delivery/slots?pincode=560034&delivery_date=${ok.body.deliveryDate}`)
    assert.deepEqual(left.body.slots.map((s) => [s.label, s.remainingBoxes, s.available]), [['Morning', 2, true], ['Evening', null, true]])

    const other = await customerToken(api)
    const full = await checkout(api, other.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 3 }], { slotId: morning.id })
    assert.equal(full.body.error.code, 'SLOT_FULL')
    const evenings = await checkout(api, other.accessToken, [], { slotId: evening.id })
    assert.equal(evenings.status, 201)

    const detail = (await api.get(`/admin/v1/orders/${ok.body.orderId}`, { token: admin })).body
    assert.deepEqual(detail.slot, { id: morning.id, label: 'Morning', startsAt: '07:00', endsAt: '11:00' })
    const mine = (await api.get(`/v1/orders/${ok.body.orderId}`, { token: cust.accessToken })).body
    assert.equal(mine.slot.label, 'Morning')

    await pay(ok.body.orderId)
    await pay(evenings.body.orderId)
    const pack = (await api.get(`/admin/v1/pack-list?date=${ok.body.deliveryDate}`, { token: admin })).body
    assert.deepEqual(pack.map((o) => o.slot?.label ?? null), ['Morning', 'Evening'])
    const cov = (await api.get('/admin/v1/coverage', { token: admin })).body[0]
    assert.deepEqual(cov.slots.map((s) => [s.label, s.booked, s.maxBoxes]), [['Morning', 1, 3], ['Evening', 3, null]])
  })

  test('only managers edit slots, a slot must end after it starts, and an inactive slot is not offered', async () => {
    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    assert.equal((await api.post('/admin/v1/slots', { label: 'X', startsAt: '07:00', endsAt: '09:00' }, { token: ops })).status, 403)
    const bad = await api.post('/admin/v1/slots', { label: 'X', startsAt: '09:00', endsAt: '07:00' }, { token: admin })
    assert.equal(bad.status, 400)
    const s = await addSlot({ label: 'Noon', startsAt: '11:00', endsAt: '14:00' })
    const off = await api.patch(`/admin/v1/slots/${s.id}`, { active: false }, { token: admin })
    assert.equal(off.body.active, false)
    assert.deepEqual((await api.get('/v1/delivery/check?pincode=560034')).body.slots, [])
    assert.equal((await api.get('/admin/v1/slots', { token: admin })).body.length, 1)
  })

  test('staff can move an order to another slot, and a failed delivery keeps its slot for the retry', async () => {
    await makeBatch({ age: 4, rating: 'SEMI_RIPE', lines: { 'ALP-3': 6 } })
    const morning = await addSlot({ label: 'Morning', startsAt: '07:00', endsAt: '11:00', maxBoxes: 1 })
    const evening = await addSlot({ label: 'Evening', startsAt: '16:00', endsAt: '20:00' })
    const cust = await customerToken(api)
    const o = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'SEMI_RIPE', qty: 1 }], { slotId: evening.id })
    await pay(o.body.orderId)
    const id = o.body.orderId
    const date = o.body.deliveryDate

    const moved = await api.post(`/admin/v1/orders/${id}/reschedule`, { deliveryDate: date, slotId: morning.id }, { token: admin })
    assert.equal(moved.status, 204)
    assert.equal((await api.get(`/admin/v1/orders/${id}`, { token: admin })).body.slot.label, 'Morning')

    for (const s of ['PROCESSING']) await move(id, s)
    await api.post(`/admin/v1/orders/${id}/allocate`, undefined, { token: admin })
    for (const s of ['PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED']) assert.equal((await move(id, s)).status, 204)
    const after = (await api.get(`/admin/v1/orders/${id}`, { token: admin })).body
    assert.equal(after.slot.label, 'Morning')
  })
})

describe('WhatsApp order updates', () => {
  test('each step queues one update, sent with its template; unpaid cancels send nothing', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const slot = await addSlot({ label: 'Morning', startsAt: '07:00', endsAt: '11:30' })
    const cust = await customerToken(api)
    const o = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }], { slotId: slot.id })
    const id = o.body.orderId
    assert.deepEqual(await notes(id), [])
    await pay(id)
    await pay(id) // a replayed payment queues nothing more
    assert.deepEqual(await notes(id), ['ORDER_CONFIRMED:PENDING'])

    const sent = []
    const sender = async (m) => {
      sent.push(m)
      return `wamid.${sent.length}`
    }
    assert.equal(await sendDueNotifications({ sender }), 1)
    assert.equal(sent[0].template, 'mandi_order_confirmed')
    assert.equal(sent[0].phone, (await query('SELECT phone FROM orders WHERE id = $1', [id])).rows[0].phone)
    assert.deepEqual(sent[0].params.slice(2), ['Fri, 16 Oct', '7 AM to 11:30 AM'])
    assert.equal(await sendDueNotifications({ sender }), 0)

    await move(id, 'PROCESSING')
    await api.post(`/admin/v1/orders/${id}/allocate`, undefined, { token: admin })
    for (const s of ['PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED']) await move(id, s)
    assert.deepEqual(await notes(id), ['ORDER_CONFIRMED:SENT', 'OUT_FOR_DELIVERY:PENDING', 'DELIVERED:PENDING'])

    const unpaid = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }], { slotId: slot.id })
    await api.post(`/v1/orders/${unpaid.body.orderId}/cancel`, undefined, { token: cust.accessToken })
    assert.deepEqual(await notes(unpaid.body.orderId), [])

    const paid = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }], { slotId: slot.id })
    await pay(paid.body.orderId)
    await api.post(`/v1/orders/${paid.body.orderId}/cancel`, undefined, { token: cust.accessToken })
    assert.deepEqual((await notes(paid.body.orderId)).sort(), ['CANCELLED:PENDING', 'ORDER_CONFIRMED:PENDING', 'REFUNDED:PENDING'])
    const detail = (await api.get(`/admin/v1/orders/${paid.body.orderId}`, { token: admin })).body
    assert.equal(detail.notifications.length, 3)
  })

  test('a failed send is retried with backoff, then given up; old updates are skipped', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const cust = await customerToken(api)
    const o = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    await pay(o.body.orderId)
    const failing = async () => {
      throw new Error('WhatsApp 500: try later')
    }
    const t0 = Date.parse('2026-10-15T04:30:00Z')
    const row = async () => (await query('SELECT status, attempts, next_attempt_at FROM notifications WHERE order_id = $1', [o.body.orderId])).rows[0]
    assert.equal(await sendDueNotifications({ sender: failing }), 0)
    assert.equal((await row()).attempts, 1)
    assert.ok(Math.abs((await row()).next_attempt_at.getTime() - (t0 + 60_000)) < 5000) // the test clock keeps ticking
    assert.equal(await sendDueNotifications({ sender: failing }), 0) // not due yet
    assert.equal((await row()).attempts, 1)
    // Each retry waits 1, 5, 15, 60 and 180 minutes; step the clock just past each one.
    for (const minutes of [1, 5, 15, 60, 180]) {
      const due = (await row()).next_attempt_at.getTime()
      assert.ok(Math.abs(due - now().getTime() - minutes * 60_000) < 5000)
      setNow(new Date(due + 1000).toISOString())
      await sendDueNotifications({ sender: failing })
    }
    assert.deepEqual([(await row()).status, (await row()).attempts], ['FAILED', 6])

    const late = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    await pay(late.body.orderId)
    setNow(new Date(Date.now() + 25 * 3_600_000).toISOString())
    await sendDueNotifications({ sender: async () => 'never' })
    assert.equal((await query('SELECT status FROM notifications WHERE order_id = $1', [late.body.orderId])).rows[0].status, 'SKIPPED')
  })

  test('the Cloud API request names the template and fills its variables', async () => {
    const calls = []
    const send = metaSender({ token: 't0k', phoneNumberId: '1234', apiVersion: 'v23.0', language: 'en' }, async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.abc' }] }), { status: 200 })
    })
    assert.equal(await send({ phone: '+919876543210', template: 'mandi_delivered', params: ['Asha', 'ORD-1001'] }), 'wamid.abc')
    assert.equal(calls[0].url, 'https://graph.facebook.com/v23.0/1234/messages')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer t0k')
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      messaging_product: 'whatsapp', to: '919876543210', type: 'template',
      template: { name: 'mandi_delivered', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Asha' }, { type: 'text', text: 'ORD-1001' }] }] },
    })
    const bad = metaSender({ token: 't', phoneNumberId: '1', apiVersion: 'v23.0', language: 'en' }, async () =>
      new Response(JSON.stringify({ error: { message: 'Template name does not exist' } }), { status: 404 }),
    )
    await assert.rejects(bad({ phone: '+919876543210', template: 'x', params: [] }), /Template name does not exist/)
    assert.deepEqual(paramsFor({ kind: 'REFUNDED', customer_name: null, number: 'ORD-9', payment_amount: 189_900 }), ['there', 'ORD-9', 'Rs 1,899'])
  })
})
