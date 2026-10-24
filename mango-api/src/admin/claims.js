// Claims: review, and resolve as a replacement or a rejection.
import express from 'express'
import { z } from 'zod'
import { now } from '../clock.js'
import { isOwnPhotoUrl, sendPhoto } from '../photos.js'
import { query, tx } from '../db.js'
import { env } from '../env.js'
import { asyncHandler, badRequest, conflict, HttpError, notFound, parse } from '../errors.js'
import { createReplacement } from '../orders.js'
import { enqueue } from '../notify.js'
import { LIST_LIMIT } from './shared.js'

export const router = express.Router()

// ---------------------------------------------------------------- claims

/** Replacements in 90 days after which the next one needs a manager. */
export const CLAIM_MANAGER_AFTER = 2

/**
 * What staff should know before approving a replacement: how many claims the
 * customer made lately, and how the order was delivered. A frequent claimant,
 * or "not delivered" on an order the customer's own code confirmed, needs a
 * manager to approve.
 */
async function claimRisk(c, claim) {
  return (await claimRisks(c, [claim])).get(claim.id)
}

/** claimRisk for many claims in two queries (the claims list), Map claim id → risk. */
async function claimRisks(c, claims) {
  const out = new Map()
  if (!claims.length) return out
  const since = new Date(now().getTime() - 90 * 86_400_000)
  const [hist, del] = await Promise.all([
    c.query(
      `SELECT x.id, COUNT(o.id)::int AS claims, COUNT(o.id) FILTER (WHERE o.resolution = 'REPLACEMENT_APPROVED')::int AS replacements
         FROM claims x LEFT JOIN claims o ON o.customer_id = x.customer_id AND o.created_at >= $2 AND o.id <> x.id
        WHERE x.id = ANY($1) GROUP BY x.id`,
      [claims.map((cl) => cl.id), since],
    ),
    c.query(
      `SELECT DISTINCT ON (order_id) order_id, method, created_at FROM delivery_attempts
        WHERE order_id = ANY($1) AND outcome = 'DELIVERED' ORDER BY order_id, created_at DESC`,
      [[...new Set(claims.map((cl) => cl.order_id))]],
    ),
  ])
  const hists = new Map(hist.rows.map((h) => [h.id, h]))
  const dels = new Map(del.rows.map((d) => [d.order_id, d]))
  for (const claim of claims) {
    const h = hists.get(claim.id) ?? { claims: 0, replacements: 0 }
    const d = dels.get(claim.order_id)
    const reasons = []
    if (h.replacements >= CLAIM_MANAGER_AFTER) reasons.push(`${h.replacements} replacements in the last 90 days`)
    if (claim.issue_type === 'NOT_DELIVERED' && d?.method === 'code') reasons.push("the customer's own code confirmed the delivery")
    out.set(claim.id, {
      history: { claims90d: h.claims, replacements90d: h.replacements },
      delivery: d ? { method: d.method, at: d.created_at } : null,
      managerNeeded: reasons.length ? reasons : null,
    })
  }
  return out
}


