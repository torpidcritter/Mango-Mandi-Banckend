// Farm Experience (docs/farm-experience.md): 250 kg or more, booked without
// paying, a farm stay arranged by staff, and the bill paid after picking for
// the kilograms weighed and accepted. The rules on their own (price, minimum,
// bill, status moves, cancel and move options, meal plan), then the whole flow
// through the API: setup, booking, the open-bookings cap, concurrency on the
// last kilograms, hospitality review for groups of any size, the day at the
// farm, the bill (paid online once however often Razorpay says so, or recorded
// by a manager), payments for a replaced bill refunded, cancelling and moving,
// who may do what, and the reports.
import { adminToken, client, closeAll, customerToken, resetDb, signWebhook, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { drainBackground } from '../src/background.js'
import { addDays, setNow, todayIST } from '../src/clock.js'
import { query } from '../src/db.js'
import { env } from '../src/env.js'
import { forgetSwitches } from '../src/feature-switches.js'
import { newId } from '../src/ids.js'
import { billFor, cancelOption, priceFor, rescheduleOption, suggestMealPlan, assertStaffMove, MIN_KG } from '../src/farm/rules.js'
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
/** A booking made (nothing paid): it waits for staff to arrange the stay. */
async function booked(varietyId, over = {}, cust = null) {
  cust ??= await customerToken(api)
  const b = await book(cust, input(varietyId, over))
  assert.equal(b.status, 201, JSON.stringify(b.body))
  assert.equal(b.body.status, 'HOSPITALITY_REVIEW')
  return { cust, id: b.body.bookingId, created: b.body }
}
const harvestRow = (varietyId, day = VISIT()) => one('SELECT * FROM farm_harvest WHERE variety_id = $1 AND day = $2', [varietyId, day])
const booking = (id) => one('SELECT * FROM farm_bookings WHERE id = $1', [id])
const staffPost = (path, body, token = manager) => api.post(`/admin/v1/farm/bookings/${path}`, body, as(token))

/** Takes a booking through the visit to its bill: stay approved, checked in on the day, picked, weighed, billed. */
async function billed(id, { harvestedKg = 310, acceptedKg = 300, token = manager } = {}) {
  if ((await booking(id)).status === 'HOSPITALITY_REVIEW') assert.equal((await staffPost(`${id}/hospitality`, { action: 'APPROVE' }, token)).status, 200)
  const b = await booking(id)
  setNow(new Date(`${b.visit_date}T05:00:00Z`))
  const ci = await api.post('/admin/v1/farm/check-in', { code: b.checkin_code }, as(token))
  assert.equal(ci.body.status, 'CHECKED_IN', JSON.stringify(ci.body))
  for (const to of ['HARVESTING', 'WEIGHING']) assert.equal((await staffPost(`${id}/status`, { to }, token)).body.status, to)
  assert.equal((await staffPost(`${id}/harvest`, { harvestedKg, acceptedKg }, token)).status, 200)
  const bill = await staffPost(`${id}/bill`, {}, token)
  assert.equal(bill.status, 200, JSON.stringify(bill.body))
  assert.equal(bill.body.status, 'PAYMENT_DUE')
  return bill.body
}
/** The customer presses Pay on the bill: the Razorpay order to pay. */
async function startPay(cust, id) {
  const r = await api.post(`/v1/farm-bookings/${id}/pay`, {}, { token: cust.accessToken })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.match(r.body.razorpayOrderId, /^order_dev_/)
  return r.body
}

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
  test('the bill charges the accepted kilograms: the booked part at the booking price, extra at the extra price, to the paisa', () => {
    const b = { kg: 300, price_per_kg: 12_000 }
    assert.deepEqual(billFor(b, 280), { acceptedKg: 280, bookedKg: 300, pricePerKg: 12_000, bookedPartKg: 280, extraKg: 0, extraPricePerKg: null, amount: 3_360_000 })
    assert.equal(billFor(b, 312.25).amount, 3_600_000 + 147_000) // no extra price set: the booking price
    const extra = billFor(b, 312.25, 10_000)
    assert.deepEqual([extra.extraKg, extra.extraPricePerKg, extra.amount], [12.25, 10_000, 3_600_000 + 122_500])
    assert.equal(billFor(b, '0.33').amount, 3960)
    assert.throws(() => billFor(b, 0), /accepted weight/)
    assert.throws(() => billFor(b, 0.005), /too little/)
  })
  test('status moves outside the list are refused; the bill and the payment have their own routes', () => {
    assertStaffMove('CONFIRMED', 'PREPARING')
    assertStaffMove('PACKING', 'COMPLETED')
    assert.throws(() => assertStaffMove('HOSPITALITY_REVIEW', 'CONFIRMED'), /can’t move/)
    assert.throws(() => assertStaffMove('CONFIRMED', 'COMPLETED'), /can’t move/)
    assert.throws(() => assertStaffMove('WEIGHING', 'PAYMENT_DUE'), /can’t move/)
    assert.throws(() => assertStaffMove('PAYMENT_DUE', 'PACKING'), /can’t move/)
    assert.throws(() => assertStaffMove('PAYMENT_DUE', 'COMPLETED'), /can’t move/)
  })
  test('cancel and move options follow the deadline and the progress', () => {
    const s = { cancelDays: 7, rescheduleDays: 3 }
    const today = '2027-04-01'
    const at = (status, visit) => ({ status, visit_date: visit })
    assert.equal(cancelOption(at('HOSPITALITY_REVIEW', '2027-04-08'), s, today), 'CANCEL')
    assert.equal(cancelOption(at('CONFIRMED', '2027-04-08'), s, today), 'CANCEL')
    assert.equal(cancelOption(at('CONFIRMED', '2027-04-07'), s, today), 'REQUEST')
    assert.equal(cancelOption(at('PREPARING', '2027-05-30'), s, today), 'REQUEST')
    assert.equal(cancelOption(at('HARVESTING', '2027-04-01'), s, today), null)
    assert.equal(cancelOption(at('PAYMENT_DUE', '2027-04-01'), s, today), null)
    assert.equal(rescheduleOption(at('CONFIRMED', '2027-04-04'), s, today), 'MOVE')
    assert.equal(rescheduleOption(at('CONFIRMED', '2027-04-03'), s, today), 'REQUEST')
    assert.equal(rescheduleOption(at('PAYMENT_DUE', '2027-04-30'), s, today), null)
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

// ---------------------------------------------------------------- booking

describe('booking (nothing paid up front)', () => {
  test('249 kg is refused by the API; 250 kg is booked with the kilograms held and nothing to pay yet', async () => {
    const { varietyId } = await setupFarm()
    const cust = await customerToken(api)
    const low = await book(cust, input(varietyId, { kg: 249 }))
    assert.equal(low.status, 400)
    assert.equal(low.body.error.code, 'FARM_MIN_KG')
    const ok = await book(cust, { ...input(varietyId, { kg: 250 }) })
    assert.equal(ok.status, 201, JSON.stringify(ok.body))
    assert.deepEqual([ok.body.status, ok.body.estimate, ok.body.kg], ['HOSPITALITY_REVIEW', 250 * 12_000, 250])
    assert.equal(ok.body.razorpayOrderId, undefined)
    // A price sent by the shop is not accepted at all.
    const sneaky = await book(await customerToken(api), { ...input(varietyId), total: 1 })
    assert.equal(sneaky.status, 400)
    const b = await booking(ok.body.bookingId)
    assert.deepEqual([b.status, b.kg_reserved, b.bill_amount, b.paid_at], ['HOSPITALITY_REVIEW', true, null, null])
    assert.equal((await harvestRow(varietyId)).reserved_kg, 250)
    assert.equal((await one('SELECT COUNT(*)::int AS n FROM farm_booking_payments')).n, 0)
    const page = await api.get(`/v1/farm-bookings/${ok.body.bookingId}`, { token: cust.accessToken })
    assert.deepEqual([page.body.payment, page.body.canPay, page.body.bill, page.body.canCancel], [null, false, null, 'CANCEL'])
    assert.match(page.body.checkinCode, /^[2-9A-HJKMNP-Z]{12}$/)
    assert.equal(page.body.notes, undefined)
    // Nothing to pay before the bill.
    assert.equal((await api.post(`/v1/farm-bookings/${ok.body.bookingId}/pay`, {}, { token: cust.accessToken })).body.error.code, 'NOTHING_TO_PAY')
  })

  test('the same key never books twice; one customer holds at most the set number of upcoming visits', async () => {
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
    assert.equal((await book(cust, input(varietyId, { visitDate: addDays(VISIT(), 1) }))).status, 201)
    const third = await book(cust, input(varietyId, { visitDate: addDays(VISIT(), 2) }))
    assert.equal(third.status, 409)
    assert.deepEqual([third.body.error.code, third.body.error.details?.max ?? third.body.error.max], ['TOO_MANY_FARM_BOOKINGS', 2])
    // Cancelling one frees a place.
    await api.post(`/v1/farm-bookings/${b.body.bookingId}/cancel`, {}, { token: cust.accessToken })
    assert.equal((await book(cust, input(varietyId, { visitDate: addDays(VISIT(), 2) }))).status, 201)
  })

  test('a large group (500 people) is accepted by the form and flagged for staff, not refused', async () => {
    const { varietyId } = await setupFarm()
    const { id } = await booked(varietyId, { adults: 350, children: 150, overnightGuests: 480, departureDate: addDays(VISIT(), 1) })
    const b = await booking(id)
    assert.deepEqual([b.status, b.over_capacity, b.adults + b.children], ['HOSPITALITY_REVIEW', true, 500])
    // Staff can't approve it blind: rooms or a written arrangement first.
    const a = await staffPost(`${id}/hospitality`, { action: 'APPROVE' })
    assert.equal(a.body.error.code, 'HOSPITALITY_PLAN_REQUIRED')
    const p = await staffPost(`${id}/hospitality`, { action: 'PROPOSE', text: 'Farmhouse for 4; the rest in two partner homestays 2 km away, with transfers.' })
    assert.equal(p.status, 200, JSON.stringify(p.body))
    assert.equal(p.body.hospitality.status, 'ALTERNATIVE_PROPOSED')
    assert.equal((await api.get(`/v1/farm-bookings/${id}`)).status, 401)
  })

  test('two customers racing for the last kilograms: exactly one gets them', async () => {
    const { varietyId } = await setupFarm({ bookableKg: 300 })
    const custs = await Promise.all(Array.from({ length: 6 }, () => customerToken(api)))
    const results = await Promise.all(custs.map((c) => book(c, input(varietyId))))
    assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.body?.error?.code ?? r.status)))
    assert.ok(results.filter((r) => r.status !== 201).every((r) => ['FARM_NOT_ENOUGH_HARVEST'].includes(r.body.error.code)))
    assert.equal((await harvestRow(varietyId)).reserved_kg, 300)
  })

  test('dates: closed, outside the window, or full are refused; a day cap counts bookings', async () => {
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
    await booked(varietyId, { kg: 600 })
    const r = await api.put(`/admin/v1/farm/harvest/${varietyId}/${VISIT()}`, { bookableKg: 500 }, as(manager))
    assert.equal(r.body.error.code, 'FARM_BELOW_BOOKED')
  })
})

