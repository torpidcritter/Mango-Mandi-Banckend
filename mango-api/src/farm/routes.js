// Farm Experience for customers (docs/farm-experience.md), mounted in the /v1
// router. While FARM_EXPERIENCE is off every route answers 404.
//
// Public:
//   GET  /farm-experience            the page: farm details, what's included, policies, FAQs, varieties
//   GET  /farm-experience/dates      visit dates with enough of a variety (?varietyId=&kg=)
//   POST /farm-experience/quote      the price for a variety and kilograms (worked out here)
// Signed in, the caller's own bookings only (someone else's answers 404):
//   POST /farm-bookings                          book (Idempotency-Key): takes the mangoes; nothing is paid until after picking
//   GET  /farm-bookings, /farm-bookings/:id      list, and one booking with its itinerary
//   GET  /farm-bookings/:id/qr.svg               the check-in QR (the code only, nothing personal)
//   POST /farm-bookings/:id/pay                  pay the bill made after weighing (starts Razorpay Checkout)
//   POST /farm-bookings/:id/verify-payment       Checkout's reply, checked as for an order (PAY-B3)
//   POST /farm-bookings/:id/cancel               cancel (at once, or a request to the team, by the policy)
//   POST /farm-bookings/:id/reschedule           move the visit (at once, or a request to the team)
//   POST /farm-bookings/:id/hospitality          accept or decline a proposed arrangement
import express from 'express'
import QRCode from 'qrcode'
import { z } from 'zod'
import { diffDays, now } from '../clock.js'
import { query, tx } from '../db.js'
import { env } from '../env.js'
import { asyncHandler, badRequest, HttpError, notFound, parse } from '../errors.js'
import { isOn } from '../feature-switches.js'
import { logger } from '../logger.js'
import { hit } from '../ratelimit.js'
import { createGatewayOrder, reconcileFarmNow, sendDueRefunds, verifyCheckoutSignature } from '../payments.js'
import { gstinProblem, normaliseGstin } from '../gstin.js'
// Function declarations and lazily read constants only: customer.js imports this file.
import { requestHash } from '../customer.js'
import {
  answerAlternative, billPayment, createBooking, customerCancel, customerMove, customerView, lockBooking, openDates,
  processFarmPayment, varietyAvailability, varietyView,
} from './bookings.js'
import { MIN_KG, priceFor, STATUS_WORDS } from './rules.js'
import { loadSettings, publicSettings } from './settings.js'

const whenOn = (_req, _res, next) => next(isOn('FARM_EXPERIENCE') ? undefined : notFound())

export const farmPublic = express.Router()
farmPublic.use('/farm-experience', whenOn)
export const farmCustomer = express.Router()
farmCustomer.use('/farm-bookings', whenOn)

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
/** Group sizes: whole numbers, no upper limit beyond what the database column holds. */
const count = (msg) => z.number({ message: msg }).int(msg).min(0, msg).max(2_147_483_647, msg)

// ---------------------------------------------------------------- public

farmPublic.get(
  '/farm-experience',
  asyncHandler(async (_req, res) => {
    const { settings } = await loadSettings({ query })
    const [{ rows }, avail] = await Promise.all([
      query('SELECT * FROM farm_varieties WHERE active ORDER BY sort_order, name'),
      varietyAvailability({ query }, settings),
    ])
    res.set('Cache-Control', 'no-store')
    res.json({
      minKg: MIN_KG,
      bookingsOpen: settings.bookingsOpen,
      settings: publicSettings(settings),
      varieties: rows.map((v) => varietyView(v, avail.get(v.id) ?? { availableKg: 0, bestDayKg: 0, firstDate: null })),
    })
  }),
)

farmPublic.get(
  '/farm-experience/dates',
  asyncHandler(async (req, res) => {
    const q = parse(z.object({ varietyId: ID.optional(), kg: z.coerce.number().int().min(MIN_KG).optional() }), req.query)
    const { settings } = await loadSettings({ query })
    res.set('Cache-Control', 'no-store')
    res.json({ dates: await openDates({ query }, { varietyId: q.varietyId ?? null, kg: q.kg ?? MIN_KG, settings }) })
  }),
)

