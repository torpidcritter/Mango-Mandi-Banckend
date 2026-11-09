// Farm Experience lists, calendar and reports for staff (docs/farm-experience.md).
// Every figure is read from recorded data: bills made from the weights staff
// recorded, payments Razorpay confirmed or a manager recorded, never from what a page sent.
import { addDays, todayIST } from '../clock.js'
import { csvCell } from '../warehouse/reports.js'
import { listRow } from './bookings.js'
import { BEFORE_VISIT, FINAL, ON_SITE, STATUSES } from './rules.js'

export const SORTS = { created: 'b.created_at', visit: 'b.visit_date', kg: 'b.kg', guests: '(b.adults + b.children)', total: 'b.total', number: 'b.number' }

/** Bookings that need someone: a stay to arrange, a customer request, or a refund of money taken twice that needs a manager. */
export const NEEDS_ACTION = `(b.status = 'HOSPITALITY_REVIEW' OR b.request_kind IS NOT NULL
  OR EXISTS (SELECT 1 FROM farm_refunds r WHERE r.booking_id = b.id AND r.refund_gave_up_at IS NOT NULL AND r.refunded_at IS NULL))`

export async function listBookings(c, f) {
  const where = []
  const args = []
  const arg = (v) => (args.push(v), `$${args.length}`)
  if (f.q) {
    const like = arg(`%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`)
    const digits = f.q.replace(/\D/g, '')
    where.push(`(b.number ILIKE ${like} OR b.contact_name ILIKE ${like} OR b.contact_email ILIKE ${like}
      ${digits.length >= 4 ? `OR b.contact_phone LIKE ${arg(`%${digits}%`)}` : ''}
      OR EXISTS (SELECT 1 FROM farm_booking_payments p WHERE p.booking_id = b.id AND (p.payment_id ILIKE ${like} OR p.razorpay_order_id ILIKE ${like})))`)
  }
  if (f.status?.length) where.push(`b.status = ANY(${arg(f.status)})`)
  if (f.varietyId) where.push(`b.variety_id = ${arg(f.varietyId)}`)
  if (f.visitFrom) where.push(`b.visit_date >= ${arg(f.visitFrom)}`)
  if (f.visitTo) where.push(`b.visit_date <= ${arg(f.visitTo)}`)
  if (f.createdFrom) where.push(`b.created_at >= ${arg(f.createdFrom)}::date`)
  if (f.createdTo) where.push(`b.created_at < (${arg(f.createdTo)}::date + 1)`)
  if (f.payment === 'PAID') where.push(`b.paid_at IS NOT NULL`)
  if (f.payment === 'DUE') where.push(`b.status = 'PAYMENT_DUE'`)
  if (f.payment === 'REFUNDED') where.push(`EXISTS (SELECT 1 FROM farm_refunds r WHERE r.booking_id = b.id)`)
  if (f.minKg != null) where.push(`b.kg >= ${arg(f.minKg)}`)
  if (f.maxKg != null) where.push(`b.kg <= ${arg(f.maxKg)}`)
  if (f.minGuests != null) where.push(`(b.adults + b.children) >= ${arg(f.minGuests)}`)
  if (f.maxGuests != null) where.push(`(b.adults + b.children) <= ${arg(f.maxGuests)}`)
  if (f.customerId) where.push(`b.customer_id = ${arg(f.customerId)}`)
  if (f.needsAction) where.push(NEEDS_ACTION)
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = (await c.query(`SELECT COUNT(*)::int AS n FROM farm_bookings b ${w}`, args)).rows[0].n
  const order = `${SORTS[f.sort] ?? SORTS.created} ${f.dir === 'asc' ? 'ASC' : 'DESC'}, b.id`
  const { rows } = await c.query(
    `SELECT b.*, (SELECT COALESCE(p.payment_id, p.reference) FROM farm_booking_payments p WHERE p.booking_id = b.id AND p.status = 'SUCCEEDED' ORDER BY p.paid_at LIMIT 1) AS payment_id,
            (SELECT CASE WHEN COUNT(*) = 0 THEN NULL WHEN COUNT(*) FILTER (WHERE r.refunded_at IS NULL) > 0 THEN 'REFUND_PENDING' ELSE 'REFUNDED' END
               FROM farm_refunds r WHERE r.booking_id = b.id) AS refund_state
       FROM farm_bookings b
       ${w} ORDER BY ${order} LIMIT ${arg(f.pageSize)} OFFSET ${arg((f.page - 1) * f.pageSize)}`,
    args,
  )
  return { total, page: f.page, pageSize: f.pageSize, items: rows.map(listRow) }
}

