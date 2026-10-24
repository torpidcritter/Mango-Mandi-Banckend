// Regression tests for the 23 Oct inventory and orders audit (INV-A to INV-I).
import { closeAll, T0, adminToken, checkout, client, customerToken, line, makeBatch, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { setNow } from '../src/clock.js'
import { currentConfig, saveConfig } from '../src/config.js'
import { query, tx } from '../src/db.js'
import { slotUsage } from '../src/delivery.js'
import { newId } from '../src/ids.js'
import { auditLedger } from '../src/inventory.js'
import { checkHealth } from '../src/maintenance.js'
import { CONFIRMATION_HELD, ORDER_TRANSITIONS, STAFF_TRANSITIONS } from '../src/orders.js'

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

const later = (ms) => setNow(new Date(Date.parse(T0) + ms).toISOString())
const pay = (orderId, outcome = 'captured') => api.post('/v1/dev/pay', { orderId, outcome })
const order = async (id) => (await api.get(`/admin/v1/orders/${id}`, { token: admin })).body
const setStatus = (id, body, token = admin) => api.patch(`/admin/v1/orders/${id}/status`, body, { token })
const noDrift = async () => assert.deepEqual(await tx((c) => auditLedger(c)), [])
const lineId = async (batchId) => (await query('SELECT id FROM batch_lines WHERE batch_id = $1', [batchId])).rows[0].id

async function paidOrder(qty = 1, { deliveryDate } = {}) {
  const cust = await customerToken(api)
  const o = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty }], { deliveryDate })
  assert.equal(o.status, 201, JSON.stringify(o.body))
  assert.equal((await pay(o.body.orderId)).status, 200)
  return { id: o.body.orderId, cust }
}

async function packedOrder(qty = 1) {
  const { id, cust } = await paidOrder(qty)
  await setStatus(id, { status: 'PROCESSING' })
  assert.equal((await api.post(`/admin/v1/orders/${id}/allocate`, undefined, { token: admin })).status, 204)
  assert.equal((await setStatus(id, { status: 'PACKED' })).status, 204)
  return { id, cust }
}

const dispatch = async (id) => assert.equal((await api.post(`/admin/v1/orders/${id}/dispatch`, {}, { token: admin })).status, 204)
const attempt = async (id) => (await order(id)).attempt
const fail = async (id) => api.post(`/admin/v1/orders/${id}/delivery`, { outcome: 'FAILED', reason: 'NOT_HOME', attempt: await attempt(id) }, { token: admin })

describe('INV-A: an expired unpaid hold no longer keeps a day or slot full', () => {
  test('cap 2, A holds 2, the hold runs out: B books the day without waiting for the sweep', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } }) // ripe on 10-16 and 10-17
    await api.put('/admin/v1/calendar/2026-10-16', { isOpen: true, maxBoxes: 2 }, { token: admin })
    const a = await customerToken(api)
    const held = await checkout(api, a.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }], { deliveryDate: '2026-10-16' })
    assert.equal(held.status, 201)

    const b = await customerToken(api)
    const early = await checkout(api, b.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }], { deliveryDate: '2026-10-16' })
    assert.equal(early.status, 409, 'a live hold still counts')
    assert.equal(early.body.error.code, 'DATE_FULL')

    later(11 * 60_000) // A's 10-minute hold has run out; no sweep has run
    const c = await customerToken(api)
    const r = await checkout(api, c.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }], { deliveryDate: '2026-10-16' })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal((await pay(r.body.orderId)).status, 200)

    // A pays late: the day is full now, so A moves to the next day with room and stock, never over the cap.
    assert.equal((await pay(held.body.orderId)).status, 200)
    const oa = await order(held.body.orderId)
    assert.equal(oa.deliveryDate, '2026-10-17')
    assert.ok(oa.notifications.some((n) => n.kind === 'DATE_MOVED'))
    const booked = await query(
      `SELECT COALESCE(SUM(i.quantity), 0)::int AS n FROM orders o JOIN order_items i ON i.order_id = o.id
        WHERE o.delivery_date = '2026-10-16' AND o.status NOT IN ('CANCELLED', 'RTO')`,
    )
    assert.equal(booked.rows[0].n, 2)
    await noDrift()
  })

  test('slot usage leaves out holds that ran out', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const a = await customerToken(api)
    const held = await checkout(api, a.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 3 }], { deliveryDate: '2026-10-16' })
    const slot = newId('slot')
    await query(`INSERT INTO delivery_slots (id, label, starts_at, ends_at, max_boxes, active, sort, created_at) VALUES ($1, 'Morning', '07:00', '11:00', 3, TRUE, 1, now())`, [slot])
    await query('UPDATE orders SET slot_id = $2 WHERE id = $1', [held.body.orderId, slot])
    assert.equal((await slotUsage({ query }, '2026-10-16')).get(slot), 3)
    later(11 * 60_000)
    assert.equal((await slotUsage({ query }, '2026-10-16')).get(slot) ?? 0, 0)
    // The customer's slot list says the same.
    const listed = await api.get('/v1/delivery/slots?pincode=560034&delivery_date=2026-10-16')
    assert.equal(listed.body.slots.find((s) => s.id === slot).remainingBoxes, 3)
  })
})