farmPublic.post(
  '/farm-experience/quote',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ varietyId: ID, kg: z.number().int('Enter whole kilograms') }).strict(), req.body)
    if (b.kg < MIN_KG) throw new HttpError(400, 'FARM_MIN_KG', `The minimum is ${MIN_KG} kg.`, { minKg: MIN_KG })
    const { rows } = await query('SELECT * FROM farm_varieties WHERE id = $1 AND active', [b.varietyId])
    if (!rows.length) throw new HttpError(409, 'FARM_VARIETY_UNAVAILABLE', 'That variety isn’t available for farm visits.')
    const p = priceFor(rows[0], b.kg)
    res.json({ varietyId: b.varietyId, kg: b.kg, pricePerKg: p.pricePerKg, total: p.total, tier: p.tier })
  }),
)

// ---------------------------------------------------------------- booking

const bookingSchema = z
  .object({
    varietyId: ID,
    kg: z.number({ message: 'Enter the kilograms' }).int('Enter whole kilograms'),
    visitDate: DAY,
    arrivalDate: DAY.optional(),
    departureDate: DAY.optional(),
    adults: count('Enter the number of adults').refine((n) => n >= 1, 'At least one adult'),
    children: count('Enter the number of children'),
    overnightGuests: count('Enter how many stay overnight'),
    food: z
      .object({
        veg: count('Enter a number').optional(), nonVeg: count('Enter a number').optional(), jain: count('Enter a number').optional(),
        allergies: z.string().trim().max(1000).optional(), requests: z.string().trim().max(1000).optional(),
      })
      .strict()
      .optional(),
    accessibility: z.string().trim().max(1000).optional(),
    notes: z.string().trim().max(2000).optional(),
    guestList: z.array(z.object({ name: z.string().trim().min(1).max(80), child: z.boolean().optional() }).strict()).optional(),
    contactName: z.string().trim().min(1, 'Enter your name').max(80),
    contactEmail: z.union([z.literal(''), z.string().trim().email('Enter a valid email').max(200)]).optional(),
    billingName: z.string().trim().max(120).optional(),
    billingGstin: z.string().trim().max(20).optional(),
    acceptPolicies: z.literal(true, { message: 'Please read and accept the booking policies' }),
  })
  .strict()

function checkInput(b) {
  if (b.kg < MIN_KG) throw new HttpError(400, 'FARM_MIN_KG', `The minimum is ${MIN_KG} kg.`, { minKg: MIN_KG })
  const arrival = b.arrivalDate ?? b.visitDate
  const departure = b.departureDate ?? b.visitDate
  if (arrival > b.visitDate || departure < b.visitDate) throw badRequest('Your stay has to include the visit date.', 'FARM_STAY_DATES')
  if (diffDays(departure, arrival) > 30) throw badRequest('A stay can be up to 30 nights. Talk to us for longer.', 'FARM_STAY_DATES')
  const group = b.adults + b.children
  if (b.overnightGuests > group) throw badRequest('Overnight guests can’t be more than the whole group.', 'FARM_GUESTS')
  if (b.guestList && b.guestList.length > group) throw badRequest('You listed more names than people in the group.', 'FARM_GUESTS')
  const gstin = b.billingGstin ? normaliseGstin(b.billingGstin) : null
  if (gstin && gstinProblem(gstin)) throw badRequest(gstinProblem(gstin), 'FARM_GSTIN')
  return { ...b, arrivalDate: arrival, departureDate: departure, billingGstin: gstin }
}

const replayBooking = async (key) =>
  (await query(`SELECT k.request_hash AS idem_hash, b.* FROM idempotency_keys k JOIN farm_bookings b ON b.id = k.order_id WHERE k.key = $1`, [key])).rows[0] ?? null

const created = (b) => ({ bookingId: b.id, number: b.number, status: b.status, estimate: b.total, kg: b.kg, visitDate: b.visit_date })

/** Creates the Razorpay order for a bill payment; if the gateway fails, the try is closed and the customer can tap Pay again. */
async function startPayment(payRow, b) {
  if (payRow.razorpay_order_id) return payRow.razorpay_order_id
  try {
    const rzp = await createGatewayOrder({ amount: payRow.amount, receipt: `${b.number}-${payRow.id.slice(-6)}`, orderId: b.id })
    const { rows } = await query('UPDATE farm_booking_payments SET razorpay_order_id = $2 WHERE id = $1 AND razorpay_order_id IS NULL RETURNING razorpay_order_id', [payRow.id, rzp])
    return rows[0]?.razorpay_order_id ?? (await query('SELECT razorpay_order_id FROM farm_booking_payments WHERE id = $1', [payRow.id])).rows[0].razorpay_order_id
  } catch (err) {
    logger.error({ err, farmPaymentId: payRow.id }, 'could not create the gateway order for a farm payment')
    await tx((c) => processFarmPayment(c, { farmPaymentId: payRow.id, outcome: 'abandoned' }))
    throw new HttpError(502, 'PAYMENT_GATEWAY_ERROR', 'Could not start the payment. Please try again.')
  }
}

