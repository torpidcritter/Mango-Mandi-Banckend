// Farm Experience bookings (docs/farm-experience.md): availability, booking,
// hospitality, the day at the farm, the bill and its payment, cancelling and moving.
//
// Stock: each variety has bookable kilograms per visit date (farm_harvest).
// A booking takes its kilograms with one conditional UPDATE, in the same
// transaction that checks the date, so two customers can never book the same
// fruit. Nothing is paid when booking: after picking, staff weigh the mangoes,
// the bill is made for the kilograms accepted (billFor), and the customer pays
// it online, or a manager records a payment made at the farm. Packing starts
// once it is paid. A customer can hold only settings.maxOpenBookings upcoming
// visits at a time.
//
// Every change writes a farm_booking_events row in the same transaction.
import { randomInt } from 'node:crypto'
import { addDays, diffDays, now, todayIST } from '../clock.js'
import { HttpError, conflict, notFound } from '../errors.js'
import { env } from '../env.js'
import { newId } from '../ids.js'
import { findProduct } from '../products.js'
import {
  BEFORE_VISIT, BOOKING_NUMBER_RE, CHECKIN_FROM, CODE_CHARS, FINAL, MIN_KG, ON_SITE, STATUS_WORDS, TAKES_A_VISIT,
  assertStaffMove, billFor, cancelOption, groupSize, priceFor, rescheduleOption, suggestMealPlan,
} from './rules.js'
import { loadSettings } from './settings.js'
import { queueFarmMessages } from './notify.js'

export const SYSTEM_ACTOR = { kind: 'SYSTEM', label: 'system' }

