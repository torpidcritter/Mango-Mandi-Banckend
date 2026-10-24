// Business invariants under failure (readiness roadmap, phase 2). One describe
// per failure scenario. Each test drives the failure through the real HTTP
// routes (or the maintenance jobs), checks the outcome the business needs, and
// ends with assertDatabaseValid(): whatever went wrong, the database is left
// valid and recoverable. Each describe names the guard it relies on; the
// readiness report (FAILURE-SCENARIOS.md) records what happened when that
// guard was switched off locally.
//
// Razorpay is never called. A fetch stub stands in for it with only the calls
// the code already makes (the same stub pay-fixes.test.js uses).
import { adminToken, checkout, client, closeAll, customerToken, line, makeBatch, resetDb, signWebhook, startServer, T0 } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { drainBackground } from '../src/background.js'
import { now, setNow } from '../src/clock.js'
import { pool, query, tx } from '../src/db.js'
import { env } from '../src/env.js'
import { newId } from '../src/ids.js'
import { auditLedger } from '../src/inventory.js'
import { rebalanceAllOpen, runMaintenance } from '../src/maintenance.js'
import { CONFIRMATION_HELD, OPEN_STATUSES, ORDER_TRANSITIONS, sweepExpiredHolds } from '../src/orders.js'
import { processDueRefunds, refundDuplicatePayments } from '../src/payments.js'

let srv
let api
let manager
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
  manager = await adminToken(api)
  ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
})

const MIN = 60_000
const DAY = 86_400_000
const at = (ms) => setNow(new Date(Date.parse(T0) + ms).toISOString())
const order = async (id) => (await query('SELECT * FROM orders WHERE id = $1', [id])).rows[0]
const ok = (r) => r.status >= 200 && r.status < 300
const setStatus = (id, body, token = manager) => api.patch(`/admin/v1/orders/${id}/status`, body, { token })
const devPay = (orderId) => api.post('/v1/dev/pay', { orderId, outcome: 'captured' })

/** A signed Razorpay webhook, as Razorpay sends it (same event id on every retry). */
function hook(event, eventId = newId('evt')) {
  const { raw, signature } = signWebhook(event)
  return api.raw('POST', '/webhooks/razorpay', {
    raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': eventId },
  })
}
const captured = (o, paymentId) => ({
  event: 'payment.captured',
  payload: { payment: { entity: { id: paymentId, order_id: o.razorpayOrderId, amount: o.total, currency: 'INR', method: 'upi' } } },
})

/**
 * Stands in for api.razorpay.com with test keys set (as in pay-fixes.test.js).
 * `handler(method, path, body)` returns a JSON body, [status, body], null (404),
 * or throws (a timeout or a network error), after `delayMs` (Razorpay's latency). Every call is recorded.
 */
function stubRazorpay(handler, { delayMs = 0 } = {}) {
  const realFetch = globalThis.fetch
  const calls = []
  env.RAZORPAY_KEY_ID = 'rzp_test_x'
  env.RAZORPAY_KEY_SECRET = 'key_secret_test'
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (!u.startsWith('https://api.razorpay.com/v1')) return realFetch(url, init)
    const method = init.method ?? 'GET'
    const path = u.slice('https://api.razorpay.com/v1'.length)
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ method, path, body })
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    const out = await handler(method, path, body)
    const [status, json] = Array.isArray(out) ? out : out == null ? [404, { error: { code: 'NOT_FOUND' } }] : [200, out]
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return {
    calls,
    posts: () => calls.filter((c) => c.method === 'POST'),
    restore() {
      globalThis.fetch = realFetch
      env.RAZORPAY_KEY_ID = ''
      env.RAZORPAY_KEY_SECRET = ''
    },
  }
}

/** Razorpay's refunds: lists them per payment and refuses a receipt it has seen before (as in pay-fixes.test.js). */
function refundDesk() {
  const refunds = []
  const receipts = []
  return {
    refunds,
    receipts,
    handle(method, path, body) {
      let m = /^\/payments\/([^/]+)\/refunds$/.exec(path)
      if (m && method === 'GET') return { items: refunds.filter((r) => r.payment_id === m[1]).map(({ id, status, amount }) => ({ id, status, amount })) }
      m = /^\/payments\/([^/]+)\/refund$/.exec(path)
      if (m && method === 'POST') {
        if (receipts.includes(body.receipt)) return [400, { error: { code: 'BAD_REQUEST_ERROR', description: 'Duplicate receipt found for this refund request' } }]
        receipts.push(body.receipt)
        const r = { id: `rfnd_${refunds.length + 1}`, payment_id: m[1], amount: body.amount ?? 0, status: 'pending' }
        refunds.push(r)
        return { id: r.id, status: 'pending', amount: r.amount }
      }
      return null
    },
  }
}
// What fetch throws when AbortSignal.timeout fires, and when the network is down.
const timeoutError = () => new globalThis.DOMException('The operation was aborted due to timeout', 'TimeoutError')
const networkError = () => new TypeError('fetch failed')

/**
 * Database failures, injected at the pool every query goes through.
 * 'down': every new query and connection is refused (ECONNREFUSED).
 * 'commit': the connection drops at COMMIT of a transaction that wrote one of
 * `tables` (the server rolls it back), as when the database restarts mid-request.
 * 'ack': the COMMIT goes through but its reply is lost (the API can't know it worked).
 */
function dbOutage(mode, { tables = ['orders', 'processed_webhooks'] } = {}) {
  const realQuery = pool.query
  const realConnect = pool.connect
  const patched = []
  const killed = { commits: 0 }
  const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })
  const writes = new RegExp(`^\\s*INSERT INTO (${tables.join('|')})\\b`, 'i')
  if (mode === 'down') {
    pool.query = async () => {
      throw refused()
    }
    pool.connect = async (cb) => {
      if (typeof cb === 'function') return cb(refused())
      throw refused()
    }
  } else {
    pool.connect = async function (cb) {
      if (typeof cb === 'function') return realConnect.call(pool, cb) // pool.query's own single statements
      const c = await realConnect.call(pool)
      if (!c.__realQuery) {
        const real = c.query
        c.__realQuery = real
        c.__wrote = false
        c.query = function (text, ...rest) {
          const sql = typeof text === 'string' ? text : (text?.text ?? '')
          if (/^\s*(BEGIN|ROLLBACK)\b/i.test(sql)) c.__wrote = false
          if (writes.test(sql)) c.__wrote = true
          if (/^\s*COMMIT\b/i.test(sql) && c.__wrote) {
            c.__wrote = false
            killed.commits++
            return real.call(c, mode === 'ack' ? 'COMMIT' : 'ROLLBACK').then(() => {
              throw new Error('Connection terminated unexpectedly')
            })
          }
          return real.call(c, text, ...rest)
        }
        patched.push(c)
      }
      return c
    }
  }
  return {
    killed,
    restore() {
      pool.query = realQuery
      pool.connect = realConnect
      for (const c of patched) {
        c.query = c.__realQuery
        delete c.__realQuery
        delete c.__wrote
      }
    },
  }
}

