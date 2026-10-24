// Customer experience fixes from the 23 Oct UX audit: prices before a pincode
// (UX-5), box contents, the hold length at Pay (UX-3), claim rejection reasons
// and claim WhatsApp messages (UX-4 / ADM-3), order links in WhatsApp (UX-7),
// staff order search by name and address (ADM-1) and the price-change audit (ADM-2).
import { closeAll, adminToken, checkout, client, customerToken, makeBatch, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { query } from '../src/db.js'
import { env } from '../src/env.js'
import { sendDueNotifications } from '../src/notify.js'
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
  env.WHATSAPP_CLAIM_UPDATES = false
  env.WHATSAPP_ORDER_LINKS = false
})

const pay = (orderId) => api.post('/v1/dev/pay', { orderId, outcome: 'captured' })
const move = (id, status) =>
  api.patch(`/admin/v1/orders/${id}/status`, status === 'DELIVERED' ? { status, override: true, reason: 'Customer confirmed by phone' } : { status }, { token: admin })

/** A paid, delivered order for a new customer, with a claim raised on it. */
async function deliveredWithClaim() {
  await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
  const cust = await customerToken(api)
  const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
  assert.equal(c.status, 201)
  await query(`UPDATE orders SET customer_name = 'Ravi Kumar' WHERE id = $1`, [c.body.orderId])
  assert.equal((await pay(c.body.orderId)).status, 200)
  const id = c.body.orderId
  assert.equal((await move(id, 'PROCESSING')).status, 204)
  assert.equal((await api.post(`/admin/v1/orders/${id}/allocate`, undefined, { token: admin })).status, 204)
  for (const s of ['PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED']) assert.equal((await move(id, s)).status, 204, s)
  const claim = await api.post('/v1/claims', { orderId: id, issueType: 'DAMAGED', description: 'Two mangoes crushed', itemSkus: ['ALP-3'] }, { token: cust.accessToken })
  assert.equal(claim.status, 201)
  assert.equal((await api.post(`/admin/v1/claims/${claim.body.id}/review`, undefined, { token: admin })).status, 204)
  return { cust, orderId: id, number: c.body.number, claimId: claim.body.id }
}

/** Sends every due message with a fake sender and returns what it was asked to send. */
async function sent() {
  const calls = []
  await query(`UPDATE notifications SET next_attempt_at = created_at WHERE status = 'PENDING'`)
  await sendDueNotifications({ sender: async (m) => (calls.push(m), `wamid.${calls.length}`) })
  return calls
}

describe('UX-5 and box contents: prices before a pincode', () => {
  test('GET /v1/products lists every box on sale with its price and no stock, without a pincode', async () => {
    const r = await api.get('/v1/products')
    assert.equal(r.status, 200)
    assert.ok(r.body.items.length >= 2)
    const alp = r.body.items.find((p) => p.sku === 'ALP-3')
    assert.equal(alp.price, 189_900)
    assert.equal(alp.fruitsPerBox, null)
    assert.equal(alp.fruitWeightG, null)
    assert.equal('qty' in alp, false, 'stock depends on the delivery day, so it is not here')
  })

  test('managers set what is in the box; the shop sees it on the products list and the catalogue', async () => {
    const r = await api.patch('/admin/v1/products/ALP-3', { fruitsPerBox: 12, fruitWeightG: 250 }, { token: admin })
    assert.equal(r.status, 200)
    assert.equal(r.body.fruitsPerBox, 12)
    assert.equal((await api.get('/v1/products')).body.items.find((p) => p.sku === 'ALP-3').fruitWeightG, 250)
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const cat = (await api.get('/v1/catalogue?pincode=560034')).body
    assert.equal(cat.items.find((i) => i.sku === 'ALP-3').fruitsPerBox, 12)
    // Cleared again with null; nonsense is refused.
    assert.equal((await api.patch('/admin/v1/products/ALP-3', { fruitsPerBox: null }, { token: admin })).body.fruitsPerBox, null)
    assert.equal((await api.patch('/admin/v1/products/ALP-3', { fruitWeightG: 5 }, { token: admin })).status, 400)
    const added = await api.post('/admin/v1/products', { sku: 'KES-3', name: 'Kesar 3kg Box', variety: 'Kesar', price: 149_900, fruitsPerBox: 14 }, { token: admin })
    assert.equal(added.status, 201)
    assert.equal(added.body.fruitsPerBox, 14)
    assert.equal(added.body.fruitWeightG, null)
  })
})

