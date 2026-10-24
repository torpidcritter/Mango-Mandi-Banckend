// Security and privacy fixes from the 23 Oct audit (SEC-01 to SEC-13).
import { adminToken, checkout, client, closeAll, customerToken, makeBatch, resetDb, startServer, T0 } from './helpers.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, beforeEach, describe, test } from 'node:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import sharp from 'sharp'
import { setNow } from '../src/clock.js'
import { query } from '../src/db.js'
import { env } from '../src/env.js'
import { useGoogleKeys } from '../src/google.js'
import { isCommonPassword } from '../src/passwords.js'
import { anonymiseOldOrders, monthsBefore } from '../src/retention.js'
import { main as eraseMain, normalisePhone } from '../ops/erase-customer.js'

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

/** A real (tiny) JPEG carrying EXIF, as a phone camera writes it. */
const photoWithExif = () =>
  sharp({ create: { width: 16, height: 16, channels: 3, background: '#f80' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'GPS-SECRET-12.9352N', Artist: 'rider-phone' } })
    .toBuffer()

async function packedOrder(cust) {
  const o = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
  assert.equal(o.status, 201, JSON.stringify(o.body))
  await api.post('/v1/dev/pay', { orderId: o.body.orderId, outcome: 'captured' })
  const id = o.body.orderId
  await api.patch(`/admin/v1/orders/${id}/status`, { status: 'PROCESSING' }, { token: admin })
  assert.equal((await api.post(`/admin/v1/orders/${id}/allocate`, undefined, { token: admin })).status, 204)
  assert.equal((await api.patch(`/admin/v1/orders/${id}/status`, { status: 'PACKED' }, { token: admin })).status, 204)
  return { id, date: o.body.deliveryDate }
}

async function newRider(email) {
  const add = await api.post('/admin/v1/staff', { email, role: 'RIDER', password: 'mango-run-2026-x' }, { token: admin })
  assert.equal(add.status, 201, JSON.stringify(add.body))
  return { id: add.body.id, token: await adminToken(api, email, 'mango-run-2026-x') }
}

const stopIds = (m) => m.body.runs.flatMap((r) => r.stops.flatMap((s) => s.orders.map((o) => o.id)))

describe('SEC-01: login codes stay out of answers when the shop is shared', () => {
  test('OTP_CODE_IN_RESPONSE=false: no devCode, and sign-in still works with the code', async () => {
    env.OTP_CODE_IN_RESPONSE = false
    try {
      const r = await api.post('/v1/auth/otp/request', { phone: '9876511111' })
      assert.equal(r.status, 200)
      assert.deepEqual(Object.keys(r.body).sort(), ['channel', 'sent'])
    } finally {
      env.OTP_CODE_IN_RESPONSE = true
    }
    assert.match((await api.post('/v1/auth/otp/request', { phone: '9876511112' })).body.devCode, /^\d{6}$/)
  })
})

