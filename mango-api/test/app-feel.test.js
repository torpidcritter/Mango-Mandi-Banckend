// App feel (docs/app-feel.md): browser notifications (RFC 8291 + RFC 8292,
// sent through a stub, never a real push service), live tracking without GPS,
// favourites, and the switches the shop and panel read.
import { closeAll, adminToken, checkout, client, customerToken, makeBatch, resetDb, startServer, T0 } from './helpers.js'
import assert from 'node:assert/strict'
import { createPublicKey, randomBytes, verify } from 'node:crypto'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { setNow } from '../src/clock.js'
import { query, tx } from '../src/db.js'
import { env } from '../src/env.js'
import { newId } from '../src/ids.js'
import { cleanupExpired, runMaintenance } from '../src/maintenance.js'
import { checkProduction } from '../src/preflight.js'
import { moveFavourites } from '../src/favourites.js'
import { CONFIRMATION_HELD } from '../src/orders.js'
import { loadProducts } from '../src/products.js'
import { endpointHint, MAX_SUBSCRIPTIONS, payloadFor, sendDuePush, usePushSender } from '../src/push.js'
import { pushProblems } from '../src/push-checks.js'
import { b64url, decrypt, encrypt, fromB64url, generateKeyPair, MAX_PAYLOAD, vapidAuthorization, vapidKey, vapidSender } from '../src/webpush.js'

let srv
let api
let admin

const FLAGS = ['WEB_PUSH', 'WEB_PUSH_PROVIDER', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'LIVE_TRACKING', 'FAVOURITES', 'SHOP_INSTALL', 'SHOP_SORT_FILTER']
const saved = Object.fromEntries(FLAGS.map((k) => [k, env[k]]))
const SERVER_KEYS = generateKeyPair()

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
afterEach(() => {
  Object.assign(env, saved)
  usePushSender(null)
})

/** Push on, as in development: the log provider with a key pair, so browsers can subscribe. */
function pushOnForTest() {
  Object.assign(env, {
    WEB_PUSH: true,
    WEB_PUSH_PROVIDER: 'log',
    VAPID_PUBLIC_KEY: b64url(SERVER_KEYS.publicKey),
    VAPID_PRIVATE_KEY: b64url(SERVER_KEYS.privateKey),
    VAPID_SUBJECT: 'mailto:ops@mandimangoes.test',
  })
}

/** What a browser makes when the customer says yes: its own key pair and auth secret, and a push service URL. */
let browserSeq = 0
function browser(host = 'fcm.googleapis.com') {
  const keys = generateKeyPair()
  const auth = randomBytes(16)
  return {
    keys,
    auth,
    json: { endpoint: `https://${host}/fcm/send/test-${++browserSeq}-${randomBytes(6).toString('hex')}`, expirationTime: null, keys: { p256dh: b64url(keys.publicKey), auth: b64url(auth) } },
  }
}

/** A stub sender: records every call, answers the given statuses in turn (201 once they run out). */
function stubSender(statuses = []) {
  const calls = []
  usePushSender(async (sub, msg) => {
    calls.push({ endpoint: sub.endpoint, ...msg })
    const status = statuses.shift() ?? 201
    if (status instanceof Error) throw status
    return { status }
  })
  return calls
}

const ADDRESS = '12, 4th Cross, Koramangala, Bengaluru'

/** A paid order for one box, to the given address. */
async function paidOrder(cust, { address = ADDRESS } = {}) {
  const token = cust.accessToken
  assert.equal((await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 1 }, { token })).status, 204)
  const q = await api.post('/v1/checkout/quote', { pincode: '560034' }, { token })
  assert.equal(q.status, 200, JSON.stringify(q.body))
  const o = await api.post('/v1/checkout/confirm', { quoteId: q.body.quoteId, address }, { token, headers: { 'Idempotency-Key': newId('idem') } })
  assert.equal(o.status, 201, JSON.stringify(o.body))
  assert.equal((await api.post('/v1/dev/pay', { orderId: o.body.orderId, outcome: 'captured' })).status, 200)
  return { id: o.body.orderId, date: o.body.deliveryDate }
}

async function pack(id) {
  assert.equal((await api.patch(`/admin/v1/orders/${id}/status`, { status: 'PROCESSING' }, { token: admin })).status, 204)
  assert.equal((await api.post(`/admin/v1/orders/${id}/allocate`, undefined, { token: admin })).status, 204)
  assert.equal((await api.patch(`/admin/v1/orders/${id}/status`, { status: 'PACKED' }, { token: admin })).status, 204)
}

async function addRider(email = 'ravi@mandimangoes.test') {
  const add = await api.post('/admin/v1/staff', { email, role: 'RIDER', password: 'long-enough-1' }, { token: admin })
  assert.equal(add.status, 201, JSON.stringify(add.body))
  return adminToken(api, email, 'long-enough-1')
}

const pushRows = (customerId) => query('SELECT * FROM push_messages WHERE customer_id = $1 ORDER BY created_at, kind', [customerId]).then((r) => r.rows)
const subRows = (customerId) => query('SELECT * FROM push_subscriptions WHERE customer_id = $1 ORDER BY created_at', [customerId]).then((r) => r.rows)

// ---------------------------------------------------------------- the encryption, on its own

