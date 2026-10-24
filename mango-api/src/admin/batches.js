// Batches: intake, status, QC, stock adjustments, the ledger.
import express from 'express'
import { z } from 'zod'
import { requireManager } from '../auth.js'
import { addDays, diffDays, isDate, now, todayIST } from '../clock.js'
import { currentConfig } from '../config.js'
import { query, tx } from '../db.js'
import { asyncHandler, badRequest, HttpError, notFound, parse } from '../errors.js'
import { newId } from '../ids.js'
import { ADJUST_REASONS, ledger } from '../inventory.js'
import { lockBatchOrders, rebalanceBatchOrders, recordShortArrival, takeBatchOutOfService } from '../orders.js'
import { findProduct, productName } from '../products.js'
import { STAGES } from '../stage.js'
import { LIST_LIMIT } from './shared.js'

export const router = express.Router()

const available = (l) => Math.max(0, l.on_hand - l.held - l.committed - l.reserve_buffer)

// ---------------------------------------------------------------- batches

const BATCH_FLOW = ['ARRIVING', 'IN_TRANSIT', 'ARRIVED', 'RIPENING', 'SELLING', 'EXHAUSTED']
const BATCH_STATUSES = [...BATCH_FLOW, 'CONDEMNED']
const ARRIVED_OR_LATER = ['ARRIVED', 'RIPENING', 'SELLING', 'EXHAUSTED']

const batchListSql = `
  SELECT b.id, b.variety, b.plucked_on, b.farm, b.status, b.created_at,
         q.ripeness_rating, q.condition,
         COALESCE(SUM(l.on_hand), 0)::int AS on_hand, COALESCE(SUM(l.held), 0)::int AS held,
         COALESCE(SUM(l.committed), 0)::int AS committed,
         COALESCE(SUM(GREATEST(l.on_hand - l.held - l.committed - l.reserve_buffer, 0)), 0)::int AS available
    FROM batches b
    LEFT JOIN batch_lines l ON l.batch_id = b.id
    LEFT JOIN LATERAL (SELECT ripeness_rating, condition FROM batch_qc WHERE batch_id = b.id ORDER BY logged_at DESC LIMIT 1) q ON TRUE`

router.get(
  '/batches',
  asyncHandler(async (req, res) => {
    const status = req.query.status ? parse(z.enum(BATCH_STATUSES), req.query.status) : null
    const { rows } = await query(
      `${batchListSql} WHERE ($1::text IS NULL OR b.status = $1)
        GROUP BY b.id, q.ripeness_rating, q.condition ORDER BY b.plucked_on DESC, b.created_at DESC LIMIT $2`,
      [status, LIST_LIMIT],
    )
    const today = todayIST()
    res.json(
      rows.map((b) => ({
        id: b.id, variety: b.variety, pluckedOn: b.plucked_on, ageDays: diffDays(today, b.plucked_on), farm: b.farm,
        status: b.status, latestRating: b.ripeness_rating ?? null, latestCondition: b.condition ?? null,
        onHand: b.on_hand, held: b.held, committed: b.committed, available: b.available,
      })),
    )
  }),
)