async function buyers(n) {
  const out = []
  for (let i = 0; i < n; i++) out.push(await customerToken(api))
  return out
}

async function placed(cust, qty = 1, opts = {}) {
  const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty }], opts)
  assert.equal(c.status, 201, JSON.stringify(c.body))
  return c.body
}

async function paidOrder(cust = null, qty = 1) {
  cust ??= await customerToken(api)
  const o = await placed(cust, qty)
  assert.equal((await devPay(o.orderId)).body.result, 'confirmed')
  return { ...o, cust }
}

async function allocatedOrder(cust = null) {
  const o = await paidOrder(cust)
  assert.equal((await setStatus(o.orderId, { status: 'PROCESSING' })).status, 204)
  assert.equal((await api.post(`/admin/v1/orders/${o.orderId}/allocate`, undefined, { token: manager })).status, 204)
  return o
}

/**
 * The shared end-of-scenario check: the database is valid and recoverable.
 *  1. the stock ledger audit is clean (inventory.auditLedger);
 *  2. no batch line is over capacity (held + committed + buffer <= on hand, nothing negative);
 *  3. held and committed counters match order_stock, stock sits only on orders that
 *     may hold it, and no order holds more than it ordered;
 *  4. every captured payment is on exactly one order or booking, or recorded in
 *     duplicate_payments; every order past payment is paid;
 *  5. no refund is paid twice, and only cancelled orders are refunded;
 *  6. every order's status history follows ORDER_TRANSITIONS and ends at its status;
 *  7. after a hold sweep, no unpaid hold is left past its expiry.
 * `gateway` adds what the Razorpay stub saw: the payments it captured and the refunds it made.
 */
async function assertDatabaseValid({ sweep = true, gateway = null } = {}) {
  await drainBackground()
  if (sweep) await tx((c) => sweepExpiredHolds(c, now()))
  const rows = async (sql, params) => (await query(sql, params)).rows

  // 1. Ledger audit.
  assert.deepEqual(await tx((c) => auditLedger(c)), [], 'stock counters drift from the ledger')

  // 2. Capacity.
  assert.deepEqual(
    await rows(`SELECT id, on_hand, held, committed, reserve_buffer FROM batch_lines
                 WHERE on_hand < 0 OR held < 0 OR committed < 0 OR reserve_buffer < 0 OR held + committed + reserve_buffer > on_hand`),
    [],
    'a batch line is over capacity',
  )

  // 3. Counters against order_stock, stock against order status, per-order totals.
  assert.deepEqual(
    await rows(`SELECT l.id, l.held, l.committed, COALESCE(s.held, 0) AS stock_held, COALESCE(s.committed, 0) AS stock_committed
                  FROM batch_lines l LEFT JOIN (
                    SELECT line_id, SUM(quantity) FILTER (WHERE state = 'held')::int AS held, SUM(quantity) FILTER (WHERE state = 'committed')::int AS committed
                      FROM order_stock GROUP BY line_id) s ON s.line_id = l.id
                 WHERE l.held <> COALESCE(s.held, 0) OR l.committed <> COALESCE(s.committed, 0)`),
    [],
    'held/committed counters differ from order_stock',
  )
  assert.deepEqual(
    await rows(`SELECT o.number, o.status, s.state FROM order_stock s JOIN orders o ON o.id = s.order_id
                 WHERE (s.state = 'held' AND o.status <> 'PAYMENT_PENDING')
                    OR (s.state = 'committed' AND (o.status = 'PAYMENT_PENDING' OR NOT o.status = ANY($1)))`, [OPEN_STATUSES]),
    [],
    'stock is held or committed for an order that cannot have it',
  )
  assert.deepEqual(
    await rows(`SELECT s.order_id, s.sku, s.stage, SUM(s.quantity)::int AS got, COALESCE(MAX(i.qty), 0)::int AS want
                  FROM order_stock s LEFT JOIN (SELECT order_id, sku, stage, SUM(quantity) AS qty FROM order_items GROUP BY 1, 2, 3) i
                    ON i.order_id = s.order_id AND i.sku = s.sku AND i.stage = s.stage
                 WHERE s.state IN ('held', 'committed', 'packed') GROUP BY 1, 2, 3 HAVING SUM(s.quantity) > COALESCE(MAX(i.qty), 0)`),
    [],
    'an order holds more boxes than it ordered',
  )

  // 4. Payments.
  assert.deepEqual(
    await rows(`SELECT payment_id, COUNT(*)::int AS n FROM (
                  SELECT payment_id FROM orders WHERE payment_id IS NOT NULL
                  UNION ALL SELECT payment_id FROM preorders WHERE payment_id IS NOT NULL
                  UNION ALL SELECT payment_id FROM duplicate_payments) p GROUP BY payment_id HAVING COUNT(*) > 1`),
    [],
    'a payment is attached to more than one order, booking or duplicate record',
  )
  assert.deepEqual(
    await rows(`SELECT number, status, payment_status, payment_id FROM orders
                 WHERE status NOT IN ('PAYMENT_PENDING', 'CANCELLED') AND COALESCE(payment_method, '') <> 'REPLACEMENT'
                   AND (payment_status <> 'SUCCEEDED' OR payment_id IS NULL)`),
    [],
    'an order went past payment without a captured payment',
  )
  assert.deepEqual(
    await rows(`SELECT number, payment_status FROM orders WHERE payment_status IN ('SUCCEEDED', 'REFUNDED') AND payment_id IS NULL`),
    [],
    'an order is marked paid with no payment id',
  )

  // 5. Refunds.
  assert.deepEqual(
    await rows(`SELECT refund_id, COUNT(*)::int AS n FROM (
                  SELECT refund_id FROM orders WHERE refund_id IS NOT NULL
                  UNION ALL SELECT refund_id FROM preorders WHERE refund_id IS NOT NULL
                  UNION ALL SELECT refund_id FROM duplicate_payments WHERE refund_id IS NOT NULL) r GROUP BY refund_id HAVING COUNT(*) > 1`),
    [],
    'one refund is recorded against two things',
  )
  assert.deepEqual(
    await rows(`SELECT number, status, payment_status FROM orders
                 WHERE (refund_requested_at IS NOT NULL OR refund_id IS NOT NULL OR payment_status = 'REFUNDED') AND status <> 'CANCELLED'`),
    [],
    'a refund on an order that is not cancelled (the only refunds are cancellations)',
  )
  assert.deepEqual(await rows(`SELECT number FROM orders WHERE payment_status = 'REFUNDED' AND refund_id IS NULL`), [], 'refunded with no refund id')

  // 6. Status history.
  const events = await rows('SELECT order_id, from_status, status, created_at, id FROM order_events ORDER BY created_at, id')
  const byOrder = Map.groupBy(events, (e) => e.order_id)
  for (const o of await rows('SELECT id, number, status FROM orders')) {
    const evs = byOrder.get(o.id) ?? []
    const created = evs.filter((e) => e.from_status == null)
    assert.equal(created.length, 1, `${o.number}: ${created.length} creation events`)
    assert.ok(['PAYMENT_PENDING', 'CONFIRMED'].includes(created[0].status), `${o.number} created as ${created[0].status}`)
    // Walk the status changes from creation; ties on the timestamp are taken in whichever order chains.
    const moves = evs.filter((e) => e.from_status != null && e.from_status !== e.status)
    let cur = created[0].status
    const seen = new Set([cur])
    while (moves.length) {
      const i = moves.findIndex((e) => e.from_status === cur)
      assert.ok(i >= 0, `${o.number}: no event continues from ${cur}; left ${JSON.stringify(moves.map((e) => [e.from_status, e.status]))}`)
      const [e] = moves.splice(i, 1)
      assert.ok(ORDER_TRANSITIONS[e.from_status]?.includes(e.status), `${o.number}: ${e.from_status} → ${e.status} is not allowed`)
      cur = e.status
      seen.add(cur)
    }
    assert.equal(cur, o.status, `${o.number}: history ends at ${cur} but the order is ${o.status}`)
    for (const e of evs.filter((x) => x.from_status != null && x.from_status === x.status)) {
      assert.ok(seen.has(e.status), `${o.number}: a note on ${e.status}, a status it never had`)
    }
  }

  // 7. Holds.
  if (sweep) {
    assert.deepEqual(
      await rows(`SELECT number FROM orders WHERE status = 'PAYMENT_PENDING' AND hold_expires_at < $1`, [now()]),
      [],
      'an unpaid order is past its hold after a sweep',
    )
    assert.deepEqual(
      await rows(`SELECT o.number FROM order_stock s JOIN orders o ON o.id = s.order_id
                   WHERE s.state = 'held' AND (o.hold_expires_at IS NULL OR o.hold_expires_at < $1)`, [now()]),
      [],
      'stock is still held for an expired hold after a sweep',
    )
  }

  if (gateway) {
    // Every payment Razorpay captured is known to us exactly once.
    for (const pid of gateway.captured ?? []) {
      const [{ n }] = await rows(
        `SELECT ((SELECT COUNT(*) FROM orders WHERE payment_id = $1) + (SELECT COUNT(*) FROM preorders WHERE payment_id = $1)
                 + (SELECT COUNT(*) FROM duplicate_payments WHERE payment_id = $1))::int AS n`,
        [pid],
      )
      assert.equal(n, 1, `captured payment ${pid} is attached ${n} times`)
    }
    // No payment was refunded twice at Razorpay, nor beyond what was paid.
    const live = (gateway.refunds ?? []).filter((r) => r.status !== 'failed')
    for (const [pid, rs] of Map.groupBy(live, (r) => r.payment_id)) {
      assert.equal(rs.length, 1, `payment ${pid} was refunded ${rs.length} times at Razorpay`)
      const [paid] = await rows(
        `SELECT payment_amount AS amount, status FROM orders WHERE payment_id = $1
         UNION ALL SELECT amount, 'DUPLICATE' FROM duplicate_payments WHERE payment_id = $1`,
        [pid],
      )
      assert.ok(paid, `refund for ${pid}, a payment we have no record of`)
      assert.ok(rs[0].amount <= paid.amount, `payment ${pid} refunded ${rs[0].amount} of ${paid.amount}`)
      assert.ok(paid.status === 'CANCELLED' || paid.status === 'DUPLICATE', `payment ${pid} refunded on a ${paid.status} order`)
    }
  }
}

