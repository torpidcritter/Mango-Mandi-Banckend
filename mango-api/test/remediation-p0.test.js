// Remediation Stage 1 (P0) regression tests. Each test reproduces an audit
// finding from 2026-10-22 and proves the fix.
import { closeAll, checkout, client, customerToken, line, makeBatch, resetDb, startServer, T0 } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { setNow } from '../src/clock.js'
import { query } from '../src/db.js'
import { auditLedger } from '../src/inventory.js'

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
beforeEach(async () => {
  await resetDb()
})

const at = (minutes) => setNow(new Date(Date.parse(T0) + minutes * 60_000).toISOString())
const status = async (id) => (await query('SELECT status FROM orders WHERE id = $1', [id])).rows[0].status
const catalogueQty = async (sku, stage) =>
  (await api.get('/v1/catalogue?pincode=560034')).body.items.find((i) => i.sku === sku && i.stage === stage).qty

describe('lazy hold expiry (INV-01)', () => {
  test('an expired hold frees its stock with no maintenance run: the next buyer gets it and the stale order is cancelled', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 2 } })
    const first = await customerToken(api)
    const one = await checkout(api, first.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])
    assert.equal(one.status, 201, JSON.stringify(one.body))
    assert.equal((await line(b, 'ALP-3')).held, 2)

    // Still inside the hold: sold out for everyone else.
    const early = await customerToken(api)
    assert.equal((await checkout(api, early.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])).status, 409)

    // 12.5 minutes later the hold has run out, with its 2-minute grace for a late
    // webhook (PAY-B5). No scheduler, no /internal/maintenance.
    at(12.5)
    const second = await customerToken(api)
    const two = await checkout(api, second.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])
    assert.equal(two.status, 201, JSON.stringify(two.body))

    assert.equal(await status(one.body.orderId), 'CANCELLED')
    assert.equal(await status(two.body.orderId), 'PAYMENT_PENDING')
    const l = await line(b, 'ALP-3')
    assert.equal(l.held, 2)
    assert.deepEqual(await auditLedger({ query }), [])
    const ev = (await query(`SELECT actor, reason FROM order_events WHERE order_id = $1 AND status = 'CANCELLED'`, [one.body.orderId])).rows
    assert.equal(ev.length, 1)
    assert.match(ev[0].reason, /hold expired/)
  })

  test('the catalogue counts boxes on an expired hold as available before anything sweeps it', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 3 } })
    const first = await customerToken(api)
    assert.equal((await checkout(api, first.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 3 }])).status, 201)
    assert.equal(await catalogueQty('ALP-3', 'RIPE'), 0)
    at(11)
    assert.equal(await catalogueQty('ALP-3', 'RIPE'), 3)
  })

  test('two buyers racing for stock on an expired hold: exactly one wins, nothing oversold, ledger clean', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 2 } })
    const first = await customerToken(api)
    const one = await checkout(api, first.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])
    assert.equal(one.status, 201)
    at(12.5) // past the hold and its 2-minute grace for a late webhook (PAY-B5)
    const [x, y] = await Promise.all([customerToken(api), customerToken(api)])
    const results = await Promise.all([
      checkout(api, x.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }]),
      checkout(api, y.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }]),
    ])
    const codes = results.map((r) => r.status).sort()
    assert.deepEqual(codes, [201, 409], JSON.stringify(results.map((r) => r.body)))
    assert.equal(await status(one.body.orderId), 'CANCELLED')
    const l = await line(b, 'ALP-3')
    assert.ok(l.held + l.committed <= l.on_hand)
    assert.equal(l.held, 2)
    assert.deepEqual(await auditLedger({ query }), [])
  })
})

const confirmWith = (token, quoteId, key) =>
  api.post('/v1/checkout/confirm', { quoteId, address: '12, 4th Cross, Koramangala, Bengaluru' }, { token, headers: { 'Idempotency-Key': key } })
const quote = async (token) => {
  const q = await api.post('/v1/checkout/quote', { pincode: '560034' }, { token })
  assert.equal(q.status, 200, JSON.stringify(q.body))
  return q.body.quoteId
}

