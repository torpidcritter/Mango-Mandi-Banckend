// Every route in STEP_UP_ROUTES (admin/step-up.js) asks the manager to confirm it is
// them: without `confirmCode` it answers 403 REAUTH_REQUIRED and changes nothing; with
// the password it goes through. Money and pricing routes ask even with STAFF_STEP_UP
// off; the staff routes ask with it on (the default in production). Each route has a
// scenario below, and a route added to the list without one fails here.
import { adminToken, checkout, client, closeAll, customerToken, makeBatch, resetDb, startServer, T0 } from './helpers.js'
import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { router as adminRouter } from '../src/admin.js'
import { STEP_UP_ROUTES } from '../src/admin/step-up.js'
import { drainBackground } from '../src/background.js'
import { addDays, setNow, todayIST } from '../src/clock.js'
import { query } from '../src/db.js'
import { env } from '../src/env.js'
import { forgetSwitches } from '../src/feature-switches.js'
import { newId } from '../src/ids.js'

let srv
let api
let manager
const CONFIRM = 'manager123'
const FLAGS = ['STAFF_STEP_UP', 'PURCHASE_RECORDS', 'PANEL_FEATURE_SWITCHES', 'FAVOURITES', 'FARM_EXPERIENCE']
const saved = Object.fromEntries(FLAGS.map((k) => [k, env[k]]))

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
  env.STAFF_STEP_UP = false
})
afterEach(async () => {
  await drainBackground()
  for (const k of FLAGS) env[k] = saved[k]
  forgetSwitches()
})

const one = async (sql, params) => (await query(sql, params)).rows[0]
const staffId = async (email) => (await one('SELECT id FROM admin_users WHERE email = $1', [email])).id

async function paidOrder() {
  await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
  const cust = await customerToken(api)
  const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
  assert.equal(c.status, 201, JSON.stringify(c.body))
  assert.equal((await api.post('/v1/dev/pay', { orderId: c.body.orderId, outcome: 'captured' })).body.result, 'confirmed')
  return c.body.orderId
}

async function paidBooking() {
  let week = addDays(todayIST(), 6)
  while (new Date(`${week}T00:00:00Z`).getUTCDay() !== 1) week = addDays(week, 1)
  assert.ok((await api.put(`/admin/v1/preorder-capacity/${week}/ALP-3`, { capacity: 10 }, { token: manager })).status < 300)
  const cust = await customerToken(api)
  const b = await api.post(
    '/v1/preorders',
    { sku: 'ALP-3', stage: 'RIPE', qty: 2, weekStart: week, pincode: '560034', address: '12, 4th Cross, Koramangala, Bengaluru' },
    { token: cust.accessToken, headers: { 'Idempotency-Key': newId('idem') } },
  )
  assert.equal(b.status, 201, JSON.stringify(b.body))
  assert.equal((await api.post('/v1/dev/pay-preorder', { preorderId: b.body.id, outcome: 'captured' })).body.result, 'booked')
  return b.body.id
}

async function batchWithPurchase() {
  env.PURCHASE_RECORDS = true
  const farm = await api.post('/admin/v1/farms', { name: 'Ratnagiri Orchards', place: 'Ratnagiri' }, { token: manager })
  assert.equal(farm.status, 201, JSON.stringify(farm.body))
  const b = await api.post('/admin/v1/batches', { variety: 'Alphonso', pluckedOn: addDays(todayIST(), -1), lines: [{ sku: 'ALP-3', onHand: 20 }] }, { token: manager })
  assert.equal(b.status, 201, JSON.stringify(b.body))
  const body = { farmId: farm.body.id, purchasedOn: addDays(todayIST(), -1), crates: 4, boxes: 10, costPerCrate: 500_000, transportCost: 0, otherCost: 0 }
  return { batchId: b.body.id, body }
}