const code = (n) => Array.from({ length: n }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('')
export const newBookingNumber = () => `MMF-${code(8)}`
export const newCheckinCode = () => code(12)
export { BOOKING_NUMBER_RE }

export const staffActor = (admin) => ({ kind: 'STAFF', label: admin.email, id: admin.id })
export const customerActor = (customerId) => ({ kind: 'CUSTOMER', label: 'customer', id: customerId })

export async function event(c, b, { to = b.status, action, detail = null, actor }) {
  await c.query(
    `INSERT INTO farm_booking_events (id, booking_id, from_status, to_status, action, detail, actor, actor_kind, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [newId('fbe'), b.id, b.status, to, action, detail, actor.label ?? actor.id ?? 'system', actor.kind, now()],
  )
}

/** Sets fields on a booking (and its version and updated_at); returns the new row. */
async function update(c, id, fields) {
  const keys = Object.keys(fields)
  if (!keys.length) return (await c.query('UPDATE farm_bookings SET version = version + 1, updated_at = $2 WHERE id = $1 RETURNING *', [id, now()])).rows[0]
  const { rows } = await c.query(
    `UPDATE farm_bookings SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, version = version + 1, updated_at = $${keys.length + 2}
      WHERE id = $1 RETURNING *`,
    [id, ...keys.map((k) => fields[k]), now()],
  )
  return rows[0]
}

/** Moves a booking to `to`, recording who and why, and queues the customer's update. */
async function move(c, b, to, { action, detail = null, actor, fields = {}, notify = true }) {
  await event(c, b, { to, action, detail, actor })
  const next = await update(c, b.id, { ...fields, status: to })
  if (notify) await queueFarmMessages(c, next, action)
  return next
}

export async function lockBooking(c, id) {
  const { rows } = await c.query('SELECT * FROM farm_bookings WHERE id = $1 FOR UPDATE', [id])
  if (!rows.length) throw notFound('Booking not found')
  return rows[0]
}

export async function getVariety(c, id, { lock = false } = {}) {
  const { rows } = await c.query(`SELECT * FROM farm_varieties WHERE id = $1${lock ? ' FOR SHARE' : ''}`, [id])
  return rows[0] ?? null
}

// ---------------------------------------------------------------- availability

/** The first and last dates a customer may pick today: lead time, how far ahead, and the season. */
export function bookingWindow(settings, today = todayIST()) {
  let from = addDays(today, settings.leadDays)
  let to = addDays(today, settings.maxDaysAhead)
  if (settings.seasonStart && settings.seasonStart > from) from = settings.seasonStart
  if (settings.seasonEnd && settings.seasonEnd < to) to = settings.seasonEnd
  if (!settings.seasonStart || !settings.seasonEnd) return { from, to: addDays(from, -1) } // no season set: nothing is bookable
  return { from, to }
}

/** Bookings counted against a day's visit cap: every booking not cancelled or missed. */
async function visitsOn(c, day, excludeId = null) {
  const { rows } = await c.query(
    `SELECT COUNT(*)::int AS n FROM farm_bookings WHERE visit_date = $1 AND status = ANY($2) AND ($3::text IS NULL OR id <> $3)`,
    [day, TAKES_A_VISIT, excludeId],
  )
  return rows[0].n
}

/**
 * Dates a customer can pick, each with what is left of every active variety.
 * With `varietyId` and `kg`, only dates where that much of it is left.
 */
export async function openDates(c, { varietyId = null, kg = MIN_KG, settings, today = todayIST() }) {
  const w = bookingWindow(settings, today)
  if (w.from > w.to) return []
  const { rows } = await c.query(
    `SELECT d.day, d.max_bookings,
            (SELECT COUNT(*)::int FROM farm_bookings b WHERE b.visit_date = d.day AND b.status = ANY($3)) AS visits,
            COALESCE(json_agg(json_build_object('varietyId', h.variety_id, 'availableKg', h.bookable_kg - h.reserved_kg, 'readiness', h.readiness)
                     ORDER BY v.sort_order, v.name) FILTER (WHERE h.variety_id IS NOT NULL), '[]') AS varieties
       FROM farm_days d
       LEFT JOIN farm_harvest h ON h.day = d.day AND h.bookable_kg > 0
       LEFT JOIN farm_varieties v ON v.id = h.variety_id AND v.active
      WHERE d.open AND d.day BETWEEN $1 AND $2 AND (h.variety_id IS NULL OR v.id IS NOT NULL)
      GROUP BY d.day, d.max_bookings ORDER BY d.day`,
    [w.from, w.to, TAKES_A_VISIT],
  )
  return rows
    .map((r) => ({
      date: r.day,
      visitsLeft: r.max_bookings == null ? null : Math.max(r.max_bookings - r.visits, 0),
      varieties: r.varieties.map((v) => ({ ...v, availableKg: Math.max(v.availableKg, 0) })),
    }))
    .filter((d) => d.visitsLeft !== 0)
    .filter((d) => (varietyId ? d.varieties.some((v) => v.varietyId === varietyId && v.availableKg >= kg) : d.varieties.some((v) => v.availableKg >= MIN_KG)))
}

/** The kilograms of each active variety still bookable over the whole window (for the variety cards). */
export async function varietyAvailability(c, settings, today = todayIST()) {
  const w = bookingWindow(settings, today)
  const { rows } = await c.query(
    `SELECT h.variety_id, COALESCE(SUM(h.bookable_kg - h.reserved_kg) FILTER (WHERE d.open), 0)::int AS available_kg,
            MAX(h.bookable_kg - h.reserved_kg) FILTER (WHERE d.open)::int AS best_day_kg,
            MIN(h.day) FILTER (WHERE d.open AND h.bookable_kg - h.reserved_kg >= $3) AS first_day
       FROM farm_harvest h JOIN farm_days d ON d.day = h.day
      WHERE h.day BETWEEN $1 AND $2 GROUP BY h.variety_id`,
    [w.from, w.to, MIN_KG],
  )
  return new Map(rows.map((r) => [r.variety_id, { availableKg: Math.max(r.available_kg, 0), bestDayKg: Math.max(r.best_day_kg ?? 0, 0), firstDate: r.first_day }]))
}

export function varietyView(v, avail = null) {
  return {
    id: v.id, name: v.name, sku: v.sku, description: v.description, ripenessNote: v.ripeness_note,
    harvestFrom: v.harvest_from, harvestTo: v.harvest_to, pricePerKg: v.price_per_kg,
    tiers: [...(v.tiers ?? [])].sort((a, b) => a.minKg - b.minKg), photoUrl: v.sku ? (findProduct(v.sku)?.photoUrl ?? null) : null,
    ...(avail ? { availableKg: avail.availableKg, bestDayKg: avail.bestDayKg, firstDate: avail.firstDate, available: avail.bestDayKg >= MIN_KG } : {}),
  }
}

/**
 * Checks a visit date for a booking: open, in the window, and under the day's
 * visit cap. Locks the day's row, so two bookings for the last visit queue here.
 */
async function checkDay(c, day, settings, { excludeId = null, today = todayIST(), window = true } = {}) {
  if (window) {
    const w = bookingWindow(settings, today)
    if (day < w.from || day > w.to) {
      throw new HttpError(409, 'FARM_DATE_UNAVAILABLE', 'That visit date can’t be booked. Pick one of the dates shown.', { from: w.from, to: w.to })
    }
  }
  const { rows } = await c.query('SELECT * FROM farm_days WHERE day = $1 FOR UPDATE', [day])
  const d = rows[0]
  if (!d?.open) throw new HttpError(409, 'FARM_DATE_UNAVAILABLE', 'The farm isn’t open for visits on that date. Pick another.', { date: day })
  if (d.max_bookings != null && (await visitsOn(c, day, excludeId)) >= d.max_bookings) {
    throw new HttpError(409, 'FARM_DATE_FULL', 'That date is fully booked. Pick another.', { date: day })
  }
}

/** Takes `kg` of a variety on a day, or returns false when it is not there. */
export async function reserveKg(c, varietyId, day, kg) {
  const r = await c.query(
    `UPDATE farm_harvest SET reserved_kg = reserved_kg + $3 WHERE variety_id = $1 AND day = $2 AND reserved_kg + $3 <= bookable_kg`,
    [varietyId, day, kg],
  )
  return r.rowCount > 0
}

/** Gives a booking's kilograms back, if it holds them. Returns the booking's new row. */
async function releaseKg(c, b) {
  if (!b.kg_reserved) return b
  await c.query('UPDATE farm_harvest SET reserved_kg = GREATEST(reserved_kg - $3, 0) WHERE variety_id = $1 AND day = $2', [b.variety_id, b.visit_date, b.kg])
  return update(c, b.id, { kg_reserved: false })
}

/** Beds at the farmhouse: what the active rooms sleep, extra beds included. */
async function farmhouseBeds(c) {
  const { rows } = await c.query('SELECT COALESCE(SUM(sleeps + extra_beds), 0)::int AS n FROM farm_rooms WHERE active AND NOT maintenance')
  return rows[0].n
}

// ---------------------------------------------------------------- booking

/**
 * Creates a booking and takes its kilograms: everything checked on the server,
 * nothing taken from the shop but the choices. Nothing is paid now: the stay
 * goes to our team to arrange, and the bill comes after picking.
 */
export async function createBooking(c, { customerId, input, today = todayIST() }) {
  const { settings } = await loadSettings(c)
  if (!settings.bookingsOpen) throw new HttpError(409, 'FARM_BOOKINGS_CLOSED', 'Farm Experience bookings aren’t open yet.')
  const v = await getVariety(c, input.varietyId, { lock: true })
  if (!v?.active) throw new HttpError(409, 'FARM_VARIETY_UNAVAILABLE', 'That variety isn’t available for farm visits. Pick another.')
  const price = priceFor(v, input.kg)
  // Nothing is paid up front, so one customer can hold only a few upcoming visits (and a day's fruit) at a time.
  await c.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [customerId])
  const open = await c.query(`SELECT number FROM farm_bookings WHERE customer_id = $1 AND status = ANY($2) ORDER BY visit_date`, [customerId, BEFORE_VISIT])
  if (open.rows.length >= settings.maxOpenBookings) {
    throw new HttpError(409, 'TOO_MANY_FARM_BOOKINGS', `You already have ${open.rows.length} upcoming farm visit${open.rows.length === 1 ? '' : 's'} (${open.rows.map((r) => r.number).join(', ')}). Cancel one or wait until after your visit to book another.`, {
      open: open.rows.length, max: settings.maxOpenBookings,
    })
  }
  await checkDay(c, input.visitDate, settings, { today })
  if (!(await reserveKg(c, v.id, input.visitDate, input.kg))) {
    const { rows } = await c.query('SELECT GREATEST(bookable_kg - reserved_kg, 0)::int AS left FROM farm_harvest WHERE variety_id = $1 AND day = $2', [v.id, input.visitDate])
    const left = rows[0]?.left ?? 0
    throw new HttpError(409, 'FARM_NOT_ENOUGH_HARVEST', left >= MIN_KG
      ? `Only ${left} kg of ${v.name} is left for that date. Book ${left} kg or less, or pick another date.`
      : `${v.name} is fully booked for that date. Pick another date or variety.`, { availableKg: left })
  }
  const beds = await farmhouseBeds(c)
  const at = now()
  const { rows } = await c.query(
    `INSERT INTO farm_bookings (id, number, customer_id, variety_id, variety_name, kg, price_per_kg, total, pricing, visit_date, arrival_date, departure_date,
        adults, children, overnight_guests, food, accessibility, customer_notes, guest_list, contact_name, contact_phone, contact_email, billing_name, billing_gstin,
        status, kg_reserved, over_capacity, checkin_code, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
        'HOSPITALITY_REVIEW', TRUE, $25, $26, $27, $27) RETURNING *`,
    [
      newId('fbk'), newBookingNumber(), customerId, v.id, v.name, input.kg, price.pricePerKg, price.total,
      JSON.stringify({ basePricePerKg: v.price_per_kg, tier: price.tier, varietyVersion: v.version }),
      input.visitDate, input.arrivalDate, input.departureDate, input.adults, input.children, input.overnightGuests,
      JSON.stringify(input.food ?? {}), input.accessibility || null, input.notes || null, JSON.stringify(input.guestList ?? []),
      input.contactName, input.contactPhone, input.contactEmail || null, input.billingName || null, input.billingGstin || null,
      input.overnightGuests > beds, newCheckinCode(), at,
    ],
  )
  const b = rows[0]
  await event(c, { ...b, status: null }, { to: b.status, action: 'CREATED', detail: `${b.kg} kg of ${b.variety_name} for ${b.visit_date}`, actor: customerActor(customerId) })
  await queueFarmMessages(c, b, 'CREATED')
  await queueFarmMessages(c, b, 'TEAM_NEW_BOOKING')
  return b
}

// ---------------------------------------------------------------- payments

/**
 * Applies one Razorpay payment result to a bill payment, once however often it
 * comes (webhook, reconcile, the page asking). The amount was checked already
 * (checkCapture). Returns { result, bookingId }: paid, refund_due,
 * duplicate_payment, already_paid, attempt_failed, cancelled, ignored.
 */
export async function processFarmPayment(c, { farmPaymentId, outcome, paymentId = null, method = null, amount = null }) {
  const { rows } = await c.query('SELECT * FROM farm_booking_payments WHERE id = $1 FOR UPDATE', [farmPaymentId])
  const p = rows[0]
  if (!p) return { result: 'ignored' }
  let b = await lockBooking(c, p.booking_id)
  if (p.status === 'SUCCEEDED') {
    if (outcome === 'captured' && paymentId && p.payment_id && paymentId !== p.payment_id) {
      const ins = await c.query(
        'INSERT INTO duplicate_payments (payment_id, amount, found_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [paymentId, amount, now()],
      )
      if (ins.rowCount) {
        await event(c, b, { action: 'DUPLICATE_PAYMENT', detail: `A second payment (${paymentId}) was taken; it is being refunded`, actor: SYSTEM_ACTOR })
        return { result: 'duplicate_payment', bookingId: b.id }
      }
    }
    return { result: 'already_paid', bookingId: b.id }
  }
  if (outcome === 'failed') {
    await c.query('UPDATE farm_booking_payments SET last_failure = $2 WHERE id = $1', [p.id, now().toISOString()])
    await event(c, b, { action: 'PAYMENT_FAILED', detail: 'A payment attempt failed; the customer can try again', actor: SYSTEM_ACTOR })
    return { result: 'attempt_failed', bookingId: b.id }
  }
  if (outcome === 'abandoned') {
    if (p.status !== 'INITIATED') return { result: 'ignored', bookingId: b.id }
    await c.query(`UPDATE farm_booking_payments SET status = 'CANCELLED' WHERE id = $1`, [p.id])
    return { result: 'cancelled', bookingId: b.id }
  }
  // Captured.
  await c.query(
    `UPDATE farm_booking_payments SET status = 'SUCCEEDED', payment_id = $2, payment_method = $3, paid_at = $4 WHERE id = $1`,
    [p.id, paymentId, method, now()],
  )
  const paid = `Payment ${paymentId ?? ''} received`.trim()
  if (b.status === 'PAYMENT_DUE' && !b.paid_at && p.status === 'INITIATED' && p.amount === b.bill_amount) {
    b = await move(c, b, 'PACKING', { action: 'PAID', detail: paid, actor: SYSTEM_ACTOR, fields: { paid_at: now() } })
    await c.query(`UPDATE farm_booking_payments SET status = 'CANCELLED' WHERE booking_id = $1 AND status = 'INITIATED'`, [b.id])
    return { result: 'paid', bookingId: b.id }
  }
  // Paid already (a manager recorded it, or another try went through), or for a bill since replaced: it all goes back.
  await requestRefunds(c, b, { kind: 'OVERPAID', reason: 'Paid again for a bill already paid or replaced', actor: SYSTEM_ACTOR, farmPaymentId: p.id })
  await event(c, b, { action: 'OVERPAID_REFUND', detail: `${paid}, but the bill was already paid or replaced; refunding it in full`, actor: SYSTEM_ACTOR })
  return { result: 'refund_due', bookingId: b.id }
}

// ---------------------------------------------------------------- refunds

/**
 * Queues refunds for a booking: every successful payment (or only `farmPaymentId`)
 * gets back what is still unrefunded on it, or `amount` when given (a shortfall).
 * The maintenance loop and the request after it send them (farm/refunds.js).
 * Returns the refund rows.
 */
export async function requestRefunds(c, b, { kind, reason, actor, amount = null, farmPaymentId = null }) {
  const { rows: pays } = await c.query(
    `SELECT p.*, COALESCE((SELECT SUM(r.amount) FROM farm_refunds r WHERE r.farm_payment_id = p.id), 0)::int AS refunded
       FROM farm_booking_payments p WHERE p.booking_id = $1 AND p.status = 'SUCCEEDED' AND ($2::text IS NULL OR p.id = $2) ORDER BY p.created_at FOR UPDATE OF p`,
    [b.id, farmPaymentId],
  )
  const out = []
  for (const p of pays) {
    const left = p.amount - p.refunded
    const take = amount == null ? left : Math.min(amount, left)
    if (take <= 0) continue
    const { rows } = await c.query(
      `INSERT INTO farm_refunds (id, booking_id, farm_payment_id, payment_id, amount, kind, reason, requested_by, requested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [newId('frf'), b.id, p.id, p.payment_id, take, kind, reason, actor.label ?? 'system', now()],
    )
    out.push(rows[0])
    if (amount != null) break
  }
  return out
}

/** What has been paid and refunded on a booking, in paise. */
export async function moneyOf(c, bookingId) {
  const { rows } = await c.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'SUCCEEDED'), 0)::int AS paid,
            (SELECT COALESCE(SUM(amount), 0)::int FROM farm_refunds WHERE booking_id = $1) AS refunded,
            (SELECT COALESCE(SUM(amount), 0)::int FROM farm_refunds WHERE booking_id = $1 AND refunded_at IS NOT NULL) AS refund_sent
       FROM farm_booking_payments WHERE booking_id = $1`,
    [bookingId],
  )
  return rows[0]
}

// ---------------------------------------------------------------- cancel and move

/** Cancels a booking before the visit: its kilograms go back. Nothing was paid, so nothing is refunded. */
export async function cancelBooking(c, b, { reason, actor }) {
  if (!BEFORE_VISIT.includes(b.status)) {
    throw conflict(ON_SITE.includes(b.status) ? 'This visit has started, so it can’t be cancelled.' : 'This booking is already closed.', 'NOT_CANCELLABLE')
  }
  let next = await releaseKg(c, b)
  next = await move(c, next, 'CANCELLED', {
    action: 'CANCELLED', detail: reason, actor,
    fields: { cancelled_at: now(), cancel_reason: reason, request_kind: null, request_date: null, request_note: null, requested_at: null },
  })
  return { booking: next }
}

/**
 * Moves a booking's visit to `day`, keeping the length of the stay. Its kilograms
 * move with it (taken on the new day before being given back on the old one, so a
 * failure leaves it as it was). Rooms are given up and the stay goes back to review.
 */
export async function moveVisit(c, b, day, { actor, reason, window = true }) {
  if (!BEFORE_VISIT.includes(b.status)) throw conflict('Only a booking whose visit hasn’t started can be moved.', 'NOT_MOVABLE')
  if (day === b.visit_date) throw conflict('That is already the visit date.', 'SAME_DATE')
  const { settings } = await loadSettings(c)
  await checkDay(c, day, settings, { excludeId: b.id, window })
  if (!(await reserveKg(c, b.variety_id, day, b.kg))) {
    throw new HttpError(409, 'FARM_NOT_ENOUGH_HARVEST', `There isn’t ${b.kg} kg of ${b.variety_name} free on that date. Pick another.`)
  }
  if (b.kg_reserved) await c.query('UPDATE farm_harvest SET reserved_kg = GREATEST(reserved_kg - $3, 0) WHERE variety_id = $1 AND day = $2', [b.variety_id, b.visit_date, b.kg])
  const shift = diffDays(day, b.visit_date)
  await c.query('DELETE FROM farm_room_allocations WHERE booking_id = $1', [b.id])
  return move(c, b, 'HOSPITALITY_REVIEW', {
    action: 'MOVED', detail: `Visit moved from ${b.visit_date} to ${day}${reason ? `: ${reason}` : ''}`, actor,
    fields: {
      visit_date: day, arrival_date: addDays(b.arrival_date, shift), departure_date: addDays(b.departure_date, shift), kg_reserved: true,
      hospitality_status: 'PENDING', meal_plan: '[]',
      request_kind: null, request_date: null, request_note: null, requested_at: null,
    },
  })
}

/** A customer asks to cancel or move; a manager decides. */
export async function recordRequest(c, b, { kind, date = null, note, customerId }) {
  if (b.request_kind) throw conflict('You already have a request waiting for our team.', 'REQUEST_PENDING')
  await event(c, b, { action: kind === 'CANCEL' ? 'CANCEL_REQUESTED' : 'MOVE_REQUESTED', detail: `${date ? `New date ${date}. ` : ''}${note ?? ''}`.trim() || null, actor: customerActor(customerId) })
  const next = await update(c, b.id, { request_kind: kind, request_date: date, request_note: note || null, requested_at: now() })
  await queueFarmMessages(c, next, 'TEAM_REQUEST')
  return next
}

/** The customer cancels. Returns { booking, requested }. */
export async function customerCancel(c, b, { reason, customerId, today = todayIST() }) {
  const { settings } = await loadSettings(c)
  const option = cancelOptionFor(b, settings, today)
  const actor = customerActor(customerId)
  if (!option) throw conflict('This booking can no longer be cancelled.', 'NOT_CANCELLABLE')
  if (option === 'REQUEST') return { booking: await recordRequest(c, b, { kind: 'CANCEL', note: reason, customerId }), requested: true }
  const why = reason ? `Cancelled by the customer: ${reason}` : 'Cancelled by the customer'
  const r = await cancelBooking(c, b, { reason: why, actor })
  return { ...r, requested: false }
}

/**
 * cancelOption, plus: when we could not keep the stay as agreed (we proposed
 * changing it), the customer may always cancel at once.
 */
export function cancelOptionFor(b, settings, today) {
  const o = cancelOption(b, settings, today)
  if (!o) return o
  if (['ALTERNATIVE_PROPOSED', 'CUSTOMER_DECLINED'].includes(b.hospitality_status) && ['HOSPITALITY_REVIEW', 'CONFIRMED'].includes(b.status)) return 'CANCEL'
  return o
}

/** The customer moves the visit (at once when allowed and the date has room, else a request). */
export async function customerMove(c, b, { date, note, customerId, today = todayIST() }) {
  const { settings } = await loadSettings(c)
  const option = rescheduleOption(b, settings, today)
  if (!option) throw conflict('This visit can no longer be moved.', 'NOT_MOVABLE')
  if (option === 'REQUEST') return { booking: await recordRequest(c, b, { kind: 'RESCHEDULE', date, note, customerId }), requested: true }
  return { booking: await moveVisit(c, b, date, { actor: customerActor(customerId), reason: note }), requested: false }
}

// ---------------------------------------------------------------- hospitality

export async function approveHospitality(c, b, { plan, actor }) {
  if (b.status !== 'HOSPITALITY_REVIEW') throw conflict('Only a booking waiting for its stay to be arranged can be approved.', 'BAD_STATUS_MOVE')
  if (b.over_capacity && !(await allocatedBeds(c, b.id)) && !plan?.trim()) {
    throw new HttpError(409, 'HOSPITALITY_PLAN_REQUIRED', 'This group is larger than the farmhouse. Give rooms or write the arrangement before approving.')
  }
  const meal = b.meal_plan?.length ? b.meal_plan : await defaultMealPlan(c, b)
  return move(c, b, 'CONFIRMED', {
    action: 'HOSPITALITY_APPROVED', detail: plan?.trim() || null, actor,
    fields: { hospitality_status: 'APPROVED', hospitality_plan: plan?.trim() || b.hospitality_plan, meal_plan: JSON.stringify(meal) },
  })
}

export function proposeAlternative(c, b, { proposal, actor }) {
  if (!['HOSPITALITY_REVIEW', 'CONFIRMED', 'PREPARING', 'READY_FOR_VISIT'].includes(b.status)) throw conflict('Arrangements can only be changed before the visit.', 'BAD_STATUS_MOVE')
  return move(c, b, 'HOSPITALITY_REVIEW', {
    action: 'ALTERNATIVE_PROPOSED', detail: proposal, actor, fields: { hospitality_status: 'ALTERNATIVE_PROPOSED', alternative_proposal: proposal },
  })
}

/** The customer answers a proposed arrangement. Accepting confirms the booking; declining leaves it for the team (and cancelling open). */
export async function answerAlternative(c, b, { accept, note, customerId }) {
  if (b.hospitality_status !== 'ALTERNATIVE_PROPOSED' || b.status !== 'HOSPITALITY_REVIEW') throw conflict('There is no proposed arrangement to answer.', 'NOTHING_TO_ANSWER')
  const actor = customerActor(customerId)
  if (accept) {
    const meal = b.meal_plan?.length ? b.meal_plan : await defaultMealPlan(c, b)
    return move(c, b, 'CONFIRMED', {
      action: 'ALTERNATIVE_ACCEPTED', detail: note || null, actor,
      fields: { hospitality_status: 'CUSTOMER_ACCEPTED', hospitality_plan: b.alternative_proposal, meal_plan: JSON.stringify(meal) },
    })
  }
  const next = await move(c, b, 'HOSPITALITY_REVIEW', { action: 'ALTERNATIVE_DECLINED', detail: note || null, actor, fields: { hospitality_status: 'CUSTOMER_DECLINED' } })
  await queueFarmMessages(c, next, 'TEAM_DECLINED')
  return next
}

async function allocatedBeds(c, bookingId) {
  const { rows } = await c.query('SELECT COALESCE(SUM(guests), 0)::int AS n FROM farm_room_allocations WHERE booking_id = $1', [bookingId])
  return rows[0].n
}

export async function defaultMealPlan(c, b) {
  const { settings } = await loadSettings(c)
  return suggestMealPlan({ arrival: b.arrival_date, departure: b.departure_date, guests: groupSize(b), meals: settings.meals })
}

/**
 * Gives rooms to a booking (replacing what it had). A room already given to
 * another open booking for any of the same nights is refused, as is one out of
 * use. Rooms are locked in id order, so two allocations can't cross.
 */
export async function allocateRooms(c, b, allocations, { actor }) {
  if (FINAL.includes(b.status)) throw conflict('Rooms can be given only to an open booking.', 'BAD_STATUS_MOVE')
  const ids = [...new Set(allocations.map((a) => a.roomId))].sort()
  if (ids.length !== allocations.length) throw new HttpError(400, 'VALIDATION_ERROR', 'Each room can be listed once.')
  const { rows: rooms } = ids.length ? await c.query('SELECT * FROM farm_rooms WHERE id = ANY($1) ORDER BY id FOR UPDATE', [ids]) : { rows: [] }
  for (const a of allocations) {
    const r = rooms.find((x) => x.id === a.roomId)
    if (!r || !r.active) throw new HttpError(409, 'ROOM_UNAVAILABLE', 'One of the rooms no longer exists.')
    if (r.maintenance) throw new HttpError(409, 'ROOM_UNAVAILABLE', `${r.name} is out of use for maintenance.`)
    if (a.fromDate >= a.toDate) throw new HttpError(400, 'VALIDATION_ERROR', 'A room’s last night must be after its first.')
    const clash = await c.query(
      `SELECT fb.number FROM farm_room_allocations a JOIN farm_bookings fb ON fb.id = a.booking_id
        WHERE a.room_id = $1 AND a.booking_id <> $2 AND a.from_date < $4 AND $3 < a.to_date AND NOT (fb.status = ANY($5)) LIMIT 1`,
      [a.roomId, b.id, a.fromDate, a.toDate, ['CANCELLED', 'NO_SHOW', 'COMPLETED']],
    )
    if (clash.rows.length) throw new HttpError(409, 'ROOM_TAKEN', `${r.name} is already given to ${clash.rows[0].number} for some of those nights.`)
  }
  await c.query('DELETE FROM farm_room_allocations WHERE booking_id = $1', [b.id])
  for (const a of allocations) {
    await c.query(
      `INSERT INTO farm_room_allocations (booking_id, room_id, from_date, to_date, guests, extra_beds, note, created_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [b.id, a.roomId, a.fromDate, a.toDate, a.guests, a.extraBeds ?? 0, a.note || null, now(), actor.label],
    )
  }
  await event(c, b, { action: 'ROOMS_ALLOCATED', detail: allocations.map((a) => `${rooms.find((r) => r.id === a.roomId).name}: ${a.guests} guests, ${a.fromDate} to ${a.toDate}`).join('; ') || 'Rooms cleared', actor })
  return update(c, b.id, {})
}