describe('SEC-02: riders see only their own stops', () => {
  test('rider B gets 404 on rider A\'s stop; each manifest lists only its own stops', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 20 } })
    const a = await newRider('asha.rider@mandimangoes.test')
    const b = await newRider('bala.rider@mandimangoes.test')
    const one = await packedOrder(await customerToken(api))
    const two = await packedOrder(await customerToken(api))
    const free = await packedOrder(await customerToken(api))
    const date = one.date

    // Staff give one stop to each rider; the third is nobody's yet.
    assert.deepEqual((await api.get('/admin/v1/riders', { token: admin })).body.map((r) => r.email), ['asha.rider@mandimangoes.test', 'bala.rider@mandimangoes.test'])
    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    assert.equal((await api.post('/admin/v1/manifest/assign', { date, orderIds: [one.id], riderId: a.id }, { token: ops })).status, 200)
    assert.equal((await api.post('/admin/v1/manifest/assign', { date, orderIds: [two.id], riderId: b.id }, { token: admin })).status, 200)
    assert.equal((await api.post('/admin/v1/manifest/assign', { date, orderIds: [two.id], riderId: 'adm_nobody' }, { token: admin })).body.error.code, 'NOT_A_RIDER')
    assert.equal((await api.post('/admin/v1/manifest/assign', { date, riderId: a.id }, { token: a.token })).status, 403)

    const mA = await api.get(`/admin/v1/manifest?date=${date}`, { token: a.token })
    assert.deepEqual(stopIds(mA), [one.id])
    assert.equal(mA.body.unassigned, 1)
    assert.deepEqual(stopIds(await api.get(`/admin/v1/manifest?date=${date}`, { token: b.token })), [two.id])
    // Staff see every stop and who has it.
    const all = (await api.get(`/admin/v1/manifest?date=${date}`, { token: admin })).body.runs.flatMap((r) => r.stops.flatMap((s) => s.orders))
    assert.equal(all.find((o) => o.id === one.id).rider.email, 'asha.rider@mandimangoes.test')
    assert.equal(all.find((o) => o.id === free.id).rider, null)

    // Another rider's stop is not there for B: sending out, photos, delivery all 404.
    assert.equal((await api.post(`/admin/v1/orders/${one.id}/dispatch`, undefined, { token: b.token })).status, 404)
    assert.equal((await api.post(`/admin/v1/orders/${one.id}/delivery`, { outcome: 'FAILED', reason: 'NOT_HOME', attempt: 1 }, { token: b.token })).status, 404)
    assert.equal((await api.get(`/admin/v1/orders/${one.id}/delivery-photos/x`, { token: b.token })).status, 404)
    // An unassigned stop is reachable only to take it, by sending it out.
    assert.equal((await api.post(`/admin/v1/orders/${free.id}/delivery`, { outcome: 'FAILED', reason: 'NOT_HOME', attempt: 1 }, { token: b.token })).status, 404)
    const run = await api.post('/admin/v1/manifest/dispatch', { date }, { token: b.token })
    assert.deepEqual(run.body.dispatched.length, 2, JSON.stringify(run.body)) // their own and the free one
    assert.deepEqual(stopIds(await api.get(`/admin/v1/manifest?date=${date}`, { token: b.token })).sort(), [two.id, free.id].sort())
    assert.equal((await query('SELECT rider_id FROM orders WHERE id = $1', [free.id])).rows[0].rider_id, b.id)
    // A's stop was not taken by B's run.
    assert.equal((await query('SELECT status, rider_id FROM orders WHERE id = $1', [one.id])).rows[0].rider_id, a.id)
    assert.equal((await api.post(`/admin/v1/orders/${free.id}/dispatch`, undefined, { token: a.token })).status, 404)

    // Removing a rider puts their stops back in the pool.
    assert.equal((await api.del(`/admin/v1/staff/${b.id}`, { token: admin })).status, 204)
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM orders WHERE rider_id = $1', [b.id])).rows[0].n, 0)
  })

  test('a rider no longer sees a stop delivered before today', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const a = await newRider('asha.rider@mandimangoes.test')
    const o = await packedOrder(await customerToken(api))
    assert.equal((await api.post(`/admin/v1/orders/${o.id}/dispatch`, undefined, { token: a.token })).status, 204)
    const jpeg = await photoWithExif()
    const pic = await api.raw('POST', `/admin/v1/orders/${o.id}/delivery-photos`, { token: a.token, headers: { 'Content-Type': 'image/jpeg' }, raw: jpeg })
    assert.equal(pic.status, 201, JSON.stringify(pic.body))
    // SEC-13: the stored photo is re-encoded, without the phone's EXIF.
    const stored = (await query('SELECT bytes, mime FROM delivery_photos WHERE id = $1', [pic.body.id])).rows[0]
    assert.equal(stored.mime, 'image/jpeg')
    assert.ok(!stored.bytes.includes('GPS-SECRET'), 'EXIF kept')
    assert.ok(jpeg.includes('GPS-SECRET'), 'the test photo had EXIF')
    const done = await api.post(`/admin/v1/orders/${o.id}/delivery`, { outcome: 'DELIVERED', photoId: pic.body.id, receivedBy: 'Security guard' }, { token: a.token })
    assert.equal(done.status, 200, JSON.stringify(done.body))
    assert.deepEqual(stopIds(await api.get(`/admin/v1/manifest?date=${o.date}`, { token: a.token })), [o.id]) // still today's run

    setNow(new Date(Date.parse(`${o.date}T04:30:00Z`) + 86_400_000)) // the next day
    try {
      assert.deepEqual(stopIds(await api.get(`/admin/v1/manifest?date=${o.date}`, { token: a.token })), [])
      assert.equal((await api.get(`/admin/v1/orders/${o.id}/delivery-photos/${pic.body.id}`, { token: a.token })).status, 404)
      // Staff still see it.
      assert.deepEqual(stopIds(await api.get(`/admin/v1/manifest?date=${o.date}`, { token: admin })), [o.id])
    } finally {
      setNow(T0)
    }
  })
})