export async function overview(c, today = todayIST()) {
  const { rows } = await c.query(`SELECT status, COUNT(*)::int AS n FROM farm_bookings GROUP BY status`)
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]))
  for (const r of rows) byStatus[r.status] = r.n
  const [action, upcoming, refunds] = await Promise.all([
    c.query(`SELECT COUNT(*)::int AS n FROM farm_bookings b WHERE ${NEEDS_ACTION}`),
    c.query(
      `SELECT visit_date, COUNT(*)::int AS bookings, SUM(adults + children)::int AS guests, SUM(overnight_guests)::int AS overnight, SUM(kg)::int AS kg
         FROM farm_bookings WHERE visit_date BETWEEN $1 AND $2 AND status = ANY($3) GROUP BY visit_date ORDER BY visit_date`,
      [today, addDays(today, 13), [...BEFORE_VISIT, ...ON_SITE]],
    ),
    c.query(`SELECT COUNT(*)::int AS n FROM farm_refunds WHERE refunded_at IS NULL`),
  ])
  return { byStatus, needsAction: action.rows[0].n, refundsPending: refunds.rows[0].n, nextTwoWeeks: upcoming.rows }
}

/** The calendar: each day's opening, visit cap, harvest per variety, bookings, guests and rooms in use. */
export async function calendar(c, from, to) {
  const [days, harvest, bookings, rooms, roomUse] = await Promise.all([
    c.query('SELECT * FROM farm_days WHERE day BETWEEN $1 AND $2 ORDER BY day', [from, to]),
    c.query(
      `SELECT h.*, v.name FROM farm_harvest h JOIN farm_varieties v ON v.id = h.variety_id WHERE h.day BETWEEN $1 AND $2 ORDER BY h.day, v.sort_order, v.name`,
      [from, to],
    ),
    c.query(
      `SELECT id, number, status, visit_date, arrival_date, departure_date, variety_name, kg, adults, children, overnight_guests, hospitality_status, over_capacity, contact_name
         FROM farm_bookings WHERE departure_date >= $1 AND arrival_date <= $2 AND NOT (status = ANY($3)) ORDER BY visit_date, created_at`,
      [from, to, ['CANCELLED']],
    ),
    c.query('SELECT COALESCE(SUM(sleeps + extra_beds), 0)::int AS beds, COUNT(*)::int AS rooms FROM farm_rooms WHERE active AND NOT maintenance'),
    c.query(
      `SELECT a.room_id, a.from_date, a.to_date, a.guests, fb.number FROM farm_room_allocations a JOIN farm_bookings fb ON fb.id = a.booking_id
        WHERE a.to_date > $1 AND a.from_date <= $2 AND NOT (fb.status = ANY($3))`,
      [from, to, ['CANCELLED', 'NO_SHOW']],
    ),
  ])
  const out = []
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const day = days.rows.find((x) => x.day === d)
    const visits = bookings.rows.filter((b) => b.visit_date === d && b.status !== 'NO_SHOW')
    const staying = bookings.rows.filter((b) => b.arrival_date <= d && d < b.departure_date && !FINAL.includes(b.status))
    const used = roomUse.rows.filter((a) => a.from_date <= d && d < a.to_date)
    out.push({
      date: d,
      open: Boolean(day?.open), closedReason: day?.closed_reason ?? null, maxBookings: day?.max_bookings ?? null, note: day?.note ?? null,
      harvest: harvest.rows.filter((h) => h.day === d).map((h) => ({
        varietyId: h.variety_id, name: h.name, estimatedKg: h.estimated_kg, bookableKg: h.bookable_kg, confirmedKg: h.confirmed_kg, reservedKg: h.reserved_kg,
        availableKg: Math.max(h.bookable_kg - h.reserved_kg, 0), readiness: h.readiness, qcStatus: h.qc_status, note: h.note,
      })),
      visits: visits.map((b) => ({ id: b.id, number: b.number, status: b.status, name: b.contact_name, variety: b.variety_name, kg: b.kg, guests: b.adults + b.children, hospitalityStatus: b.hospitality_status, overCapacity: b.over_capacity })),
      overnightGuests: staying.reduce((s, b) => s + b.overnight_guests, 0),
      roomsInUse: used.length,
      // Two bookings sharing a room on a night (should not happen: allocateRooms refuses it), shown if ever found.
      overlaps: used.filter((a, i) => used.findIndex((x) => x.room_id === a.room_id) !== i).map((a) => a.number),
    })
  }
  return { from, to, rooms: rooms.rows[0].rooms, beds: rooms.rows[0].beds, days: out }
}