describe('UX-3: the hold length at Pay comes from the rules', () => {
  test('GET /v1/policy gives the live rules the help and terms pages quote', async () => {
    const r = await api.get('/v1/policy')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { holdMinutes: 10, cutoffTime: '18:00 IST', maxDaysAhead: 5, claimWindowHours: 24 })
  })

  test('the quote says how many minutes the boxes are held', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const cust = await customerToken(api)
    await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 1 }, { token: cust.accessToken })
    const q = await api.post('/v1/checkout/quote', { pincode: '560034' }, { token: cust.accessToken })
    assert.equal(q.status, 200)
    assert.equal(q.body.holdMinutes, 10)
  })
})

describe('UX-4 / ADM-3: claim rejections say why, and the customer hears about it', () => {
  test('a rejection needs a reason; the customer and staff see it', async () => {
    const { cust, claimId } = await deliveredWithClaim()
    const bare = await api.post(`/admin/v1/claims/${claimId}/resolve`, { resolution: 'REJECTED' }, { token: admin })
    assert.equal(bare.status, 400)
    assert.match(JSON.stringify(bare.body), /customer sees this/i)
    const short = await api.post(`/admin/v1/claims/${claimId}/resolve`, { resolution: 'REJECTED', reason: 'no' }, { token: admin })
    assert.equal(short.status, 400)
    const reason = 'The delivery photo shows both boxes sealed and undamaged.'
    assert.equal((await api.post(`/admin/v1/claims/${claimId}/resolve`, { resolution: 'REJECTED', reason }, { token: admin })).status, 204)
    const mine = (await api.get('/v1/claims', { token: cust.accessToken })).body[0]
    assert.equal(mine.resolution, 'REJECTED')
    assert.equal(mine.rejectionReason, reason)
    const staff = (await api.get('/admin/v1/claims?status=RESOLVED', { token: admin })).body[0]
    assert.equal(staff.rejectionReason, reason)
    // Without WHATSAPP_CLAIM_UPDATES (templates not approved yet) nothing is queued.
    const { rows } = await query(`SELECT kind FROM notifications WHERE kind LIKE 'CLAIM_%'`)
    assert.deepEqual(rows, [])
  })

  test('a replacement needs no reason and keeps none', async () => {
    const { cust, claimId } = await deliveredWithClaim()
    assert.equal((await api.post(`/admin/v1/claims/${claimId}/resolve`, { resolution: 'REPLACEMENT_APPROVED', reason: 'ignored' }, { token: admin })).status, 204)
    assert.equal((await api.get('/v1/claims', { token: cust.accessToken })).body[0].rejectionReason, null)
  })

  test('with WHATSAPP_CLAIM_UPDATES, "claim received" and "claim rejected" go out with the reason and an order button', async () => {
    env.WHATSAPP_CLAIM_UPDATES = true
    const { orderId, number, claimId } = await deliveredWithClaim()
    let calls = (await sent()).filter((m) => m.template.includes('claim'))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].template, 'mandi_claim_received')
    assert.deepEqual(calls[0].params, ['Ravi Kumar', number])
    assert.equal(calls[0].urlParam, orderId, 'the claim templates carry the "Open order" button')

    const reason = 'The photo shows\nthe boxes intact.'
    assert.equal((await api.post(`/admin/v1/claims/${claimId}/resolve`, { resolution: 'REJECTED', reason }, { token: admin })).status, 204)
    calls = await sent()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].template, 'mandi_claim_rejected')
    assert.deepEqual(calls[0].params, ['Ravi Kumar', number, 'The photo shows the boxes intact.'])
    assert.equal(calls[0].urlParam, orderId)
  })
})

