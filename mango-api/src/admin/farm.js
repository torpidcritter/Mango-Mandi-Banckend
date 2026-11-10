// Farm Experience for staff (docs/farm-experience.md): bookings, the farm
// calendar, harvest stock, rooms, settings and reports. Managers and operators
// (access.js lists what operators may call: they can weigh and send the bill;
// recording a payment, prices, dates, cancelling, settings and exports are managers only). Every change is written to
// staff_audit by access.js (auditStaffChanges) and to the booking's own events
// in the same transaction as the change. While FARM_EXPERIENCE is off every
// route answers 404.
import express from 'express'
import { z } from 'zod'
import { requireManager } from '../auth.js'
import { addDays, now, todayIST } from '../clock.js'
import { query, tx } from '../db.js'
import { asyncHandler, conflict, HttpError, notFound, parse } from '../errors.js'
import { isOn } from '../feature-switches.js'
import { newId } from '../ids.js'
import {
  allocateRooms, approveHospitality, cancelBooking, checkIn, declineRequest, event, issueBill, lockBooking, markNoShow, moveVisit, proposeAlternative,
  recordHarvest, recordPayment, staffActor, staffMove, staffView,
} from '../farm/bookings.js'
import { settleFarmRefund } from '../farm/refunds.js'
import { BEFORE_VISIT, CHECKIN_CODE_RE, STAFF_MOVES, STATUSES } from '../farm/rules.js'
import { loadSettings, readinessProblems, saveSettings } from '../farm/settings.js'
import { bookingsCsv, calendar, listBookings, overview, report, SORTS } from '../farm/staff.js'
import { stepUp, withoutConfirm } from './step-up.js'

export const router = express.Router()
const F = '/farm'
router.use(F, (_req, _res, next) => next(isOn('FARM_EXPERIENCE') ? undefined : notFound()))

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const reason = z.string().trim().min(5, 'Say why (5 characters or more). It is kept in the booking’s history.').max(1000)
const clean = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === '' ? undefined : v]))
const actorOf = (req) => staffActor(req.admin)
const fresh = async (id) => staffView({ query }, (await query('SELECT * FROM farm_bookings WHERE id = $1', [id])).rows[0])

/** Runs `fn` on the locked booking in one transaction and answers the booking as staff see it. */
const onBooking = (fn, { after = null } = {}) =>
  asyncHandler(async (req, res) => {
    const id = parse(ID, req.params.id)
    const out = await tx(async (c) => fn(c, await lockBooking(c, id), req))
    if (after) await after(id, out)
    res.json(await fresh(id))
  })

// ---------------------------------------------------------------- bookings

const listFilters = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.string().max(400).transform((s) => s.split(',').filter(Boolean)).pipe(z.array(z.enum(STATUSES)).max(STATUSES.length)).optional(),
  varietyId: ID.optional(),
  visitFrom: DAY.optional(),
  visitTo: DAY.optional(),
  createdFrom: DAY.optional(),
  createdTo: DAY.optional(),
  payment: z.enum(['PAID', 'DUE', 'REFUNDED']).optional(),
  minKg: z.coerce.number().int().min(0).optional(),
  maxKg: z.coerce.number().int().min(0).optional(),
  minGuests: z.coerce.number().int().min(0).optional(),
  maxGuests: z.coerce.number().int().min(0).optional(),
  customerId: ID.optional(),
  needsAction: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  sort: z.enum(Object.keys(SORTS)).default('created'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
})

router.get(`${F}/overview`, asyncHandler(async (_req, res) => res.json(await overview({ query }))))
router.get(`${F}/bookings`, asyncHandler(async (req, res) => res.json(await listBookings({ query }, parse(listFilters, clean(req.query))))))

router.get(
  `${F}/bookings/:id`,
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM farm_bookings WHERE id = $1', [parse(ID, req.params.id)])
    if (!rows.length) throw notFound('Booking not found')
    res.json(await staffView({ query }, rows[0]))
  }),
)