async function batchDetail(c, batchId) {
  const { rows } = await c.query('SELECT * FROM batches WHERE id = $1', [batchId])
  if (!rows.length) throw notFound('Batch not found')
  const b = rows[0]
  const [lines, qc] = await Promise.all([
    // packed_here: boxes packed for orders that haven't left yet. They are off on_hand but still on the shelf, so a count includes them (INV-D).
    c.query(
      `SELECT l.*, COALESCE((SELECT SUM(s.quantity) FROM order_stock s JOIN orders o ON o.id = s.order_id
                              WHERE s.line_id = l.id AND s.state = 'packed' AND o.status IN ('CONFIRMED', 'PROCESSING', 'PACKED')), 0)::int AS packed_here
         FROM batch_lines l WHERE l.batch_id = $1 ORDER BY l.sku`,
      [batchId],
    ),
    c.query('SELECT * FROM batch_qc WHERE batch_id = $1 ORDER BY logged_at DESC', [batchId]),
  ])
  return {
    id: b.id, variety: b.variety, pluckedOn: b.plucked_on, ageDays: diffDays(todayIST(), b.plucked_on), farm: b.farm,
    status: b.status, etaDate: b.eta_date, arrivedAt: b.arrived_at, createdAt: b.created_at,
    // The QR printed on each box opens this page in the shop.
    lines: lines.rows.map((l) => ({
      id: l.id, sku: l.sku, productName: productName(l.sku), onHand: l.on_hand, held: l.held, committed: l.committed,
      reserveBuffer: l.reserve_buffer, available: available(l), packedNotDispatched: l.packed_here,
    })),
    qc: qc.rows.map((q) => ({
      id: q.id, ripenessRating: q.ripeness_rating, condition: q.condition, notes: q.notes, loggedBy: q.logged_by, loggedAt: q.logged_at,
    })),
  }
}

router.post(
  '/batches',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        variety: z.string().trim().min(1).max(60),
        pluckedOn: z.string().refine(isDate, 'must be a date (YYYY-MM-DD)'),
        farm: z.string().trim().max(120).optional().nullable(),
        lines: z.array(z.object({ sku: z.string().min(1), onHand: z.number().int().min(0).max(100_000) })).min(1).max(20),
      }),
      req.body,
    )
    if (body.pluckedOn > todayIST()) throw badRequest('pluckedOn cannot be in the future')
    const seen = new Set()
    for (const l of body.lines) {
      const p = findProduct(l.sku)
      if (!p) throw badRequest(`Unknown SKU ${l.sku}`, 'INVALID_SKU')
      if (!p.active) throw badRequest(`${p.name} has been removed from sale`, 'PRODUCT_INACTIVE')
      if (p.variety !== body.variety) throw badRequest(`${l.sku} is not a ${body.variety} SKU`, 'INVALID_SKU')
      if (seen.has(l.sku)) throw badRequest(`${l.sku} is listed twice`)
      seen.add(l.sku)
    }
    const detail = await tx(async (c) => {
      const batchId = newId('bat')
      await c.query('INSERT INTO batches (id, variety, plucked_on, farm, eta_date, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [
        batchId, body.variety, body.pluckedOn, body.farm || null, addDays(body.pluckedOn, currentConfig().rules.transitDays), now(),
      ])
      for (const l of body.lines) {
        await c.query('INSERT INTO batch_lines (id, batch_id, sku, on_hand) VALUES ($1, $2, $3, $4)', [newId('bl'), batchId, l.sku, l.onHand])
        if (l.onHand) await ledger(c, { batchId, eventType: 'INTAKE', sku: l.sku, delta: l.onHand, actorId: req.admin.id, reason: 'Batch received', reasonCode: 'RECEIVED' })
      }
      return batchDetail(c, batchId)
    })
    res.status(201).json(detail)
  }),
)

router.get('/batches/:id', asyncHandler(async (req, res) => res.json(await batchDetail({ query }, req.params.id))))