// ---------------------------------------------------------------- the day at the farm

export function staffMove(c, b, to, { actor, note }) {
  assertStaffMove(b.status, to)
  const fields = {}
  if (to === 'COMPLETED') {
    if (!b.paid_at) throw conflict('The bill isn’t paid yet.', 'NOT_PAID')
    if (!['PACKED', 'COLLECTED'].includes(b.packing_status)) throw conflict('Record the mangoes as packed or collected first.', 'NOT_PACKED')
    fields.completed_at = now()
    fields.harvest_status = 'DONE'
  }
  if (to === 'HARVESTING') fields.harvest_status = 'IN_PROGRESS'
  return move(c, b, to, { action: `TO_${to}`, detail: note || null, actor, fields })
}

/** Farm staff check a booking in by its QR code or reference, on its stay's days (a manager may override). */
export function checkIn(c, b, { actor, override = false, today = todayIST() }) {
  if (ON_SITE.includes(b.status)) throw new HttpError(409, 'ALREADY_CHECKED_IN', `Already checked in (${STATUS_WORDS[b.status].toLowerCase()}).`)
  if (!CHECKIN_FROM.includes(b.status)) throw new HttpError(409, 'NOT_CHECKABLE', `This booking is ${STATUS_WORDS[b.status].toLowerCase()}, so it can’t be checked in.`, { status: b.status })
  if (!override && (today < b.arrival_date || today > b.departure_date)) {
    throw new HttpError(409, 'NOT_VISIT_DAY', `This booking is for ${b.arrival_date} to ${b.departure_date}, not today.`, { arrivalDate: b.arrival_date, departureDate: b.departure_date })
  }
  return move(c, b, 'CHECKED_IN', { action: 'CHECKED_IN', detail: override ? 'Checked in outside the booked days (manager override)' : null, actor, fields: { checked_in_at: now(), checked_in_by: actor.label } })
}

