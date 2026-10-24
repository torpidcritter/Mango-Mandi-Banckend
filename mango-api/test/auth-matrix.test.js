// Who can and cannot call each route (audit remediation, stage 2).
//
// The staff matrix reads the admin router itself, so a new route is covered
// the moment it is registered: for every role, the roles access.js allows (and
// requireManager does not refuse) must get past the sign-in and role gate (any
// answer but 401/403), and every other role must get 403. Then the negative
// cases: no token, a garbage token, an expired token, the wrong kind of token,
// one customer reaching for another's things, a removed staff member, and the
// unsigned webhooks and cron.
import { adminToken, checkout, client, closeAll, customerToken, makeBatch, resetDb, signWebhook, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import jwt from 'jsonwebtoken'
import { ROLES, roleAllows } from '../src/access.js'
import { router as adminRouter } from '../src/admin.js'
import { ACCESS_TTL_S } from '../src/auth.js'
import { addDays, todayIST } from '../src/clock.js'
import { router as customerRouter } from '../src/customer.js'
import { query } from '../src/db.js'
import { env } from '../src/env.js'
import { newId } from '../src/ids.js'

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

// ---------------------------------------------------------------- the routes

/** Every route registered behind requireAdmin, nested routers (review moderation) included. */
function adminRoutes() {
  const out = []
  let authed = false
  const walk = (stack) => {
    for (const layer of stack) {
      if (layer.route) {
        if (!authed) continue
        const managerOnly = layer.route.stack.some((s) => s.name === 'requireManager')
        for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), path: layer.route.path, managerOnly })
      } else if (layer.name === 'router') {
        walk(layer.handle.stack)
      } else if (layer.name === 'requireAdmin') {
        authed = true
      }
    }
  }
  walk(adminRouter.stack)
  return out
}

/** Customer routes behind requireCustomer (the path-scoped use() in customer.js). */
function customerRoutes() {
  const gate = customerRouter.stack.find((l) => !l.route && l.name === 'requireCustomer')
  assert.ok(gate, 'requireCustomer is mounted on the customer router')
  const out = []
  const walk = (stack) => {
    for (const layer of stack) {
      if (layer.route) {
        // Public routes registered before the gate (e.g. GET /preorders/weeks) are not behind it.
        if (!gate.regexp.test(layer.route.path)) continue
        for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), path: layer.route.path })
      } else if (layer.name === 'router') {
        walk(layer.handle.stack)
      }
    }
  }
  const stack = customerRouter.stack
  walk(stack.slice(stack.indexOf(gate) + 1))
  return out
}

const ADMIN_ROUTES = adminRoutes()
const CUSTOMER_ROUTES = customerRoutes()

/** A path with every parameter filled by an id that doesn't exist. */
const concrete = (path) => path.replace(/:(\w+)/g, (_m, name) => (name === 'date' || name === 'weekStart' ? '2026-01-05' : `none_${name}`))

/**
 * Bodies that pass the role gate without doing anything. A packer may only
 * move an order to a packing status, and condemning a batch needs a manager,
 * so those two routes get a body that keeps the question to the route itself.
 */
const BODIES = {
  'PATCH /orders/:id/status': { status: 'PROCESSING' },
  'PATCH /batches/:id/status': { status: 'SELLING' },
}

const call = (method, path, { token, body, headers } = {}) =>
  api.raw(method, path, { token, headers, body: method === 'GET' || method === 'HEAD' ? undefined : (body ?? {}) })

/** What the code allows today: access.js's allowlists, and requireManager on a route. */
const codeAllows = (role, r) => role === 'MANAGER' || (!r.managerOnly && roleAllows(role, r.method, concrete(r.path)))