describe('web push encryption (RFC 8291) and VAPID (RFC 8292), with node:crypto only', () => {
  // RFC 8291 Appendix A: the worked example, byte for byte.
  const A = {
    plain: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
    asPriv: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    uaPub: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    uaPriv: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    out: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  }

  test('matches the RFC 8291 worked example exactly, both ways', () => {
    const body = encrypt(fromB64url(A.plain), { p256dh: fromB64url(A.uaPub), auth: fromB64url(A.auth) }, { asKeys: { privateKey: fromB64url(A.asPriv) }, salt: fromB64url(A.salt) })
    assert.equal(b64url(body), A.out)
    const back = decrypt(fromB64url(A.out), { privateKey: fromB64url(A.uaPriv), publicKey: fromB64url(A.uaPub), auth: fromB64url(A.auth) })
    assert.equal(back.toString(), 'When I grow up, I want to be a watermelon')
  })

  test('round-trips with a fresh test key pair, a new salt and key every time, and refuses tampering', () => {
    const b = browser()
    const payload = JSON.stringify(payloadFor('OUT_FOR_DELIVERY', 'ord_abc'))
    const one = encrypt(payload, { p256dh: b.keys.publicKey, auth: b.auth })
    const two = encrypt(payload, { p256dh: b.keys.publicKey, auth: b.auth })
    assert.notEqual(b64url(one), b64url(two))
    const opened = decrypt(one, { privateKey: b.keys.privateKey, publicKey: b.keys.publicKey, auth: b.auth })
    assert.deepEqual(JSON.parse(opened.toString()), { title: 'MandiMangoes', body: 'Your MandiMangoes order is out for delivery', url: '/orders/ord_abc', tag: 'order-ord_abc' })
    // Header: 16-byte salt, record size 4096, 65-byte key id (our one-off public key).
    assert.equal(one.readUInt32BE(16), 4096)
    assert.equal(one.readUInt8(20), 65)
    const tampered = Buffer.from(one)
    tampered[tampered.length - 20] ^= 1
    assert.throws(() => decrypt(tampered, { privateKey: b.keys.privateKey, publicKey: b.keys.publicKey, auth: b.auth }))
    // Another browser's secret can't open it.
    assert.throws(() => decrypt(one, { privateKey: b.keys.privateKey, publicKey: b.keys.publicKey, auth: randomBytes(16) }))
    assert.throws(() => encrypt('x'.repeat(MAX_PAYLOAD + 1), { p256dh: b.keys.publicKey, auth: b.auth }), /too large/)
    assert.throws(() => encrypt('x', { p256dh: Buffer.alloc(65, 4), auth: b.auth }), /P-256/)
  })

  test('the VAPID token is an ES256 JWT for the push service origin, signed with our key', () => {
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', {
      publicKey: b64url(SERVER_KEYS.publicKey), privateKey: b64url(SERVER_KEYS.privateKey), subject: 'mailto:ops@mandimangoes.test', nowS: 1_800_000_000,
    })
    const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/)
    assert.equal(k, b64url(SERVER_KEYS.publicKey))
    const [h, c, s] = jwt.split('.')
    assert.deepEqual(JSON.parse(fromB64url(h)), { typ: 'JWT', alg: 'ES256' })
    assert.deepEqual(JSON.parse(fromB64url(c)), { aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + 12 * 3600, sub: 'mailto:ops@mandimangoes.test' })
    const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(SERVER_KEYS.publicKey.subarray(1, 33)), y: b64url(SERVER_KEYS.publicKey.subarray(33)) }, format: 'jwk' })
    assert.equal(verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, fromB64url(s)), true)
    // A private key that is not the public key's half is refused before anything is signed.
    assert.throws(() => vapidKey(b64url(SERVER_KEYS.publicKey), b64url(generateKeyPair().privateKey)), /does not belong/)
  })

  test('the real sender posts an encrypted body the browser can open, with the push headers, and follows no redirects', async () => {
    const b = browser()
    const seen = []
    const fakeFetch = async (url, init) => {
      seen.push({ url, init })
      return new Response(null, { status: 201 })
    }
    const send = vapidSender({ publicKey: b64url(SERVER_KEYS.publicKey), privateKey: b64url(SERVER_KEYS.privateKey), subject: 'mailto:ops@mandimangoes.test' }, fakeFetch)
    const r = await send({ endpoint: b.json.endpoint, p256dh: b.json.keys.p256dh, auth: b.json.keys.auth }, { payload: '{"hello":"there"}', urgency: 'high', topic: 'ord_1' })
    assert.deepEqual(r, { status: 201 })
    assert.equal(seen.length, 1)
    const { url, init } = seen[0]
    assert.equal(url, b.json.endpoint)
    assert.equal(init.method, 'POST')
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers['Content-Encoding'], 'aes128gcm')
    assert.equal(init.headers.TTL, String(24 * 3600))
    assert.equal(init.headers.Urgency, 'high')
    assert.equal(init.headers.Topic, 'ord_1')
    assert.match(init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/)
    assert.equal(decrypt(init.body, { privateKey: b.keys.privateKey, publicKey: b.keys.publicKey, auth: b.auth }).toString(), '{"hello":"there"}')
  })

  test('production preflight refuses push without a real provider, keys and contact', () => {
    assert.deepEqual(pushProblems({ WEB_PUSH: false }), { errors: [], warnings: [] })
    const pub = b64url(SERVER_KEYS.publicKey)
    const priv = b64url(SERVER_KEYS.privateKey)
    const good = { WEB_PUSH: true, WEB_PUSH_PROVIDER: 'vapid', VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv, VAPID_SUBJECT: 'mailto:ops@mandimangoes.in' }
    assert.deepEqual(pushProblems(good).errors, [])
    assert.match(pushProblems({ ...good, WEB_PUSH_PROVIDER: 'log' }).errors.join(), /not vapid/)
    assert.match(pushProblems({ ...good, VAPID_PRIVATE_KEY: '' }).errors.join(), /needs VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY/)
    assert.match(pushProblems({ ...good, VAPID_PRIVATE_KEY: b64url(generateKeyPair().privateKey) }).errors.join(), /unusable/)
    assert.match(pushProblems({ ...good, VAPID_SUBJECT: 'ops' }).errors.join(), /VAPID_SUBJECT/)
    // And checkProduction carries them, so a production start stops.
    assert.ok(checkProduction({ ...env, ...good, WEB_PUSH_PROVIDER: 'log' }).errors.some((e) => /not vapid/.test(e)))
  })
})