const mealRow = z.object({
  date: DAY, breakfast: z.number().int().min(0), lunch: z.number().int().min(0), dinner: z.number().int().min(0), refreshments: z.number().int().min(0),
}).strict()

router.patch(
  `${F}/bookings/:id`,
  onBooking(async (c, b, req) => {
    const p = parse(
      z.object({ hospitalityPlan: z.string().trim().max(3000).optional(), mealPlan: z.array(mealRow).max(62).optional(), version: z.number().int().optional() }).strict(),
      req.body,
    )
    if (p.version != null && p.version !== b.version) throw new HttpError(409, 'STALE_BOOKING', 'Someone else changed this booking. Reload to see their change.', { version: b.version })
    if (['CANCELLED', 'NO_SHOW', 'COMPLETED'].includes(b.status)) throw conflict('This booking is closed.', 'BOOKING_CLOSED')
    const sets = []
    const args = [b.id]
    if (p.hospitalityPlan !== undefined) sets.push(`hospitality_plan = $${args.push(p.hospitalityPlan || null)}`)
    if (p.mealPlan !== undefined) sets.push(`meal_plan = $${args.push(JSON.stringify(p.mealPlan))}`)
    if (!sets.length) return
    await event(c, b, { action: 'HOSPITALITY_UPDATED', detail: [p.hospitalityPlan !== undefined && 'stay plan', p.mealPlan !== undefined && 'meal plan'].filter(Boolean).join(' and ') + ' updated', actor: actorOf(req) })
    await c.query(`UPDATE farm_bookings SET ${sets.join(', ')}, version = version + 1, updated_at = $${args.push(now())} WHERE id = $1`, args)
  }),
)

router.post(
  `${F}/bookings/:id/notes`,
  onBooking(async (c, b, req) => {
    const { body } = parse(z.object({ body: z.string().trim().min(1, 'Write the note').max(3000) }).strict(), req.body)
    await c.query('INSERT INTO farm_booking_notes (id, booking_id, body, author_id, author_name, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [
      newId('fbn'), b.id, body, req.admin.id, req.admin.email, now(),
    ])
  }),
)

router.post(
  `${F}/bookings/:id/hospitality`,
  onBooking((c, b, req) => {
    const p = parse(z.object({ action: z.enum(['APPROVE', 'PROPOSE']), text: z.string().trim().max(3000).optional() }).strict(), req.body)
    if (p.action === 'APPROVE') return approveHospitality(c, b, { plan: p.text, actor: actorOf(req) })
    if (!p.text || p.text.length < 10) throw new HttpError(400, 'VALIDATION_ERROR', 'Describe the arrangement you are proposing (10 characters or more).')
    return proposeAlternative(c, b, { proposal: p.text, actor: actorOf(req) })
  }),
)

const allocation = z.object({
  roomId: ID, fromDate: DAY, toDate: DAY, guests: z.number().int().min(0), extraBeds: z.number().int().min(0).optional(), note: z.string().trim().max(300).optional(),
}).strict()

router.put(
  `${F}/bookings/:id/rooms`,
  onBooking((c, b, req) => {
    const { allocations } = parse(z.object({ allocations: z.array(allocation).max(200) }).strict(), req.body)
    return allocateRooms(c, b, allocations, { actor: actorOf(req) })
  }),
)

router.post(
  `${F}/bookings/:id/status`,
  onBooking((c, b, req) => {
    const to = Object.values(STAFF_MOVES).flat()
    const p = parse(z.object({ to: z.enum([...new Set(to)]), note: z.string().trim().max(1000).optional() }).strict(), req.body)
    return staffMove(c, b, p.to, { actor: actorOf(req), note: p.note })
  }),
)