// SEC-08: the expected outcome comes from a committed snapshot of the policy
// (route -> roles), not from access.js itself, so a change to who may call what
// shows up as a reviewed diff of test/fixtures/role-policy.json. After a
// deliberate change, regenerate it with UPDATE_ROLE_POLICY=1 and review the diff.
const POLICY_FILE = new URL('./fixtures/role-policy.json', import.meta.url)
const currentPolicy = () =>
  Object.fromEntries(
    ADMIN_ROUTES.map((r) => [`${r.method} ${r.path}`, ROLES.filter((role) => codeAllows(role, r))]).sort(([a], [b]) => a.localeCompare(b)),
  )
// One route per line, so a policy change is a one-line diff.
const policyJson = (p) => `{\n${Object.entries(p).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}\n`
if (process.env.UPDATE_ROLE_POLICY) writeFileSync(POLICY_FILE, policyJson(currentPolicy()))
const POLICY = JSON.parse(readFileSync(POLICY_FILE, 'utf8'))
const expectedFor = (role, r) => (POLICY[`${r.method} ${r.path}`] ?? []).includes(role)

/** A token signed with the real secret that lapsed an hour ago, as if the holder waited out the lifetime. */
function expiredStaffToken(staff) {
  const iat = Math.floor(Date.now() / 1000) - ACCESS_TTL_S - 3600
  return jwt.sign({ sub: staff.id, email: staff.email, role: staff.role, typ: 'admin', sv: staff.sv, iat, exp: iat + ACCESS_TTL_S }, env.JWT_SECRET, { algorithm: 'HS256' })
}

/** A token's claims without iat/exp, to sign again. */
const decode = (t) => {
  const { iat: _iat, exp: _exp, ...claims } = jwt.decode(t)
  return claims
}

// ---------------------------------------------------------------- staff matrix

