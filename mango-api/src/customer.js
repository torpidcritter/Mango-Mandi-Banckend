// /v1: the customer storefront API. Phone OTP login, catalogue by pincode and
// delivery date, cart, checkout with stock holds, orders and claims.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import express from 'express'
import { z } from 'zod'
import { ACCESS_TTL_S, issueRefresh, requireCustomer, revokeRefresh, rotateRefresh, sameSiteOnly, signAccess } from './auth.js'
import { isDate, now, todayIST } from './clock.js'
import { getConfig } from './config.js'
import { query, tx } from './db.js'
import { customerDelivery, customerPhoto } from './delivery-proof.js'
import { activeSlots, earliestDeliveryDate, orderableDates, slotsForDate, slotView } from './delivery.js'
import { env, isProd } from './env.js'
import { asyncHandler, badRequest, conflict, HttpError, notFound, parse, StockError, unauthorized } from './errors.js'
import { newId } from './ids.js'
import { availability } from './inventory.js'
import { logger } from './logger.js'
import { metrics } from './metrics.js'
import { createOrder, customerCancel, eatByFor, moveOrderToDate, processPayment, SYSTEM } from './orders.js'
import { createGatewayOrder, devGateway, reconcilePendingPayments, refundDuplicatePayments, refundOrder } from './payments.js'
import { findProduct, sellable, shopProducts } from './products.js'
import { bookPreorder, cancelPreorder, ensurePaymentLink, openWeeks, preorderView, processPreorderPayment, refundPreorder } from './preorders.js'
import { hit, sharedLimiter } from './ratelimit.js'
import { reportProblem } from './sentry.js'
import { sendOtp } from './sms.js'
import { googleOn, verifyGoogleCredential } from './google.js'
import { STAGES } from './stage.js'
import { publicBox } from './labels.js'
import { applyPromo, recordRedemption } from './promos.js'
import { checkPhoto, dropPhoto, MAX_PHOTO_BYTES, sendPhoto, storePhoto } from './photos.js'
import { eraseCustomer } from './privacy.js'
import { requireHuman } from './turnstile.js'
import { cancelAlert, createAlert, listAlerts } from './engagement.js'
import { readyOnFor } from './ripeness.js'

export const router = express.Router()

// Per address, counted in Postgres so every serverless instance shares it.
// Outside production it is loose, so test runs don't trip it.
const otpLimiter = sharedLimiter('otp-ip', { windowMs: 15 * 60_000, limit: isProd ? 30 : 300 })

/** Claims a customer can raise in 30 days from the app. */
const MAX_CLAIMS_PER_MONTH = 3

const OTP_TTL_MS = 5 * 60_000
const OTP_MAX_ATTEMPTS = 5
const OTP_MAX_SENDS_PER_HOUR = 5
const OTP_MAX_SENDS_PER_DAY = 10
const DAY_MS = 86_400_000

/**
 * Stops SMS pumping: every code costs money, and bots request codes for
 * numbers they don't own. Each number gets 10 codes a day, and the whole shop
 * a daily budget (OTP_DAILY_LIMIT). Numbers with no account may use only part
 * of it (OTP_NEW_NUMBER_SHARE), so a flood of new numbers can't lock existing
 * customers out. Past 80% of the budget Sentry is told; past 100% no more
 * codes go out until midnight IST (Google sign-in still works).
 */
async function checkOtpBudget(phone) {
  const day = todayIST()
  const mine = await hit(`otp-phone-day:${phone}:${day}`, DAY_MS)
  if (mine.hits > OTP_MAX_SENDS_PER_DAY) throw new HttpError(429, 'OTP_LIMIT', 'Too many codes for this number today. Try again tomorrow.')
  const known = (await query('SELECT 1 FROM customers WHERE phone = $1 AND deleted_at IS NULL', [phone])).rowCount > 0
  if (!known) {
    const share = Math.ceil(env.OTP_DAILY_LIMIT * env.OTP_NEW_NUMBER_SHARE)
    const fresh = await hit(`otp-day-new:${day}`, DAY_MS)
    if (fresh.hits > share) {
      if (fresh.hits === share + 1) reportProblem('Login codes for new numbers paused: their share of the daily budget is used up', { share })
      throw new HttpError(503, 'OTP_PAUSED', "We can't send login codes to new numbers right now. Sign in with Google, or try again later.")
    }
  }
  const all = await hit(`otp-day:${day}`, DAY_MS)
  metrics.otpBudgetUsed.set(all.hits)
  if (all.hits === Math.ceil(env.OTP_DAILY_LIMIT * 0.8)) reportProblem('Login codes: 80% of the daily SMS budget used', { used: all.hits, limit: env.OTP_DAILY_LIMIT })
  if (all.hits > env.OTP_DAILY_LIMIT) {
    if (all.hits === env.OTP_DAILY_LIMIT + 1) reportProblem('Login codes paused: the daily SMS budget is used up', { limit: env.OTP_DAILY_LIMIT })
    throw new HttpError(503, 'OTP_PAUSED', "We can't send login codes right now. Sign in with Google, or try again later.")
  }
}

/** Indian mobile numbers, normalised to +91XXXXXXXXXX. */
const phoneSchema = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, ''))
  .refine((s) => /^[6-9]\d{9}$/.test(s), 'Enter a 10-digit Indian mobile number')
  .transform((s) => `+91${s}`)

const otpRequest = z.object({ phone: phoneSchema, channel: z.enum(['sms', 'whatsapp']).optional(), captchaToken: z.string().max(2048).optional() })

const hashOtp = (phone, code) => createHash('sha256').update(`${env.JWT_SECRET}:${phone}:${code}`).digest()

// ---------------------------------------------------------------- auth

/** Stores a fresh login code for the phone (rate-limited per phone) and sends it. */
async function issueCode(phone, channel) {
  const code = String(randomInt(100_000, 1_000_000))
  const at = now()
  await tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM otps WHERE phone = $1 FOR UPDATE', [phone])
    const prev = rows[0]
    const fresh = !prev || at.getTime() - prev.window_start.getTime() > 3_600_000
    if (!fresh && prev.resends >= OTP_MAX_SENDS_PER_HOUR) {
      throw new HttpError(429, 'OTP_LIMIT', 'Too many codes requested. Try again in an hour.')
    }
    await c.query(
      `INSERT INTO otps (phone, code, expires_at, attempts, resends, window_start) VALUES ($1, $2, $3, 0, 1, $4)
       ON CONFLICT (phone) DO UPDATE SET code = $2, expires_at = $3, attempts = 0,
         resends = CASE WHEN $5 THEN 1 ELSE otps.resends + 1 END,
         window_start = CASE WHEN $5 THEN $4 ELSE otps.window_start END`,
      [phone, hashOtp(phone, code).toString('hex'), new Date(at.getTime() + OTP_TTL_MS), at, fresh],
    )
  })
  await checkOtpBudget(phone)
  const via = await sendOtp(phone, code, channel)
  return isProd ? { sent: true, channel: via } : { sent: true, channel: via, devCode: code }
}