describe('SEC-05: retention, export and erasure by request', () => {
  test('a year after delivery the order keeps its amounts but not the customer details', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const paid = async (key) => {
      const o = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }], { key })
      assert.equal(o.status, 201, JSON.stringify(o.body))
      await api.post('/v1/dev/pay', { orderId: o.body.orderId, outcome: 'captured' })
      return o
    }
    const old = await paid('k1')
    const recent = await paid('k2')
    const owed = await paid('k3')
    await query(
      `UPDATE orders SET status = 'DELIVERED', delivery_date = '2025-09-01', gift_recipient_name = 'Asha', gift_recipient_phone = '+919811122233', gift_message = 'Happy Diwali'
        WHERE id = ANY($1)`,
      [[old.body.orderId, owed.body.orderId]],
    )
    await query(`UPDATE orders SET status = 'DELIVERED' WHERE id = $1`, [recent.body.orderId])
    await query(`UPDATE orders SET refund_requested_at = now() WHERE id = $1`, [owed.body.orderId])
    await query(
      `INSERT INTO delivery_attempts (id, order_id, outcome, method, received_by, lat, lng, actor, created_at)
       VALUES ('dat_old', $1, 'DELIVERED', 'code', 'Neighbour', 12.9, 77.6, 'rider', now())`,
      [old.body.orderId],
    )
    const before = (await query('SELECT total, subtotal FROM orders WHERE id = $1', [old.body.orderId])).rows[0]

    assert.equal(monthsBefore('2026-10-15', 12), '2025-10-15')
    assert.equal(monthsBefore('2026-03-31', 1), '2026-02-28')
    assert.equal(await anonymiseOldOrders(), 1)
    const o = (await query('SELECT * FROM orders WHERE id = $1', [old.body.orderId])).rows[0]
    for (const k of ['customer_name', 'phone', 'delivery_address', 'gift_recipient_name', 'gift_recipient_phone', 'gift_message']) assert.equal(o[k], null, k)
    assert.ok(o.pii_removed_at)
    assert.equal(o.total, before.total)
    assert.equal(o.subtotal, before.subtotal)
    const att = (await query("SELECT * FROM delivery_attempts WHERE id = 'dat_old'")).rows[0]
    assert.deepEqual([att.lat, att.lng, att.received_by], [null, null, null])
    // Recent orders, and money still owed back, keep their details.
    assert.ok((await query('SELECT phone FROM orders WHERE id = $1', [recent.body.orderId])).rows[0].phone)
    assert.ok((await query('SELECT phone FROM orders WHERE id = $1', [owed.body.orderId])).rows[0].phone)
    assert.equal(await anonymiseOldOrders(), 0, 'once only')
  })

  test('GET /v1/me/export gives the customer their own data, and nobody else\'s', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const me = await customerToken(api)
    const other = await customerToken(api)
    const mine = await checkout(api, me.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    await checkout(api, other.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    const r = await api.get('/v1/me/export', { token: me.accessToken })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.headers.get('cache-control'), 'no-store')
    assert.match(r.headers.get('content-disposition'), /attachment/)
    assert.equal(r.body.account.id, me.customer.id)
    assert.deepEqual(r.body.orders.map((o) => o.id), [mine.body.orderId])
    assert.equal(r.body.orders[0].items.length, 1)
    assert.equal(r.body.orders[0].delivery_address, '12, 4th Cross, Koramangala, Bengaluru')
    for (const k of ['addresses', 'preorders', 'claims', 'ratings', 'reviews', 'stockAlerts']) assert.ok(Array.isArray(r.body[k]), k)
    assert.equal((await api.get('/v1/me/export')).status, 401)
  })

  test('ops/erase-customer.js erases an account found by phone, only with --yes', async () => {
    const cust = await customerToken(api, '9876522222')
    assert.equal(normalisePhone('098765 22222'), '+919876522222')
    assert.equal(normalisePhone('12345'), null)
    const logs = []
    const realLog = console.log
    console.log = (...a) => logs.push(a.join(' '))
    try {
      await eraseMain(['--phone', '98765-22222'])
      assert.ok((await query('SELECT 1 FROM customers WHERE id = $1 AND deleted_at IS NULL', [cust.customer.id])).rowCount, 'not deleted without --yes')
      await eraseMain(['--phone', '9876522222', '--yes'])
    } finally {
      console.log = realLog
    }
    assert.match(logs.join('\n'), new RegExp(`Deleted ${cust.customer.id}`))
    const row = (await query('SELECT phone, deleted_at FROM customers WHERE id = $1', [cust.customer.id])).rows[0]
    assert.equal(row.phone, null)
    assert.ok(row.deleted_at)
    assert.equal((await api.get('/v1/me', { token: cust.accessToken })).status, 401)
  })
})

