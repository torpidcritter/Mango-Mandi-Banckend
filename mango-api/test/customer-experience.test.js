// Shop improvements: product descriptions and "back on" dates in the
// catalogue, saved addresses, customers moving their own delivery day, and
// ratings after delivery.
import { adminToken, checkout, client, closeAll, customerToken, makeBatch, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { query } from '../src/db.js'

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
const confirmWith = async (token, address, { gift } = {}) => {
  // One unpaid order at a time (INV-02): cancel the last one first, as a customer would.
  for (const o of (await api.get('/v1/orders', { token })).body) {
    if (o.status === 'PAYMENT_PENDING') assert.equal((await api.post(`/v1/orders/${o.id}/cancel`, undefined, { token })).status, 204)
  }
  await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 1 }, { token })
  const q = await api.post('/v1/checkout/quote', { pincode: '560034' }, { token })
  assert.equal(q.status, 200, JSON.stringify(q.body))
  const c = await api.post('/v1/checkout/confirm', { quoteId: q.body.quoteId, address, name: 'Asha', gift }, { token, headers: { 'Idempotency-Key': `k-${Math.random()}` } })
  assert.equal(c.status, 201, JSON.stringify(c.body))
  return c.body
}

describe('catalogue', () => {
  test('each product has its description, and a sold-out choice says the next day it is back', async () => {
    await makeBatch({ age: 6, rating: 'RIPE', lines: { 'ALP-3': 5 } })
    // Fruit still on the truck: sells only after it arrives, as raw a few days on.
    await makeBatch({ age: 0, status: 'IN_TRANSIT', rating: null, lines: { 'ALP-3': 20 } })
    const cat = await api.get('/v1/catalogue?pincode=560034')
    assert.equal(cat.status, 200)
    const raw = cat.body.items.find((i) => i.sku === 'ALP-3' && i.stage === 'RAW')
    assert.match(raw.description, /Alphonso/)
    assert.equal(raw.qty, 0)
    assert.ok(raw.nextAvailableDate > cat.body.deliveryDate, JSON.stringify(raw))
    const later = await api.get(`/v1/catalogue?pincode=560034&delivery_date=${raw.nextAvailableDate}`)
    assert.ok(later.body.items.find((i) => i.sku === 'ALP-3' && i.stage === 'RAW').qty > 0)
    const ripe = cat.body.items.find((i) => i.sku === 'ALP-3' && i.stage === 'RIPE')
    assert.ok(ripe.qty > 0)
    assert.equal(ripe.nextAvailableDate, null)
    // Nothing anywhere: no date to promise.
    assert.equal(cat.body.items.find((i) => i.sku === 'BAD-5' && i.stage === 'RIPE').nextAvailableDate, null)
  })
})

describe('saved addresses', () => {
  test('an order saves its address once; the same address with other spacing is not repeated; at most five', async () => {
    await makeBatch({ age: 6, rating: 'RIPE', lines: { 'ALP-3': 20 } })
    const cust = await customerToken(api)
    await confirmWith(cust.accessToken, '12, 4th Cross, Koramangala, Bengaluru')
    await confirmWith(cust.accessToken, '12,  4th cross, Koramangala,   Bengaluru')
    let list = await api.get('/v1/me/addresses', { token: cust.accessToken })
    assert.equal(list.status, 200)
    assert.equal(list.body.length, 1)
    assert.equal(list.body[0].pincode, '560034')
    assert.equal(list.body[0].name, 'Asha')

    for (let i = 1; i <= 5; i++) await confirmWith(cust.accessToken, `Flat ${i}, Rose Apartments, HSR Layout`)
    list = await api.get('/v1/me/addresses', { token: cust.accessToken })
    assert.equal(list.body.length, 5)
    assert.equal(list.body[0].address, 'Flat 5, Rose Apartments, HSR Layout')
    assert.ok(!list.body.some((a) => a.address.includes('Koramangala')), 'the oldest one drops off')

    const other = await customerToken(api)
    assert.equal((await api.del(`/v1/me/addresses/${list.body[0].id}`, { token: other.accessToken })).status, 404)
    assert.equal((await api.del(`/v1/me/addresses/${list.body[0].id}`, { token: cust.accessToken })).status, 204)
    assert.equal((await api.get('/v1/me/addresses', { token: cust.accessToken })).body.length, 4)
  })

  test("a gift's address (someone else's) is not saved, and deleting the account removes the list", async () => {
    await makeBatch({ age: 6, rating: 'RIPE', lines: { 'ALP-3': 20 } })
    const cust = await customerToken(api)
    const gift = await confirmWith(cust.accessToken, '7, Lake View Road, Indiranagar', { gift: { recipientName: 'Meera', recipientPhone: '9876543210' } })
    assert.equal((await api.get('/v1/me/addresses', { token: cust.accessToken })).body.length, 0)
    const own = await confirmWith(cust.accessToken, '12, 4th Cross, Koramangala, Bengaluru')
    assert.equal((await api.get('/v1/me/addresses', { token: cust.accessToken })).body.length, 1)
    // Unpaid, so cancelling closes it with nothing to refund (the gift order was cancelled to place this one).
    assert.equal((await api.get(`/v1/orders/${gift.orderId}`, { token: cust.accessToken })).body.status, 'CANCELLED')
    for (const o of [own]) assert.equal((await api.post(`/v1/orders/${o.orderId}/cancel`, undefined, { token: cust.accessToken })).status, 204)
    assert.equal((await api.del('/v1/me', { token: cust.accessToken })).status, 204)
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM customer_addresses')).rows[0].n, 0)
  })
})

