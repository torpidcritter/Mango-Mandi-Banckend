// Preorders and weekly preorder capacity.
import express from 'express'
import { z } from 'zod'
import { requireManager } from '../auth.js'
import { addDays, isDate, todayIST } from '../clock.js'
import { query, tx } from '../db.js'
import { asyncHandler, badRequest, parse } from '../errors.js'
import { isMonday, preorderView, PREORDER_STATUSES, promoteWaitlist, refundPreorder, staffCancelPreorder } from '../preorders.js'
import { refundOrder } from '../payments.js'
import { logger } from '../logger.js'
import { productName, sellable } from '../products.js'

export const router = express.Router()

// ---------------------------------------------------------------- preorders

router.get(
  '/preorders',
  asyncHandler(async (req, res) => {
    const f = parse(
      z.object({ status: z.enum(PREORDER_STATUSES).optional(), week: z.string().refine(isDate, 'week must be YYYY-MM-DD').optional() }),
      Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '')),
    )
    const { rows } = await query(
      `SELECT p.*, o.number AS order_number, o.status AS order_status, o.delivery_date AS order_date FROM preorders p LEFT JOIN orders o ON o.id = p.order_id
        WHERE ($1::text IS NULL OR p.status = $1) AND ($2::date IS NULL OR p.week_start = $2)
        ORDER BY p.week_start, p.created_at LIMIT 500`,
      [f.status ?? null, f.week ?? null],
    )
    res.json(rows.map((p) => ({
      ...preorderView(p),
      order: p.order_id ? { id: p.order_id, number: p.order_number, status: p.order_status, deliveryDate: p.order_date } : null,
    })))
  }),
)

/** Manager cancel of a booking we can't fill: frees the capacity and refunds a paid booking in full. */
router.post(
  '/preorders/:id/cancel',
  requireManager,
  asyncHandler(async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(1, 'reason is required').max(500) }), req.body ?? {})
    const r = await tx((c) => staffCancelPreorder(c, req.params.id, req.actor, reason))
    const send = r.refund === 'order' ? refundOrder : r.refund === 'preorder' ? refundPreorder : null
    if (send) await send(r.id).catch((err) => logger.error({ err, id: r.id }, 'refund failed; maintenance will retry'))
    res.json({ refunded: Boolean(r.refund) })
  }),
)

router.get(
  '/preorder-capacity',
  asyncHandler(async (_req, res) => {
    const { rows } = await query(
      `SELECT k.*, (SELECT COUNT(*)::int FROM preorders p WHERE p.sku = k.sku AND p.week_start = k.week_start AND p.status = 'WAITLISTED') AS waitlisted
         FROM preorder_capacity k WHERE k.week_start >= $1 ORDER BY k.week_start, k.sku`,
      [addDays(todayIST(), -7)],
    )
    res.json(rows.map((k) => ({ sku: k.sku, productName: productName(k.sku), weekStart: k.week_start, capacity: k.capacity, reserved: k.reserved, waitlisted: k.waitlisted })))
  }),
)

/** Sets a week's preorder capacity for a SKU. Lowering it never cancels bookings; raising it promotes the waitlist. */
router.put(
  '/preorder-capacity/:weekStart/:sku',
  requireManager,
  asyncHandler(async (req, res) => {
    const weekStart = parse(z.string().refine((d) => isDate(d) && isMonday(d), 'weekStart must be a Monday (YYYY-MM-DD)'), req.params.weekStart)
    if (!sellable(req.params.sku)) throw badRequest(`Unknown SKU ${req.params.sku}`, 'INVALID_SKU')
    const { capacity } = parse(z.object({ capacity: z.number().int().min(0).max(100_000) }), req.body)
    const { rows } = await query(
      `INSERT INTO preorder_capacity (sku, week_start, capacity) VALUES ($1, $2, $3)
       ON CONFLICT (sku, week_start) DO UPDATE SET capacity = $3 RETURNING *`,
      [req.params.sku, weekStart, capacity],
    )
    await promoteWaitlist().catch(() => {}) // maintenance retries
    res.json({ sku: rows[0].sku, weekStart: rows[0].week_start, capacity: rows[0].capacity, reserved: rows[0].reserved })
  }),
)