describe('UX-7: order links in WhatsApp updates', () => {
  test('order updates carry the order button only once WHATSAPP_ORDER_LINKS is on', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const a = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    await pay(a.body.orderId)
    let confirmed = (await sent()).find((m) => m.template === 'mandi_order_confirmed')
    assert.equal(confirmed.urlParam, null, 'the approved templates have no button yet')

    env.WHATSAPP_ORDER_LINKS = true
    const b = await checkout(api, (await customerToken(api)).accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    await pay(b.body.orderId)
    confirmed = (await sent()).find((m) => m.template === 'mandi_order_confirmed')
    assert.equal(confirmed.urlParam, b.body.orderId)
  })

  test('the Cloud API request adds the URL button variable only when there is one', async () => {
    const bodies = []
    const fake = async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.1' }] }) }
    }
    const send = metaSender({ token: 't', phoneNumberId: '1', apiVersion: 'v21.0', language: 'en' }, fake)
    await send({ phone: '+919800000001', template: 'mandi_delivered', params: ['Ravi', 'ORD-1001'] })
    await send({ phone: '+919800000001', template: 'mandi_delivered', params: ['Ravi', 'ORD-1001'], urlParam: 'ord_123' })
    assert.deepEqual(bodies[0].template.components, [{ type: 'body', parameters: [{ type: 'text', text: 'Ravi' }, { type: 'text', text: 'ORD-1001' }] }])
    assert.deepEqual(bodies[1].template.components[1], { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'ord_123' }] })
  })
})

describe('ADM-1: order search by name and address', () => {
  test('a name or part of the address finds the order, as the number and phone do', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    await query(`UPDATE orders SET customer_name = 'Ravi Kumar' WHERE id = $1`, [c.body.orderId])
    const find = async (q) => (await api.get(`/admin/v1/orders?q=${encodeURIComponent(q)}`, { token: admin })).body.items.map((o) => o.id)
    assert.deepEqual(await find('ravi'), [c.body.orderId])
    assert.deepEqual(await find('Koramangala'), [c.body.orderId])
    assert.deepEqual(await find(c.body.number), [c.body.orderId])
    assert.deepEqual(await find('Indiranagar'), [])
    // LIKE wildcards are matched as plain characters.
    assert.deepEqual(await find('%'), [])
  })
})

describe('ADM-2: price changes keep the old price and a reason', () => {
  test('the staff activity row holds the value before, the reason, and is written once', async () => {
    const r = await api.patch('/admin/v1/products/ALP-3', { price: 199_900, reason: 'Mandi rate went up' }, { token: admin })
    assert.equal(r.status, 200)
    assert.equal(r.body.price, 199_900)
    const { rows } = await query(`SELECT * FROM staff_audit WHERE action = 'PATCH /products/:sku' AND target = 'ALP-3'`)
    assert.equal(rows.length, 1, 'one row, written with the change (not again after the response)')
    assert.deepEqual(rows[0].detail, { price: 199_900, reason: 'Mandi rate went up', before: { price: 189_900 } })
    assert.equal(rows[0].email, 'manager@mandimangoes.test')
    // The Staff page's activity list shows it.
    const list = (await api.get('/admin/v1/audit?target=ALP-3', { token: admin })).body
    assert.ok(JSON.stringify(list).includes('Mandi rate went up'))
    // A failed change writes nothing.
    assert.equal((await api.patch('/admin/v1/products/NOPE-1', { price: 100 }, { token: admin })).status, 404)
    assert.equal((await query(`SELECT 1 FROM staff_audit WHERE target = 'NOPE-1'`)).rowCount, 0)
  })
})