// ----------------------------------------------------------------------------------------------

describe('0. assertDatabaseValid catches broken data', () => {
  // A validator that never fails proves nothing: each kind of damage it is meant to find is made
  // by hand on a valid database (one paid order), and must be reported.
  const ev = (orderId, from, to) =>
    query('INSERT INTO order_events (id, order_id, from_status, status, actor, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [newId('evt'), orderId, from, to, 'test', now()])
  const damage = {
    'counter drift': [/drift from the ledger/, ({ lineId }) => query('UPDATE batch_lines SET held = held + 1 WHERE id = $1', [lineId])],
    'line over capacity': [/over capacity/, async ({ lineId, batchId }) => {
      await query('ALTER TABLE batch_lines DROP CONSTRAINT batch_lines_no_oversell')
      await query('UPDATE batch_lines SET reserve_buffer = on_hand WHERE id = $1', [lineId])
      await query(`INSERT INTO batch_ledger (id, batch_id, event_type, sku, delta, actor_type, actor_id, created_at)
                   SELECT $1, $2, 'ADJUST_BUFFER', sku, reserve_buffer, 'system', 'test', $4 FROM batch_lines WHERE id = $3`, [newId('led'), batchId, lineId, now()])
    }],
    'stock on a cancelled order': [/cannot have it/, async ({ orderId }) => {
      await query(`UPDATE orders SET status = 'CANCELLED' WHERE id = $1`, [orderId])
      await ev(orderId, 'CONFIRMED', 'CANCELLED')
    }],
    'more boxes than ordered': [/more boxes than it ordered/, async ({ orderId, lineId, batchId }) => {
      await query('UPDATE batch_lines SET committed = committed + 1 WHERE id = $1', [lineId])
      await query(`INSERT INTO order_stock (id, order_id, batch_id, line_id, sku, stage, quantity, state) VALUES ($1, $2, $3, $4, 'ALP-3', 'RIPE', 1, 'committed')`, [newId('ost'), orderId, batchId, lineId])
    }],
    'one payment on two records': [/more than one order/, ({ orderId, paymentId }) =>
      query('INSERT INTO duplicate_payments (payment_id, order_id, amount, found_at) VALUES ($1, $2, 1, $3)', [paymentId, orderId, now()])],
    'confirmed without a payment': [/without a captured payment/, ({ orderId }) => query(`UPDATE orders SET payment_status = 'INITIATED' WHERE id = $1`, [orderId])],
    'refund on an open order': [/not cancelled/, ({ orderId }) => query('UPDATE orders SET refund_requested_at = $2 WHERE id = $1', [orderId, now()])],
    'a skipped step': [/is not allowed/, async ({ orderId }) => {
      await query(`UPDATE orders SET status = 'SHIPPED' WHERE id = $1`, [orderId])
      await ev(orderId, 'CONFIRMED', 'SHIPPED')
    }],
    'status with no history': [/history ends at CONFIRMED/, ({ orderId }) => query(`UPDATE orders SET status = 'PROCESSING' WHERE id = $1`, [orderId])],
    'a captured payment we lost': [/attached 0 times/, () => null, { captured: ['pay_nowhere'] }],
    'refunded twice at Razorpay': [/refunded 2 times/, () => null, ({ paymentId }) => ({
      refunds: [{ id: 'rfnd_a', payment_id: paymentId, amount: 1, status: 'processed' }, { id: 'rfnd_b', payment_id: paymentId, amount: 1, status: 'pending' }],
    })],
  }
  test('each kind of damage is reported; the undamaged database passes', async () => {
    for (const [name, [message, breakIt, gateway]] of Object.entries(damage)) {
      await resetDb()
      const batchId = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
      const o = await paidOrder()
      const fixture = { orderId: o.orderId, batchId, lineId: (await line(batchId, 'ALP-3')).id, paymentId: (await order(o.orderId)).payment_id }
      const gw = typeof gateway === 'function' ? gateway(fixture) : gateway
      await assertDatabaseValid({ gateway: gw?.refunds ? { refunds: [] } : null })
      await breakIt(fixture)
      await assert.rejects(assertDatabaseValid({ gateway: gw ?? null }), message, name)
    }
  })
})

describe('1. many customers buy the final boxes at once: never oversold', () => {
  // Guards: inventory.js allocate, the conditional UPDATE "… - held - committed - reserve_buffer >= $2";
  // the batch_lines_no_oversell CHECK (migrations/001_init.sql); createOrder allOrNothing (orders.js),
  // which rolls a short order back whole inside the confirm transaction.
  // Checkouts for one delivery day queue on a per-day lock (delivery.js chooseSlot), but stock is
  // not per day: buyers for 16 and 17 October race for the same boxes, so the buyers are split
  // across both days to reach the stock guard itself.
  const DAYS = ['2026-10-16', '2026-10-17'] // the batch is RIPE on both
  test('20 customers confirm at the same moment for the last 3 boxes, on two delivery days: exactly 3 orders', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 3 } })
    const people = await buyers(20)
    const quotes = []
    for (const [i, p] of people.entries()) {
      assert.equal((await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 1 }, { token: p.accessToken })).status, 204)
      const q = await api.post('/v1/checkout/quote', { pincode: '560034', deliveryDate: DAYS[i % 2] }, { token: p.accessToken })
      assert.equal(q.status, 200, JSON.stringify(q.body)) // a quote holds nothing, so everyone gets one
      quotes.push(q.body.quoteId)
    }
    const results = await Promise.all(
      people.map((p, i) =>
        api.post('/v1/checkout/confirm', { quoteId: quotes[i], address: '12, 4th Cross, Koramangala, Bengaluru' }, { token: p.accessToken, headers: { 'Idempotency-Key': `last-${i}` } }),
      ),
    )
    const won = results.filter((r) => r.status === 201)
    assert.equal(won.length, 3, JSON.stringify(results.map((r) => [r.status, r.body?.error?.code])))
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.body.error.code === 'STOCK_INSUFFICIENT'))
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n, 3, 'a losing confirm left an order behind')
    assert.equal((await line(b, 'ALP-3')).held, 3)

    // The three winners pay at once (webhooks): the boxes move to committed, still 3.
    const paid = await Promise.all(won.map((r, i) => hook(captured(r.body, `pay_last${i}`))))
    assert.deepEqual(paid.map((r) => r.body.result), ['confirmed', 'confirmed', 'confirmed'])
    const l = await line(b, 'ALP-3')
    assert.deepEqual([l.on_hand, l.held, l.committed], [3, 0, 3])
    // The 21st customer is told at once.
    const late = await checkout(api, (await customerToken(api)).accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal(late.status, 409)
    await assertDatabaseValid({ gateway: { captured: ['pay_last0', 'pay_last1', 'pay_last2'] } })
  })

  test('10 customers want 2 each of the last 5 boxes: 2 orders, no part-filled order or stray hold', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const people = await buyers(10)
    const quotes = []
    for (const [i, p] of people.entries()) {
      await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 2 }, { token: p.accessToken })
      const q = await api.post('/v1/checkout/quote', { pincode: '560034', deliveryDate: DAYS[i % 2] }, { token: p.accessToken })
      assert.equal(q.status, 200, JSON.stringify(q.body))
      quotes.push(q.body.quoteId)
    }
    const results = await Promise.all(
      people.map((p, i) =>
        api.post('/v1/checkout/confirm', { quoteId: quotes[i], address: '12, 4th Cross, Koramangala, Bengaluru' }, { token: p.accessToken, headers: { 'Idempotency-Key': `pair-${i}` } }),
      ),
    )
    assert.equal(results.filter((r) => r.status === 201).length, 2, JSON.stringify(results.map((r) => r.status)))
    const l = await line(b, 'ALP-3')
    assert.deepEqual([l.held, l.committed], [4, 0])
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM order_stock WHERE state = 'held'`)).rows[0].n, 2)
    await assertDatabaseValid({ sweep: false })
  })
})

describe('2. a customer pays twice, or Razorpay repeats a webhook: one correct outcome', () => {
  // Guards: payments.js handleWebhook dedupe (processed_webhooks row in the same transaction);
  // orders.js processPayment lockOrder + the already-paid branch, and recordDuplicatePayment
  // (ON CONFLICT DO NOTHING); payments.js refundDuplicatePayments lease + gatewayRefund's lookup of
  // refunds already made.
  test('the same payment.captured event 5 times at once, then under 5 new event ids: confirmed once', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const o = await placed(await customerToken(api))
    const same = await Promise.all([1, 2, 3, 4, 5].map(() => hook(captured(o, 'pay_W1'), 'evt_same_1')))
    assert.ok(same.every((r) => r.status === 200), JSON.stringify(same.map((r) => r.status)))
    assert.equal(same.filter((r) => r.body.result === 'confirmed').length, 1, JSON.stringify(same.map((r) => r.body)))
    assert.equal(same.filter((r) => r.body.duplicate === true).length, 4)
    // The same payment reported again under other events (order.paid and the like): nothing more happens.
    const again = await Promise.all([1, 2, 3, 4, 5].map(() => hook(captured(o, 'pay_W1'))))
    assert.deepEqual(again.map((r) => r.body.result), Array(5).fill('already_paid'))

    const row = await order(o.orderId)
    assert.deepEqual([row.status, row.payment_status, row.payment_id], ['CONFIRMED', 'SUCCEEDED', 'pay_W1'])
    const confirms = await query(`SELECT COUNT(*)::int AS n FROM order_events WHERE order_id = $1 AND status = 'CONFIRMED' AND from_status = 'PAYMENT_PENDING'`, [o.orderId])
    assert.equal(confirms.rows[0].n, 1)
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM notifications WHERE order_id = $1 AND kind = 'ORDER_CONFIRMED'`, [o.orderId])).rows[0].n, 1)
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM duplicate_payments')).rows[0].n, 0)
    await assertDatabaseValid({ gateway: { captured: ['pay_W1'] } })
  })

  test('two payments for one order (two tabs), each webhook retried 3 times at once: one order, the second payment refunded once', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const o = await placed(await customerToken(api))
    const desk = refundDesk()
    const gw = stubRazorpay((m, p, b) => desk.handle(m, p, b))
    try {
      const sends = [
        ...[1, 2, 3].map(() => hook(captured(o, 'pay_T1'), 'evt_tab_1')),
        ...[1, 2, 3].map(() => hook(captured(o, 'pay_T2'), 'evt_tab_2')),
      ]
      const results = await Promise.all(sends)
      assert.ok(results.every((r) => r.status === 200))
      assert.equal(results.filter((r) => r.body.result === 'confirmed').length, 1, JSON.stringify(results.map((r) => r.body)))
      assert.equal(results.filter((r) => r.body.result === 'duplicate_payment').length, 1)
      await drainBackground()

      const row = await order(o.orderId)
      const second = row.payment_id === 'pay_T1' ? 'pay_T2' : 'pay_T1'
      assert.deepEqual([row.status, row.payment_status, row.refund_requested_at], ['CONFIRMED', 'SUCCEEDED', null])
      const dup = (await query('SELECT * FROM duplicate_payments')).rows
      assert.deepEqual(dup.map((d) => [d.payment_id, d.order_id, d.amount]), [[second, o.orderId, o.total]])
      assert.deepEqual(desk.refunds.map((r) => [r.payment_id, r.amount]), [[second, o.total]])
      assert.equal(dup[0].refund_id, desk.refunds[0].id)

      // Every retry path runs again, now and after the lease: nothing more is sent.
      await Promise.all([refundDuplicatePayments(), refundDuplicatePayments(), processDueRefunds()])
      at(5 * MIN)
      await Promise.all([refundDuplicatePayments(), processDueRefunds()])
      assert.equal(gw.posts().length, 1)
      await assertDatabaseValid({ gateway: { captured: ['pay_T1', 'pay_T2'], refunds: desk.refunds } })
    } finally {
      gw.restore()
    }
  })
})