describe('SEC-06: signed-in answers are not cached', () => {
  test('no-store on /v1/me, staff order pages and sign-in answers', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const o = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal((await api.get('/v1/me', { token: cust.accessToken })).headers.get('cache-control'), 'no-store')
    assert.equal((await api.get(`/v1/orders/${o.body.orderId}`, { token: cust.accessToken })).headers.get('cache-control'), 'no-store')
    assert.equal((await api.get(`/admin/v1/orders/${o.body.orderId}`, { token: admin })).headers.get('cache-control'), 'no-store')
    assert.equal((await api.post('/admin/v1/auth/login', { email: 'manager@mandimangoes.test', password: 'manager123' })).headers.get('cache-control'), 'no-store')
    const code = (await api.post('/v1/auth/otp/request', { phone: '9876533333' })).body.devCode
    assert.equal((await api.post('/v1/auth/otp/verify', { phone: '9876533333', code })).headers.get('cache-control'), 'no-store')
  })
})

describe('SEC-09: staff passwords', () => {
  test('at least 12 characters and not a common password', async () => {
    assert.ok(isCommonPassword('qwerty123456'))
    assert.ok(isCommonPassword('Password1234!'))
    assert.ok(isCommonPassword('aaaaaaaaaaaa'))
    assert.ok(!isCommonPassword('mango-run-2026-x'))
    const add = (password) => api.post('/admin/v1/staff', { email: 'new@mandimangoes.test', role: 'PACKER', password }, { token: admin })
    assert.equal((await add('short-pass1')).status, 400) // 11 characters
    const common = await add('1q2w3e4r5t6y')
    assert.equal(common.status, 400)
    assert.match(JSON.stringify(common.body), /too common/)
    assert.equal((await add('mandimangoes123')).status, 400)
    assert.equal((await add('ripe-alphonso-crates-7')).status, 201)
  })

  test('staff change their own password; other sessions end', async () => {
    const add = await api.post('/admin/v1/staff', { email: 'pia@mandimangoes.test', role: 'PACKER', password: 'first-long-pass-1' }, { token: admin })
    assert.equal(add.status, 201)
    const login = () => api.post('/admin/v1/auth/login', { email: 'pia@mandimangoes.test', password: 'first-long-pass-1' })
    const phone = (await login()).body.accessToken
    const laptop = await login()
    const cookie = laptop.headers.get('set-cookie').split(';')[0]
    const token = laptop.body.accessToken
    const change = (body, t = token) => api.post('/admin/v1/me/password', body, { token: t })

    assert.equal((await change({ currentPassword: 'wrong-one-entirely', newPassword: 'second-long-pass-2' })).body.error.code, 'WRONG_PASSWORD')
    assert.equal((await change({ currentPassword: 'first-long-pass-1', newPassword: 'qwerty123456' })).status, 400)
    assert.equal((await change({ currentPassword: 'first-long-pass-1', newPassword: 'first-long-pass-1' })).body.error.code, 'SAME_PASSWORD')
    const ok = await change({ currentPassword: 'first-long-pass-1', newPassword: 'second-long-pass-2' })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    // This session carries on with the new token; the old tokens and the other refresh cookie are done.
    assert.equal((await api.get('/admin/v1/auth/me', { token: ok.body.accessToken })).status, 200)
    assert.equal((await api.get('/admin/v1/auth/me', { token: phone })).status, 401)
    assert.equal((await api.post('/admin/v1/auth/refresh', undefined, { headers: { Cookie: cookie } })).status, 401)
    assert.equal((await login()).status, 401)
    assert.equal((await api.post('/admin/v1/auth/login', { email: 'pia@mandimangoes.test', password: 'second-long-pass-2' })).status, 200)
  })
})

