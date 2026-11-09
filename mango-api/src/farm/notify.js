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
const rupees = (paise) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(paise / 100)}`
const CUSTOMER = {
  CREATED: (b) => `We have your booking for ${b.kg} kg of ${b.variety_name} on ${day(b.visit_date)}. Our team is arranging your stay. You pay after picking, for the mangoes weighed and accepted.`,
  HOSPITALITY_APPROVED: (b) => `Your farm visit on ${day(b.visit_date)} is confirmed. Your itinerary and check-in code are in your booking.`,
  ALTERNATIVE_ACCEPTED: (b) => `Your farm visit on ${day(b.visit_date)} is confirmed with the arrangement you accepted.`,
  ALTERNATIVE_PROPOSED: () => 'We have proposed a change to your stay. Please open your booking to accept or decline it.',
  MOVED: (b) => `Your farm visit is now on ${day(b.visit_date)}.`,
  CANCELLED: () => 'Your farm booking is cancelled. Nothing was charged.',
  TO_READY_FOR_VISIT: (b) => `Everything is ready for your visit on ${day(b.visit_date)}. Arrival instructions are in your booking.`,
  REMINDER: (b) => `A reminder: your farm visit is on ${day(b.visit_date)}. Arrival instructions are in your booking.`,
  BILL_ISSUED: (b) => `Your mangoes are weighed: ${Number(b.accepted_kg)} kg accepted. Your bill is ${rupees(b.bill_amount)}. Please pay it in your booking.`,
  BILL_REVISED: (b) => `Your bill was corrected to ${rupees(b.bill_amount)} for ${Number(b.accepted_kg)} kg. Please pay it in your booking.`,
  PAID: (b) => `We received your payment of ${rupees(b.bill_amount)}. Your mangoes are being packed.`,
  TO_COMPLETED: () => 'Your farm visit is complete. Thank you for visiting MandiMangoes.',
  REFUND_SENT: () => 'We took your payment twice, so we have refunded one. It can take 5 to 7 working days to show.',
  REQUEST_DECLINED: () => 'Our team replied to your request. Please open your booking to see it.',
}

/** What the team is told (to FARM_ALERT_PHONES). */
const TEAM = {
  TEAM_NEW_BOOKING: 'New farm booking',
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
