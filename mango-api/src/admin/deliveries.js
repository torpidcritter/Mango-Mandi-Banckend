// Deliveries: the rider manifest, dispatch, rider assignment, proof of delivery.
import express from 'express'
import { z } from 'zod'
import { isPacker, redactForPacker, RIDER_TAKES } from '../access.js'
import { addDays, isDate, todayIST } from '../clock.js'
import { sendPhoto } from '../photos.js'
import { dispatchOrder, FAIL_REASONS, MAX_PHOTO_BYTES, photo, photoReviews, recordDelivery, reviewDelivery, savePhoto } from '../delivery-proof.js'
import { query, tx } from '../db.js'
import { asyncHandler, badRequest, HttpError, notFound, parse } from '../errors.js'
import { productName } from '../products.js'

export const router = express.Router()

// ---------------------------------------------------------------- rider manifest

const MANIFEST_STATUSES = ['CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'DELIVERED']

/**
 * The delivery run for a date: slots in order, then stops grouped by zone and
 * pincode, each with the address, phone and boxes. Every order is prepaid, so
 * riders collect nothing. Orders not packed yet are flagged.
 */
router.get(
  '/manifest',
  asyncHandler(async (req, res) => {
    const date = req.query.date ? parse(z.string().refine(isDate, 'date must be YYYY-MM-DD'), req.query.date) : addDays(todayIST(), 1)
    const rider = req.admin.role === 'RIDER'
    // SEC-02: a rider sees only their own stops, and no delivered ones from before today.
    const statuses = isPacker(req) || (rider && date < todayIST()) ? MANIFEST_STATUSES.filter((s) => s !== 'DELIVERED') : MANIFEST_STATUSES
    const { rows: orders } = await query(
      `SELECT o.id, o.number, o.customer_name, o.phone, o.pincode, o.delivery_address, o.status, o.slot_id, o.delivery_failures,
              o.gift_recipient_name, o.gift_recipient_phone, o.gift_message, o.rider_id, r.email AS rider_email,
              s.label AS slot_label, s.starts_at, s.ends_at, p.city, p.zone
         FROM orders o LEFT JOIN delivery_slots s ON s.id = o.slot_id LEFT JOIN pincodes p ON p.pincode = o.pincode
         LEFT JOIN admin_users r ON r.id = o.rider_id
        WHERE o.delivery_date = $1 AND o.status = ANY($2) ${rider ? 'AND o.rider_id = $3' : ''}
        ORDER BY s.sort NULLS LAST, s.starts_at NULLS LAST, p.zone NULLS LAST, o.pincode, o.number`,
      rider ? [date, statuses, req.admin.id] : [date, statuses],
    )
    // Packed stops nobody has yet: a rider can take them by starting the run (they see only how many).
    const unassigned = rider
      ? (await query('SELECT COUNT(*)::int AS n FROM orders WHERE delivery_date = $1 AND rider_id IS NULL AND status = ANY($2)', [date, RIDER_TAKES])).rows[0].n
      : undefined
    const { rows: items } = await query(
      'SELECT order_id, sku, stage, SUM(quantity)::int AS quantity FROM order_items WHERE order_id = ANY($1) GROUP BY order_id, sku, stage ORDER BY sku, stage',
      [orders.map((o) => o.id)],
    )
    const runs = []
    for (const o of orders) {
      let run = runs.at(-1)
      if (!run || run.key !== (o.slot_id ?? null)) {
        run = {
          key: o.slot_id ?? null,
          slot: o.slot_id ? { id: o.slot_id, label: o.slot_label, startsAt: String(o.starts_at).slice(0, 5), endsAt: String(o.ends_at).slice(0, 5) } : null,
          stops: [],
          orders: 0,
          boxes: 0,
        }
        runs.push(run)
      }
      let stop = run.stops.at(-1)
      if (!stop || stop.pincode !== o.pincode) {
        stop = { pincode: o.pincode, city: o.city ?? null, zone: o.zone ?? null, orders: [] }
        run.stops.push(stop)
      }
      const lines = items.filter((i) => i.order_id === o.id)
      const boxes = lines.reduce((n, i) => n + i.quantity, 0)
      const entry = {
        // A gift goes to the recipient: the rider sees and calls them.
        id: o.id, number: o.number, status: o.status, deliveryAddress: o.delivery_address,
        customerName: o.gift_recipient_name ?? o.customer_name, phone: o.gift_recipient_phone ?? o.phone,
        gift: o.gift_recipient_name ? { from: o.customer_name, message: o.gift_message } : null,
        packed: !['CONFIRMED', 'PROCESSING'].includes(o.status), boxes,
        rider: o.rider_id ? { id: o.rider_id, email: o.rider_email ?? null } : null,
        // Sent back with the delivery report, so a late resend for an earlier attempt is refused.
        attempt: o.delivery_failures + 1,
        items: lines.map((i) => ({ sku: i.sku, productName: productName(i.sku), stage: i.stage, quantity: i.quantity })),
      }
      stop.orders.push(isPacker(req) ? redactForPacker(entry) : entry)
      run.orders++
      run.boxes += boxes
    }
    res.json({
      date,
      orders: orders.length,
      boxes: runs.reduce((n, r) => n + r.boxes, 0),
      ...(rider ? { unassigned } : {}),
      runs: runs.map(({ key, ...r }) => r),
    })
  }),
)

// ---------------------------------------------------------------- proof of delivery

/** Start a run: every packed order on the date (one slot, or all) goes out for delivery. */
router.post(
  '/manifest/dispatch',
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({ date: z.string().refine(isDate, 'date must be YYYY-MM-DD'), slotId: z.string().nullable().optional(), riderId: z.string().max(40).optional() }),
      req.body,
    )
    const rider = req.admin.role === 'RIDER'
    // Staff may hand the run to a rider as it goes out; a rider takes the stops nobody has yet.
    if (b.riderId && rider) throw new HttpError(403, 'FORBIDDEN', 'Riders take stops by starting the run')
    if (b.riderId) await riderOrThrow(b.riderId)
    const params = [b.date]
    let slotFilter = ''
    if (b.slotId === null) slotFilter = 'AND slot_id IS NULL'
    else if (b.slotId) {
      params.push(b.slotId)
      slotFilter = `AND slot_id = $${params.length}`
    }
    if (rider) {
      params.push(req.admin.id)
      slotFilter += ` AND (rider_id = $${params.length} OR (rider_id IS NULL AND status IN ('PACKED', 'SHIPPED', 'DELIVERY_FAILED')))`
    }
    const { rows } = await query(
      `SELECT id, number, status FROM orders WHERE delivery_date = $1 ${slotFilter}
          AND status IN ('CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'DELIVERY_FAILED') ORDER BY number`,
      params,
    )
    const assignTo = rider ? req.admin.id : (b.riderId ?? null)
    const dispatched = []
    const skipped = []
    for (const o of rows) {
      if (['CONFIRMED', 'PROCESSING'].includes(o.status)) {
        skipped.push({ number: o.number, reason: 'Not packed yet' })
        continue
      }
      try {
        const sent = await tx(async (c) => {
          if (assignTo) await assignRider(c, o.id, assignTo, { onlyIfFree: rider })
          return dispatchOrder(c, o.id, req.actor)
        })
        if (sent) dispatched.push(o.number)
      } catch (err) {
        skipped.push({ number: o.number, reason: err.message })
      }
    }
    res.json({ dispatched, skipped })
  }),
)