/** Farm Experience (docs/farm-experience.md): a farm ready for bookings, and bookings billed or paid on it. */
async function farmReady() {
  env.FARM_EXPERIENCE = true
  const as = { token: manager }
  const day = addDays(todayIST(), 10)
  const v = await api.post('/admin/v1/farm/varieties', { name: 'Alphonso', pricePerKg: 12_000, confirmCode: CONFIRM }, as)
  assert.equal(v.status, 201, JSON.stringify(v.body))
  assert.equal((await api.put(`/admin/v1/farm/days/${day}`, { open: true }, as)).status, 200)
  assert.equal((await api.put(`/admin/v1/farm/harvest/${v.body.id}/${day}`, { estimatedKg: 1000, bookableKg: 1000 }, as)).status, 200)
  assert.equal((await api.post('/admin/v1/farm/rooms', { name: 'Room 1', sleeps: 4 }, as)).status, 201)
  const settings = {
    farmName: 'Test orchard', location: 'Test place', contactPhone: '+919800000000', arrivalInstructions: 'At the gate.', checkInTime: '10:00', checkOutTime: '11:00',
    sleepingArrangements: 'Rooms', bathroomFacilities: 'Attached', meals: { breakfast: true, lunch: true, dinner: true, refreshments: false }, transportPolicy: 'Not included.',
    weatherPolicy: 'Moved in heavy rain.', seasonStart: todayIST(), seasonEnd: addDays(todayIST(), 60), faqs: [{ q: 'Minimum?', a: '250 kg.' }], bookingsOpen: true,
  }
  const cur = await api.get('/admin/v1/farm/settings', as)
  assert.equal((await api.put('/admin/v1/farm/settings', { settings, version: cur.body.version, confirmCode: CONFIRM }, as)).status, 200)
  return { varietyId: v.body.id, day }
}
/** A booking weighed and billed (customers pay after picking): its bill is due. */
async function billedFarmBooking() {
  const { varietyId, day } = await farmReady()
  const cust = await customerToken(api)
  const body = { varietyId, kg: 300, visitDate: day, adults: 2, children: 0, overnightGuests: 0, contactName: 'Asha', acceptPolicies: true }
  const b = await api.post('/v1/farm-bookings', body, { token: cust.accessToken, headers: { 'Idempotency-Key': newId('k') } })
  assert.equal(b.status, 201, JSON.stringify(b.body))
  await query(`UPDATE farm_bookings SET status = 'WEIGHING', harvested_kg = 300, accepted_kg = 300 WHERE id = $1`, [b.body.bookingId])
  const bill = await api.post(`/admin/v1/farm/bookings/${b.body.bookingId}/bill`, {}, { token: manager })
  assert.equal(bill.status, 200, JSON.stringify(bill.body))
  return b.body.bookingId
}
async function paidFarmBooking() {
  const id = await billedFarmBooking()
  assert.equal((await api.post('/v1/dev/pay-farm', { bookingId: id, outcome: 'captured' })).body.result, 'paid')
  return id
}

const BULK = {
  sku: 'ALP-3', title: 'Alphonso for offices', description: 'Hand-picked Ratnagiri Alphonso in 3 kg boxes, for offices and events.',
  origin: 'Ratnagiri, Maharashtra', stages: ['RIPE'], minQty: 10, qtyStep: 1, maxQty: null, tiers: [{ minQty: 10, unitPrice: 159_900 }],
}

/**
 * Per route: the request that asks, the status it answers once confirmed, and (where it
 * says something) a check that nothing changed while it was waiting for the confirmation.
 */