describe('INV-I: quote checks the day, one transition table, ledger actor ids', () => {
  test('a full day fails at quote, not only at confirm', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    await api.put('/admin/v1/calendar/2026-10-16', { isOpen: true, maxBoxes: 1 }, { token: admin })
    await paidOrder(1, { deliveryDate: '2026-10-16' })
    const b = await customerToken(api)
    await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 1 }, { token: b.accessToken })
    const q = await api.post('/v1/checkout/quote', { pincode: '560034', deliveryDate: '2026-10-16' }, { token: b.accessToken })
    assert.equal(q.status, 409)
    assert.equal(q.body.error.code, 'DATE_FULL')
  })

  test('the staff moves are derived from ORDER_TRANSITIONS and match the old table', () => {
    const old = {
      CONFIRMED: ['PROCESSING'],
      PROCESSING: ['PACKED'],
      PACKED: ['SHIPPED'],
      SHIPPED: ['OUT_FOR_DELIVERY'],
      OUT_FOR_DELIVERY: ['DELIVERED', 'DELIVERY_FAILED'],
      DELIVERY_FAILED: ['OUT_FOR_DELIVERY', 'RTO'],
    }
    const derived = Object.fromEntries(Object.entries(STAFF_TRANSITIONS).filter(([, tos]) => tos.length))
    assert.deepEqual(derived, old)
    for (const [from, tos] of Object.entries(STAFF_TRANSITIONS)) for (const to of tos) assert.ok(ORDER_TRANSITIONS[from].includes(to))
  })

  test('batch routes record the staff id like the order engine does; the ledger view adds the email', async () => {
    const created = await api.post('/admin/v1/batches', { variety: 'Alphonso', pluckedOn: '2026-10-12', lines: [{ sku: 'ALP-3', onHand: 10 }] }, { token: admin })
    assert.equal(created.status, 201)
    const b = created.body.id
    await api.patch(`/admin/v1/batches/${b}/lines/${created.body.lines[0].id}`, { onHand: 12, reason: 'found two', reasonCode: 'CORRECTION' }, { token: admin })
    const me = (await query(`SELECT id FROM admin_users WHERE email = 'manager@mandimangoes.test'`)).rows[0].id
    const ids = (await query('SELECT DISTINCT actor_id FROM batch_ledger WHERE batch_id = $1', [b])).rows.map((r) => r.actor_id)
    assert.deepEqual(ids, [me])
    const view = await api.get(`/admin/v1/batches/${b}/ledger`, { token: admin })
    assert.ok(view.body.every((e) => e.actorId === me && e.actorEmail === 'manager@mandimangoes.test'))
  })
})

describe('INV-C: approval limits on stock changes', () => {
  test('five +20s by an operator: the limit is per line per day, not per call', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const id = await lineId(b)
    const statuses = []
    for (let i = 1; i <= 5; i++) {
      statuses.push((await api.patch(`/admin/v1/batches/${b}/lines/${id}`, { onHand: (await line(b, 'ALP-3')).on_hand + 20, reason: 'recount' }, { token: ops })).status)
    }
    assert.deepEqual(statuses, [204, 403, 403, 403, 403])
    assert.equal((await line(b, 'ALP-3')).on_hand, 30)
    // A manager can, and the ledger says so; the next day the operator's allowance starts again.
    assert.equal((await api.patch(`/admin/v1/batches/${b}/lines/${id}`, { onHand: 60, reason: 'second truck' }, { token: admin })).status, 204)
    later(86_400_000)
    assert.equal((await api.patch(`/admin/v1/batches/${b}/lines/${id}`, { onHand: 75, reason: 'recount' }, { token: ops })).status, 204)
  })

  test('-100 by an operator needs a manager, through an adjustment or a short arrival', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 200 } })
    const id = await lineId(b)
    const r = await api.patch(`/admin/v1/batches/${b}/lines/${id}`, { onHand: 100, reason: 'crushed' }, { token: ops })
    assert.equal(r.status, 403)
    assert.equal(r.body.error.code, 'MANAGER_APPROVAL_NEEDED')
    const short = await api.post(`/admin/v1/batches/${b}/lines/${id}/short-arrival`, { onHand: 100, reason: 'short truck' }, { token: ops })
    assert.equal(short.status, 403)
    assert.equal((await line(b, 'ALP-3')).on_hand, 200)
    assert.equal((await api.patch(`/admin/v1/batches/${b}/lines/${id}`, { onHand: 190, reason: 'crushed', reasonCode: 'DAMAGED' }, { token: ops })).status, 204)
    assert.equal((await api.patch(`/admin/v1/batches/${b}/lines/${id}`, { onHand: 100, reason: 'crushed', reasonCode: 'DAMAGED' }, { token: admin })).status, 204)
    const last = (await query(`SELECT reason FROM batch_ledger WHERE batch_id = $1 AND event_type = 'ADJUST' ORDER BY created_at DESC, id DESC LIMIT 1`, [b])).rows[0]
    assert.match(last.reason, /large decrease of 90, by a manager/)
  })
})

