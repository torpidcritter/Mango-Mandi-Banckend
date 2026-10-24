// Production-readiness security pass (23 Oct, Phase 4). Fills the gaps left by
// auth-matrix, roles, sec-fixes, security-fixes, privacy and log-safety:
//   - every route of the whole app is in a reviewed inventory, every staff route
//     in the role policy, every customer route that takes an id in the
//     isolation cases below (a new route fails here until someone files it);
//   - customer B gets exactly what a made-up id gets for each of customer A's
//     objects, reading and writing, and nothing of A's changes;
//   - photos stay private and stored Blob paths never reach a response;
//   - webhook replays, staff session revocation and the staff sign-in limit;
//   - the audit trails name who did it and why;
//   - a database restore followed by ops/reapply-deletions.js leaves no
//     deleted account behind.
import { adminToken, checkout, client, closeAll, customerToken, makeBatch, resetDb, signWebhook, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { after, before, beforeEach, describe, test } from 'node:test'
import sharp from 'sharp'
import { createApp } from '../src/app.js'
import { forgetCustomer } from '../src/auth.js'
import { addDays, now, todayIST } from '../src/clock.js'
import { query } from '../src/db.js'
import { newId } from '../src/ids.js'
import { DEV_CHECKOUT_SECRET } from '../src/payments.js'
import { usePhotoStore } from '../src/photos.js'
import { enforceLimitsInTests } from '../src/ratelimit.js'
import { anonymiseOldOrders } from '../src/retention.js'

const run = promisify(execFile)
let srv
let api
let manager

before(async () => {
  srv = await startServer()
  api = client(srv.base)
})
after(async () => {
  usePhotoStore(null)
  enforceLimitsInTests(false)
  await srv.close()
  await closeAll()
})
beforeEach(async () => {
  usePhotoStore(null)
  enforceLimitsInTests(false)
  await resetDb()
  manager = await adminToken(api)
})

// ---------------------------------------------------------------- the route inventory

/** "METHOD /full/path" -> the gate it sits behind, read from the Express stacks of the whole app. */
function routeInventory() {
  const app = createApp()
  const mount = (re) => re.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\//g, '/')
  const out = {}
  const walk = (stack, prefix, gates) => {
    for (const layer of stack) {
      if (layer.route) {
        const gate = gates.filter((g) => !g.re || g.re.test(layer.route.path)).map((g) => g.name)
        const full = `${prefix}${layer.route.path}`
        const kind = gate.includes('requireAdmin') ? 'staff'
          : gate.includes('requireCustomer') ? 'customer'
            : full.startsWith('/webhooks/') ? (layer.route.methods.get ? 'webhook-verify-token' : 'webhook-signature')
              : full.startsWith('/internal/') ? 'cron-secret'
                : full === '/metrics' ? 'metrics-token'
                  : full.startsWith('/v1/dev/') ? 'dev-only'
                    : 'public'
        for (const m of Object.keys(layer.route.methods)) out[`${m.toUpperCase()} ${full}`] = kind
      } else if (layer.name === 'router') {
        walk(layer.handle.stack, prefix + mount(layer.regexp), [...gates])
      } else if (/^require(Admin|Customer)$/.test(layer.name)) {
        gates.push({ name: layer.name, re: layer.regexp.fast_slash ? null : layer.regexp })
      }
    }
  }
  walk(app._router.stack, '', [])
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

const INVENTORY_FILE = new URL('./fixtures/route-inventory.json', import.meta.url)
const inventoryJson = (p) => `{\n${Object.entries(p).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}\n`
if (process.env.UPDATE_ROUTE_INVENTORY) writeFileSync(INVENTORY_FILE, inventoryJson(routeInventory()))
const INVENTORY = JSON.parse(readFileSync(INVENTORY_FILE, 'utf8'))
const POLICY = JSON.parse(readFileSync(new URL('./fixtures/role-policy.json', import.meta.url), 'utf8'))

/**
 * Customer routes that name one of the customer's own objects (in the path or
 * the body), each proven below. EXEMPT: keyed to the caller's own cart, so
 * there is no other customer's object to reach.
 */
const ISOLATION_CASES = [
  'GET /v1/orders/:id', 'GET /v1/orders/:id/delivery-photo', 'GET /v1/orders/:id/payment-status', 'POST /v1/orders/:id/verify-payment',
  'POST /v1/orders/:id/cancel', 'POST /v1/orders/:id/reschedule', 'PUT /v1/orders/:id/rating',
  'GET /v1/preorders/:id', 'POST /v1/preorders/:id/cancel',
  'DELETE /v1/me/addresses/:id', 'DELETE /v1/stock-alerts/:id',
  'PATCH /v1/reviews/:id', 'DELETE /v1/reviews/:id', 'GET /v1/reviews/:id/photos/:photoId',
  'POST /v1/claims', 'POST /v1/reviews', 'POST /v1/reviews/photos',
]
const EXEMPT = ['DELETE /v1/cart/items/:sku']

describe('every route is filed', () => {
  test('the whole app matches the reviewed inventory (test/fixtures/route-inventory.json)', () => {
    assert.deepEqual(routeInventory(), INVENTORY, 'a route was added, removed or moved behind another gate: if on purpose, run with UPDATE_ROUTE_INVENTORY=1 and review the diff')
  })

  test('every staff route is in the role policy, and the policy names no route that is gone', () => {
    const staff = Object.entries(INVENTORY).filter(([, k]) => k === 'staff').map(([r]) => r.replace(' /admin/v1/', ' /'))
    assert.deepEqual(staff.filter((r) => !(r in POLICY)), [], 'staff routes missing from role-policy.json')
    assert.deepEqual(Object.keys(POLICY).filter((r) => !staff.includes(r)), [], 'role-policy.json names routes that no longer exist')
  })

  test('every customer route that takes an id is in the isolation cases', () => {
    const withId = Object.entries(INVENTORY).filter(([r, k]) => k === 'customer' && r.includes('/:')).map(([r]) => r)
    assert.deepEqual(withId.filter((r) => !ISOLATION_CASES.includes(r) && !EXEMPT.includes(r)), [])
    for (const r of ISOLATION_CASES) assert.equal(INVENTORY[r], 'customer', r)
  })

  test('the public routes are the reviewed few: sign-in, catalogue, policy, approved reviews and photos', () => {
    const open = Object.entries(INVENTORY).filter(([, k]) => k === 'public').map(([r]) => r)
    assert.deepEqual(open, [
      'GET /admin/v1/auth/config', 'GET /health', 'GET /ready', 'GET /v1/auth/config', 'GET /v1/catalogue', 'GET /v1/delivery/check', 'GET /v1/delivery/slots',
      'GET /v1/policy', 'GET /v1/preorders/weeks', 'GET /v1/products', 'GET /v1/products/:sku/photo', 'GET /v1/products/:sku/reviews', 'GET /v1/review-photos/:id',
      'POST /admin/v1/auth/google', 'POST /admin/v1/auth/login', 'POST /admin/v1/auth/logout', 'POST /admin/v1/auth/refresh', 'POST /admin/v1/auth/two-step',
      'POST /v1/auth/google', 'POST /v1/auth/logout', 'POST /v1/auth/otp/request', 'POST /v1/auth/otp/verify', 'POST /v1/auth/token/refresh',
    ])
  })
})

// ---------------------------------------------------------------- customer to customer

/** An in-memory Blob store: stored paths are what a leak would show. */
const blobs = new Map()
const memoryStore = {
  async put(path, bytes) {
    blobs.set(path, bytes)
    return path
  },
  async get(path) {
    return blobs.get(path) ?? null
  },
  async del(path) {
    blobs.delete(path)
  },
  async listOld() {
    return []
  },
}
const jpeg = () => sharp({ create: { width: 32, height: 24, channels: 3, background: '#fa0' } }).jpeg().toBuffer()
const image = async (path, token) => api.raw('POST', path, { token, headers: { 'Content-Type': 'image/jpeg' }, raw: await jpeg() })

async function mondayWithCapacity() {
  let week = addDays(todayIST(), 6)
  while (new Date(`${week}T00:00:00Z`).getUTCDay() !== 1) week = addDays(week, 1)
  assert.equal((await api.put(`/admin/v1/preorder-capacity/${week}/ALP-3`, { capacity: 5 }, { token: manager })).status, 200)
  return week
}

async function paid(cust) {
  const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
  assert.equal(c.status, 201, JSON.stringify(c.body))
  await api.post('/v1/dev/pay', { orderId: c.body.orderId, outcome: 'captured' })
  return c.body
}

/** Packed, sent out and delivered by staff with a photo, as on the road. */
async function deliveredWithPhoto(cust, body = {}) {
  const o = await paid(cust)
  const t = { token: manager }
  await api.patch(`/admin/v1/orders/${o.orderId}/status`, { status: 'PROCESSING' }, t)
  assert.equal((await api.post(`/admin/v1/orders/${o.orderId}/allocate`, undefined, t)).status, 204)
  assert.equal((await api.patch(`/admin/v1/orders/${o.orderId}/status`, { status: 'PACKED' }, t)).status, 204)
  assert.equal((await api.post(`/admin/v1/orders/${o.orderId}/dispatch`, undefined, t)).status, 204)
  const pic = await image(`/admin/v1/orders/${o.orderId}/delivery-photos`, manager)
  assert.equal(pic.status, 201, JSON.stringify(pic.body))
  const done = await api.post(`/admin/v1/orders/${o.orderId}/delivery`, { outcome: 'DELIVERED', photoId: pic.body.id, receivedBy: 'Security guard', ...body }, t)
  assert.equal(done.status, 200, JSON.stringify(done.body))
  return { ...o, photoId: pic.body.id }
}

describe('customer to customer', () => {
  test("for each of A's objects, B gets what a made-up id gets, reading or writing, and nothing of A's changes", async () => {
    usePhotoStore(memoryStore)
    blobs.clear()
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 40 } })
    const week = await mondayWithCapacity()
    const a = await customerToken(api, '9876500101')
    const b = await customerToken(api, '9876500202')
    const A = { token: a.accessToken }
    const B = { token: b.accessToken }

    // A: a delivered order (photo proof, a claim with a photo, a rating, a review with a photo), a paid
    // order not yet packed, a booking, a saved address, a stock alert, and loose photos not yet sent.
    const done = await deliveredWithPhoto(a)
    const open = await paid(a)
    const pre = await api.post('/v1/preorders', { sku: 'ALP-3', stage: 'RIPE', qty: 1, weekStart: week, pincode: '560034', address: '12, 4th Cross, Koramangala, Bengaluru' }, { ...A, headers: { 'Idempotency-Key': newId('idem') } })
    assert.equal(pre.status, 201, JSON.stringify(pre.body))
    const claimPhoto = (await image('/v1/claims/photos', a.accessToken)).body.id
    const looseClaimPhoto = (await image('/v1/claims/photos', a.accessToken)).body.id
    const claim = await api.post('/v1/claims', { orderId: done.orderId, issueType: 'DAMAGED', description: 'two were squashed', photoIds: [claimPhoto] }, A)
    assert.equal(claim.status, 201, JSON.stringify(claim.body))
    assert.equal((await api.put(`/v1/orders/${done.orderId}/rating`, { stars: 4, comment: 'good' }, A)).status, 204)
    const reviewPhoto = (await image('/v1/reviews/photos', a.accessToken)).body.id
    const looseReviewPhoto = (await image('/v1/reviews/photos', a.accessToken)).body.id
    const item = (await query('SELECT id FROM order_items WHERE order_id = $1', [done.orderId])).rows[0].id
    const review = await api.post('/v1/reviews', { orderItemId: item, rating: 4, comment: 'sweet', photoIds: [reviewPhoto] }, { ...A, headers: { 'Idempotency-Key': newId('k') } })
    assert.equal(review.status, 201, JSON.stringify(review.body))
    const rid = review.body.review.id
    const address = (await api.get('/v1/me/addresses', A)).body[0].id
    const alert = (await api.post('/v1/stock-alerts', { sku: 'ALP-3', stage: 'RAW', pincode: '560034' }, A)).body.id
    // The owner reaches each of them: what follows is about ownership, not the objects.
    assert.equal((await api.get(`/v1/orders/${done.orderId}/delivery-photo`, A)).status, 200)
    assert.equal((await api.get(`/v1/reviews/${rid}/photos/${reviewPhoto}`, A)).status, 200)

    // B has a delivered order of their own, to aim A's photo ids at.
    const bOrder = await paid(b)
    await query(`UPDATE orders SET status = 'DELIVERED' WHERE id = $1`, [bOrder.orderId])
    await query(`INSERT INTO order_events (id, order_id, from_status, status, actor, created_at) VALUES ($1, $2, 'OUT_FOR_DELIVERY', 'DELIVERED', 'test', $3)`, [newId('evt'), bOrder.orderId, now()])
    const bItem = (await query('SELECT id FROM order_items WHERE order_id = $1', [bOrder.orderId])).rows[0].id

    const snapshot = async () => ({
      orders: (await query('SELECT id, status, delivery_date, slot_id, payment_status, refund_requested_at FROM orders WHERE customer_id = $1 ORDER BY id', [a.customer.id])).rows,
      preorder: (await query('SELECT status FROM preorders WHERE id = $1', [pre.body.id])).rows,
      claims: (await query('SELECT id, status, order_id FROM claims ORDER BY id')).rows,
      claimPhotos: (await query('SELECT id, claim_id, customer_id FROM claim_photos ORDER BY id')).rows,
      rating: (await query('SELECT stars, comment FROM order_ratings WHERE order_id = $1', [done.orderId])).rows,
      reviews: (await query('SELECT id, status, rating, comment, customer_id FROM reviews ORDER BY id')).rows,
      reviewPhotos: (await query('SELECT id, review_id, removed_at FROM review_photos ORDER BY id')).rows,
      addresses: (await query('SELECT id FROM customer_addresses WHERE customer_id = $1', [a.customer.id])).rows,
      alert: (await query('SELECT cancelled_at FROM stock_alerts WHERE id = $1', [alert])).rows,
    })
    const before = await snapshot()

    const sig = (rzpOrder, pay) => createHmac('sha256', DEV_CHECKOUT_SECRET).update(`${rzpOrder}|${pay}`).digest('hex')
    const verify = (id, rzpOrder) => api.post(`/v1/orders/${id}/verify-payment`, { razorpay_payment_id: 'pay_b', razorpay_order_id: rzpOrder, razorpay_signature: sig(rzpOrder, 'pay_b') }, B)
    const reviewAs = (orderItemId, photoIds = []) => api.post('/v1/reviews', { orderItemId, rating: 1, photoIds }, { ...B, headers: { 'Idempotency-Key': newId('k') } })
    // [route, B on A's object, B on an object that doesn't exist]
    const cases = [
      ['GET /v1/orders/:id', () => api.get(`/v1/orders/${done.orderId}`, B), () => api.get('/v1/orders/ord_none', B)],
      ['GET /v1/orders/:id/delivery-photo', () => api.get(`/v1/orders/${done.orderId}/delivery-photo`, B), () => api.get('/v1/orders/ord_none/delivery-photo', B)],
      ['GET /v1/orders/:id/payment-status', () => api.get(`/v1/orders/${open.orderId}/payment-status`, B), () => api.get('/v1/orders/ord_none/payment-status', B)],
      ['POST /v1/orders/:id/verify-payment', () => verify(open.orderId, open.razorpayOrderId), () => verify('ord_none', open.razorpayOrderId)],
      ['POST /v1/orders/:id/cancel', () => api.post(`/v1/orders/${open.orderId}/cancel`, {}, B), () => api.post('/v1/orders/ord_none/cancel', {}, B)],
      ['POST /v1/orders/:id/reschedule', () => api.post(`/v1/orders/${open.orderId}/reschedule`, { deliveryDate: addDays(todayIST(), 4) }, B), () => api.post('/v1/orders/ord_none/reschedule', { deliveryDate: addDays(todayIST(), 4) }, B)],
      ['PUT /v1/orders/:id/rating', () => api.put(`/v1/orders/${done.orderId}/rating`, { stars: 1 }, B), () => api.put('/v1/orders/ord_none/rating', { stars: 1 }, B)],
      ['GET /v1/preorders/:id', () => api.get(`/v1/preorders/${pre.body.id}`, B), () => api.get('/v1/preorders/pre_none', B)],
      ['POST /v1/preorders/:id/cancel', () => api.post(`/v1/preorders/${pre.body.id}/cancel`, {}, B), () => api.post('/v1/preorders/pre_none/cancel', {}, B)],
      ['DELETE /v1/me/addresses/:id', () => api.del(`/v1/me/addresses/${address}`, B), () => api.del('/v1/me/addresses/adr_none', B)],
      ['DELETE /v1/stock-alerts/:id', () => api.del(`/v1/stock-alerts/${alert}`, B), () => api.del('/v1/stock-alerts/sal_none', B)],
      ['PATCH /v1/reviews/:id', () => api.patch(`/v1/reviews/${rid}`, { rating: 1 }, B), () => api.patch('/v1/reviews/rvw_none', { rating: 1 }, B)],
      ['DELETE /v1/reviews/:id', () => api.del(`/v1/reviews/${rid}`, B), () => api.del('/v1/reviews/rvw_none', B)],
      ['GET /v1/reviews/:id/photos/:photoId', () => api.get(`/v1/reviews/${rid}/photos/${reviewPhoto}`, B), () => api.get('/v1/reviews/rvw_none/photos/rph_none', B)],
      ['POST /v1/claims', () => api.post('/v1/claims', { orderId: done.orderId, issueType: 'DAMAGED', description: 'not my order' }, B), () => api.post('/v1/claims', { orderId: 'ord_none', issueType: 'DAMAGED', description: 'not my order' }, B)],
      ['POST /v1/claims', () => api.post('/v1/claims', { orderId: bOrder.orderId, issueType: 'DAMAGED', description: 'with your photo', photoIds: [looseClaimPhoto] }, B), () => api.post('/v1/claims', { orderId: bOrder.orderId, issueType: 'DAMAGED', description: 'with your photo', photoIds: ['cph_none'] }, B)],
      ['POST /v1/reviews', () => reviewAs(item), () => reviewAs('itm_none')],
      ['POST /v1/reviews', () => reviewAs(bItem, [looseReviewPhoto]), () => reviewAs(bItem, ['rph_none'])],
      ['POST /v1/reviews/photos', () => api.post('/v1/reviews/photos', { pathname: `review-uploads/${a.customer.id}/up_1` }, B), () => api.post('/v1/reviews/photos', { pathname: `review-uploads/${b.customer.id}/up_none` }, B)],
    ]
    assert.deepEqual([...new Set(cases.map(([r]) => r))].sort(), [...ISOLATION_CASES].sort(), 'a case for every isolation route')
    for (const [route, theirs, none] of cases) {
      const x = await theirs()
      const y = await none()
      assert.ok([400, 404].includes(x.status), `${route} -> ${x.status} ${JSON.stringify(x.body)}`)
      assert.deepEqual([x.status, x.body?.error?.code], [y.status, y.body?.error?.code], `${route}: A's object must look like one that doesn't exist`)
    }
    assert.deepEqual(await snapshot(), before, "nothing of A's changed")

    // B's lists and export carry nothing of A's: no id, no phone, no address, no stored photo path.
    const aMarks = [done.orderId, open.orderId, pre.body.id, claim.body.id, rid, address, alert, claimPhoto, reviewPhoto, looseClaimPhoto, looseReviewPhoto, '9876500101']
    for (const path of ['/v1/orders', '/v1/preorders', '/v1/claims', '/v1/me/addresses', '/v1/stock-alerts', '/v1/me/reviews', '/v1/me/export', '/v1/me']) {
      const r = await api.get(path, B)
      assert.equal(r.status, 200, path)
      const text = JSON.stringify(r.body)
      for (const m of aMarks) assert.ok(!text.includes(m), `${path} shows ${m}`)
    }
    assert.ok(!JSON.stringify((await api.get(`/v1/me/reviews?orderId=${done.orderId}`, B)).body).includes(rid))

    // Private photos: no sign-in, or a customer token on the staff photo routes, is refused; the
    // public review photo route opens only approved photos of approved reviews.
    assert.equal((await api.get(`/v1/orders/${done.orderId}/delivery-photo`)).status, 401)
    assert.equal((await api.get(`/v1/reviews/${rid}/photos/${reviewPhoto}`)).status, 401)
    assert.equal((await api.get(`/admin/v1/orders/${done.orderId}/delivery-photos/${done.photoId}`)).status, 401)
    assert.equal((await api.get(`/admin/v1/orders/${done.orderId}/delivery-photos/${done.photoId}`, A)).status, 401)
    assert.equal((await api.get(`/admin/v1/claims/${claim.body.id}/photos/${claimPhoto}`, A)).status, 401)
    assert.equal((await api.get(`/admin/v1/reviews/${rid}/photos/${reviewPhoto}`, A)).status, 401)
    assert.equal((await api.get(`/v1/review-photos/${reviewPhoto}`)).status, 404, 'not approved yet')
    assert.equal((await api.get(`/admin/v1/claims/${claim.body.id}/photos/${claimPhoto}`, { token: manager })).status, 200)

    // Stored Blob paths are never in an answer, the customer's own or the staff's.
    const paths = [...blobs.keys()]
    assert.ok(paths.length >= 5, `${paths.length} photos stored`)
    const answers = [
      ...(await Promise.all(['/v1/orders', `/v1/orders/${done.orderId}`, '/v1/claims', '/v1/me/reviews', '/v1/me/export'].map((p) => api.get(p, A)))),
      ...(await Promise.all([`/admin/v1/orders/${done.orderId}`, '/admin/v1/claims', '/admin/v1/reviews', `/admin/v1/reviews/${rid}`, '/admin/v1/delivery-reviews'].map((p) => api.get(p, { token: manager })))),
    ]
    for (const r of answers) {
      assert.equal(r.status, 200)
      const text = JSON.stringify(r.body)
      for (const p of paths) assert.ok(!text.includes(p), `a stored photo path is in an answer: ${p}`)
      assert.ok(!/blob\.vercel-storage\.com|blob_path|blobPath/.test(text))
    }
  })
})