/** Checks a code inside a transaction. Returns an error to throw after commit (so wrong tries count), or null. */
async function consumeCode(c, phone, code) {
  const { rows } = await c.query('SELECT * FROM otps WHERE phone = $1 FOR UPDATE', [phone])
  const otp = rows[0]
  if (!otp || otp.expires_at <= now()) return unauthorized('This code has expired. Request a new one.', 'OTP_EXPIRED')
  if (otp.attempts >= OTP_MAX_ATTEMPTS) return unauthorized('Too many wrong codes. Request a new one.', 'OTP_LOCKED')
  if (!timingSafeEqual(Buffer.from(otp.code, 'hex'), hashOtp(phone, code))) {
    await c.query('UPDATE otps SET attempts = attempts + 1 WHERE phone = $1', [phone])
    return unauthorized('Incorrect code', 'OTP_INVALID')
  }
  await c.query('DELETE FROM otps WHERE phone = $1', [phone])
  return null
}

router.post(
  '/auth/otp/request',
  otpLimiter,
  asyncHandler(async (req, res) => {
    const { phone, channel, captchaToken } = parse(otpRequest, req.body)
    await requireHuman(captchaToken, req.ip)
    res.json(await issueCode(phone, channel))
  }),
)

// The web shop keeps the refresh token in an httpOnly cookie (sent with
// "X-Session: cookie"), out of reach of page scripts. Other clients get it in
// the response body, as before.
const RT_COOKIE = 'mm_customer_rt'
const rtCookie = () => ({ httpOnly: true, secure: env.COOKIE_SECURE, sameSite: env.COOKIE_SAMESITE, path: '/v1/auth' })
const cookieMode = (req) => req.get('x-session') === 'cookie'

const profile = (cu) => ({ id: cu.id, phone: cu.phone ?? null, name: cu.name ?? null, email: cu.email ?? null })

async function sendTokens(req, res, customer) {
  const refresh = await issueRefresh(customer.id, 'customer')
  const body = { accessToken: signAccess({ sub: customer.id, phone: customer.phone ?? null, typ: 'customer' }), expiresIn: ACCESS_TTL_S, customer: profile(customer) }
  if (cookieMode(req)) {
    res.cookie(RT_COOKIE, refresh.token, { ...rtCookie(), expires: refresh.expiresAt })
    return res.json(body)
  }
  res.json({ ...body, refreshToken: refresh.token })
}

router.post(
  '/auth/otp/verify',
  otpLimiter,
  asyncHandler(async (req, res) => {
    const { phone, code } = parse(z.object({ phone: phoneSchema, code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }), req.body)
    const customer = await tx(async (c) => {
      const error = await consumeCode(c, phone, code)
      if (error) return { error }
      const up = await c.query(
        `INSERT INTO customers (id, phone, created_at) VALUES ($1, $2, $3) ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
         RETURNING id, phone, name, email`,
        [newId('cus'), phone, now()],
      )
      return up.rows[0]
    })
    // Failed attempts are counted even though the request fails.
    if (customer.error) throw customer.error
    await sendTokens(req, res, customer)
  }),
)

// The public page behind a box label's QR (labels.js): no sign-in, no personal
// data, and the same answer for anything unknown, tampered or switched off.
const boxLimiter = sharedLimiter('box-page', { windowMs: 60_000, limit: 30, message: 'Too many lookups. Try again in a minute.' })
router.get('/box/:token', boxLimiter, asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.json(await publicBox({ query }, req.params.token))
}))

/** What the sign-in page offers. The Google client ID is public by design. */
router.get('/auth/config', (_req, res) =>
  res.json({ googleClientId: googleOn() ? env.GOOGLE_CLIENT_ID.split(',')[0].trim() : null, turnstileSiteKey: env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SITE_KEY || null : null }),
)

router.post(
  '/auth/google',
  otpLimiter,
  asyncHandler(async (req, res) => {
    const { credential } = parse(z.object({ credential: z.string().min(20).max(4096) }), req.body)
    const g = await verifyGoogleCredential(credential)
    const customer = await tx(async (c) => {
      const { rows } = await c.query('SELECT id, phone, name, email FROM customers WHERE google_sub = $1 FOR UPDATE', [g.sub])
      if (rows.length) {
        const up = await c.query('UPDATE customers SET email = $2, name = COALESCE(name, $3) WHERE id = $1 RETURNING id, phone, name, email', [rows[0].id, g.email, g.name])
        return up.rows[0]
      }
      const ins = await c.query(
        'INSERT INTO customers (id, phone, name, email, google_sub, created_at) VALUES ($1, NULL, $2, $3, $4, $5) RETURNING id, phone, name, email',
        [newId('cus'), g.name, g.email, g.sub, now()],
      )
      return ins.rows[0]
    })
    await sendTokens(req, res, customer)
  }),
)

router.post(
  '/auth/token/refresh',
  sameSiteOnly,
  otpLimiter,
  asyncHandler(async (req, res) => {
    const token = req.body?.refreshToken || req.cookies?.[RT_COOKIE]
    if (!token) throw unauthorized('Session expired. Please sign in again.', 'INVALID_TOKEN')
    const { userId, refresh } = await rotateRefresh(token, 'customer')
    const { rows } = await query('SELECT id, phone, name, email FROM customers WHERE id = $1', [userId])
    if (!rows.length) throw unauthorized('Session expired. Please sign in again.', 'INVALID_TOKEN')
    const body = { accessToken: signAccess({ sub: rows[0].id, phone: rows[0].phone, typ: 'customer' }), expiresIn: ACCESS_TTL_S, customer: profile(rows[0]) }
    if (cookieMode(req)) {
      if (refresh) res.cookie(RT_COOKIE, refresh.token, { ...rtCookie(), expires: refresh.expiresAt })
      return res.json(body)
    }
    res.json({ ...body, refreshToken: refresh.token })
  }),
)

router.post(
  '/auth/logout',
  sameSiteOnly,
  asyncHandler(async (req, res) => {
    await revokeRefresh(req.body?.refreshToken || req.cookies?.[RT_COOKIE])
    res.clearCookie(RT_COOKIE, rtCookie())
    res.status(204).end()
  }),
)

