// Security audit fixes: refresh limits apart from sign-in limits (SEC-2),
// per-account staff password lockout and two-step for every role (SEC-4),
// login-code limits per number and address (SEC-5), manager setup codes for
// two-step (SEC-6), staff tokens checked on every request (SEC-8), claim photo
// links (SEC-9), login codes kept out of logs (SEC-11), and the dev routes'
// explicit opt-in (PAY-7).
import { adminToken, client, closeAll, customerToken, resetDb, startServer, T0 } from './helpers.js'
import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { now, setNow, todayIST } from '../src/clock.js'
import { query } from '../src/db.js'
import { devRoutesOn, env } from '../src/env.js'
import { logger } from '../src/logger.js'
import { isOwnPhotoUrl } from '../src/photos.js'
import { enforceLimitsInTests } from '../src/ratelimit.js'
import { jioSender, logOnly } from '../src/sms.js'
import { codeAt, stepAt } from '../src/totp.js'

let srv
let api
before(async () => {
  srv = await startServer()
  api = client(srv.base)
})
after(async () => {
  await srv.close()
  await closeAll()
})
beforeEach(() => resetDb())
afterEach(() => {
  enforceLimitsInTests(false)
  env.STAFF_TWO_STEP = 'optional'
  setNow(T0)
})

const later = (s) => setNow(new Date(now().getTime() + s * 1000).toISOString())
const totp = (secret) => codeAt(secret, stepAt(now().getTime()))
const MANAGER = { email: 'manager@mandimangoes.test', password: 'manager123' }
const PACKER = { email: 'packer@mandimangoes.test', password: 'packer123' }
const limitKey = async (pattern) => (await query('SELECT key FROM rate_limits WHERE key LIKE $1', [pattern])).rows.map((r) => r.key)
const setHits = (key, hits) =>
  query('INSERT INTO rate_limits (key, hits, reset_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET hits = $2, reset_at = $3', [
    key, hits, new Date(now().getTime() + 3_600_000),
  ])
const staffId = async (email) => (await query('SELECT id FROM admin_users WHERE email = $1', [email])).rows[0].id

describe('SEC-2: token refresh has its own limit', () => {
  test('a used-up sign-in limit on the address does not stop refreshes; refreshes are counted per person', async () => {
    enforceLimitsInTests(true)
    const me = await customerToken(api)
    const [ipKey] = await limitKey('otp-ip:%')
    assert.ok(ipKey, 'the sign-in limiter counted the address')
    await setHits(ipKey, 100_000)
    assert.equal((await api.post('/v1/auth/otp/request', { phone: '9876500111' })).status, 429)

    // 31 refreshes from the same address all go through.
    let rt = me.refreshToken
    for (let i = 0; i < 31; i++) {
      const r = await api.post('/v1/auth/token/refresh', { refreshToken: rt })
      assert.equal(r.status, 200, `refresh ${i + 1}: ${JSON.stringify(r.body)}`)
      rt = r.body.refreshToken
    }
    assert.deepEqual(await limitKey('refresh-customer:%'), [`refresh-customer:user:${me.customer.id}`])
    await setHits(`refresh-customer:user:${me.customer.id}`, 60)
    const limited = await api.post('/v1/auth/token/refresh', { refreshToken: rt })
    assert.equal(limited.status, 429)
    // Someone else on the same address is unaffected.
    const other = await customerToken(api, '9876500222').catch(() => null)
    assert.equal(other, null, 'sign-in is still limited on this address')
    await setHits(ipKey, 0)
    const fresh = await customerToken(api, '9876500333')
    assert.equal((await api.post('/v1/auth/token/refresh', { refreshToken: fresh.refreshToken })).status, 200)
  })

  test('staff refresh no longer shares the password limit', async () => {
    enforceLimitsInTests(true)
    const login = await api.post('/admin/v1/auth/login', MANAGER)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    const [ipKey] = await limitKey('staff-auth:%')
    await setHits(ipKey, 100_000)
    assert.equal((await api.post('/admin/v1/auth/login', MANAGER)).status, 429)
    assert.equal((await api.post('/admin/v1/auth/refresh', undefined, { headers: { Cookie: cookie } })).status, 200)
  })
})

