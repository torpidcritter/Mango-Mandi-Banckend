// Remediation Stage 3 regression tests, one block per audit finding.
import { adminToken, checkout, client, closeAll, customerToken, makeBatch, resetDb, startServer, T0 } from './helpers.js'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { after, before, beforeEach, describe, test } from 'node:test'
import pino from 'pino'
import { isDate, setNow } from '../src/clock.js'
import { query } from '../src/db.js'
import { env } from '../src/env.js'
import { reconcilePendingPayments } from '../src/payments.js'
import { REDACT_PATHS } from '../src/logger.js'

let srv
let api
let manager

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
})

describe('SEC-01: a deleted account cannot keep using its token', () => {
  test('cart, checkout, orders and phone change all answer 401 after deletion', async () => {
    const cust = await customerToken(api)
    const t = { token: cust.accessToken }
    assert.equal((await api.get('/v1/cart', t)).status, 200)
    assert.equal((await api.del('/v1/me', t)).status, 204)
    assert.equal((await api.get('/v1/cart', t)).status, 401)
    assert.equal((await api.get('/v1/orders', t)).status, 401)
    assert.equal((await api.post('/v1/checkout/confirm', {}, t)).status, 401)
    assert.equal((await api.post('/v1/me/phone/verify', { phone: '9876500001', code: '000000' }, t)).status, 401)
  })
})

describe('INV-05: impossible calendar dates are refused', () => {
  test('isDate refuses dates that would roll over', () => {
    for (const d of ['2026-02-31', '2026-04-31', '2026-13-01', '2026-00-10', '2025-02-29']) assert.equal(isDate(d), false, d)
    for (const d of ['2026-02-28', '2028-02-29', '2026-12-31']) assert.equal(isDate(d), true, d)
  })

  test('staff routes answer 400 instead of using the rolled-over day', async () => {
    const opts = { token: manager }
    assert.equal((await api.get('/admin/v1/pack-list?date=2026-02-31', opts)).status, 400)
    assert.equal((await api.del('/admin/v1/calendar/2026-02-30', opts)).status, 400)
    assert.equal((await api.get('/admin/v1/pack-list?date=2026-02-28', opts)).status, 200)
  })
})

describe('OPS-06: error codes reach the logs; login codes do not', () => {
  test('err.code and SQLSTATEs stay, codes in bodies are redacted', () => {
    const lines = []
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(chunk))
        cb()
      },
    })
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, sink)
    const err = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
    log.error({ err }, 'db down')
    log.warn({ sqlState: '40001' }, 'retried')
    log.info({ body: { phone: '98xxxxxx01', code: '123456' } }, 'verify')
    log.info({ req: { body: { code: '654321' } } }, 'nested')
    log.info({ code: '111111', devCode: '222222', accessToken: 'tok' }, 'top level')
    assert.equal(lines[0].err.code, 'ECONNREFUSED')
    assert.equal(lines[1].sqlState, '40001')
    assert.equal(lines[2].body.code, '[redacted]')
    assert.equal(lines[3].req.body.code, '[redacted]')
    assert.equal(lines[4].code, '[redacted]')
    assert.equal(lines[4].devCode, '[redacted]')
    assert.equal(lines[4].accessToken, '[redacted]')
    assert.ok(!JSON.stringify(lines).match(/123456|654321|111111|222222/))
  })
})

/** Points Razorpay calls at a stub for the length of fn (test keys, never live). */
async function withRazorpay(handler, fn) {
  const realFetch = globalThis.fetch
  env.RAZORPAY_KEY_ID = 'rzp_test_x'
  env.RAZORPAY_KEY_SECRET = 'secret'
  const calls = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (!u.startsWith('https://api.razorpay.com/')) return realFetch(url, init)
    const path = u.slice('https://api.razorpay.com/v1'.length)
    calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(init.body) : null })
    return new Response(JSON.stringify(handler(init?.method ?? 'GET', path) ?? {}), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = realFetch
    env.RAZORPAY_KEY_ID = ''
    env.RAZORPAY_KEY_SECRET = ''
  }
}