const SCENARIOS = {
  'POST /orders/:id/cancel': async () => {
    const id = await paidOrder()
    return { path: `/orders/${id}/cancel`, body: { reason: 'van broke down', refund: true }, ok: 204, unchanged: async () => (await one('SELECT status FROM orders WHERE id = $1', [id])).status === 'CONFIRMED' }
  },
  'POST /preorders/:id/cancel': async () => {
    const id = await paidBooking()
    return { path: `/preorders/${id}/cancel`, body: { reason: 'Hail damaged the crop' }, ok: 200, unchanged: async () => (await one('SELECT status FROM preorders WHERE id = $1', [id])).status === 'BOOKED' }
  },
  'POST /webhook-failures/:id/refund': async () => {
    const id = newId('whf')
    await query(`INSERT INTO webhook_failures (id, source, reason, payment_id, created_at) VALUES ($1, 'razorpay', 'payment.captured matches no order', 'pay_STEPUP1', $2)`, [id, new Date(T0)])
    return { path: `/webhook-failures/${id}/refund`, body: { reason: 'checked in Razorpay: bought nothing' }, ok: 200, unchanged: async () => !(await one(`SELECT 1 AS x FROM duplicate_payments WHERE payment_id = 'pay_STEPUP1'`)) }
  },
  'POST /refunds/:id/paid-another-way': async () => {
    await query(`INSERT INTO duplicate_payments (payment_id, amount, found_at, last_error) VALUES ('pay_STEPUP2', 50000, $1, 'refund not allowed')`, [new Date(Date.parse(T0) - 3_600_000)])
    return { path: '/refunds/pay_STEPUP2/paid-another-way', body: { type: 'payment', reference: 'UPI 998877', reason: 'paid back by UPI' }, ok: 200, unchanged: async () => !(await one(`SELECT refunded_at FROM duplicate_payments WHERE payment_id = 'pay_STEPUP2'`)).refunded_at }
  },
  'POST /staff/sign-out-all': async () => {
    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    return { path: '/staff/sign-out-all', body: { reason: 'laptop stolen' }, ok: 200, unchanged: async () => (await api.get('/admin/v1/auth/me', { token: ops })).status === 200 }
  },
  'POST /products': async () => ({
    path: '/products', body: { sku: 'KES-3', name: 'Kesar 3kg Box', variety: 'Kesar', price: 159_900 }, ok: 201,
    unchanged: async () => !(await one(`SELECT 1 AS x FROM products WHERE sku = 'KES-3'`)),
  }),
  'PATCH /products/:sku': async () => ({
    path: '/products/ALP-3', method: 'PATCH', body: { price: 199_900, reason: 'Mandi rate went up' }, ok: 200,
    unchanged: async () => (await one(`SELECT price FROM products WHERE sku = 'ALP-3'`)).price !== 199_900,
  }),
  'DELETE /products/:sku': async () => ({ path: '/products/BAD-5', method: 'DELETE', body: {}, ok: 200, unchanged: async () => Boolean(await one(`SELECT 1 AS x FROM products WHERE sku = 'BAD-5'`)) }),
  'POST /promos': async () => ({
    path: '/promos', body: { code: 'STEPUP10', kind: 'PERCENT', value: 10 }, ok: 201, unchanged: async () => !(await one(`SELECT 1 AS x FROM promo_codes WHERE code = 'STEPUP10'`)),
  }),
  'PATCH /promos/:code': async () => {
    assert.equal((await api.post('/admin/v1/promos', { code: 'STEPUP20', kind: 'PERCENT', value: 20, confirmCode: CONFIRM }, { token: manager })).status, 201)
    return { path: '/promos/STEPUP20', method: 'PATCH', body: { maxUses: 5 }, ok: 200, unchanged: async () => (await one(`SELECT max_uses FROM promo_codes WHERE code = 'STEPUP20'`)).max_uses === null }
  },
  'POST /bulk-listings': async () => ({ path: '/bulk-listings', body: BULK, ok: 201, unchanged: async () => !(await one('SELECT 1 AS x FROM bulk_listings')) }),
  'PATCH /bulk-listings/:id': async () => {
    const made = await api.post('/admin/v1/bulk-listings', { ...BULK, confirmCode: CONFIRM }, { token: manager })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    return {
      path: `/bulk-listings/${made.body.id}`, method: 'PATCH', body: { tiers: [{ minQty: 10, unitPrice: 149_900 }] }, ok: 200,
      unchanged: async () => (await one('SELECT version FROM bulk_listings WHERE id = $1', [made.body.id])).version === 1,
    }
  },
  'PUT /config': async () => {
    const cfg = (await api.get('/admin/v1/config', { token: manager })).body
    return { path: '/config', method: 'PUT', body: { rules: { ...cfg.rules, cutoffHourIST: 17 } }, ok: 200, unchanged: async () => (await api.get('/admin/v1/config', { token: manager })).body.version === cfg.version }
  },
  'POST /batches/:id/purchases': async () => {
    const { batchId, body } = await batchWithPurchase()
    return { path: `/batches/${batchId}/purchases`, body, ok: 201, unchanged: async () => !(await one('SELECT 1 AS x FROM batch_purchases')) }
  },
  'PATCH /batches/:id/purchases/:purchaseId': async () => {
    const { batchId, body } = await batchWithPurchase()
    const made = await api.post(`/admin/v1/batches/${batchId}/purchases`, { ...body, confirmCode: CONFIRM }, { token: manager })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    return {
      path: `/batches/${batchId}/purchases/${made.body.id}`, method: 'PATCH', body: { costPerCrate: 450_000 }, ok: 200,
      unchanged: async () => (await one('SELECT cost_per_crate FROM batch_purchases WHERE id = $1', [made.body.id])).cost_per_crate === 500_000,
    }
  },
  'PUT /settings/switches/:key': async () => {
    env.PANEL_FEATURE_SWITCHES = true
    env.FAVOURITES = false
    return { path: '/settings/switches/FAVOURITES', method: 'PUT', body: { enabled: true }, ok: 200, unchanged: async () => !(await one('SELECT 1 AS x FROM feature_switches')) }
  },
  'PUT /whatsapp/automations/:kind': async () => ({
    path: '/whatsapp/automations/REVIEW_REQUEST', method: 'PUT', body: { enabled: false }, ok: 200,
    unchanged: async () => !(await one(`SELECT 1 AS x FROM wa_automations WHERE kind = 'REVIEW_REQUEST' AND NOT enabled`)),
  }),
  'POST /staff': async () => ({
    path: '/staff', body: { email: 'meena@mandimangoes.test', role: 'PACKER', password: 'long-enough-pass-1' }, ok: 201,
    unchanged: async () => !(await one(`SELECT 1 AS x FROM admin_users WHERE email = 'meena@mandimangoes.test'`)),
  }),
  'PATCH /staff/:id': async () => {
    const id = await staffId('ops@mandimangoes.test')
    return { path: `/staff/${id}`, method: 'PATCH', body: { role: 'PACKER' }, ok: 200, unchanged: async () => (await one('SELECT role FROM admin_users WHERE id = $1', [id])).role === 'OPERATOR' }
  },
  'POST /staff/:id/two-step/reset': async () => ({ path: `/staff/${await staffId('ops@mandimangoes.test')}/two-step/reset`, body: {}, ok: 200 }),
  'POST /staff/:id/two-step/setup-code': async () => ({ path: `/staff/${await staffId('ops@mandimangoes.test')}/two-step/setup-code`, body: {}, ok: 200 }),
  'DELETE /staff/:id': async () => {
    const id = await staffId('packer@mandimangoes.test')
    return { path: `/staff/${id}`, method: 'DELETE', body: {}, ok: 204, unchanged: async () => Boolean(await one('SELECT 1 AS x FROM admin_users WHERE id = $1', [id])) }
  },
  'POST /farm/varieties': async () => {
    env.FARM_EXPERIENCE = true
    return { path: '/farm/varieties', body: { name: 'Kesar', pricePerKg: 9_000 }, ok: 201, unchanged: async () => !(await one(`SELECT 1 AS x FROM farm_varieties WHERE name = 'Kesar'`)) }
  },
  'PATCH /farm/varieties/:id': async () => {
    const { varietyId } = await farmReady()
    return {
      path: `/farm/varieties/${varietyId}`, method: 'PATCH', body: { pricePerKg: 13_000, version: 1 }, ok: 200,
      unchanged: async () => (await one('SELECT price_per_kg FROM farm_varieties WHERE id = $1', [varietyId])).price_per_kg === 12_000,
    }
  },
  'PUT /farm/settings': async () => {
    env.FARM_EXPERIENCE = true
    const cur = (await api.get('/admin/v1/farm/settings', { token: manager })).body
    return { path: '/farm/settings', method: 'PUT', body: { settings: { farmName: 'Ratnagiri orchard' }, version: cur.version }, ok: 200, unchanged: async () => (await one('SELECT version FROM farm_settings WHERE id = 1')).version === cur.version }
  },
  'POST /farm/bookings/:id/record-payment': async () => {
    const id = await billedFarmBooking()
    // The group arrived today (the helper skips the visit), so today's payment date is allowed.
    const { bill_amount: amount } = await one('UPDATE farm_bookings SET arrival_date = $2 WHERE id = $1 RETURNING bill_amount', [id, todayIST()])
    return { path: `/farm/bookings/${id}/record-payment`, body: { method: 'CASH', reference: 'Receipt 12', amount }, ok: 200, unchanged: async () => (await one('SELECT paid_at FROM farm_bookings WHERE id = $1', [id])).paid_at === null }
  },
  'POST /farm/refunds/:id/settle': async () => {
    const id = await paidFarmBooking()
    const pay = await one(`SELECT id, payment_id FROM farm_booking_payments WHERE booking_id = $1`, [id])
    const refundId = newId('frf')
    await query(
      `INSERT INTO farm_refunds (id, booking_id, farm_payment_id, payment_id, amount, kind, reason, requested_by, requested_at, refund_gave_up_at)
       VALUES ($1, $2, $3, $4, 1000, 'OVERPAID', 'test', 'test', $5, $5)`,
      [refundId, id, pay.id, pay.payment_id, new Date(T0)],
    )
    return { path: `/farm/refunds/${refundId}/settle`, body: { reference: 'UPI 112233' }, ok: 200, unchanged: async () => !(await one('SELECT refunded_at FROM farm_refunds WHERE id = $1', [refundId])).refunded_at }
  },
  'POST /me/two-step/setup': async () => ({ path: '/me/two-step/setup', body: {}, ok: 200, unchanged: async () => !(await one(`SELECT totp_pending FROM admin_users WHERE email = 'manager@mandimangoes.test'`)).totp_pending }),
}