router.patch(
  '/batches/:id/status',
  asyncHandler(async (req, res, next) => {
    const { status, reason } = parse(
      z.object({ status: z.enum(BATCH_STATUSES), reason: z.string().trim().max(500).optional() }),
      req.body,
    )
    if (status === 'CONDEMNED' && req.admin.role !== 'MANAGER') return requireManager(req, res, next)
    const result = await tx(async (c) => {
      await lockBatchOrders(c, [req.params.id]) // orders before the batch (INV-03)
      const { rows } = await c.query('SELECT * FROM batches WHERE id = $1 FOR UPDATE', [req.params.id])
      if (!rows.length) throw notFound('Batch not found')
      const b = rows[0]
      if (['EXHAUSTED', 'CONDEMNED'].includes(b.status)) throw badRequest(`This batch is ${b.status} and cannot change`, 'INVALID_TRANSITION')
      if (status === 'EXHAUSTED') {
        // INV-4: exhausting writes off whatever is left, for good. Boxes still on
        // the shelf need a manager and a reason; an empty batch is just closed.
        const { rows: left } = await c.query('SELECT COALESCE(SUM(on_hand), 0)::int AS n FROM batch_lines WHERE batch_id = $1', [b.id])
        if (left[0].n > 0) {
          if (req.admin.role !== 'MANAGER') {
            throw new HttpError(403, 'FORBIDDEN', `${left[0].n} boxes are still on hand. Only a manager can write them off.`)
          }
          if (!reason) throw badRequest(`Say why the ${left[0].n} boxes still on hand are being written off`, 'REASON_REQUIRED')
        }
      }
      if (status !== 'CONDEMNED' && BATCH_FLOW.indexOf(status) <= BATCH_FLOW.indexOf(b.status)) {
        throw badRequest(`Cannot move a batch from ${b.status} back to ${status}`, 'INVALID_TRANSITION')
      }
      const arrivedAt = !b.arrived_at && ARRIVED_OR_LATER.includes(status) ? now() : b.arrived_at
      await c.query('UPDATE batches SET status = $2, arrived_at = $3 WHERE id = $1', [b.id, status, arrivedAt])
      await ledger(c, {
        batchId: b.id, eventType: 'STATUS', sku: null, delta: 0, actorId: req.admin.id, reason: `${b.status} → ${status}${reason ? `: ${reason}` : ''}`,
      })
      const actor = req.actor
      if (status === 'CONDEMNED' || status === 'EXHAUSTED') return takeBatchOutOfService(c, b.id, status, actor, reason || null)
      const touched = await rebalanceBatchOrders(c, [b.id], actor)
      return { rebalancedOrders: touched.filter((r) => r.changed && !r.atRisk).map((r) => r.number), atRiskOrders: touched.filter((r) => r.atRisk).map((r) => r.number) }
    })
    if (status === 'CONDEMNED') return res.json(result)
    res.status(204).end()
  }),
)

router.post(
  '/batches/:id/qc',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        ripenessRating: z.enum(STAGES),
        condition: z.enum(['GOOD', 'FAIR', 'REJECT']),
        notes: z.string().trim().max(1000).optional().nullable(),
      }),
      req.body,
    )
    const out = await tx(async (c) => {
      await lockBatchOrders(c, [req.params.id]) // orders before the batch (INV-03)
      const { rows } = await c.query('SELECT id, status FROM batches WHERE id = $1 FOR UPDATE', [req.params.id])
      if (!rows.length) throw notFound('Batch not found')
      if (['EXHAUSTED', 'CONDEMNED'].includes(rows[0].status)) throw badRequest(`This batch is ${rows[0].status}`, 'INVALID_TRANSITION')
      // Lock the lines before the reading lands: an allocation in flight either
      // finishes first (and is rebalanced below) or re-checks the stage after us (INV-6).
      await c.query('SELECT id FROM batch_lines WHERE batch_id = $1 ORDER BY id FOR UPDATE', [req.params.id])
      const today = todayIST()
      const dup = await c.query(
        `SELECT 1 FROM batch_qc WHERE batch_id = $1 AND logged_by = $2 AND (logged_at AT TIME ZONE 'Asia/Kolkata')::date = $3 LIMIT 1`,
        [req.params.id, req.admin.email, today],
      )
      const qcId = newId('qc')
      await c.query(
        'INSERT INTO batch_qc (id, batch_id, ripeness_rating, condition, notes, logged_by, logged_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [qcId, req.params.id, body.ripenessRating, body.condition, body.notes || null, req.admin.email, now()],
      )
      // A QC reading can shift the batch's stage: re-check every order on it.
      const touched = await rebalanceBatchOrders(c, [req.params.id], req.actor)
      return {
        id: qcId,
        ...(dup.rowCount ? { warning: 'QC already logged today by this user' } : {}),
        rebalancedOrders: touched.filter((r) => r.changed && !r.atRisk).map((r) => r.number),
        atRiskOrders: touched.filter((r) => r.atRisk).map((r) => r.number),
      }
    })
    res.status(201).json(out)
  }),
)

