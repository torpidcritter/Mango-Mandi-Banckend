// Orders: the list and detail, status changes, cancel, reschedule, and the pack list.
import express from 'express'
import { z } from 'zod'
import { isPacker, redactForPacker } from '../access.js'
import { requireManager } from '../auth.js'
import { addDays, isDate, todayIST } from '../clock.js'
import { attemptsFor, recordStaffDelivery } from '../delivery-proof.js'
import { query, tx } from '../db.js'
import { orderableDates } from '../delivery.js'
import { asyncHandler, badRequest, HttpError, notFound, parse } from '../errors.js'
import { newId } from '../ids.js'
import { allocateOrder, cancelOrder, eatByFor, moveOrderToDate, placeOnFirstDateWithStock, rebalanceOrder, setOrderStatus } from '../orders.js'
import { enqueue } from '../notify.js'
import { refundOrder } from '../payments.js'
import { logger } from '../logger.js'
import { productName } from '../products.js'
import { bookReturnedStock, WRITE_OFF_REASONS } from '../stock-watch.js'

export const router = express.Router()

// ---------------------------------------------------------------- orders

const ORDER_STATUSES = ['PAYMENT_PENDING', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED', 'RTO', 'CANCELLED']
const PAGE_SIZE = 50
const likeEscape = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`)

router.get(
  '/orders',
  asyncHandler(async (req, res) => {
    const f = parse(
      z.object({
        status: z.enum(ORDER_STATUSES).optional(),
        from: z.string().refine(isDate, 'from must be YYYY-MM-DD').optional(),
        to: z.string().refine(isDate, 'to must be YYYY-MM-DD').optional(),
        q: z.string().trim().max(40).optional(),
        atRisk: z.enum(['true', 'false']).optional(),
        page: z.coerce.number().int().min(1).max(10_000).default(1),
      }),
      Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '')),
    )
    const where = []
    const params = []
    const add = (sql, v) => {
      params.push(v)
      where.push(sql.replace('?', `$${params.length}`))
    }
    if (f.status) add('o.status = ?', f.status)
    if (f.from) add(`(o.placed_at AT TIME ZONE 'Asia/Kolkata')::date >= ?`, f.from)
    if (f.to) add(`(o.placed_at AT TIME ZONE 'Asia/Kolkata')::date <= ?`, f.to)
    if (f.atRisk) add('o.at_risk = ?', f.atRisk === 'true')
    if (f.q) {
      params.push(`${likeEscape(f.q)}%`, `%${likeEscape(f.q)}%`)
      // ADM-1: callers give a name or an area as often as a number.
      const [starts, has] = [`$${params.length - 1}`, `$${params.length}`]
      where.push(`(o.number ILIKE ${starts} OR o.phone ILIKE ${has} OR o.customer_name ILIKE ${has} OR o.delivery_address ILIKE ${has} OR o.gift_recipient_name ILIKE ${has})`)
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = (await query(`SELECT COUNT(*)::int AS n FROM orders o ${w}`, params)).rows[0].n
    const { rows } = await query(
      `SELECT o.*, (SELECT COALESCE(SUM(quantity), 0)::int FROM order_items i WHERE i.order_id = o.id) AS item_count
         FROM orders o ${w} ORDER BY o.placed_at DESC, o.number DESC LIMIT ${PAGE_SIZE} OFFSET ${(f.page - 1) * PAGE_SIZE}`,
      params,
    )
    res.json({
      page: f.page,
      pageSize: PAGE_SIZE,
      total,
      items: rows.map((o) => ({
        id: o.id, number: o.number, customerName: o.customer_name, phone: o.phone, itemCount: o.item_count, total: o.total,
        status: o.status, deliveryDate: o.delivery_date, placedAt: o.placed_at, atRisk: o.at_risk, channel: o.channel,
      })),
    })
  }),
)

export async function orderDetail(c, orderId) {
  const { rows } = await c.query(
    `SELECT o.*, r.number AS replacement_for_number, s.label AS slot_label, s.starts_at AS slot_starts_at, s.ends_at AS slot_ends_at
       FROM orders o LEFT JOIN orders r ON r.id = o.replacement_for LEFT JOIN delivery_slots s ON s.id = o.slot_id WHERE o.id = $1`,
    [orderId],
  )
  if (!rows.length) throw notFound('Order not found')
  const o = rows[0]
  const [items, stock, events, notes, deliveryAttempts, rating] = await Promise.all([
    c.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY sku, stage', [orderId]),
    c.query(
      `SELECT s.*, b.variety, b.plucked_on FROM order_stock s JOIN batches b ON b.id = s.batch_id
        WHERE s.order_id = $1 AND s.state <> 'released' ORDER BY s.sku, b.plucked_on`,
      [orderId],
    ),
    c.query('SELECT * FROM order_events WHERE order_id = $1 ORDER BY created_at, id', [orderId]),
    c.query('SELECT * FROM notifications WHERE order_id = $1 ORDER BY created_at, id', [orderId]),
    attemptsFor(c, orderId),
    c.query('SELECT stars, comment, updated_at FROM order_ratings WHERE order_id = $1', [orderId]),
  ])
  const r = rating.rows[0]
  return {
    rating: r ? { stars: r.stars, comment: r.comment, at: r.updated_at } : null,
    id: o.id, number: o.number, status: o.status, customerName: o.customer_name, phone: o.phone, pincode: o.pincode,
    // The delivery attempt a report made now is for (sent back with "Couldn't deliver").
    attempt: o.delivery_failures + 1,
    deliveryAddress: o.delivery_address, deliveryDate: o.delivery_date, placedAt: o.placed_at, total: o.total,
    subtotal: o.subtotal, discount: o.discount, promoCode: o.promo_code, gift: o.gift_recipient_name ? { recipientName: o.gift_recipient_name, recipientPhone: o.gift_recipient_phone, message: o.gift_message } : null,
    atRisk: o.at_risk, atRiskReason: o.at_risk_reason, channel: o.channel,
    replacementFor: o.replacement_for ? { id: o.replacement_for, number: o.replacement_for_number } : null,
    slot: o.slot_id ? { id: o.slot_id, label: o.slot_label, startsAt: String(o.slot_starts_at).slice(0, 5), endsAt: String(o.slot_ends_at).slice(0, 5) } : null,
    notifications: notes.rows.map((n) => ({
      kind: n.kind, channel: n.channel, status: n.status, attempts: n.attempts, createdAt: n.created_at, sentAt: n.sent_at, error: n.last_error,
    })),
    items: items.rows.map((i) => ({
      id: i.id, productName: productName(i.sku), sku: i.sku, quantity: i.quantity, stage: i.stage, unitPrice: i.unit_price,
      linePrice: i.line_price, eatBy: i.stage ? eatByFor(i.stage, o.delivery_date) : null,
    })),
    stock: stock.rows.map((s) => ({ id: s.id, batchId: s.batch_id, sku: s.sku, stage: s.stage, variety: s.variety, pluckedOn: s.plucked_on, quantity: s.quantity, state: s.state })),
    // INV-F: boxes on a cancelled or returned order that staff still have to put back or write off.
    returnedBoxes: ['CANCELLED', 'RTO'].includes(o.status) ? stock.rows.filter((s) => s.state === 'packed').reduce((n, s) => n + s.quantity, 0) : 0,
    events: events.rows.map((e) => ({ status: e.status, fromStatus: e.from_status, actor: e.actor, reason: e.reason, createdAt: e.created_at })),
    deliveryAttempts,
    payment: o.payment_status || o.payment_method
      ? { status: o.payment_status, method: o.payment_method, amount: o.payment_amount, id: o.payment_id, ...(o.payment_link_url ? { linkUrl: o.payment_link_url } : {}),
          refund: o.refund_requested_at ? { requestedAt: o.refund_requested_at, refundedAt: o.refunded_at, id: o.refund_id, status: o.refund_status ?? null } : null }
      : null,
  }
}

router.get(
  '/orders/:id',
  asyncHandler(async (req, res) => {
    const detail = await orderDetail({ query }, req.params.id)
    res.json(isPacker(req) ? redactForPacker(detail) : detail)
  }),
)

router.patch(
  '/orders/:id/status',
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({ status: z.enum(ORDER_STATUSES), reason: z.string().trim().max(300).optional(), override: z.boolean().optional() }),
      req.body,
    )
    const override = Boolean(b.override)
    if (override && req.admin.role !== 'MANAGER') throw new HttpError(403, 'FORBIDDEN', 'Only a manager can override this')
    // OPS-01: a missed delivery is reported with its reason and attempt (POST /orders/:id/delivery), never as a bare status.
    if (b.status === 'DELIVERY_FAILED') {
      throw badRequest("Report a missed delivery with Couldn't deliver: it needs the reason and the attempt", 'USE_DELIVERY_REPORT')
    }
    await tx(async (c) => {
      await setOrderStatus(c, req.params.id, b.status, req.actor, { reason: b.reason, override })
      await recordStaffDelivery(c, req.params.id, b.status, req.actor, b.reason)
    })
    res.status(204).end()
  }),
)

router.post(
  '/orders/:id/allocate',
  asyncHandler(async (req, res) => {
    await tx((c) => allocateOrder(c, req.params.id, req.actor))
    res.status(204).end()
  }),
)

router.post(
  '/orders/:id/cancel',
  asyncHandler(async (req, res) => {
    const { reason, refund } = parse(
      z.object({ reason: z.string().trim().min(1, 'reason is required').max(500), refund: z.boolean().default(false) }),
      req.body ?? {},
    )
    const refundDue = await tx((c) => cancelOrder(c, req.params.id, req.actor, reason, { manager: req.admin.role === 'MANAGER', refund }))
    if (refundDue) {
      await refundOrder(req.params.id).catch((err) => logger.error({ err, orderId: req.params.id }, 'refund failed; maintenance will retry'))
    }
    res.status(204).end()
  }),
)

/**
 * INV-F: the boxes of an order cancelled or returned after it left the store
 * come back on the shelf (RESTOCK) or are written off with a reason (WRITE_OFF).
 */
router.post(
  '/orders/:id/returned-stock',
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({
        action: z.enum(['RESTOCK', 'WRITE_OFF']),
        reasonCode: z.enum(WRITE_OFF_REASONS).optional(),
        reason: z.string().trim().min(1, 'reason is required').max(300),
      }),
      req.body ?? {},
    )
    res.json(await tx((c) => bookReturnedStock(c, req.params.id, b, req.actor)))
  }),
)

router.post(
  '/orders/:id/rebalance',
  asyncHandler(async (req, res) => {
    const r = await tx((c) => rebalanceOrder(c, req.params.id, req.actor))
    if (!r) throw badRequest('Only open orders can be rebalanced', 'INVALID_TRANSITION')
    res.json({ changed: r.changed, atRisk: r.atRisk })
  }),
)

/** Ops fix for an at-risk order: move it to a date that has stock. */
router.post(
  '/orders/:id/reschedule',
  asyncHandler(async (req, res) => {
    const { deliveryDate, slotId } = parse(
      z.object({ deliveryDate: z.string().refine(isDate, 'deliveryDate must be YYYY-MM-DD'), slotId: z.string().max(64).optional().nullable() }),
      req.body,
    )
    await tx(async (c) => {
      const from = await moveOrderToDate(c, req.params.id, {
        deliveryDate, slotId, statuses: ['CONFIRMED', 'PROCESSING'], actor: req.actor, why: `Rescheduled by ${req.admin.email}`,
      })
      if (deliveryDate !== from) await enqueue(c, req.params.id, newId('mov'), 'DATE_MOVED')
    })
    res.status(204).end()
  }),
)

const BULK_LIMIT = 500

/**
 * Moves every open order on one delivery date (a rain-out, a holiday) to
 * another, optionally only some pincodes or orders. Each order moves in its
 * own transaction, onto toDate or the next open date after it with stock, and
 * the customer gets a DATE_MOVED update. Orders that fit nowhere stay put and
 * are listed so ops can handle them. dryRun lists the orders without moving.
 */
router.post(
  '/orders/bulk-reschedule',
  requireManager,
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({
        fromDate: z.string().refine(isDate, 'fromDate must be YYYY-MM-DD'),
        toDate: z.string().refine(isDate, 'toDate must be YYYY-MM-DD'),
        slotId: z.string().max(64).optional().nullable(),
        pincodes: z.array(z.string().regex(/^\d{6}$/, 'pincodes must be 6 digits')).max(200).optional(),
        orderIds: z.array(z.string().max(64)).max(BULK_LIMIT).optional(),
        reason: z.string().trim().min(1, 'reason is required').max(200),
        dryRun: z.boolean().optional(),
      }),
      req.body,
    )
    if (b.toDate === b.fromDate) throw badRequest('Pick a different date to move to', 'INVALID_DATE')
    const open = await orderableDates({ query })
    if (!open.includes(b.toDate)) throw badRequest(`${b.toDate} is not an open delivery date`, 'INVALID_DATE')
    if (b.slotId && !(await query('SELECT 1 FROM delivery_slots WHERE id = $1 AND active', [b.slotId])).rows.length) {
      throw badRequest('That delivery slot is not available', 'SLOT_INVALID')
    }
    const params = [b.fromDate]
    let filter = ''
    if (b.pincodes?.length) {
      params.push(b.pincodes)
      filter += ` AND o.pincode = ANY($${params.length})`
    }
    if (b.orderIds?.length) {
      params.push(b.orderIds)
      filter += ` AND o.id = ANY($${params.length})`
    }
    const { rows: picked } = await query(
      `SELECT o.id, o.number, o.customer_name, o.pincode, o.status FROM orders o
        WHERE o.delivery_date = $1 AND o.status IN ('CONFIRMED', 'PROCESSING')${filter}
        ORDER BY o.placed_at LIMIT ${BULK_LIMIT + 1}`,
      params,
    )
    if (picked.length > BULK_LIMIT) throw badRequest(`More than ${BULK_LIMIT} orders match; narrow it by pincode`, 'TOO_MANY')
    const brief = (o) => ({ id: o.id, number: o.number, customerName: o.customer_name, pincode: o.pincode })
    if (b.dryRun) return res.json({ matched: picked.length, orders: picked.map(brief), moved: [], notMoved: [] })

    const dates = open.filter((d) => d >= b.toDate)
    const why = `${b.reason} (moved by ${req.admin.email})`
    const moved = []
    const notMoved = []
    for (const p of picked) {
      try {
        const date = await tx(async (c) => {
          const { rows } = await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [p.id])
          const o = rows[0]
          // Changed since we listed it (packed, cancelled or moved): leave it.
          if (!o || o.delivery_date !== b.fromDate || !['CONFIRMED', 'PROCESSING'].includes(o.status)) return 'changed'
          if (b.slotId) o.slot_id = b.slotId
          const d = await placeOnFirstDateWithStock(c, o, dates, req.actor, why)
          if (!d) return null
          await enqueue(c, o.id, newId('mov'), 'DATE_MOVED')
          await rebalanceOrder(c, o.id, req.actor)
          return d
        })
        if (date === 'changed') notMoved.push({ ...brief(p), reason: 'Changed while moving; check it by hand' })
        else if (date) moved.push({ ...brief(p), deliveryDate: date })
        else notMoved.push({ ...brief(p), reason: `No stock on ${b.toDate} or any later open date` })
      } catch (err) {
        notMoved.push({ ...brief(p), reason: err.message })
      }
    }
    res.json({ matched: picked.length, orders: picked.map(brief), moved, notMoved })
  }),
)

// ---------------------------------------------------------------- pack list

router.get(
  '/pack-list',
  asyncHandler(async (req, res) => {
    const date = req.query.date ? parse(z.string().refine(isDate, 'date must be YYYY-MM-DD'), req.query.date) : addDays(todayIST(), 1)
    const { rows: orders } = await query(
      `SELECT o.id, o.number, o.customer_name, o.pincode, o.status, o.slot_id, s.label AS slot_label,
              o.gift_recipient_name, o.gift_recipient_phone, o.gift_message
         FROM orders o LEFT JOIN delivery_slots s ON s.id = o.slot_id
        WHERE o.delivery_date = $1 AND o.status IN ('CONFIRMED', 'PROCESSING', 'PACKED')
        ORDER BY s.sort NULLS LAST, s.starts_at NULLS LAST, o.number`,
      [date],
    )
    const ids = orders.map((o) => o.id)
    const [items, stock] = await Promise.all([
      query('SELECT order_id, sku, SUM(quantity)::int AS quantity FROM order_items WHERE order_id = ANY($1) GROUP BY order_id, sku ORDER BY sku', [ids]),
      query(
        `SELECT s.order_id, s.sku, s.batch_id, s.quantity, s.state, b.variety, b.plucked_on
           FROM order_stock s JOIN batches b ON b.id = s.batch_id
          WHERE s.order_id = ANY($1) AND s.state IN ('committed', 'packed') ORDER BY b.plucked_on`,
        [ids],
      ),
    ])
    res.json(
      orders.map((o) => ({
        id: o.id, number: o.number, customerName: o.customer_name, pincode: o.pincode, status: o.status,
        slot: o.slot_id ? { id: o.slot_id, label: o.slot_label } : null,
        gift: o.gift_recipient_name ? { recipientName: o.gift_recipient_name, recipientPhone: isPacker(req) ? null : o.gift_recipient_phone, message: o.gift_message } : null,
        items: items.rows
          .filter((i) => i.order_id === o.id)
          .map((i) => ({
            sku: i.sku, productName: productName(i.sku), quantity: i.quantity,
            picks: stock.rows
              .filter((s) => s.order_id === o.id && s.sku === i.sku)
              .map((s) => ({ batchId: s.batch_id, variety: s.variety, pluckedOn: s.plucked_on, quantity: s.quantity, packed: s.state === 'packed' })),
          })),
      })),
    )
  }),
)
