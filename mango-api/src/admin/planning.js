// Planning: pincodes, rules, the delivery calendar, slots, and supply coverage.
import express from 'express'
import { z } from 'zod'
import { requireManager } from '../auth.js'
import { addDays, isDate, now, todayIST } from '../clock.js'
import { currentConfig, rulesSchema, saveConfig } from '../config.js'
import { query, tx } from '../db.js'
import { orderableDates, slotsForDate, slotView } from '../delivery.js'
import { asyncHandler, badRequest, notFound, parse } from '../errors.js'
import { newId } from '../ids.js'
import { availability } from '../inventory.js'
import { triggerRebalanceAll } from '../maintenance.js'
import { shopProducts } from '../products.js'
import { STAGES } from '../stage.js'

export const router = express.Router()

// ---------------------------------------------------------------- pincodes

const pincodeDto = (p) => ({ pincode: p.pincode, city: p.city, zone: p.zone, active: p.active })
const PIN = z.string().regex(/^\d{6}$/, 'pincode must be 6 digits')

router.get('/pincodes', asyncHandler(async (_req, res) => res.json((await query('SELECT * FROM pincodes ORDER BY pincode')).rows.map(pincodeDto))))

router.post(
  '/pincodes',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ pincode: PIN, city: z.string().trim().min(1, 'city is required').max(80), zone: z.string().trim().max(80).optional().nullable() }), req.body)
    const { rows } = await query(
      `INSERT INTO pincodes (pincode, city, zone, active) VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (pincode) DO UPDATE SET city = EXCLUDED.city, zone = EXCLUDED.zone, active = TRUE RETURNING *`,
      [b.pincode, b.city, b.zone || null],
    )
    res.status(201).json(pincodeDto(rows[0]))
  }),
)

router.patch(
  '/pincodes/:pincode',
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({ city: z.string().trim().min(1).max(80).optional(), zone: z.string().trim().max(80).nullable().optional(), active: z.boolean().optional() }),
      req.body,
    )
    const { rows } = await query(
      `UPDATE pincodes SET city = COALESCE($2, city), zone = CASE WHEN $5 THEN $3 ELSE zone END, active = COALESCE($4, active)
        WHERE pincode = $1 RETURNING *`,
      [req.params.pincode, b.city ?? null, b.zone ?? null, b.active ?? null, 'zone' in b],
    )
    if (!rows.length) throw notFound('Pincode not found')
    res.json(pincodeDto(rows[0]))
  }),
)

router.delete(
  '/pincodes/:pincode',
  requireManager,
  asyncHandler(async (req, res) => {
    const r = await query('DELETE FROM pincodes WHERE pincode = $1', [req.params.pincode])
    if (!r.rowCount) throw notFound('Pincode not found')
    res.status(204).end()
  }),
)

// ---------------------------------------------------------------- rules, calendar, coverage

router.get('/config', (_req, res) => {
  const { version, rules } = currentConfig()
  res.json({ version, rules })
})

router.put(
  '/config',
  requireManager,
  asyncHandler(async (req, res) => {
    const rules = parse(rulesSchema, req.body?.rules ?? req.body)
    const saved = await saveConfig(rules, req.admin.email)
    await triggerRebalanceAll() // new windows can invalidate allocations
    res.json(saved)
  }),
)

router.get(
  '/calendar',
  asyncHandler(async (req, res) => {
    const from = isDate(req.query.from) ? req.query.from : todayIST()
    const to = isDate(req.query.to) ? req.query.to : addDays(from, 60)
    const { rows } = await query('SELECT * FROM delivery_calendar WHERE date BETWEEN $1 AND $2 ORDER BY date', [from, to])
    res.json(rows.map((r) => ({ date: r.date, isOpen: r.is_open, maxBoxes: r.max_boxes, note: r.note })))
  }),
)

