// Regression tests for the stock and order audit fixes (INV-1..7, ORD-2..4).
import { closeAll, T0, adminToken, checkout, client, customerToken, line, makeBatch, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { setNow } from '../src/clock.js'
import { pool, query, tx } from '../src/db.js'
import { allocate, auditLedger } from '../src/inventory.js'
import { newId } from '../src/ids.js'
import { sweepExpiredHolds, SYSTEM } from '../src/orders.js'

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
  admin = await adminToken(api)
  ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
})

const pay = (orderId, outcome = 'captured') => api.post('/v1/dev/pay', { orderId, outcome })
const order = async (id) => (await api.get(`/admin/v1/orders/${id}`, { token: admin })).body
const allocateOrder = (id) => api.post(`/admin/v1/orders/${id}/allocate`, undefined, { token: admin })
const setStatus = (id, body, token = admin) => api.patch(`/admin/v1/orders/${id}/status`, body, { token })
const stockOf = async (id) =>
  (await query(`SELECT state, SUM(quantity)::int AS n FROM order_stock WHERE order_id = $1 AND state <> 'released' GROUP BY state ORDER BY state`, [id])).rows
const noDrift = async () => assert.deepEqual(await tx((c) => auditLedger(c)), [])

/** A paid order on 10-16, as a customer. */
async function paidOrder(qty = 2, cust = null) {
  cust ??= await customerToken(api)
  const o = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty }])
  assert.equal(o.status, 201, JSON.stringify(o.body))
  assert.equal((await pay(o.body.orderId)).status, 200)
  return { id: o.body.orderId, cust }
}

describe('INV-1: packed stock on a CONFIRMED order', () => {
  test('allocate → customer reschedule → allocate takes one box per box ordered', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } }) // ripe on 10-16 and 10-17
    const { id, cust } = await paidOrder(2)
    assert.equal((await allocateOrder(id)).status, 204)
    assert.equal((await line(b, 'ALP-3')).on_hand, 8)

    const moved = await api.post(`/v1/orders/${id}/reschedule`, { deliveryDate: '2026-10-17' }, { token: cust.accessToken })
    assert.equal(moved.status, 204, JSON.stringify(moved.body))
    // The packed boxes went back on the shelf and the order is committed for the new date.
    assert.equal((await line(b, 'ALP-3')).on_hand, 10)
    assert.deepEqual(await stockOf(id), [{ state: 'committed', n: 2 }])
    assert.match((await order(id)).events.at(-1).reason ?? '', /pack it again/)

    assert.equal((await allocateOrder(id)).status, 204)
    assert.equal((await line(b, 'ALP-3')).on_hand, 8)
    assert.deepEqual(await stockOf(id), [{ state: 'packed', n: 2 }])
    // A second allocate has nothing to do.
    assert.equal((await allocateOrder(id)).status, 409)
    assert.equal((await line(b, 'ALP-3')).on_hand, 8)
    await noDrift()
  })

  test('admin and bulk reschedules unpack too; a same-day slot move keeps the packed boxes', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const { id } = await paidOrder(2)
    await setStatus(id, { status: 'PROCESSING' })
    assert.equal((await allocateOrder(id)).status, 204)

    // Same date: nothing is taken twice.
    assert.equal((await api.post(`/admin/v1/orders/${id}/reschedule`, { deliveryDate: '2026-10-16' }, { token: admin })).status, 204)
    assert.equal((await line(b, 'ALP-3')).on_hand, 8)
    assert.deepEqual(await stockOf(id), [{ state: 'packed', n: 2 }])

    assert.equal((await api.post(`/admin/v1/orders/${id}/reschedule`, { deliveryDate: '2026-10-17' }, { token: admin })).status, 204)
    assert.equal((await allocateOrder(id)).status, 204)
    assert.equal((await line(b, 'ALP-3')).on_hand, 8)

    const bulk = await api.post('/admin/v1/orders/bulk-reschedule', { fromDate: '2026-10-17', toDate: '2026-10-16', reason: 'Rain' }, { token: admin })
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body))
    assert.equal(bulk.body.moved.length, 1)
    assert.equal((await allocateOrder(id)).status, 204)
    assert.equal((await line(b, 'ALP-3')).on_hand, 8)
    assert.deepEqual(await stockOf(id), [{ state: 'packed', n: 2 }])
    await noDrift()
  })

  test('cancelling a CONFIRMED order that was already packed puts the boxes back', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const { id, cust } = await paidOrder(2)
    assert.equal((await allocateOrder(id)).status, 204)
    assert.equal((await line(b, 'ALP-3')).on_hand, 8)
    const r = await api.post(`/v1/orders/${id}/cancel`, {}, { token: cust.accessToken })
    assert.ok(r.status < 300, JSON.stringify(r.body))
    assert.equal((await line(b, 'ALP-3')).on_hand, 10)
    assert.deepEqual(await stockOf(id), [])
    await noDrift()
  })
})

