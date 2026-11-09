// Farm Experience rules with no database: price, status moves, what a customer
// may cancel or move, and the meal plan staff start from. Tested on their own
// in test/farm-experience.test.js.
import { addDays, diffDays } from '../clock.js'
import { HttpError } from '../errors.js'
import { MIN_KG } from './settings.js'

export { MIN_KG }

export const STATUSES = [
  'HOSPITALITY_REVIEW', 'CONFIRMED', 'PREPARING', 'READY_FOR_VISIT', 'CHECKED_IN', 'HARVESTING', 'WEIGHING', 'PAYMENT_DUE', 'PACKING',
  'COMPLETED', 'CANCELLED', 'NO_SHOW',
]
/** Booked and not yet at the farm: these hold their kilograms. Nothing is paid until after picking. */
export const BEFORE_VISIT = ['HOSPITALITY_REVIEW', 'CONFIRMED', 'PREPARING', 'READY_FOR_VISIT']
/** At the farm, or done there. */
export const ON_SITE = ['CHECKED_IN', 'HARVESTING', 'WEIGHING', 'PAYMENT_DUE', 'PACKING', 'COMPLETED']
/** Counted against a day's visit cap. */
export const TAKES_A_VISIT = [...BEFORE_VISIT, ...ON_SITE]
export const FINAL = ['COMPLETED', 'CANCELLED', 'NO_SHOW']

/** The plain-words name of each status, for the shop and the panel. */
export const STATUS_WORDS = {
  HOSPITALITY_REVIEW: 'Booked: stay being arranged',
  CONFIRMED: 'Booking confirmed',
  PREPARING: 'Preparation in progress',
  READY_FOR_VISIT: 'Ready for your visit',
  CHECKED_IN: 'Checked in',
  HARVESTING: 'Harvesting in progress',
  WEIGHING: 'Weighing and inspection',
  PAYMENT_DUE: 'Ready to pay',
  PACKING: 'Paid: packing',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'Missed visit',
}

/**
 * The moves staff make with the status action. Payment, expiry, cancelling,
 * check-in and dates have their own routes and rules, so they are not here.
 */
export const STAFF_MOVES = {
  CONFIRMED: ['PREPARING', 'READY_FOR_VISIT'],
  PREPARING: ['READY_FOR_VISIT'],
  CHECKED_IN: ['HARVESTING'],
  HARVESTING: ['WEIGHING'],
  // WEIGHING → PAYMENT_DUE is the bill (its own route); PAYMENT_DUE → PACKING is the payment.
  PACKING: ['COMPLETED'],
}

export function assertStaffMove(from, to) {
  if (!(STAFF_MOVES[from] ?? []).includes(to)) {
    throw new HttpError(409, 'BAD_STATUS_MOVE', `A booking that is ${STATUS_WORDS[from]?.toLowerCase() ?? from} can’t move to ${STATUS_WORDS[to]?.toLowerCase() ?? to}.`, { from, to })
  }
}

/** Check-in is possible once the booking is confirmed, on the visit window's days. */
export const CHECKIN_FROM = ['CONFIRMED', 'PREPARING', 'READY_FOR_VISIT']

/**
 * The price for `kg` of a variety: its tier for that amount (the highest minKg
 * at or below kg), else its price per kg. Always worked out here, never taken
 * from the shop.
 */
export function priceFor(variety, kg) {
  if (!Number.isInteger(kg) || kg < MIN_KG) throw new HttpError(400, 'FARM_MIN_KG', `The minimum is ${MIN_KG} kg.`, { minKg: MIN_KG })
  const tiers = [...(variety.tiers ?? [])].filter((t) => Number.isInteger(t.minKg) && Number.isInteger(t.pricePerKg)).sort((a, b) => a.minKg - b.minKg)
  const tier = tiers.filter((t) => t.minKg <= kg).at(-1) ?? null
  const pricePerKg = tier ? tier.pricePerKg : variety.price_per_kg
  return { pricePerKg, total: pricePerKg * kg, tier }
}

/**
 * The bill after weighing: the kilograms accepted, up to what was booked, at the
 * booking's price per kg; anything above that at `extraPricePerKg` (the farm
 * setting) or else the same price. Fewer kilograms than booked cost less: the
 * customer pays only for what they take. In paise, rounded to the paisa.
 */
export function billFor(b, acceptedKg, extraPricePerKg = null) {
  const accepted = Number(acceptedKg)
  if (!Number.isFinite(accepted) || accepted <= 0) throw new HttpError(409, 'NOT_WEIGHED', 'Record the accepted weight first.')
  const bookedPartKg = Math.min(accepted, b.kg)
  const extraKg = Math.round(Math.max(accepted - b.kg, 0) * 100) / 100
  const extraPrice = extraKg > 0 ? (extraPricePerKg ?? b.price_per_kg) : null
  const amount = Math.round(bookedPartKg * b.price_per_kg) + (extraKg > 0 ? Math.round(extraKg * extraPrice) : 0)
  if (amount < 100) throw new HttpError(409, 'BILL_TOO_SMALL', 'That is too little to charge for.')
  return { acceptedKg: accepted, bookedKg: b.kg, pricePerKg: b.price_per_kg, bookedPartKg, extraKg, extraPricePerKg: extraPrice, amount }
}

/** Everyone in the group. */
export const groupSize = (b) => b.adults + b.children

/**
 * What a customer's cancel does now (nothing is paid before the visit, so no money moves):
 * - 'CANCEL': cancelled at once, the kilograms go back on sale;
 * - 'REQUEST': too close to the visit, or preparations have started: our team decides;
 * - null: it can't be cancelled (at the farm already, or over).
 */
export function cancelOption(b, settings, today) {
  if (b.status === 'HOSPITALITY_REVIEW' || b.status === 'CONFIRMED') return diffDays(b.visit_date, today) >= settings.cancelDays ? 'CANCEL' : 'REQUEST'
  if (b.status === 'PREPARING' || b.status === 'READY_FOR_VISIT') return 'REQUEST'
  return null
}

/** What a customer's change of date does: 'MOVE' (done at once if the date has room), 'REQUEST' (a manager decides), or null. */
export function rescheduleOption(b, settings, today) {
  if (!BEFORE_VISIT.includes(b.status)) return null
  if (b.status === 'PREPARING' || b.status === 'READY_FOR_VISIT') return 'REQUEST'
  return diffDays(b.visit_date, today) >= settings.rescheduleDays ? 'MOVE' : 'REQUEST'
}

/**
 * The meal plan staff start from: one row a day from arrival to departure, the
 * included meals for everyone in the group. Staff change it to match the real stay.
 */
export function suggestMealPlan({ arrival, departure, guests, meals }) {
  const out = []
  const days = Math.max(diffDays(departure, arrival), 0)
  for (let i = 0; i <= days; i++) {
    out.push({
      date: addDays(arrival, i),
      breakfast: meals.breakfast && i > 0 ? guests : 0,
      lunch: meals.lunch ? guests : 0,
      dinner: meals.dinner && i < days ? guests : 0,
      refreshments: meals.refreshments ? guests : 0,
    })
  }
  return out
}

/** Random, unguessable codes from an alphabet without look-alikes (0/O/1/I/L). */
export const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const BOOKING_NUMBER_RE = /^MMF-[2-9A-HJKMNP-Z]{8}$/
export const CHECKIN_CODE_RE = /^[2-9A-HJKMNP-Z]{12}$/