farmCustomer.post(
  '/farm-bookings',
  asyncHandler(async (req, res) => {
    const rawKey = req.get('Idempotency-Key')
    if (!rawKey || rawKey.length > 100) throw badRequest('An Idempotency-Key header is required', 'IDEMPOTENCY_KEY_REQUIRED')
    const tries = await hit(`farm-book:${req.customer.id}`, 10 * 60_000)
    if (tries.hits > 10) throw new HttpError(429, 'RATE_LIMITED', 'Too many booking tries. Wait a few minutes and try again.')
    const input = checkInput(parse(bookingSchema, req.body))
    const key = `${req.customer.id}:farm:${rawKey}`
    const hash = requestHash(req.body)
    const replay = await replayBooking(key)
    if (replay) {
      if (replay.idem_hash && replay.idem_hash !== hash) {
        throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'This request does not match the one first sent with this Idempotency-Key. Use a new key for a new booking.')
      }
      return res.status(200).json(created(replay))
    }
    const b = await tx(async (c) => {
      const ins = await c.query('INSERT INTO idempotency_keys (key, order_id, created_at, request_hash) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [key, 'pending', now(), hash])
      if (!ins.rowCount) return null
      const { rows: cust } = await c.query('SELECT name, phone FROM customers WHERE id = $1', [req.customer.id])
      if (!cust[0]?.phone) throw new HttpError(409, 'PHONE_REQUIRED', 'Add your mobile number first, so the farm team can reach you.')
      const made = await createBooking(c, { customerId: req.customer.id, input: { ...input, contactPhone: cust[0].phone } })
      if (!cust[0].name) await c.query('UPDATE customers SET name = $2 WHERE id = $1', [req.customer.id, input.contactName])
      await c.query('UPDATE idempotency_keys SET order_id = $2 WHERE key = $1', [key, made.id])
      return made
    })
    if (!b) {
      // The same key at the same moment: the first request's transaction has committed by now.
      const first = await replayBooking(key)
      if (!first) throw new HttpError(409, 'BOOKING_IN_PROGRESS', 'Your booking is still being made. Please try again in a moment.', { retryAfterSeconds: 2 })
      return res.status(200).json(created(first))
    }
    res.status(201).json(created(b))
  }),
)

async function own(c, req, { lock = false } = {}) {
  const b = lock ? await lockBooking(c, req.params.id).catch(() => null) : (await c.query('SELECT * FROM farm_bookings WHERE id = $1', [req.params.id])).rows[0]
  if (!b || b.customer_id !== req.customer.id) throw notFound('Booking not found')
  return b
}

farmCustomer.get(
  '/farm-bookings',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM farm_bookings WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50', [req.customer.id])
    res.json(rows.map((b) => ({
      id: b.id, number: b.number, status: b.status, statusLabel: STATUS_WORDS[b.status], variety: b.variety_name, kg: b.kg, total: b.total,
      billAmount: b.bill_amount, paidAt: b.paid_at, visitDate: b.visit_date, guests: b.adults + b.children, createdAt: b.created_at,
    })))
  }),
)

farmCustomer.get(
  '/farm-bookings/:id',
  asyncHandler(async (req, res) => {
    const b = await own({ query }, req)
    // Back from Checkout a minute later with no webhook yet: ask Razorpay (throttled), as an order's page does.
    const pending = (await query(`SELECT id FROM farm_booking_payments WHERE booking_id = $1 AND status = 'INITIATED' AND razorpay_order_id IS NOT NULL`, [b.id])).rows
    for (const p of pending) await reconcileFarmNow(p.id, { minAgeMs: 60_000, throttleMs: 30_000 }).catch((err) => logger.warn({ err, bookingId: b.id }, 'farm payment check at Razorpay failed'))
    res.set('Cache-Control', 'no-store')
    res.json(await customerView({ query }, await own({ query }, req)))
  }),
)

