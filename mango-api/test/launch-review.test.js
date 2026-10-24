// Fixes from the launch review: manager refunds for orders we can't deliver,
// replaying payments after a restore, login-code protection, payment and
// idempotency keys, delivery proof, gift codes, claim limits, the operator
// allowlist, maintenance time slices and account deletion with money owed.
import sharp from 'sharp'
import { adminToken, checkout, client, closeAll, customerToken, makeBatch, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { OPERATOR_ROUTES, roleAllows } from '../src/access.js'
import { router as adminRouter } from '../src/admin.js'
import { withBudget, timeLeft } from '../src/budget.js'
import { addDays, now, todayIST } from '../src/clock.js'
import { query, tx } from '../src/db.js'
import { env } from '../src/env.js'
import { newId } from '../src/ids.js'
import { runMaintenance, SLICE } from '../src/maintenance.js'
import { sendDueNotifications } from '../src/notify.js'
import { devGateway, replayCapturedPayments } from '../src/payments.js'
import { eraseCustomer } from '../src/privacy.js'

let srv
let api
let admin
let ops
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
  devGateway.clear()
  admin = await adminToken(api)
  ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
})

const pay = (orderId) => api.post('/v1/dev/pay', { orderId, outcome: 'captured' })
const order = async (id) => (await query('SELECT * FROM orders WHERE id = $1', [id])).rows[0]
async function paidOrder(cust, extra) {
  const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }], extra)
  assert.equal(c.status, 201, JSON.stringify(c.body))
  await pay(c.body.orderId)
  return c.body
}
const cancel = (id, body, token = admin) => api.post(`/admin/v1/orders/${id}/cancel`, body, { token })

describe('manager refunds for orders we cannot deliver', () => {
  test('only a manager cancels a paid order, and only after confirming the refund', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const o = await paidOrder(cust)
    assert.equal((await cancel(o.orderId, { reason: 'Truck short' }, ops)).status, 403)
    const unconfirmed = await cancel(o.orderId, { reason: 'Truck short' })
    assert.equal(unconfirmed.status, 409)
    assert.equal(unconfirmed.body.error.code, 'REFUND_REQUIRED')
    assert.equal((await order(o.orderId)).status, 'CONFIRMED')

    const r = await cancel(o.orderId, { reason: 'Truck short', refund: true })
    assert.equal(r.status < 300, true, JSON.stringify(r.body))
    const after = await order(o.orderId)
    assert.equal(after.status, 'CANCELLED')
    assert.equal(after.payment_status, 'REFUNDED')
    assert.ok(after.staff_cancelled_at && after.refunded_at)
    const kinds = (await query('SELECT kind FROM notifications WHERE order_id = $1', [o.orderId])).rows.map((n) => n.kind)
    assert.ok(kinds.includes('REFUNDED'))
  })

  test('an operator can still cancel an unpaid order without a refund', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    const r = await cancel(c.body.orderId, { reason: 'Customer asked by phone' }, ops)
    assert.equal(r.status < 300, true, JSON.stringify(r.body))
    // Paying after the shop cancelled is refunded, not revived.
    const late = await pay(c.body.orderId)
    assert.equal(late.body.result, 'refund_due')
    const o = await order(c.body.orderId)
    assert.equal(o.status, 'CANCELLED')
    assert.ok(o.refund_requested_at)
  })

  test('a third missed delivery can be cancelled with a refund', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const o = await paidOrder(cust)
    await query(`UPDATE orders SET status = 'DELIVERY_FAILED', delivery_failures = 3 WHERE id = $1`, [o.orderId])
    assert.equal((await cancel(o.orderId, { reason: 'Three missed deliveries', refund: true })).status < 300, true)
    assert.equal((await order(o.orderId)).payment_status, 'REFUNDED')
  })
})