// ---------------------------------------------------------------- switches

describe('the switches the shop and panel read', () => {
  test('all off by default (Partner Network is on by default); each one on its own', async () => {
    const off = (await api.get('/v1/policy')).body.features
    assert.deepEqual(off, { installApp: false, push: false, tracking: false, favourites: false, sortFilter: false, referrals: false, funnel: false, multiGift: false, partnerNetwork: true, farmExperience: false, languages: false })
    Object.assign(env, { SHOP_INSTALL: true, SHOP_SORT_FILTER: true, FAVOURITES: true, LIVE_TRACKING: true })
    assert.deepEqual((await api.get('/v1/policy')).body.features, { installApp: true, push: false, tracking: true, favourites: true, sortFilter: true, referrals: false, funnel: false, multiGift: false, partnerNetwork: true, farmExperience: false, languages: false })
    // Push needs the flag and a key to subscribe with.
    env.WEB_PUSH = true
    assert.equal((await api.get('/v1/policy')).body.features.push, false)
    pushOnForTest()
    assert.equal((await api.get('/v1/policy')).body.features.push, true)

    const rider = await addRider()
    // /auth/me features also carries the trust pack's switches (docs/trust.md); this test checks the rider's one.
    assert.equal((await api.get('/admin/v1/auth/me', { token: rider })).body.features.riderRoute, true)
    env.LIVE_TRACKING = false
    assert.equal((await api.get('/admin/v1/auth/me', { token: rider })).body.features.riderRoute, false)
  })

  test('while a switch is off its routes do not exist', async () => {
    const cust = await customerToken(api)
    const token = cust.accessToken
    assert.equal((await api.get('/v1/me/push', { token })).status, 404)
    assert.equal((await api.put('/v1/me/push/subscription', browser().json, { token })).status, 404)
    assert.equal((await api.get('/v1/me/favourites', { token })).status, 404)
    assert.equal((await api.put('/v1/me/favourites/ALP-3', undefined, { token })).status, 404)
    assert.equal((await api.post('/v1/me/favourites/merge', { skus: ['ALP-3'] }, { token })).status, 404)
    // And they need a signed-in customer either way.
    pushOnForTest()
    env.FAVOURITES = true
    assert.equal((await api.get('/v1/me/push')).status, 401)
    assert.equal((await api.get('/v1/me/favourites')).status, 401)
  })
})

// ---------------------------------------------------------------- notifications