describe('INV-2: hold sweeper', () => {
  test('one order that fails to cancel does not block the others', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const ids = []
    for (let i = 0; i < 3; i++) {
      const cust = await customerToken(api)
      const o = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
      ids.push(o.body.orderId)
    }
    // Poison the first (oldest) order: its line no longer counts its hold, so releasing it breaks held >= 0.
    const other = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 1 } })
    const otherLine = (await line(other, 'ALP-3')).id
    await query(`UPDATE order_stock SET line_id = $2, batch_id = $3 WHERE order_id = $1`, [ids[0], otherLine, other])
    await query('UPDATE batch_lines SET held = held - 1 WHERE id = $1', [(await line(b, 'ALP-3')).id])

    const at = new Date(Date.parse(T0) + 11 * 60_000)
    const n = await tx((c) => sweepExpiredHolds(c, at))
    assert.equal(n, 2)
    const { rows } = await query('SELECT id, status, at_risk, at_risk_reason FROM orders WHERE id = ANY($1) ORDER BY placed_at', [ids])
    assert.equal(rows[0].status, 'PAYMENT_PENDING')
    assert.equal(rows[0].at_risk, true)
    assert.match(rows[0].at_risk_reason, /could not be cancelled/)
    assert.deepEqual(rows.slice(1).map((r) => r.status), ['CANCELLED', 'CANCELLED'])
  })
})

