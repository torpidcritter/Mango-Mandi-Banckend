// Promo codes.
import express from 'express'
import { z } from 'zod'
import { requireManager } from '../auth.js'
import { isDate, now } from '../clock.js'
import { normaliseCode, promoView } from '../promos.js'
import { query } from '../db.js'
import { asyncHandler, conflict, notFound, parse } from '../errors.js'

export const router = express.Router()

// ---------------------------------------------------------------- promo codes

router.get(
  '/promos',
  requireManager,
  asyncHandler(async (_req, res) => {
    const { rows } = await query(
      `SELECT p.*, (SELECT COUNT(*)::int FROM promo_redemptions r JOIN orders o ON o.id = r.order_id
                     WHERE r.code = p.code AND o.status <> 'CANCELLED') AS uses,
              (SELECT COALESCE(SUM(r.discount), 0)::int FROM promo_redemptions r JOIN orders o ON o.id = r.order_id
                     WHERE r.code = p.code AND o.status <> 'CANCELLED' AND o.payment_status = 'SUCCEEDED') AS given
         FROM promo_codes p ORDER BY p.active DESC, p.created_at DESC`,
    )
    res.json(rows.map((p) => ({ ...promoView(p, p.uses), discountGiven: p.given })))
  }),
)

const promoFields = {
  description: z.string().trim().max(120).optional().nullable(),
  endsOn: z.string().refine(isDate, 'Use YYYY-MM-DD').optional().nullable(),
  maxUses: z.number().int().positive().optional().nullable(),
}

router.post(
  '/promos',
  requireManager,
  asyncHandler(async (req, res) => {
    const b = parse(
      z
        .object({
          code: z.string().transform(normaliseCode).refine((c) => /^[A-Z0-9]{3,20}$/.test(c), 'Use 3 to 20 letters and digits'),
          kind: z.enum(['PERCENT', 'FLAT']),
          value: z.number().int().positive(),
          maxDiscount: z.number().int().positive().optional().nullable(),
          minSubtotal: z.number().int().min(0).default(0),
          startsOn: z.string().refine(isDate, 'Use YYYY-MM-DD').optional().nullable(),
          perCustomer: z.number().int().positive().default(1),
          firstOrderOnly: z.boolean().default(false),
          ...promoFields,
        })
        .refine((p) => p.kind !== 'PERCENT' || p.value <= 90, { message: 'A percentage is at most 90', path: ['value'] })
        .refine((p) => !p.startsOn || !p.endsOn || p.startsOn <= p.endsOn, { message: 'The end date is before the start', path: ['endsOn'] }),
      req.body,
    )
    const { rows } = await query(
      `INSERT INTO promo_codes (code, kind, value, max_discount, min_subtotal, starts_on, ends_on, max_uses, per_customer, first_order_only,
                                description, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (code) DO NOTHING RETURNING *`,
      [
        b.code, b.kind, b.value, b.maxDiscount ?? null, b.minSubtotal, b.startsOn ?? null, b.endsOn ?? null, b.maxUses ?? null,
        b.perCustomer, b.firstOrderOnly, b.description ?? null, req.admin.email, now(),
      ],
    )
    if (!rows.length) throw conflict('That code already exists', 'PROMO_EXISTS')
    req.params.id = b.code
    res.status(201).json(promoView(rows[0]))
  }),
)

/** Turn a code off or on, or change its end date, limit or note. The discount itself can't change once made. */
router.patch(
  '/promos/:code',
  requireManager,
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ active: z.boolean().optional(), ...promoFields }), req.body)
    const { rows } = await query(
      `UPDATE promo_codes SET active = COALESCE($2, active),
              description = CASE WHEN $3::boolean THEN $4 ELSE description END,
              ends_on = CASE WHEN $5::boolean THEN $6::date ELSE ends_on END,
              max_uses = CASE WHEN $7::boolean THEN $8::int ELSE max_uses END
        WHERE code = $1 RETURNING *`,
      [
        normaliseCode(req.params.code), b.active ?? null, 'description' in b, b.description ?? null, 'endsOn' in b, b.endsOn ?? null,
        'maxUses' in b, b.maxUses ?? null,
      ],
    )
    if (!rows.length) throw notFound('No promo code with that name')
    res.json(promoView(rows[0]))
  }),
)