describe('SEC-5: login-code limits per number and address', () => {
  const phone = '9876511111'
  const full = `+91${phone}`

  test('another address using up its allowance for a number does not block the owner', async () => {
    const day = todayIST()
    await setHits(`otp-phone-ip-hour:${full}:203.0.113.9`, 50)
    await setHits(`otp-phone-ip-day:${full}:203.0.113.9:${day}`, 50)
    const r = await api.post('/v1/auth/otp/request', { phone })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal((await api.post('/v1/auth/otp/verify', { phone, code: r.body.devCode })).status, 200)
  })

  test('one address gets 5 codes an hour; a refused request leaves the last code working', async () => {
    let last
    for (let i = 0; i < 5; i++) {
      last = await api.post('/v1/auth/otp/request', { phone })
      assert.equal(last.status, 200, JSON.stringify(last.body))
    }
    const refused = await api.post('/v1/auth/otp/request', { phone })
    assert.equal(refused.status, 429)
    assert.equal(refused.body.error.code, 'OTP_LIMIT')
    assert.equal((await api.post('/v1/auth/otp/verify', { phone, code: last.body.devCode })).status, 200)
  })

  test('a number gets at most 16 codes a day from all addresses, and 3 tries per code (48 guesses, no more than before)', async () => {
    await setHits(`otp-phone-day:${full}:${todayIST()}`, 16)
    assert.equal((await api.post('/v1/auth/otp/request', { phone })).body.error.code, 'OTP_LIMIT')
    await setHits(`otp-phone-day:${full}:${todayIST()}`, 0)
    const r = await api.post('/v1/auth/otp/request', { phone })
    const wrong = r.body.devCode === '000000' ? '111111' : '000000'
    for (let i = 0; i < 3; i++) assert.equal((await api.post('/v1/auth/otp/verify', { phone, code: wrong })).body.error.code, 'OTP_INVALID')
    assert.equal((await api.post('/v1/auth/otp/verify', { phone, code: r.body.devCode })).body.error.code, 'OTP_LOCKED')
  })
})

describe('SEC-4: staff password lockout and two-step for every role', () => {
  test('10 wrong passwords lock the account for 15 minutes, known or unknown email alike', async () => {
    for (let i = 0; i < 10; i++) assert.equal((await api.post('/admin/v1/auth/login', { ...MANAGER, password: 'wrong-password' })).status, 401)
    const locked = await api.post('/admin/v1/auth/login', MANAGER)
    assert.equal(locked.status, 429)
    assert.equal(locked.body.error.code, 'ACCOUNT_LOCKED')
    // Someone else's account is not affected.
    assert.equal((await api.post('/admin/v1/auth/login', PACKER)).status, 200)
    // An unknown email answers the same way, so a lock says nothing about whether an account exists.
    for (let i = 0; i < 10; i++) await api.post('/admin/v1/auth/login', { email: 'nobody@mandimangoes.test', password: 'x' })
    assert.equal((await api.post('/admin/v1/auth/login', { email: 'nobody@mandimangoes.test', password: 'x' })).body.error.code, 'ACCOUNT_LOCKED')
    later(15 * 60 + 1)
    assert.equal((await api.post('/admin/v1/auth/login', MANAGER)).status, 200)
  })

  test('a manager setting a new password lifts the lock; a right password clears the count', async () => {
    const manager = await adminToken(api)
    for (let i = 0; i < 9; i++) await api.post('/admin/v1/auth/login', { ...PACKER, password: 'wrong-password' })
    assert.equal((await api.post('/admin/v1/auth/login', PACKER)).status, 200)
    for (let i = 0; i < 9; i++) await api.post('/admin/v1/auth/login', { ...PACKER, password: 'wrong-password' })
    assert.equal((await api.post('/admin/v1/auth/login', PACKER)).status, 200)
    for (let i = 0; i < 10; i++) await api.post('/admin/v1/auth/login', { ...PACKER, password: 'wrong-password' })
    assert.equal((await api.post('/admin/v1/auth/login', PACKER)).status, 429)
    const id = await staffId(PACKER.email)
    assert.equal((await api.patch(`/admin/v1/staff/${id}`, { password: 'a-new-password-1' }, { token: manager })).status, 200)
    assert.equal((await api.post('/admin/v1/auth/login', { ...PACKER, password: 'a-new-password-1' })).status, 200)
  })

  test('with STAFF_TWO_STEP=all (the production default) packers must set up two-step too', async () => {
    env.STAFF_TWO_STEP = 'all'
    const packer = await adminToken(api, PACKER.email, PACKER.password)
    assert.equal((await api.get('/admin/v1/pack-list', { token: packer })).body.error.code, 'TWO_STEP_SETUP_REQUIRED')
  })
})