describe('staff route × role matrix', () => {
  const tokens = {}
  let customer

  before(async () => {
    await resetDb()
    tokens.MANAGER = await adminToken(api)
    tokens.OPERATOR = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    tokens.PACKER = await adminToken(api, 'packer@mandimangoes.test', 'packer123')
    tokens.QC = await adminToken(api, 'qc@mandimangoes.test', 'qc123')
    const rider = await api.post('/admin/v1/staff', { email: 'rider@mandimangoes.test', role: 'RIDER', password: 'rider-pass-123' }, { token: tokens.MANAGER })
    assert.equal(rider.status, 201, JSON.stringify(rider.body))
    tokens.RIDER = await adminToken(api, 'rider@mandimangoes.test', 'rider-pass-123')
    customer = (await customerToken(api)).accessToken
    assert.deepEqual(Object.keys(tokens).sort(), [...ROLES].sort(), 'a token for every role')
  })

  test('the router walk finds the staff routes, the review routes included', () => {
    assert.ok(ADMIN_ROUTES.length >= 70, `only ${ADMIN_ROUTES.length} routes found`)
    for (const want of ['GET /orders', 'GET /staff', 'POST /reviews/:id/approve', 'PUT /preorder-capacity/:weekStart/:sku']) {
      assert.ok(ADMIN_ROUTES.some((r) => `${r.method} ${r.path}` === want), want)
    }
    assert.ok(!ADMIN_ROUTES.some((r) => r.path === '/auth/login'), 'sign-in routes are public and not in the matrix')
  })

  test('the role policy matches the reviewed snapshot (test/fixtures/role-policy.json)', () => {
    assert.deepEqual(currentPolicy(), POLICY, 'who may call which staff route changed: if on purpose, run with UPDATE_ROLE_POLICY=1 and commit the reviewed diff')
  })

  for (const r of ADMIN_ROUTES) {
    const key = `${r.method} ${r.path}`
    test(`${key}: ${ROLES.filter((role) => expectedFor(role, r)).join(', ')} only`, async () => {
      const url = `/admin/v1${concrete(r.path)}`
      for (const role of ROLES) {
        const res = await call(r.method, url, { token: tokens[role], body: BODIES[key] })
        if (expectedFor(role, r)) {
          assert.ok(![401, 403].includes(res.status), `${role} ${key} should pass the gate, got ${res.status} ${JSON.stringify(res.body)}`)
          assert.ok(res.status < 500, `${role} ${key} -> ${res.status} ${JSON.stringify(res.body)}`)
        } else {
          assert.equal(res.status, 403, `${role} ${key} should be refused, got ${res.status} ${JSON.stringify(res.body)}`)
        }
      }
    })
  }

  test('no token, a garbage token, a forged token and a customer token: 401 on every staff route', async () => {
    const forged = jwt.sign({ sub: 'adm_x', email: 'x@x', role: 'MANAGER', typ: 'admin', sv: 0 }, 'not-the-secret', { algorithm: 'HS256', expiresIn: 600 })
    const none = jwt.sign(decode(tokens.MANAGER), '', { algorithm: 'none' })
    for (const r of ADMIN_ROUTES) {
      const url = `/admin/v1${concrete(r.path)}`
      for (const [label, token, headers] of [
        ['no token', null],
        ['garbage', 'garbage.token.here'],
        ['not bearer', null, { Authorization: `Basic ${tokens.MANAGER}` }],
        ['wrong secret', forged],
        ['alg none', none],
        ['customer', customer],
      ]) {
        const res = await call(r.method, url, { token, headers, body: BODIES[`${r.method} ${r.path}`] })
        assert.equal(res.status, 401, `${label} ${r.method} ${r.path} -> ${res.status}`)
      }
    }
  })

  test('an expired staff token is refused on every staff route', async () => {
    const me = await api.get('/admin/v1/auth/me', { token: tokens.MANAGER })
    assert.equal(me.status, 200)
    const claims = decode(tokens.MANAGER)
    const expired = expiredStaffToken({ id: claims.sub, email: claims.email, role: claims.role, sv: claims.sv })
    for (const r of ADMIN_ROUTES) {
      const res = await call(r.method, `/admin/v1${concrete(r.path)}`, { token: expired, body: BODIES[`${r.method} ${r.path}`] })
      assert.equal(res.status, 401, `${r.method} ${r.path} -> ${res.status}`)
    }
  })

  test('a real staff token stops working once its lifetime has passed', async () => {
    const token = tokens.OPERATOR
    assert.equal((await api.get('/admin/v1/orders', { token })).status, 200)
    // Tokens are checked against the wall clock (jsonwebtoken), not clock.js, so move Date itself.
    mock.timers.enable({ apis: ['Date'], now: Date.now() + (ACCESS_TTL_S + 60) * 1000 })
    let res
    try {
      res = await api.get('/admin/v1/orders', { token })
    } finally {
      mock.timers.reset()
    }
    assert.equal(res.status, 401)
    assert.equal(res.body.error.code, 'INVALID_TOKEN')
  })

  test('staff tokens are refused on every signed-in customer route', async () => {
    assert.ok(CUSTOMER_ROUTES.length >= 30, `only ${CUSTOMER_ROUTES.length} customer routes found`)
    for (const r of CUSTOMER_ROUTES) {
      for (const role of ROLES) {
        const res = await call(r.method, `/v1${concrete(r.path)}`, { token: tokens[role] })
        assert.equal(res.status, 401, `${role} ${r.method} ${r.path} -> ${res.status}`)
      }
    }
  })
})

// ---------------------------------------------------------------- customer side