describe('SEC-13: smaller items', () => {
  test('sign out everywhere ends every session and every access token', async () => {
    const phone = '9876544444'
    const first = await customerToken(api, phone)
    const second = await customerToken(api, phone)
    assert.equal((await api.get('/v1/me', { token: first.accessToken })).status, 200)
    assert.equal((await api.post('/v1/me/sign-out-everywhere', undefined, { token: second.accessToken })).status, 204)
    for (const t of [first.accessToken, second.accessToken]) assert.equal((await api.get('/v1/me', { token: t })).status, 401)
    assert.equal((await api.post('/v1/auth/token/refresh', { refreshToken: first.refreshToken })).status, 401)
    // Signing in again works, with the new session version.
    const again = await customerToken(api, phone)
    assert.equal((await api.get('/v1/me', { token: again.accessToken })).status, 200)
    const refreshed = await api.post('/v1/auth/token/refresh', { refreshToken: again.refreshToken })
    assert.equal((await api.get('/v1/me', { token: refreshed.body.accessToken })).status, 200)
  })

  test('OTP_PEPPER: a code sent before it was set still works; new codes use it', async () => {
    const code = (await api.post('/v1/auth/otp/request', { phone: '9876555555' })).body.devCode
    env.OTP_PEPPER = 'a-separate-otp-pepper'
    try {
      assert.equal((await api.post('/v1/auth/otp/verify', { phone: '9876555555', code })).status, 200)
      const next = (await api.post('/v1/auth/otp/request', { phone: '9876555556' })).body.devCode
      const stored = (await query("SELECT code FROM otps WHERE phone = '+919876555556'")).rows[0].code
      assert.equal(stored, createHash('sha256').update(`a-separate-otp-pepper:+919876555556:${next}`).digest('hex'))
      assert.equal((await api.post('/v1/auth/otp/verify', { phone: '9876555556', code: next })).status, 200)
    } finally {
      env.OTP_PEPPER = ''
    }
  })

  test('STAFF_GOOGLE_HD limits staff Google sign-in to the shop\'s domain', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256')
    useGoogleKeys(createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] }))
    const credential = (claims) =>
      new SignJWT({ email: 'manager@mandimangoes.test', email_verified: true, ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer('https://accounts.google.com')
        .setAudience(env.GOOGLE_CLIENT_ID).setSubject('g-1').setIssuedAt().setExpirationTime('5m').sign(privateKey)
    env.STAFF_GOOGLE_HD = 'mandimangoes.test'
    try {
      assert.equal((await api.post('/admin/v1/auth/google', { credential: await credential({}) })).body.error.code, 'NOT_STAFF')
      assert.equal((await api.post('/admin/v1/auth/google', { credential: await credential({ hd: 'gmail.example' }) })).body.error.code, 'NOT_STAFF')
      assert.equal((await api.post('/admin/v1/auth/google', { credential: await credential({ hd: 'mandimangoes.test' }) })).status, 200)
    } finally {
      env.STAFF_GOOGLE_HD = ''
    }
    assert.equal((await api.post('/admin/v1/auth/google', { credential: await credential({}) })).status, 200)
  })

  test('the metrics token and the WhatsApp verify token are checked exactly', async () => {
    env.METRICS_TOKEN = 'metrics-secret'
    try {
      assert.equal((await api.get('/metrics', { token: 'metrics-secreT' })).status, 401)
      assert.equal((await api.get('/metrics', { token: 'metrics-secret-and-more' })).status, 401)
      assert.equal((await api.get('/metrics')).status, 401)
      assert.equal((await api.get('/metrics', { token: 'metrics-secret' })).status, 200)
    } finally {
      env.METRICS_TOKEN = ''
    }
    const verify = (t) => api.get(`/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=42`)
    assert.equal((await verify('wa_verify_tesT')).status, 403)
    assert.equal((await verify('wa_verify_test&hub.verify_token=x')).status, 403)
    const ok = await verify('wa_verify_test')
    assert.equal(ok.status, 200)
    assert.equal(ok.body, 42)
  })

  test('claim photos are re-encoded without EXIF', async () => {
    const cust = await customerToken(api)
    const jpeg = await photoWithExif()
    const up = await api.raw('POST', '/v1/claims/photos', { token: cust.accessToken, headers: { 'Content-Type': 'image/jpeg' }, raw: jpeg })
    assert.equal(up.status, 201, JSON.stringify(up.body))
    const row = (await query('SELECT bytes, mime FROM claim_photos WHERE id = $1', [up.body.id])).rows[0]
    assert.equal(row.mime, 'image/jpeg')
    assert.ok(!row.bytes.includes('GPS-SECRET'))
    // A file that only starts like a JPEG is refused now that it must decode.
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)])
    assert.equal((await api.raw('POST', '/v1/claims/photos', { token: cust.accessToken, headers: { 'Content-Type': 'image/jpeg' }, raw: fake })).body.error.code, 'PHOTO_INVALID')
  })
})