/** Weights and progress on the day. Allowed only at the farm; the weights only until the bill is made. */
export async function recordHarvest(c, b, f, { actor }) {
  if (!ON_SITE.includes(b.status) || b.status === 'COMPLETED') throw conflict('Harvest details are recorded once the customer is checked in.', 'NOT_ON_SITE')
  if ((f.acceptedKg !== undefined || f.harvestedKg !== undefined) && ['PAYMENT_DUE', 'PACKING'].includes(b.status)) {
    throw conflict('The bill is made from these weights. To change them, make a new bill with the right weight.', 'BILL_MADE')
  }
  const fields = {}
  if (f.harvestedKg !== undefined) fields.harvested_kg = f.harvestedKg
  if (f.acceptedKg !== undefined) fields.accepted_kg = f.acceptedKg
  if (f.inspectionNote !== undefined) fields.inspection_note = f.inspectionNote || null
  if (f.harvestStatus !== undefined) fields.harvest_status = f.harvestStatus
  if (f.packingStatus !== undefined) fields.packing_status = f.packingStatus
  const acc = fields.accepted_kg ?? b.accepted_kg
  const har = fields.harvested_kg ?? b.harvested_kg
  if (acc != null && har != null && Number(acc) > Number(har)) throw new HttpError(400, 'VALIDATION_ERROR', 'The accepted weight can’t be more than what was picked.')
  const parts = Object.entries(f).filter(([, v]) => v !== undefined).map(([k, v]) => `${k} ${v}`)
  await event(c, b, { action: 'HARVEST_UPDATED', detail: parts.join(', ') || null, actor })
  return update(c, b.id, fields)
}