describe('customer routes', () => {
  beforeEach(async () => {
    await resetDb()
  })

  test('no token, garbage, a forged and an expired customer token: 401 on every signed-in customer route', async () => {
    const real = await customerToken(api)
    const claims = decode(real.accessToken)
    const forged = jwt.sign(claims, 'not-the-secret', { algorithm: 'HS256', expiresIn: 600 })
    const iat = Math.floor(Date.now() / 1000) - ACCESS_TTL_S - 3600
    const expired = jwt.sign({ ...claims, iat, exp: iat + ACCESS_TTL_S }, env.JWT_SECRET, { algorithm: 'HS256' })
    for (const r of CUSTOMER_ROUTES) {
      for (const [label, token] of [['no token', null], ['garbage', 'garbage'], ['wrong secret', forged], ['expired', expired]]) {
        const res = await call(r.method, `/v1${concrete(r.path)}`, { token })
        assert.equal(res.status, 401, `${label} ${r.method} ${r.path} -> ${res.status}`)
      }
    }
  })

  test("a customer cannot read, move, cancel, rate or claim another customer's order", async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const a = await customerToken(api)
    const b = await customerToken(api)
    const c = await checkout(api, a.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal(c.status, 201, JSON.stringify(c.body))
    const id = c.body.orderId
    await api.post('/v1/dev/pay', { orderId: id, outcome: 'captured' })
    const before = (await query('SELECT status, delivery_date, slot_id FROM orders WHERE id = $1', [id])).rows[0]
    assert.equal(before.status, 'CONFIRMED')
    const t = { token: b.accessToken }

    assert.equal((await api.get(`/v1/orders/${id}`, t)).status, 404)
    assert.equal((await api.get(`/v1/orders/${id}/payment-status`, t)).status, 404)
    assert.equal((await api.get(`/v1/orders/${id}/delivery-photo`, t)).status, 404)
    assert.equal((await api.post(`/v1/orders/${id}/reschedule`, { deliveryDate: addDays(todayIST(), 3) }, t)).status, 404)
    assert.equal((await api.post(`/v1/orders/${id}/cancel`, {}, t)).status, 404)
    assert.ok(!(await api.get('/v1/orders', t)).body.some((o) => o.id === id), "another customer's order is not listed")
    assert.deepEqual((await query('SELECT status, delivery_date, slot_id FROM orders WHERE id = $1', [id])).rows[0], before)

    // Rating and claims only open once delivered: the other customer still gets a 404.
    await query("UPDATE orders SET status = 'DELIVERED' WHERE id = $1", [id])
    assert.equal((await api.put(`/v1/orders/${id}/rating`, { stars: 1, comment: 'not mine' }, t)).status, 404)
    const claim = await api.post('/v1/claims', { orderId: id, issueType: 'DAMAGED', description: 'they were all squashed' }, t)
    assert.equal(claim.status, 404)
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM order_ratings WHERE order_id = $1', [id])).rows[0].n, 0)
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM claims WHERE order_id = $1', [id])).rows[0].n, 0)
    // The owner still can: the 404s above are about ownership, not the order.
    assert.equal((await api.put(`/v1/orders/${id}/rating`, { stars: 5 }, { token: a.accessToken })).status, 204)
  })

  test("a customer cannot see or delete another customer's saved addresses or stock alerts", async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const a = await customerToken(api)
    const b = await customerToken(api)
    assert.equal((await checkout(api, a.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])).status, 201)
    const mine = await api.get('/v1/me/addresses', { token: a.accessToken })
    assert.equal(mine.body.length, 1)
    const addressId = mine.body[0].id
    assert.deepEqual((await api.get('/v1/me/addresses', { token: b.accessToken })).body, [])
    assert.equal((await api.del(`/v1/me/addresses/${addressId}`, { token: b.accessToken })).status, 404)
    assert.equal((await api.get('/v1/me/addresses', { token: a.accessToken })).body.length, 1)

    const alert = await api.post('/v1/stock-alerts', { sku: 'ALP-3', stage: 'RAW', pincode: '560034' }, { token: a.accessToken })
    assert.equal(alert.status, 201, JSON.stringify(alert.body))
    assert.deepEqual((await api.get('/v1/stock-alerts', { token: b.accessToken })).body, [])
    assert.equal((await api.del(`/v1/stock-alerts/${alert.body.id}`, { token: b.accessToken })).status, 404)
    const still = (await query('SELECT cancelled_at FROM stock_alerts WHERE id = $1', [alert.body.id])).rows[0]
    assert.equal(still.cancelled_at, null)
  })

  test("a customer cannot read or cancel another customer's preorder", async () => {
    const manager = await adminToken(api)
    let week = addDays(todayIST(), 6)
    while (new Date(`${week}T00:00:00Z`).getUTCDay() !== 1) week = addDays(week, 1)
    assert.equal((await api.put(`/admin/v1/preorder-capacity/${week}/ALP-3`, { capacity: 5 }, { token: manager })).status, 200)
    const a = await customerToken(api)
    const b = await customerToken(api)
    const p = await api.post(
      '/v1/preorders',
      { sku: 'ALP-3', stage: 'RIPE', qty: 1, weekStart: week, pincode: '560034', address: '12, 4th Cross, Koramangala, Bengaluru' },
      { token: a.accessToken, headers: { 'Idempotency-Key': newId('idem') } },
    )
    assert.equal(p.status, 201, JSON.stringify(p.body))
    const t = { token: b.accessToken }
    assert.equal((await api.get(`/v1/preorders/${p.body.id}`, t)).status, 404)
    assert.equal((await api.post(`/v1/preorders/${p.body.id}/cancel`, {}, t)).status, 404)
    const listed = (await api.get('/v1/preorders', t)).body
    assert.ok(!(listed.items ?? listed).some((x) => x.id === p.body.id))
    assert.equal((await query('SELECT status FROM preorders WHERE id = $1', [p.body.id])).rows[0].status, p.body.status)
  })

  test('a deleted account sees no profile with its old token', async () => {
    const cust = await customerToken(api)
    assert.equal((await api.del('/v1/me', { token: cust.accessToken })).status, 204)
    assert.equal((await api.get('/v1/me', { token: cust.accessToken })).status, 401)
  })

  // SEC-01 (fixed): requireCustomer also checks the customer still exists,
  // so a deleted account's access token stops working at once.
  test("SEC-01: a deleted account's access token is refused (401) on every signed-in customer route", async () => {
    const cust = await customerToken(api)
    assert.equal((await api.del('/v1/me', { token: cust.accessToken })).status, 204)
    for (const r of CUSTOMER_ROUTES) {
      const res = await call(r.method, `/v1${concrete(r.path)}`, { token: cust.accessToken })
      assert.equal(res.status, 401, `${r.method} ${r.path} -> ${res.status}`)
    }
  })
})

