// The post-deploy smoke test (scripts/smoke.mjs): it passes against the API
// started the way production starts it (NODE_ENV=production, preflight on,
// dummy local secrets only), and it catches a development API: /v1/dev on,
// demo staff accounts, cookies without Secure, plain http.
import { closeAll, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { after, describe, test } from 'node:test'
import { query } from '../src/db.js'
import { env } from '../src/env.js'
import { cookieProblems, main, parseSetCookie, runSmoke } from '../scripts/smoke.mjs'

const byCheck = (results) => Object.fromEntries(results.map((r) => [`${r.area} ${r.check}`, r]))
const failed = (results) => results.filter((r) => r.status === 'fail').map((r) => `${r.area} ${r.check}`)

after(async () => {
  await resetDb() // the production-mode run stamped the database as production
  await closeAll()
})

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

/** Starts src/index.js as production would: preflight, migrations, the first maintenance run. */
async function startProductionApi() {
  const port = await freePort()
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    // Only these variables: nothing from the test setup (dev routes, NODE_ENV=test) leaks in.
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      PORT: String(port),
      DATABASE_URL: env.DATABASE_URL,
      LOG_LEVEL: 'warn',
      JWT_SECRET: randomBytes(32).toString('hex'),
      CRON_SECRET: randomBytes(16).toString('hex'),
      COOKIE_SECURE: 'true',
      ADMIN_ORIGIN: 'https://ops.smoke.invalid',
      CUSTOMER_ORIGIN: 'https://shop.smoke.invalid',
      // Dummy values: nothing here can reach a real provider.
      RAZORPAY_KEY_ID: 'rzp_test_dummyLocalOnly',
      RAZORPAY_KEY_SECRET: 'dummy-local-only',
      RAZORPAY_WEBHOOK_SECRET: 'dummy-local-webhook-secret',
      SMS_PROVIDER: 'jio',
      JIO_SMS_URL: 'http://127.0.0.1:9/sms',
      JIO_SMS_API_KEY: 'dummy',
      JIO_SMS_SENDER_ID: 'MANDIM',
      JIO_SMS_TEMPLATE_ID: 'dummy',
      JIO_SMS_ENTITY_ID: 'dummy',
      JIO_SMS_SUCCESS_PATH: 'status',
      JIO_SMS_SUCCESS_VALUES: 'ok',
      TURNSTILE_SITE_KEY: 'dummy-site',
      TURNSTILE_SECRET_KEY: 'dummy-secret',
      SENTRY_DSN: 'http://public@127.0.0.1:9/1',
      SEED_DEMO_DATA: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`production API exited:\n${log}`)
    const ok = await fetch(`${base}/ready`).then((r) => r.ok, () => false)
    if (ok) return { base, stop: () => new Promise((r) => (child.once('exit', r), child.kill('SIGTERM'))) }
    await new Promise((r) => setTimeout(r, 200))
  }
  child.kill('SIGKILL')
  throw new Error(`production API never became ready:\n${log}`)
}