router.put(
  '/calendar/:date',
  asyncHandler(async (req, res) => {
    if (!isDate(req.params.date)) throw badRequest('date must be YYYY-MM-DD')
    const b = parse(
      z.object({ isOpen: z.boolean(), maxBoxes: z.number().int().min(0).nullable().optional(), note: z.string().trim().max(200).nullable().optional() }),
      req.body,
    )
    await query(
      `INSERT INTO delivery_calendar (date, is_open, max_boxes, note) VALUES ($1, $2, $3, $4)
       ON CONFLICT (date) DO UPDATE SET is_open = EXCLUDED.is_open, max_boxes = EXCLUDED.max_boxes, note = EXCLUDED.note`,
      [req.params.date, b.isOpen, b.maxBoxes ?? null, b.note ?? null],
    )
    res.status(204).end()
  }),
)

router.delete(
  '/calendar/:date',
  asyncHandler(async (req, res) => {
    if (!isDate(req.params.date)) throw badRequest('date must be YYYY-MM-DD')
    await query('DELETE FROM delivery_calendar WHERE date = $1', [req.params.date])
    res.status(204).end()
  }),
)

const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)')
const slotBody = z.object({
  label: z.string().trim().min(1).max(40),
  startsAt: TIME,
  endsAt: TIME,
  maxBoxes: z.number().int().min(0).nullable().optional(),
  active: z.boolean().optional(),
  sort: z.number().int().min(0).max(1000).optional(),
})

router.get(
  '/slots',
  asyncHandler(async (_req, res) => {
    const { rows } = await query('SELECT * FROM delivery_slots ORDER BY sort, starts_at, id')
    res.json(rows.map(slotView))
  }),
)

router.post(
  '/slots',
  requireManager,
  asyncHandler(async (req, res) => {
    const b = parse(slotBody.refine((s) => s.endsAt > s.startsAt, { message: 'The slot must end after it starts', path: ['endsAt'] }), req.body)
    const { rows } = await query(
      `INSERT INTO delivery_slots (id, label, starts_at, ends_at, max_boxes, active, sort, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [newId('slt'), b.label, b.startsAt, b.endsAt, b.maxBoxes ?? null, b.active ?? true, b.sort ?? 0, now()],
    )
    res.status(201).json(slotView(rows[0]))
  }),
)

/** Slots are switched off rather than deleted: orders keep pointing at them. */
router.patch(
  '/slots/:id',
  requireManager,
  asyncHandler(async (req, res) => {
    const b = parse(slotBody.partial(), req.body)
    const out = await tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM delivery_slots WHERE id = $1 FOR UPDATE', [req.params.id])
      if (!rows.length) throw notFound('Slot not found')
      const s = { ...slotView(rows[0]), ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) }
      if (!(s.endsAt > s.startsAt)) throw badRequest('The slot must end after it starts', 'VALIDATION_ERROR')
      const r = await c.query(
        'UPDATE delivery_slots SET label = $2, starts_at = $3, ends_at = $4, max_boxes = $5, active = $6, sort = $7 WHERE id = $1 RETURNING *',
        [s.id, s.label, s.startsAt, s.endsAt, s.maxBoxes ?? null, s.active, s.sort],
      )
      return slotView(r.rows[0])
    })
    res.json(out)
  }),
)


/** Sellable boxes per SKU and stage for each orderable date: the supply-coverage grid. */
router.get(
  '/coverage',
  asyncHandler(async (_req, res) => {
    const out = await tx(async (c) => {
      const dates = await orderableDates(c)
      const grid = []
      for (const date of dates) {
        const pool = await availability(c, date)
        grid.push({
          date,
          slots: (await slotsForDate(c, date)).map(({ id, label, booked, maxBoxes }) => ({ id, label, booked, maxBoxes })),
          stock: shopProducts().flatMap((p) => STAGES.map((stage) => ({ sku: p.sku, stage, qty: pool.get(`${p.sku}|${stage}`) ?? 0 }))),
        })
      }
      return grid
    })
    res.json(out)
  }),
)
