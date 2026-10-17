// Preorders: weekly capacity, waitlist, payment links, the allocator, moves and refunds.
import { adminToken, client, closeAll, customerToken, makeBatch, resetDb, signWebhook, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { addDays, now, setNow, todayIST } from '../src/clock.js'
import { query } from '../src/db.js'
import { newId } from '../src/ids.js'
import { runPreorderJobs } from '../src/maintenance.js'

let srv
let api
let admin

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
})

/** The first Monday after the regular booking horizon (today + 5 days before the cutoff). */
function openWeek() {
  let d = addDays(todayIST(), 6)
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1)
  return d
}
const setCapacity = (week, capacity, token = admin) => api.put(`/admin/v1/preorder-capacity/${week}/ALP-3`, { capacity }, { token })
const book = (token, week, extra = {}) =>
  api.post(
    '/v1/preorders',
    { sku: 'ALP-3', stage: 'RIPE', qty: 2, weekStart: week, pincode: '560034', address: '12, 4th Cross, Koramangala, Bengaluru', ...extra },
    { token, headers: { 'Idempotency-Key': newId('idem') } },
  )
const pre = async (id) => (await query('SELECT * FROM preorders WHERE id = $1', [id])).rows[0]
async function payLink(p) {
  const { raw, signature } = signWebhook({
    event: 'payment_link.paid',
    payload: {
      payment_link: { entity: { id: p.payment_link_id, notes: { preorderId: p.id }, status: 'paid' } },
      payment: { entity: { id: `pay_${p.id}`, amount: p.total, method: 'upi' } },
    },
  })
  const r = await api.raw('POST', '/webhooks/razorpay', { raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body
}
const kinds = async (id) => (await query('SELECT kind FROM notifications WHERE preorder_id = $1 ORDER BY created_at', [id])).rows.map((r) => r.kind)

describe('preorders', () => {
  test('capacity is taken atomically, overflow joins the waitlist, and payment books it', async () => {
    const week = openWeek()
    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    assert.equal((await setCapacity(week, 3, ops)).status, 403)
    assert.equal((await setCapacity(week, 3)).status, 200)
    assert.equal((await setCapacity(addDays(week, 1), 3)).status, 400) // not a Monday

    const weeks = await api.get('/v1/preorders/weeks?sku=ALP-3')
    const [w] = weeks.body.weeks
    assert.equal(weeks.body.weeks.length, 1)
    assert.deepEqual({ sku: w.sku, weekStart: w.weekStart, capacity: w.capacity, remaining: w.remaining }, { sku: 'ALP-3', weekStart: week, capacity: 3, remaining: 3 })
    // The shop shows the product with its locked price.
    assert.ok(w.name && w.boxSize && w.price > 0, JSON.stringify(w))
    // A week inside the regular booking horizon can't be preordered.
    const near = addDays(week, -7)
    await setCapacity(near, 5)
    const a = await customerToken(api)
    assert.equal((await book(a.accessToken, near)).body.error.code, 'INVALID_WEEK')

    const first = await book(a.accessToken, week)
    assert.equal(first.status, 201, JSON.stringify(first.body))
    assert.equal(first.body.status, 'PAYMENT_PENDING')
    assert.equal(first.body.total, 2 * first.body.unitPrice)
    assert.match(first.body.paymentUrl, /^https:\/\/rzp\.io\/i\/plink_dev_/)

    const b = await customerToken(api)
    const full = await book(b.accessToken, week)
    assert.equal(full.status, 409)
    assert.equal(full.body.error.code, 'PREORDER_FULL')
    const wait = await book(b.accessToken, week, { waitlist: true })
    assert.equal(wait.body.status, 'WAITLISTED')
    assert.equal(wait.body.paymentUrl, null)
    assert.equal((await api.get('/v1/preorders/weeks?sku=ALP-3')).body.weeks.find((w) => w.weekStart === week).remaining, 1)

    const p = await pre(first.body.id)
    await payLink(p)
    await payLink(p) // a replayed webhook changes nothing
    const paid = await api.get(`/v1/preorders/${p.id}`, { token: a.accessToken })
    assert.equal(paid.body.status, 'BOOKED')
    assert.equal(paid.body.paymentStatus, 'SUCCEEDED')
    assert.deepEqual(await kinds(p.id), ['PREORDER_BOOKED'])

    const list = await api.get('/admin/v1/preorders', { token: admin })
    assert.deepEqual(list.body.map((x) => x.status).sort(), ['BOOKED', 'WAITLISTED'])
    const cap = await api.get('/admin/v1/preorder-capacity', { token: admin })
    assert.deepEqual(cap.body.find((k) => k.weekStart === week), { sku: 'ALP-3', productName: cap.body[0].productName, weekStart: week, capacity: 3, reserved: 2, waitlisted: 1 })
  })

  test('an unpaid hold expires, raised capacity promotes the waitlist, and a late payment still books', async () => {
    const week = openWeek()
    await setCapacity(week, 2)
    const a = await customerToken(api)
    const held = await book(a.accessToken, week)
    const b = await customerToken(api)
    const waiting = await book(b.accessToken, week, { waitlist: true })
    assert.equal(waiting.body.status, 'WAITLISTED')

    setNow(new Date(now().getTime() + 11 * 60_000).toISOString())
    const jobs = await runPreorderJobs()
    assert.equal(jobs.expired, 1)
    assert.equal(jobs.promoted, 1) // the freed 2 boxes go to the waitlist
    const promoted = await pre(waiting.body.id)
    assert.equal(promoted.status, 'PAYMENT_PENDING')
    assert.ok(promoted.payment_link_url)
    assert.deepEqual(await kinds(promoted.id), ['PREORDER_SPOT_OPEN'])
    assert.equal((await pre(held.body.id)).status, 'CANCELLED')

    // The first customer pays after their hold expired: still booked, even over capacity.
    await payLink(await pre(held.body.id))
    assert.equal((await pre(held.body.id)).status, 'BOOKED')
    const cap = (await query('SELECT reserved FROM preorder_capacity WHERE sku = $1 AND week_start = $2', ['ALP-3', week])).rows[0]
    assert.equal(cap.reserved, 4)
  })

  test('the allocator turns a paid preorder into an order before regular shoppers can book that date', async () => {
    const week = openWeek()
    setNow(`${addDays(week, -6)}T04:30:00Z`) // 10:00 IST six days before: the horizon ends on Sunday
    await setCapacity(week, 10)
    const a = await customerToken(api)
    const booked = await book(a.accessToken, week)
    await payLink(await pre(booked.body.id))
    assert.equal((await runPreorderJobs()).converted, 0) // no stock yet

    await makeBatch({ age: 0, rating: 'RAW', lines: { 'ALP-3': 10 } }) // ripe (age 6) on Monday
    const jobs = await runPreorderJobs()
    assert.equal(jobs.converted, 1)
    const p = await pre(booked.body.id)
    assert.equal(p.status, 'CONVERTED')
    const o = (await query('SELECT * FROM orders WHERE id = $1', [p.order_id])).rows[0]
    assert.equal(o.delivery_date, week)
    assert.equal(o.status, 'CONFIRMED')
    assert.equal(o.preorder_id, p.id)
    assert.equal(o.payment_id, p.payment_id)
    assert.equal(o.total, p.total)
    const n = await query('SELECT kind FROM notifications WHERE order_id = $1', [o.id])
    assert.deepEqual(n.rows.map((r) => r.kind), ['ORDER_CONFIRMED'])

    // Cancelling the preorder now cancels its order, with the full refund.
    const cancel = await api.post(`/v1/preorders/${p.id}/cancel`, {}, { token: a.accessToken })
    assert.equal(cancel.status, 204)
    const after = (await query('SELECT status, payment_status FROM orders WHERE id = $1', [o.id])).rows[0]
    assert.deepEqual(after, { status: 'CANCELLED', payment_status: 'REFUNDED' })
  })

  test('a week that passes without stock moves the preorder to the next week and tells the customer', async () => {
    const week = openWeek()
    await setCapacity(week, 10)
    const a = await customerToken(api)
    const booked = await book(a.accessToken, week)
    await payLink(await pre(booked.body.id))
    setNow(`${addDays(week, 7)}T04:30:00Z`)
    const jobs = await runPreorderJobs()
    assert.equal(jobs.moved, 1)
    const p = await pre(booked.body.id)
    assert.equal(p.status, 'BOOKED')
    assert.equal(p.week_start, addDays(week, 7))
    assert.equal(p.moved_count, 1)
    assert.deepEqual(await kinds(p.id), ['PREORDER_BOOKED', 'PREORDER_MOVED'])
  })

  test('a paid preorder cancelled before its week is refunded in full and frees its spot', async () => {
    const week = openWeek()
    await setCapacity(week, 2)
    const a = await customerToken(api)
    const booked = await book(a.accessToken, week)
    await payLink(await pre(booked.body.id))
    const b = await customerToken(api)
    const waiting = await book(b.accessToken, week, { waitlist: true })

    assert.equal((await api.post(`/v1/preorders/${booked.body.id}/cancel`, {}, { token: b.accessToken })).status, 404)
    assert.equal((await api.post(`/v1/preorders/${booked.body.id}/cancel`, {}, { token: a.accessToken })).status, 204)
    const p = await pre(booked.body.id)
    assert.equal(p.status, 'CANCELLED')
    assert.equal(p.payment_status, 'REFUNDED')
    assert.match(p.refund_id, /^rfnd_dev_/)
    assert.deepEqual(await kinds(p.id), ['PREORDER_BOOKED', 'REFUNDED'])
    assert.equal((await runPreorderJobs()).promoted, 1)
    assert.equal((await pre(waiting.body.id)).status, 'PAYMENT_PENDING')
  })

  test('the dev payment route books a preorder, and a cancel after paying refunds it', async () => {
    const week = openWeek()
    await setCapacity(week, 5)
    const a = await customerToken(api)
    const p = (await book(a.accessToken, week)).body
    assert.equal(p.address, '12, 4th Cross, Koramangala, Bengaluru')
    assert.equal((await api.post('/v1/dev/pay-preorder', { preorderId: p.id, outcome: 'failed' })).body.result, 'ignored')
    assert.equal((await api.get(`/v1/preorders/${p.id}`, { token: a.accessToken })).body.status, 'PAYMENT_PENDING')
    assert.equal((await api.post('/v1/dev/pay-preorder', { preorderId: p.id, outcome: 'captured' })).body.result, 'booked')
    const booked = (await api.get(`/v1/preorders/${p.id}`, { token: a.accessToken })).body
    assert.equal(booked.status, 'BOOKED')
    assert.equal(booked.paymentUrl, null)
    assert.equal((await api.post(`/v1/preorders/${p.id}/cancel`, {}, { token: a.accessToken })).status, 204)
    const gone = (await api.get(`/v1/preorders/${p.id}`, { token: a.accessToken })).body
    assert.equal(gone.status, 'CANCELLED')
    assert.ok(gone.refund?.refundedAt, JSON.stringify(gone.refund))
  })
})