// ---------------------------------------------------------------- the visit and the bill

describe('the visit, the bill and paying after picking', () => {
  test('the whole journey: review, rooms, confirm, check-in by QR code, picking, weighing, bill with extra kg, paid online, packing, completed', async () => {
    const { varietyId, roomId } = await setupFarm()
    const { cust, id } = await booked(varietyId, { overnightGuests: 4, departureDate: addDays(VISIT(), 1) })
    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    const list = await api.get('/admin/v1/farm/bookings?needsAction=true', as(ops))
    assert.equal(list.body.items[0].id, id)
    const rooms = await api.put(`/admin/v1/farm/bookings/${id}/rooms`, { allocations: [{ roomId, fromDate: VISIT(), toDate: addDays(VISIT(), 1), guests: 4 }] }, as(ops))
    assert.equal(rooms.status, 200, JSON.stringify(rooms.body))
    const ok = await staffPost(`${id}/hospitality`, { action: 'APPROVE', text: 'Room 1 for four; others leave the same evening.' }, ops)
    assert.equal(ok.body.status, 'CONFIRMED')
    assert.equal(ok.body.hospitality.mealPlan.length, 2)
    // The same room can't be given to another booking for the same night.
    const other = await booked(varietyId, { overnightGuests: 2, departureDate: addDays(VISIT(), 1) })
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
    for (const to of ['HARVESTING', 'WEIGHING']) assert.equal((await staffPost(`${id}/status`, { to }, ops)).body.status, to)
    // No bill before the weight is recorded.
    assert.equal((await staffPost(`${id}/bill`, {}, ops)).body.error.code, 'NOT_WEIGHED')
    await staffPost(`${id}/harvest`, { harvestedKg: 315.5, acceptedKg: 312.25, inspectionNote: 'Good' }, ops)
    // The bill: 300 kg booked at Rs 120 and 12.25 kg more at the same price (no extra price set).
    const bill = await staffPost(`${id}/bill`, {}, ops)
    assert.equal(bill.status, 200, JSON.stringify(bill.body))
    assert.deepEqual([bill.body.status, bill.body.bill.amount, bill.body.bill.extraKg], ['PAYMENT_DUE', 3_747_000, 12.25])
    // Weights are fixed once billed; packing waits for the payment.
    assert.equal((await staffPost(`${id}/harvest`, { acceptedKg: 300 }, ops)).body.error.code, 'BILL_MADE')
    assert.equal((await staffPost(`${id}/status`, { to: 'COMPLETED' }, ops)).body.error.code, 'BAD_STATUS_MOVE')
    // The customer sees the bill and pays it online.
    const due = await api.get(`/v1/farm-bookings/${id}`, { token: cust.accessToken })
    assert.deepEqual([due.body.canPay, due.body.payment.status, due.body.payment.amount, due.body.bill.acceptedKg], [true, 'DUE', 3_747_000, 312.25])
    const pay = await startPay(cust, id)
    assert.equal(pay.amount, 3_747_000)
    assert.equal((await startPay(cust, id)).razorpayOrderId, pay.razorpayOrderId) // pressing Pay again reuses the order
    assert.equal((await webhook(captured(pay.razorpayOrderId, 3_747_000))).result, 'paid')
    const paid = await api.get(`/v1/farm-bookings/${id}`, { token: cust.accessToken })
    assert.deepEqual([paid.body.status, paid.body.canPay, paid.body.payment.status, paid.body.payment.method], ['PACKING', false, 'PAID', 'ONLINE'])
    assert.equal((await staffPost(`${id}/status`, { to: 'COMPLETED' }, ops)).body.error.code, 'NOT_PACKED')
    await staffPost(`${id}/harvest`, { packingStatus: 'COLLECTED' }, ops)
    const done = await staffPost(`${id}/status`, { to: 'COMPLETED' }, ops)
    assert.equal(done.body.status, 'COMPLETED')
    assert.equal(done.body.money.paid, 3_747_000)
    // Every step is recorded with who did it.
    assert.ok(done.body.events.some((e) => e.action === 'CHECKED_IN' && e.actor === 'ops@mandimangoes.test'))
    assert.ok(done.body.events.some((e) => e.action === 'BILL_ISSUED' && e.actor === 'ops@mandimangoes.test'))
    assert.ok(done.body.events.some((e) => e.action === 'PAID' && e.actor === 'system'))
    const audit = await one(`SELECT COUNT(*)::int AS n FROM staff_audit WHERE action LIKE '%/farm/%'`)
    assert.ok(audit.n >= 5)
  })

  test('a smaller harvest is billed for what was accepted, with the extra kg price when one is set', async () => {
    const { varietyId } = await setupFarm()
    const cur = await api.get('/admin/v1/farm/settings', as(manager))
    assert.equal((await api.put('/admin/v1/farm/settings', { settings: { extraPricePerKg: 10_000 }, version: cur.body.version, confirmCode: CONFIRM }, as(manager))).status, 200)
    const short = await booked(varietyId)
    const big = await booked(varietyId, { visitDate: VISIT() })
    assert.equal((await billed(short.id, { harvestedKg: 290, acceptedKg: 280 })).bill.amount, 280 * 12_000)
    const b = await billed(big.id, { harvestedKg: 330, acceptedKg: 320 })
    assert.deepEqual([b.bill.bookedPartKg, b.bill.extraKg, b.bill.extraPricePerKg, b.bill.amount], [300, 20, 10_000, 300 * 12_000 + 20 * 10_000])
  })

  test('a captured payment is applied once however often it comes; a second payment is refunded; a wrong amount pays nothing', async () => {
    const { varietyId } = await setupFarm()
    const { cust, id } = await booked(varietyId)
    const bill = await billed(id)
    const pay = await startPay(cust, id)
    // A wrong amount confirms nothing.
    assert.equal((await webhook(captured(pay.razorpayOrderId, bill.bill.amount - 100, 'pay_farm_0'))).result, 'rejected')
    assert.equal((await booking(id)).status, 'PAYMENT_DUE')
    const ev = captured(pay.razorpayOrderId, bill.bill.amount, 'pay_farm_1')
    assert.equal((await webhook(ev, 'evt_f1')).result, 'paid')
    assert.equal((await webhook(ev, 'evt_f1')).duplicate, true)
    assert.equal((await webhook(ev, 'evt_f2')).result, 'already_paid')
    // A second, different payment for the same order is refunded on its own.
    assert.equal((await webhook(captured(pay.razorpayOrderId, bill.bill.amount, 'pay_farm_2'))).result, 'duplicate_payment')
    assert.ok(await one(`SELECT 1 AS x FROM duplicate_payments WHERE payment_id = 'pay_farm_2'`))
    // verify-payment for someone else's booking is refused; the page shows the webhook's word.
    const v = await api.post(`/v1/farm-bookings/${id}/verify-payment`, { razorpay_order_id: pay.razorpayOrderId, razorpay_payment_id: 'pay_x', razorpay_signature: 'f'.repeat(64) }, { token: (await customerToken(api)).accessToken })
    assert.equal(v.status, 404)
    assert.equal((await api.post(`/v1/farm-bookings/${id}/pay`, {}, { token: cust.accessToken })).body.error.code, 'NOTHING_TO_PAY')
  })

  test('a failed payment leaves the bill open to pay again', async () => {
    const { varietyId } = await setupFarm()
    const { cust, id } = await booked(varietyId)
    const bill = await billed(id)
    const pay = await startPay(cust, id)
    const f = await webhook({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_fail', order_id: pay.razorpayOrderId, amount: bill.bill.amount, currency: 'INR' } } } })
    assert.equal(f.result, 'attempt_failed')
    const page = await api.get(`/v1/farm-bookings/${id}`, { token: cust.accessToken })
    assert.deepEqual([page.body.status, page.body.payment.failed, page.body.payment.razorpayOrderId, page.body.canPay], ['PAYMENT_DUE', true, pay.razorpayOrderId, true])
    assert.equal((await webhook(captured(pay.razorpayOrderId, bill.bill.amount))).result, 'paid')
  })

  test('a corrected bill replaces the open one; paying the old one is refunded in full', async () => {
    const { varietyId } = await setupFarm()
    const { cust, id } = await booked(varietyId)
    const first = await billed(id, { harvestedKg: 310, acceptedKg: 300 })
    const old = await startPay(cust, id)
    const fixed = await staffPost(`${id}/bill`, { acceptedKg: 305 })
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body))
    assert.equal(fixed.body.bill.amount, 305 * 12_000)
    assert.ok(fixed.body.events.some((e) => e.action === 'BILL_REVISED'))
    assert.equal((await staffPost(`${id}/bill`, { acceptedKg: 320 })).body.error.code, 'VALIDATION_ERROR') // more than was picked
    const pay = await startPay(cust, id)
    assert.notEqual(pay.razorpayOrderId, old.razorpayOrderId)
    // The customer pays the old bill in another tab: it does not count, and goes back.
    assert.equal((await webhook(captured(old.razorpayOrderId, first.bill.amount, 'pay_old'))).result, 'refund_due')
    assert.equal((await booking(id)).status, 'PAYMENT_DUE')
    assert.equal((await webhook(captured(pay.razorpayOrderId, 305 * 12_000, 'pay_new'))).result, 'paid')
    await drainBackground()
    await processDueRefunds()
    const r = await one('SELECT * FROM farm_refunds WHERE booking_id = $1', [id])
    assert.deepEqual([r.kind, r.amount, r.payment_id], ['OVERPAID', first.bill.amount, 'pay_old'])
    assert.ok(r.refunded_at)
    const b = await booking(id)
    assert.deepEqual([b.status, b.bill_amount], ['PACKING', 305 * 12_000])
  })

  test('a manager records a bill paid at the farm (confirming it is them); an online payment after that is refunded', async () => {
    const { varietyId } = await setupFarm()
    const { cust, id } = await booked(varietyId)
    const bill = await billed(id)
    const pay = await startPay(cust, id)
    const b0 = await booking(id)
    const body = { method: 'UPI', reference: 'UPI ref 4321', amount: bill.bill.amount, receivedOn: b0.visit_date, note: 'Paid by the group leader' }
    assert.equal((await staffPost(`${id}/record-payment`, body)).body.error.code, 'REAUTH_REQUIRED')
    // Part of the bill, a day in the future or before the group arrived: refused, nothing recorded.
    const part = await staffPost(`${id}/record-payment`, { ...body, amount: bill.bill.amount - 100_00, confirmCode: CONFIRM })
    assert.deepEqual([part.status, part.body.error.code], [409, 'AMOUNT_MISMATCH'])
    const later = await staffPost(`${id}/record-payment`, { ...body, receivedOn: addDays(b0.visit_date, 1), confirmCode: CONFIRM })
    assert.equal(later.body.error.code, 'BAD_PAYMENT_DATE')
    const early = await staffPost(`${id}/record-payment`, { ...body, receivedOn: addDays(b0.arrival_date, -1), confirmCode: CONFIRM })
    assert.equal(early.body.error.code, 'BAD_PAYMENT_DATE')
    assert.equal((await booking(id)).status, 'PAYMENT_DUE')
    const rec = await staffPost(`${id}/record-payment`, { ...body, confirmCode: CONFIRM })
    assert.equal(rec.status, 200, JSON.stringify(rec.body))
    assert.equal(rec.body.status, 'PACKING')
    const p = rec.body.payments.find((x) => x.kind === 'RECORDED')
    assert.deepEqual(
      [p.amount, p.status, p.method, p.reference, p.receivedOn, p.note, p.recordedBy],
      [bill.bill.amount, 'SUCCEEDED', 'UPI', 'UPI ref 4321', b0.visit_date, 'Paid by the group leader', 'manager@mandimangoes.test'],
    )
    const mineNow = await api.get(`/v1/farm-bookings/${id}`, { token: cust.accessToken })
    assert.ok(!JSON.stringify(mineNow.body).includes('group leader'), 'remarks stay with staff')
    assert.equal((await staffPost(`${id}/record-payment`, { ...body, confirmCode: CONFIRM })).body.error.code, 'NOTHING_TO_PAY')
    const mine = await api.get(`/v1/farm-bookings/${id}`, { token: cust.accessToken })
    assert.deepEqual([mine.body.payment.status, mine.body.payment.method], ['PAID', 'UPI'])
    assert.equal((await webhook(captured(pay.razorpayOrderId, bill.bill.amount, 'pay_late'))).result, 'refund_due')
    assert.equal((await one('SELECT kind FROM farm_refunds WHERE booking_id = $1', [id])).kind, 'OVERPAID')
  })

  test('the customer accepts or declines a proposed arrangement; declining lets them cancel at once', async () => {
    const { varietyId } = await setupFarm()
    const { cust, id } = await booked(varietyId)
    await staffPost(`${id}/hospitality`, { action: 'PROPOSE', text: 'Day visit only; the farmhouse is closed for repairs that night.' })
    const no = await api.post(`/v1/farm-bookings/${id}/hospitality`, { accept: false, note: 'We wanted to stay' }, { token: cust.accessToken })
    assert.equal(no.body.hospitality.status, 'CUSTOMER_DECLINED')
    assert.equal(no.body.canCancel, 'CANCEL')
    const second = await booked(varietyId, { visitDate: addDays(VISIT(), 1) })
    await staffPost(`${second.id}/hospitality`, { action: 'PROPOSE', text: 'Tents on the lawn for the group of six.' })
    const yes = await api.post(`/v1/farm-bookings/${second.id}/hospitality`, { accept: true }, { token: second.cust.accessToken })
    assert.deepEqual([yes.body.status, yes.body.hospitality.status], ['CONFIRMED', 'CUSTOMER_ACCEPTED'])
  })
})