// ---------------------------------------------------------------- webhooks

const razorpay = (event, eventId, signed = signWebhook(event)) =>
  api.raw('POST', '/webhooks/razorpay', { raw: signed.raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signed.signature, ...(eventId ? { 'X-Razorpay-Event-Id': eventId } : {}) } })

describe('webhook replays', () => {
  test('Razorpay: the same event twice, the same event id with another body, and a new id for the same payment change nothing more', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal(c.status, 201)
    const entity = { id: 'pay_replay', order_id: c.body.razorpayOrderId, amount: c.body.total, currency: 'INR', method: 'upi' }
    const event = { event: 'payment.captured', payload: { payment: { entity } } }
    const state = async () => ({
      order: (await query('SELECT status, payment_status, payment_id, refund_requested_at FROM orders WHERE id = $1', [c.body.orderId])).rows[0],
      events: (await query('SELECT COUNT(*)::int AS n FROM order_events WHERE order_id = $1', [c.body.orderId])).rows[0].n,
      ledger: (await query("SELECT COUNT(*)::int AS n FROM batch_ledger WHERE event_type <> 'INTAKE'")).rows[0].n,
      duplicates: (await query('SELECT COUNT(*)::int AS n FROM duplicate_payments')).rows[0].n,
      notifications: (await query('SELECT COUNT(*)::int AS n FROM notifications WHERE order_id = $1', [c.body.orderId])).rows[0].n,
    })

    const first = await razorpay(event, 'evt_replay_1')
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const confirmed = await state()
    assert.equal(confirmed.order.status, 'CONFIRMED')

    const again = await razorpay(event, 'evt_replay_1')
    assert.equal(again.status, 200)
    assert.equal(again.body.duplicate, true)
    // Same event id, a different (validly signed) body: still the event already handled.
    const changed = await razorpay({ event: 'payment.captured', payload: { payment: { entity: { ...entity, id: 'pay_other', amount: 1 } } } }, 'evt_replay_1')
    assert.equal(changed.body.duplicate, true)
    // Same payment under a new event id: applied once, not twice; no refund, no second payment.
    const newId_ = await razorpay(event, 'evt_replay_2')
    assert.equal(newId_.status, 200, JSON.stringify(newId_.body))
    // And without an event id at all (deduplicated on the payment id).
    await razorpay(event, null)
    await razorpay(event, null)
    assert.deepEqual(await state(), confirmed)
  })

  test('WhatsApp: a signed message delivered twice is handled once', async () => {
    const raw = JSON.stringify({
      entry: [{ changes: [{ value: {
        contacts: [{ wa_id: '919800000077', profile: { name: 'Asha' } }],
        messages: [{ from: '919800000077', id: 'wamid.replay1', timestamp: String(Math.floor(now().getTime() / 1000)), type: 'text', text: { body: 'hi' } }],
      } }] }],
    })
    const sig = `sha256=${createHmac('sha256', 'wa_test_secret').update(raw).digest('hex')}`
    const send = () => api.raw('POST', '/webhooks/whatsapp', { raw, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig } })
    assert.equal((await send()).status, 200)
    const count = async () => ({
      inbound: (await query("SELECT COUNT(*)::int AS n FROM wa_inbound WHERE message_id = 'wamid.replay1'")).rows[0].n,
      sessions: (await query("SELECT COUNT(*)::int AS n FROM wa_sessions WHERE phone = '+919800000077'")).rows[0].n,
      outbound: (await query("SELECT COUNT(*)::int AS n FROM notifications WHERE phone = '+919800000077'")).rows[0].n,
    })
    const once = await count()
    assert.equal(once.inbound, 1)
    assert.equal((await send()).status, 200)
    assert.deepEqual(await count(), once)
  })
})