/**
 * The bill after weighing: from WEIGHING (or again while PAYMENT_DUE and unpaid,
 * e.g. with a corrected weight). An open online payment for an older bill is
 * cancelled; if it is paid anyway, it is refunded (processFarmPayment).
 */
export async function issueBill(c, b, { acceptedKg, actor }) {
  if (!['WEIGHING', 'PAYMENT_DUE'].includes(b.status)) throw conflict('The bill is made after weighing.', 'BAD_STATUS_MOVE')
  if (b.paid_at) throw conflict('This booking is already paid.', 'ALREADY_PAID')
  const accepted = acceptedKg ?? (b.accepted_kg == null ? null : Number(b.accepted_kg))
  if (accepted == null) throw conflict('Record the accepted weight first.', 'NOT_WEIGHED')
  if (b.harvested_kg != null && accepted > Number(b.harvested_kg)) throw new HttpError(400, 'VALIDATION_ERROR', 'The accepted weight can’t be more than what was picked.')
  const { settings } = await loadSettings(c)
  const bill = billFor(b, accepted, settings.extraPricePerKg)
  await c.query(`UPDATE farm_booking_payments SET status = 'CANCELLED' WHERE booking_id = $1 AND status = 'INITIATED'`, [b.id])
  await c.query(`INSERT INTO farm_booking_payments (id, booking_id, kind, amount, status, created_at) VALUES ($1, $2, 'ONLINE', $3, 'INITIATED', $4)`, [newId('fbp'), b.id, bill.amount, now()])
  const words = `${bill.acceptedKg} kg accepted: ${bill.bookedPartKg} kg at ${bill.pricePerKg / 100} rupees${bill.extraKg ? ` and ${bill.extraKg} kg extra at ${bill.extraPricePerKg / 100} rupees` : ''} = ${bill.amount / 100} rupees`
  return move(c, b, 'PAYMENT_DUE', {
    action: b.status === 'PAYMENT_DUE' ? 'BILL_REVISED' : 'BILL_ISSUED', detail: words, actor,
    fields: { accepted_kg: accepted, bill: JSON.stringify(bill), bill_amount: bill.amount, billed_at: now() },
  })
}