describe('browser notifications for order updates', () => {
  test('turning on takes only https subscriptions on known push services with real keys', async () => {
    pushOnForTest()
    const cust = await customerToken(api)
    const token = cust.accessToken
    const me = await api.get('/v1/me/push', { token })
    assert.deepEqual(me.body, { available: true, publicKey: b64url(SERVER_KEYS.publicKey), browsers: 0 })

    const b = browser()
    const bad = [
      { ...b.json, endpoint: 'https://evil.example/push' },
      { ...b.json, endpoint: 'http://fcm.googleapis.com/fcm/send/x' },
      { ...b.json, endpoint: 'https://fcm.googleapis.com:8443/fcm/send/x' },
      { ...b.json, endpoint: 'https://user:pw@fcm.googleapis.com/fcm/send/x' },
      { ...b.json, endpoint: 'https://127.0.0.1/fcm/send/x' },
      { ...b.json, endpoint: 'https://fcm.googleapis.com.evil.example/x' },
      { ...b.json, keys: { ...b.json.keys, p256dh: b64url(Buffer.alloc(65, 4)) } },
      { ...b.json, keys: { ...b.json.keys, auth: b64url(randomBytes(12)) } },
    ]
    for (const body of bad) {
      const r = await api.put('/v1/me/push/subscription', body, { token })
      assert.equal(r.status, 400, JSON.stringify(body))
      assert.ok(['BAD_SUBSCRIPTION', 'VALIDATION_ERROR'].includes(r.body.error.code), r.body.error.code)
    }
    assert.equal((await api.put('/v1/me/push/subscription', { ...b.json, extra: 1 }, { token })).status, 400)

    assert.equal((await api.put('/v1/me/push/subscription', b.json, { token })).status, 201)
    // A subdomain of an allowed "*." host is fine (Apple's push service).
    assert.equal((await api.put('/v1/me/push/subscription', browser('api.push.apple.com').json, { token })).status, 201)
    assert.equal((await api.get('/v1/me/push', { token })).body.browsers, 2)
    // Saving the same browser again does not add a row.
    assert.equal((await api.put('/v1/me/push/subscription', b.json, { token })).status, 201)
    assert.equal((await subRows(cust.customer.id)).length, 2)

    // Someone else can't turn this browser off; its owner can.
    const other = await customerToken(api)
    assert.equal((await api.del('/v1/me/push/subscription', { token: other.accessToken, body: { endpoint: b.json.endpoint } })).status, 204)
    assert.equal((await subRows(cust.customer.id)).length, 2)
    assert.equal((await api.del('/v1/me/push/subscription', { token, body: { endpoint: b.json.endpoint } })).status, 204)
    assert.equal((await subRows(cust.customer.id)).length, 1)
  })

  test('a browser belongs to whoever signed in on it last, and a customer keeps at most ten', async () => {
    pushOnForTest()
    const a = await customerToken(api)
    const b = await customerToken(api)
    const shared = browser()
    await api.put('/v1/me/push/subscription', shared.json, { token: a.accessToken })
    await api.put('/v1/me/push/subscription', shared.json, { token: b.accessToken })
    assert.equal((await subRows(a.customer.id)).length, 0)
    assert.equal((await subRows(b.customer.id)).length, 1)

    for (let i = 0; i < MAX_SUBSCRIPTIONS + 2; i++) {
      setNow(new Date(Date.parse('2026-10-15T05:00:00Z') + i * 1000))
      assert.equal((await api.put('/v1/me/push/subscription', browser().json, { token: a.accessToken })).status, 201)
    }
    assert.equal((await subRows(a.customer.id)).length, MAX_SUBSCRIPTIONS)
  })

  test('order steps are pushed beside WhatsApp, with nothing personal in them', async () => {
    pushOnForTest()
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const rider = await addRider()
    const cust = await customerToken(api)
    const b = browser()
    assert.equal((await api.put('/v1/me/push/subscription', b.json, { token: cust.accessToken })).status, 201)
    const calls = stubSender()

    const { id, date } = await paidOrder(cust)
    assert.deepEqual((await pushRows(cust.customer.id)).map((m) => [m.kind, m.status, m.order_id]), [['ORDER_CONFIRMED', 'PENDING', id]])
    // The WhatsApp message is still queued as before.
    assert.ok((await query(`SELECT 1 FROM notifications WHERE order_id = $1 AND kind = 'ORDER_CONFIRMED'`, [id])).rowCount)

    assert.equal(await sendDuePush(), 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].endpoint, b.json.endpoint)
    assert.deepEqual(JSON.parse(calls[0].payload), { title: 'MandiMangoes', body: 'Your MandiMangoes order is confirmed', url: `/orders/${id}`, tag: `order-${id}` })
    assert.equal(calls[0].topic, id)
    const [sent] = await pushRows(cust.customer.id)
    assert.equal(sent.status, 'SENT')
    assert.equal(sent.delivered, 1)

    await pack(id)
    assert.equal((await api.post('/admin/v1/manifest/dispatch', { date }, { token: rider })).status, 200)
    assert.equal(await sendDuePush(), 1)
    const out = calls.at(-1)
    assert.equal(JSON.parse(out.payload).body, 'Your MandiMangoes order is out for delivery')
    assert.equal(out.urgency, 'high')
    // Nothing about the customer: no phone, address, code, amount or order number.
    const order = (await api.get(`/v1/orders/${id}`, { token: cust.accessToken })).body
    for (const c of calls) {
      for (const secret of [cust.customer.phone, ADDRESS, '4th Cross', order.deliveryCode, String(order.total), String(order.number)]) {
        assert.equal(c.payload.includes(secret), false, `payload carries ${secret}`)
      }
    }
    // Sent once only.
    assert.equal(await sendDuePush(), 0)
    assert.equal(calls.length, 2)
  })

  test('a confirmation held for stock (INV-B) holds its push too; one push goes when stock is found', async () => {
    pushOnForTest()
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 2 } })
    const a = await customerToken(api)
    assert.equal((await api.put('/v1/me/push/subscription', browser().json, { token: a.accessToken })).status, 201)
    const calls = stubSender()
    const ca = await checkout(api, a.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])
    setNow(new Date(Date.parse(T0) + 12.5 * 60_000).toISOString()) // A's hold runs out
    const b = await customerToken(api)
    const cb = await checkout(api, b.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }]) // takes the boxes
    assert.equal(cb.status, 201)
    await api.post('/v1/dev/pay', { orderId: cb.body.orderId, outcome: 'captured' })
    await api.post('/v1/dev/pay', { orderId: ca.body.orderId, outcome: 'captured' }) // late, no stock anywhere
    assert.deepEqual((await pushRows(a.customer.id)).map((m) => [m.kind, m.status, m.last_error]), [['ORDER_CONFIRMED', 'SKIPPED', CONFIRMATION_HELD]])
    assert.equal(await sendDuePush(), 0)
    assert.equal(calls.length, 0)

    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 3 } })
    const r = await api.post(`/admin/v1/orders/${ca.body.orderId}/rebalance`, undefined, { token: admin })
    assert.deepEqual(r.body, { changed: true, atRisk: false })
    assert.equal(await sendDuePush(), 1)
    assert.deepEqual(calls.map((c) => JSON.parse(c.payload).body), ['Your MandiMangoes order is confirmed'])
    assert.equal(await sendDuePush(), 0)
    assert.equal(calls.length, 1)
  })

  test('a missed delivery that will not be retried on its own does not promise a retry', async () => {
    pushOnForTest()
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    assert.equal((await api.put('/v1/me/push/subscription', browser().json, { token: cust.accessToken })).status, 201)
    const first = await paidOrder(cust)
    const last = await paidOrder(cust)
    await sendDuePush()
    const calls = stubSender()
    const failNow = async (id) => {
      await pack(id)
      assert.equal((await api.post(`/admin/v1/orders/${id}/dispatch`, {}, { token: admin })).status, 204)
      const { attempt } = (await api.get(`/admin/v1/orders/${id}`, { token: admin })).body
      const f = await api.post(`/admin/v1/orders/${id}/delivery`, { outcome: 'FAILED', reason: 'NOT_HOME', attempt }, { token: admin })
      assert.equal(f.status, 200, JSON.stringify(f.body))
    }
    await failNow(first.id)
    // Two misses already: this third one is not rescheduled; staff call first.
    await query('UPDATE orders SET delivery_failures = 2 WHERE id = $1', [last.id])
    await failNow(last.id)
    assert.equal((await api.get(`/v1/orders/${last.id}`, { token: cust.accessToken })).body.retryScheduled, false)
    await sendDuePush()
    const said = Object.fromEntries(calls.map((c) => JSON.parse(c.payload)).map((p) => [p.url, p.body]))
    assert.equal(said[`/orders/${first.id}`], 'We missed you: your MandiMangoes order will be tried again')
    assert.equal(said[`/orders/${last.id}`], 'We missed you: MandiMangoes will be in touch about your order')
    assert.deepEqual((await query('SELECT kind, status FROM push_messages WHERE order_id = $1 AND kind LIKE $2', [last.id, 'DELIVERY_FAILED%'])).rows, [
      { kind: 'DELIVERY_FAILED_NO_RETRY', status: 'SENT' },
    ])
  })

  test('the maintenance loop sends them, and the real sender path encrypts for the browser', async () => {
    pushOnForTest()
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const b = browser()
    await api.put('/v1/me/push/subscription', b.json, { token: cust.accessToken })
    const posted = []
    usePushSender(
      vapidSender({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT }, async (url, init) => {
        posted.push({ url, init })
        return new Response(null, { status: 201 })
      }),
    )
    const { id } = await paidOrder(cust)
    const out = await runMaintenance({ forceAll: true })
    assert.equal(out.pushed, 1)
    assert.equal(posted.length, 1)
    assert.equal(posted[0].url, b.json.endpoint)
    const opened = JSON.parse(decrypt(posted[0].init.body, { privateKey: b.keys.privateKey, publicKey: b.keys.publicKey, auth: b.auth }).toString())
    assert.equal(opened.url, `/orders/${id}`)
  })

  test('a gone browser (404 or 410) is removed; a busy push service is retried; other refusals count up to removal', async () => {
    pushOnForTest()
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const gone = browser()
    const busy = browser('updates.push.services.mozilla.com')
    // now() keeps ticking from where a test puts it: set each time, so the order of the two browsers is certain.
    setNow('2026-10-15T04:30:00Z')
    await api.put('/v1/me/push/subscription', gone.json, { token: cust.accessToken })
    setNow('2026-10-15T04:30:05Z')
    await api.put('/v1/me/push/subscription', busy.json, { token: cust.accessToken })
    // First browser: 410. Second: 503, then a network error, then 201.
    const calls = stubSender([410, 503])
    await paidOrder(cust)
    assert.equal(await sendDuePush(), 0)
    assert.deepEqual((await subRows(cust.customer.id)).map((s) => s.endpoint), [busy.json.endpoint])
    let [m] = await pushRows(cust.customer.id)
    assert.equal(m.status, 'PENDING')
    assert.equal(m.attempts, 1)
    assert.match(m.last_error, /503/)
    // The error names the push service and the endpoint's last four characters, never the whole URL.
    assert.equal(m.last_error.includes(busy.json.endpoint), false)
    assert.ok(m.last_error.includes(endpointHint(busy.json.endpoint)))

    // Not due yet.
    assert.equal(await sendDuePush(), 0)
    assert.equal(calls.length, 2)
    setNow('2026-10-15T04:32:00Z')
    usePushSender(async () => {
      throw new Error('socket hang up')
    })
    assert.equal(await sendDuePush(), 0)
    ;[m] = await pushRows(cust.customer.id)
    assert.equal(m.attempts, 2)
    assert.equal(m.status, 'PENDING')
    setNow('2026-10-15T04:40:00Z')
    const later = stubSender([201])
    assert.equal(await sendDuePush(), 1)
    assert.equal(later.length, 1)
    ;[m] = await pushRows(cust.customer.id)
    assert.equal(m.status, 'SENT')

    // 403 (keys that don't match) five times in a row: the browser is dropped.
    const sub = (await subRows(cust.customer.id))[0]
    await query('UPDATE push_subscriptions SET failures = 4 WHERE id = $1', [sub.id])
    stubSender([403])
    await query(`INSERT INTO push_messages (id, customer_id, order_id, event_id, kind, next_attempt_at, created_at) SELECT 'psh_t', customer_id, order_id, 'evt_t', 'DELIVERED', $1, $1 FROM push_messages LIMIT 1`, [
      new Date('2026-10-15T04:40:00Z'),
    ])
    assert.equal(await sendDuePush(), 0)
    assert.equal((await subRows(cust.customer.id)).length, 0)
    const failed = (await pushRows(cust.customer.id)).find((r) => r.id === 'psh_t')
    assert.equal(failed.status, 'FAILED')
  })

  test('nothing is queued without the switch or without a browser; stale and old updates are skipped', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const calls = stubSender()
    // Off: even a stored browser gets nothing.
    pushOnForTest()
    await api.put('/v1/me/push/subscription', browser().json, { token: cust.accessToken })
    env.WEB_PUSH = false
    await paidOrder(cust)
    assert.equal((await pushRows(cust.customer.id)).length, 0)
    assert.equal(await sendDuePush(), 0)

    // On, but this customer never turned notifications on.
    pushOnForTest()
    const quiet = await customerToken(api)
    await paidOrder(quiet)
    assert.equal((await pushRows(quiet.customer.id)).length, 0)

    // Out for delivery, but delivered before it went: not sent late.
    const { id } = await paidOrder(cust)
    await query(`UPDATE push_messages SET status = 'SENT' WHERE customer_id = $1`, [cust.customer.id])
    await query(`INSERT INTO push_messages (id, customer_id, order_id, event_id, kind, next_attempt_at, created_at) VALUES ('psh_s', $1, $2, 'evt_s', 'OUT_FOR_DELIVERY', $3, $3)`, [
      cust.customer.id, id, new Date('2026-10-15T04:30:00Z'),
    ])
    assert.equal(await sendDuePush(), 0)
    assert.match((await pushRows(cust.customer.id)).find((r) => r.id === 'psh_s').last_error, /order is CONFIRMED now/)
    // Older than a day: skipped.
    await query(`INSERT INTO push_messages (id, customer_id, order_id, event_id, kind, next_attempt_at, created_at) VALUES ('psh_o', $1, $2, 'evt_o', 'ORDER_CONFIRMED', $3, $4)`, [
      cust.customer.id, id, new Date('2026-10-15T04:30:00Z'), new Date('2026-10-13T04:30:00Z'),
    ])
    assert.equal(await sendDuePush(), 0)
    assert.equal((await pushRows(cust.customer.id)).find((r) => r.id === 'psh_o').status, 'SKIPPED')
    assert.equal(calls.length, 0)

    // Finished messages go after 30 days; pending ones stay.
    await query(`UPDATE push_messages SET created_at = '2026-09-01T00:00:00Z'`)
    await query(`INSERT INTO push_messages (id, customer_id, order_id, event_id, kind, next_attempt_at, created_at) VALUES ('psh_p', $1, $2, 'evt_p', 'DELIVERED', $3, '2026-09-01T00:00:00Z')`, [
      cust.customer.id, id, new Date('2026-10-16T04:30:00Z'),
    ])
    await cleanupExpired()
    assert.deepEqual((await pushRows(cust.customer.id)).map((r) => r.id), ['psh_p'])
  })

  test('signing out everywhere, the export and deleting the account', async () => {
    pushOnForTest()
    env.FAVOURITES = true
    const cust = await customerToken(api)
    const token = cust.accessToken
    const b = browser()
    await api.put('/v1/me/push/subscription', b.json, { token })
    assert.equal((await api.put('/v1/me/favourites/ALP-3', undefined, { token })).status, 200)

    const exp = (await api.get('/v1/me/export', { token })).body
    assert.deepEqual(exp.favourites.map((f) => f.sku), ['ALP-3'])
    assert.equal(exp.notificationBrowsers.length, 1)
    assert.equal(exp.notificationBrowsers[0].pushService, 'fcm.googleapis.com')
    // The endpoint and keys are capabilities: never in the export.
    const text = JSON.stringify(exp)
    assert.equal(text.includes(b.json.endpoint), false)
    assert.equal(text.includes(b.json.keys.auth), false)

    assert.equal((await api.post('/v1/me/sign-out-everywhere', undefined, { token })).status, 204)
    assert.equal((await subRows(cust.customer.id)).length, 0)

    const again = await customerToken(api, cust.customer.phone)
    await api.put('/v1/me/push/subscription', b.json, { token: again.accessToken })
    await query(`INSERT INTO push_messages (id, customer_id, event_id, kind, next_attempt_at, created_at) VALUES ('psh_d', $1, 'evt_d', 'DELIVERED', now(), now())`, [cust.customer.id])
    assert.equal((await api.del('/v1/me', { token: again.accessToken })).status, 204)
    assert.equal((await subRows(cust.customer.id)).length, 0)
    assert.equal((await query('SELECT 1 FROM customer_favourites WHERE customer_id = $1', [cust.customer.id])).rowCount, 0)
    assert.equal((await pushRows(cust.customer.id))[0].status, 'SKIPPED')
  })
})