describe('SEC-6: setting up two-step needs a code from a manager', () => {
  async function enrol(token, body) {
    const setup = await api.post('/admin/v1/me/two-step/setup', body, { token })
    if (setup.status !== 200) return setup
    return api.post('/admin/v1/me/two-step/enable', { code: totp(setup.body.secret) }, { token })
  }

  test('the password alone is not enough where two-step is required', async () => {
    env.STAFF_TWO_STEP = 'all'
    // The first manager needs no code.
    const first = await api.post('/admin/v1/auth/login', MANAGER)
    const on = await enrol(first.body.accessToken)
    assert.equal(on.status, 200, JSON.stringify(on.body))
    const manager = on.body.accessToken

    const packer = await adminToken(api, PACKER.email, PACKER.password)
    assert.equal((await api.get('/admin/v1/auth/me', { token: packer })).body.twoStep.setupCodeNeeded, true)
    assert.equal((await enrol(packer)).body.error.code, 'SETUP_CODE_REQUIRED')
    assert.equal((await enrol(packer, { setupCode: 'abcd-efgh' })).body.error.code, 'WRONG_SETUP_CODE')

    const id = await staffId(PACKER.email)
    assert.equal((await api.post(`/admin/v1/staff/${id}/two-step/setup-code`, undefined, { token: packer })).status, 403)
    const issued = await api.post(`/admin/v1/staff/${id}/two-step/setup-code`, undefined, { token: manager })
    assert.equal(issued.status, 200)
    assert.match(issued.body.setupCode, /^[a-z0-9]{4}-[a-z0-9]{4}$/)
    // Typed without the dash and in capitals, it still works; it is used up once two-step is on.
    const done = await enrol(packer, { setupCode: issued.body.setupCode.replace('-', '').toUpperCase() })
    assert.equal(done.status, 200, JSON.stringify(done.body))
    assert.equal((await api.post(`/admin/v1/staff/${id}/two-step/setup-code`, undefined, { token: manager })).body.error.code, 'TWO_STEP_ON')
    // The code never reaches the audit trail.
    const { rows } = await query("SELECT detail FROM staff_audit WHERE action = 'POST /me/two-step/setup'")
    assert.ok(rows.every((r) => !JSON.stringify(r.detail ?? {}).includes(issued.body.setupCode)))
  })

  test('a new person comes with a setup code; codes expire after 7 days; guessing is limited', async () => {
    env.STAFF_TWO_STEP = 'all'
    const first = await api.post('/admin/v1/auth/login', MANAGER)
    const manager = (await enrol(first.body.accessToken)).body.accessToken
    const added = await api.post('/admin/v1/staff', { email: 'rider@mandimangoes.test', role: 'RIDER', password: 'rider-password-1' }, { token: manager })
    assert.equal(added.status, 201)
    assert.match(added.body.setupCode, /^[a-z0-9]{4}-[a-z0-9]{4}$/)
    later(7 * 86_400 + 1)
    const rider = await adminToken(api, 'rider@mandimangoes.test', 'rider-password-1')
    assert.equal((await enrol(rider, { setupCode: added.body.setupCode })).body.error.code, 'WRONG_SETUP_CODE')
    for (let i = 0; i < 4; i++) await enrol(rider, { setupCode: 'zzzz-zzzz' })
    assert.equal((await enrol(rider, { setupCode: 'zzzz-zzzz' })).status, 429)
  })

  test('where two-step is optional (development), turning it on needs no code', async () => {
    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    assert.equal((await enrol(ops)).status, 200)
  })
})

describe('SEC-8: staff access tokens end with the change', () => {
  test('a role change, a new password or removal stops the old access token at once', async () => {
    const manager = await adminToken(api)
    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    const opsId = await staffId('ops@mandimangoes.test')
    assert.equal((await api.get('/admin/v1/orders', { token: ops })).status, 200)
    assert.equal((await api.patch(`/admin/v1/staff/${opsId}`, { role: 'PACKER' }, { token: manager })).status, 200)
    const r = await api.get('/admin/v1/orders', { token: ops })
    assert.equal(r.status, 401)
    assert.equal(r.body.error.code, 'INVALID_TOKEN')

    const asPacker = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    assert.equal((await api.get('/admin/v1/pack-list', { token: asPacker })).status, 200)
    assert.equal((await api.patch(`/admin/v1/staff/${opsId}`, { password: 'another-password-1' }, { token: manager })).status, 200)
    assert.equal((await api.get('/admin/v1/pack-list', { token: asPacker })).status, 401)

    const again = await adminToken(api, 'ops@mandimangoes.test', 'another-password-1')
    assert.equal((await api.del(`/admin/v1/staff/${opsId}`, { token: manager })).status, 204)
    assert.equal((await api.get('/admin/v1/pack-list', { token: again })).status, 401)
    // Everyone else carries on.
    assert.equal((await api.get('/admin/v1/orders', { token: manager })).status, 200)
  })
})