describe('INV-D: reason codes and counts', () => {
  test('adjustments and short arrivals store a reason code; a count posts with reason Count', async () => {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const id = await lineId(b)
    const bad = await api.patch(`/admin/v1/batches/${b}/lines/${id}`, { onHand: 9, reason: 'x', reasonCode: 'ROTTEN' }, { token: admin })
    assert.equal(bad.status, 400)
    assert.equal((await api.patch(`/admin/v1/batches/${b}/lines/${id}`, { onHand: 9, reason: 'one crushed', reasonCode: 'DAMAGED' }, { token: admin })).status, 204)
    assert.equal((await api.patch(`/admin/v1/batches/${b}/lines/${id}`, { onHand: 8, reason: 'no code' }, { token: admin })).status, 204)

    // 4 paid and packed (off on_hand, still on the shelf), 2 paid and waiting: a shelf count of 7 means 1 box is gone.
    const { id: packedId } = await packedOrder(4)
    await paidOrder(2)
    const detail = (await api.get(`/admin/v1/batches/${b}`, { token: admin })).body
    assert.equal(detail.lines[0].packedNotDispatched, 4)
    assert.equal(detail.lines[0].onHand, 4)
    // counted 5 (incl. the 4 packed) → on hand 1, below the 2 promised: posted as a short arrival with reason Count.
    const r = await api.post(`/admin/v1/batches/${b}/lines/${id}/short-arrival`, { onHand: 1, reason: 'Physical count: 5 counted, 4 of them packed', reasonCode: 'COUNT' }, { token: admin })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const ledger = (await api.get(`/admin/v1/batches/${b}/ledger`, { token: admin })).body.filter((e) => e.eventType === 'ADJUST')
    assert.deepEqual(ledger.map((e) => e.reasonCode), ['COUNT', 'OTHER', 'DAMAGED'])
    assert.match(ledger[0].reason, /^Count: Physical count/)
    assert.ok(packedId)
    await noDrift()
  })
})

describe('INV-G: overdue orders are flagged', () => {
  test('an order past its date shows in summary and attention and raises the health alert', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const { id } = await paidOrder(1, { deliveryDate: '2026-10-16' })
    let s = (await api.get('/admin/v1/summary', { token: admin })).body
    assert.deepEqual(s.overdueOrders, [])
    later(3 * 86_400_000) // 10-18
    s = (await api.get('/admin/v1/summary', { token: admin })).body
    assert.deepEqual(s.overdueOrders.map((o) => [o.id, o.daysLate]), [[id, 2]])
    const a = (await api.get('/admin/v1/attention', { token: admin })).body
    assert.deepEqual(a.overdueOrders.map((o) => o.id), [id])
    assert.match(a.overdueOrders[0].reason, /2 days past its delivery date/)
    assert.ok((await checkHealth()).includes('overdue'))
  })

  test('out for delivery longer than the rule allows is overdue the same day', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const { id } = await packedOrder(1)
    await dispatch(id)
    later(2 * 3_600_000)
    assert.deepEqual((await api.get('/admin/v1/attention', { token: admin })).body.overdueOrders, [])
    later(9.5 * 3_600_000)
    const a = (await api.get('/admin/v1/attention', { token: admin })).body
    assert.deepEqual(a.overdueOrders.map((o) => o.id), [id])
    assert.match(a.overdueOrders[0].reason, /out for delivery for 9 hours/)
  })
})