// ---------------------------------------------------------------- staff sessions

const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0]

describe('staff sessions', () => {
  async function staffWithCookie(role = 'OPERATOR') {
    const email = `${newId('s').toLowerCase()}@mandimangoes.test`
    const add = await api.post('/admin/v1/staff', { email, role, password: 'long-enough-pass-1' }, { token: manager })
    assert.equal(add.status, 201, JSON.stringify(add.body))
    const login = await api.post('/admin/v1/auth/login', { email, password: 'long-enough-pass-1' })
    assert.equal(login.status, 200, JSON.stringify(login.body))
    return { id: add.body.id, email, token: login.body.accessToken, cookie: cookieOf(login) }
  }
  const refresh = (cookie) => api.post('/admin/v1/auth/refresh', undefined, { headers: { Cookie: cookie } })

  test('removal, a new password and a two-step reset each end the refresh session as well as the access token', async () => {
    for (const [label, change] of [
      ['removed', (s) => api.del(`/admin/v1/staff/${s.id}`, { token: manager })],
      ['new password', (s) => api.patch(`/admin/v1/staff/${s.id}`, { password: 'another-long-pass-2' }, { token: manager })],
      ['role change', (s) => api.patch(`/admin/v1/staff/${s.id}`, { role: 'QC' }, { token: manager })],
      ['two-step reset', (s) => api.post(`/admin/v1/staff/${s.id}/two-step/reset`, {}, { token: manager })],
    ]) {
      const s = await staffWithCookie()
      assert.equal((await api.get('/admin/v1/auth/me', { token: s.token })).status, 200, label)
      const r = await change(s)
      assert.ok(r.status < 300, `${label}: ${r.status} ${JSON.stringify(r.body)}`)
      assert.equal((await api.get('/admin/v1/auth/me', { token: s.token })).status, 401, `${label}: access token`)
      assert.equal((await refresh(s.cookie)).status, 401, `${label}: refresh cookie`)
    }
  })

  test('staff sign-in is limited per address: the 31st try in 15 minutes is refused, the right password too', async () => {
    enforceLimitsInTests(true)
    for (let i = 0; i < 30; i++) {
      const r = await api.post('/admin/v1/auth/login', { email: `nobody${i}@mandimangoes.test`, password: 'wrong-password-123' })
      assert.equal(r.status, 401, `try ${i + 1}`)
    }
    const blocked = await api.post('/admin/v1/auth/login', { email: 'manager@mandimangoes.test', password: 'manager123' })
    assert.equal(blocked.status, 429)
    assert.equal(blocked.body.error.code, 'RATE_LIMITED')
    // The two-step and Google sign-in steps share the same count.
    assert.equal((await api.post('/admin/v1/auth/two-step', { ticket: 'x'.repeat(30), code: '123456' })).status, 429)
    assert.equal((await api.post('/admin/v1/auth/google', { credential: 'x'.repeat(30) })).status, 429)
  })
})