describe('OPS-07: Razorpay replies are checked before use', () => {
  for (const [label, reply] of [['an empty reply', {}], ['a null id', { id: null }], ['a number id', { id: 123 }], ['a wrong prefix', { id: 'pay_X' }]]) {
    test(`${label} to create order: 502 and the order is cancelled, stock released`, async () => {
      await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
      const cust = await customerToken(api)
      await withRazorpay(() => reply, async () => {
        const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
        assert.equal(c.status, 502)
        assert.equal(c.body.error.code, 'PAYMENT_GATEWAY_ERROR')
      })
      const { rows } = await query('SELECT status, razorpay_order_id FROM orders')
      assert.deepEqual(rows.map((r) => [r.status, r.razorpay_order_id]), [['CANCELLED', null]])
    })
  }

  test('a refund list with a bad item is refused, not half-read', async () => {
    const { gatewayItems, gatewayId } = await import('../src/payments.js')
    assert.throws(() => gatewayItems({ items: 'x' }, 'rfnd_', 'refund list'))
    assert.throws(() => gatewayItems({ items: [{ id: 'rfnd_1', status: 'processed', amount: '100' }] }, 'rfnd_', 'refund list'))
    assert.equal(gatewayItems({ items: [{ id: 'rfnd_1', status: 'processed', amount: 100 }] }, 'rfnd_', 'refund list').length, 1)
    assert.equal(gatewayId({ id: 'order_ABC' }, 'order_', 'x'), 'order_ABC')
  })
})

describe('PAY-05: an authorized payment found by reconcile is captured', () => {
  test('a missed payment.authorized webhook no longer leaves the money blocked', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const cust = await customerToken(api)
    let total
    await withRazorpay(
      (method, path) => {
        if (method === 'POST' && path === '/orders') return { id: 'order_T1' }
        if (path === '/orders/order_T1/payments') return { items: [{ id: 'pay_A1', status: 'authorized', amount: total, currency: 'INR' }] }
        if (path === '/payments/pay_A1/capture') return { id: 'pay_A1', status: 'captured' }
        return {}
      },
      async (calls) => {
        const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
        assert.equal(c.status, 201)
        total = (await query('SELECT total FROM orders WHERE id = $1', [c.body.orderId])).rows[0].total
        setNow(new Date(Date.parse(T0) + 3 * 60_000).toISOString())
        await reconcilePendingPayments()
        const capture = calls.find((x) => x.path === '/payments/pay_A1/capture')
        assert.ok(capture, 'capture was requested')
        assert.deepEqual(capture.body, { amount: total, currency: 'INR' })
      },
    )
  })

  test('an authorized payment for the wrong amount is not captured', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const cust = await customerToken(api)
    await withRazorpay(
      (method, path) => {
        if (method === 'POST' && path === '/orders') return { id: 'order_T2' }
        if (path === '/orders/order_T2/payments') return { items: [{ id: 'pay_A2', status: 'authorized', amount: 1, currency: 'INR' }] }
        return {}
      },
      async (calls) => {
        assert.equal((await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])).status, 201)
        setNow(new Date(Date.parse(T0) + 3 * 60_000).toISOString())
        await reconcilePendingPayments()
        assert.ok(!calls.some((x) => x.path.endsWith('/capture')))
      },
    )
  })
})