/** The open online payment for a bill (made again if an earlier try could not start). */
export async function billPayment(c, b) {
  if (b.status !== 'PAYMENT_DUE' || b.paid_at) throw conflict('There is nothing to pay on this booking now.', 'NOTHING_TO_PAY')
  const { rows } = await c.query(`SELECT * FROM farm_booking_payments WHERE booking_id = $1 AND kind = 'ONLINE' AND status = 'INITIATED' ORDER BY created_at DESC LIMIT 1`, [b.id])
  if (rows[0]) return rows[0]
  const ins = await c.query(
    `INSERT INTO farm_booking_payments (id, booking_id, kind, amount, status, created_at) VALUES ($1, $2, 'ONLINE', $3, 'INITIATED', $4) RETURNING *`,
    [newId('fbp'), b.id, b.bill_amount, now()],
  )
  return ins.rows[0]
}

/** A manager records that the customer paid the bill another way at the farm (UPI to the farm, card machine, cash). */
export async function recordPayment(c, b, { method, reference, amount, receivedOn = todayIST(), note = null, actor, today = todayIST() }) {
  if (b.status !== 'PAYMENT_DUE' || b.paid_at) throw conflict('There is no unpaid bill on this booking.', 'NOTHING_TO_PAY')
  // Only the full bill pays it: packing never starts on part of the money.
  if (amount !== b.bill_amount) {
    throw conflict(`The bill is ${b.bill_amount / 100} rupees. Record the payment only once the full bill is in.`, 'AMOUNT_MISMATCH')
  }
  if (receivedOn > today) throw conflict('The payment date can’t be in the future.', 'BAD_PAYMENT_DATE')
  // The group pays at the farm, so not before they arrived (or were checked in early).
  const earliest = b.checked_in_at ? [todayIST(b.checked_in_at), b.arrival_date].sort()[0] : b.arrival_date
  if (receivedOn < earliest) throw conflict('The payment date can’t be before the group arrived.', 'BAD_PAYMENT_DATE')
  await c.query(`UPDATE farm_booking_payments SET status = 'CANCELLED' WHERE booking_id = $1 AND status = 'INITIATED'`, [b.id])
  await c.query(
    `INSERT INTO farm_booking_payments (id, booking_id, kind, amount, status, payment_method, reference, received_on, note, recorded_by, created_at, paid_at)
     VALUES ($1, $2, 'RECORDED', $3, 'SUCCEEDED', $4, $5, $6, $7, $8, $9, $9)`,
    [newId('fbp'), b.id, b.bill_amount, method, reference, receivedOn, note, actor.label, now()],
  )
  const how = `${b.bill_amount / 100} rupees paid by ${method.toLowerCase().replace(/_/g, ' ')} on ${receivedOn} (${reference}), recorded by staff`
  return move(c, b, 'PACKING', { action: 'PAID', detail: how, actor, fields: { paid_at: now() } })
}