router.post(
  `${F}/bookings/:id/harvest`,
  onBooking((c, b, req) => {
    const kg = z.number().min(0).max(1_000_000).multipleOf(0.01, 'Up to two decimals')
    const p = parse(
      z.object({
        harvestedKg: kg.optional(), acceptedKg: kg.optional(), inspectionNote: z.string().trim().max(1000).optional(),
        harvestStatus: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'DONE']).optional(), packingStatus: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'PACKED', 'COLLECTED']).optional(),
      }).strict(),
      req.body,
    )
    return recordHarvest(c, b, p, { actor: actorOf(req) })
  }),
)

// The bill after weighing (or a corrected one before it is paid), for the kilograms accepted.
router.post(
  `${F}/bookings/:id/bill`,
  onBooking((c, b, req) => {
    const p = parse(z.object({ acceptedKg: z.number().positive('More than 0 kg').max(1_000_000).multipleOf(0.01, 'Up to two decimals').optional() }).strict(), req.body ?? {})
    return issueBill(c, b, { acceptedKg: p.acceptedKg, actor: actorOf(req) })
  }),
)

// ---- managers only: dates, cancelling, money

router.post(
  `${F}/bookings/:id/move`,
  requireManager,
  onBooking((c, b, req) => {
    const p = parse(z.object({ date: DAY, reason, outsideWindow: z.boolean().optional() }).strict(), req.body)
    return moveVisit(c, b, p.date, { actor: actorOf(req), reason: p.reason, window: !p.outsideWindow })
  }),
)

// Before the visit nothing is paid, so cancelling moves no money.
router.post(
  `${F}/bookings/:id/cancel`,
  requireManager,
  onBooking((c, b, req) => cancelBooking(c, b, { reason: parse(z.object({ reason }).strict(), req.body).reason, actor: actorOf(req) })),
)

router.post(
  `${F}/bookings/:id/request/decline`,
  requireManager,
  onBooking((c, b, req) => declineRequest(c, b, { reason: parse(z.object({ reason }).strict(), req.body).reason, actor: actorOf(req) })),
)

router.post(
  `${F}/bookings/:id/no-show`,
  requireManager,
  onBooking((c, b, req) => markNoShow(c, b, { actor: actorOf(req), note: parse(z.object({ note: z.string().trim().max(1000).optional() }).strict(), req.body).note })),
)

// The customer paid the bill another way at the farm: money in, so the manager confirms it is them (STEP_UP_ROUTES).
router.post(
  `${F}/bookings/:id/record-payment`,
  requireManager,
  asyncHandler(async (req, res) => {
    const id = parse(ID, req.params.id)
    const p = parse(
      z.object({
        method: z.enum(['UPI', 'CARD', 'CASH', 'BANK_TRANSFER']),
        reference: z.string().trim().min(3, 'Give the receipt or UPI reference').max(100),
        amount: z.number().int('In paise').positive(),
        receivedOn: DAY.optional(),
        note: z.string().trim().max(1000).optional(),
      }).strict(),
      withoutConfirm(req.body),
    )
    await stepUp(req, { always: true })
    await tx(async (c) =>
      recordPayment(c, await lockBooking(c, id), { method: p.method, reference: p.reference, amount: p.amount, receivedOn: p.receivedOn, note: p.note || null, actor: actorOf(req) }),
    )
    res.json(await fresh(id))
  }),
)

router.post(
  `${F}/refunds/:id/settle`,
  requireManager,
  asyncHandler(async (req, res) => {
    const id = parse(ID, req.params.id)
    const p = parse(z.object({ reference: z.string().trim().min(3, 'Give the payment reference').max(100) }).strict(), withoutConfirm(req.body))
    await stepUp(req, { always: true })
    const r = await tx((c) => settleFarmRefund(c, id, { reference: p.reference, actor: actorOf(req) }))
    if (!r) throw conflict('That refund is already done.', 'REFUND_DONE')
    res.json(await fresh(r.booking_id))
  }),
)

// ---------------------------------------------------------------- check-in