describe('preorders we cannot fill', () => {
  test('a manager cancels a paid booking and it is refunded in full; operators cannot', async () => {
    let week = addDays(todayIST(), 6)
    while (new Date(`${week}T00:00:00Z`).getUTCDay() !== 1) week = addDays(week, 1)
    assert.equal((await api.put(`/admin/v1/preorder-capacity/${week}/ALP-3`, { capacity: 10 }, { token: admin })).status < 300, true)
    const cust = await customerToken(api)
    const b = await api.post(
      '/v1/preorders',
      { sku: 'ALP-3', stage: 'RIPE', qty: 2, weekStart: week, pincode: '560034', address: '12, 4th Cross, Koramangala, Bengaluru' },
      { token: cust.accessToken, headers: { 'Idempotency-Key': newId('idem') } },
    )
    assert.equal(b.status, 201, JSON.stringify(b.body))
    assert.equal((await api.post('/v1/dev/pay-preorder', { preorderId: b.body.id, outcome: 'captured' })).body.result, 'booked')
    assert.equal((await api.post(`/admin/v1/preorders/${b.body.id}/cancel`, { reason: 'Hail damaged the crop' }, { token: ops })).status, 403)
    const r = await api.post(`/admin/v1/preorders/${b.body.id}/cancel`, { reason: 'Hail damaged the crop' }, { token: admin })
    assert.deepEqual(r.body, { refunded: true })
    const p = (await query('SELECT * FROM preorders WHERE id = $1', [b.body.id])).rows[0]
    assert.equal(p.status, 'CANCELLED')
    assert.ok(p.refunded_at && p.staff_cancelled_at)
  })
})