describe('unpaid-order limit per customer (INV-02)', () => {
  test('a second unpaid order is refused with a pointer to the first; paying, cancelling or expiry lifts it', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 30 } })
    const cust = await customerToken(api)
    const one = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])
    assert.equal(one.status, 201)

    const two = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])
    assert.equal(two.status, 409)
    assert.equal(two.body.error.code, 'UNPAID_ORDER_EXISTS')
    assert.equal(two.body.error.orderId, one.body.orderId)
    assert.equal((await line(b, 'ALP-3')).held, 2, 'the refused order took nothing')

    // Cancelling the first lets them order again.
    assert.equal((await api.post(`/v1/orders/${one.body.orderId}/cancel`, {}, { token: cust.accessToken })).status, 204)
    const three = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])
    assert.equal(three.status, 201, JSON.stringify(three.body))

    // An order whose hold has run out doesn't count (swept lazily once its 2-minute grace for a late webhook is over).
    at(12.5)
    const four = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])
    assert.equal(four.status, 201, JSON.stringify(four.body))
    assert.equal(await status(three.body.orderId), 'CANCELLED')

    // Other customers are not affected.
    const other = await customerToken(api)
    assert.equal((await checkout(api, other.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])).status, 201)
    assert.deepEqual(await auditLedger({ query }), [])
  })

  test('two confirms at once by the same customer: exactly one order', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 30 } })
    const cust = await customerToken(api)
    assert.equal((await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 5 }, { token: cust.accessToken })).status, 204)
    const q1 = await quote(cust.accessToken)
    const q2 = await quote(cust.accessToken)
    const rs = await Promise.all([confirmWith(cust.accessToken, q1, 'race-1'), confirmWith(cust.accessToken, q2, 'race-2')])
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409], JSON.stringify(rs.map((r) => r.body)))
    assert.equal(rs.find((r) => r.status === 409).body.error.code, 'UNPAID_ORDER_EXISTS')
    const n = (await query(`SELECT count(*)::int AS n FROM orders WHERE customer_id = $1 AND status = 'PAYMENT_PENDING'`, [cust.customer.id])).rows[0].n
    assert.equal(n, 1)
    assert.equal((await line(b, 'ALP-3')).held, 5)
  })

  test('the boxes one customer can hold unpaid are capped by a rule', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 30 } })
    const { DEFAULT_RULES, loadConfig } = await import('../src/config.js')
    await query(`INSERT INTO app_config (version, value, changed_by) VALUES (2, $1, 'test')`, [{ ...DEFAULT_RULES, maxHeldBoxes: 3 }])
    await loadConfig()
    const cust = await customerToken(api)
    const r = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 4 }])
    assert.equal(r.status, 409)
    assert.equal(r.body.error.code, 'HOLD_LIMIT')
    assert.equal(r.body.error.maxHeldBoxes, 3)
  })

  test('rule versions saved before the limit existed still load, with the defaults', async () => {
    const { DEFAULT_RULES, loadConfig, getConfig } = await import('../src/config.js')
    const { maxUnpaidOrders, maxHeldBoxes, ...old } = DEFAULT_RULES
    await query(`INSERT INTO app_config (version, value, changed_by) VALUES (2, $1, 'test')`, [old])
    await loadConfig()
    assert.equal(getConfig().maxUnpaidOrders, 1)
    assert.equal(getConfig().maxHeldBoxes, 40)
  })

  test('WhatsApp ordering obeys the same limit as the shop', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 30 } })
    const cust = await customerToken(api, '9812300001')
    const shop = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal(shop.status, 201)
    const { handleInbound } = await import('../src/chat.js')
    let seq = 0
    const say = (input) =>
      handleInbound({ waId: '919812300001', name: 'Asha', messageId: `wamid.lim.${++seq}`, input: typeof input === 'string' ? { text: input } : input }, { send: async () => {} })
    await say('hi')
    await say({ id: 'ORDER' })
    await say('560034')
    await say({ id: 'item:ALP-3|RIPE' })
    await say({ id: 'qty:2' })
    await say({ id: 'CHECKOUT' })
    await say('12, 4th Cross, Koramangala, Bengaluru')
    const replies = await say({ id: 'PAY' })
    assert.match(replies.map((r) => r.text ?? '').join(' '), /already have an unpaid order/)
    const n = (await query(`SELECT count(*)::int AS n FROM orders WHERE customer_id = $1`, [cust.customer.id])).rows[0].n
    assert.equal(n, 1)
  })
})

describe('payment state the shop can be honest about (FE-1, FE-5)', () => {
  test('the order list points at a held unpaid order, and a swept order says its hold expired', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const one = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    const list = await api.get('/v1/orders', { token: cust.accessToken })
    assert.ok(list.body[0].holdExpiresAt)
    assert.equal((await api.get(`/v1/orders/${one.body.orderId}`, { token: cust.accessToken })).body.cancelReason, null)

    at(11)
    const { runMaintenance } = await import('../src/maintenance.js')
    await runMaintenance()
    const o = await api.get(`/v1/orders/${one.body.orderId}`, { token: cust.accessToken })
    assert.equal(o.body.status, 'CANCELLED')
    assert.equal(o.body.cancelReason, 'HOLD_EXPIRED')
    assert.ok(o.body.cancelledAt)
    assert.equal((await api.get('/v1/orders', { token: cust.accessToken })).body[0].holdExpiresAt, null)

    // A customer's own cancel is not a hold expiry.
    const two = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal(two.status, 201)
    await api.post(`/v1/orders/${two.body.orderId}/cancel`, {}, { token: cust.accessToken })
    assert.equal((await api.get(`/v1/orders/${two.body.orderId}`, { token: cust.accessToken })).body.cancelReason, 'OTHER')
  })
})