describe('INV-3: short arrival', () => {
  test('the youngest order gives boxes back and moves to the next date with stock', async () => {
    const x = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 4 } }) // ripe on 10-16 and 10-17
    await makeBatch({ age: 4, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } }) // ripe from 10-17
    const a = await paidOrder(2)
    const b = await paidOrder(2)
    const l = await line(x, 'ALP-3')
    assert.equal(l.committed, 4)

    // The plain adjustment still refuses, and says what to do instead.
    const adj = await api.patch(`/admin/v1/batches/${x}/lines/${l.id}`, { onHand: 3, reason: 'count' }, { token: admin })
    assert.equal(adj.body.error.code, 'BELOW_COMMITTED')
    assert.equal(adj.body.error.promised, 4)

    const r = await api.post(`/admin/v1/batches/${x}/lines/${l.id}/short-arrival`, { onHand: 3, reason: 'One box short off the truck' }, { token: ops })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body, { refilled: [], moved: [{ number: (await order(b.id)).number, deliveryDate: '2026-10-17' }], atRisk: [] })
    assert.equal((await line(x, 'ALP-3')).on_hand, 3)
    const ob = await order(b.id)
    assert.equal(ob.deliveryDate, '2026-10-17')
    assert.equal(ob.atRisk, false)
    assert.ok(ob.notifications.some((n) => n.kind === 'DATE_MOVED'))
    const oa = await order(a.id)
    assert.equal(oa.deliveryDate, '2026-10-16')
    assert.deepEqual(await stockOf(a.id), [{ state: 'committed', n: 2 }])
    const led = (await api.get(`/admin/v1/batches/${x}/ledger`, { token: admin })).body.find((e) => e.eventType === 'ADJUST')
    assert.deepEqual([led.delta, led.reason], [-1, 'Short arrival: One box short off the truck'])
    await noDrift()
  })

  test('with nowhere to go the order is flagged at-risk; the buffer goes first', async () => {
    const x = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 6 } })
    const l = await line(x, 'ALP-3')
    assert.equal((await api.patch(`/admin/v1/batches/${x}/lines/${l.id}`, { reserveBuffer: 2, reason: 'spare' }, { token: admin })).status, 204)
    const a = await paidOrder(2)
    const b = await paidOrder(2)
    // 6 on hand, 4 promised, 2 buffer. Down to 4: only the buffer goes.
    let r = await api.post(`/admin/v1/batches/${x}/lines/${l.id}/short-arrival`, { onHand: 4, reason: 'short' }, { token: admin })
    assert.deepEqual(r.body, { refilled: [], moved: [], atRisk: [] })
    assert.deepEqual([(await line(x, 'ALP-3')).reserve_buffer, (await line(x, 'ALP-3')).committed], [0, 4])
    r = await api.post(`/admin/v1/batches/${x}/lines/${l.id}/short-arrival`, { onHand: 1, reason: 'short' }, { token: admin })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const [na, nb] = [(await order(a.id)).number, (await order(b.id)).number]
    assert.deepEqual(r.body.atRisk.sort(), [na, nb].sort())
    assert.equal((await order(b.id)).atRisk, true)
    assert.deepEqual(await stockOf(b.id), [])
    assert.deepEqual(await stockOf(a.id), [{ state: 'committed', n: 1 }])
    // Raising the count is not a short arrival.
    r = await api.post(`/admin/v1/batches/${x}/lines/${l.id}/short-arrival`, { onHand: 5, reason: 'x' }, { token: admin })
    assert.equal(r.body.error.code, 'NOT_SHORT')
    await noDrift()
  })
})

describe('INV-5: a late payment respects the day capacity', () => {
  test('the day filled while the order was cancelled: it moves to the next date', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    assert.equal((await api.put('/admin/v1/calendar/2026-10-16', { isOpen: true, maxBoxes: 3 }, { token: admin })).status, 204)
    const cust = await customerToken(api)
    const late = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])
    assert.equal(late.status, 201, JSON.stringify(late.body))
    await tx((c) => sweepExpiredHolds(c, new Date(Date.parse(T0) + 11 * 60_000)))
    await paidOrder(2) // takes the day's room while the first is cancelled
    assert.equal((await pay(late.body.orderId)).body.result, 'confirmed_late')
    const o = await order(late.body.orderId)
    assert.equal(o.deliveryDate, '2026-10-17')
    assert.equal(o.atRisk, false)
    const { rows } = await query(
      `SELECT COALESCE(SUM(i.quantity), 0)::int AS n FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.delivery_date = '2026-10-16' AND o.status <> 'CANCELLED'`,
    )
    assert.ok(rows[0].n <= 3)
    await noDrift()
  })
})