describe('3. payment succeeds after the hold expired and the stock was sold: never lost', () => {
  // Guards: orders.js processPayment (a CANCELLED order whose hold ran out is confirmed late, then
  // placeOnFirstDateWithStock / setRisk); payments.js reconcilePendingPayments (looks at cancelled
  // orders for a day); orders.js setRisk + rebalanceOrder fill it when stock comes.
  async function lostTheBox() {
    const a = await customerToken(api)
    const ca = await placed(a)
    at(12.5 * MIN) // past the 10-minute hold and the 2-minute grace for orders with a Razorpay order (PAY-B5)
    const cb = await placed(await customerToken(api)) // the lazy sweep cancels A and B takes the box
    assert.equal((await devPay(cb.orderId)).body.result, 'confirmed')
    assert.equal((await order(ca.orderId)).status, 'CANCELLED')
    return { a, ca, cb }
  }

  test('no stock anywhere: confirmed and flagged at risk for staff, filled when stock arrives', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 1 } })
    const { ca } = await lostTheBox()
    const r = await hook(captured(ca, 'pay_LATE1'))
    assert.equal(r.status, 200)
    assert.equal(r.body.result, 'confirmed_late')
    let row = await order(ca.orderId)
    assert.deepEqual([row.status, row.payment_status, row.payment_id, row.at_risk, row.refund_requested_at], ['CONFIRMED', 'SUCCEEDED', 'pay_LATE1', true, null])
    const summary = await api.get('/admin/v1/summary', { token: manager })
    assert.ok(summary.body.atRiskOrders.some((x) => x.id === ca.orderId), 'staff see it at risk')
    const held = await query(`SELECT status, last_error FROM notifications WHERE order_id = $1 AND kind = 'ORDER_CONFIRMED'`, [ca.orderId])
    assert.deepEqual(held.rows.map((n) => [n.status, n.last_error]), [['SKIPPED', CONFIRMATION_HELD]], 'no promise of a date we cannot keep')
    await assertDatabaseValid({ gateway: { captured: ['pay_LATE1'] } })

    // Stock arrives: the maintenance re-check fills it.
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 4 } })
    await rebalanceAllOpen({ atRiskOnly: true })
    row = await order(ca.orderId)
    assert.equal(row.at_risk, false)
    assert.equal((await query(`SELECT COALESCE(SUM(quantity), 0)::int AS n FROM order_stock WHERE order_id = $1 AND state = 'committed'`, [ca.orderId])).rows[0].n, 1)
    await assertDatabaseValid({ gateway: { captured: ['pay_LATE1'] } })
  })

  test('stock only on a later day: confirmed for that day and the customer is told', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 1 } }) // RIPE on 10-16
    await makeBatch({ age: 3, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } }) // semi-ripe on 10-16, RIPE from 10-17
    const { ca } = await lostTheBox()
    assert.equal(ca.deliveryDate, '2026-10-16')
    assert.equal((await hook(captured(ca, 'pay_LATE2'))).body.result, 'confirmed_late')
    const row = await order(ca.orderId)
    assert.deepEqual([row.status, row.payment_status, row.delivery_date, row.at_risk], ['CONFIRMED', 'SUCCEEDED', '2026-10-17', false])
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM notifications WHERE order_id = $1 AND kind = 'DATE_MOVED'`, [ca.orderId])).rows[0].n, 1)
    await assertDatabaseValid({ gateway: { captured: ['pay_LATE2'] } })
  })

  test('the webhook never comes: the maintenance run finds the payment at Razorpay and confirms it', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 1 } })
    const { ca } = await lostTheBox()
    assert.equal((await api.post('/v1/dev/mark-paid-at-gateway', { orderId: ca.orderId, outcome: 'captured' })).status, 200)
    at(14 * MIN)
    await runMaintenance({ forceAll: true })
    const row = await order(ca.orderId)
    assert.deepEqual([row.status, row.payment_status, row.at_risk], ['CONFIRMED', 'SUCCEEDED', true])
    assert.match(row.payment_id, /^pay_dev_/)
    await assertDatabaseValid({ gateway: { captured: [row.payment_id] } })
  })
})

describe('4. a refund times out or Razorpay is down: no blind second refund, one refund in the end', () => {
  // Guards: payments.js gatewayRefund (GET /payments/:id/refunds before any POST, so a refund
  // Razorpay made before the timeout is found), claimRefund (2-minute lease per order),
  // refundReceipt (a new receipt per attempt), processDueRefunds (retries what is due).
  async function cancelledPaid(paymentId) {
    const o = await paidOrder()
    await query('UPDATE orders SET payment_id = $2 WHERE id = $1', [o.orderId, paymentId])
    return o
  }

  test('Razorpay times out after making the refund: the retry finds it and sends nothing new', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const o = await cancelledPaid('pay_R1')
    const desk = refundDesk()
    let firstPost = true
    const gw = stubRazorpay((m, p, b) => {
      const out = desk.handle(m, p, b)
      if (m === 'POST' && firstPost) {
        firstPost = false
        throw timeoutError() // Razorpay made the refund; our side gave up waiting
      }
      return out
    })
    try {
      assert.equal((await api.post(`/v1/orders/${o.orderId}/cancel`, {}, { token: o.cust.accessToken })).status, 204)
      let row = await order(o.orderId)
      assert.equal(row.status, 'CANCELLED')
      assert.ok(row.refund_requested_at)
      assert.deepEqual([row.refunded_at, row.refund_id], [null, null]) // not recorded as done: it is still owed
      assert.equal(desk.refunds.length, 1)
      // Recoverable and visible: the stuck refund is on Needs attention after 30 minutes.
      at(31 * MIN)
      const att = await api.get('/admin/v1/attention', { token: manager })
      assert.ok(att.body.stuckRefunds.some((s) => s.id === o.orderId), JSON.stringify(att.body.stuckRefunds))
      // The retry (cancel path, maintenance, several instances) asks Razorpay first.
      await Promise.all([processDueRefunds(), processDueRefunds(), processDueRefunds()])
      row = await order(o.orderId)
      assert.deepEqual([row.payment_status, row.refund_id], ['REFUNDED', 'rfnd_1'])
      assert.equal(gw.posts().length, 1, 'a second refund was sent')
      assert.equal(await processDueRefunds(), 0)
      await assertDatabaseValid({ gateway: { captured: ['pay_R1'], refunds: desk.refunds } })
    } finally {
      gw.restore()
    }
  })

  test('Razorpay answers 500, then the network fails, then it works: exactly one refund', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const o = await cancelledPaid('pay_R2')
    const desk = refundDesk()
    let mode = '500'
    const gw = stubRazorpay((m, p, b) => {
      if (mode === '500' && m === 'POST') return [500, { error: { code: 'SERVER_ERROR', description: 'internal error' } }]
      if (mode === 'network') throw networkError()
      return desk.handle(m, p, b)
    }, { delayMs: 50 })
    try {
      assert.equal((await api.post(`/v1/orders/${o.orderId}/cancel`, {}, { token: o.cust.accessToken })).status, 204)
      assert.equal((await order(o.orderId)).refund_id, null)
      mode = 'network'
      at(3 * MIN) // past the lease
      assert.equal(await processDueRefunds(), 0)
      assert.equal((await order(o.orderId)).refund_id, null)
      mode = 'ok'
      at(6 * MIN)
      // Two instances retry at once (maintenance on one, a webhook's refund on another).
      await Promise.all([processDueRefunds(), processDueRefunds(), processDueRefunds()])
      const row = await order(o.orderId)
      assert.deepEqual([row.status, row.payment_status, row.refund_id], ['CANCELLED', 'REFUNDED', 'rfnd_1'])
      assert.equal(desk.refunds.length, 1)
      assert.equal(desk.refunds[0].amount, o.total)
      at(10 * MIN)
      assert.equal(await processDueRefunds(), 0)
      assert.equal(desk.refunds.length, 1)
      await assertDatabaseValid({ gateway: { captured: ['pay_R2'], refunds: desk.refunds } })
    } finally {
      gw.restore()
    }
  })

  test('a second-payment refund that times out at Razorpay is not sent twice', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const o = await placed(await customerToken(api))
    const desk = refundDesk()
    let firstPost = true
    const gw = stubRazorpay((m, p, b) => {
      const out = desk.handle(m, p, b)
      if (m === 'POST' && firstPost) {
        firstPost = false
        throw timeoutError()
      }
      return out
    })
    try {
      assert.equal((await hook(captured(o, 'pay_D1'))).body.result, 'confirmed')
      assert.equal((await hook(captured(o, 'pay_D2'))).body.result, 'duplicate_payment')
      await drainBackground()
      assert.equal((await query(`SELECT refunded_at FROM duplicate_payments WHERE payment_id = 'pay_D2'`)).rows[0].refunded_at, null)
      at(3 * MIN)
      await Promise.all([refundDuplicatePayments(), refundDuplicatePayments()])
      assert.equal((await query(`SELECT refund_id FROM duplicate_payments WHERE payment_id = 'pay_D2'`)).rows[0].refund_id, 'rfnd_1')
      assert.equal(gw.posts().length, 1)
      await assertDatabaseValid({ gateway: { captured: ['pay_D1', 'pay_D2'], refunds: desk.refunds } })
    } finally {
      gw.restore()
    }
  })
})

describe('5. the database is unavailable: a controlled 503, never a false success', () => {
  // Guards: app.js error handler (isDbUnavailable → 503 UNAVAILABLE + Retry-After); db.js tx (one
  // transaction per change, rolled back on error); the confirm route claims its idempotency key in
  // the order's own transaction; payments.js handleWebhook writes its dedupe row in the same
  // transaction and the route answers non-2xx on any error, so Razorpay retries.
  async function readyToConfirm(cust) {
    await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 1 }, { token: cust.accessToken })
    const q = await api.post('/v1/checkout/quote', { pincode: '560034' }, { token: cust.accessToken })
    assert.equal(q.status, 200, JSON.stringify(q.body))
    return (key) =>
      api.post('/v1/checkout/confirm', { quoteId: q.body.quoteId, address: '12, 4th Cross, Koramangala, Bengaluru' }, { token: cust.accessToken, headers: { 'Idempotency-Key': key } })
  }

  test('connections refused: checkout and the webhook answer 503/non-2xx, nothing is written, retries work after', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const cust = await customerToken(api)
    const confirm = await readyToConfirm(cust)
    const pending = await placed(await customerToken(api))
    const out = dbOutage('down')
    let c1
    let w1
    try {
      c1 = await confirm('outage-1')
      w1 = await hook(captured(pending, 'pay_O1'), 'evt_outage_1')
    } finally {
      out.restore()
    }
    assert.deepEqual([c1.status, c1.body.error.code, c1.headers.get('retry-after')], [503, 'UNAVAILABLE', '5'])
    assert.ok(!ok(w1) && w1.status >= 500, `webhook answered ${w1.status}`)
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM orders WHERE customer_id = $1', [cust.customer.id])).rows[0].n, 0)
    assert.equal((await order(pending.orderId)).status, 'PAYMENT_PENDING')
    assert.equal((await line(b, 'ALP-3')).held, 1)

    // Back up: the shop's retry with the same key places the order; Razorpay's retry confirms the other.
    const c2 = await confirm('outage-1')
    assert.equal(c2.status, 201, JSON.stringify(c2.body))
    const w2 = await hook(captured(pending, 'pay_O1'), 'evt_outage_1')
    assert.equal(w2.body.result, 'confirmed')
    await assertDatabaseValid({ sweep: false, gateway: { captured: ['pay_O1'] } })
  })

  test('the connection drops at COMMIT: no 201 without the order, no 200 without the payment, retries are clean', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const cust = await customerToken(api)
    const confirm = await readyToConfirm(cust)
    const pending = await placed(await customerToken(api))
    const out = dbOutage('commit')
    let c1
    let w1
    try {
      c1 = await confirm('drop-1')
      w1 = await hook(captured(pending, 'pay_C1'), 'evt_drop_1')
    } finally {
      out.restore()
    }
    assert.equal(out.killed.commits, 2, 'both transactions reached COMMIT')
    assert.deepEqual([c1.status, c1.body.error.code], [503, 'UNAVAILABLE'])
    assert.ok(!ok(w1), `webhook answered ${w1.status}: Razorpay would not retry`)
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM orders WHERE customer_id = $1', [cust.customer.id])).rows[0].n, 0)
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM idempotency_keys WHERE key LIKE $1', [`${cust.customer.id}:%`])).rows[0].n, 0)
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM processed_webhooks WHERE dedupe_key = 'evt_drop_1'`)).rows[0].n, 0)
    assert.deepEqual([(await order(pending.orderId)).status, (await line(b, 'ALP-3')).held], ['PAYMENT_PENDING', 1])

    const c2 = await confirm('drop-1')
    assert.equal(c2.status, 201, JSON.stringify(c2.body))
    assert.equal((await confirm('drop-1')).body.orderId, c2.body.orderId)
    assert.equal((await hook(captured(pending, 'pay_C1'), 'evt_drop_1')).body.result, 'confirmed')
    assert.equal((await hook(captured(pending, 'pay_C1'), 'evt_drop_1')).body.duplicate, true)
    await assertDatabaseValid({ sweep: false, gateway: { captured: ['pay_C1'] } })
  })

  test('the COMMIT lands but its reply is lost: a 503, and both retries find the work already done', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const cust = await customerToken(api)
    const confirm = await readyToConfirm(cust)
    const pending = await placed(await customerToken(api))
    const out = dbOutage('ack')
    let c1
    let w1
    try {
      c1 = await confirm('ack-1')
      w1 = await hook(captured(pending, 'pay_A1'), 'evt_ack_1')
    } finally {
      out.restore()
    }
    assert.equal(out.killed.commits, 2)
    // A false failure, never a false success: the shop and Razorpay both retry.
    assert.deepEqual([c1.status, c1.body.error.code], [503, 'UNAVAILABLE'])
    assert.ok(!ok(w1), `webhook answered ${w1.status}`)
    const [placedOrder] = (await query('SELECT * FROM orders WHERE customer_id = $1', [cust.customer.id])).rows
    assert.deepEqual([placedOrder.status, placedOrder.razorpay_order_id], ['PAYMENT_PENDING', null]) // committed; the payment never started

    // The shop's retry with the same key finds the order (PAY-B4: it starts the payment after 15 s), never a second one.
    const soon = await confirm('ack-1')
    assert.deepEqual([soon.status, soon.body.error?.code], [409, 'PAYMENT_STARTING'])
    setNow(new Date(placedOrder.placed_at.getTime() + 16_000).toISOString())
    const retry = await confirm('ack-1')
    assert.equal(retry.status, 200, JSON.stringify(retry.body))
    assert.equal(retry.body.orderId, placedOrder.id)
    assert.ok(retry.body.razorpayOrderId)
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM orders WHERE customer_id = $1', [cust.customer.id])).rows[0].n, 1)
    // Razorpay's retry is recognised as already applied.
    assert.equal((await hook(captured(pending, 'pay_A1'), 'evt_ack_1')).body.duplicate, true)
    assert.deepEqual([(await order(pending.orderId)).status, (await order(pending.orderId)).payment_id], ['CONFIRMED', 'pay_A1'])
    await assertDatabaseValid({ sweep: false, gateway: { captured: ['pay_A1'] } })
  })
})