export async function markNoShow(c, b, { actor, note, today = todayIST() }) {
  if (!CHECKIN_FROM.includes(b.status)) throw conflict('Only a confirmed booking can be marked as missed.', 'BAD_STATUS_MOVE')
  if (today < b.visit_date) throw conflict('A visit can be marked as missed only on or after its date.', 'TOO_EARLY')
  const next = await releaseKg(c, b)
  return move(c, next, 'NO_SHOW', { action: 'NO_SHOW', detail: note || null, actor })
}

/** A manager resolves a NEEDS_ATTENTION booking by moving it, or a customer's request (cancel or move). */
export async function declineRequest(c, b, { reason, actor }) {
  if (!b.request_kind) throw conflict('There is no request on this booking.', 'NO_REQUEST')
  await event(c, b, { action: 'REQUEST_DECLINED', detail: reason, actor })
  const next = await update(c, b.id, { request_kind: null, request_date: null, request_note: null, requested_at: null })
  await queueFarmMessages(c, next, 'REQUEST_DECLINED')
  return next
}

// ---------------------------------------------------------------- views

/** Each step the customer sees: what happened and when, never which staff member. */
const CUSTOMER_STEPS = new Set([
  'CREATED', 'HOSPITALITY_APPROVED', 'ALTERNATIVE_PROPOSED', 'ALTERNATIVE_ACCEPTED', 'ALTERNATIVE_DECLINED', 'MOVED',
  'CANCEL_REQUESTED', 'MOVE_REQUESTED', 'REQUEST_DECLINED', 'CANCELLED', 'TO_PREPARING', 'TO_READY_FOR_VISIT', 'CHECKED_IN', 'TO_HARVESTING',
  'TO_WEIGHING', 'BILL_ISSUED', 'BILL_REVISED', 'PAID', 'TO_COMPLETED', 'NO_SHOW', 'OVERPAID_REFUND',
])

async function parts(c, b) {
  const [payments, refunds, rooms, events] = await Promise.all([
    c.query('SELECT * FROM farm_booking_payments WHERE booking_id = $1 ORDER BY created_at', [b.id]),
    c.query('SELECT * FROM farm_refunds WHERE booking_id = $1 ORDER BY requested_at', [b.id]),
    c.query(
      `SELECT a.*, r.name, r.description FROM farm_room_allocations a JOIN farm_rooms r ON r.id = a.room_id WHERE a.booking_id = $1 ORDER BY r.sort_order, r.name`,
      [b.id],
    ),
    c.query('SELECT * FROM farm_booking_events WHERE booking_id = $1 ORDER BY created_at, id', [b.id]),
  ])
  return { payments: payments.rows, refunds: refunds.rows, rooms: rooms.rows, events: events.rows }
}

const refundView = (r) => ({
  id: r.id, amount: r.amount, kind: r.kind, reason: r.reason, requestedAt: r.requested_at,
  status: r.refunded_at ? (r.refund_status === 'processed' ? 'REFUNDED' : 'SENT') : r.refund_gave_up_at ? 'NEEDS_A_MANAGER' : 'PENDING',
  refundedAt: r.refunded_at,
})
const guestsView = (b) => ({
  adults: b.adults, children: b.children, total: groupSize(b), overnight: b.overnight_guests, arrivalDate: b.arrival_date, departureDate: b.departure_date,
  food: b.food ?? {}, accessibility: b.accessibility, notes: b.customer_notes, list: b.guest_list ?? [],
})

function common(b, p) {
  const refunded = p.refunds.reduce((s, r) => s + r.amount, 0)
  const paid = p.payments.filter((x) => x.status === 'SUCCEEDED').reduce((s, x) => s + x.amount, 0)
  const refundState = !p.refunds.length ? null : p.refunds.every((r) => r.refunded_at) ? 'REFUNDED' : 'REFUND_PENDING'
  return {
    id: b.id, number: b.number, status: b.status, statusLabel: STATUS_WORDS[b.status], refundStatus: refundState,
    // total: the estimate at booking. bill: what is owed after weighing (null until then).
    variety: { id: b.variety_id, name: b.variety_name }, kg: b.kg, pricePerKg: b.price_per_kg, total: b.total,
    bill: b.bill ? { ...b.bill, at: b.billed_at } : null,
    visitDate: b.visit_date, guests: guestsView(b),
    contact: { name: b.contact_name, phone: b.contact_phone, email: b.contact_email },
    billing: b.billing_name || b.billing_gstin ? { name: b.billing_name, gstin: b.billing_gstin } : null,
    hospitality: {
      status: b.hospitality_status, plan: b.hospitality_plan, alternative: b.alternative_proposal, overCapacity: b.over_capacity,
      rooms: p.rooms.map((r) => ({ roomId: r.room_id, name: r.name, fromDate: r.from_date, toDate: r.to_date, guests: r.guests, extraBeds: r.extra_beds, note: r.note })),
      mealPlan: b.meal_plan ?? [],
    },
    harvest: {
      status: b.harvest_status, harvestedKg: b.harvested_kg == null ? null : Number(b.harvested_kg), acceptedKg: b.accepted_kg == null ? null : Number(b.accepted_kg),
      inspectionNote: b.inspection_note, packingStatus: b.packing_status,
    },
    money: { paid, refunded, refunds: p.refunds.map(refundView) },
    request: b.request_kind ? { kind: b.request_kind, date: b.request_date, note: b.request_note, at: b.requested_at } : null,
    paidAt: b.paid_at, cancelledAt: b.cancelled_at, cancelReason: b.cancel_reason, completedAt: b.completed_at, checkedInAt: b.checked_in_at,
    createdAt: b.created_at, updatedAt: b.updated_at, version: b.version,
  }
}