// ---------------------------------------------------------------- staff removed or changed

describe('staff whose access changes', () => {
  let manager
  beforeEach(async () => {
    await resetDb()
    manager = await adminToken(api)
  })

  async function newStaff(role = 'OPERATOR') {
    const email = `${newId('s').toLowerCase()}@mandimangoes.test`
    const add = await api.post('/admin/v1/staff', { email, role, password: 'long-enough-1' }, { token: manager })
    assert.equal(add.status, 201)
    const token = await adminToken(api, email, 'long-enough-1')
    assert.equal((await api.get('/admin/v1/auth/me', { token })).status, 200)
    return { id: add.body.id, email, token }
  }

  test("a removed staff member's token stops working at once", async () => {
    const s = await newStaff()
    assert.equal((await api.del(`/admin/v1/staff/${s.id}`, { token: manager })).status, 204)
    const r = await api.get('/admin/v1/orders', { token: s.token })
    assert.equal(r.status, 401)
    assert.equal((await api.get('/admin/v1/auth/me', { token: s.token })).status, 401)
  })

  test("a role change or new password ends the old token; the old role's access does not linger", async () => {
    const s = await newStaff('OPERATOR')
    assert.equal((await api.patch(`/admin/v1/staff/${s.id}`, { role: 'QC' }, { token: manager })).status, 200)
    assert.equal((await api.get('/admin/v1/orders', { token: s.token })).status, 401)
    const qc = await adminToken(api, s.email, 'long-enough-1')
    assert.equal((await api.get('/admin/v1/orders', { token: qc })).status, 403)
    assert.equal((await api.patch(`/admin/v1/staff/${s.id}`, { password: 'another-long-1' }, { token: manager })).status, 200)
    assert.equal((await api.get('/admin/v1/batches', { token: qc })).status, 401)
  })

  test('a token claiming a role the staff row does not have is refused', async () => {
    const s = await newStaff('PACKER')
    const claims = decode(s.token)
    const promoted = jwt.sign({ ...claims, role: 'MANAGER' }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: 600 })
    assert.equal((await api.get('/admin/v1/staff', { token: promoted })).status, 401)
  })
})