describe('FE-2 / FE-3: the API sends what the shop and panel used to guess', () => {
  test('claimUntil follows the live claim window; failed deliveries say whether a retry is booked', async () => {
    const { addEvent, SYSTEM } = await import('../src/orders.js')
    const { getConfig, saveConfig } = await import('../src/config.js')
    const { tx } = await import('../src/db.js')
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    await api.post('/v1/dev/pay', { orderId: c.body.orderId, outcome: 'captured' })
    const t = { token: cust.accessToken }
    const view = async () => (await api.get(`/v1/orders/${c.body.orderId}`, t)).body

    let o = await view()
    assert.equal(o.claimUntil, null)
    assert.equal(o.retryScheduled, null)

    await query(`UPDATE orders SET status = 'DELIVERY_FAILED', delivery_failures = 1 WHERE id = $1`, [o.id])
    assert.deepEqual([(await view()).retryScheduled, (await view()).deliveryFailures], [true, 1])
    await query(`UPDATE orders SET delivery_failures = 3 WHERE id = $1`, [o.id])
    assert.equal((await view()).retryScheduled, false)

    await query(`UPDATE orders SET status = 'DELIVERED' WHERE id = $1`, [o.id])
    await tx((c2) => addEvent(c2, o.id, 'OUT_FOR_DELIVERY', 'DELIVERED', SYSTEM))
    o = await view()
    const delivered = (await query(`SELECT MAX(created_at) AS at FROM order_events WHERE order_id = $1 AND status = 'DELIVERED'`, [o.id])).rows[0].at
    assert.equal(o.claimWindowHours, 24)
    assert.equal(Date.parse(o.claimUntil), delivered.getTime() + 24 * 3_600_000)
    const rules = getConfig()
    try {
      await saveConfig({ ...rules, claimWindowHours: 48 }, 'test')
      o = await view()
      assert.equal(Date.parse(o.claimUntil), delivered.getTime() + 48 * 3_600_000)
    } finally {
      await saveConfig(rules, 'test')
    }
  })

  test('the panel summary carries maxSellableAge', async () => {
    const s = await api.get('/admin/v1/summary', { token: manager })
    assert.equal(s.body.maxSellableAge, 7)
  })
})

describe('order status changes come from one map', () => {
  test('every staff move, cancel and payment is in ORDER_TRANSITIONS; delivered is final', async () => {
    const { ORDER_TRANSITIONS, MANAGER_REFUNDABLE, assertTransition } = await import('../src/orders.js')
    for (const from of MANAGER_REFUNDABLE) assert.ok(ORDER_TRANSITIONS[from].includes('CANCELLED'), from)
    assert.deepEqual(ORDER_TRANSITIONS.DELIVERED, [])
    assert.throws(() => assertTransition('DELIVERED', 'CANCELLED'), /cannot go from DELIVERED to CANCELLED/)
    assert.throws(() => assertTransition('PACKED', 'DELIVERED'))
    assert.doesNotThrow(() => assertTransition('CANCELLED', 'CONFIRMED'))
  })

  test('no file outside orders.js writes an order status, and each write there is guarded', async () => {
    const { readdir, readFile } = await import('node:fs/promises')
    const dir = new URL('../src/', import.meta.url)
    for (const f of (await readdir(dir)).filter((x) => x.endsWith('.js'))) {
      const src = await readFile(new URL(f, dir), 'utf8')
      const writes = [...src.matchAll(/UPDATE orders SET status\b/g)]
      if (f !== 'orders.js') assert.equal(writes.length, 0, `${f} writes orders.status directly`)
      else {
        for (const w of writes) {
          const before = src.slice(Math.max(0, w.index - 400), w.index)
          assert.match(before, /assertTransition\(/, `unguarded status write at offset ${w.index}`)
        }
        assert.equal(writes.length, 3)
      }
    }
  })
})

test('cancelling an order twice says it is already cancelled, not packed', async () => {
  await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
  const cust = await customerToken(api)
  const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
  const t = { token: cust.accessToken }
  assert.equal((await api.post(`/v1/orders/${c.body.orderId}/cancel`, {}, t)).status, 204)
  const again = await api.post(`/v1/orders/${c.body.orderId}/cancel`, {}, t)
  assert.equal(again.status, 409)
  assert.equal(again.body.error.code, 'NOT_CANCELLABLE')
  assert.match(again.body.error.message, /already cancelled/)
})