describe('6. a batch fails QC or is condemned after orders were placed: rebalanced or at risk, never cancelled', () => {
  // Guards: orders.js takeBatchOutOfService and rebalanceBatchOrders → rebalanceOrder (swap FEFO to
  // another batch, else setRisk; "Never cancels"); inventory.js sellableAs (condition REJECT and
  // CONDEMNED are unsellable); orders.js allocateOrder refuses to pack an at-risk order.
  test('condemned: every paid and unpaid order on it moves to another batch, none cancelled or refunded', async () => {
    const a = await makeBatch({ age: 6, rating: 'SEMI_RIPE', lines: { 'ALP-3': 8 } }) // older: taken first (FEFO)
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 8 } })
    const paid = [await paidOrder(), await paidOrder(), await paidOrder()]
    const unpaid = await placed(await customerToken(api))
    const ids = [...paid.map((o) => o.orderId), unpaid.orderId]
    assert.equal((await line(a, 'ALP-3')).committed, 3)
    const r = await api.patch(`/admin/v1/batches/${a}/status`, { status: 'CONDEMNED', reason: 'rot found at intake' }, { token: manager })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.rebalancedOrders.length, 4)
    assert.deepEqual(r.body.atRiskOrders, [])
    for (const id of ids) {
      const o = await order(id)
      assert.ok(['CONFIRMED', 'PAYMENT_PENDING'].includes(o.status), o.status)
      assert.deepEqual([o.at_risk, o.refund_requested_at], [false, null])
      const stock = (await query(`SELECT batch_id FROM order_stock WHERE order_id = $1 AND state IN ('held', 'committed')`, [id])).rows
      assert.deepEqual(stock.map((s) => s.batch_id), [b])
    }
    const la = await line(a, 'ALP-3')
    assert.deepEqual([la.on_hand, la.held, la.committed], [0, 0, 0])
    const lb = await line(b, 'ALP-3')
    assert.deepEqual([lb.held, lb.committed], [1, 3])
    await assertDatabaseValid({ sweep: false })
  })

  test('QC rejects a batch and too little else is left: the rest are at risk for staff, never cancelled, filled later', async () => {
    const a = await makeBatch({ age: 6, rating: 'SEMI_RIPE', lines: { 'ALP-3': 4 } })
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 1 } })
    const orders = [await paidOrder(), await paidOrder(), await paidOrder()]
    const qc = await api.post(`/admin/v1/batches/${a}/qc`, { ripenessRating: 'RIPE', condition: 'REJECT', notes: 'bruised' }, { token: manager })
    assert.equal(qc.status, 201, JSON.stringify(qc.body))
    assert.equal(qc.body.rebalancedOrders.length, 1)
    assert.equal(qc.body.atRiskOrders.length, 2)
    const summary = (await api.get('/admin/v1/summary', { token: manager })).body
    assert.equal(summary.atRiskOrders.length, 2)
    for (const o of orders) {
      const row = await order(o.orderId)
      assert.deepEqual([row.status, row.payment_status, row.refund_requested_at], ['CONFIRMED', 'SUCCEEDED', null])
    }
    // An at-risk order can't be packed from the rejected fruit.
    const risky = summary.atRiskOrders[0].id
    await setStatus(risky, { status: 'PROCESSING' })
    const pack = await api.post(`/admin/v1/orders/${risky}/allocate`, undefined, { token: manager })
    assert.deepEqual([pack.status, pack.body.error.code], [409, 'AT_RISK'])
    await assertDatabaseValid({ sweep: false })

    // New stock: the maintenance re-check fills them.
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    await rebalanceAllOpen({ atRiskOnly: true })
    assert.equal((await api.get('/admin/v1/summary', { token: manager })).body.atRiskOrders.length, 0)
    await assertDatabaseValid({ sweep: false })
  })
})