router.post(
  '/orders/:id/dispatch',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ override: z.boolean().optional(), reason: z.string().trim().max(300).optional() }), req.body ?? {})
    if (b.override && req.admin.role !== 'MANAGER') throw new HttpError(403, 'FORBIDDEN', 'Only a manager can override this')
    if (b.override && !b.reason) throw badRequest('Say why it is going out anyway', 'REASON_REQUIRED')
    await tx(async (c) => {
      // A rider sending out an unassigned stop takes it (riderScope let them reach it for this).
      if (req.admin.role === 'RIDER') await assignRider(c, req.params.id, req.admin.id, { onlyIfFree: true })
      return dispatchOrder(c, req.params.id, req.actor, { override: Boolean(b.override), reason: b.reason })
    })
    res.status(204).end()
  }),
)

// ---------------------------------------------------------------- rider assignment (SEC-02)

/** Riders, for the Deliveries page's assign control. */
router.get(
  '/riders',
  asyncHandler(async (_req, res) => res.json((await query("SELECT id, email FROM admin_users WHERE role = 'RIDER' ORDER BY email")).rows)),
)

async function riderOrThrow(id) {
  const { rows } = await query("SELECT id FROM admin_users WHERE id = $1 AND role = 'RIDER'", [id])
  if (!rows.length) throw badRequest('Pick a rider', 'NOT_A_RIDER')
}