// ---------------------------------------------------------------- cancel, move, refunds

describe('cancelling, moving and refunds', () => {
  test('a customer cancelling 7+ days ahead is cancelled at once and the fruit goes back; later it becomes a request a manager decides', async () => {
    const { varietyId } = await setupFarm()
    const { cust, id } = await booked(varietyId)
    const c = await api.post(`/v1/farm-bookings/${id}/cancel`, { reason: 'Plans changed' }, { token: cust.accessToken })
    assert.equal(c.status, 200, JSON.stringify(c.body))
    assert.deepEqual([c.body.requested, c.body.booking.status, c.body.booking.refundStatus, c.body.booking.money.paid], [false, 'CANCELLED', null, 0])
    assert.equal((await harvestRow(varietyId)).reserved_kg, 0)
    assert.equal((await api.get(`/v1/farm-bookings/${id}/qr.svg`, { token: cust.accessToken })).status, 404)
    const late = await booked(varietyId)
    const visiting = await booked(varietyId, { visitDate: addDays(VISIT(), 1) })
    // Within the deadline: a request for the team.
    setNow(new Date(`${addDays(VISIT(), -3)}T05:00:00Z`))
    const r = await api.post(`/v1/farm-bookings/${late.id}/cancel`, { reason: 'Sick' }, { token: late.cust.accessToken })
    assert.deepEqual([r.body.requested, r.body.booking.status, r.body.booking.request.kind], [true, 'HOSPITALITY_REVIEW', 'CANCEL'])
    const done = await staffPost(`${late.id}/cancel`, { reason: 'Customer is unwell; cancelled' })
    assert.equal(done.status, 200, JSON.stringify(done.body))
    assert.equal(done.body.status, 'CANCELLED')
    assert.equal((await one('SELECT COUNT(*)::int AS n FROM farm_refunds')).n, 0)
    // Once at the farm, nobody cancels: the visit is billed or marked otherwise.
    await staffPost(`${visiting.id}/hospitality`, { action: 'APPROVE' })
    await api.post('/admin/v1/farm/check-in', { code: (await booking(visiting.id)).checkin_code, override: true }, as(manager))
    assert.equal((await staffPost(`${visiting.id}/cancel`, { reason: 'Trying to cancel on site' })).body.error.code, 'NOT_CANCELLABLE')
  })

  test('a group that does not come: marked only on or after the visit day, the kilograms go back, nothing to pay or refund', async () => {
    const { varietyId } = await setupFarm()
    const { id } = await booked(varietyId)
    assert.equal((await staffPost(`${id}/hospitality`, { action: 'APPROVE' })).status, 200)
    const b = await booking(id)
    const held = (await harvestRow(varietyId, b.visit_date)).reserved_kg
    assert.equal((await staffPost(`${id}/no-show`, {})).body.error.code, 'TOO_EARLY')
    assert.equal((await staffPost(`${id}/no-show`, {}, await adminToken(api, 'ops@mandimangoes.test', 'operator123'))).status, 403)
    setNow(new Date(`${b.visit_date}T12:00:00Z`))
    const r = await staffPost(`${id}/no-show`, { note: 'No answer on the phone' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.status, 'NO_SHOW')
    assert.equal((await harvestRow(varietyId, b.visit_date)).reserved_kg, held - 300)
    const money = await one('SELECT (SELECT COUNT(*) FROM farm_booking_payments WHERE booking_id = $1)::int AS paid, (SELECT COUNT(*) FROM farm_refunds WHERE booking_id = $1)::int AS refunds', [id])
    assert.deepEqual([money.paid, money.refunds], [0, 0])
  })

  test('a customer moves the visit at once when it is early and the date has fruit', async () => {
    const { varietyId } = await setupFarm()
    const { cust, id } = await booked(varietyId)
    await staffPost(`${id}/hospitality`, { action: 'APPROVE' })
    const m = await api.post(`/v1/farm-bookings/${id}/reschedule`, { date: addDays(VISIT(), 1) }, { token: cust.accessToken })
    assert.equal(m.status, 200, JSON.stringify(m.body))
    assert.deepEqual([m.body.requested, m.body.booking.visitDate, m.body.booking.status], [false, addDays(VISIT(), 1), 'HOSPITALITY_REVIEW'])
    assert.equal((await harvestRow(varietyId)).reserved_kg, 0)
    assert.equal((await harvestRow(varietyId, addDays(VISIT(), 1))).reserved_kg, 300)
  })

  test('a refund that fails at Razorpay is retried; a manager can record one paid another way', async () => {
    const { varietyId } = await setupFarm()
    // A payment for a bill already settled by a manager: refunded through the farm refunds.
    const other = await booked(varietyId, { visitDate: VISIT() })
    const ob = await billed(other.id)
    const op = await startPay(other.cust, other.id)
    await staffPost(`${other.id}/record-payment`, { method: 'CASH', reference: 'Receipt 77', amount: ob.bill.amount, confirmCode: CONFIRM })
    await webhook(captured(op.razorpayOrderId, ob.bill.amount, 'pay_c'))
    await drainBackground()
    await processDueRefunds()
    const refund = await one('SELECT * FROM farm_refunds WHERE booking_id = $1', [other.id])
    assert.ok(refund.refunded_at)
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
    const { id, cust } = await booked(varietyId)
    await staffPost(`${id}/notes`, { body: 'VIP: owner’s friend' })
    const stranger = await customerToken(api)
    assert.equal((await api.get(`/v1/farm-bookings/${id}`, { token: stranger.accessToken })).status, 404)
    assert.equal((await api.post(`/v1/farm-bookings/${id}/cancel`, {}, { token: stranger.accessToken })).status, 404)
    assert.equal((await api.post(`/v1/farm-bookings/${id}/pay`, {}, { token: stranger.accessToken })).status, 404)
    const staff = await api.get(`/admin/v1/farm/bookings/${id}`, as(manager))
    assert.equal(staff.body.notes[0].body, 'VIP: owner’s friend')
    const mine = await api.get(`/v1/farm-bookings/${id}`, { token: cust.accessToken })
    assert.equal(mine.status, 200)
    assert.ok(!JSON.stringify(mine.body).includes('VIP'))
    assert.ok(!JSON.stringify(mine.body).includes('manager@'))
  })

  test('operators run the day and make the bill, but can’t record payments, cancel, move, change prices or settings; packers and QC see nothing', async () => {
    const { varietyId } = await setupFarm()
    const { id } = await booked(varietyId)
    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    assert.equal((await api.get(`/admin/v1/farm/bookings/${id}`, as(ops))).status, 200)
    for (const [m, p, b] of [
      ['POST', `/farm/bookings/${id}/cancel`, { reason: 'trying it' }],
      ['POST', `/farm/bookings/${id}/move`, { date: addDays(VISIT(), 1), reason: 'trying it' }],
      ['POST', `/farm/bookings/${id}/record-payment`, { method: 'CASH', reference: 'trying it' }],
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
    assert.equal((await booking(id)).status, 'HOSPITALITY_REVIEW')
    // The bill is theirs to make on the day.
    assert.equal((await billed(id, { token: ops })).status, 'PAYMENT_DUE')
  })
})

// ---------------------------------------------------------------- reports and messages

describe('reports and messages', () => {
  test('reports count revenue from paid bills only, with conversion and a formula-safe CSV', async () => {
    const { varietyId } = await setupFarm()
    const range = `from=${T()}&to=${addDays(VISIT(), 5)}`
    const { cust, id } = await booked(varietyId, { kg: 400, adults: 2, children: 0 })
    await booked(varietyId, { visitDate: addDays(VISIT(), 1), contactName: '=HYPERLINK("x")' }) // never billed
    const bill = await billed(id, { harvestedKg: 420, acceptedKg: 410 })
    const pay = await startPay(cust, id)
    await webhook(captured(pay.razorpayOrderId, bill.bill.amount))
    const r = await api.get(`/admin/v1/farm/reports?${range}`, as(manager))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual([r.body.bookings, r.body.kgBooked, r.body.kgHarvested, r.body.revenue, r.body.paidBookings], [2, 700, 410, 410 * 12_000, 1])
    assert.deepEqual([r.body.extras.kg, r.body.extras.revenue], [10, 10 * 12_000])
    assert.deepEqual([r.body.conversion.started, r.body.conversion.paid], [2, 1])
    const csv = await api.get(`/admin/v1/farm/reports/bookings.csv?${range}`, as(manager))
    assert.match(csv.body, /'=HYPERLINK/)
    assert.match(csv.body, /bill_rupees/)
  })

  test('with WHATSAPP_FARM_UPDATES on, a booking, its bill and its payment each queue their message once', async () => {
    env.WHATSAPP_FARM_UPDATES = true
    env.FARM_ALERT_PHONES = ['+919811111111']
    const { varietyId } = await setupFarm()
    const cust = await customerToken(api)
    const key = newId('k')
    const b = await book(cust, input(varietyId), key)
    await book(cust, input(varietyId), key) // a retry adds nothing
    const created = (await query('SELECT kind, farm_params FROM notifications WHERE farm_booking_id = $1 ORDER BY kind', [b.body.bookingId])).rows
    assert.deepEqual(created.map((r) => r.kind), ['FARM_BOOKING_UPDATE', 'FARM_TEAM_ALERT'])
    assert.equal(created[0].farm_params.length, 4)
    assert.match(created[0].farm_params[2], /pay after picking/)
    const bill = await billed(b.body.bookingId)
    const pay = await startPay(cust, b.body.bookingId)
    const ev = captured(pay.razorpayOrderId, bill.bill.amount, 'pay_msg')
    await webhook(ev, 'evt_m1')
    await webhook(ev, 'evt_m2')
    const texts = (await query(`SELECT farm_params FROM notifications WHERE farm_booking_id = $1 AND kind = 'FARM_BOOKING_UPDATE' ORDER BY created_at`, [b.body.bookingId])).rows.map((r) => r.farm_params[2])
    assert.equal(texts.filter((t) => /Your bill is/.test(t)).length, 1)
    assert.equal(texts.filter((t) => /received your payment/.test(t)).length, 1)
  })

  test('with it off, nothing is queued (the booking page shows the status)', async () => {
    const { varietyId } = await setupFarm()
    await booked(varietyId)
    assert.equal((await one('SELECT COUNT(*)::int AS n FROM notifications WHERE farm_booking_id IS NOT NULL')).n, 0)
  })
})
