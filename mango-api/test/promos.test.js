// Promo codes and gift orders.
import { adminToken, checkout, closeAll, client, customerToken, makeBatch, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { newId } from '../src/ids.js'

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
  await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 30 } })
})

const BOX = 189_900
const line = (qty = 1) => [{ sku: 'ALP-3', stage: 'RIPE', qty }]
const quote = async (token, promoCode, qty = 1) => {
  await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty }, { token })
  return api.post('/v1/checkout/quote', { pincode: '560034', promoCode }, { token })
}
const addPromo = (body) => api.post('/admin/v1/promos', body, { token: admin })

describe('promo codes', () => {
  test('a percentage code with a cap, once per customer, freed again by a cancel', async () => {
    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    assert.equal((await api.post('/admin/v1/promos', { code: 'X10', kind: 'PERCENT', value: 10 }, { token: ops })).status, 403)
    assert.equal((await addPromo({ code: 'big', kind: 'PERCENT', value: 95 })).status, 400)
    const made = await addPromo({ code: ' welcome10 ', kind: 'PERCENT', value: 10, maxDiscount: 25_000, minSubtotal: 100_000, description: 'First box' })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    assert.equal(made.body.code, 'WELCOME10')
    assert.equal((await addPromo({ code: 'WELCOME10', kind: 'FLAT', value: 100 })).body.error.code, 'PROMO_EXISTS')

    const cust = await customerToken(api)
    const t = cust.accessToken
    assert.equal((await quote(t, 'NOPE')).body.error.code, 'PROMO_INVALID')
    await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 2 }, { token: t })
    const q = await api.post('/v1/checkout/quote', { pincode: '560034', promoCode: 'welcome10' }, { token: t })
    assert.equal(q.status, 200, JSON.stringify(q.body))
    assert.equal(q.body.subtotal, 2 * BOX)
    assert.equal(q.body.discount, 25_000) // 10% is 37,980; capped at 25,000
    assert.equal(q.body.total, 2 * BOX - 25_000)
    assert.deepEqual(q.body.promo, { code: 'WELCOME10', description: 'First box' })

    const o = await api.post('/v1/checkout/confirm', { quoteId: q.body.quoteId, address: '12, 4th Cross, Koramangala, Bengaluru' }, { token: t, headers: { 'Idempotency-Key': newId('k') } })
    assert.equal(o.status, 201, JSON.stringify(o.body))
    assert.equal(o.body.total, 2 * BOX - 25_000)
    const mine = (await api.get(`/v1/orders/${o.body.orderId}`, { token: t })).body
    assert.deepEqual([mine.subtotal, mine.discount, mine.promoCode, mine.total], [2 * BOX, 25_000, 'WELCOME10', 2 * BOX - 25_000])

    assert.equal((await quote(t, 'WELCOME10')).body.error.code, 'PROMO_ALREADY_USED')
    assert.equal((await api.post(`/v1/orders/${o.body.orderId}/cancel`, undefined, { token: t })).status, 204)
    assert.equal((await api.post('/v1/checkout/quote', { pincode: '560034', promoCode: 'WELCOME10' }, { token: t })).status, 200)

    const list = (await api.get('/admin/v1/promos', { token: admin })).body
    assert.equal(list[0].uses, 0)
    assert.equal((await api.patch('/admin/v1/promos/welcome10', { active: false }, { token: admin })).body.active, false)
    assert.equal((await api.post('/v1/checkout/quote', { pincode: '560034', promoCode: 'WELCOME10' }, { token: t })).body.error.code, 'PROMO_INVALID')
  })

  test('minimum order, dates, and a flat code never makes an order free', async () => {
    await addPromo({ code: 'MIN', kind: 'FLAT', value: 10_000, minSubtotal: 500_000 })
    await addPromo({ code: 'OLD', kind: 'FLAT', value: 10_000, endsOn: '2026-10-01' })
    await addPromo({ code: 'SOON', kind: 'FLAT', value: 10_000, startsOn: '2026-12-01' })
    await addPromo({ code: 'HUGE', kind: 'FLAT', value: 10_000_000 })
    const t = (await customerToken(api)).accessToken
    assert.equal((await quote(t, 'MIN')).body.error.code, 'PROMO_MIN_SUBTOTAL')
    assert.equal((await api.post('/v1/checkout/quote', { pincode: '560034', promoCode: 'OLD' }, { token: t })).body.error.code, 'PROMO_EXPIRED')
    assert.equal((await api.post('/v1/checkout/quote', { pincode: '560034', promoCode: 'SOON' }, { token: t })).body.error.code, 'PROMO_NOT_STARTED')
    const huge = await api.post('/v1/checkout/quote', { pincode: '560034', promoCode: 'HUGE' }, { token: t })
    assert.equal(huge.body.total, 100)
  })

  test('a code with one use left goes to only one of two customers checking out at once', async () => {
    await addPromo({ code: 'ONLYONE', kind: 'FLAT', value: 10_000, maxUses: 1 })
    const [a, b] = [await customerToken(api), await customerToken(api)]
    const qa = await quote(a.accessToken, 'ONLYONE')
    const qb = await quote(b.accessToken, 'ONLYONE')
    const confirm = (cust, q) =>
      api.post('/v1/checkout/confirm', { quoteId: q.body.quoteId, address: '12, 4th Cross, Koramangala, Bengaluru' }, { token: cust.accessToken, headers: { 'Idempotency-Key': newId('k') } })
    const results = await Promise.all([confirm(a, qa), confirm(b, qb)])
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 400])
    assert.equal(results.find((r) => r.status === 400).body.error.code, 'PROMO_USED_UP')
  })

  test('first-order-only codes', async () => {
    await addPromo({ code: 'FIRST', kind: 'PERCENT', value: 5, firstOrderOnly: true })
    const cust = await customerToken(api)
    assert.equal((await checkout(api, cust.accessToken, line())).status, 201)
    assert.equal((await quote(cust.accessToken, 'FIRST')).body.error.code, 'PROMO_FIRST_ORDER')
  })
})