describe('INV-6: allocation racing a condemn', () => {
  test('an allocation that read the batch before a condemn committed does not keep its stock', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const l = await line(b, 'ALP-3')
    const condemn = await pool.connect()
    try {
      await condemn.query('BEGIN')
      await condemn.query(`SELECT id FROM batch_lines WHERE batch_id = $1 FOR UPDATE`, [b])
      await condemn.query(`UPDATE batches SET status = 'CONDEMNED' WHERE id = $1`, [b])
      // The allocation reads the batch as SELLING, then waits on the line lock.
      const got = tx(async (c) => {
        const { rows } = await c.query(`INSERT INTO orders (id, number, status, delivery_date, placed_at, subtotal, total) VALUES ($1, 'ORD-T1', 'CONFIRMED', '2026-10-16', NOW(), 0, 0) RETURNING id`, [newId('ord')])
        return allocate(c, { orderId: rows[0].id, orderNumber: 'ORD-T1', deliveryDate: '2026-10-16', sku: 'ALP-3', stage: 'RIPE', qty: 2, state: 'committed', actor: SYSTEM })
      })
      for (let i = 0; i < 100; i++) {
        const { rows } = await query(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)
        if (rows.length) break
        await new Promise((r) => setTimeout(r, 20))
      }
      await condemn.query('COMMIT')
      assert.equal(await got, 0)
    } finally {
      condemn.release()
    }
    const after = await line(b, 'ALP-3')
    assert.equal(after.committed, 0)
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM order_stock WHERE line_id = $1', [l.id])).rows[0].n, 0)
  })
})

describe('INV-7: ledger integrity', () => {
  test('the ledger is append-only, event types are checked, and stock rows match their line', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5, 'ALP-5': 5 } })
    await assert.rejects(query('UPDATE batch_ledger SET delta = 99'), /append-only/)
    await assert.rejects(query('DELETE FROM batch_ledger'), /append-only/)
    await assert.rejects(query('TRUNCATE batch_ledger'), /append-only|cannot truncate/)
    await assert.rejects(
      query(`INSERT INTO batch_ledger (id, batch_id, event_type, sku, delta, actor_id) VALUES ('led_x', $1, 'GIFT', 'ALP-3', 1, 't')`, [b]),
      /batch_ledger_event_type_check/,
    )
    const { id } = await paidOrder(1)
    const l5 = await line(b, 'ALP-5')
    await assert.rejects(
      query(`INSERT INTO order_stock (id, order_id, batch_id, line_id, sku, stage, quantity, state) VALUES ('ost_x', $1, $2, $3, 'ALP-3', 'RIPE', 1, 'released')`, [id, b, l5.id]),
      /order_stock_line_matches/,
    )
  })

  test('ledger drift shows on Needs attention', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    let r = await api.get('/admin/v1/attention', { token: admin })
    assert.deepEqual(r.body.ledgerDrift, [])
    await query('UPDATE batch_lines SET on_hand = 4 WHERE batch_id = $1', [b])
    r = await api.get('/admin/v1/attention', { token: admin })
    assert.equal(r.body.ledgerDrift.length, 1)
    assert.deepEqual(r.body.ledgerDrift[0].onHand, [4, 5])
  })
})

/** A paid order, packed; returns its id and date. */
async function packed(qty = 1) {
  const { id } = await paidOrder(qty)
  await setStatus(id, { status: 'PROCESSING' })
  assert.equal((await allocateOrder(id)).status, 204)
  assert.equal((await setStatus(id, { status: 'PACKED' })).status, 204)
  return id
}

describe('ORD-2: condemned packed stock does not go out', () => {
  test('dispatch is refused unless a manager overrides with a reason', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const id = await packed()
    assert.equal((await api.patch(`/admin/v1/batches/${b}/status`, { status: 'CONDEMNED' }, { token: admin })).status, 200)

    const run = await api.post('/admin/v1/manifest/dispatch', { date: '2026-10-16' }, { token: ops })
    assert.deepEqual(run.body.dispatched, [])
    assert.match(run.body.skipped[0].reason, /condemned/)
    const one = await api.post(`/admin/v1/orders/${id}/dispatch`, {}, { token: ops })
    assert.equal(one.status, 409)
    assert.equal(one.body.error.code, 'AT_RISK')
    assert.equal((await setStatus(id, { status: 'SHIPPED' }, ops)).body.error.code, 'AT_RISK')
    assert.equal((await api.post(`/admin/v1/orders/${id}/dispatch`, { override: true, reason: 'x' }, { token: ops })).status, 403)
    assert.equal((await api.post(`/admin/v1/orders/${id}/dispatch`, { override: true }, { token: admin })).body.error.code, 'REASON_REQUIRED')
    const ok = await api.post(`/admin/v1/orders/${id}/dispatch`, { override: true, reason: 'Boxes checked by hand; fruit is fine' }, { token: admin })
    assert.equal(ok.status, 204, JSON.stringify(ok.body))
    assert.equal((await order(id)).status, 'OUT_FOR_DELIVERY')
  })
})