/** Every staff route the admin router serves, as "METHOD /path". */
function adminRoutes() {
  const out = new Set()
  const walk = (stack) => {
    for (const layer of stack) {
      if (layer.route) for (const m of Object.keys(layer.route.methods)) out.add(`${m.toUpperCase()} ${layer.route.path}`)
      else if (layer.name === 'router') walk(layer.handle.stack)
    }
  }
  walk(adminRouter.stack)
  return out
}

describe('STEP_UP_ROUTES: each one asks the manager to confirm it is them', () => {
  test('every listed route exists, once, and has a scenario here', () => {
    const routes = adminRoutes()
    const listed = STEP_UP_ROUTES.map((r) => r.route)
    assert.equal(new Set(listed).size, listed.length, 'listed twice')
    for (const r of listed) assert.ok(routes.has(r), `${r} is not a staff route`)
    assert.deepEqual(Object.keys(SCENARIOS).sort(), [...listed].sort())
  })

  for (const entry of STEP_UP_ROUTES) {
    test(`${entry.route}: ${entry.always ? 'always asks' : 'asks with STAFF_STEP_UP on'}`, async () => {
      // Money and pricing routes ask with the flag off; the rest with it on.
      env.STAFF_STEP_UP = !entry.always
      const s = await SCENARIOS[entry.route]()
      const method = s.method ?? 'POST'
      const send = (body) => api.raw(method, `/admin/v1${s.path}`, { token: manager, body })
      setNow(T0)
      const asked = await send(s.body)
      assert.equal(asked.status, 403, JSON.stringify(asked.body))
      assert.deepEqual([asked.body.error.code, asked.body.error.method], ['REAUTH_REQUIRED', 'password'])
      if (s.unchanged) assert.ok(await s.unchanged(), 'nothing changed without the confirmation')
      const wrong = await send({ ...s.body, confirmCode: 'not-my-password' })
      assert.equal(wrong.body.error.code, 'REAUTH_FAILED')
      if (s.unchanged) assert.ok(await s.unchanged(), 'nothing changed with a wrong confirmation')
      const done = await send({ ...s.body, confirmCode: CONFIRM })
      assert.equal(done.status, s.ok, JSON.stringify(done.body))
      if (s.unchanged) assert.ok(!(await s.unchanged()), 'the change went through once confirmed')
    })
  }
})

describe('requests on those routes that move no money do not ask', () => {
  test('an unpaid cancel, a renamed product, a bulk deal\'s title and an unpaid booking', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal((await api.post(`/admin/v1/orders/${c.body.orderId}/cancel`, { reason: 'customer rang' }, { token: manager })).status, 204)
    const renamed = await api.patch('/admin/v1/products/ALP-3', { name: 'Alphonso Premium 3kg', price: 189_900 }, { token: manager })
    assert.equal(renamed.status, 200, 'the same price is not a price change')
    assert.equal(renamed.body.name, 'Alphonso Premium 3kg')
    const deal = await api.post('/admin/v1/bulk-listings', { ...BULK, confirmCode: CONFIRM }, { token: manager })
    assert.equal((await api.patch(`/admin/v1/bulk-listings/${deal.body.id}`, { title: 'Alphonso for hotels' }, { token: manager })).status, 200)
  })
})