describe('SEC-9: claim photo links', () => {
  test('only links into our own Blob store are accepted or shown', async () => {
    const before = env.BLOB_READ_WRITE_TOKEN
    try {
      env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_AbC123_secretpart'
      assert.equal(isOwnPhotoUrl('https://abc123.public.blob.vercel-storage.com/claims/x.jpg'), true)
      assert.equal(isOwnPhotoUrl('https://abc123.private.blob.vercel-storage.com/claims/x.jpg'), true)
      assert.equal(isOwnPhotoUrl('https://other.public.blob.vercel-storage.com/x.jpg'), false)
      assert.equal(isOwnPhotoUrl('https://abc123.public.blob.vercel-storage.com.evil.example/x.jpg'), false)
      assert.equal(isOwnPhotoUrl('http://abc123.public.blob.vercel-storage.com/x.jpg'), false)
      assert.equal(isOwnPhotoUrl('https://user@abc123.public.blob.vercel-storage.com/x.jpg'), false)
      assert.equal(isOwnPhotoUrl('https://evil.example/login'), false)
      env.BLOB_READ_WRITE_TOKEN = ''
      assert.equal(isOwnPhotoUrl('https://abc123.public.blob.vercel-storage.com/claims/x.jpg'), false)
    } finally {
      env.BLOB_READ_WRITE_TOKEN = before
    }
    const me = await customerToken(api)
    const r = await api.post(
      '/v1/claims',
      { orderId: 'ord_x', issueType: 'DAMAGED', description: 'Crushed mangoes', photoUrl: 'https://evil.example/login' },
      { token: me.accessToken },
    )
    assert.equal(r.status, 400)
  })
})

describe('SEC-11: login codes stay out of the logs', () => {
  function capture(level) {
    const lines = []
    const original = logger[level]
    logger[level] = (...args) => lines.push(JSON.stringify(args))
    return { lines, restore: () => (logger[level] = original) }
  }

  test('the log provider writes the code only with LOG_OTP_CODES=true, and never the whole number', async () => {
    const log = capture('info')
    try {
      await logOnly('+919876512345', '482913')
      assert.ok(!log.lines.join().includes('482913'))
      assert.ok(!log.lines.join().includes('9876512345'))
      env.LOG_OTP_CODES = true
      await logOnly('+919876512345', '482913')
      assert.ok(log.lines.at(-1).includes('482913'))
      assert.ok(!log.lines.join().includes('9876512345'))
    } finally {
      env.LOG_OTP_CODES = false
      log.restore()
    }
  })

  test('a Jio error that echoes the message does not put the code in the log', async () => {
    const log = capture('error')
    try {
      const send = jioSender({ url: 'https://jio.example/sms', apiKey: 'k', senderId: 'MANDIM', templateId: 't', entityId: 'e', text: '{code} is your code' }, async () =>
        new Response('rejected: "771204 is your code"', { status: 400 }),
      )
      await assert.rejects(send('+919876512345', '771204'))
      // Also when Jio answers 200 without the accepted status and echoes the text.
      const echo = jioSender(
        { url: 'https://jio.example/sms', apiKey: 'k', senderId: 'MANDIM', templateId: 't', entityId: 'e', text: '{code} is your code', successPath: 'state', successValues: ['OK'] },
        async () => new Response('{"state":"DLT_MISMATCH","text":"771204 is your code"}', { status: 200 }),
      )
      await assert.rejects(echo('+919876512345', '771204'))
      assert.ok(log.lines.length > 1)
      assert.ok(!log.lines.join().includes('771204'))
    } finally {
      log.restore()
    }
  })
})

describe('PAY-7: the dev payment routes need an explicit opt-in', () => {
  test('off without ENABLE_DEV_ROUTES, and off whenever Razorpay keys are set', async () => {
    assert.equal(devRoutesOn(), true) // the test setup opts in
    env.RAZORPAY_KEY_ID = 'rzp_test_x'
    assert.equal(devRoutesOn(), false)
    env.RAZORPAY_KEY_ID = ''
    env.ENABLE_DEV_ROUTES = false
    try {
      assert.equal(devRoutesOn(), false)
      const plain = await startServer()
      try {
        const r = await client(plain.base).post('/v1/dev/pay', { orderId: 'ord_x', outcome: 'captured' })
        assert.equal(r.status, 404)
      } finally {
        await plain.close()
      }
    } finally {
      env.ENABLE_DEV_ROUTES = true
    }
  })
})