describe('INV-B: a late payment with no stock anywhere is not told the old date', () => {
  test('the confirmation is held until stock is found, and the shop says so', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 2 } })
    const a = await customerToken(api)
    const ca = await checkout(api, a.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])
    later(12.5 * 60_000) // past the hold plus the 2-minute grace for gateway orders (PAY-B5)
    const b = await customerToken(api)
    const cb = await checkout(api, b.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }]) // lazily expires A, takes the boxes
    assert.equal(cb.status, 201)
    await pay(cb.body.orderId)
    await pay(ca.body.orderId)

    let o = await order(ca.body.orderId)
    assert.equal(o.status, 'CONFIRMED')
    assert.equal(o.atRisk, true)
    const confirmed = o.notifications.filter((n) => n.kind === 'ORDER_CONFIRMED')
    assert.deepEqual(confirmed.map((n) => [n.status, n.error]), [['SKIPPED', CONFIRMATION_HELD]])
    const mine = (await api.get(`/v1/orders/${ca.body.orderId}`, { token: a.accessToken })).body
    assert.equal(mine.findingStock, true)

    // Stock turns up: the re-check fills the order and the confirmation goes out then.
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 3 } })
    const r = await api.post(`/admin/v1/orders/${ca.body.orderId}/rebalance`, undefined, { token: admin })
    assert.deepEqual(r.body, { changed: true, atRisk: false })
    o = await order(ca.body.orderId)
    assert.deepEqual(o.notifications.filter((n) => n.kind === 'ORDER_CONFIRMED').map((n) => n.status), ['SKIPPED', 'PENDING'])
    assert.equal((await api.get(`/v1/orders/${ca.body.orderId}`, { token: a.accessToken })).body.findingStock, false)
    await noDrift()
  })
})

describe('INV-E: a missed ripe delivery whose retry would be over-age', () => {
  async function failedRipe() {
    const old = await makeBatch({ age: 6, rating: 'RIPE', lines: { 'ALP-3': 1 } }) // age 7 on 10-16, 8 on 10-17
    const { id, cust } = await packedOrder(1)
    later(86_400_000) // 10-16, the delivery day
    await dispatch(id)
    return { id, cust, old }
  }

  test('younger stock is packed for the retry and the old box goes back to the shelf', async () => {
    const { id, old } = await failedRipe()
    const young = await makeBatch({ age: 5, rating: 'RIPE', lines: { 'ALP-3': 3 } }) // age 6 on 10-17
    assert.equal((await fail(id)).status, 200)
    const o = await order(id)
    assert.equal(o.deliveryDate, '2026-10-17')
    assert.equal(o.atRisk, false)
    assert.deepEqual(o.stock.map((s) => [s.batchId, s.state]), [[young, 'packed']])
    assert.match(o.events.find((e) => e.status === 'DELIVERY_FAILED').reason, /swapped for younger stock/)
    assert.equal((await line(old, 'ALP-3')).on_hand, 1)
    assert.equal((await line(young, 'ALP-3')).on_hand, 2)
    later(2 * 86_400_000)
    await dispatch(id) // goes out on the retry day without an override
    await noDrift()
  })

  test('with no younger stock it is flagged for a manager and the retry message is held', async () => {
    const { id, cust } = await failedRipe()
    assert.equal((await fail(id)).status, 200)
    const o = await order(id)
    assert.equal(o.atRisk, true)
    assert.match(o.events.find((e) => e.status === 'DELIVERY_FAILED').reason, /A manager decides/)
    assert.deepEqual(o.notifications.filter((n) => n.kind === 'DELIVERY_FAILED').map((n) => n.status), ['SKIPPED'])
    const a = (await api.get('/admin/v1/attention', { token: admin })).body
    assert.deepEqual(a.retryDecisions.map((r) => r.id), [id])
    assert.equal((await api.get(`/v1/orders/${id}`, { token: cust.accessToken })).body.retryScheduled, false)
    await noDrift()
  })
})