async function byCode(c, raw, lock = false) {
  const code = String(raw ?? '').trim().toUpperCase().replace(/^MMF:/, '')
  const isNumber = /^MMF-[2-9A-HJKMNP-Z]{8}$/.test(code)
  if (!isNumber && !CHECKIN_CODE_RE.test(code)) throw new HttpError(400, 'VALIDATION_ERROR', 'Scan the QR or type the booking’s check-in code or MMF- number.')
  const { rows } = await c.query(`SELECT * FROM farm_bookings WHERE ${isNumber ? 'number' : 'checkin_code'} = $1${lock ? ' FOR UPDATE' : ''}`, [code])
  if (!rows.length) throw notFound('No booking has that code.')
  return rows[0]
}

router.get(
  `${F}/check-in/:code`,
  asyncHandler(async (req, res) => {
    const b = await byCode({ query }, req.params.code)
    res.json(await staffView({ query }, b))
  }),
)

router.post(
  `${F}/check-in`,
  asyncHandler(async (req, res) => {
    const p = parse(z.object({ code: z.string().max(40), override: z.boolean().optional() }).strict(), req.body)
    if (p.override && req.admin.role !== 'MANAGER') throw new HttpError(403, 'FORBIDDEN', 'Only a manager can check a booking in outside its days.')
    const b = await tx(async (c) => checkIn(c, await byCode(c, p.code, true), { actor: actorOf(req), override: Boolean(p.override) }))
    res.json(await staffView({ query }, b))
  }),
)

// ---------------------------------------------------------------- calendar and harvest

router.get(
  `${F}/calendar`,
  asyncHandler(async (req, res) => {
    const today = todayIST()
    const q = parse(z.object({ from: DAY.default(today), to: DAY.optional() }), clean(req.query))
    const to = q.to ?? addDays(q.from, 41)
    if (to < q.from || addDays(q.from, 92) < to) throw new HttpError(400, 'VALIDATION_ERROR', 'Show up to 92 days at a time.')
    res.json(await calendar({ query }, q.from, to))
  }),
)

const dayFields = z.object({
  open: z.boolean(),
  closedReason: z.enum(['WEATHER', 'MAINTENANCE', 'SEASON', 'HOLIDAY', 'OTHER']).nullable().optional(),
  maxBookings: z.number().int().min(0).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
}).strict()

async function saveDay(c, day, d, admin) {
  await c.query(
    `INSERT INTO farm_days (day, open, closed_reason, max_bookings, note, updated_at, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (day) DO UPDATE SET open = $2, closed_reason = $3, max_bookings = $4, note = $5, updated_at = $6, updated_by = $7`,
    [day, d.open, d.open ? null : (d.closedReason ?? 'OTHER'), d.maxBookings ?? null, d.note || null, now(), admin.email],
  )
}

/** Open bookings on a day being closed: the manager is told, never silently left. */
async function bookingsOnDay(c, day) {
  const { rows } = await c.query(`SELECT number FROM farm_bookings WHERE visit_date = $1 AND status = ANY($2)`, [day, BEFORE_VISIT])
  return rows.map((r) => r.number)
}

router.put(
  `${F}/days/:date`,
  requireManager,
  asyncHandler(async (req, res) => {
    const day = parse(DAY, req.params.date)
    const d = parse(dayFields, req.body)
    const affected = await tx(async (c) => {
      await saveDay(c, day, d, req.admin)
      return d.open ? [] : bookingsOnDay(c, day)
    })
    res.json({ date: day, ...d, bookingsToMove: affected })
  }),
)

router.post(
  `${F}/days`,
  requireManager,
  asyncHandler(async (req, res) => {
    const p = parse(z.object({ from: DAY, to: DAY, weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(), day: dayFields }).strict(), req.body)
    if (p.to < p.from || addDays(p.from, 183) < p.to) throw new HttpError(400, 'VALIDATION_ERROR', 'Choose up to six months at a time.')
    const out = await tx(async (c) => {
      let n = 0
      const affected = []
      for (let d = p.from; d <= p.to; d = addDays(d, 1)) {
        if (p.weekdays?.length && !p.weekdays.includes(new Date(`${d}T00:00:00Z`).getUTCDay())) continue
        await saveDay(c, d, p.day, req.admin)
        if (!p.day.open) affected.push(...(await bookingsOnDay(c, d)))
        n++
      }
      return { days: n, bookingsToMove: affected }
    })
    res.json(out)
  }),
)