describe('post-deploy smoke test', () => {
  test('passes against the API started in production mode', { timeout: 60_000 }, async () => {
    await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;') // a fresh database, as on a first deploy
    const prod = await startProductionApi()
    try {
      const results = await runSmoke({ api: prod.base, origins: ['https://shop.smoke.invalid', 'https://ops.smoke.invalid'], local: true, checkDemoLogin: true })
      assert.deepEqual(failed(results), [], JSON.stringify(results, null, 1))
      const r = byCheck(results)
      assert.equal(r['api dev routes absent (/v1/dev)'].status, 'pass')
      assert.equal(r['api demo manager cannot sign in'].status, 'pass')
      assert.equal(r['api GET /ready: database and maintenance'].status, 'pass')
      assert.equal(r['api staff refresh cookie: HttpOnly, Secure, SameSite, Path'].status, 'pass')
      assert.equal(r['api Razorpay webhook refuses unsigned bodies'].status, 'pass')
      assert.equal(r['api CORS refuses https://smoke-check.invalid'].status, 'pass')
      // Read-only: the run left no session, order or webhook record behind.
      assert.equal((await query('SELECT COUNT(*)::int AS n FROM refresh_sessions')).rows[0].n, 0)
      assert.equal((await query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n, 0)
      assert.equal((await query('SELECT COUNT(*)::int AS n FROM webhook_failures')).rows[0].n, 0)
    } finally {
      await prod.stop()
    }
  })

  test('catches a development API: dev routes on and demo staff accounts', async () => {
    await resetDb()
    const srv = await startServer() // NODE_ENV=test with ENABLE_DEV_ROUTES=true, demo staff seeded
    try {
      const results = await runSmoke({ api: srv.base, origins: [env.CUSTOMER_ORIGIN, env.ADMIN_ORIGIN], local: true, checkDemoLogin: true })
      const r = byCheck(results)
      assert.equal(r['api dev routes absent (/v1/dev)'].status, 'fail')
      assert.match(r['api dev routes absent (/v1/dev)'].detail, /HTTP 400/) // refused by validation: nothing was paid
      assert.equal(r['api demo manager cannot sign in'].status, 'fail')
      // Without --local, the cookies (COOKIE_SECURE=false here) and plain http fail too.
      const strict = byCheck(await runSmoke({ api: srv.base, origins: [env.CUSTOMER_ORIGIN, env.ADMIN_ORIGIN] }))
      assert.match(strict['api staff refresh cookie: HttpOnly, Secure, SameSite, Path'].detail, /not Secure/)
      assert.equal(strict['api http redirects to https'].status, 'fail')
      assert.equal(strict['api HSTS'].status, 'pass') // helmet sends it even over http
      assert.equal(strict['api demo manager cannot sign in'].status, 'manual') // not tried unless asked
      // The command exits 1.
      const lines = []
      assert.equal(await main(['--api', srv.base, '--local'], fetch, (l) => lines.push(l)), 1)
      assert.match(lines.join('\n'), /FAIL +api +dev routes absent/)
    } finally {
      await srv.close()
    }
  })
})

describe('smoke test checks on a deployment over https (stubbed answers)', () => {
  const headers = (h) => new Headers(h)
  /** A stand-in for a correct Vercel deployment, with `broken` changes. */
  const stubFetch = (broken = {}) => async (url, init = {}) => {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    const origin = init.headers?.Origin
    if (u.protocol === 'http:') return new Response(null, { status: broken.noRedirect ? 200 : 308, headers: broken.noRedirect ? {} : { Location: `https://${u.host}${u.pathname}` } })
    const sec = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'strict-transport-security': 'max-age=31536000; includeSubDomains' }
    if (u.host === 'api.example.in') {
      const apiSec = { ...sec, 'content-security-policy': "default-src 'none'" }
      if (method === 'OPTIONS') {
        const allowed = ['https://example.in', 'https://ops.example.in']
        return new Response(null, { status: 204, headers: allowed.includes(origin) || broken.corsAll ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' } : {} })
      }
      if (u.pathname === '/health') return new Response('{"ok":true}', { headers: apiSec })
      if (u.pathname === '/ready') return new Response(JSON.stringify({ ready: true, maintenanceAgeSeconds: broken.staleMaintenance ? 900 : 30 }), { status: 200 })
      if (u.pathname.endsWith('/auth/logout')) {
        if (origin === 'https://smoke-check.invalid') return new Response('{}', { status: 403 })
        const name = u.pathname.startsWith('/admin') ? 'mango_admin_rt' : 'mm_customer_rt'
        const path = u.pathname.startsWith('/admin') ? '/admin/v1/auth' : '/v1/auth'
        return new Response(null, { status: 204, headers: headers([['set-cookie', `${name}=; Path=${path}; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`]]) })
      }
      if (u.pathname === '/internal/maintenance') return new Response('{}', { status: 401 })
      if (u.pathname === '/metrics') return new Response('', { status: 404 })
      if (u.pathname === '/webhooks/razorpay') return new Response('{}', { status: 400 })
      if (u.pathname === '/webhooks/whatsapp') return new Response('', { status: method === 'POST' ? 401 : 403 })
      return new Response('{"error":{"code":"NOT_FOUND"}}', { status: 404 })
    }
    // shop and panel
    if (u.pathname.endsWith('.js')) return new Response(broken.leak ? 'const k="rzp_live_LeakedKey123"' : 'fetch("https://api.example.in/v1/products")')
    const csp = "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'"
    return new Response('<html><head><meta http-equiv="Content-Security-Policy" content="x"><script type="module" src="/assets/index-a.js"></script></head></html>', {
      headers: { ...sec, ...(broken.noCsp ? {} : { 'content-security-policy': csp }), 'x-robots-tag': 'noindex, nofollow' },
    })
  }
  const opts = { api: 'https://api.example.in', shop: 'https://example.in', panel: 'https://ops.example.in' }

  test('a correct deployment passes every automatic check', async () => {
    const results = await runSmoke(opts, stubFetch())
    assert.deepEqual(failed(results), [])
    assert.equal(byCheck(results)['shop http redirects to https'].status, 'pass')
    assert.equal(byCheck(results)['panel Content-Security-Policy'].status, 'pass')
  })

  test('each broken setting fails its check', async () => {
    const cases = [
      [{ noRedirect: true }, 'api http redirects to https'],
      [{ corsAll: true }, 'api CORS refuses https://smoke-check.invalid'],
      [{ staleMaintenance: true }, 'api GET /ready: database and maintenance'],
      [{ noCsp: true }, 'shop Content-Security-Policy'],
      [{ leak: true }, 'panel deployed bundle: no secrets, dev routes or demo accounts'],
    ]
    for (const [broken, check] of cases) {
      const f = failed(await runSmoke(opts, stubFetch(broken)))
      assert.ok(f.includes(check), `${JSON.stringify(broken)} should fail "${check}", failed: ${f.join(', ')}`)
    }
  })

  test('--header goes on every request (a protected preview\'s bypass header)', async () => {
    const seen = []
    const f = stubFetch()
    const spy = (url, init = {}) => (seen.push(init.headers?.['x-vercel-protection-bypass']), f(url, init))
    const lines = []
    assert.equal(await main(['--api', opts.api, '--shop', opts.shop, '--panel', opts.panel, '--header', 'x-vercel-protection-bypass: s3cret'], spy, (l) => lines.push(l)), 0, lines.join('\n'))
    assert.ok(seen.length > 20 && seen.every((h) => h === 's3cret'))
    assert.equal(await main(['--api', opts.api, '--header', 'no-colon'], spy, () => {}), 2)
  })

  test('cookie flags are read from Set-Cookie', () => {
    const c = parseSetCookie('mm_customer_rt=; Path=/v1/auth; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=None')
    assert.deepEqual(cookieProblems(c, { name: 'mm_customer_rt', path: '/v1/auth' }), [])
    const weak = parseSetCookie('mm_customer_rt=x; Path=/; SameSite=None')
    assert.deepEqual(cookieProblems(weak, { name: 'mm_customer_rt', path: '/v1/auth' }), ['not HttpOnly', 'not Secure', 'SameSite=None without Secure', 'Path is /, expected /v1/auth'])
    assert.deepEqual(cookieProblems(undefined, { name: 'mm_customer_rt', path: '/v1/auth' }), ['no mm_customer_rt cookie in the answer'])
  })
})