describe('gift orders', () => {
  test('the rider sees the recipient; the packer sees the note; the buyer still gets the updates', async () => {
    const cust = await customerToken(api)
    const t = cust.accessToken
    await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 1 }, { token: t })
    const q = await api.post('/v1/checkout/quote', { pincode: '560034' }, { token: t })
    const gift = { recipientName: 'Meera Iyer', recipientPhone: '98450 12345', message: 'Happy birthday, Amma!' }
    const bad = await api.post('/v1/checkout/confirm', { quoteId: q.body.quoteId, address: '12, 4th Cross, Koramangala, Bengaluru', gift: { ...gift, recipientPhone: '123' } }, { token: t, headers: { 'Idempotency-Key': newId('k') } })
    assert.equal(bad.status, 400)
    const o = await api.post('/v1/checkout/confirm', { quoteId: q.body.quoteId, address: '12, 4th Cross, Koramangala, Bengaluru', name: 'Ravi', gift }, { token: t, headers: { 'Idempotency-Key': newId('k') } })
    assert.equal(o.status, 201, JSON.stringify(o.body))
    await api.post('/v1/dev/pay', { orderId: o.body.orderId, outcome: 'captured' })

    assert.deepEqual((await api.get(`/v1/orders/${o.body.orderId}`, { token: t })).body.gift, { recipientName: 'Meera Iyer', recipientPhone: '+919845012345', message: 'Happy birthday, Amma!' })
    const pack = (await api.get(`/admin/v1/pack-list?date=${o.body.deliveryDate}`, { token: admin })).body
    assert.equal(pack[0].gift.message, 'Happy birthday, Amma!')
    const stop = (await api.get(`/admin/v1/manifest?date=${o.body.deliveryDate}`, { token: admin })).body.runs[0].stops[0].orders[0]
    assert.deepEqual([stop.customerName, stop.phone, stop.gift], ['Meera Iyer', '+919845012345', { from: 'Ravi', message: 'Happy birthday, Amma!' }])
  })
})
