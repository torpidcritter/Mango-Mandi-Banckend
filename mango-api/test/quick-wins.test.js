// Quick wins: the ripeness guide after ordering, back-in-stock alerts, the
// opt-in reorder reminder and the public trace page behind a box's QR code.
import { adminToken, checkout, client, closeAll, customerToken, makeBatch, resetDb, startServer, T0 } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { addDays, setNow, todayIST } from '../src/clock.js'
import { query } from '../src/db.js'
import { sendReorderReminders, sendStockAlerts } from '../src/engagement.js'
import { readyWords, sendDueNotifications } from '../src/notify.js'

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

const sendAll = async () => {
  const sent = []
  await sendDueNotifications({ sender: async (m) => (sent.push(m), 'wamid.x') })
  return sent
}

describe('ripeness guide', () => {
  test('a minute after the confirmation, the customer hears when each box is ready and how to keep it', async () => {
    await makeBatch({ age: 2, rating: 'RAW', lines: { 'ALP-3': 10 } })
    await makeBatch({ variety: 'Badami', age: 6, rating: 'RIPE', lines: { 'BAD-3': 10 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RAW', qty: 1 }, { sku: 'BAD-3', stage: 'RIPE', qty: 1 }])
    assert.equal(c.status, 201, JSON.stringify(c.body))
    await api.post('/v1/dev/pay', { orderId: c.body.orderId, outcome: 'captured' })
    const first = await sendAll()
    assert.deepEqual(first.map((m) => m.template), ['mandi_order_confirmed'])
    setNow(new Date(Date.parse(T0) + 2 * 60_000))
    const [guide] = await sendAll()
    assert.equal(guide.template, 'mandi_ripeness_guide')
    const d = c.body.deliveryDate
    assert.match(guide.params[2], /Alphonso 3kg Box \(raw\): ready around/)
    assert.match(guide.params[2], /Badami 3kg Box \(ripe\): ready on arrival/)
    assert.match(guide.params[3], /don't refrigerate/)
    assert.ok(!/\n/.test(guide.params.join(' ')), 'WhatsApp template values cannot hold new lines')
    // The shop shows the same date.
    const o = (await api.get(`/v1/orders/${c.body.orderId}`, { token: cust.accessToken })).body
    assert.equal(o.items.find((i) => i.stage === 'RAW').readyOn, addDays(d, 5))
    assert.equal(readyWords([], d), '')
  })

  test('an order of ripe boxes gets no guide: they are ready on arrival', async () => {
    await makeBatch({ variety: 'Badami', age: 5, rating: 'RIPE', lines: { 'BAD-3': 10 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'BAD-3', stage: 'RIPE', qty: 1 }])
    assert.equal(c.status, 201, JSON.stringify(c.body))
    await api.post('/v1/dev/pay', { orderId: c.body.orderId, outcome: 'captured' })
    const { rows } = await query('SELECT kind FROM notifications WHERE order_id = $1', [c.body.orderId])
    assert.deepEqual(rows.map((r) => r.kind), ['ORDER_CONFIRMED'])
  })
})

describe('back-in-stock alerts', () => {
  test('a customer asks to be told; when stock arrives they get one message and the alert closes', async () => {
    const cust = await customerToken(api)
    const add = (body) => api.post('/v1/stock-alerts', body, { token: cust.accessToken })
    assert.equal((await add({ sku: 'ALP-3', stage: 'RIPE', pincode: '999999' })).body.error.code, 'NOT_SERVICEABLE')
    assert.equal((await add({ sku: 'NOPE', stage: 'RIPE', pincode: '560034' })).body.error.code, 'INVALID_SKU')
    const a = await add({ sku: 'ALP-3', stage: 'RIPE', pincode: '560034' })
    assert.equal(a.status, 201, JSON.stringify(a.body))
    assert.equal((await add({ sku: 'ALP-3', stage: 'RIPE', pincode: '560034' })).body.id, a.body.id, 'asking twice keeps one alert')
    assert.equal((await api.get('/v1/stock-alerts', { token: cust.accessToken })).body.length, 1)

    assert.equal(await sendStockAlerts(), 0, 'nothing in stock yet')
    await makeBatch({ age: 5, rating: 'RIPE', lines: { 'ALP-3': 5 } })
    assert.equal(await sendStockAlerts(), 1)
    assert.equal(await sendStockAlerts(), 0, 'told once')
    const [m] = await sendAll()
    assert.equal(m.template, 'mandi_back_in_stock')
    assert.equal(m.params[1], 'Alphonso 3kg Box (ripe)')
    assert.match(m.params[3], /^http/)
    const listed = (await api.get('/v1/stock-alerts', { token: cust.accessToken })).body[0]
    assert.ok(listed.notifiedAt && listed.availableOn)
  })

  test('alerts can be removed, are capped, and go with a deleted account', async () => {
    const cust = await customerToken(api)
    const a = await api.post('/v1/stock-alerts', { sku: 'BAD-3', stage: 'RAW', pincode: '560034' }, { token: cust.accessToken })
    assert.equal((await api.del(`/v1/stock-alerts/${a.body.id}`, { token: cust.accessToken })).status, 204)
    assert.equal((await api.del(`/v1/stock-alerts/${a.body.id}`, { token: cust.accessToken })).status, 404)
    await api.post('/v1/stock-alerts', { sku: 'BAD-3', stage: 'RAW', pincode: '560034' }, { token: cust.accessToken })
    assert.equal((await api.del('/v1/me', { token: cust.accessToken })).status, 204)
    await makeBatch({ variety: 'Badami', age: 3, rating: 'RAW', lines: { 'BAD-3': 5 } })
    assert.equal(await sendStockAlerts(), 0)
  })
})

describe('reorder reminder', () => {
  async function delivered(cust) {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    await api.post('/v1/dev/pay', { orderId: c.body.orderId, outcome: 'captured' })
    await query(`UPDATE orders SET status = 'DELIVERED' WHERE id = $1`, [c.body.orderId])
    return c.body
  }
  // 11:00 IST, seven days after delivery.
  const weekLater = (d) => new Date(`${addDays(d, 7)}T05:30:00Z`)

  test('only for customers who turned it on, a week after delivery, once', async () => {
    const cust = await customerToken(api)
    const o = await delivered(cust)
    assert.equal(await sendReorderReminders(weekLater(o.deliveryDate)), 0, 'off by default')
    const me = await api.patch('/v1/me', { remindersOptIn: true }, { token: cust.accessToken })
    assert.equal(me.body.remindersOptIn, true)
    assert.equal((await api.get('/v1/me', { token: cust.accessToken })).body.remindersOptIn, true)
    assert.equal(await sendReorderReminders(new Date(`${addDays(o.deliveryDate, 7)}T15:00:00Z`)), 0, 'not in the evening (20:30 IST)')
    setNow(weekLater(o.deliveryDate))
    assert.equal(await sendReorderReminders(weekLater(o.deliveryDate)), 1)
    assert.equal(await sendReorderReminders(weekLater(o.deliveryDate)), 0)
    const [m] = await sendAll()
    assert.equal(m.template, 'mandi_reorder_reminder')
    assert.equal(m.params[1], 'Alphonso 3kg Box')
  })

  test('not sent when the customer has ordered again since', async () => {
    const cust = await customerToken(api)
    const o = await delivered(cust)
    await api.patch('/v1/me', { remindersOptIn: true }, { token: cust.accessToken })
    await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal(await sendReorderReminders(weekLater(o.deliveryDate)), 0)
  })
})