farmCustomer.get(
  '/farm-bookings/:id/qr.svg',
  asyncHandler(async (req, res) => {
    const b = await own({ query }, req)
    if (['CANCELLED', 'NO_SHOW', 'COMPLETED'].includes(b.status)) throw notFound('No check-in code for this booking')
    // The QR holds only the check-in code: staff look the booking up with it in the panel.
    const svg = await QRCode.toString(`MMF:${b.checkin_code}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
    res.set('Content-Type', 'image/svg+xml')
    res.set('Cache-Control', 'no-store')
    res.send(svg)
  }),
)

const VERIFY_PER_MINUTE = 6

/** Pay the bill made after weighing: starts (or reuses) its Razorpay order. */
farmCustomer.post(
  '/farm-bookings/:id/pay',
  asyncHandler(async (req, res) => {
    const out = await tx(async (c) => {
      const b = await own(c, req, { lock: true })
      return { b, pay: await billPayment(c, b) }
    })
    const rzp = await startPayment(out.pay, out.b)
    res.json({ bookingId: out.b.id, number: out.b.number, amount: out.pay.amount, razorpayOrderId: rzp, razorpayKeyId: env.RAZORPAY_KEY_ID || null })
  }),
)

farmCustomer.post(
  '/farm-bookings/:id/verify-payment',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({ razorpay_payment_id: z.string().min(1).max(64), razorpay_order_id: z.string().min(1).max(64), razorpay_signature: z.string().min(1).max(128) }),
      req.body,
    )
    const b = await own({ query }, req)
    const { rows } = await query('SELECT * FROM farm_booking_payments WHERE booking_id = $1 AND razorpay_order_id = $2', [b.id, body.razorpay_order_id])
    if (!rows.length) throw badRequest('This payment is not for this booking', 'PAYMENT_MISMATCH')
    if (!verifyCheckoutSignature(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature)) throw badRequest('The payment could not be verified', 'BAD_SIGNATURE')
    const tries = await hit(`verify-farm-payment:${rows[0].id}`, 60_000)
    if (tries.hits > VERIFY_PER_MINUTE) throw new HttpError(429, 'RATE_LIMITED', 'Too many checks. Your booking page updates on its own.')
    // The signature proves Checkout finished; the booking changes only on what Razorpay itself says (webhook or this check).
    if (rows[0].status !== 'SUCCEEDED') await reconcileFarmNow(rows[0].id, { throttleMs: 2_000 })
    const after = (await query('SELECT status FROM farm_booking_payments WHERE id = $1', [rows[0].id])).rows[0]
    const fresh = await own({ query }, req)
    res.json({ paymentStatus: after.status, status: fresh.status })
  }),
)

farmCustomer.post(
  '/farm-bookings/:id/cancel',
  asyncHandler(async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().max(1000).optional() }).strict(), req.body ?? {})
    const r = await tx(async (c) => customerCancel(c, await own(c, req, { lock: true }), { reason, customerId: req.customer.id }))
    res.json({ requested: r.requested, booking: await customerView({ query }, await own({ query }, req)) })
  }),
)

farmCustomer.post(
  '/farm-bookings/:id/reschedule',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ date: DAY, note: z.string().trim().max(1000).optional() }).strict(), req.body)
    const r = await tx(async (c) => customerMove(c, await own(c, req, { lock: true }), { date: b.date, note: b.note, customerId: req.customer.id }))
    res.json({ requested: r.requested, booking: await customerView({ query }, await own({ query }, req)) })
  }),
)

farmCustomer.post(
  '/farm-bookings/:id/hospitality',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ accept: z.boolean(), note: z.string().trim().max(1000).optional() }).strict(), req.body)
    await tx(async (c) => answerAlternative(c, await own(c, req, { lock: true }), { accept: b.accept, note: b.note, customerId: req.customer.id }))
    res.json(await customerView({ query }, await own({ query }, req)))
  }),
)

/** /v1/dev (ENABLE_DEV_ROUTES, never in production): pays or fails a farm payment, as the Razorpay webhook would. */
export const devFarm = express.Router()
devFarm.post(
  '/pay-farm',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ bookingId: ID, outcome: z.enum(['captured', 'failed']) }), req.body)
    const { rows } = await query(
      `SELECT * FROM farm_booking_payments WHERE booking_id = $1 AND kind = 'ONLINE' AND status IN ('INITIATED', 'CANCELLED') ORDER BY created_at DESC LIMIT 1`,
      [b.bookingId],
    )
    if (!rows.length) throw notFound('No unpaid farm payment')
    const r = await tx((c) => processFarmPayment(c, { farmPaymentId: rows[0].id, outcome: b.outcome, paymentId: `pay_dev_${rows[0].id.slice(4, 18)}`, amount: rows[0].amount, method: 'dev' }))
    if (r.result === 'refund_due') await sendDueRefunds({ farmBookingId: b.bookingId })
    res.json(r)
  }),
)