/** The customer's view: no staff notes, staff names or internal reasons. */
export async function customerView(c, b, { today = todayIST() } = {}) {
  const p = await parts(c, b)
  const { settings } = await loadSettings(c)
  const open = [...p.payments].reverse().find((x) => x.kind === 'ONLINE' && x.status === 'INITIATED')
  const done = p.payments.find((x) => x.status === 'SUCCEEDED')
  return {
    ...common(b, p),
    // The QR and its code while the booking is open (before and during the visit).
    checkinCode: !FINAL.includes(b.status) ? b.checkin_code : null,
    payment: b.status === 'PAYMENT_DUE' && open
      ? { status: 'DUE', amount: open.amount, razorpayOrderId: open.razorpay_order_id, failed: Boolean(open.last_failure) }
      : done ? { status: 'PAID', amount: done.amount, paidAt: done.paid_at, method: done.kind === 'RECORDED' ? done.payment_method : 'ONLINE' } : null,
    razorpayKeyId: env.RAZORPAY_KEY_ID || null,
    canPay: b.status === 'PAYMENT_DUE' && !b.paid_at,
    canCancel: cancelOptionFor(b, settings, today),
    canMove: rescheduleOption(b, settings, today),
    steps: p.events.filter((e) => CUSTOMER_STEPS.has(e.action)).map((e) => ({
      action: e.action, status: e.to_status, at: e.created_at,
      // Customers see the words of what was proposed or why something moved, not internal reasons.
      detail: ['ALTERNATIVE_PROPOSED', 'MOVED', 'HOSPITALITY_APPROVED', 'REQUEST_DECLINED'].includes(e.action) ? e.detail : null,
    })),
    farm: {
      name: settings.farmName || null, location: settings.location || null, mapUrl: settings.mapUrl || null, contactPhone: settings.contactPhone || null,
      contactEmail: settings.contactEmail || null, arrivalInstructions: settings.arrivalInstructions || null, checkInTime: settings.checkInTime || null,
      checkOutTime: settings.checkOutTime || null, meals: settings.meals, mealNotes: settings.mealNotes || null,
      transportIncluded: settings.transportIncluded, transportPolicy: settings.transportPolicy || null,
    },
    policy: { cancelDays: settings.cancelDays, rescheduleDays: settings.rescheduleDays, extraPricePerKg: settings.extraPricePerKg },
  }
}

/** Staff see everything, internal notes included. */
export async function staffView(c, b) {
  const p = await parts(c, b)
  const [notes, cust, harvest] = await Promise.all([
    c.query('SELECT * FROM farm_booking_notes WHERE booking_id = $1 ORDER BY created_at DESC', [b.id]),
    c.query('SELECT id, name, phone, email FROM customers WHERE id = $1', [b.customer_id]),
    c.query('SELECT * FROM farm_harvest WHERE variety_id = $1 AND day = $2', [b.variety_id, b.visit_date]),
  ])
  return {
    ...common(b, p),
    customer: cust.rows[0] ?? null,
    checkinCode: b.checkin_code, kgReserved: b.kg_reserved, pricing: b.pricing,
    harvestDay: harvest.rows[0] ? { estimatedKg: harvest.rows[0].estimated_kg, bookableKg: harvest.rows[0].bookable_kg, reservedKg: harvest.rows[0].reserved_kg, readiness: harvest.rows[0].readiness, qcStatus: harvest.rows[0].qc_status } : null,
    payments: p.payments.map((x) => ({
      id: x.id, kind: x.kind, amount: x.amount, status: x.status, razorpayOrderId: x.razorpay_order_id, paymentId: x.payment_id, method: x.payment_method,
      reference: x.reference, receivedOn: x.received_on, note: x.note, recordedBy: x.recorded_by, failed: Boolean(x.last_failure), createdAt: x.created_at, paidAt: x.paid_at,
    })),
    events: p.events.map((e) => ({ id: e.id, from: e.from_status, to: e.to_status, action: e.action, detail: e.detail, actor: e.actor, actorKind: e.actor_kind, at: e.created_at })),
    notes: notes.rows.map((n) => ({ id: n.id, body: n.body, author: n.author_name, at: n.created_at })),
    nextMoves: STAFF_NEXT[b.status] ?? [],
  }
}

/** What the panel offers next for each status (the routes still check). */
const STAFF_NEXT = {
  HOSPITALITY_REVIEW: ['APPROVE', 'PROPOSE', 'ROOMS', 'MOVE', 'CANCEL'],
  CONFIRMED: ['PREPARING', 'READY_FOR_VISIT', 'CHECK_IN', 'PROPOSE', 'ROOMS', 'MOVE', 'CANCEL', 'NO_SHOW'],
  PREPARING: ['READY_FOR_VISIT', 'CHECK_IN', 'PROPOSE', 'ROOMS', 'MOVE', 'CANCEL', 'NO_SHOW'],
  READY_FOR_VISIT: ['CHECK_IN', 'PROPOSE', 'ROOMS', 'MOVE', 'CANCEL', 'NO_SHOW'],
  CHECKED_IN: ['HARVESTING', 'HARVEST'],
  HARVESTING: ['WEIGHING', 'HARVEST'],
  WEIGHING: ['HARVEST', 'BILL'],
  PAYMENT_DUE: ['BILL', 'RECORD_PAYMENT', 'HARVEST'],
  PACKING: ['COMPLETED', 'HARVEST'],
}

export const listRow = (b) => ({
  id: b.id, number: b.number, status: b.status, statusLabel: STATUS_WORDS[b.status], customerName: b.contact_name, phone: b.contact_phone, email: b.contact_email,
  variety: b.variety_name, varietyId: b.variety_id, kg: b.kg, total: b.total, billAmount: b.bill_amount, paidAt: b.paid_at, paymentId: b.payment_id ?? null,
  visitDate: b.visit_date, arrivalDate: b.arrival_date, departureDate: b.departure_date,
  adults: b.adults, children: b.children, guests: groupSize(b), overnight: b.overnight_guests,
  hospitalityStatus: b.hospitality_status, overCapacity: b.over_capacity, foodSummary: b.food ?? {}, harvestStatus: b.harvest_status, packingStatus: b.packing_status,
  request: b.request_kind, refundStatus: b.refund_state ?? null, createdAt: b.created_at,
})