describe('changing the delivery day', () => {
  test('a confirmed order moves to another open day with stock; not once packing starts, and not anyone else’s', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal(c.status, 201, JSON.stringify(c.body))
    await pay(c.body.orderId)
    const dates = (await api.get('/v1/delivery/check?pincode=560034')).body.deliveryDates
    const from = c.body.deliveryDate
    const to = dates.find((d) => d > from)

    const stranger = await customerToken(api)
    assert.equal((await api.post(`/v1/orders/${c.body.orderId}/reschedule`, { deliveryDate: to }, { token: stranger.accessToken })).status, 404)
    assert.equal((await api.post(`/v1/orders/${c.body.orderId}/reschedule`, { deliveryDate: '2026-12-25' }, { token: cust.accessToken })).body.error.code, 'INVALID_DATE')

    const moved = await api.post(`/v1/orders/${c.body.orderId}/reschedule`, { deliveryDate: to }, { token: cust.accessToken })
    assert.equal(moved.status, 204, JSON.stringify(moved.body))
    const seen = (await api.get(`/v1/orders/${c.body.orderId}`, { token: cust.accessToken })).body
    assert.equal(seen.deliveryDate, to)
    assert.equal(seen.status, 'CONFIRMED')
    const { rows } = await query(`SELECT COALESCE(SUM(quantity), 0)::int AS n FROM order_stock WHERE order_id = $1 AND state = 'committed'`, [c.body.orderId])
    assert.equal(rows[0].n, 1, 'the box is still taken, for the new day')

    await api.patch(`/admin/v1/orders/${c.body.orderId}/status`, { status: 'PROCESSING' }, { token: admin })
    const late = await api.post(`/v1/orders/${c.body.orderId}/reschedule`, { deliveryDate: from }, { token: cust.accessToken })
    assert.equal(late.body.error.code, 'INVALID_TRANSITION')
  })

  test('a day without enough stock is refused and the order stays as it was', async () => {
    await makeBatch({ age: 6, rating: 'RIPE', lines: { 'ALP-3': 3 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    await pay(c.body.orderId)
    const dates = (await api.get('/v1/delivery/check?pincode=560034')).body.deliveryDates
    // Ripe today, too old to sell a few days on.
    const far = dates.at(-1)
    const r = await api.post(`/v1/orders/${c.body.orderId}/reschedule`, { deliveryDate: far }, { token: cust.accessToken })
    assert.equal(r.body.error.code, 'STOCK_INSUFFICIENT')
    assert.equal((await api.get(`/v1/orders/${c.body.orderId}`, { token: cust.accessToken })).body.deliveryDate, c.body.deliveryDate)
  })
})

describe('ratings', () => {
  test('a delivered order can be rated and re-rated; staff see it, and analytics averages it and lists the unhappy ones', async () => {
    await makeBatch({ age: 6, rating: 'RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const a = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    await pay(a.body.orderId)
    const put = (id, body) => api.put(`/v1/orders/${id}/rating`, body, { token: cust.accessToken })
    assert.equal((await put(a.body.orderId, { stars: 5 })).body.error.code, 'NOT_DELIVERED')

    const b = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }], { key: 'second' })
    await pay(b.body.orderId)
    await query(`UPDATE orders SET status = 'DELIVERED' WHERE id IN ($1, $2)`, [a.body.orderId, b.body.orderId])
    assert.equal((await put(a.body.orderId, { stars: 6 })).status, 400)
    assert.equal((await put(a.body.orderId, { stars: 5, comment: 'Perfectly ripe' })).status, 204)
    assert.equal((await put(b.body.orderId, { stars: 3 })).status, 204)
    assert.equal((await put(b.body.orderId, { stars: 1, comment: 'Two were bruised' })).status, 204)

    const mine = (await api.get(`/v1/orders/${b.body.orderId}`, { token: cust.accessToken })).body
    assert.deepEqual([mine.rating.stars, mine.rating.comment], [1, 'Two were bruised'])
    const staff = (await api.get(`/admin/v1/orders/${b.body.orderId}`, { token: admin })).body
    assert.equal(staff.rating.stars, 1)

    const day = a.body.deliveryDate
    const stats = (await api.get(`/admin/v1/analytics?from=${day}&to=${day}`, { token: admin })).body
    assert.equal(stats.totals.ratings, 2)
    assert.equal(stats.totals.averageRating, 3)
    assert.deepEqual(stats.lowRatings.map((r) => [r.number, r.stars, r.comment]), [[b.body.number, 1, 'Two were bruised']])
  })
})