describe('ORD-4: retries', () => {
  async function outForDelivery() {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const id = await packed()
    assert.equal((await api.post(`/admin/v1/orders/${id}/dispatch`, {}, { token: admin })).status, 204)
    return id
  }
  const currentAttempt = async (id) => (await api.get(`/admin/v1/orders/${id}`, { token: admin })).body.attempt
  const fail = async (id, extra = {}) =>
    api.post(`/admin/v1/orders/${id}/delivery`, { outcome: 'FAILED', reason: 'NOT_HOME', attempt: await currentAttempt(id), ...extra }, { token: admin })
  // A missed order goes out again on a later day, not the same one (OPS-01).
  const nextDay = (i) => setNow(new Date(Date.parse(T0) + i * 86_400_000).toISOString())

  test('a missed delivery retries on the next day with room', async () => {
    const id = await outForDelivery()
    await api.put('/admin/v1/calendar/2026-10-16', { isOpen: true, maxBoxes: 0 }, { token: admin })
    assert.equal((await fail(id)).status, 200)
    assert.equal((await order(id)).deliveryDate, '2026-10-17')
  })

  test('a late resend of a FAILED report for an earlier attempt is refused', async () => {
    const id = await outForDelivery()
    const manifest = await api.get('/admin/v1/manifest?date=2026-10-16', { token: admin })
    assert.equal(manifest.body.runs[0].stops[0].orders[0].attempt, 1)
    assert.equal((await fail(id, { attempt: 1 })).status, 200)
    nextDay(1)
    assert.equal((await api.post(`/admin/v1/orders/${id}/dispatch`, {}, { token: admin })).status, 204)
    const resent = await fail(id, { attempt: 1 })
    assert.equal(resent.status, 409)
    assert.equal(resent.body.error.code, 'STALE_ATTEMPT')
    assert.equal((await order(id)).status, 'OUT_FOR_DELIVERY')
    assert.equal((await fail(id, { attempt: 2 })).status, 200)
  })

  test('after the last attempt, only a manager sends it out again', async () => {
    const id = await outForDelivery()
    for (let i = 0; i < 3; i++) {
      if (i) {
        nextDay(i)
        assert.equal((await api.post(`/admin/v1/orders/${id}/dispatch`, {}, { token: admin })).status, 204)
      }
      assert.equal((await fail(id)).status, 200)
    }
    nextDay(3)
    const again = await api.post(`/admin/v1/orders/${id}/dispatch`, {}, { token: ops })
    assert.equal(again.status, 409)
    assert.equal(again.body.error.code, 'ATTEMPTS_USED_UP')
    assert.equal((await setStatus(id, { status: 'OUT_FOR_DELIVERY' }, ops)).body.error.code, 'ATTEMPTS_USED_UP')
    assert.equal((await setStatus(id, { status: 'OUT_FOR_DELIVERY', override: true, reason: 'Called; customer home tomorrow' })).status, 204)
  })
})

describe('INV-4: writing off a batch', () => {
  test('a QC user cannot exhaust a batch with boxes left', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const qc = await adminToken(api, 'qc@mandimangoes.test', 'qc123')
    assert.equal((await api.patch(`/admin/v1/batches/${b}/status`, { status: 'EXHAUSTED', reason: 'gone' }, { token: qc })).status, 403)
    assert.equal((await line(b, 'ALP-3')).on_hand, 5)
  })
})

setNow(T0)