router.put(
  `${F}/harvest/:varietyId/:date`,
  requireManager,
  asyncHandler(async (req, res) => {
    const varietyId = parse(ID, req.params.varietyId)
    const day = parse(DAY, req.params.date)
    const kg = z.number().int().min(0).max(10_000_000)
    const p = parse(
      z.object({
        estimatedKg: kg.optional(), bookableKg: kg.optional(), confirmedKg: kg.nullable().optional(),
        readiness: z.enum(['NOT_READY', 'NEARLY_READY', 'READY', 'PAST_PEAK']).optional(), qcStatus: z.enum(['PENDING', 'PASSED', 'FAILED']).optional(),
        note: z.string().trim().max(500).nullable().optional(),
      }).strict(),
      req.body,
    )
    const row = await tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM farm_varieties WHERE id = $1', [varietyId])).rowCount) throw notFound('Variety not found')
      await c.query('INSERT INTO farm_harvest (variety_id, day) VALUES ($1, $2) ON CONFLICT DO NOTHING', [varietyId, day])
      const cur = (await c.query('SELECT * FROM farm_harvest WHERE variety_id = $1 AND day = $2 FOR UPDATE', [varietyId, day])).rows[0]
      const bookable = p.bookableKg ?? cur.bookable_kg
      if (bookable < cur.reserved_kg) {
        throw new HttpError(409, 'FARM_BELOW_BOOKED', `${cur.reserved_kg} kg is already booked or held for this day, so bookable kg can’t go below that. Move or cancel bookings first.`, { reservedKg: cur.reserved_kg })
      }
      const { rows } = await c.query(
        `UPDATE farm_harvest SET estimated_kg = $3, bookable_kg = $4, confirmed_kg = $5, readiness = $6, qc_status = $7, note = $8, updated_at = $9, updated_by = $10
          WHERE variety_id = $1 AND day = $2 RETURNING *`,
        [varietyId, day, p.estimatedKg ?? cur.estimated_kg, bookable, p.confirmedKg === undefined ? cur.confirmed_kg : p.confirmedKg,
          p.readiness ?? cur.readiness, p.qcStatus ?? cur.qc_status, p.note === undefined ? cur.note : p.note || null, now(), req.admin.email],
      )
      return rows[0]
    })
    res.json({
      varietyId, date: day, estimatedKg: row.estimated_kg, bookableKg: row.bookable_kg, confirmedKg: row.confirmed_kg, reservedKg: row.reserved_kg,
      availableKg: row.bookable_kg - row.reserved_kg, readiness: row.readiness, qcStatus: row.qc_status, note: row.note,
    })
  }),
)

// ---------------------------------------------------------------- varieties

const tier = z.object({ minKg: z.number().int().min(250), pricePerKg: z.number().int().positive().max(10_000_000) }).strict()
const varietyFields = {
  name: z.string().trim().min(2).max(80),
  sku: z.string().trim().max(40).nullable().optional(),
  description: z.string().trim().max(1200).optional(),
  ripenessNote: z.string().trim().max(400).optional(),
  harvestFrom: DAY.nullable().optional(),
  harvestTo: DAY.nullable().optional(),
  pricePerKg: z.number().int().positive('Set the price per kg').max(10_000_000),
  tiers: z.array(tier).max(8).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
}
const varietyOut = (v) => ({
  id: v.id, name: v.name, sku: v.sku, description: v.description, ripenessNote: v.ripeness_note, harvestFrom: v.harvest_from, harvestTo: v.harvest_to,
  pricePerKg: v.price_per_kg, tiers: v.tiers, active: v.active, sortOrder: v.sort_order, version: v.version, updatedAt: v.updated_at,
})