// ---------------------------------------------------------------- audit trails

describe('audit trails name who and why', () => {
  test('stock adjustment, a manager refund, order steps, a customer cancel and a staff role change', async () => {
    const batch = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    const opsId = (await query(`SELECT id FROM admin_users WHERE email = 'ops@mandimangoes.test'`)).rows[0].id
    const lineId = (await query('SELECT id FROM batch_lines WHERE batch_id = $1', [batch])).rows[0].id
    assert.equal((await api.patch(`/admin/v1/batches/${batch}/lines/${lineId}`, { onHand: 18, reason: 'two crushed in the crate', reasonCode: 'DAMAGED' }, { token: ops })).status, 204)
    const adj = (await query(`SELECT * FROM batch_ledger WHERE batch_id = $1 AND event_type = 'ADJUST'`, [batch])).rows[0]
    assert.deepEqual([adj.actor_type, adj.actor_id, adj.delta, adj.reason, adj.reason_code], ['admin', opsId, -2, 'two crushed in the crate', 'DAMAGED'])
    assert.equal((await api.patch(`/admin/v1/batches/${batch}/lines/${lineId}`, { onHand: 17 }, { token: ops })).status, 400, 'a stock change needs a reason')

    const cust = await customerToken(api)
    const refunded = await paid(cust)
    assert.equal((await api.post(`/admin/v1/orders/${refunded.orderId}/cancel`, { reason: 'van broke down', refund: true }, { token: manager })).status, 204)
    const ev = (await query(`SELECT actor, reason FROM order_events WHERE order_id = $1 AND status = 'CANCELLED'`, [refunded.orderId])).rows[0]
    assert.equal(ev.actor, 'manager@mandimangoes.test')
    assert.match(ev.reason, /full refund: van broke down/)
    assert.ok((await query('SELECT refund_requested_at FROM orders WHERE id = $1', [refunded.orderId])).rows[0].refund_requested_at)

    const mine = await paid(cust)
    assert.equal((await api.post(`/v1/orders/${mine.orderId}/cancel`, {}, { token: cust.accessToken })).status, 204)
    const own = (await query(`SELECT actor, reason FROM order_events WHERE order_id = $1 AND status = 'CANCELLED'`, [mine.orderId])).rows[0]
    assert.deepEqual(own, { actor: 'customer', reason: 'Cancelled by customer; full refund requested' })

    const step = await paid(cust)
    assert.equal((await api.patch(`/admin/v1/orders/${step.orderId}/status`, { status: 'PROCESSING' }, { token: ops })).status, 204)
    const moved = (await query(`SELECT from_status, actor FROM order_events WHERE order_id = $1 AND status = 'PROCESSING'`, [step.orderId])).rows[0]
    assert.deepEqual(moved, { from_status: 'CONFIRMED', actor: 'ops@mandimangoes.test' })

    const add = await api.post('/admin/v1/staff', { email: 'meena@mandimangoes.test', role: 'PACKER', password: 'long-enough-pass-1' }, { token: manager })
    assert.equal((await api.patch(`/admin/v1/staff/${add.body.id}`, { role: 'OPERATOR', password: 'another-long-pass-2' }, { token: manager })).status, 200)
    let rows = []
    for (let i = 0; i < 50 && rows.length < 3; i++) {
      rows = (await query(`SELECT * FROM staff_audit WHERE action IN ('PATCH /staff/:id', 'POST /orders/:id/cancel', 'PATCH /batches/:id/lines/:lineId') ORDER BY created_at`)).rows
      if (rows.length < 3) await new Promise((r) => setTimeout(r, 20))
    }
    const role = rows.find((r) => r.action === 'PATCH /staff/:id')
    assert.deepEqual([role.email, role.role, role.target, role.detail.role, role.detail.password], ['manager@mandimangoes.test', 'MANAGER', add.body.id, 'OPERATOR', '[removed]'])
    const cancel = rows.find((r) => r.action === 'POST /orders/:id/cancel')
    assert.deepEqual([cancel.email, cancel.target, cancel.detail.reason, cancel.detail.refund], ['manager@mandimangoes.test', refunded.orderId, 'van broke down', true])
    const stock = rows.find((r) => r.action === 'PATCH /batches/:id/lines/:lineId')
    assert.deepEqual([stock.email, stock.target, stock.detail.reason], ['ops@mandimangoes.test', `${batch}/${lineId}`, 'two crushed in the crate'])
  })

  test('SEC-R3: the audit trail keeps no copy of where the rider stood or who took the box, and erasure clears old rows', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const o = await deliveredWithPhoto(cust, { lat: 12.935, lng: 77.624, note: 'Left with Priya at flat 4B' })
    const auditRow = async () => {
      for (let i = 0; i < 50; i++) {
        const r = (await query(`SELECT detail FROM staff_audit WHERE action = 'POST /orders/:id/delivery' AND target = $1`, [o.orderId])).rows[0]
        if (r) return r.detail
        await new Promise((res) => setTimeout(res, 20))
      }
      return null
    }
    const d = await auditRow()
    assert.equal(d.outcome, 'DELIVERED')
    assert.deepEqual([d.lat, d.lng, d.receivedBy], ['[removed]', '[removed]', '[removed]'])
    // The attempt itself keeps them for ops, until erasure or retention.
    const att = (await query(`SELECT lat, received_by FROM delivery_attempts WHERE order_id = $1 AND outcome = 'DELIVERED'`, [o.orderId])).rows[0]
    assert.equal(Number(att.lat), 12.935)
    assert.equal(att.received_by, 'Security guard')

    // Rows written before this fix carry them: deleting the account takes them out.
    await query(`UPDATE staff_audit SET detail = detail || '{"lat": 12.9, "lng": 77.6, "receivedBy": "Priya"}'::jsonb WHERE target = $1`, [o.orderId])
    assert.equal((await api.del('/v1/me', { token: cust.accessToken })).status, 204)
    const after = await auditRow()
    for (const k of ['lat', 'lng', 'receivedBy', 'note']) assert.ok(!(k in after), `${k} left in the audit row`)
    assert.equal(after.outcome, 'DELIVERED', 'the rest of the row stays')

    // The 12-month retention pass does the same for live accounts.
    const other = await customerToken(api)
    const old = await deliveredWithPhoto(other, { note: 'Gate 2, ask for Ravi' })
    await auditRow()
    await query(`UPDATE staff_audit SET detail = detail || '{"lat": 1, "receivedBy": "Ravi"}'::jsonb WHERE target = $1`, [old.orderId])
    await query(`UPDATE orders SET delivery_date = '2025-01-10' WHERE id = $1`, [old.orderId])
    assert.equal(await anonymiseOldOrders(), 1)
    const kept = (await query(`SELECT detail FROM staff_audit WHERE action = 'POST /orders/:id/delivery' AND target = $1`, [old.orderId])).rows[0].detail
    for (const k of ['lat', 'receivedBy', 'note']) assert.ok(!(k in kept), `${k} left after retention`)
  })
})