// ---------------------------------------------------------------- delivery and catalogue

const PIN = z.string().regex(/^\d{6}$/, 'pincode must be 6 digits')

async function serviceable(c, pincode) {
  const { rows } = await c.query('SELECT 1 FROM pincodes WHERE pincode = $1 AND active', [pincode])
  return rows.length > 0
}

const cutoffLabel = () => `${String(getConfig().cutoffHourIST).padStart(2, '0')}:00 IST`

router.get(
  '/delivery/check',
  asyncHandler(async (req, res) => {
    const pincode = parse(PIN, req.query.pincode)
    const ok = await serviceable({ query }, pincode)
    const dates = ok ? await orderableDates({ query }) : []
    const slots = ok ? (await activeSlots({ query })).map(slotView) : []
    res.json({ serviceable: ok, earliestDeliveryDate: dates[0] ?? null, deliveryDates: dates, cutoffTime: cutoffLabel(), slots })
  }),
)

/** Delivery slots on a date with what is left in each. Empty when slots are not in use. */
router.get(
  '/delivery/slots',
  asyncHandler(async (req, res) => {
    const pincode = parse(PIN, req.query.pincode)
    const { date } = await deliveryDateFor({ query }, pincode, req.query.delivery_date || null)
    const slots = await slotsForDate({ query }, date)
    res.json({
      deliveryDate: date,
      slots: slots.map(({ id, label, startsAt, endsAt, remainingBoxes, available }) => ({ id, label, startsAt, endsAt, remainingBoxes, available })),
    })
  }),
)

/** Resolves and validates the delivery date for a pincode (pincode gate first). */
async function deliveryDateFor(c, pincode, wanted) {
  if (!(await serviceable(c, pincode))) throw badRequest('We do not deliver to this pincode yet', 'NOT_SERVICEABLE')
  const dates = await orderableDates(c)
  if (!dates.length) throw conflict('No delivery dates are open right now', 'NO_DELIVERY_DAY')
  if (!wanted) return { date: dates[0], dates }
  if (!dates.includes(wanted)) throw badRequest(`Choose one of: ${dates.join(', ')}`, 'INVALID_DATE')
  return { date: wanted, dates }
}

router.get(
  '/catalogue',
  asyncHandler(async (req, res) => {
    const pincode = parse(PIN, req.query.pincode)
    if (!(await serviceable({ query }, pincode))) return res.json({ serviceable: false, items: [] })
    const wanted = req.query.delivery_date || req.query.deliveryDate || null
    const { date, dates } = await deliveryDateFor({ query }, pincode, wanted)
    const { pool, later } = await tx(async (c) => {
      const pool = await availability(c, date)
      // Later days with stock, so a sold-out choice can say when it is back
      // instead of being a dead end. At most a handful of bookable days.
      const soldOut = shopProducts().some((p) => STAGES.some((st) => !(pool.get(`${p.sku}|${st}`) > 0)))
      const later = []
      if (soldOut) for (const d of dates.filter((x) => x > date)) later.push([d, await availability(c, d)])
      return { pool, later }
    })
    const items = shopProducts().flatMap((p) =>
      STAGES.map((stage) => {
        const key = `${p.sku}|${stage}`
        const qty = pool.get(key) ?? 0
        return {
          sku: p.sku, name: p.name, variety: p.variety, boxSize: p.boxSize, price: p.price, description: p.description ?? '', stage,
          qty, eatBy: eatByFor(stage, date), nextAvailableDate: qty > 0 ? null : (later.find(([, lp]) => lp.get(key) > 0)?.[0] ?? null),
        }
      }),
    )
    res.json({ serviceable: true, deliveryDate: date, deliveryDates: dates, cutoffTime: cutoffLabel(), items })
  }),
)

// ---------------------------------------------------------------- cart

/** Weeks open for preorders, with capacity left per SKU. */
router.get(
  '/preorders/weeks',
  asyncHandler(async (req, res) => {
    const sku = req.query.sku ? String(req.query.sku) : null
    const weeks = (await openWeeks({ query }, sku)).flatMap((w) => {
      const p = sellable(w.sku)
      return p ? [{ ...w, name: p.name, variety: p.variety, boxSize: p.boxSize, price: p.price }] : []
    })
    res.json({ weeks, stages: STAGES, cancelPolicy: 'Cancel any time before packing for a full refund.' })
  }),
)

/** What a box's QR code opens: where the mangoes came from and when they'll be ripe. Public. */

router.use(['/cart', '/checkout', '/orders', '/claims', '/me', '/preorders', '/stock-alerts'], requireCustomer)

const meView = (cu) => ({ ...profile(cu), remindersOptIn: Boolean(cu.reminders_opt_in) })

router.get('/me', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT id, phone, name, email, reminders_opt_in FROM customers WHERE id = $1 AND deleted_at IS NULL', [req.customer.id])
  if (!rows.length) throw notFound('Customer not found')
  res.json(meView(rows[0]))
}))

/** Settings the customer controls: for now, the WhatsApp reminder a week after delivery. */
router.patch('/me', asyncHandler(async (req, res) => {
  const b = parse(z.object({ remindersOptIn: z.boolean() }).strict(), req.body ?? {})
  const { rows } = await query(
    'UPDATE customers SET reminders_opt_in = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING id, phone, name, email, reminders_opt_in',
    [req.customer.id, b.remindersOptIn],
  )
  if (!rows.length) throw notFound('Customer not found')
  res.json(meView(rows[0]))
}))

// ---------------------------------------------------------------- back-in-stock alerts

router.get('/stock-alerts', asyncHandler(async (req, res) => res.json(await listAlerts({ query }, req.customer.id))))

router.post(
  '/stock-alerts',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ sku: z.string().min(1).max(20), stage: z.enum(STAGES), pincode: PIN }), req.body)
    if (!(await serviceable({ query }, b.pincode))) throw badRequest('We do not deliver to this pincode yet', 'NOT_SERVICEABLE')
    res.status(201).json(await tx((c) => createAlert(c, req.customer.id, b)))
  }),
)

router.delete(
  '/stock-alerts/:id',
  asyncHandler(async (req, res) => {
    await tx((c) => cancelAlert(c, req.customer.id, req.params.id))
    res.status(204).end()
  }),
)

// ---------------------------------------------------------------- saved addresses

const MAX_ADDRESSES = 5
const addressView = (a) => ({ id: a.id, name: a.name, address: a.address, pincode: a.pincode, lastUsedAt: a.last_used_at })