// ---------------------------------------------------------------- live tracking

describe('live tracking without GPS', () => {
  /** Three customers on one rider's run, in route order (same pincode: by order number). */
  async function run(addresses) {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const rider = await addRider()
    const stops = []
    for (const address of addresses) {
      const cust = await customerToken(api)
      const o = await paidOrder(cust, { address })
      await pack(o.id)
      stops.push({ cust, ...o })
    }
    const go = await api.post('/admin/v1/manifest/dispatch', { date: stops[0].date }, { token: rider })
    assert.equal(go.status, 200, JSON.stringify(go.body))
    assert.equal(go.body.dispatched.length, addresses.length)
    return { rider, stops }
  }
  const tracking = async (s) => (await api.get(`/v1/orders/${s.id}`, { token: s.cust.accessToken })).body.tracking

  test('"N stops away" counts the rider\'s stops still ahead, and drops as stops are done', async () => {
    env.LIVE_TRACKING = true
    const { rider, stops } = await run(['1 First Main, Koramangala', '2 Second Main, Koramangala', '3 Third Main, Koramangala'])
    // The manifest lists them in the same order the count uses.
    const manifest = (await api.get(`/admin/v1/manifest?date=${stops[0].date}`, { token: rider })).body
    assert.deepEqual(manifest.runs.flatMap((r) => r.stops.flatMap((s) => s.orders.map((o) => o.id))), stops.map((s) => s.id))

    assert.deepEqual(await tracking(stops[0]), { stopsAway: 0, minutesPerStop: 10, etaMinutes: 10 })
    assert.deepEqual(await tracking(stops[1]), { stopsAway: 1, minutesPerStop: 10, etaMinutes: 20 })
    assert.deepEqual(await tracking(stops[2]), { stopsAway: 2, minutesPerStop: 10, etaMinutes: 30 })

    // The first stop is delivered (with its code, as always): everyone behind moves up.
    const code = (await api.get(`/v1/orders/${stops[0].id}`, { token: stops[0].cust.accessToken })).body.deliveryCode
    assert.equal((await api.post(`/admin/v1/orders/${stops[0].id}/delivery`, { outcome: 'DELIVERED', code }, { token: rider })).status, 200)
    assert.equal(await tracking(stops[0]), null)
    assert.equal((await tracking(stops[2])).stopsAway, 1)
    // A missed stop is done for today too.
    assert.equal((await api.post(`/admin/v1/orders/${stops[1].id}/delivery`, { outcome: 'FAILED', reason: 'NOT_HOME', attempt: 1 }, { token: rider })).status, 200)
    assert.deepEqual(await tracking(stops[2]), { stopsAway: 0, minutesPerStop: 10, etaMinutes: 10 })

    // Minutes per stop is a selling rule.
    const cfg = (await api.get('/admin/v1/config', { token: admin })).body
    assert.equal((await api.put('/admin/v1/config', { rules: { ...cfg.rules, minutesPerStop: 121 } }, { token: admin })).status, 400)
    assert.equal((await api.put('/admin/v1/config', { rules: { ...cfg.rules, minutesPerStop: 15 }, confirmCode: 'manager123' }, { token: admin })).status, 200)
    assert.deepEqual(await tracking(stops[2]), { stopsAway: 0, minutesPerStop: 15, etaMinutes: 15 })
  })

  test('two orders to one address are one stop; others only ever see a count; off means no tracking', async () => {
    env.LIVE_TRACKING = true
    const { stops } = await run(['1 First Main, Koramangala', '1  first main, koramangala ', '9 Ninth Main, Koramangala'])
    assert.equal((await tracking(stops[1])).stopsAway, 0)
    assert.equal((await tracking(stops[2])).stopsAway, 1)
    // Only the order's owner sees it, and the answer has nothing about the other stops.
    assert.equal((await api.get(`/v1/orders/${stops[2].id}`, { token: stops[0].cust.accessToken })).status, 404)
    assert.deepEqual(Object.keys(await tracking(stops[2])).sort(), ['etaMinutes', 'minutesPerStop', 'stopsAway'])
    env.LIVE_TRACKING = false
    assert.equal(await tracking(stops[2]), null)
  })

  test('an order not out with a rider has no tracking', async () => {
    env.LIVE_TRACKING = true
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const o = await paidOrder(cust)
    assert.equal((await api.get(`/v1/orders/${o.id}`, { token: cust.accessToken })).body.tracking, null)
    // Out for delivery without a rider (sent by staff to no one): no count to give.
    await pack(o.id)
    assert.equal((await api.post(`/admin/v1/orders/${o.id}/dispatch`, undefined, { token: admin })).status, 204)
    assert.equal((await api.get(`/v1/orders/${o.id}`, { token: cust.accessToken })).body.tracking, null)
  })

  test('an older rules version without minutesPerStop loads with the default', async () => {
    const { loadConfig, getConfig } = await import('../src/config.js')
    const { minutesPerStop, ...older } = getConfig()
    void minutesPerStop
    await query(`INSERT INTO app_config (version, value, changed_by) SELECT MAX(version) + 1, $1, 'older' FROM app_config`, [older])
    assert.equal((await loadConfig()).rules.minutesPerStop, 10)
  })
})