// ---------------------------------------------------------------- webhooks and cron

describe('webhooks and the cron', () => {
  beforeEach(async () => {
    await resetDb()
  })

  test('a Razorpay webhook without a valid signature is refused and changes nothing', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal(c.status, 201)
    const event = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_forged', order_id: c.body.razorpayOrderId, amount: c.body.total, method: 'upi' } } } }
    const raw = JSON.stringify(event)
    const wrongSecret = createHmac('sha256', 'not-the-webhook-secret').update(raw).digest('hex')
    for (const [label, sig] of [['missing', undefined], ['empty', ''], ['zeros', '0'.repeat(64)], ['wrong secret', wrongSecret], ['short', 'abc']]) {
      const headers = { 'Content-Type': 'application/json', ...(sig === undefined ? {} : { 'X-Razorpay-Signature': sig }) }
      const r = await api.raw('POST', '/webhooks/razorpay', { raw, headers })
      assert.equal(r.status, 400, `${label} -> ${r.status}`)
      assert.equal(r.body.error.code, 'BAD_SIGNATURE')
    }
    const o = (await query('SELECT status FROM orders WHERE id = $1', [c.body.orderId])).rows[0]
    assert.equal(o.status, 'PAYMENT_PENDING')

    // The same event, signed, does confirm it: the refusals above were the signature.
    const signed = signWebhook(event)
    const ok = await api.raw('POST', '/webhooks/razorpay', { raw: signed.raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signed.signature } })
    assert.equal(ok.status, 200)
    assert.equal((await query('SELECT status FROM orders WHERE id = $1', [c.body.orderId])).rows[0].status, 'CONFIRMED')
  })

  test('a WhatsApp webhook without a valid signature is refused and changes nothing', async () => {
    const raw = JSON.stringify({
      entry: [{ changes: [{ value: {
        contacts: [{ wa_id: '919800000001', profile: { name: 'Forger' } }],
        messages: [{ from: '919800000001', id: 'wamid.forged1', type: 'text', text: { body: 'hi' } }],
      } }] }],
    })
    const wrong = `sha256=${createHmac('sha256', 'not-the-app-secret').update(raw).digest('hex')}`
    for (const [label, sig] of [['missing', undefined], ['zeros', `sha256=${'0'.repeat(64)}`], ['wrong secret', wrong], ['no prefix', createHmac('sha256', 'wa_test_secret').update(raw).digest('hex')]]) {
      const headers = { 'Content-Type': 'application/json', ...(sig === undefined ? {} : { 'X-Hub-Signature-256': sig }) }
      const r = await api.raw('POST', '/webhooks/whatsapp', { raw, headers })
      assert.equal(r.status, 401, `${label} -> ${r.status}`)
    }
    assert.equal((await query("SELECT COUNT(*)::int AS n FROM wa_sessions WHERE phone = '+919800000001'")).rows[0].n, 0)
    assert.equal((await api.get('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status, 403)
    assert.equal((await api.get('/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=1')).status, 403)
  })

  test('the maintenance cron needs the cron secret', async () => {
    for (const [label, headers] of [
      ['none', {}],
      ['wrong', { Authorization: 'Bearer wrong-secret' }],
      ['prefix', { Authorization: `Bearer ${env.CRON_SECRET.slice(0, -1)}` }],
      ['staff token', { Authorization: `Bearer ${await adminToken(api)}` }],
    ]) {
      const r = await api.raw('GET', '/internal/maintenance', { headers })
      assert.equal(r.status, 401, `${label} -> ${r.status}`)
    }
    const ok = await api.raw('GET', '/internal/maintenance', { headers: { Authorization: `Bearer ${env.CRON_SECRET}` } })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
  })
})