/**
 * Remembers the address an order went to, most recent first, at most five.
 * The same address (ignoring case and spacing) is refreshed, not repeated.
 */
export async function rememberAddress(c, customerId, { name, address, pincode }) {
  const same = await c.query(
    `SELECT id FROM customer_addresses WHERE customer_id = $1 AND pincode = $2
        AND lower(regexp_replace(address, '\\s+', ' ', 'g')) = lower(regexp_replace($3, '\\s+', ' ', 'g'))`,
    [customerId, pincode, address],
  )
  if (same.rowCount) {
    await c.query('UPDATE customer_addresses SET last_used_at = $2, name = COALESCE($3, name), address = $4 WHERE id = $1', [same.rows[0].id, now(), name || null, address])
  } else {
    await c.query('INSERT INTO customer_addresses (id, customer_id, name, address, pincode, created_at, last_used_at) VALUES ($1, $2, $3, $4, $5, $6, $6)', [
      newId('adr'), customerId, name || null, address, pincode, now(),
    ])
  }
  await c.query(
    `DELETE FROM customer_addresses WHERE customer_id = $1 AND id NOT IN (
       SELECT id FROM customer_addresses WHERE customer_id = $1 ORDER BY last_used_at DESC, id LIMIT ${MAX_ADDRESSES})`,
    [customerId],
  )
}

router.get(
  '/me/addresses',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM customer_addresses WHERE customer_id = $1 ORDER BY last_used_at DESC, id', [req.customer.id])
    res.json(rows.map(addressView))
  }),
)

router.delete(
  '/me/addresses/:id',
  asyncHandler(async (req, res) => {
    const r = await query('DELETE FROM customer_addresses WHERE id = $1 AND customer_id = $2', [req.params.id, req.customer.id])
    if (!r.rowCount) throw notFound('Address not found')
    res.status(204).end()
  }),
)

/**
 * Deletes the account (DPDP Act, privacy.js). Not while an order or booking
 * is still open or money is still owed back to the customer.
 */
router.delete(
  '/me',
  asyncHandler(async (req, res) => {
    const photos = await tx((c) => eraseCustomer(c, req.customer.id))
    for (const p of photos) await dropPhoto(p)
    logger.info({ customerId: req.customer.id }, 'customer deleted their account')
    res.clearCookie(RT_COOKIE, rtCookie())
    res.status(204).end()
  }),
)

/** Orders need a mobile number: the rider calls it and WhatsApp updates go to it. */
async function requirePhone(c, customerId) {
  const { rows } = await c.query('SELECT name, phone FROM customers WHERE id = $1', [customerId])
  if (!rows[0]?.phone) throw conflict('Add your mobile number first, so the rider can reach you.', 'PHONE_REQUIRED')
  return rows[0]
}

// Adding a mobile number to an account made with Google, checked by code.
router.post(
  '/me/phone/request',
  otpLimiter,
  asyncHandler(async (req, res) => {
    const { phone, channel, captchaToken } = parse(otpRequest, req.body)
    await requireHuman(captchaToken, req.ip)
    res.json(await issueCode(phone, channel))
  }),
)

/**
 * Verifies the code and adds the number. If the number already has an account
 * (they ordered by phone before), the Google sign-in joins that account and the
 * new, empty one goes away; the response carries tokens for the joined account.
 */
router.post(
  '/me/phone/verify',
  otpLimiter,
  asyncHandler(async (req, res) => {
    const { phone, code } = parse(z.object({ phone: phoneSchema, code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }), req.body)
    const out = await tx(async (c) => {
      const error = await consumeCode(c, phone, code)
      if (error) return { error }
      const { rows: mine } = await c.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [req.customer.id])
      const me = mine[0]
      if (!me) throw notFound('Customer not found')
      if (me.phone === phone) return { customer: me }
      if (me.phone) throw conflict('This account already has a mobile number.', 'PHONE_ALREADY_SET')
      const { rows: other } = await c.query('SELECT * FROM customers WHERE phone = $1 FOR UPDATE', [phone])
      if (!other.length) {
        const up = await c.query('UPDATE customers SET phone = $2 WHERE id = $1 RETURNING *', [me.id, phone])
        return { customer: up.rows[0] }
      }
      const target = other[0]
      if (target.google_sub && target.google_sub !== me.google_sub) {
        throw conflict('This number belongs to an account with a different Google login.', 'PHONE_TAKEN')
      }
      // Join: the cart comes along; the Google identity moves to the phone account.
      await c.query(
        `INSERT INTO carts (customer_id, sku, stage, qty)
           SELECT $2, sku, stage, qty FROM carts WHERE customer_id = $1
         ON CONFLICT (customer_id, sku, stage) DO UPDATE SET qty = GREATEST(carts.qty, EXCLUDED.qty)`,
        [me.id, target.id],
      )
      await c.query('DELETE FROM customer_addresses WHERE customer_id = $1', [me.id])
      await c.query('UPDATE order_ratings SET comment = NULL WHERE customer_id = $1', [me.id])
      await c.query('DELETE FROM carts WHERE customer_id = $1', [me.id])
      await c.query('DELETE FROM quotes WHERE customer_id = $1', [me.id])
      await c.query('UPDATE claim_photos SET customer_id = $2 WHERE customer_id = $1', [me.id, target.id])
      await c.query("UPDATE refresh_sessions SET revoked_at = $2 WHERE user_id = $1 AND user_type = 'customer' AND revoked_at IS NULL", [me.id, now()])
      await c.query('DELETE FROM customers WHERE id = $1', [me.id])
      const up = await c.query('UPDATE customers SET google_sub = $2, email = $3, name = COALESCE(name, $4) WHERE id = $1 RETURNING *', [
        target.id, me.google_sub, me.email, me.name,
      ])
      return { customer: up.rows[0], joined: true }
    })
    if (out.error) throw out.error
    await sendTokens(req, res, out.customer)
  }),
)

router.get(
  '/cart',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT sku, stage, qty FROM carts WHERE customer_id = $1 ORDER BY sku, stage', [req.customer.id])
    let date = req.query.deliveryDate || req.query.delivery_date || null
    const pool = await tx(async (c) => {
      date = date ?? (await earliestDeliveryDate(c))
      return availability(c, date)
    })
    const lines = rows.map((l) => {
      const p = findProduct(l.sku)
      // A product taken off sale stays in the cart, shown as unavailable, until removed.
      const avail = p?.active ? (pool.get(`${l.sku}|${l.stage}`) ?? 0) : 0
      return { sku: l.sku, name: p?.name ?? l.sku, stage: l.stage, qty: l.qty, unitPrice: p?.price ?? 0, available: avail, insufficient: avail < l.qty }
    })
    res.json({ deliveryDate: date, lines, subtotal: lines.reduce((s, l) => s + l.unitPrice * l.qty, 0) })
  }),
)