/**
 * Gives the order to a rider (null: to nobody). With onlyIfFree (a rider
 * taking a stop) it must be unassigned or theirs already; another rider's
 * stop answers 404, as riderScope does.
 */
async function assignRider(c, orderId, riderId, { onlyIfFree = false } = {}) {
  const r = await c.query(`UPDATE orders SET rider_id = $2 WHERE id = $1 ${onlyIfFree ? 'AND (rider_id IS NULL OR rider_id = $2)' : ''} RETURNING id`, [orderId, riderId])
  if (!r.rowCount) throw notFound('Order not found')
}

/**
 * Assigns stops to a rider: the listed orders, or every order still to
 * deliver on the date (one slot, or all). riderId null takes them off anyone.
 */
router.post(
  '/manifest/assign',
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({
        date: z.string().refine(isDate, 'date must be YYYY-MM-DD'),
        slotId: z.string().nullable().optional(),
        orderIds: z.array(z.string().max(40)).min(1).max(500).optional(),
        riderId: z.string().max(40).nullable(),
      }),
      req.body,
    )
    if (b.riderId) await riderOrThrow(b.riderId)
    const params = [b.date, b.riderId, MANIFEST_STATUSES.filter((s) => s !== 'DELIVERED')]
    let filter = ''
    if (b.slotId === null) filter += ' AND slot_id IS NULL'
    else if (b.slotId) {
      params.push(b.slotId)
      filter += ` AND slot_id = $${params.length}`
    }
    if (b.orderIds) {
      params.push(b.orderIds)
      filter += ` AND id = ANY($${params.length})`
    }
    const { rows } = await query(`UPDATE orders SET rider_id = $2 WHERE delivery_date = $1 AND status = ANY($3) ${filter} RETURNING number`, params)
    res.json({ assigned: rows.map((r) => r.number).sort() })
  }),
)

/** The photo is the raw request body (Content-Type image/jpeg, png or webp). */
router.post(
  '/orders/:id/delivery-photos',
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_PHOTO_BYTES, inflate: false }),
  asyncHandler(async (req, res) => {
    const id = await savePhoto(req.params.id, req.body, req.actor) // uploads first, then a short transaction (OPS-26)
    res.status(201).json({ id })
  }),
)

router.get(
  '/orders/:id/delivery-photos/:photoId',
  asyncHandler(async (req, res) => {
    await sendPhoto(res, await photo({ query }, req.params.id, req.params.photoId))
  }),
)

router.post(
  '/orders/:id/delivery',
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({
        outcome: z.enum(['DELIVERED', 'FAILED']),
        code: z.string().regex(/^\d{4}$/, 'The code is 4 digits').optional(),
        photoId: z.string().max(40).optional(),
        receivedBy: z.string().trim().max(80).optional(),
        reason: z.enum(FAIL_REASONS).optional(),
        note: z.string().trim().max(300).optional(),
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
        // Which delivery attempt this report is for (the manifest's attempt): a late resend after a re-dispatch is refused.
        attempt: z.number().int().min(1).max(100).optional(),
      }),
      req.body,
    )
    // OPS-02: a missed-delivery report must say which attempt it is for, so a late resend can't count twice.
    if (b.outcome === 'FAILED' && b.attempt === undefined) throw badRequest('Say which delivery attempt this report is for', 'ATTEMPT_REQUIRED')
    const r = await tx((c) => recordDelivery(c, req.params.id, b, req.actor))
    if (r.wrongCode) {
      throw new HttpError(422, 'WRONG_CODE', r.triesLeft ? `That code is not right. ${r.triesLeft} tries left.` : 'That code is not right. Take a photo of the handover instead.', { triesLeft: r.triesLeft })
    }
    res.json(r)
  }),
)

/** Photo deliveries waiting for someone other than the rider to check them. */
router.get('/delivery-reviews', asyncHandler(async (_req, res) => res.json(await photoReviews({ query }))))

router.post(
  '/delivery-reviews/:id',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ ok: z.boolean(), note: z.string().trim().max(300).optional() }), req.body)
    await tx((c) => reviewDelivery(c, req.params.id, b, req.actor))
    res.status(204).end()
  }),
)