describe('after a restore', () => {
  test('payments taken since the restore point are applied, and lost-order payments refunded', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    const o = await order(c.body.orderId)
    // Paid at Razorpay, but the webhook landed in the database we threw away.
    devGateway.set(o.razorpay_order_id, { id: 'pay_kept', status: 'captured', amount: o.total, method: 'upi' })
    // And a payment for an order the restore lost completely.
    devGateway.set('order_lost_1', { id: 'pay_lost', status: 'captured', amount: 159_900, method: 'upi' })

    const dry = await replayCapturedPayments({ from: new Date(now().getTime() - 3_600_000) })
    assert.equal(dry.applied, 1)
    assert.deepEqual(dry.lost.map((l) => l.paymentId), ['pay_lost'])
    assert.equal((await order(o.id)).status, 'CONFIRMED')
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM webhook_failures WHERE reason LIKE 'After a restore%'`)).rows[0].n, 1)
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM duplicate_payments')).rows[0].n, 0, 'nothing refunded without --refund-missing')

    const again = await replayCapturedPayments({ from: new Date(now().getTime() - 3_600_000), refundMissing: true })
    assert.equal(again.applied, 0, 'replaying twice changes nothing')
    assert.equal(again.refunded, 1)
    assert.ok((await query(`SELECT refunded_at FROM duplicate_payments WHERE payment_id = 'pay_lost'`)).rows[0].refunded_at)
  })

  test('a deletion made after the restore point is made again', async () => {
    const cust = await customerToken(api)
    const id = (await api.get('/v1/me', { token: cust.accessToken })).body.id
    await tx((c) => eraseCustomer(c, id, { force: true }))
    const row = (await query('SELECT phone, deleted_at FROM customers WHERE id = $1', [id])).rows[0]
    assert.equal(row.phone, null)
    assert.ok(row.deleted_at)
  })
})

describe('accounts with money still owed', () => {
  test('deletion waits for a pending refund or a second payment to be refunded', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const o = await paidOrder(cust)
    await query(`UPDATE orders SET status = 'DELIVERED' WHERE id = $1`, [o.orderId])
    await query(`INSERT INTO duplicate_payments (payment_id, order_id, amount, found_at) VALUES ('pay_twice', $1, 100, $2)`, [o.orderId, now()])
    const r = await api.del('/v1/me', { token: cust.accessToken })
    assert.equal(r.status, 409)
    assert.equal(r.body.error.code, 'OPEN_ORDERS')
    await query(`UPDATE duplicate_payments SET refunded_at = $1`, [now()])
    assert.equal((await api.del('/v1/me', { token: cust.accessToken })).status, 204)
  })
})

describe('login codes', () => {
  test('new numbers use only their share of the day, existing customers keep the rest', async () => {
    const saved = [env.OTP_DAILY_LIMIT, env.OTP_NEW_NUMBER_SHARE]
    env.OTP_DAILY_LIMIT = 4
    env.OTP_NEW_NUMBER_SHARE = 0.5
    try {
      await customerToken(api, '9876500001') // a new number: uses 1 of the 2 codes new numbers may have
      assert.equal((await api.post('/v1/auth/otp/request', { phone: '9876500002' })).status, 200)
      const refused = await api.post('/v1/auth/otp/request', { phone: '9876500003' })
      assert.equal(refused.status, 503)
      assert.equal(refused.body.error.code, 'OTP_PAUSED')
      // An existing customer still gets a code.
      assert.equal((await api.post('/v1/auth/otp/request', { phone: '9876500001' })).status, 200)
    } finally {
      ;[env.OTP_DAILY_LIMIT, env.OTP_NEW_NUMBER_SHARE] = saved
    }
  })

  test('with Turnstile on, a code needs a passed check', async () => {
    const realFetch = globalThis.fetch
    env.TURNSTILE_SECRET_KEY = 'secret'
    env.TURNSTILE_SITE_KEY = 'site'
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('challenges.cloudflare.com')) {
        const token = new URLSearchParams(String(init.body)).get('response')
        // SEC-04: a token solved on another site, or for another action, passes Cloudflare but not us.
        const answer = { success: token !== 'bad', hostname: token === 'other-site' ? 'evil.example' : 'localhost', action: token === 'other-action' ? 'login' : 'otp' }
        return new Response(JSON.stringify(answer), { headers: { 'Content-Type': 'application/json' } })
      }
      return realFetch(url, init)
    }
    try {
      assert.equal((await api.get('/v1/auth/config')).body.turnstileSiteKey, 'site')
      assert.equal((await api.post('/v1/auth/otp/request', { phone: '9876500011' })).body.error.code, 'CAPTCHA_REQUIRED')
      assert.equal((await api.post('/v1/auth/otp/request', { phone: '9876500011', captchaToken: 'bad' })).body.error.code, 'CAPTCHA_FAILED')
      assert.equal((await api.post('/v1/auth/otp/request', { phone: '9876500011', captchaToken: 'other-site' })).body.error.code, 'CAPTCHA_FAILED')
      assert.equal((await api.post('/v1/auth/otp/request', { phone: '9876500011', captchaToken: 'other-action' })).body.error.code, 'CAPTCHA_FAILED')
      assert.equal((await api.post('/v1/auth/otp/request', { phone: '9876500011', captchaToken: 'good' })).status, 200)

      // Cloudflare unreachable: fail safe. A new number is refused, an account holder still gets in.
      globalThis.fetch = async (url, init) => {
        if (String(url).includes('challenges.cloudflare.com')) throw new TypeError('fetch failed')
        return realFetch(url, init)
      }
      const fresh = await api.post('/v1/auth/otp/request', { phone: '9876500012', captchaToken: 'good' })
      assert.equal(fresh.status, 503)
      assert.equal(fresh.body.error.code, 'CAPTCHA_UNAVAILABLE')
      await query(`INSERT INTO customers (id, phone, name, created_at) VALUES ('cus_known', '+919876500013', 'Known', now())`)
      assert.equal((await api.post('/v1/auth/otp/request', { phone: '9876500013', captchaToken: 'good' })).status, 200)
    } finally {
      globalThis.fetch = realFetch
      env.TURNSTILE_SECRET_KEY = ''
      env.TURNSTILE_SITE_KEY = ''
    }
  })
})

describe('idempotency keys', () => {
  test('a retry with the same body replays; another customer or another body does not', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 1 }, { token: cust.accessToken })
    const q = await api.post('/v1/checkout/quote', { pincode: '560034' }, { token: cust.accessToken })
    const body = { quoteId: q.body.quoteId, address: '12, 4th Cross, Koramangala, Bengaluru' }
    const send = (b, token = cust.accessToken) => api.post('/v1/checkout/confirm', b, { token, headers: { 'Idempotency-Key': 'same-key' } })
    const first = await send(body)
    assert.equal(first.status, 201)
    const retry = await send({ address: body.address, quoteId: body.quoteId }) // same body, keys in another order
    assert.equal(retry.status, 200)
    assert.equal(retry.body.orderId, first.body.orderId)
    assert.equal((await send({ ...body, address: '99, Another Street, Indiranagar' })).body.error.code, 'IDEMPOTENCY_KEY_REUSED')
    // Another customer's identical key is theirs alone.
    const other = await customerToken(api)
    assert.equal((await send(body, other.accessToken)).body.error.code, 'QUOTE_EXPIRED')
  })
})

describe('delivery proof', () => {
  async function outForDelivery(cust, gift) {
    const o = await paidOrder(cust, gift ? {} : undefined)
    const id = o.orderId
    if (gift) {
      await query(`UPDATE orders SET gift_recipient_name = 'Asha', gift_recipient_phone = '+919811122233' WHERE id = $1`, [id])
    }
    await api.patch(`/admin/v1/orders/${id}/status`, { status: 'PROCESSING' }, { token: admin })
    await api.post(`/admin/v1/orders/${id}/allocate`, undefined, { token: admin })
    await api.patch(`/admin/v1/orders/${id}/status`, { status: 'PACKED' }, { token: admin })
    assert.equal((await api.post(`/admin/v1/orders/${id}/dispatch`, undefined, { token: admin })).status, 204)
    return id
  }

  test('a gift recipient gets the delivery code too', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const id = await outForDelivery(cust, true)
    const sent = []
    await sendDueNotifications({ sender: async (m) => (sent.push(m), 'wamid.x') })
    const code = (await order(id)).delivery_code
    const toRecipient = sent.find((m) => m.phone === '+919811122233')
    assert.equal(toRecipient.template, 'mandi_out_for_delivery')
    assert.equal(toRecipient.params[0], 'Asha')
    assert.equal(toRecipient.params.at(-1), code)
    assert.ok(sent.some((m) => m.phone !== '+919811122233' && m.template === 'mandi_out_for_delivery'), 'the buyer still hears too')
  })

  test('photo deliveries wait for a check by someone other than the rider', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const id = await outForDelivery(cust)
    for (let i = 0; i < 5; i++) await api.post(`/admin/v1/orders/${id}/delivery`, { outcome: 'DELIVERED', code: '0000' === (await order(id)).delivery_code ? '1111' : '0000' }, { token: ops })
    const JPEG = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#fa0' } }).jpeg().toBuffer()
    const ph = await api.raw('POST', `/admin/v1/orders/${id}/delivery-photos`, { token: ops, headers: { 'Content-Type': 'image/jpeg' }, raw: JPEG })
    const done = await api.post(`/admin/v1/orders/${id}/delivery`, { outcome: 'DELIVERED', photoId: ph.body.id, receivedBy: 'Security guard' }, { token: ops })
    assert.equal(done.status, 200, JSON.stringify(done.body))

    const attention = (await api.get('/admin/v1/attention', { token: admin })).body
    const review = attention.photoDeliveries[0]
    assert.deepEqual(review.flags, ['5 wrong codes first', 'no location'])
    // The person who delivered it can't sign it off.
    assert.equal((await api.post(`/admin/v1/delivery-reviews/${review.id}`, { ok: true }, { token: ops })).status, 403)
    assert.equal((await api.post(`/admin/v1/delivery-reviews/${review.id}`, { ok: false }, { token: admin })).body.error.code, 'NOTE_REQUIRED')
    assert.equal((await api.post(`/admin/v1/delivery-reviews/${review.id}`, { ok: false, note: 'Photo shows a different gate' }, { token: admin })).status, 204)
    assert.deepEqual((await api.get('/admin/v1/delivery-reviews', { token: admin })).body, [])
    const events = (await query('SELECT reason FROM order_events WHERE order_id = $1', [id])).rows.map((e) => e.reason)
    assert.ok(events.some((r) => r?.startsWith('Delivery photo doubted')))
  })
})

describe('claims', () => {
  async function deliveredOrder(cust, method = 'code') {
    const o = await paidOrder(cust)
    await query(`UPDATE orders SET status = 'DELIVERED' WHERE id = $1`, [o.orderId])
    await query(
      `INSERT INTO delivery_attempts (id, order_id, outcome, method, actor, created_at) VALUES ($1, $2, 'DELIVERED', $3, 'rider', $4)`,
      [newId('dat'), o.orderId, method, now()],
    )
    return o.orderId
  }
  const claim = (cust, orderId, issueType = 'DAMAGED') =>
    api.post('/v1/claims', { orderId, issueType, description: 'Two mangoes squashed' }, { token: cust.accessToken })

  test('"not delivered" on a code-confirmed order, or a frequent claimant, needs a manager', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 30 } })
    const cust = await customerToken(api)
    const first = await claim(cust, await deliveredOrder(cust), 'NOT_DELIVERED')
    assert.equal(first.status, 201)
    const list = (await api.get('/admin/v1/claims', { token: ops })).body
    assert.deepEqual(list[0].managerNeeded, ["the customer's own code confirmed the delivery"])
    assert.equal(list[0].delivery.method, 'code')
    const r = await api.post(`/admin/v1/claims/${first.body.id}/resolve`, { resolution: 'REPLACEMENT_APPROVED' }, { token: ops })
    assert.equal(r.body.error.code, 'MANAGER_REQUIRED')
    assert.equal((await api.post(`/admin/v1/claims/${first.body.id}/resolve`, { resolution: 'REPLACEMENT_APPROVED' }, { token: admin })).status, 204)
    // The same order can't be claimed again once replaced.
    const orderId = (await query('SELECT order_id FROM claims WHERE id = $1', [first.body.id])).rows[0].order_id
    assert.equal((await claim(cust, orderId)).body.error.code, 'ALREADY_REPLACED')
  })

  test('three claims a month, then the customer is asked to message us', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 30 } })
    const cust = await customerToken(api)
    for (let i = 0; i < 3; i++) {
      const c = await claim(cust, await deliveredOrder(cust, 'staff'))
      assert.equal(c.status, 201, JSON.stringify(c.body))
      await query(`UPDATE claims SET status = 'RESOLVED', resolution = 'REJECTED' WHERE id = $1`, [c.body.id])
    }
    const fourth = await claim(cust, await deliveredOrder(cust, 'staff'))
    assert.equal(fourth.status, 429)
    assert.equal(fourth.body.error.code, 'CLAIM_LIMIT')
  })
})

describe('staff access', () => {
  test('every staff route is either open to operators or manager-only', () => {
    const unclassified = []
    let authed = false
    let seen = 0
    // admin.js mounts each area's router (src/admin/*.js), so walk into nested routers.
    const walk = (stack) => {
      for (const layer of stack) {
        if (!layer.route) {
          if (layer.name === 'requireAdmin') authed = true
          else if (layer.name === 'router') walk(layer.handle.stack)
          continue
        }
        if (!authed) continue
        const managerOnly = layer.route.stack.some((s) => s.name === 'requireManager')
        for (const method of Object.keys(layer.route.methods)) {
          seen++
          const m = method.toUpperCase()
          const listed = OPERATOR_ROUTES.some((r) => r.method === m && r.re.test(layer.route.path.replace(/:\w+/g, 'x')))
          if (listed === managerOnly) unclassified.push(`${m} ${layer.route.path} (${managerOnly ? 'manager-only but listed for operators' : 'not listed'})`)
        }
      }
    }
    walk(adminRouter.stack)
    assert.ok(seen > 50, `walked ${seen} staff routes`)
    assert.deepEqual(unclassified, [])
    assert.equal(roleAllows('OPERATOR', 'GET', '/staff'), false)
    assert.equal(roleAllows('OPERATOR', 'GET', '/orders'), true)
  })

  test('operators are refused anything not on their list', async () => {
    assert.equal((await api.get('/admin/v1/staff', { token: ops })).status, 403)
    assert.equal((await api.get('/admin/v1/orders', { token: ops })).status, 200)
  })
})

describe('maintenance time slices', () => {
  test('a step never gets more than its slice of the run', async () => {
    let seen = null
    await withBudget(45_000, async () => {
      const { withSlice } = await import('../src/budget.js')
      await withSlice(SLICE.reconcile, async () => {
        seen = timeLeft()
      })
    })
    assert.ok(seen <= SLICE.reconcile && seen > SLICE.reconcile - 1000)
  })

  test('the hold sweep, batch retirement and the audit run even with little time left', async () => {
    await makeBatch({ age: 30, rating: 'RIPE', lines: { 'ALP-3': 1 } })
    const out = await runMaintenance({ budgetMs: 4_500 })
    assert.notEqual(out.expired, null)
    assert.equal(out.retired, 1)
    assert.notEqual(out.drift, null)
  })
})