// ---------------------------------------------------------------- favourites

describe('favourites', () => {
  test('heart, list, un-heart; only boxes on sale; each customer has their own', async () => {
    env.FAVOURITES = true
    const a = await customerToken(api)
    const b = await customerToken(api)
    const put = (c, sku) => api.put(`/v1/me/favourites/${sku}`, undefined, { token: c.accessToken })
    const list = async (c) => (await api.get('/v1/me/favourites', { token: c.accessToken })).body

    assert.deepEqual(await list(a), { items: [], max: 50 })
    const r = await put(a, 'ALP-3')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.items.map((i) => [i.sku, i.onSale, typeof i.price]), [['ALP-3', true, 'number']])
    assert.equal((await put(a, 'ALP-3')).body.items.length, 1)
    assert.equal((await put(a, 'NOPE-1')).status, 404)

    // B's list is B's own, and B can't take A's heart away.
    assert.deepEqual((await list(b)).items, [])
    assert.equal((await api.del('/v1/me/favourites/ALP-3', { token: b.accessToken })).status, 204)
    assert.equal((await list(a)).items.length, 1)

    // Taken off sale: still listed, marked, and can't be hearted anew.
    await query(`UPDATE products SET active = FALSE WHERE sku = 'ALP-3'`)
    await loadProducts()
    assert.equal((await list(a)).items[0].onSale, false)
    assert.equal((await put(b, 'ALP-3')).status, 404)
    await query(`UPDATE products SET active = TRUE WHERE sku = 'ALP-3'`)
    await loadProducts()

    assert.equal((await api.del('/v1/me/favourites/ALP-3', { token: a.accessToken })).status, 204)
    assert.deepEqual((await list(a)).items, [])
  })

  test('a guest\'s hearts merge on sign-in, skipping what is not on sale, up to the cap', async () => {
    env.FAVOURITES = true
    const cust = await customerToken(api)
    const token = cust.accessToken
    const skus = (await query('SELECT sku FROM products WHERE active ORDER BY sku')).rows.map((r) => r.sku)
    assert.ok(skus.length >= 2)
    await api.put(`/v1/me/favourites/${skus[0]}`, undefined, { token })
    const merged = await api.post('/v1/me/favourites/merge', { skus: [skus[0], skus[1], skus[1], 'GONE-1'] }, { token })
    assert.equal(merged.status, 200)
    assert.deepEqual(merged.body.items.map((i) => i.sku).sort(), [skus[0], skus[1]].sort())
    assert.deepEqual(merged.body.ignored, ['GONE-1'])
    assert.equal((await api.post('/v1/me/favourites/merge', { skus: 'ALP-3' }, { token })).status, 400)
    assert.equal((await api.post('/v1/me/favourites/merge', { skus: Array.from({ length: 51 }, (_, i) => `S-${i}`) }, { token })).status, 400)

    // The cap: 50 boxes on sale, then the 51st is refused (one at a time) or left out (merged).
    for (let i = 0; i < 50; i++) await query(`INSERT INTO products (sku, name, variety, price) VALUES ($1, $2, 'Alphonso', 100)`, [`FAV-${i}`, `Box ${i}`])
    await loadProducts()
    await query('DELETE FROM customer_favourites WHERE customer_id = $1', [cust.customer.id])
    const fill = await api.post('/v1/me/favourites/merge', { skus: Array.from({ length: 48 }, (_, i) => `FAV-${i}`) }, { token })
    assert.equal(fill.body.items.length, 48)
    const over = await api.post('/v1/me/favourites/merge', { skus: ['FAV-48', 'FAV-49', skus[0]] }, { token })
    assert.equal(over.body.items.length, 50)
    assert.deepEqual(over.body.ignored, [skus[0]])
    const full = await api.put(`/v1/me/favourites/${skus[0]}`, undefined, { token })
    assert.equal(full.status, 409)
    assert.equal(full.body.error.code, 'FAVOURITES_FULL')

    // An account join moves hearts across, keeping the joined account's own and the cap.
    const other = await customerToken(api)
    await query('INSERT INTO customer_favourites (customer_id, sku, created_at) VALUES ($1, $2, now()), ($1, $3, now())', [other.customer.id, skus[0], 'FAV-0'])
    await tx((c) => moveFavourites(c, other.customer.id, cust.customer.id))
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM customer_favourites WHERE customer_id = $1', [cust.customer.id])).rows[0].n, 50)
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM customer_favourites WHERE customer_id = $1', [other.customer.id])).rows[0].n, 0)
    await query('DELETE FROM customer_favourites WHERE customer_id = $1 AND sku = $2', [cust.customer.id, 'FAV-49'])
    await query('INSERT INTO customer_favourites (customer_id, sku, created_at) VALUES ($1, $2, now())', [other.customer.id, skus[0]])
    await tx((c) => moveFavourites(c, other.customer.id, cust.customer.id))
    assert.ok((await query('SELECT 1 FROM customer_favourites WHERE customer_id = $1 AND sku = $2', [cust.customer.id, skus[0]])).rows.length)
  })

  test('the previous release\'s account join still works on this schema: its delete takes these rows with it', async () => {
    pushOnForTest()
    env.FAVOURITES = true
    const cust = await customerToken(api)
    const token = cust.accessToken
    await api.put('/v1/me/favourites/ALP-3', undefined, { token })
    assert.equal((await api.put('/v1/me/push/subscription', browser().json, { token })).status, 201)
    await query(`INSERT INTO push_messages (id, customer_id, event_id, kind, next_attempt_at, created_at) VALUES ('psh_t', $1, 'ev_t', 'ORDER_CONFIRMED', now(), now())`, [cust.customer.id])
    // The previous release's join deletes the joining customer without knowing these tables.
    await query('DELETE FROM customers WHERE id = $1', [cust.customer.id])
    for (const t of ['customer_favourites', 'push_subscriptions', 'push_messages']) {
      assert.equal((await query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE customer_id = $1`, [cust.customer.id])).rows[0].n, 0, t)
    }
  })
})