router.post(
  '/cart/items',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ sku: z.string().min(1), stage: z.enum(STAGES), qty: z.number().int().min(0).max(20) }), req.body)
    if (b.qty > 0 && !sellable(b.sku)) throw badRequest(`Unknown SKU ${b.sku}`, 'INVALID_SKU')
    if (b.qty === 0) {
      await query('DELETE FROM carts WHERE customer_id = $1 AND sku = $2 AND stage = $3', [req.customer.id, b.sku, b.stage])
    } else {
      await query(
        `INSERT INTO carts (customer_id, sku, stage, qty) VALUES ($1, $2, $3, $4)
         ON CONFLICT (customer_id, sku, stage) DO UPDATE SET qty = EXCLUDED.qty`,
        [req.customer.id, b.sku, b.stage, b.qty],
      )
    }
    res.status(204).end()
  }),
)

router.delete(
  '/cart/items/:sku',
  asyncHandler(async (req, res) => {
    const stage = req.query.stage ? parse(z.enum(STAGES), req.query.stage) : null
    await query('DELETE FROM carts WHERE customer_id = $1 AND sku = $2 AND ($3::text IS NULL OR stage = $3)', [req.customer.id, req.params.sku, stage])
    res.status(204).end()
  }),
)

// ---------------------------------------------------------------- checkout

router.post(
  '/checkout/quote',
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({
        pincode: PIN, deliveryDate: z.string().optional().nullable(), slotId: z.string().max(64).optional().nullable(),
        promoCode: z.string().max(40).optional().nullable(),
      }),
      req.body,
    )
    const quote = await tx(async (c) => {
      const { date } = await deliveryDateFor(c, b.pincode, b.deliveryDate || null)
      const { rows } = await c.query('SELECT sku, stage, qty FROM carts WHERE customer_id = $1 ORDER BY sku, stage', [req.customer.id])
      if (!rows.length) throw badRequest('Your cart is empty', 'CART_EMPTY')
      const pool = await availability(c, date)
      const lines = rows.map((l) => {
        if (!sellable(l.sku)) throw conflict(`${findProduct(l.sku)?.name ?? l.sku} is no longer sold. Remove it from your cart.`, 'PRODUCT_UNAVAILABLE')
        if ((pool.get(`${l.sku}|${l.stage}`) ?? 0) < l.qty) throw new StockError(l.sku)
        const price = findProduct(l.sku).price
        return { sku: l.sku, name: findProduct(l.sku).name, stage: l.stage, qty: l.qty, unitPrice: price, linePrice: price * l.qty, eatBy: eatByFor(l.stage, date) }
      })
      const subtotal = lines.reduce((s, l) => s + l.linePrice, 0)
      const slot = await quoteSlot(c, date, b.slotId ?? null, lines.reduce((s, l) => s + l.qty, 0))
      const promo = b.promoCode?.trim() ? await applyPromo(c, b.promoCode, req.customer.id, subtotal) : null
      const discount = promo?.discount ?? 0
      const data = {
        pincode: b.pincode, deliveryDate: date, slotId: slot?.id ?? null, slot, lines, subtotal,
        promo: promo ? { code: promo.code, description: promo.description ?? null } : null, discount, total: subtotal - discount,
      }
      const expiresAt = new Date(now().getTime() + getConfig().quoteMinutes * 60_000)
      const quoteId = newId('quo')
      await c.query('INSERT INTO quotes (id, customer_id, data, expires_at) VALUES ($1, $2, $3, $4)', [quoteId, req.customer.id, data, expiresAt])
      return { quoteId, ...data, expiresAt }
    })
    res.json(quote)
  }),
)

/** Checks the customer's slot choice at quote time; confirm re-checks it under lock. */
async function quoteSlot(c, date, wanted, boxes) {
  const slots = await slotsForDate(c, date)
  if (!slots.length) return null
  if (!wanted) throw badRequest('Choose a delivery slot', 'SLOT_REQUIRED')
  const s = slots.find((x) => x.id === wanted)
  if (!s) throw badRequest('That delivery slot is not available', 'SLOT_INVALID')
  if (s.remainingBoxes != null && s.remainingBoxes < boxes) throw conflict(`The ${s.label} slot on ${date} is fully booked`, 'SLOT_FULL')
  return { id: s.id, label: s.label, startsAt: s.startsAt, endsAt: s.endsAt }
}

/** The same request, whatever the key order: a retry must send what the first try sent. */
const stable = (v) => (Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v)
const requestHash = (body) => createHash('sha256').update(JSON.stringify(stable(body))).digest('hex')

/**
 * What an earlier request with this key made, or null. The same key with a
 * different body is a client bug (or a reused key): refused, not replayed.
 */
async function replayFor(key, hash, table) {
  const { rows } = await query(`SELECT k.request_hash AS idem_hash, t.* FROM idempotency_keys k JOIN ${table} t ON t.id = k.order_id WHERE k.key = $1`, [key])
  const r = rows[0]
  if (r?.idem_hash && r.idem_hash !== hash) {
    throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'This request does not match the one first sent with this Idempotency-Key. Use a new key for a new order.')
  }
  return r ?? null
}

const confirmResponse = (o) => ({
  orderId: o.id, number: o.number, status: o.status, total: o.total, deliveryDate: o.delivery_date, slotId: o.slot_id ?? null,
  razorpayOrderId: o.razorpay_order_id, razorpayKeyId: env.RAZORPAY_KEY_ID || null, holdExpiresAt: o.hold_expires_at,
})