describe('7. delivery fails repeatedly: attempts are bounded and the order needs attention', () => {
  // Guards: orders.js MAX_DELIVERY_ATTEMPTS (3) in setOrderStatus and checkDispatchable
  // (ATTEMPTS_USED_UP); delivery-proof.js recordDelivery's attempt check (STALE_ATTEMPT) under the
  // order lock; admin/reports.js Needs attention failedDeliveries.
  test('two riders report the same miss at once; after 3 misses a 4th dispatch is refused and staff see it', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const o = await allocatedOrder()
    assert.equal((await setStatus(o.orderId, { status: 'PACKED' })).status, 204)
    const report = (attempt) => api.post(`/admin/v1/orders/${o.orderId}/delivery`, { outcome: 'FAILED', reason: 'NOT_HOME', attempt }, { token: manager })
    for (let i = 1; i <= 3; i++) {
      if (i > 1) at((i - 1) * DAY) // each retry goes out on a later day (OPS-01)
      assert.equal((await api.post(`/admin/v1/orders/${o.orderId}/dispatch`, {}, { token: ops })).status, 204)
      const both = await Promise.all([report(i), report(i)])
      assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], JSON.stringify(both.map((r) => r.body)))
      assert.equal((await order(o.orderId)).delivery_failures, i)
    }
    at(3 * DAY)
    const fourth = await api.post(`/admin/v1/orders/${o.orderId}/dispatch`, {}, { token: ops })
    assert.equal(fourth.status, 409, 'a 4th delivery attempt went out')
    assert.equal(fourth.body.error.code, 'ATTEMPTS_USED_UP')
    assert.equal((await setStatus(o.orderId, { status: 'OUT_FOR_DELIVERY' }, ops)).body.error.code, 'ATTEMPTS_USED_UP')
    const row = await order(o.orderId)
    assert.deepEqual([row.status, row.delivery_failures, row.payment_status, row.refund_requested_at], ['DELIVERY_FAILED', 3, 'SUCCEEDED', null])
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM delivery_attempts WHERE order_id = $1 AND outcome = 'FAILED'`, [o.orderId])).rows[0].n, 3)
    const att = (await api.get('/admin/v1/attention', { token: manager })).body
    assert.deepEqual(att.failedDeliveries.map((d) => [d.id, d.attempts]), [[o.orderId, 3]])
    await assertDatabaseValid()
  })
})

describe('8. two staff change the same order at once: one wins, the rest are refused', () => {
  // Guards: orders.js lockOrder (SELECT … FOR UPDATE) in setOrderStatus, customerCancel and
  // cancelOrder; the transition checks (TRANSITIONS → 409 "just updated by someone else",
  // CUSTOMER_CANCELLABLE → NOT_CANCELLABLE) and assertTransition before every status write.
  test('five status changes at once on one order (5 orders): exactly one goes through each time, one event', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    for (let round = 0; round < 5; round++) {
      const o = await paidOrder()
      const results = await Promise.all([
        setStatus(o.orderId, { status: 'PROCESSING' }),
        setStatus(o.orderId, { status: 'PROCESSING' }, ops),
        setStatus(o.orderId, { status: 'PROCESSING' }, ops),
        setStatus(o.orderId, { status: 'PACKED' }),
        setStatus(o.orderId, { status: 'SHIPPED' }, ops),
      ])
      assert.equal(results.filter(ok).length, 1, `round ${round}: ${JSON.stringify(results.map((r) => [r.status, r.body?.error?.code]))}`)
      assert.ok(results.filter((r) => !ok(r)).every((r) => r.status === 409 || r.status === 400))
      assert.equal((await order(o.orderId)).status, 'PROCESSING')
      assert.equal((await query(`SELECT COUNT(*)::int AS n FROM order_events WHERE order_id = $1 AND status = 'PROCESSING'`, [o.orderId])).rows[0].n, 1)
    }
    await assertDatabaseValid()
  })

  test('the customer cancels while staff mark it packed: exactly one wins, stock and refund follow the winner', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    for (let round = 0; round < 4; round++) {
      const o = await allocatedOrder()
      // Which request reaches the order lock first alternates, so both outcomes are exercised.
      const sendCancel = () => api.post(`/v1/orders/${o.orderId}/cancel`, {}, { token: o.cust.accessToken })
      const sendPack = () => setStatus(o.orderId, { status: 'PACKED' }, ops)
      const [cancel, pack] = round % 2
        ? await Promise.all([sendCancel(), sendPack()])
        : (await Promise.all([sendPack(), sendCancel()])).reverse()
      assert.equal([cancel, pack].filter(ok).length, 1, `round ${round}: ${cancel.status} ${pack.status}`)
      const row = await order(o.orderId)
      const stock = (await query(`SELECT state, SUM(quantity)::int AS n FROM order_stock WHERE order_id = $1 GROUP BY state ORDER BY state`, [o.orderId])).rows
      if (ok(cancel)) {
        assert.deepEqual([pack.status, row.status, row.payment_status], [400, 'CANCELLED', 'REFUNDED'], JSON.stringify(pack.body))
        assert.deepEqual(stock.map((s) => [s.state, s.n]), [['released', 1]])
      } else {
        assert.deepEqual([cancel.status, cancel.body.error.code, row.status, row.refund_requested_at], [409, 'NOT_CANCELLABLE', 'PACKED', null])
        assert.deepEqual(stock.map((s) => [s.state, s.n]), [['packed', 1]])
      }
    }
    await assertDatabaseValid()
  })
})

setNow(T0)