router.get(
  '/claims',
  asyncHandler(async (req, res) => {
    const status = req.query.status ? parse(z.enum(['SUBMITTED', 'UNDER_REVIEW', 'RESOLVED']), req.query.status) : null
    const { rows } = await query(
      `SELECT c.*, o.number AS order_number, o.total AS order_total, o.phone, r.number AS replacement_number
         FROM claims c JOIN orders o ON o.id = c.order_id LEFT JOIN orders r ON r.id = c.replacement_order_id
        WHERE ($1::text IS NULL AND c.status IN ('SUBMITTED', 'UNDER_REVIEW')) OR c.status = $1
        ORDER BY CASE WHEN c.status = 'RESOLVED' THEN -extract(epoch FROM c.created_at) ELSE extract(epoch FROM c.created_at) END, c.id
        LIMIT $2`,
      [status, LIST_LIMIT],
    )
    const pics = await query('SELECT id, claim_id FROM claim_photos WHERE claim_id = ANY($1) ORDER BY created_at', [rows.map((c) => c.id)])
    const photosOf = Map.groupBy(pics.rows, (p) => p.claim_id)
    const risks = await claimRisks({ query }, rows.filter((c) => c.status !== 'RESOLVED'))
    res.json(
      rows.map((c) => ({
        ...(risks.has(c.id) ? risks.get(c.id) : {}),
        photos: (photosOf.get(c.id) ?? []).map((p) => ({ id: p.id })),
        id: c.id, orderId: c.order_id, orderNumber: c.order_number, orderTotal: c.order_total, customerPhone: c.phone,
        issueType: c.issue_type, description: c.description, affectedItems: c.affected_items, photoUrl: isOwnPhotoUrl(c.photo_url) ? c.photo_url : null,
        status: c.status, resolution: c.resolution, rejectionReason: c.resolution_note ?? null, createdAt: c.created_at,
        replacementOrder: c.replacement_order_id ? { id: c.replacement_order_id, number: c.replacement_number } : null,
      })),
    )
  }),
)

router.get(
  '/claims/:id/photos/:photoId',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT mime, bytes, blob_path FROM claim_photos WHERE id = $1 AND claim_id = $2', [req.params.photoId, req.params.id])
    if (!rows.length) throw notFound('Photo not found')
    await sendPhoto(res, rows[0])
  }),
)

router.post(
  '/claims/:id/review',
  asyncHandler(async (req, res) => {
    const r = await query(`UPDATE claims SET status = 'UNDER_REVIEW' WHERE id = $1 AND status = 'SUBMITTED'`, [req.params.id])
    if (!r.rowCount) throw notFound('Claim not found or not awaiting review')
    res.status(204).end()
  }),
)

router.post(
  '/claims/:id/resolve',
  asyncHandler(async (req, res) => {
    if (req.body?.resolution === 'REFUND_APPROVED') throw badRequest('MandiMangoes does not refund. Approve a replacement or reject the claim.', 'NO_REFUNDS')
    // UX-4: a rejection says why. The customer sees the reason on the order page and on WhatsApp.
    const { resolution, reason } = parse(
      z
        .object({ resolution: z.enum(['REPLACEMENT_APPROVED', 'REJECTED']), reason: z.string().trim().max(500).optional() })
        .refine((x) => x.resolution !== 'REJECTED' || (x.reason?.length ?? 0) >= 5, { message: 'Say why the claim is rejected (5 characters or more). The customer sees this.', path: ['reason'] }),
      req.body,
    )
    await tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM claims WHERE id = $1 FOR UPDATE', [req.params.id])
      if (!rows.length) throw notFound('Claim not found')
      const claim = rows[0]
      if (claim.status === 'RESOLVED') throw conflict('This claim is already resolved')
      let replacementId = null
      if (resolution === 'REPLACEMENT_APPROVED') {
        const risk = await claimRisk(c, claim)
        if (risk.managerNeeded && req.admin.role !== 'MANAGER') {
          throw new HttpError(403, 'MANAGER_REQUIRED', `A manager has to approve this replacement: ${risk.managerNeeded.join(', and ')}.`)
        }
        const { rows: o } = await c.query('SELECT * FROM orders WHERE id = $1', [claim.order_id])
        replacementId = (await createReplacement(c, claim, o[0], req.actor)).id
      }
      await c.query(
        `UPDATE claims SET status = 'RESOLVED', resolution = $2, replacement_order_id = $3, resolved_by = $4, resolved_at = $5, resolution_note = $6 WHERE id = $1`,
        [claim.id, resolution, replacementId, req.admin.email, now(), resolution === 'REJECTED' ? reason : null],
      )
      // A replacement already sends mandi_replacement_confirmed; a rejection sends its reason.
      if (resolution === 'REJECTED' && env.WHATSAPP_CLAIM_UPDATES) await enqueue(c, claim.order_id, claim.id, 'CLAIM_REJECTED')
    })
    res.status(204).end()
  }),
)