router.post(
  '/checkout/confirm',
  asyncHandler(async (req, res) => {
    const rawKey = req.get('Idempotency-Key')
    if (!rawKey || rawKey.length > 100) throw badRequest('An Idempotency-Key header is required', 'IDEMPOTENCY_KEY_REQUIRED')
    const b = parse(
      z.object({
        quoteId: z.string().min(1),
        address: z.string().trim().min(10, 'Enter the full delivery address').max(500),
        name: z.string().trim().max(80).optional(),
        gift: z
          .object({
            recipientName: z.string().trim().min(1, "Enter the recipient's name").max(80),
            recipientPhone: phoneSchema,
            message: z.string().trim().max(200).optional().nullable(),
          })
          .optional()
          .nullable(),
      }),
      req.body,
    )
    const key = `${req.customer.id}:${rawKey}`
    const hash = requestHash(b)
    const existing = () => replayFor(key, hash, 'orders')
    const replay = await existing()
    if (replay) return res.status(200).json(confirmResponse(replay))

    const order = await tx(async (c) => {
      // Claimed first: a concurrent retry with the same key waits here, then replays.
      const ins = await c.query('INSERT INTO idempotency_keys (key, order_id, created_at, request_hash) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [key, 'pending', now(), hash])
      if (!ins.rowCount) return null
      const { rows } = await c.query('SELECT * FROM quotes WHERE id = $1 AND customer_id = $2 FOR UPDATE', [b.quoteId, req.customer.id])
      const q = rows[0]
      if (!q || q.expires_at <= now()) throw conflict('This quote has expired. Review your cart again.', 'QUOTE_EXPIRED')
      const { date } = await deliveryDateFor(c, q.data.pincode, q.data.deliveryDate)
      if (b.name) await c.query('UPDATE customers SET name = $2 WHERE id = $1', [req.customer.id, b.name])
      const cust = await requirePhone(c, req.customer.id)
      const subtotal = q.data.lines.reduce((t, l) => t + l.unitPrice * l.qty, 0)
      // The code is checked again, locked, so a limited code can't be over-used.
      const promo = q.data.promo ? await applyPromo(c, q.data.promo.code, req.customer.id, subtotal, { lock: true }) : null
      const created = await createOrder(
        c,
        {
          customerId: req.customer.id, customerName: b.name ?? cust.name, phone: cust.phone, pincode: q.data.pincode, address: b.address,
          deliveryDate: date, slotId: q.data.slotId ?? null, strictSlot: Boolean(q.data.slotId), status: 'PAYMENT_PENDING', paymentStatus: 'INITIATED', allOrNothing: true,
          holdExpiresAt: new Date(now().getTime() + getConfig().holdMinutes * 60_000),
          lines: q.data.lines.map((l) => ({ sku: l.sku, stage: l.stage, qty: l.qty, unitPrice: l.unitPrice })),
          discount: promo?.discount ?? 0, promoCode: promo?.code ?? null,
          gift: b.gift ? { recipientName: b.gift.recipientName, recipientPhone: b.gift.recipientPhone, message: b.gift.message || null } : null,
        },
        req.actor,
      )
      if (promo) await recordRedemption(c, { orderId: created.id, code: promo.code, customerId: req.customer.id, discount: promo.discount })
      // A gift goes to someone else's address, which isn't ours to keep offering.
      if (!b.gift) await rememberAddress(c, req.customer.id, { name: b.name ?? cust.name, address: b.address, pincode: q.data.pincode })
      await c.query('UPDATE idempotency_keys SET order_id = $2 WHERE key = $1', [key, created.id])
      await c.query('DELETE FROM quotes WHERE id = $1', [q.id])
      await c.query('DELETE FROM carts WHERE customer_id = $1', [req.customer.id])
      return (await c.query('SELECT * FROM orders WHERE id = $1', [created.id])).rows[0]
    })
    if (!order) return res.status(200).json(confirmResponse(await existing()))

    try {
      const rzp = await createGatewayOrder({ amount: order.total, receipt: order.number, orderId: order.id })
      await query('UPDATE orders SET razorpay_order_id = $2 WHERE id = $1', [order.id, rzp])
      order.razorpay_order_id = rzp
    } catch (err) {
      logger.error({ err, orderId: order.id }, 'could not create the gateway order')
      await tx((c) => processPayment(c, { orderId: order.id, outcome: 'abandoned' }, SYSTEM))
      throw new HttpError(502, 'PAYMENT_GATEWAY_ERROR', 'Could not start the payment. Please try again.')
    }
    res.status(201).json(confirmResponse(order))
  }),
)

// ---------------------------------------------------------------- orders

async function ownOrder(c, req) {
  const { rows } = await c.query('SELECT * FROM orders WHERE id = $1 AND customer_id = $2', [req.params.id, req.customer.id])
  if (!rows.length) throw notFound('Order not found')
  return rows[0]
}

router.get(
  '/orders',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT o.*, (SELECT COALESCE(SUM(quantity), 0)::int FROM order_items i WHERE i.order_id = o.id) AS item_count
         FROM orders o WHERE customer_id = $1 ORDER BY placed_at DESC LIMIT 100`,
      [req.customer.id],
    )
    res.json(rows.map((o) => ({ id: o.id, number: o.number, status: o.status, deliveryDate: o.delivery_date, total: o.total, itemCount: o.item_count, placedAt: o.placed_at })))
  }),
)

router.get(
  '/orders/:id',
  asyncHandler(async (req, res) => {
    const o = await ownOrder({ query }, req)
    const [items, events, slot, proof, rating] = await Promise.all([
      query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY sku, stage', [o.id]),
      query(`SELECT status, created_at FROM order_events WHERE order_id = $1 AND from_status IS DISTINCT FROM status ORDER BY created_at, id`, [o.id]),
      o.slot_id ? query('SELECT * FROM delivery_slots WHERE id = $1', [o.slot_id]) : { rows: [] },
      customerDelivery({ query }, o),
      query('SELECT stars, comment, updated_at FROM order_ratings WHERE order_id = $1', [o.id]),
    ])
    const r = rating.rows[0]
    res.json({
      rating: r ? { stars: r.stars, comment: r.comment, at: r.updated_at } : null,
      slot: slot.rows[0] ? (({ id, label, startsAt, endsAt }) => ({ id, label, startsAt, endsAt }))(slotView(slot.rows[0])) : null,
      id: o.id, number: o.number, status: o.status, deliveryDate: o.delivery_date, placedAt: o.placed_at, pincode: o.pincode,
      deliveryAddress: o.delivery_address, subtotal: o.subtotal, discount: o.discount, promoCode: o.promo_code, total: o.total, paymentStatus: o.payment_status,
      gift: o.gift_recipient_name ? { recipientName: o.gift_recipient_name, recipientPhone: o.gift_recipient_phone, message: o.gift_message } : null,
      refundStatus: o.refunded_at ? 'REFUNDED' : o.refund_requested_at ? 'PENDING' : null, razorpayOrderId: o.razorpay_order_id,
      holdExpiresAt: o.hold_expires_at,
      items: items.rows.map((i) => ({ sku: i.sku, name: findProduct(i.sku)?.name ?? i.sku, stage: i.stage, quantity: i.quantity, unitPrice: i.unit_price, linePrice: i.line_price, eatBy: i.stage ? eatByFor(i.stage, o.delivery_date) : null, readyOn: i.stage ? readyOnFor(i.stage, o.delivery_date) : null })),
      timeline: events.rows.map((e) => ({ status: e.status, at: e.created_at })),
      ...proof,
    })
  }),
)

router.get(
  '/orders/:id/delivery-photo',
  asyncHandler(async (req, res) => {
    await sendPhoto(res, await customerPhoto({ query }, await ownOrder({ query }, req)))
  }),
)

router.get(
  '/orders/:id/payment-status',
  asyncHandler(async (req, res) => {
    const o = await ownOrder({ query }, req)
    res.json({ status: o.payment_status, orderStatus: o.status })
  }),
)

router.post(
  '/orders/:id/cancel',
  asyncHandler(async (req, res) => {
    const refundDue = await tx((c) => customerCancel(c, req.params.id, req.customer.id, req.actor))
    if (refundDue) {
      await refundOrder(req.params.id).catch((err) => logger.error({ err, orderId: req.params.id }, 'refund failed; maintenance will retry'))
    }
    res.status(204).end()
  }),
)

/** Statuses in which a customer may move their own order to another day: before packing starts. */
const CUSTOMER_MOVABLE = ['CONFIRMED']

router.post(
  '/orders/:id/reschedule',
  asyncHandler(async (req, res) => {
    const { deliveryDate, slotId } = parse(
      z.object({ deliveryDate: z.string().refine(isDate, 'deliveryDate must be YYYY-MM-DD'), slotId: z.string().max(64).optional().nullable() }),
      req.body,
    )
    await tx((c) =>
      moveOrderToDate(c, req.params.id, {
        deliveryDate, slotId: slotId ?? null, statuses: CUSTOMER_MOVABLE, actor: req.actor, why: 'Customer changed the delivery day', customerId: req.customer.id,
      }),
    )
    res.status(204).end()
  }),
)

/** Stars (1 to 5) and an optional note on a delivered order. Can be changed later. */
router.put(
  '/orders/:id/rating',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ stars: z.number().int().min(1).max(5), comment: z.string().trim().max(500).optional().nullable() }), req.body)
    const o = await ownOrder({ query }, req)
    if (o.status !== 'DELIVERED') throw badRequest('You can rate an order once it is delivered', 'NOT_DELIVERED')
    await query(
      `INSERT INTO order_ratings (order_id, customer_id, stars, comment, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (order_id) DO UPDATE SET stars = EXCLUDED.stars, comment = EXCLUDED.comment, updated_at = EXCLUDED.updated_at`,
      [o.id, req.customer.id, b.stars, b.comment || null, now()],
    )
    res.status(204).end()
  }),
)

// ---------------------------------------------------------------- preorders

router.post(
  '/preorders',
  asyncHandler(async (req, res) => {
    const rawKey = req.get('Idempotency-Key')
    if (!rawKey || rawKey.length > 100) throw badRequest('An Idempotency-Key header is required', 'IDEMPOTENCY_KEY_REQUIRED')
    const b = parse(
      z.object({
        sku: z.string().min(1), stage: z.enum(STAGES), qty: z.number().int().min(1).max(20),
        weekStart: z.string().refine(isDate, 'weekStart must be YYYY-MM-DD'), pincode: PIN,
        address: z.string().trim().min(10, 'Enter the full delivery address').max(500), name: z.string().trim().max(80).optional(),
        slotId: z.string().max(64).optional().nullable(), waitlist: z.boolean().optional(),
      }),
      req.body,
    )
    const key = `${req.customer.id}:pre:${rawKey}`
    const hash = requestHash(b)
    const existing = () => replayFor(key, hash, 'preorders')
    const replay = await existing()
    if (replay) return res.status(200).json(preorderView(replay))
    const pre = await tx(async (c) => {
      const ins = await c.query('INSERT INTO idempotency_keys (key, order_id, created_at, request_hash) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [key, 'pending', now(), hash])
      if (!ins.rowCount) return null
      if (b.name) await c.query('UPDATE customers SET name = $2 WHERE id = $1', [req.customer.id, b.name])
      const cust = await requirePhone(c, req.customer.id)
      const p = await bookPreorder(c, { ...b, customerId: req.customer.id, name: b.name ?? cust.name, phone: cust.phone }, req.actor)
      await c.query('UPDATE idempotency_keys SET order_id = $2 WHERE key = $1', [key, p.id])
      return p
    })
    if (!pre) return res.status(200).json(preorderView(await existing()))
    if (pre.status !== 'PAYMENT_PENDING') return res.status(201).json(preorderView(pre))
    try {
      res.status(201).json(preorderView(await ensurePaymentLink(pre.id)))
    } catch (err) {
      logger.error({ err, preorderId: pre.id }, 'could not create the preorder payment link')
      await tx((c) => cancelPreorder(c, pre.id, req.customer.id, SYSTEM))
      throw new HttpError(502, 'PAYMENT_GATEWAY_ERROR', 'Could not start the payment. Please try again.')
    }
  }),
)

router.get(
  '/preorders',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM preorders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50', [req.customer.id])
    res.json(rows.map(preorderView))
  }),
)

router.get(
  '/preorders/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM preorders WHERE id = $1 AND customer_id = $2', [req.params.id, req.customer.id])
    if (!rows.length) throw notFound('Preorder not found')
    res.json(preorderView(rows[0]))
  }),
)

router.post(
  '/preorders/:id/cancel',
  asyncHandler(async (req, res) => {
    const r = await tx((c) => cancelPreorder(c, req.params.id, req.customer.id, req.actor))
    const send = r.refund === 'order' ? refundOrder : r.refund === 'preorder' ? refundPreorder : null
    if (send) await send(r.id).catch((err) => logger.error({ err, id: r.id }, 'refund failed; maintenance will retry'))
    res.status(204).end()
  }),
)

// ---------------------------------------------------------------- claims

export const MAX_CLAIM_PHOTOS = 3

/** A claim photo is uploaded first (raw image body), then linked by id when the claim is sent. */
router.post(
  '/claims/photos',
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_PHOTO_BYTES }),
  asyncHandler(async (req, res) => {
    const { mime, ext } = checkPhoto(req.body)
    const loose = await query('SELECT COUNT(*)::int AS n FROM claim_photos WHERE customer_id = $1 AND claim_id IS NULL', [req.customer.id])
    if (loose.rows[0].n >= 10) throw new HttpError(429, 'TOO_MANY_PHOTOS', 'Send your claim with the photos you have added first')
    const id = newId('cph')
    const saved = await storePhoto(`claims/${req.customer.id}`, id, req.body, ext, mime)
    await query('INSERT INTO claim_photos (id, customer_id, mime, bytes, blob_path, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [
      id, req.customer.id, mime, saved.bytes, saved.blobPath, now(),
    ])
    res.status(201).json({ id })
  }),
)

router.post(
  '/claims',
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({
        orderId: z.string().min(1),
        issueType: z.enum(['DAMAGED', 'WRONG_ITEM', 'NOT_DELIVERED']),
        description: z.string().trim().min(5).max(2000),
        itemSkus: z.array(z.string()).max(20).default([]),
        photoUrl: z.string().url().startsWith('https://').max(500).optional().nullable(),
        photoIds: z.array(z.string().max(40)).max(MAX_CLAIM_PHOTOS).default([]),
      }),
      req.body,
    )
    const claim = await tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM orders WHERE id = $1 AND customer_id = $2 FOR UPDATE', [b.orderId, req.customer.id])
      if (!rows.length) throw notFound('Order not found')
      if (rows[0].status !== 'DELIVERED') throw badRequest('Claims can only be raised on delivered orders', 'NOT_DELIVERED')
      const { rows: ev } = await c.query(`SELECT MAX(created_at) AS at FROM order_events WHERE order_id = $1 AND status = 'DELIVERED'`, [b.orderId])
      const windowMs = getConfig().claimWindowHours * 3_600_000
      if (ev[0].at && now().getTime() - ev[0].at.getTime() > windowMs) {
        throw badRequest(`Claims must be raised within ${getConfig().claimWindowHours} hours of delivery`, 'CLAIM_WINDOW_CLOSED')
      }
      const { rows: skus } = await c.query('SELECT DISTINCT sku FROM order_items WHERE order_id = $1', [b.orderId])
      const valid = new Set(skus.map((s) => s.sku))
      const bad = b.itemSkus.find((s) => !valid.has(s))
      if (bad) throw badRequest(`${bad} is not in this order`, 'INVALID_SKU')
      const open = await c.query(`SELECT 1 FROM claims WHERE order_id = $1 AND status <> 'RESOLVED'`, [b.orderId])
      if (open.rowCount) throw conflict('A claim for this order is already open')
      const replaced = await c.query(`SELECT 1 FROM claims WHERE order_id = $1 AND resolution = 'REPLACEMENT_APPROVED'`, [b.orderId])
      if (replaced.rowCount) throw conflict('This order was already replaced. For a problem with the replacement, raise a claim on that order.', 'ALREADY_REPLACED')
      // More than a few claims a month is unusual: those go to a person, not the form.
      const recent = await c.query('SELECT COUNT(*)::int AS n FROM claims WHERE customer_id = $1 AND created_at >= $2', [
        req.customer.id, new Date(now().getTime() - 30 * 86_400_000),
      ])
      if (recent.rows[0].n >= MAX_CLAIMS_PER_MONTH) {
        throw new HttpError(429, 'CLAIM_LIMIT', `You have raised ${recent.rows[0].n} claims this month. Please message us on WhatsApp and we'll sort it out with you.`)
      }
      const id = newId('clm')
      await c.query(
        `INSERT INTO claims (id, order_id, customer_id, issue_type, description, affected_items, photo_url, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, b.orderId, req.customer.id, b.issueType, b.description, [...new Set(b.itemSkus)], b.photoUrl ?? null, now()],
      )
      const photoIds = [...new Set(b.photoIds)]
      if (photoIds.length) {
        const linked = await c.query('UPDATE claim_photos SET claim_id = $1 WHERE id = ANY($2) AND customer_id = $3 AND claim_id IS NULL', [id, photoIds, req.customer.id])
        if (linked.rowCount !== photoIds.length) throw badRequest('One of the photos was not found. Add it again.', 'PHOTO_NOT_FOUND')
      }
      return { id, status: 'SUBMITTED', photos: photoIds.length }
    })
    res.status(201).json(claim)
  }),
)

router.get(
  '/claims',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT c.*, o.number, r.number AS replacement_number FROM claims c JOIN orders o ON o.id = c.order_id
         LEFT JOIN orders r ON r.id = c.replacement_order_id WHERE c.customer_id = $1 ORDER BY c.created_at DESC`,
      [req.customer.id],
    )
    res.json(
      rows.map((c) => ({
        id: c.id, orderId: c.order_id, orderNumber: c.number, issueType: c.issue_type, status: c.status, resolution: c.resolution,
        replacementOrder: c.replacement_order_id ? { id: c.replacement_order_id, number: c.replacement_number } : null, createdAt: c.created_at,
      })),
    )
  }),
)