function checkTiers(t = []) {
  const kgs = t.map((x) => x.minKg)
  if (new Set(kgs).size !== kgs.length) throw new HttpError(400, 'VALIDATION_ERROR', 'Each tier needs its own minimum kg.')
  return [...t].sort((a, b) => a.minKg - b.minKg)
}

router.get(`${F}/varieties`, asyncHandler(async (_req, res) => res.json((await query('SELECT * FROM farm_varieties ORDER BY sort_order, name')).rows.map(varietyOut))))

router.post(
  `${F}/varieties`,
  requireManager,
  asyncHandler(async (req, res) => {
    const p = parse(z.object(varietyFields).strict(), withoutConfirm(req.body))
    await stepUp(req, { always: true }) // a price (STEP_UP_ROUTES)
    if (p.sku && !(await query('SELECT 1 FROM products WHERE sku = $1', [p.sku])).rowCount) throw new HttpError(400, 'VALIDATION_ERROR', 'That product does not exist.')
    const { rows } = await query(
      `INSERT INTO farm_varieties (id, name, sku, description, ripeness_note, harvest_from, harvest_to, price_per_kg, tiers, active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [newId('fv'), p.name, p.sku || null, p.description ?? '', p.ripenessNote ?? '', p.harvestFrom ?? null, p.harvestTo ?? null, p.pricePerKg,
        JSON.stringify(checkTiers(p.tiers)), p.active ?? true, p.sortOrder ?? 0],
    )
    res.status(201).json(varietyOut(rows[0]))
  }),
)

router.patch(
  `${F}/varieties/:id`,
  requireManager,
  asyncHandler(async (req, res) => {
    const id = parse(ID, req.params.id)
    const p = parse(z.object({ ...Object.fromEntries(Object.entries(varietyFields).map(([k, v]) => [k, v.optional()])), version: z.number().int() }).strict(), withoutConfirm(req.body))
    // Price changes move money; a price never changes for bookings already made (they keep theirs).
    if (p.pricePerKg !== undefined || p.tiers !== undefined) await stepUp(req, { always: true })
    if (p.sku && !(await query('SELECT 1 FROM products WHERE sku = $1', [p.sku])).rowCount) throw new HttpError(400, 'VALIDATION_ERROR', 'That product does not exist.')
    const map = { name: 'name', sku: 'sku', description: 'description', ripenessNote: 'ripeness_note', harvestFrom: 'harvest_from', harvestTo: 'harvest_to', pricePerKg: 'price_per_kg', active: 'active', sortOrder: 'sort_order' }
    const sets = []
    const args = [id, p.version]
    for (const [k, col] of Object.entries(map)) if (p[k] !== undefined) sets.push(`${col} = $${args.push(p[k] === '' ? null : p[k])}`)
    if (p.tiers !== undefined) sets.push(`tiers = $${args.push(JSON.stringify(checkTiers(p.tiers)))}`)
    const { rows } = await query(`UPDATE farm_varieties SET ${[...sets, `version = version + 1`, `updated_at = $${args.push(now())}`].join(', ')} WHERE id = $1 AND version = $2 RETURNING *`, args)
    if (!rows.length) {
      if (!(await query('SELECT 1 FROM farm_varieties WHERE id = $1', [id])).rowCount) throw notFound('Variety not found')
      throw new HttpError(409, 'STALE_VARIETY', 'Someone else changed this variety. Reload to see their change.')
    }
    res.json(varietyOut(rows[0]))
  }),
)

// ---------------------------------------------------------------- rooms

const roomFields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(800).optional(),
  sleeps: z.number().int().min(0).max(1000),
  beds: z.number().int().min(0).max(1000).optional(),
  extraBeds: z.number().int().min(0).max(1000).optional(),
  active: z.boolean().optional(),
  maintenance: z.boolean().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
}
const roomOut = (r) => ({
  id: r.id, name: r.name, description: r.description, sleeps: r.sleeps, beds: r.beds, extraBeds: r.extra_beds, active: r.active, maintenance: r.maintenance,
  note: r.note, sortOrder: r.sort_order,
})

router.get(`${F}/rooms`, asyncHandler(async (_req, res) => res.json((await query('SELECT * FROM farm_rooms ORDER BY sort_order, name')).rows.map(roomOut))))

router.post(
  `${F}/rooms`,
  requireManager,
  asyncHandler(async (req, res) => {
    const p = parse(z.object(roomFields).strict(), req.body)
    const { rows } = await query(
      `INSERT INTO farm_rooms (id, name, description, sleeps, beds, extra_beds, active, maintenance, note, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [newId('frm'), p.name, p.description ?? '', p.sleeps, p.beds ?? 0, p.extraBeds ?? 0, p.active ?? true, p.maintenance ?? false, p.note || null, p.sortOrder ?? 0],
    )
    res.status(201).json(roomOut(rows[0]))
  }),
)

router.patch(
  `${F}/rooms/:id`,
  requireManager,
  asyncHandler(async (req, res) => {
    const id = parse(ID, req.params.id)
    const p = parse(z.object(Object.fromEntries(Object.entries(roomFields).map(([k, v]) => [k, v.optional()]))).strict(), req.body)
    const map = { name: 'name', description: 'description', sleeps: 'sleeps', beds: 'beds', extraBeds: 'extra_beds', active: 'active', maintenance: 'maintenance', note: 'note', sortOrder: 'sort_order' }
    const sets = []
    const args = [id]
    for (const [k, col] of Object.entries(map)) if (p[k] !== undefined) sets.push(`${col} = $${args.push(p[k])}`)
    const { rows } = await query(`UPDATE farm_rooms SET ${[...sets, `updated_at = $${args.push(now())}`].join(', ')} WHERE id = $1 RETURNING *`, args)
    if (!rows.length) throw notFound('Room not found')
    res.json(roomOut(rows[0]))
  }),
)

// ---------------------------------------------------------------- settings

router.get(
  `${F}/settings`,
  asyncHandler(async (_req, res) => {
    const s = await loadSettings({ query })
    res.json({ ...s, problems: await readinessProblems({ query }, s.settings) })
  }),
)

router.put(
  `${F}/settings`,
  requireManager,
  asyncHandler(async (req, res) => {
    const p = parse(z.object({ settings: z.record(z.string(), z.unknown()), version: z.number().int() }).strict(), withoutConfirm(req.body))
    await stepUp(req, { always: true }) // opening bookings and the policies customers agree to (STEP_UP_ROUTES)
    const saved = await tx(async (c) => {
      try {
        return await saveSettings(c, p.settings, p.version, req.admin)
      } catch (err) {
        if (err?.name === 'ZodError' || err?.issues) throw new HttpError(400, 'VALIDATION_ERROR', err.issues?.[0] ? `${err.issues[0].path.join('.')}: ${err.issues[0].message}` : 'Check the settings')
        throw err
      }
    })
    res.json({ settings: saved.settings, version: saved.version, updatedAt: saved.updatedAt, problems: await readinessProblems({ query }, saved.settings) })
  }),
)

// ---------------------------------------------------------------- reports

const range = z.object({ from: DAY, to: DAY, varietyId: ID.optional() })

router.get(`${F}/reports`, requireManager, asyncHandler(async (req, res) => res.json(await report({ query }, parse(range, clean(req.query))))))

router.get(
  `${F}/reports/bookings.csv`,
  requireManager,
  asyncHandler(async (req, res) => {
    const q = parse(range, clean(req.query))
    res.set('Content-Type', 'text/csv; charset=utf-8')
    res.set('Content-Disposition', `attachment; filename="farm-bookings-${q.from}-to-${q.to}.csv"`)
    res.set('Cache-Control', 'no-store')
    res.send(await bookingsCsv({ query }, q))
  }),
)