/**
 * An increase above this many boxes, or this share of what arrived, needs a
 * manager (INV-04). INV-C: the limit is on what non-managers changed on the line
 * today in total (so five +20s count as +100), and big decreases need one too.
 */
const BIG_INCREASE_BOXES = 20
const BIG_INCREASE_SHARE = 0.1

/**
 * Refuses a change of `delta` boxes to a line's on-hand count when it takes
 * today's non-manager increases (or decreases) on the line past the limit.
 * Returns the note a manager's large change adds to the reason, or null.
 */
async function checkAdjustLimit(c, req, l, delta) {
  if (delta === 0) return null
  const { rows } = await c.query(
    `SELECT COALESCE((SELECT SUM(delta) FROM batch_ledger WHERE batch_id = $1 AND sku = $2 AND event_type = 'INTAKE'), 0)::int AS intake,
            COALESCE(SUM(g.delta) FILTER (WHERE g.delta > 0), 0)::int AS up,
            COALESCE(-SUM(g.delta) FILTER (WHERE g.delta < 0), 0)::int AS down
       FROM batch_ledger g
       LEFT JOIN admin_users a ON a.id = g.actor_id OR a.email = g.actor_id
      WHERE g.batch_id = $1 AND g.sku = $2 AND g.event_type = 'ADJUST' AND g.actor_type = 'admin'
        AND (g.created_at AT TIME ZONE 'Asia/Kolkata')::date = $3::date AND a.role IS DISTINCT FROM 'MANAGER'`,
    [l.batch_id, l.sku, todayIST()],
  )
  const r = rows[0]
  const limit = Math.max(BIG_INCREASE_BOXES, Math.ceil(r.intake * BIG_INCREASE_SHARE))
  const today = delta > 0 ? r.up + delta : r.down - delta
  if (today <= limit) return null
  if (req.admin.role !== 'MANAGER') {
    const sofar = delta > 0 ? r.up : r.down
    throw new HttpError(
      403,
      'MANAGER_APPROVAL_NEEDED',
      `${delta > 0 ? 'Adding' : 'Removing'} more than ${limit} boxes on a line in one day needs a manager${sofar ? ` (${sofar} already ${delta > 0 ? 'added' : 'removed'} today)` : ''}. Ask a manager to make this change.`,
      { limit, today: sofar },
    )
  }
  return `large ${delta > 0 ? 'increase' : 'decrease'} of ${Math.abs(delta)}, by a manager`
}

const reasonCode = z.enum(ADJUST_REASONS)