describe('INV-F: boxes on orders cancelled after dispatch', () => {
  async function cancelledOnTheRoad() {
    const b = await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const { id } = await packedOrder(2)
    await dispatch(id)
    const c = await api.post(`/admin/v1/orders/${id}/cancel`, { reason: 'customer moved away', refund: true }, { token: admin })
    assert.equal(c.status, 204, JSON.stringify(c.body))
    return { id, b }
  }

  test('staff put returned boxes back on the shelf, and the ledger says why', async () => {
    const { id, b } = await cancelledOnTheRoad()
    assert.equal((await line(b, 'ALP-3')).on_hand, 3)
    assert.equal((await order(id)).returnedBoxes, 2)
    let a = (await api.get('/admin/v1/attention', { token: admin })).body
    assert.deepEqual(a.returnedStock.map((r) => [r.id, r.boxes]), [[id, 2]])

    const r = await api.post(`/admin/v1/orders/${id}/returned-stock`, { action: 'RESTOCK', reason: 'rider brought both back' }, { token: ops })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal((await line(b, 'ALP-3')).on_hand, 5)
    const last = (await query(`SELECT event_type, reason_code FROM batch_ledger WHERE batch_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [b])).rows[0]
    assert.deepEqual(last, { event_type: 'RESTOCK', reason_code: 'RETURN_RESTOCK' })
    a = (await api.get('/admin/v1/attention', { token: admin })).body
    assert.deepEqual(a.returnedStock, [])
    assert.equal((await api.post(`/admin/v1/orders/${id}/returned-stock`, { action: 'RESTOCK', reason: 'again' }, { token: ops })).body.error.code, 'NOTHING_TO_BOOK')
    await noDrift()
  })

  test('a write-off leaves on-hand as it is and records the loss with its reason', async () => {
    const { id, b } = await cancelledOnTheRoad()
    const r = await api.post(`/admin/v1/orders/${id}/returned-stock`, { action: 'WRITE_OFF', reasonCode: 'DAMAGED', reason: 'squashed in the van' }, { token: ops })
    assert.equal(r.status, 200)
    assert.equal((await line(b, 'ALP-3')).on_hand, 3)
    const rows = (await query(`SELECT event_type, delta, reason_code FROM batch_ledger WHERE batch_id = $1 AND reason_code IS NOT NULL ORDER BY created_at, delta DESC`, [b])).rows // both rows share one timestamp
    assert.deepEqual(rows.slice(-2), [
      { event_type: 'RESTOCK', delta: 2, reason_code: 'RETURN_RESTOCK' },
      { event_type: 'ADJUST', delta: -2, reason_code: 'DAMAGED' },
    ])
    assert.equal((await order(id)).returnedBoxes, 0)
    await noDrift()
  })

  test('boxes from a condemned batch can only be written off; open orders are refused', async () => {
    const { id, b } = await cancelledOnTheRoad()
    assert.equal((await api.patch(`/admin/v1/batches/${b}/status`, { status: 'CONDEMNED' }, { token: admin })).status, 200)
    const r = await api.post(`/admin/v1/orders/${id}/returned-stock`, { action: 'RESTOCK', reason: 'back' }, { token: ops })
    assert.equal(r.body.error.code, 'BATCH_CLOSED')
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 5 } })
    const { id: open } = await paidOrder(1)
    assert.equal((await api.post(`/admin/v1/orders/${open}/returned-stock`, { action: 'RESTOCK', reason: 'x' }, { token: ops })).status, 400)
  })
})

describe('INV-H: preorders that keep rolling forward', () => {
  test('moved more than the rule allows, or past the season end: on Needs attention', async () => {
    await customerToken(api)
    const customer = (await query('SELECT id, phone FROM customers LIMIT 1')).rows[0]
    const add = async (moved, week) => {
      const id = newId('pre')
      await query(
        `INSERT INTO preorders (id, number, customer_id, phone, sku, stage, qty, unit_price, total, week_start, pincode, delivery_address,
                                status, payment_status, moved_count, created_at, booked_at)
         VALUES ($1, $2, $3, $4, 'ALP-3', 'RIPE', 1, 100, 100, $5, '560034', 'x', 'BOOKED', 'SUCCEEDED', $6, now(), now())`,
        [id, `PRE-${moved}-${week}`, customer.id, customer.phone, week, moved],
      )
      return id
    }
    const fine = await add(3, '2026-11-02')
    const stuck = await add(4, '2026-11-02')
    const late = await add(0, '2026-11-16')
    let a = (await api.get('/admin/v1/attention', { token: admin })).body
    assert.deepEqual(a.preorderDecisions.map((p) => p.id), [stuck])
    await saveConfig({ ...currentConfig().rules, seasonEndsOn: '2026-11-10' }, 'test')
    a = (await api.get('/admin/v1/attention', { token: admin })).body
    assert.deepEqual(a.preorderDecisions.map((p) => p.id).sort(), [stuck, late].sort())
    assert.ok(!a.preorderDecisions.some((p) => p.id === fine))
    assert.match(a.preorderDecisions.find((p) => p.id === late).reason, /after the season ends/)
  })
})

setNow(T0)
