// Delivery dates: the cutoff, D+1/D+2, closed days and per-day capacity.
import { getConfig } from './config.js'
import { addDays, istParts, now } from './clock.js'
import { badRequest, conflict } from './errors.js'

/** Closed days between two dates (inclusive), as a Set of "YYYY-MM-DD". */
async function closedDays(c, from, to) {
  const { rows } = await c.query(
    'SELECT date FROM delivery_calendar WHERE date BETWEEN $1 AND $2 AND NOT is_open',
    [from, to],
  )
  return new Set(rows.map((r) => r.date))
}

/** First open day on or after `from`, looking at most 60 days ahead. */
export async function firstOpenDay(c, from) {
  const closed = await closedDays(c, from, addDays(from, 60))
  for (let d = from, i = 0; i <= 60; i++, d = addDays(d, 1)) if (!closed.has(d)) return d
  throw conflict('No delivery day is open in the next 60 days', 'NO_DELIVERY_DAY')
}

/** D+1 before the IST cutoff, D+2 after it, then skip closed days. */
export function earliestRawDate(at = now()) {
  const { date, hour } = istParts(at)
  return addDays(date, hour < getConfig().cutoffHourIST ? 1 : 2)
}

export const earliestDeliveryDate = (c, at = now()) => firstOpenDay(c, earliestRawDate(at))

/** Open delivery dates a customer can order for right now, earliest first. */
export async function orderableDates(c, at = now()) {
  const first = earliestRawDate(at)
  const last = addDays(first, getConfig().maxDaysAhead - 1)
  const closed = await closedDays(c, first, last)
  const out = []
  for (let d = first; d <= last; d = addDays(d, 1)) if (!closed.has(d)) out.push(d)
  return out
}

/** The next delivery day for a retry: the first open day after today (IST). */
export const nextDeliveryDay = (c, at = now()) => firstOpenDay(c, addDays(istParts(at).date, 1))

/**
 * Orders that take a day's or a slot's capacity: anything not cancelled or
 * returned, except unpaid orders whose hold has already run out (INV-A). Those
 * are cancelled by the sweep or lazily at the next checkout, but until then
 * they must not keep a capped day or slot full. $3 is "now" (clock.js, so
 * tests can move it).
 */
const BOOKED = `o.status NOT IN ('CANCELLED', 'RTO') AND NOT (o.status = 'PAYMENT_PENDING' AND COALESCE(o.hold_expires_at < $3::timestamptz, FALSE))`

/** Boxes booked on a date (see BOOKED), leaving out one order. */
async function dayBooked(c, date, excludeOrderId = null) {
  const used = await c.query(
    `SELECT COALESCE(SUM(i.quantity), 0)::int AS n FROM orders o JOIN order_items i ON i.order_id = o.id
      WHERE o.delivery_date = $1 AND ${BOOKED} AND o.id IS DISTINCT FROM $2`,
    [date, excludeOrderId, now()],
  )
  return used.rows[0].n
}

/**
 * Locks the day's calendar row (if any) and checks box capacity. Callers hold
 * the lock until their transaction ends, which serialises bookings per day.
 * `lock: false` (the checkout quote) only reads: the confirm re-checks under lock.
 */
export async function checkCapacity(c, date, boxes, excludeOrderId = null, { lock = true } = {}) {
  const { rows } = await c.query(`SELECT is_open, max_boxes FROM delivery_calendar WHERE date = $1${lock ? ' FOR UPDATE' : ''}`, [date])
  if (!rows.length) return
  if (!rows[0].is_open) throw conflict(`Deliveries are closed on ${date}`, 'DATE_CLOSED')
  if (rows[0].max_boxes == null) return
  if ((await dayBooked(c, date, excludeOrderId)) + boxes > rows[0].max_boxes) throw conflict(`${date} is fully booked`, 'DATE_FULL')
}

// ---------------------------------------------------------------- slots

const hhmm = (t) => String(t).slice(0, 5)

/** A slot as the APIs return it. */
export const slotView = (s) => ({
  id: s.id, label: s.label, startsAt: hhmm(s.starts_at), endsAt: hhmm(s.ends_at), maxBoxes: s.max_boxes, active: s.active, sort: s.sort,
})

/** Active slots in display order. `lock` takes row locks (staff editing slots). */
export async function activeSlots(c, { lock = false } = {}) {
  const { rows } = await c.query(`SELECT * FROM delivery_slots WHERE active ORDER BY sort, starts_at, id${lock ? ' FOR UPDATE' : ''}`)
  return rows
}

/** Boxes booked per slot on a date (slot id → boxes). */
export async function slotUsage(c, date, excludeOrderId = null) {
  const { rows } = await c.query(
    `SELECT o.slot_id, COALESCE(SUM(i.quantity), 0)::int AS n FROM orders o JOIN order_items i ON i.order_id = o.id
      WHERE o.delivery_date = $1 AND o.slot_id IS NOT NULL AND ${BOOKED} AND o.id IS DISTINCT FROM $2
      GROUP BY o.slot_id`,
    [date, excludeOrderId, now()],
  )
  return new Map(rows.map((r) => [r.slot_id, r.n]))
}

/** Each active slot on a date with what is left in it, for customers and the Planning page. */
export async function slotsForDate(c, date) {
  const [slots, used] = await Promise.all([activeSlots(c), slotUsage(c, date)])
  return slots.map((s) => {
    const booked = used.get(s.id) ?? 0
    const remaining = s.max_boxes == null ? null : Math.max(0, s.max_boxes - booked)
    return { ...slotView(s), booked, remainingBoxes: remaining, available: remaining == null || remaining > 0 }
  })
}

/**
 * Picks the slot for `boxes` on `date`, or null when no slots are set up.
 * `strict` (customer checkout, staff choosing a slot): the wanted slot must
 * exist and have room. Otherwise (late payments, retries, replacements) the
 * order keeps its slot if it has room, else takes the first with room, else
 * the least booked one: a system move never fails because of a slot.
 */
/** Advisory lock namespace for "booking slot capacity on one date". */
const SLOT_DAY_LOCK = 427714300

export async function chooseSlot(c, date, boxes, wanted, { strict = false, excludeOrderId = null } = {}) {
  // Serialises bookings on this date only (until the transaction ends), so
  // two checkouts can't both take the last place in a slot, while checkouts
  // for other dates don't wait. Locking the slot rows would queue every
  // checkout behind every other.
  await c.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [SLOT_DAY_LOCK, date])
  const slots = await activeSlots(c)
  if (!slots.length) {
    if (strict && wanted) throw badRequest('Delivery slots are not in use', 'SLOT_INVALID')
    return null
  }
  const used = await slotUsage(c, date, excludeOrderId)
  const fits = (s) => s.max_boxes == null || (used.get(s.id) ?? 0) + boxes <= s.max_boxes
  const want = slots.find((s) => s.id === wanted)
  if (strict) {
    if (!wanted) throw badRequest('Choose a delivery slot', 'SLOT_REQUIRED')
    if (!want) throw badRequest('That delivery slot is not available', 'SLOT_INVALID')
    if (!fits(want)) throw conflict(`The ${want.label} slot on ${date} is fully booked`, 'SLOT_FULL')
    return want.id
  }
  if (want && fits(want)) return want.id
  const free = slots.find(fits)
  if (free) return free.id
  return [...slots].sort((a, b) => (used.get(a.id) ?? 0) - (used.get(b.id) ?? 0))[0].id
}
