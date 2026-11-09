// Farm Experience WhatsApp updates (docs/farm-experience.md), through the
// existing outbox (notifications), queued in the same transaction as the change
// that causes them, so a rolled-back change sends nothing. Nothing is queued
// unless WHATSAPP_FARM_UPDATES is on (both templates need Meta's approval
// first): until then the booking page in the shop and the panel show the same
// status. The words are fixed when queued (farm_params), and each message's
// event id carries the booking's version, so a retried request adds nothing.
import { now } from '../clock.js'
import { env } from '../env.js'
import { newId } from '../ids.js'

const shopUrl = () => env.CUSTOMER_ORIGIN.split(',')[0]?.trim().replace(/\/$/, '') || 'https://mandimangoes.in'
const panelUrl = () => env.ADMIN_ORIGIN.split(',')[0]?.trim().replace(/\/$/, '') || 'http://localhost:5173'
const line = (s, n = 300) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const IST_DATE = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
const day = (d) => IST_DATE.format(new Date(`${d}T00:00:00Z`))

/** What the customer is told for each step (only steps listed here send anything). */
const CUSTOMER = {
  PAID: (b) => `We received your payment for ${b.kg} kg of ${b.variety_name}. Our team is now arranging your stay for ${day(b.visit_date)}.`,
  PAID_LATE: () => 'We received your payment, but your date is no longer available. Our team will contact you to pick a new date or refund you in full.',
  HOSPITALITY_APPROVED: (b) => `Your farm visit on ${day(b.visit_date)} is confirmed. Your itinerary and check-in code are in your booking.`,
  ALTERNATIVE_ACCEPTED: (b) => `Your farm visit on ${day(b.visit_date)} is confirmed with the arrangement you accepted.`,
  ALTERNATIVE_PROPOSED: () => 'We have proposed a change to your stay. Please open your booking to accept or decline it.',
  MOVED: (b) => `Your farm visit is now on ${day(b.visit_date)}.`,
  CANCELLED: () => 'Your farm booking is cancelled. Any refund due is shown in your booking.',
  TO_READY_FOR_VISIT: (b) => `Everything is ready for your visit on ${day(b.visit_date)}. Arrival instructions are in your booking.`,
  REMINDER: (b) => `A reminder: your farm visit is on ${day(b.visit_date)}. Arrival instructions are in your booking.`,
  TO_PACKING: () => 'Your mangoes are weighed and being packed for collection.',
  TO_COMPLETED: () => 'Your farm visit is complete. Thank you for visiting MandiMangoes.',
  EXTRA_REQUESTED: () => 'You picked more mangoes than you paid for. Please open your booking to approve and pay for the extra.',
  EXTRA_PAID: () => 'We received your payment for the extra mangoes.',
  SHORTFALL_REFUND: () => 'We are refunding the mangoes we could not supply. The amount is shown in your booking.',
  REFUND_SENT: () => 'Your refund has been sent to your bank. It can take 5 to 7 working days to show.',
  REQUEST_DECLINED: () => 'Our team replied to your request. Please open your booking to see it.',
}

/** What the team is told (to FARM_ALERT_PHONES). */
const TEAM = {
  TEAM_NEW_BOOKING: 'New paid farm booking',
  TEAM_ATTENTION: 'Farm booking needs a manager',
  TEAM_REQUEST: 'Farm booking: customer request',
  TEAM_DECLINED: 'Farm booking: customer declined the proposed stay',
}

async function add(c, { bookingId, kind, eventId, phone, params }) {
  await c.query(
    `INSERT INTO notifications (id, farm_booking_id, event_id, kind, phone, farm_params, next_attempt_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7) ON CONFLICT (event_id, kind) DO NOTHING`,
    [newId('ntf'), bookingId, eventId, kind, phone, JSON.stringify(params), now()],
  )
}

/** Queues what step `what` sends for booking `b` (its row after the change). Returns how many were queued. */
export async function queueFarmMessages(c, b, what, { tag = String(b.version) } = {}) {
  if (!env.WHATSAPP_FARM_UPDATES) return 0
  let n = 0
  const words = CUSTOMER[what]
  if (words && b.contact_phone) {
    await add(c, {
      bookingId: b.id, kind: 'FARM_BOOKING_UPDATE', eventId: `${b.id}:${what}:${tag}`, phone: b.contact_phone,
      params: [line(b.contact_name, 60) || 'there', b.number, line(words(b), 500), `${shopUrl()}/farm-bookings/${b.id}`],
    })
    n++
  }
  if (TEAM[what]) {
    const detail = `${b.kg} kg ${b.variety_name}, ${day(b.visit_date)}, ${b.adults + b.children} guests`
    for (const phone of env.FARM_ALERT_PHONES) {
      await add(c, {
        bookingId: b.id, kind: 'FARM_TEAM_ALERT', eventId: `${b.id}:${what}:${tag}:${phone}`, phone,
        params: [TEAM[what], b.number, line(detail, 300), `${panelUrl()}/farm/bookings/${b.id}`],
      })
      n++
    }
  }
  return n
}