// ---------------------------------------------------------------- dev-only

export const devRouter = express.Router()

devRouter.post(
  '/pay',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ orderId: z.string().min(1), outcome: z.enum(['captured', 'failed']) }), req.body)
    const r = await tx((c) => processPayment(c, { orderId: b.orderId, outcome: b.outcome, paymentId: `pay_dev_${newId('p').slice(2)}`, method: 'dev' }))
    if (r.result === 'refund_due') await refundOrder(b.orderId)
    if (r.result === 'duplicate_payment') await refundDuplicatePayments()
    res.json({ result: r.result })
  }),
)

// Pays (or fails) a preorder's payment link, as the Razorpay webhook would.
devRouter.post(
  '/pay-preorder',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ preorderId: z.string().min(1), outcome: z.enum(['captured', 'failed']) }), req.body)
    const r = await tx((c) =>
      processPreorderPayment(c, { preorderId: b.preorderId, outcome: b.outcome, paymentId: `pay_dev_${newId('p').slice(2)}`, method: 'dev' }),
    )
    if (r === 'refund_due') await refundPreorder(b.preorderId)
    res.json({ result: r })
  }),
)

devRouter.post(
  '/mark-paid-at-gateway',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ orderId: z.string().min(1), outcome: z.enum(['captured', 'failed']) }), req.body)
    const { rows } = await query('SELECT razorpay_order_id, total FROM orders WHERE id = $1', [b.orderId])
    if (!rows[0]?.razorpay_order_id) throw notFound('Order not found or has no gateway order')
    devGateway.set(rows[0].razorpay_order_id, { id: `pay_dev_${newId('p').slice(2)}`, status: b.outcome, amount: rows[0].total, method: 'dev' })
    res.json({ ok: true })
  }),
)

devRouter.post('/reconcile', asyncHandler(async (_req, res) => res.json({ reconciled: await reconcilePendingPayments({ minAgeSeconds: 0 }) })))