router.patch(
  '/batches/:id/lines/:lineId',
  asyncHandler(async (req, res) => {
    const body = parse(
      z
        .object({
          onHand: z.number().int().min(0).max(100_000).optional(),
          reserveBuffer: z.number().int().min(0).max(100_000).optional(),
          reason: z.string().trim().min(1, 'reason is required').max(500),
          // INV-D: why, as a code the owner can report on. Older clients send none (OTHER).
          reasonCode: reasonCode.optional(),
        })
        .refine((b) => b.onHand !== undefined || b.reserveBuffer !== undefined, 'Change onHand or reserveBuffer'),
      req.body,
    )
    await tx(async (c) => {
      const { rows } = await c.query(
        `SELECT l.*, b.status FROM batch_lines l JOIN batches b ON b.id = l.batch_id WHERE l.id = $1 AND l.batch_id = $2 FOR UPDATE OF l`,
        [req.params.lineId, req.params.id],
      )
      if (!rows.length) throw notFound('Batch line not found')
      const l = rows[0]
      if (['EXHAUSTED', 'CONDEMNED'].includes(l.status)) throw badRequest(`This batch is ${l.status}`, 'INVALID_TRANSITION')
      const onHand = body.onHand ?? l.on_hand
      const buffer = body.reserveBuffer ?? l.reserve_buffer
      if (onHand < l.held + l.committed) {
        throw new HttpError(
          400,
          'BELOW_COMMITTED',
          `On hand cannot go below the ${l.held + l.committed} boxes already promised to orders. If fewer boxes arrived than expected, record a short arrival.`,
          { promised: l.held + l.committed },
        )
      }
      if (onHand - l.held - l.committed - buffer < 0) throw badRequest('The reserve buffer is larger than the free stock', 'BUFFER_TOO_LARGE')
      // INV-04 / INV-C: boxes that appear from nowhere get sold, and boxes that vanish may be theft. Big changes need a manager.
      const note = await checkAdjustLimit(c, req, l, onHand - l.on_hand)
      const reason = note ? `${body.reason} (${note})` : body.reason
      const code = body.reasonCode ?? 'OTHER'
      await c.query('UPDATE batch_lines SET on_hand = $2, reserve_buffer = $3 WHERE id = $1', [l.id, onHand, buffer])
      if (onHand !== l.on_hand) {
        await ledger(c, { batchId: l.batch_id, eventType: 'ADJUST', sku: l.sku, delta: onHand - l.on_hand, actorId: req.admin.id, reason, reasonCode: code })
      }
      if (buffer !== l.reserve_buffer) {
        await ledger(c, { batchId: l.batch_id, eventType: 'ADJUST_BUFFER', sku: l.sku, delta: buffer - l.reserve_buffer, actorId: req.admin.id, reason: body.reason, reasonCode: code })
      }
    })
    res.status(204).end()
  }),
)

/**
 * Fewer boxes arrived than were promised (INV-3): lowers on_hand below what
 * is committed, gives the youngest orders' boxes back and re-fills or moves
 * those orders (orders.js recordShortArrival). A big drop needs a manager (INV-C).
 */
router.post(
  '/batches/:id/lines/:lineId/short-arrival',
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({
        onHand: z.number().int().min(0).max(100_000),
        reason: z.string().trim().min(1, 'reason is required').max(500),
        reasonCode: reasonCode.optional(),
      }),
      req.body,
    )
    const out = await tx((c) =>
      recordShortArrival(
        c,
        {
          batchId: req.params.id, lineId: req.params.lineId, onHand: b.onHand, reason: b.reason, reasonCode: b.reasonCode ?? 'RECEIVED',
          check: (cc, l, delta) => checkAdjustLimit(cc, req, l, delta),
        },
        req.actor,
      ),
    )
    res.json(out)
  }),
)

router.get(
  '/batches/:id/ledger',
  asyncHandler(async (req, res) => {
    // actor_id is the staff id (older rows: the email); the email comes from the staff list (INV-I).
    const { rows } = await query(
      `SELECT g.*, a.email AS actor_email FROM batch_ledger g
         LEFT JOIN admin_users a ON g.actor_type = 'admin' AND (a.id = g.actor_id OR a.email = g.actor_id)
        WHERE g.batch_id = $1 ORDER BY g.created_at DESC, g.id DESC LIMIT 200`,
      [req.params.id],
    )
    res.json(
      rows.map((r) => ({
        id: r.id, eventType: r.event_type, sku: r.sku, delta: r.delta, actorType: r.actor_type, actorId: r.actor_id,
        actorEmail: r.actor_email ?? (r.actor_id?.includes('@') ? r.actor_id : null), reason: r.reason, reasonCode: r.reason_code ?? null, createdAt: r.created_at,
      })),
    )
  }),
)