/**
 * The report for a range of visit dates (optionally one variety): every booking
 * in it, what was weighed, and revenue from bills paid. Conversion: bookings
 * made in the range whose bill was paid.
 */
export async function report(c, { from, to, varietyId = null }) {
  const args = [from, to, varietyId]
  const v = `($3::text IS NULL OR b.variety_id = $3)`
  const extraPart = `COALESCE((b.bill->>'extraKg')::numeric * (b.bill->>'extraPricePerKg')::numeric, 0)`
  const [all, started, byVariety, refunds, rooms, days] = await Promise.all([
    c.query(
      `SELECT COUNT(*) FILTER (WHERE b.status <> 'CANCELLED')::int AS bookings, COALESCE(SUM(b.kg) FILTER (WHERE b.status <> 'CANCELLED'), 0)::int AS kg,
              COALESCE(SUM(b.bill_amount) FILTER (WHERE b.paid_at IS NOT NULL), 0)::bigint AS revenue,
              COUNT(*) FILTER (WHERE b.paid_at IS NOT NULL)::int AS paid,
              COALESCE(SUM(b.adults + b.children) FILTER (WHERE b.status = ANY($4)), 0)::int AS guests_hosted,
              COALESCE(AVG(b.adults + b.children) FILTER (WHERE b.status <> 'CANCELLED'), 0)::float AS avg_group,
              COALESCE(AVG(b.kg) FILTER (WHERE b.status <> 'CANCELLED'), 0)::float AS avg_kg,
              COALESCE(SUM(b.accepted_kg) FILTER (WHERE b.bill IS NOT NULL), 0)::float AS harvested_kg,
              COALESCE(SUM(${extraPart}) FILTER (WHERE b.paid_at IS NOT NULL), 0)::float AS extra_revenue,
              COALESCE(SUM((b.bill->>'extraKg')::numeric) FILTER (WHERE b.paid_at IS NOT NULL), 0)::float AS extra_kg,
              COUNT(*) FILTER (WHERE b.status = 'CANCELLED')::int AS cancelled, COUNT(*) FILTER (WHERE b.status = 'NO_SHOW')::int AS no_shows,
              COUNT(*) FILTER (WHERE b.status = 'COMPLETED')::int AS completed, COUNT(*)::int AS made,
              COALESCE(SUM(b.overnight_guests * GREATEST(b.departure_date - b.arrival_date, 0)) FILTER (WHERE b.status NOT IN ('CANCELLED','NO_SHOW')), 0)::int AS guest_nights
         FROM farm_bookings b WHERE b.visit_date BETWEEN $1 AND $2 AND ${v}`,
      [...args, ON_SITE],
    ),
    c.query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE b.paid_at IS NOT NULL)::int AS paid FROM farm_bookings b WHERE b.created_at >= $1::date AND b.created_at < ($2::date + 1) AND ${v}`, args),
    c.query(
      `SELECT b.variety_name AS name, COUNT(*)::int AS bookings, SUM(COALESCE(b.accepted_kg, b.kg))::float AS kg, COALESCE(SUM(b.bill_amount) FILTER (WHERE b.paid_at IS NOT NULL), 0)::bigint AS revenue
         FROM farm_bookings b WHERE b.status <> 'CANCELLED' AND b.visit_date BETWEEN $1 AND $2 AND ${v} GROUP BY b.variety_name ORDER BY SUM(b.kg) DESC`,
      args,
    ),
    c.query(
      `SELECT COALESCE(SUM(r.amount), 0)::bigint AS value, COUNT(*)::int AS n FROM farm_refunds r JOIN farm_bookings b ON b.id = r.booking_id
        WHERE b.visit_date BETWEEN $1 AND $2 AND ${v}`,
      args,
    ),
    c.query(
      `SELECT COALESCE(SUM(LEAST(a.to_date, $2::date + 1) - GREATEST(a.from_date, $1::date)), 0)::int AS room_nights FROM farm_room_allocations a
         JOIN farm_bookings b ON b.id = a.booking_id WHERE a.to_date > $1 AND a.from_date <= $2 AND b.status NOT IN ('CANCELLED','NO_SHOW') AND ${v}`,
      args,
    ),
    c.query(
      `SELECT COUNT(*)::int AS open_days, COALESCE(SUM(max_bookings), 0)::int AS visit_slots, COUNT(max_bookings)::int AS capped_days,
              (SELECT COUNT(*)::int FROM farm_rooms WHERE active AND NOT maintenance) AS rooms
         FROM farm_days WHERE open AND day BETWEEN $1 AND $2`,
      [from, to],
    ),
  ])
  const p = all.rows[0]
  const d = days.rows[0]
  const roomCapacity = d.rooms * d.open_days
  return {
    from, to, varietyId,
    bookings: p.bookings, kgBooked: p.kg, kgHarvested: Number(p.harvested_kg), revenue: Number(p.revenue), paidBookings: p.paid, avgKg: Math.round(p.avg_kg),
    guestsHosted: p.guests_hosted, avgGroup: Math.round(p.avg_group * 10) / 10, completed: p.completed, cancelled: p.cancelled, noShows: p.no_shows,
    cancellationRate: p.made ? p.cancelled / p.made : 0,
    conversion: { started: started.rows[0].n, paid: started.rows[0].paid, rate: started.rows[0].n ? started.rows[0].paid / started.rows[0].n : 0 },
    refunds: { count: refunds.rows[0].n, value: Number(refunds.rows[0].value) },
    extras: { revenue: Math.round(Number(p.extra_revenue)), kg: Number(p.extra_kg) },
    varieties: byVariety.rows.map((r) => ({ name: r.name, bookings: r.bookings, kg: Number(r.kg), revenue: Number(r.revenue) })),
    utilisation: {
      openDays: d.open_days, visitSlots: d.visit_slots, visitRate: d.capped_days && d.visit_slots ? Math.min(p.bookings / d.visit_slots, 1) : null,
      roomNights: rooms.rows[0].room_nights, roomNightsAvailable: roomCapacity, roomRate: roomCapacity ? rooms.rows[0].room_nights / roomCapacity : null,
      guestNights: p.guest_nights,
    },
  }
}

export const CSV_COLUMNS = ['number', 'status', 'created_at', 'visit_date', 'arrival_date', 'departure_date', 'customer', 'phone', 'email', 'variety', 'kg', 'price_per_kg_rupees',
  'estimate_rupees', 'harvested_kg', 'accepted_kg', 'bill_rupees', 'paid_at', 'payment', 'adults', 'children', 'overnight', 'hospitality', 'packing', 'refunded_rupees']

/** The bookings in a range of visit dates as CSV (formula-safe cells). Managers only. */
export async function bookingsCsv(c, { from, to, varietyId = null }) {
  const { rows } = await c.query(
    `SELECT b.*, (SELECT COALESCE(p.payment_id, p.payment_method || ' ' || p.reference) FROM farm_booking_payments p
                   WHERE p.booking_id = b.id AND p.status = 'SUCCEEDED' ORDER BY p.paid_at LIMIT 1) AS payment_id,
            (SELECT COALESCE(SUM(r.amount), 0) FROM farm_refunds r WHERE r.booking_id = b.id)::int AS refunded
       FROM farm_bookings b
      WHERE b.visit_date BETWEEN $1 AND $2 AND ($3::text IS NULL OR b.variety_id = $3) ORDER BY b.visit_date, b.created_at LIMIT 5000`,
    [from, to, varietyId],
  )
  const lines = [CSV_COLUMNS.map(csvCell).join(',')]
  for (const b of rows) {
    lines.push([
      b.number, b.status, b.created_at.toISOString(), b.visit_date, b.arrival_date, b.departure_date, b.contact_name, b.contact_phone, b.contact_email ?? '',
      b.variety_name, b.kg, b.price_per_kg / 100, b.total / 100, b.harvested_kg ?? '', b.accepted_kg ?? '', b.bill_amount == null ? '' : b.bill_amount / 100,
      b.paid_at?.toISOString() ?? '', b.payment_id ?? '', b.adults, b.children, b.overnight_guests, b.hospitality_status, b.packing_status, b.refunded / 100,
    ].map(csvCell).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}
