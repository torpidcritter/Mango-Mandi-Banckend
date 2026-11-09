// Farm Experience (docs/farm-experience.md): 250 kg or more, paid in full
// before the visit, with a farm stay arranged by staff. The rules on their own
// (price, minimum, status moves, cancel and move options, meal plan), then the
// whole flow through the API: setup, booking with a hold, Razorpay webhooks
// (once however often), late payments, concurrency on the last kilograms,
// hospitality review for groups of any size, the day at the farm, extra
// kilograms, shortfall refunds, cancelling and moving, who may do what, and
// the reports.
import { adminToken, client, closeAll, customerToken, resetDb, signWebhook, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { drainBackground } from '../src/background.js'
import { addDays, now, setNow, todayIST } from '../src/clock.js'
import { query } from '../src/db.js'
import { env } from '../src/env.js'
import { forgetSwitches } from '../src/feature-switches.js'
import { newId } from '../src/ids.js'
import { runFarmJobs } from '../src/farm/jobs.js'
import { cancelOption, extraAmount, priceFor, rescheduleOption, suggestMealPlan, assertStaffMove, MIN_KG } from '../src/farm/rules.js'
import { processDueRefunds } from '../src/payments.js'

let srv
let api
let manager
const CONFIRM = 'manager123'

before(async () => {
  srv = await startServer()
  api = client(srv.base)
})
after(async () => {
  env.FARM_EXPERIENCE = false
  await srv.close()
  await closeAll()
})
beforeEach(async () => {
  env.FARM_EXPERIENCE = true
  env.WHATSAPP_FARM_UPDATES = false
  env.STAFF_STEP_UP = false
  forgetSwitches()
  await resetDb()
  manager = await adminToken(api)
})
afterEach(async () => {
  await drainBackground()
  setNow(null)
  env.FARM_EXPERIENCE = false
  env.WHATSAPP_FARM_UPDATES = false
  env.FARM_ALERT_PHONES = []
})

const one = async (sql, params) => (await query(sql, params)).rows[0]
const T = () => todayIST()
const VISIT = () => addDays(T(), 10)
const as = (token) => ({ token })

const READY_SETTINGS = () => ({
  farmName: 'Test orchard (placeholder)', location: 'Test location', contactPhone: '+919800000000', arrivalInstructions: 'Report at the gate.',
  checkInTime: '10:00', checkOutTime: '11:00', stayNights: 1, sleepingArrangements: 'Shared rooms', bathroomFacilities: 'Attached bathrooms',
  meals: { breakfast: true, lunch: true, dinner: true, refreshments: true }, transportPolicy: 'Transport is not included.',
  weatherPolicy: 'Visits in heavy rain are moved.', seasonStart: T(), seasonEnd: addDays(T(), 120), leadDays: 3, maxDaysAhead: 90,
  faqs: [{ q: 'Is there a minimum purchase?', a: 'Yes, 250 kg.' }],
})

/** A farm ready for bookings: one variety (Rs 120/kg, Rs 100/kg from 500 kg), open dates with bookable kg, one room for 4. */
async function setupFarm({ bookableKg = 1000, maxBookings = null, days = [VISIT(), addDays(VISIT(), 1), addDays(VISIT(), 2)] } = {}) {
  const v = await api.post('/admin/v1/farm/varieties', { name: 'Alphonso', sku: 'ALP-3', pricePerKg: 12_000, tiers: [{ minKg: 500, pricePerKg: 10_000 }], confirmCode: CONFIRM }, as(manager))
  assert.equal(v.status, 201, JSON.stringify(v.body))
  for (const d of days) {
    assert.equal((await api.put(`/admin/v1/farm/days/${d}`, { open: true, maxBookings }, as(manager))).status, 200)
    const h = await api.put(`/admin/v1/farm/harvest/${v.body.id}/${d}`, { estimatedKg: bookableKg * 2, bookableKg }, as(manager))
    assert.equal(h.status, 200, JSON.stringify(h.body))
  }
  const r = await api.post('/admin/v1/farm/rooms', { name: 'Room 1', sleeps: 4, beds: 2 }, as(manager))
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const cur = await api.get('/admin/v1/farm/settings', as(manager))
  const s = await api.put('/admin/v1/farm/settings', { settings: { ...READY_SETTINGS(), bookingsOpen: true }, version: cur.body.version, confirmCode: CONFIRM }, as(manager))
  assert.equal(s.status, 200, JSON.stringify(s.body))
  return { varietyId: v.body.id, roomId: r.body.id }
}

const input = (varietyId, over = {}) => ({
  varietyId, kg: 300, visitDate: VISIT(), adults: 4, children: 2, overnightGuests: 0, contactName: 'Asha Rao', contactEmail: 'asha@example.com',
  food: { veg: 6, allergies: 'peanuts' }, acceptPolicies: true, ...over,
})
async function book(cust, body, key = newId('k')) {
  return api.post('/v1/farm-bookings', body, { token: cust.accessToken, headers: { 'Idempotency-Key': key } })
}
const captured = (razorpayOrderId, amount, paymentId = `pay_${newId('x').slice(2, 16)}`) => ({
  event: 'payment.captured', payload: { payment: { entity: { id: paymentId, order_id: razorpayOrderId, amount, currency: 'INR', method: 'upi' } } },
})
async function webhook(event, eventId = newId('evt')) {
  const s = signWebhook(event)
  const r = await api.raw('POST', '/webhooks/razorpay', { raw: s.raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': s.signature, 'X-Razorpay-Event-Id': eventId } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body
}
async function paidBooking(varietyId, over = {}, cust = null) {
  cust ??= await customerToken(api)
  const b = await book(cust, input(varietyId, over))
  assert.equal(b.status, 201, JSON.stringify(b.body))
  const w = await webhook(captured(b.body.razorpayOrderId, b.body.total))
  assert.equal(w.result, 'confirmed', JSON.stringify(w))
  return { cust, id: b.body.bookingId, created: b.body }
}
const harvestRow = (varietyId, day = VISIT()) => one('SELECT * FROM farm_harvest WHERE variety_id = $1 AND day = $2', [varietyId, day])
const booking = (id) => one('SELECT * FROM farm_bookings WHERE id = $1', [id])

// ---------------------------------------------------------------- rules

describe('rules', () => {
  const v = { price_per_kg: 12_000, tiers: [{ minKg: 500, pricePerKg: 10_000 }, { minKg: 1000, pricePerKg: 9_000 }] }
  test('249 kg is refused, 250 kg is the minimum, tiers apply from their kg', () => {
    assert.equal(MIN_KG, 250)
    assert.throws(() => priceFor(v, 249), /minimum is 250 kg/)
    assert.throws(() => priceFor(v, 250.5), /minimum/)
    assert.deepEqual([priceFor(v, 250).total, priceFor(v, 499).pricePerKg, priceFor(v, 500).pricePerKg, priceFor(v, 1000).total], [3_000_000, 12_000, 10_000, 9_000_000])
    assert.equal(priceFor(v, 7500).pricePerKg, 9_000) // no top limit
  })
  test('extra kilograms are charged to the paisa', () => {
    assert.equal(extraAmount(12.5, 12_000), 150_000)
    assert.equal(extraAmount('0.33', 12_000), 3960)
  })
  test('status moves outside the list are refused', () => {
    assertStaffMove('CONFIRMED', 'PREPARING')
    assertStaffMove('PACKING', 'COMPLETED')
    assert.throws(() => assertStaffMove('PAYMENT_PENDING', 'CONFIRMED'), /can’t move/)
    assert.throws(() => assertStaffMove('HOSPITALITY_REVIEW', 'CONFIRMED'), /can’t move/)
    assert.throws(() => assertStaffMove('CONFIRMED', 'COMPLETED'), /can’t move/)
  })
  test('cancel and move options follow the deadline and the progress', () => {
    const s = { cancelDays: 7, rescheduleDays: 3 }
    const today = '2027-04-01'
    const at = (status, visit) => ({ status, visit_date: visit })
    assert.equal(cancelOption(at('PAYMENT_PENDING', '2027-04-02'), s, today), 'UNPAID')
    assert.equal(cancelOption(at('CONFIRMED', '2027-04-08'), s, today), 'REFUND')
    assert.equal(cancelOption(at('CONFIRMED', '2027-04-07'), s, today), 'REQUEST')
    assert.equal(cancelOption(at('PREPARING', '2027-05-30'), s, today), 'REQUEST')
    assert.equal(cancelOption(at('HARVESTING', '2027-04-01'), s, today), null)
    assert.equal(rescheduleOption(at('CONFIRMED', '2027-04-04'), s, today), 'MOVE')
    assert.equal(rescheduleOption(at('CONFIRMED', '2027-04-03'), s, today), 'REQUEST')
    assert.equal(rescheduleOption(at('PAYMENT_PENDING', '2027-04-30'), s, today), null)
  })
  test('the starting meal plan covers each day of the stay for the whole group', () => {
    const plan = suggestMealPlan({ arrival: '2027-04-10', departure: '2027-04-11', guests: 40, meals: { breakfast: true, lunch: true, dinner: true, refreshments: false } })
    assert.deepEqual(plan, [
      { date: '2027-04-10', breakfast: 0, lunch: 40, dinner: 40, refreshments: 0 },
      { date: '2027-04-11', breakfast: 40, lunch: 40, dinner: 0, refreshments: 0 },
    ])
  })
})

// ---------------------------------------------------------------- setup and switch

describe('switch and setup', () => {
  test('off: every route answers 404, and the shop is told', async () => {
    env.FARM_EXPERIENCE = false
    assert.equal((await api.get('/v1/farm-experience')).status, 404)
    assert.equal((await api.get('/admin/v1/farm/bookings', as(manager))).status, 404)
    assert.equal((await api.get('/v1/policy')).body.features.farmExperience, false)
    env.FARM_EXPERIENCE = true
    assert.equal((await api.get('/v1/policy')).body.features.farmExperience, true)
  })

  test('bookings can’t open until the farm details, a variety, dates and rooms are set; nothing is made up meanwhile', async () => {
    const page = await api.get('/v1/farm-experience')
    assert.equal(page.status, 200)
    assert.equal(page.body.bookingsOpen, false)
    assert.equal(page.body.settings.farmName, '')
    assert.equal(page.body.settings.transportIncluded, false)
    const cur = await api.get('/admin/v1/farm/settings', as(manager))
    assert.ok(cur.body.problems.length >= 5)
    const r = await api.put('/admin/v1/farm/settings', { settings: { bookingsOpen: true }, version: cur.body.version, confirmCode: CONFIRM }, as(manager))
    assert.equal(r.status, 409)
    assert.equal(r.body.error.code, 'FARM_NOT_READY')
    const cust = await customerToken(api)
    const b = await book(cust, { ...input('fv_none') })
    assert.equal(b.status, 409)
    assert.equal(b.body.error.code, 'FARM_BOOKINGS_CLOSED')
  })

  test('the public page lists varieties with what is left, and dates only where enough is left', async () => {
    const { varietyId } = await setupFarm({ bookableKg: 400 })
    const page = await api.get('/v1/farm-experience')
    assert.equal(page.body.bookingsOpen, true)
    assert.equal(page.body.minKg, 250)
    assert.equal(page.body.varieties[0].available, true)
    assert.equal(page.body.varieties[0].pricePerKg, 12_000)
    assert.equal((await api.get(`/v1/farm-experience/dates?varietyId=${varietyId}&kg=400`)).body.dates.length, 3)
    assert.equal((await api.get(`/v1/farm-experience/dates?varietyId=${varietyId}&kg=401`)).body.dates.length, 0)
    const q = await api.post('/v1/farm-experience/quote', { varietyId, kg: 600 })
    assert.deepEqual([q.body.pricePerKg, q.body.total], [10_000, 6_000_000])
    assert.equal((await api.post('/v1/farm-experience/quote', { varietyId, kg: 249 })).body.error.code, 'FARM_MIN_KG')
  })
})

// ---------------------------------------------------------------- booking and payment

describe('booking and payment', () => {
  test('249 kg is refused by the API, 250 kg is booked, and the price comes from the server', async () => {
    const { varietyId } = await setupFarm()
    const cust = await customerToken(api)
    const low = await book(cust, input(varietyId, { kg: 249 }))
    assert.equal(low.status, 400)
    assert.equal(low.body.error.code, 'FARM_MIN_KG')
    const ok = await book(cust, { ...input(varietyId, { kg: 250 }) })
    assert.equal(ok.status, 201, JSON.stringify(ok.body))
    assert.equal(ok.body.total, 250 * 12_000)
    assert.match(ok.body.razorpayOrderId, /^order_dev_/)
    // A price sent by the shop is not accepted at all.
    const sneaky = await book(await customerToken(api), { ...input(varietyId), total: 1 })
    assert.equal(sneaky.status, 400)
    const b = await booking(ok.body.bookingId)
    assert.deepEqual([b.status, b.kg_reserved], ['PAYMENT_PENDING', true])
    assert.equal((await harvestRow(varietyId)).reserved_kg, 250)
  })

  test('a large group (500 people) is accepted by the form and flagged for staff, not refused', async () => {
    const { varietyId } = await setupFarm()
    const { id } = await paidBooking(varietyId, { adults: 350, children: 150, overnightGuests: 480, departureDate: addDays(VISIT(), 1) })
    const b = await booking(id)
    assert.deepEqual([b.status, b.over_capacity, b.adults + b.children], ['HOSPITALITY_REVIEW', true, 500])
    // Staff can't approve it blind: rooms or a written arrangement first.
    const a = await api.post(`/admin/v1/farm/bookings/${id}/hospitality`, { action: 'APPROVE' }, as(manager))
    assert.equal(a.body.error.code, 'HOSPITALITY_PLAN_REQUIRED')
    const p = await api.post(`/admin/v1/farm/bookings/${id}/hospitality`, { action: 'PROPOSE', text: 'Farmhouse for 4; the rest in two partner homestays 2 km away, with transfers.' }, as(manager))
    assert.equal(p.status, 200, JSON.stringify(p.body))
    assert.equal(p.body.hospitality.status, 'ALTERNATIVE_PROPOSED')
    assert.equal((await api.get(`/v1/farm-bookings/${id}`)).status, 401)
  })

  test('a captured webhook confirms the payment once, however often it comes; the page never trusts the redirect', async () => {
    const { varietyId } = await setupFarm()
    const cust = await customerToken(api)
    const b = await book(cust, input(varietyId))
    const ev = captured(b.body.razorpayOrderId, b.body.total, 'pay_farm_1')
    assert.equal((await webhook(ev, 'evt_f1')).result, 'confirmed')
    assert.equal((await webhook(ev, 'evt_f1')).duplicate, true)
    assert.equal((await webhook(ev, 'evt_f2')).result, 'already_paid')
    // A second, different payment for the same booking is refunded on its own.
    assert.equal((await webhook(captured(b.body.razorpayOrderId, b.body.total, 'pay_farm_2'))).result, 'duplicate_payment')
    assert.ok(await one(`SELECT 1 AS x FROM duplicate_payments WHERE payment_id = 'pay_farm_2'`))
    // A wrong amount confirms nothing.
    const other = await book(await customerToken(api), input(varietyId, { visitDate: addDays(VISIT(), 1) }))
    const bad = await webhook(captured(other.body.razorpayOrderId, other.body.total - 100, 'pay_farm_3'))
    assert.equal(bad.result, 'rejected')
    assert.equal((await booking(other.body.bookingId)).status, 'PAYMENT_PENDING')
    // verify-payment with a forged signature is refused; the page shows the webhook's word.
    const v = await api.post(`/v1/farm-bookings/${other.body.bookingId}/verify-payment`, { razorpay_order_id: other.body.razorpayOrderId, razorpay_payment_id: 'pay_x', razorpay_signature: 'f'.repeat(64) }, { token: (await customerToken(api)).accessToken })
    assert.equal(v.status, 404) // not their booking
    const page = await api.get(`/v1/farm-bookings/${b.body.bookingId}`, { token: cust.accessToken })
    assert.equal(page.body.status, 'HOSPITALITY_REVIEW')
    assert.equal(page.body.payment.status, 'SUCCEEDED')
    assert.match(page.body.checkinCode, /^[2-9A-HJKMNP-Z]{12}$/)
    assert.equal(page.body.notes, undefined)
  })

  test('a failed payment keeps the booking and its hold; the customer can try again; the same key never books twice', async () => {
    const { varietyId } = await setupFarm()
    const cust = await customerToken(api)
    const key = newId('k')
    const b = await book(cust, input(varietyId), key)
    const again = await book(cust, input(varietyId), key)
    assert.equal(again.status, 200)
    assert.equal(again.body.bookingId, b.body.bookingId)
    assert.equal((await one('SELECT COUNT(*)::int AS n FROM farm_bookings')).n, 1)
    const reused = await book(cust, input(varietyId, { kg: 260 }), key)
    assert.equal(reused.status, 422)
    const f = await webhook({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_fail', order_id: b.body.razorpayOrderId, amount: b.body.total, currency: 'INR' } } } })
    assert.equal(f.result, 'attempt_failed')
    const page = await api.get(`/v1/farm-bookings/${b.body.bookingId}`, { token: cust.accessToken })
    assert.deepEqual([page.body.status, page.body.payment.failed, page.body.payment.razorpayOrderId], ['PAYMENT_PENDING', true, b.body.razorpayOrderId])
    // One unpaid booking at a time.
    const second = await book(cust, input(varietyId, { visitDate: addDays(VISIT(), 1) }))
    assert.equal(second.body.error.code, 'UNPAID_FARM_BOOKING')
    assert.equal((await webhook(captured(b.body.razorpayOrderId, b.body.total))).result, 'confirmed')
  })

  test('an expired hold gives the kilograms back; a late payment books them again if free, else goes to a manager', async () => {
    const { varietyId } = await setupFarm({ bookableKg: 300 })
    const a = await customerToken(api)
    const first = await book(a, input(varietyId))
    assert.equal(first.status, 201, JSON.stringify(first.body))
    setNow(new Date(now().getTime() + 20 * 60_000))
    assert.equal((await runFarmJobs()).expired, 1)
    assert.deepEqual([(await booking(first.body.bookingId)).status, (await harvestRow(varietyId)).reserved_kg], ['EXPIRED', 0])
    // Paid late while still free: booked.
    assert.equal((await webhook(captured(first.body.razorpayOrderId, first.body.total))).result, 'confirmed_late')
    assert.equal((await harvestRow(varietyId)).reserved_kg, 300)
    // Another expires, someone else takes the fruit, then it is paid: a manager decides.
    const day2 = addDays(VISIT(), 1)
    const late = await book(await customerToken(api), input(varietyId, { visitDate: day2 }))
    setNow(new Date(now().getTime() + 20 * 60_000))
    await runFarmJobs()
    const taker = await book(await customerToken(api), input(varietyId, { visitDate: day2 }))
    assert.equal(taker.status, 201, JSON.stringify(taker.body))
    assert.equal((await webhook(captured(late.body.razorpayOrderId, late.body.total))).result, 'needs_attention')
    const b = await booking(late.body.bookingId)
    assert.deepEqual([b.status, b.kg_reserved], ['NEEDS_ATTENTION', false])
    assert.match(b.attention_reason, /no longer free/)
    // The manager moves it to a date with fruit: the kilograms are taken there.
    const moved = await api.post(`/admin/v1/farm/bookings/${b.id}/move`, { date: addDays(VISIT(), 2), reason: 'Paid after the hold; moved' }, as(manager))
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    assert.equal(moved.body.status, 'HOSPITALITY_REVIEW')
    assert.equal((await harvestRow(varietyId, addDays(VISIT(), 2))).reserved_kg, 300)
  })

  test('two customers racing for the last kilograms: exactly one gets them', async () => {
    const { varietyId } = await setupFarm({ bookableKg: 300 })
    const custs = await Promise.all(Array.from({ length: 6 }, () => customerToken(api)))
    const results = await Promise.all(custs.map((c) => book(c, input(varietyId))))
    assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.body?.error?.code ?? r.status)))
    assert.ok(results.filter((r) => r.status !== 201).every((r) => ['FARM_NOT_ENOUGH_HARVEST'].includes(r.body.error.code)))
    assert.equal((await harvestRow(varietyId)).reserved_kg, 300)
  })

  test('dates: closed, outside the window, or full are refused; a day cap counts holds', async () => {
    const { varietyId } = await setupFarm({ maxBookings: 1 })
    const cust = await customerToken(api)
    assert.equal((await book(cust, input(varietyId, { visitDate: addDays(VISIT(), 5) }))).body.error.code, 'FARM_DATE_UNAVAILABLE')
    assert.equal((await book(cust, input(varietyId, { visitDate: addDays(T(), 1) }))).body.error.code, 'FARM_DATE_UNAVAILABLE')
    assert.equal((await book(cust, input(varietyId))).status, 201)
    assert.equal((await book(await customerToken(api), input(varietyId))).body.error.code, 'FARM_DATE_FULL')
    // Weather closure: the day closes and the manager is told which bookings to move.
    const close = await api.put(`/admin/v1/farm/days/${VISIT()}`, { open: false, closedReason: 'WEATHER' }, as(manager))
    assert.equal(close.body.bookingsToMove.length, 1)
    assert.equal((await book(await customerToken(api), input(varietyId))).body.error.code, 'FARM_DATE_UNAVAILABLE')
    // An inactive variety can't be booked.
    const v = await api.get('/admin/v1/farm/varieties', as(manager))
    await api.patch(`/admin/v1/farm/varieties/${varietyId}`, { active: false, version: v.body[0].version }, as(manager))
    assert.equal((await book(await customerToken(api), input(varietyId, { visitDate: addDays(VISIT(), 1) }))).body.error.code, 'FARM_VARIETY_UNAVAILABLE')
  })

  test('bookable kilograms can’t be cut below what is already booked', async () => {
    const { varietyId } = await setupFarm()
    await paidBooking(varietyId, { kg: 600 })
    const r = await api.put(`/admin/v1/farm/harvest/${varietyId}/${VISIT()}`, { bookableKg: 500 }, as(manager))
    assert.equal(r.body.error.code, 'FARM_BELOW_BOOKED')
  })
})

// ---------------------------------------------------------------- the visit

describe('hospitality, the visit, extras and shortfalls', () => {
  test('the whole journey: review, rooms, confirm, check-in by QR code, harvest, extra kg paid, packing, completed', async () => {
    const { varietyId, roomId } = await setupFarm()
    const { cust, id } = await paidBooking(varietyId, { overnightGuests: 4, departureDate: addDays(VISIT(), 1) })
    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    const list = await api.get('/admin/v1/farm/bookings?needsAction=true', as(ops))
    assert.equal(list.body.items[0].id, id)
    const rooms = await api.put(`/admin/v1/farm/bookings/${id}/rooms`, { allocations: [{ roomId, fromDate: VISIT(), toDate: addDays(VISIT(), 1), guests: 4 }] }, as(ops))
    assert.equal(rooms.status, 200, JSON.stringify(rooms.body))
    const ok = await api.post(`/admin/v1/farm/bookings/${id}/hospitality`, { action: 'APPROVE', text: 'Room 1 for four; others leave the same evening.' }, as(ops))
    assert.equal(ok.body.status, 'CONFIRMED')
    assert.equal(ok.body.hospitality.mealPlan.length, 2)
    // The same room can't be given to another booking for the same night.
    const other = await paidBooking(varietyId, { overnightGuests: 2, departureDate: addDays(VISIT(), 1) })
    const clash = await api.put(`/admin/v1/farm/bookings/${other.id}/rooms`, { allocations: [{ roomId, fromDate: VISIT(), toDate: addDays(VISIT(), 1), guests: 2 }] }, as(ops))
    assert.equal(clash.body.error.code, 'ROOM_TAKEN')
    // Customer's itinerary.
    const mine = await api.get(`/v1/farm-bookings/${id}`, { token: cust.accessToken })
    assert.equal(mine.body.hospitality.rooms[0].name, 'Room 1')
    const qr = await api.raw('GET', `/v1/farm-bookings/${id}/qr.svg`, { token: cust.accessToken })
    assert.equal(qr.status, 200)
    assert.match(qr.body, /<svg/)
    // Check-in only on the stay's days (operators can't override).
    const early = await api.post('/admin/v1/farm/check-in', { code: `MMF:${mine.body.checkinCode}` }, as(ops))
    assert.equal(early.body.error.code, 'NOT_VISIT_DAY')
    assert.equal((await api.post('/admin/v1/farm/check-in', { code: mine.body.checkinCode, override: true }, as(ops))).status, 403)
    setNow(new Date(`${VISIT()}T05:00:00Z`))
    const lookedUp = await api.get(`/admin/v1/farm/check-in/${mine.body.checkinCode}`, as(ops))
    assert.equal(lookedUp.body.id, id)
    const ci = await api.post('/admin/v1/farm/check-in', { code: `MMF:${mine.body.checkinCode}` }, as(ops))
    assert.equal(ci.body.status, 'CHECKED_IN')
    assert.equal((await api.post('/admin/v1/farm/check-in', { code: mine.body.checkinCode }, as(ops))).body.error.code, 'ALREADY_CHECKED_IN')
    // Customers can't cancel once at the farm.
    assert.equal((await api.post(`/v1/farm-bookings/${id}/cancel`, {}, { token: cust.accessToken })).body.error.code, 'NOT_CANCELLABLE')
    for (const to of ['HARVESTING', 'WEIGHING']) assert.equal((await api.post(`/admin/v1/farm/bookings/${id}/status`, { to }, as(ops))).body.status, to)
    await api.post(`/admin/v1/farm/bookings/${id}/harvest`, { harvestedKg: 315.5, acceptedKg: 312.25, inspectionNote: 'Good' }, as(ops))
    // 12.25 kg more than paid: an extra request the customer approves and pays.
    const x = await api.post(`/admin/v1/farm/bookings/${id}/extras`, { kg: 12.25 }, as(ops))
    assert.equal(x.body.extras[0].amount, 147_000)
    const pay = await api.post(`/v1/farm-bookings/${id}/extras/${x.body.extras[0].id}`, { accept: true }, { token: cust.accessToken })
    assert.equal(pay.status, 200, JSON.stringify(pay.body))
    assert.equal(pay.body.amount, 147_000)
    assert.equal((await webhook(captured(pay.body.razorpayOrderId, 147_000))).result, 'extra_paid')
    assert.equal((await api.post(`/admin/v1/farm/bookings/${id}/status`, { to: 'PACKING' }, as(ops))).body.status, 'PACKING')
    assert.equal((await api.post(`/admin/v1/farm/bookings/${id}/status`, { to: 'COMPLETED' }, as(ops))).body.error.code, 'NOT_PACKED')
    await api.post(`/admin/v1/farm/bookings/${id}/harvest`, { packingStatus: 'COLLECTED' }, as(ops))
    const done = await api.post(`/admin/v1/farm/bookings/${id}/status`, { to: 'COMPLETED' }, as(ops))
    assert.equal(done.body.status, 'COMPLETED')
    assert.equal(done.body.money.paid, 300 * 12_000 + 147_000)
    // Every step is recorded with who did it.
    assert.ok(done.body.events.some((e) => e.action === 'CHECKED_IN' && e.actor === 'ops@mandimangoes.test'))
    const audit = await one(`SELECT COUNT(*)::int AS n FROM staff_audit WHERE action LIKE '%/farm/%'`)
    assert.ok(audit.n >= 5)
  })

  test('a partial harvest: the manager refunds only the missing kilograms, never more than paid', async () => {
    const { varietyId } = await setupFarm()
    const { id } = await paidBooking(varietyId)
    await api.post(`/admin/v1/farm/bookings/${id}/hospitality`, { action: 'APPROVE' }, as(manager))
    setNow(new Date(`${VISIT()}T05:00:00Z`))
    const b = await booking(id)
    await api.post('/admin/v1/farm/check-in', { code: b.checkin_code }, as(manager))
    await api.post(`/admin/v1/farm/bookings/${id}/status`, { to: 'HARVESTING' }, as(manager))
    await api.post(`/admin/v1/farm/bookings/${id}/harvest`, { harvestedKg: 280, acceptedKg: 280 }, as(manager))
    const tooMuch = await api.post(`/admin/v1/farm/bookings/${id}/shortfall-refund`, { kg: 25, reason: 'Crop shortfall on the day', confirmCode: CONFIRM }, as(manager))
    assert.equal(tooMuch.body.error.code, 'SHORTFALL_TOO_LARGE')
    const r = await api.post(`/admin/v1/farm/bookings/${id}/shortfall-refund`, { kg: 20, reason: 'Crop shortfall on the day', confirmCode: CONFIRM }, as(manager))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.money.refunds[0].amount, 20 * 12_000)
    assert.notEqual(r.body.money.refunds[0].status, 'PENDING') // sent at once (dev gateway)
    assert.equal(r.body.status, 'HARVESTING') // the visit goes on
  })

  test('the customer accepts or declines a proposed arrangement; declining leaves a full refund open', async () => {
    const { varietyId } = await setupFarm()
    const { cust, id } = await paidBooking(varietyId, { visitDate: addDays(VISIT(), 0) })
    await api.post(`/admin/v1/farm/bookings/${id}/hospitality`, { action: 'PROPOSE', text: 'Day visit only; the farmhouse is closed for repairs that night.' }, as(manager))
    const no = await api.post(`/v1/farm-bookings/${id}/hospitality`, { accept: false, note: 'We wanted to stay' }, { token: cust.accessToken })
    assert.equal(no.body.hospitality.status, 'CUSTOMER_DECLINED')
    assert.equal(no.body.canCancel, 'REFUND')
    const second = await paidBooking(varietyId, { visitDate: addDays(VISIT(), 1) })
    await api.post(`/admin/v1/farm/bookings/${second.id}/hospitality`, { action: 'PROPOSE', text: 'Tents on the lawn for the group of six.' }, as(manager))
    const yes = await api.post(`/v1/farm-bookings/${second.id}/hospitality`, { accept: true }, { token: second.cust.accessToken })
    assert.deepEqual([yes.body.status, yes.body.hospitality.status], ['CONFIRMED', 'CUSTOMER_ACCEPTED'])
  })
})

// ---------------------------------------------------------------- cancel, move, refunds

describe('cancelling, moving and refunds', () => {
  test('a customer cancelling 7+ days ahead is refunded in full and the fruit goes back; later it becomes a request', async () => {
    const { varietyId } = await setupFarm()
    const { cust, id } = await paidBooking(varietyId)
    const c = await api.post(`/v1/farm-bookings/${id}/cancel`, { reason: 'Plans changed' }, { token: cust.accessToken })
    assert.equal(c.status, 200, JSON.stringify(c.body))
    assert.deepEqual([c.body.requested, c.body.booking.status, c.body.booking.refundStatus], [false, 'CANCELLED', 'REFUNDED'])
    assert.equal(c.body.booking.money.refunded, 300 * 12_000)
    assert.equal((await harvestRow(varietyId)).reserved_kg, 0)
    // Within the deadline: a request for the team, nothing refunded yet.
    const late = await paidBooking(varietyId)
    setNow(new Date(`${addDays(VISIT(), -3)}T05:00:00Z`))
    const r = await api.post(`/v1/farm-bookings/${late.id}/cancel`, { reason: 'Sick' }, { token: late.cust.accessToken })
    assert.deepEqual([r.body.requested, r.body.booking.status, r.body.booking.request.kind], [true, 'HOSPITALITY_REVIEW', 'CANCEL'])
    assert.equal((await one('SELECT COUNT(*)::int AS n FROM farm_refunds WHERE booking_id = $1', [late.id])).n, 0)
    // The manager decides: cancel with a refund (confirming it is them).
    const asked = await api.post(`/admin/v1/farm/bookings/${late.id}/cancel`, { reason: 'Customer is unwell; refunding', refund: true }, as(manager))
    assert.equal(asked.body.error.code, 'REAUTH_REQUIRED')
    const done = await api.post(`/admin/v1/farm/bookings/${late.id}/cancel`, { reason: 'Customer is unwell; refunding', refund: true, confirmCode: CONFIRM }, as(manager))
    assert.equal(done.body.status, 'CANCELLED')
    assert.equal(done.body.money.refunded, 300 * 12_000)
  })

  test('cancelling an unpaid booking just releases it; a payment that lands afterwards is refunded', async () => {
    const { varietyId } = await setupFarm()
    const cust = await customerToken(api)
    const b = await book(cust, input(varietyId))
    const c = await api.post(`/v1/farm-bookings/${b.body.bookingId}/cancel`, {}, { token: cust.accessToken })
    assert.deepEqual([c.body.booking.status, c.body.booking.refundStatus], ['CANCELLED', null])
    const w = await webhook(captured(b.body.razorpayOrderId, b.body.total))
    assert.equal(w.result, 'refund_due')
    await drainBackground()
    await processDueRefunds()
    const r = await one('SELECT * FROM farm_refunds WHERE booking_id = $1', [b.body.bookingId])
    assert.equal(r.kind, 'LATE_PAYMENT')
    assert.ok(r.refunded_at)
  })

  test('a customer moves the visit at once when it is early and the date has fruit', async () => {
    const { varietyId } = await setupFarm()
    const { cust, id } = await paidBooking(varietyId)
    await api.post(`/admin/v1/farm/bookings/${id}/hospitality`, { action: 'APPROVE' }, as(manager))
    const m = await api.post(`/v1/farm-bookings/${id}/reschedule`, { date: addDays(VISIT(), 1) }, { token: cust.accessToken })
    assert.equal(m.status, 200, JSON.stringify(m.body))
    assert.deepEqual([m.body.requested, m.body.booking.visitDate, m.body.booking.status], [false, addDays(VISIT(), 1), 'HOSPITALITY_REVIEW'])
    assert.equal((await harvestRow(varietyId)).reserved_kg, 0)
    assert.equal((await harvestRow(varietyId, addDays(VISIT(), 1))).reserved_kg, 300)
  })

  test('a refund that fails at Razorpay is retried; a manager can record one paid another way', async () => {
    const { varietyId } = await setupFarm()
    const { id } = await paidBooking(varietyId)
    const done = await api.post(`/admin/v1/farm/bookings/${id}/cancel`, { reason: 'Farm closed for weather', refund: true, kind: 'NOT_HOSTED', confirmCode: CONFIRM }, as(manager))
    const refund = await one('SELECT * FROM farm_refunds WHERE booking_id = $1', [id])
    assert.equal(done.body.money.refunds[0].status, 'SENT')
    // Razorpay says it failed: reopened for another attempt after its back-off.
    const w = await webhook({ event: 'refund.failed', payload: { refund: { entity: { id: refund.refund_id, payment_id: refund.payment_id, amount: refund.amount } } } })
    assert.ok(w)
    const reopened = await one('SELECT * FROM farm_refunds WHERE id = $1', [refund.id])
    assert.deepEqual([reopened.refunded_at, reopened.refund_status], [null, 'failed'])
    const settle = await api.post(`/admin/v1/farm/refunds/${refund.id}/settle`, { reference: 'NEFT UTR 1234', confirmCode: CONFIRM }, as(manager))
    assert.equal(settle.status, 200, JSON.stringify(settle.body))
    assert.equal(settle.body.money.refunds[0].status, 'REFUNDED')
  })
})

// ---------------------------------------------------------------- access

describe('who may do what', () => {
  test('customers only see their own bookings, and never staff notes', async () => {
    const { varietyId } = await setupFarm()
    const { id, cust } = await paidBooking(varietyId)
    await api.post(`/admin/v1/farm/bookings/${id}/notes`, { body: 'VIP: owner’s friend' }, as(manager))
    const stranger = await customerToken(api)
    assert.equal((await api.get(`/v1/farm-bookings/${id}`, { token: stranger.accessToken })).status, 404)
    assert.equal((await api.post(`/v1/farm-bookings/${id}/cancel`, {}, { token: stranger.accessToken })).status, 404)
    const staff = await api.get(`/admin/v1/farm/bookings/${id}`, as(manager))
    assert.equal(staff.body.notes[0].body, 'VIP: owner’s friend')
    const mine = await api.get(`/v1/farm-bookings/${id}`, { token: cust.accessToken })
    assert.equal(mine.status, 200)
    assert.ok(!JSON.stringify(mine.body).includes('VIP'))
    assert.ok(!JSON.stringify(mine.body).includes('manager@'))
  })

  test('operators run the day but can’t refund, cancel, move, change prices or settings; packers and riders see nothing', async () => {
    const { varietyId } = await setupFarm()
    const { id } = await paidBooking(varietyId)
    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    assert.equal((await api.get(`/admin/v1/farm/bookings/${id}`, as(ops))).status, 200)
    for (const [m, p, b] of [
      ['POST', `/farm/bookings/${id}/cancel`, { reason: 'trying it', refund: true }],
      ['POST', `/farm/bookings/${id}/move`, { date: addDays(VISIT(), 1), reason: 'trying it' }],
      ['POST', `/farm/bookings/${id}/shortfall-refund`, { kg: 1, reason: 'trying it' }],
      ['PATCH', `/farm/varieties/${varietyId}`, { pricePerKg: 1, version: 1 }],
      ['PUT', '/farm/settings', { settings: {}, version: 1 }],
      ['PUT', `/farm/days/${VISIT()}`, { open: false }],
      ['GET', `/farm/reports?from=${T()}&to=${VISIT()}`, undefined],
    ]) {
      const r = await api.raw(m, `/admin/v1${p}`, { token: ops, body: b })
      assert.equal(r.status, 403, `${m} ${p}: ${r.status}`)
    }
    for (const who of [['packer@mandimangoes.test', 'packer123'], ['qc@mandimangoes.test', 'qc123']]) {
      const t = await adminToken(api, ...who)
      assert.equal((await api.get('/admin/v1/farm/bookings', as(t))).status, 403)
    }
    assert.equal((await one('SELECT status FROM farm_bookings WHERE id = $1', [id])).status, 'HOSPITALITY_REVIEW')
  })
})

// ---------------------------------------------------------------- reports and messages

describe('reports and messages', () => {
  test('reports count paid bookings only, with refunds and a formula-safe CSV', async () => {
    const { varietyId } = await setupFarm()
    await paidBooking(varietyId, { kg: 400, adults: 2, children: 0 })
    await book(await customerToken(api), input(varietyId, { visitDate: addDays(VISIT(), 1), contactName: '=HYPERLINK("x")' })) // unpaid
    const r = await api.get(`/admin/v1/farm/reports?from=${T()}&to=${addDays(VISIT(), 5)}`, as(manager))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual([r.body.bookings, r.body.kgBooked, r.body.revenue], [1, 400, 400 * 12_000])
    assert.deepEqual([r.body.conversion.started, r.body.conversion.paid], [2, 1])
    const csv = await api.get(`/admin/v1/farm/reports/bookings.csv?from=${T()}&to=${addDays(VISIT(), 5)}`, as(manager))
    assert.match(csv.body, /'=HYPERLINK/)
  })

  test('with WHATSAPP_FARM_UPDATES on, a paid booking queues the customer update and team alert once', async () => {
    env.WHATSAPP_FARM_UPDATES = true
    env.FARM_ALERT_PHONES = ['+919811111111']
    const { varietyId } = await setupFarm()
    const cust = await customerToken(api)
    const b = await book(cust, input(varietyId))
    const ev = captured(b.body.razorpayOrderId, b.body.total, 'pay_msg')
    await webhook(ev, 'evt_m1')
    await webhook(ev, 'evt_m2')
    const rows = (await query('SELECT kind, farm_params FROM notifications WHERE farm_booking_id = $1 ORDER BY kind', [b.body.bookingId])).rows
    assert.deepEqual(rows.map((r) => r.kind), ['FARM_BOOKING_UPDATE', 'FARM_TEAM_ALERT'])
    assert.equal(rows[0].farm_params.length, 4)
    assert.match(rows[0].farm_params[2], /received your payment/)
  })

  test('with it off, nothing is queued (the booking page shows the status)', async () => {
    const { varietyId } = await setupFarm()
    await paidBooking(varietyId)
    assert.equal((await one('SELECT COUNT(*)::int AS n FROM notifications WHERE farm_booking_id IS NOT NULL')).n, 0)
  })
})
