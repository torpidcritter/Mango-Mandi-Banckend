// Sign in with Google, for customers (then adding a phone) and for staff.
import { adminToken, client, closeAll, customerToken, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { query } from '../src/db.js'
import { useGoogleKeys } from '../src/google.js'

let srv
let api
let signKey

before(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  signKey = privateKey
  useGoogleKeys(createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] }))
  srv = await startServer()
  api = client(srv.base)
})
after(async () => {
  await srv.close()
  await closeAll()
})
beforeEach(resetDb)

const credential = (claims = {}, aud = 'test-client.apps.googleusercontent.com') =>
  new SignJWT({ email: 'asha@example.com', email_verified: true, name: 'Asha Rao', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer('https://accounts.google.com')
    .setAudience(aud)
    .setSubject(claims.sub ?? 'google-123')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signKey)

async function codeFor(path, phone, token) {
  const r = await api.post(path, { phone }, { token })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body.devCode
}

describe('sign in with Google', () => {
  test('the sign-in page learns the client ID', async () => {
    assert.equal((await api.get('/v1/auth/config')).body.googleClientId, 'test-client.apps.googleusercontent.com')
    assert.equal((await api.get('/admin/v1/auth/config')).body.googleClientId, 'test-client.apps.googleusercontent.com')
  })

  test('refuses forged, foreign and unverified tokens', async () => {
    const other = await generateKeyPair('RS256')
    const forged = await new SignJWT({ email: 'x@example.com', email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer('https://accounts.google.com')
      .setAudience('test-client.apps.googleusercontent.com').setSubject('g').setExpirationTime('5m').sign(other.privateKey)
    assert.equal((await api.post('/v1/auth/google', { credential: forged })).body.error.code, 'GOOGLE_INVALID')
    assert.equal((await api.post('/v1/auth/google', { credential: await credential({}, 'someone-else') })).body.error.code, 'GOOGLE_INVALID')
    assert.equal((await api.post('/v1/auth/google', { credential: await credential({ email_verified: false }) })).body.error.code, 'GOOGLE_UNVERIFIED')
  })

  test('a new customer signs in, must add a phone before ordering, and keeps one account', async () => {
    const r = await api.post('/v1/auth/google', { credential: await credential() })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual({ ...r.body.customer, id: undefined }, { id: undefined, phone: null, name: 'Asha Rao', email: 'asha@example.com' })
    const token = r.body.accessToken
    const again = await api.post('/v1/auth/google', { credential: await credential() })
    assert.equal(again.body.customer.id, r.body.customer.id)

    const pre = await api.post('/v1/preorders', { sku: 'ALP-3', stage: 'RIPE', qty: 1, weekStart: '2026-11-02', pincode: '560034', address: '12, 4th Cross, Koramangala' }, { token, headers: { 'Idempotency-Key': 'k1' } })
    assert.equal(pre.body.error.code, 'PHONE_REQUIRED')

    const code = await codeFor('/v1/me/phone/request', '9876500001', token)
    assert.equal((await api.post('/v1/me/phone/verify', { phone: '9876500001', code: '000000' }, { token })).body.error.code, 'OTP_INVALID')
    const v = await api.post('/v1/me/phone/verify', { phone: '9876500001', code }, { token })
    assert.equal(v.status, 200, JSON.stringify(v.body))
    assert.equal(v.body.customer.phone, '+919876500001')
    assert.equal(v.body.customer.id, r.body.customer.id)
    assert.equal((await api.get('/v1/me', { token: v.body.accessToken })).body.phone, '+919876500001')
  })

  test('a Google sign-in joins the account that already has the phone', async () => {
    const old = await customerToken(api, '9876500002')
    await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 1 }, { token: old.accessToken })
    const oldId = (await api.get('/v1/me', { token: old.accessToken })).body.id

    const g = await api.post('/v1/auth/google', { credential: await credential({ sub: 'google-456' }) })
    await api.post('/v1/cart/items', { sku: 'ALP-5', stage: 'RAW', qty: 2 }, { token: g.body.accessToken })
    const code = await codeFor('/v1/me/phone/request', '9876500002', g.body.accessToken)
    const v = await api.post('/v1/me/phone/verify', { phone: '9876500002', code }, { token: g.body.accessToken })
    assert.equal(v.status, 200, JSON.stringify(v.body))
    assert.equal(v.body.customer.id, oldId)
    const cart = await api.get('/v1/cart', { token: v.body.accessToken })
    assert.deepEqual(cart.body.lines.map((l) => `${l.sku}:${l.qty}`).sort(), ['ALP-3:1', 'ALP-5:2'])
    // Next time, Google lands straight on the joined account.
    assert.equal((await api.post('/v1/auth/google', { credential: await credential({ sub: 'google-456' }) })).body.customer.id, oldId)
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM customers')).rows[0].n, 1)

    // A different Google account can't take that number.
    const h = await api.post('/v1/auth/google', { credential: await credential({ sub: 'google-789', email: 'b@example.com' }) })
    const code2 = await codeFor('/v1/me/phone/request', '9876500002', h.body.accessToken)
    assert.equal((await api.post('/v1/me/phone/verify', { phone: '9876500002', code: code2 }, { token: h.body.accessToken })).body.error.code, 'PHONE_TAKEN')
  })

  test('the web shop keeps the refresh token in an httpOnly cookie', async () => {
    const r = await api.raw('POST', '/v1/auth/google', {
      raw: JSON.stringify({ credential: await credential() }),
      headers: { 'Content-Type': 'application/json', 'X-Session': 'cookie' },
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.refreshToken, undefined)
    const cookie = r.headers.get('set-cookie')
    assert.match(cookie, /mm_customer_rt=.+HttpOnly/i)
    const refreshed = await api.raw('POST', '/v1/auth/token/refresh', {
      raw: '{}',
      headers: { 'Content-Type': 'application/json', 'X-Session': 'cookie', Cookie: cookie.split(';')[0] },
    })
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body))
    assert.ok(refreshed.body.accessToken)
    assert.equal(refreshed.body.refreshToken, undefined)
  })

  test('staff sign in with Google only when the email is a staff email', async () => {
    const no = await api.post('/admin/v1/auth/google', { credential: await credential() })
    assert.equal(no.body.error.code, 'NOT_STAFF')
    const yes = await api.post('/admin/v1/auth/google', { credential: await credential({ email: 'Manager@MandiMangoes.test' }) })
    assert.equal(yes.status, 200, JSON.stringify(yes.body))
    const me = await api.get('/admin/v1/auth/me', { token: yes.body.accessToken })
    assert.equal(me.body.role, 'MANAGER')
    assert.ok(await adminToken(api))
  })
})