// ---------------------------------------------------------------- restore and deletions

describe('a database restore does not bring a deleted account back', () => {
  test('ops/reapply-deletions.js re-deletes accounts deleted after the restore point, once', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    // The restored copy: A and B are live with their details (A deleted the account after the
    // restore point, so the copy predates it), C deleted before it.
    const a = await customerToken(api, '9876511101')
    const b = await customerToken(api, '9876511102')
    const order = await paid(a)
    await query(`UPDATE orders SET status = 'DELIVERED' WHERE id = $1`, [order.orderId])
    // The pre-restore database, as Neon keeps it as a backup branch: only what the script reads.
    await query('DROP SCHEMA IF EXISTS pre_restore CASCADE')
    await query('CREATE SCHEMA pre_restore')
    await query('CREATE TABLE pre_restore.customers (id TEXT PRIMARY KEY, deleted_at TIMESTAMPTZ)')
    const restorePoint = new Date(now().getTime() - 3_600_000)
    await query('INSERT INTO pre_restore.customers VALUES ($1, $2), ($3, NULL), ($4, $5)', [
      a.customer.id, new Date(now().getTime() - 60_000), b.customer.id, 'cus_gone_before', new Date(restorePoint.getTime() - 86_400_000),
    ])
    // A direct connection: PgBouncer refuses the search_path startup option (as Neon's pooler does).
    const oldUrl = `${process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL}?options=${encodeURIComponent('-c search_path=pre_restore')}`
    const script = new URL('../ops/reapply-deletions.js', import.meta.url).pathname
    const go = () => run(process.execPath, [script, '--old-url', oldUrl, '--since', restorePoint.toISOString()], { env: { ...process.env } })
    try {
      const out = await go()
      assert.match(out.stdout, /re-deleted 1 of 1 accounts/)
      const row = (await query('SELECT phone, name, deleted_at FROM customers WHERE id = $1', [a.customer.id])).rows[0]
      assert.equal(row.phone, null)
      assert.ok(row.deleted_at)
      const o = (await query('SELECT phone, delivery_address, total FROM orders WHERE id = $1', [order.orderId])).rows[0]
      assert.deepEqual([o.phone, o.delivery_address], [null, null])
      assert.ok(o.total > 0, 'the amounts stay for the books')
      assert.equal((await query('SELECT COUNT(*)::int AS n FROM customer_addresses WHERE customer_id = $1', [a.customer.id])).rows[0].n, 0)
      // The script ran outside the API: an instance that saw A in the last 30 s still has A cached (auth.js).
      forgetCustomer(a.customer.id)
      assert.equal((await api.get('/v1/me', { token: a.accessToken })).status, 401)
      assert.equal((await api.post('/v1/auth/token/refresh', { refreshToken: a.refreshToken })).status, 401)
      // B untouched.
      assert.equal((await api.get('/v1/me', { token: b.accessToken })).status, 200)
      // A second run finds nothing left to do.
      assert.match((await go()).stdout, /re-deleted 0 of 1 accounts/)
    } finally {
      await query('DROP SCHEMA IF EXISTS pre_restore CASCADE')
    }
  })
})
