// /v1: the customer storefront API. Phone OTP login, catalogue by pincode and
// delivery date, cart, checkout with stock holds, orders and claims.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import express from 'express'
import { z } from 'zod'
import { ACCESS_TTL_S, forgetCustomer, issueRefresh, refreshLimiter, requireCustomer, revokeRefresh, rotateRefresh, sameSiteOnly, signAccess } from './auth.js'
import { isDate, now, todayIST } from './clock.js'
import { getConfig } from './config.js'
import { query, tx } from './db.js'
import { customerDelivery, customerPhoto } from './delivery-proof.js'
import { activeSlots, checkCapacity, earliestDeliveryDate, orderableDates, slotsForDate, slotView } from './delivery.js'
import { env, isProd } from './env.js'
import { asyncHandler, badRequest, conflict, HttpError, notFound, parse, StockError, unauthorized } from './errors.js'
import { newId } from './ids.js'
import { availability, availabilityByDate } from './inventory.js'
import { logger } from './logger.js'
import { metrics } from './metrics.js'
import { checkUnpaidLimit, createOrder, HOLD_EXPIRED_REASON, customerCancel, MAX_DELIVERY_ATTEMPTS, eatByFor, moveOrderToDate, processPayment, SYSTEM } from './orders.js'
import { enqueue } from './notify.js'
import { createGatewayOrder, devGateway, reconcileOrderNow, reconcilePendingPayments, refundsFor, sendDueRefunds, verifyCheckoutSignature } from './payments.js'
import { findProduct, sellable, shopProducts } from './products.js'
import { bookPreorder, cancelPreorder, ensurePaymentLink, openWeeks, preorderView, processPreorderPayment } from './preorders.js'
import { hit, OTP_IP_WINDOW_MS, otpIpLimit, sharedLimiter } from './ratelimit.js'
import { reportProblem } from './sentry.js'
import { sendOtp } from './sms.js'
import { googleOn, verifyGoogleCredential } from './google.js'
import { STAGES } from './stage.js'
import { applyPromo, recordRedemption } from './promos.js'
import { checkPhoto, cleanImage, dropPhoto, isOwnPhotoUrl, MAX_PHOTO_BYTES, photoWidth, sendPhoto, sendPublicPhoto, storePhoto } from './photos.js'
import { customerReviews } from './review-routes.js'
import { eraseCustomer } from './privacy.js'
import { requireHuman } from './turnstile.js'
import { cancelAlert, createAlert, listAlerts } from './engagement.js'
import { readyOnFor } from './ripeness.js'
import { bulkCartView, bulkQuoteLines, cartBulk, checkBulkLinesAtConfirm, publicBulk } from './bulk-routes.js'
import { billFor, billView } from './bills.js'
import { customerBills } from './bill-routes.js'
import { gstinProblem, normaliseGstin } from './gstin.js'
import { isOn } from './feature-switches.js'
import { appFeel } from './app-feel-routes.js'
import { languages } from './language-routes.js'
import { BROWSER_ID, rememberCheckout } from './funnel.js'
import { setConsent } from './wa/consent.js'
import { growthMe, growthPublic } from './growth-routes.js'
import { moveFavourites } from './favourites.js'
import { movePushSubscriptions, pushPublicKey } from './push.js'
import { trackingFor } from './route.js'
import { customerGifts, devGifts } from './gift-routes.js'
import { care } from './care-routes.js'
import { partnerPublic } from './partner/routes.js'
import { devFarm, farmCustomer, farmPublic } from './farm/routes.js'
import { orderCycle, subscriptionsOpen } from './subscriptions.js'

export const router = express.Router()

// Per address, counted in Postgres so every serverless instance shares it.
// High enough for a carrier NAT address at a launch spike (ratelimit.js otpIpLimit).
const otpLimiter = sharedLimiter('otp-ip', { windowMs: OTP_IP_WINDOW_MS, limit: otpIpLimit() })

/**
 * Per signed-in customer, not per address (many customers share a carrier NAT address):
 * a quote, a confirm and a cancel each hold stock rows and may call Razorpay, so one
 * account looping on them is stopped at CUSTOMER_ACTION_LIMIT a minute (20; the shop
 * itself sends a handful). Counted in Postgres, so every instance shares the count.
 */
export const CUSTOMER_ACTION_WINDOW_MS = 60_000
const perCustomer = (name) =>
  sharedLimiter(`customer-${name}`, {
    windowMs: CUSTOMER_ACTION_WINDOW_MS,
    limit: () => env.CUSTOMER_ACTION_LIMIT,
    keyGenerator: (req) => req.customer.id,
    message: 'Too many tries in a minute. Wait a moment and try again.',
  })

/** Claims a customer can raise in 30 days from the app. */
const MAX_CLAIMS_PER_MONTH = 3

const OTP_TTL_MS = 5 * 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
// Wrong tries allowed on one code.
const OTP_MAX_ATTEMPTS = 3
// Codes one address may ask for one number. Counted per number and address,
// so someone else asking for your number can't use up your allowance.
const OTP_MAX_SENDS_PER_HOUR = 5
const OTP_MAX_SENDS_PER_DAY = 10
// Codes a number gets in a day from every address together. This caps
// guessing: 16 codes x 3 tries = 48 guesses a day at a 6-digit code, no more
// than the old 10 codes x 5 tries, however many addresses an attacker uses.
const OTP_MAX_SENDS_PER_NUMBER_DAY = 16

/**
 * Stops SMS pumping: every code costs money, and bots request codes for
 * numbers they don't own. Each number gets 10 codes a day, and the whole shop
 * a daily budget (OTP_DAILY_LIMIT). Numbers with no account may use only part
 * of it (OTP_NEW_NUMBER_SHARE), so a flood of new numbers can't lock existing
 * customers out. Past 80% of the budget Sentry is told; past 100% no more
 * codes go out until midnight IST (Google sign-in still works).
 */
async function checkOtpBudget(phone, ip) {
  const day = todayIST()
  const hour = await hit(`otp-phone-ip-hour:${phone}:${ip}`, HOUR_MS)
  if (hour.hits > OTP_MAX_SENDS_PER_HOUR) throw new HttpError(429, 'OTP_LIMIT', 'Too many codes requested. Try again in an hour.')
  const mine = await hit(`otp-phone-ip-day:${phone}:${ip}:${day}`, DAY_MS)
  if (mine.hits > OTP_MAX_SENDS_PER_DAY) throw new HttpError(429, 'OTP_LIMIT', 'Too many codes for this number today. Try again tomorrow.')
  const number = await hit(`otp-phone-day:${phone}:${day}`, DAY_MS)
  if (number.hits > OTP_MAX_SENDS_PER_NUMBER_DAY) {
    throw new HttpError(429, 'OTP_LIMIT', 'Too many codes for this number today. Sign in with Google, or try again tomorrow.')
  }
  const known = (await query('SELECT 1 FROM customers WHERE phone = $1 AND deleted_at IS NULL', [phone])).rowCount > 0
  // SEC-07, a known trade-off: while new numbers are paused, the 503 below tells a watcher
  // that a number has no account. Answering everyone alike would lock existing customers out
  // during an SMS-pumping attack, or claim a code was sent when it wasn't. It lasts only while
  // the budget is spent (Sentry is told). See README "Security and privacy notes".
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
export const phoneSchema = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, ''))
  .refine((s) => /^[6-9]\d{9}$/.test(s), 'Enter a 10-digit Indian mobile number')
  .transform((s) => `+91${s}`)

const otpRequest = z.object({ phone: phoneSchema, channel: z.enum(['sms', 'whatsapp']).optional(), captchaToken: z.string().max(2048).optional() })

// SEC-13: OTP_PEPPER keeps login-code hashes apart from the token key. Codes are checked against
// JWT_SECRET too, so setting OTP_PEPPER doesn't break codes sent in the five minutes before.
const peppers = () => [...new Set([env.OTP_PEPPER, env.JWT_SECRET].filter(Boolean))]
const hashOtp = (phone, code, pepper = peppers()[0]) => createHash('sha256').update(`${pepper}:${phone}:${code}`).digest()
const otpMatches = (stored, phone, code) => {
  const want = Buffer.from(stored, 'hex')
  // Every pepper is tried (no early exit), so the time taken doesn't say which one matched.
  return peppers().map((p) => want.length === 32 && timingSafeEqual(want, hashOtp(phone, code, p))).some(Boolean)
}

// ---------------------------------------------------------------- auth

/**
 * Stores a fresh login code for the phone and sends it. Every limit is checked
 * first, so a refused request never replaces the code someone is about to type.
 */
async function issueCode(phone, channel, ip) {
  await checkOtpBudget(phone, ip)
  const code = String(randomInt(100_000, 1_000_000))
  const at = now()
  const store = () =>
    query(
      `INSERT INTO otps (phone, code, expires_at, attempts, resends, window_start) VALUES ($1, $2, $3, 0, 1, $4)
       ON CONFLICT (phone) DO UPDATE SET code = $2, expires_at = $3, attempts = 0, resends = otps.resends + 1`,
      [phone, hashOtp(phone, code).toString('hex'), new Date(at.getTime() + OTP_TTL_MS), at],
    )
  // INT-13 (24 Oct audit, PROVIDER_CHECKS): the new code replaces the old one only once a
  // channel accepted it, so a failed send leaves the customer's earlier code working.
  if (!env.PROVIDER_CHECKS) await store()
  const via = await sendOtp(phone, code, channel)
  if (env.PROVIDER_CHECKS) await store()
  // SEC-01: never in production, and not when the shop is on a public link (start-local --phone).
  return isProd || !env.OTP_CODE_IN_RESPONSE ? { sent: true, channel: via } : { sent: true, channel: via, devCode: code }
}

/** Checks a code inside a transaction. Returns an error to throw after commit (so wrong tries count), or null. */
async function consumeCode(c, phone, code) {
  const { rows } = await c.query('SELECT * FROM otps WHERE phone = $1 FOR UPDATE', [phone])
  const otp = rows[0]
  if (!otp || otp.expires_at <= now()) return unauthorized('This code has expired. Request a new one.', 'OTP_EXPIRED')
  if (otp.attempts >= OTP_MAX_ATTEMPTS) return unauthorized('Too many wrong codes. Request a new one.', 'OTP_LOCKED')
  if (!otpMatches(otp.code, phone, code)) {
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
    const known = (await query('SELECT 1 FROM customers WHERE phone = $1', [phone])).rowCount > 0
    await requireHuman(captchaToken, req.ip, { known })
    res.json(await issueCode(phone, channel, req.ip))
  }),
)

// The web shop keeps the refresh token in an httpOnly cookie (sent with
// "X-Session: cookie"), out of reach of page scripts. Other clients get it in
// the response body, as before.
const RT_COOKIE = 'mm_customer_rt'
const rtCookie = () => ({ httpOnly: true, secure: env.COOKIE_SECURE, sameSite: env.COOKIE_SAMESITE, path: '/v1/auth' })
const cookieMode = (req) => req.get('x-session') === 'cookie'

const profile = (cu) => ({ id: cu.id, phone: cu.phone ?? null, name: cu.name ?? null, email: cu.email ?? null })

/** The customer's session version: "sign out everywhere" raises it, ending access tokens already issued. */
const sessionVersion = async (id) => (await query('SELECT session_version FROM customers WHERE id = $1', [id])).rows[0]?.session_version ?? 0
const customerAccess = async (cu) => signAccess({ sub: cu.id, phone: cu.phone ?? null, typ: 'customer', sv: await sessionVersion(cu.id) })

async function sendTokens(req, res, customer) {
  const refresh = await issueRefresh(customer.id, 'customer')
  const body = { accessToken: await customerAccess(customer), expiresIn: ACCESS_TTL_S, customer: profile(customer) }
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
  refreshLimiter('customer', RT_COOKIE),
  asyncHandler(async (req, res) => {
    const token = req.body?.refreshToken || req.cookies?.[RT_COOKIE]
    if (!token) throw unauthorized('Session expired. Please sign in again.', 'INVALID_TOKEN')
    const { userId, refresh } = await rotateRefresh(token, 'customer')
    const { rows } = await query('SELECT id, phone, name, email FROM customers WHERE id = $1', [userId])
    if (!rows.length) throw unauthorized('Session expired. Please sign in again.', 'INVALID_TOKEN')
    const body = { accessToken: await customerAccess(rows[0]), expiresIn: ACCESS_TTL_S, customer: profile(rows[0]) }
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

export async function serviceable(c, pincode) {
  const { rows } = await c.query('SELECT 1 FROM pincodes WHERE pincode = $1 AND active', [pincode])
  return rows.length > 0
}

export const cutoffLabel = () => `${String(getConfig().cutoffHourIST).padStart(2, '0')}:00 IST`

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
export async function deliveryDateFor(c, pincode, wanted) {
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
    // One read of the stock for the chosen day and the later bookable days, so
    // a sold-out choice can say when it is back instead of being a dead end.
    const byDate = await availabilityByDate({ query }, [date, ...dates.filter((x) => x > date)])
    const pool = byDate.get(date)
    const later = [...byDate].filter(([d]) => d !== date)
    const items = shopProducts().flatMap((p) =>
      STAGES.map((stage) => {
        const key = `${p.sku}|${stage}`
        const qty = pool.get(key) ?? 0
        return {
          sku: p.sku, name: p.name, variety: p.variety, boxSize: p.boxSize, price: p.price, description: p.description ?? '', photoUrl: p.photoUrl, stage,
          fruitsPerBox: p.fruitsPerBox, fruitWeightG: p.fruitWeightG,
          qty, eatBy: eatByFor(stage, date), nextAvailableDate: qty > 0 ? null : (later.find(([, lp]) => lp.get(key) > 0)?.[0] ?? null),
        }
      }),
    )
    res.json({ serviceable: true, deliveryDate: date, deliveryDates: dates, cutoffTime: cutoffLabel(), items })
  }),
)

/**
 * UX-3: the live rules the shop's help and terms pages quote, so they never drift from what the
 * API enforces: how long boxes are held at Pay, the order cutoff, how far ahead a day can be
 * booked and how long after delivery a problem can be reported.
 */
router.get('/policy', (_req, res) => {
  const cfg = getConfig()
  res.json({
    holdMinutes: cfg.holdMinutes, cutoffTime: cutoffLabel(), maxDaysAhead: cfg.maxDaysAhead, claimWindowHours: cfg.claimWindowHours,
    // bills: checkout offers a business name and GSTIN for the bill only while bills are on (BILLS_ENABLED).
    bills: isOn('BILLS_ENABLED'),
    // App feel (docs/app-feel.md): which of the shop's switchable parts are on, so each can be turned off on its own.
    features: {
      // Effective values: a manager may have changed these on the panel (PANEL_FEATURE_SWITCHES, docs/ops.md).
      installApp: isOn('SHOP_INSTALL'),
      push: Boolean(pushPublicKey()),
      tracking: isOn('LIVE_TRACKING'),
      favourites: isOn('FAVOURITES'),
      sortFilter: isOn('SHOP_SORT_FILTER'),
      // Growth (docs/growth.md): refer a friend on the Account page and at checkout, and the anonymous funnel steps.
      referrals: isOn('REFERRALS'),
      funnel: isOn('FUNNEL_ANALYTICS'),
      // MULTI_GIFT: "Send to many" from the gift flow, up to this many recipients.
      multiGift: isOn('MULTI_GIFT'),
      // Partner With Us links (PARTNER_NETWORK, docs/partner-network.md).
      partnerNetwork: isOn('PARTNER_NETWORK'),
      // Farm Experience in Bulk Deals (FARM_EXPERIENCE, docs/farm-experience.md).
      farmExperience: isOn('FARM_EXPERIENCE'),
      // SHOP_LANGUAGES: the shop in Hindi and Kannada as well as English (docs/languages.md).
      languages: isOn('SHOP_LANGUAGES'),
    },
    ...(isOn('MULTI_GIFT') ? { multiGiftMaxRecipients: env.MULTI_GIFT_MAX_RECIPIENTS } : {}),
    // Customer care (docs/care.md): help requests with a message thread, and subscriptions (and whether new ones can start).
    // Named only while one is on, so an API with both off answers as before.
    ...(isOn('HELP_CENTRE') || isOn('SUBSCRIPTIONS')
      ? { care: { helpCentre: isOn('HELP_CENTRE'), subscriptions: isOn('SUBSCRIPTIONS'), subscriptionsOpen: subscriptionsOpen() } }
      : {}),
  })
})

/**
 * UX-5: every box on sale with its price, before a pincode is known, so a first visit
 * (or a visitor from outside the delivery area) sees the varieties and prices. Stock and
 * ripeness depend on the delivery day, so they stay on /catalogue, which needs a pincode.
 */
router.get('/products', (_req, res) =>
  res.json({
    items: shopProducts().map((p) => ({
      sku: p.sku, name: p.name, variety: p.variety, boxSize: p.boxSize, price: p.price, description: p.description ?? '', photoUrl: p.photoUrl,
      fruitsPerBox: p.fruitsPerBox, fruitWeightG: p.fruitWeightG,
    })),
  }),
)

/**
 * A product's photo, for the shop's tiles and product page. Public: product
 * photos are not private. Each new photo has a new ?v=, so it can be cached for a year.
 * ?w= (one of PHOTO_WIDTHS) sends it resized to that width, for tiles and srcset.
 */
router.get(
  '/products/:sku/photo',
  asyncHandler(async (req, res) => {
    const width = photoWidth(req.query.w)
    const { rows } = await query('SELECT mime, bytes, blob_path, version, updated_at FROM product_photos WHERE sku = $1', [req.params.sku])
    if (!rows.length) throw notFound('Photo not found')
    const current = String(rows[0].version) === String(req.query.v ?? '')
    // The version starts again at 1 after a photo is removed, so the resize cache also keys on when it was set.
    const key = `product:${req.params.sku}:${rows[0].version}:${new Date(rows[0].updated_at).getTime()}`
    await sendPublicPhoto(res, rows[0], { key, width, cache: current ? 'public, max-age=31536000, immutable' : 'public, max-age=60' })
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

// Bulk Deals: the catalogue and its photos are public.
router.use(publicBulk)
// POST /events: the shop's anonymous funnel steps (FUNNEL_ANALYTICS), before the sign-in gate.
router.use(growthPublic)
// Partner With Us: the business enquiry form, no sign-in (docs/partner-network.md).
router.use('/partner-network', partnerPublic)
// Farm Experience: the page, dates and prices are public (docs/farm-experience.md).
router.use(farmPublic)

router.use(['/cart', '/checkout', '/orders', '/claims', '/me', '/preorders', '/stock-alerts', '/reviews', '/gifts', '/farm-bookings'], requireCustomer)
// Bulk lines in the cart (POST /cart/bulk, DELETE /cart/bulk/:listingId).
router.use(cartBulk)
// Reviews: /me/reviews and /reviews need the sign-in above; product reviews and approved photos are public.
router.use(customerReviews)
// The bill PDF of the customer's own paid order (BILLS_ENABLED).
router.use(customerBills)
// Browser notifications and favourites: /me/push and /me/favourites (app-feel-routes.js).
router.use(appFeel)
// /me/referral...: refer a friend (REFERRALS, docs/growth.md).
router.use(growthMe)
// Bulk and corporate gifting (MULTI_GIFT): /gifts..., the caller's own gift orders only.
router.use(customerGifts)
// Farm Experience bookings: /farm-bookings..., the caller's own only (docs/farm-experience.md).
router.use(farmCustomer)
// Help requests and subscriptions: /me/help and /me/subscriptions (care-routes.js, docs/care.md).
router.use(care)
// The shop language the customer chose: /me/language (language-routes.js, docs/languages.md).
router.use(languages)

const meView = (cu) => ({ ...profile(cu), remindersOptIn: Boolean(cu.reminders_opt_in) })

router.get('/me', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT id, phone, name, email, reminders_opt_in FROM customers WHERE id = $1 AND deleted_at IS NULL', [req.customer.id])
  if (!rows.length) throw notFound('Customer not found')
  res.json(meView(rows[0]))
}))

/** Settings the customer controls: for now, the WhatsApp reminder a week after delivery. */
router.patch('/me', asyncHandler(async (req, res) => {
  const b = parse(z.object({ remindersOptIn: z.boolean() }).strict(), req.body ?? {})
  // The change is also WhatsApp promotional consent, with the request id as evidence (docs/whatsapp/CONSENT.md).
  const row = await tx(async (c) => {
    const { rows } = await c.query(
      `UPDATE customers SET reminders_opt_in = $2 WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, phone, name, email, reminders_opt_in, (SELECT reminders_opt_in FROM customers WHERE id = $1) AS was`,
      [req.customer.id, b.remindersOptIn],
    )
    if (!rows.length) throw notFound('Customer not found')
    const cu = rows[0]
    if (cu.was !== b.remindersOptIn && /^\+[1-9][0-9]{6,14}$/.test(cu.phone ?? '')) {
      await setConsent(c, { phone: cu.phone, customerId: cu.id, scope: 'marketing', action: b.remindersOptIn ? 'OPT_IN' : 'OPT_OUT', source: 'shop_account', evidence: req.id ? `request ${req.id}` : null })
    }
    return cu
  })
  res.json(meView(row))
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
    forgetCustomer(req.customer.id)
    for (const p of photos) await dropPhoto(p)
    logger.info({ customerId: req.customer.id }, 'customer deleted their account')
    res.clearCookie(RT_COOKIE, rtCookie())
    res.status(204).end()
  }),
)

/**
 * "Sign out everywhere" (ASVS 3.3.4): ends every refresh session of the
 * account and raises its session version, so access tokens already issued on
 * other phones stop working too (this instance at once, others within 30 s).
 */
router.post(
  '/me/sign-out-everywhere',
  asyncHandler(async (req, res) => {
    await tx(async (c) => {
      await c.query('UPDATE customers SET session_version = session_version + 1 WHERE id = $1', [req.customer.id])
      await c.query("UPDATE refresh_sessions SET revoked_at = $2 WHERE user_id = $1 AND user_type = 'customer' AND revoked_at IS NULL", [req.customer.id, now()])
      // A phone left signed in would still show order updates: browser notifications end too.
      await c.query('DELETE FROM push_subscriptions WHERE customer_id = $1', [req.customer.id])
    })
    forgetCustomer(req.customer.id)
    logger.info({ customerId: req.customer.id }, 'customer signed out everywhere')
    res.clearCookie(RT_COOKIE, rtCookie())
    res.status(204).end()
  }),
)

/** Columns left out of the export: internal checks, not the customer's data. */
const EXPORT_HIDDEN = new Set(['delivery_code_tries', 'customer_id', 'bytes', 'blob_path'])
const exportRows = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k, v]) => !EXPORT_HIDDEN.has(k) && !Buffer.isBuffer(v))))

/**
 * A copy of everything the shop holds about the customer (DPDP Act; ASVS
 * 8.3.2), as JSON: the account, saved addresses, orders with their items,
 * bookings, claims, ratings, reviews, back-in-stock alerts, favourites and the
 * browsers with notifications on. Photos are listed, not included.
 */
router.get(
  '/me/export',
  asyncHandler(async (req, res) => {
    const id = req.customer.id
    const all = (sql) => query(sql, [id]).then((r) => exportRows(r.rows))
    const [account] = await all('SELECT id, phone, name, email, reminders_opt_in, language, created_at FROM customers WHERE id = $1 AND deleted_at IS NULL')
    if (!account) throw notFound('Customer not found')
    const orders = await all('SELECT * FROM orders WHERE customer_id = $1 ORDER BY placed_at')
    const items = await query('SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY order_id', [orders.map((o) => o.id)]).then((r) => exportRows(r.rows))
    res.set('Content-Disposition', 'attachment; filename="mandimangoes-my-data.json"')
    res.json({
      exportedAt: now().toISOString(),
      account,
      addresses: await all('SELECT * FROM customer_addresses WHERE customer_id = $1 ORDER BY created_at'),
      orders: orders.map((o) => ({ ...o, items: items.filter((i) => i.order_id === o.id) })),
      preorders: await all('SELECT * FROM preorders WHERE customer_id = $1 ORDER BY created_at'),
      claims: await all('SELECT * FROM claims WHERE customer_id = $1 ORDER BY created_at'),
      ratings: await all('SELECT * FROM order_ratings WHERE customer_id = $1'),
      reviews: await all('SELECT * FROM reviews WHERE customer_id = $1 ORDER BY created_at'),
      stockAlerts: await all('SELECT * FROM stock_alerts WHERE customer_id = $1 ORDER BY created_at'),
      bills: await all(
        `SELECT b.number, b.kind, b.bill_date, b.total, b.buyer_name, b.buyer_address, b.snapshot -> 'buyer' AS business, b.cancelled_at
           FROM bills b JOIN orders o ON o.id = b.order_id WHERE o.customer_id = $1 ORDER BY b.issued_at`,
      ),
      favourites: await all('SELECT sku, created_at FROM customer_favourites WHERE customer_id = $1 ORDER BY created_at'),
      // Help requests with every message in them, and subscriptions with their deliveries (docs/care.md).
      helpRequests: await all(
        `SELECT t.number, t.topic, t.status, t.order_id, t.created_at, t.resolved_at,
                (SELECT json_agg(json_build_object('from', CASE m.author WHEN 'STAFF' THEN 'MandiMangoes' ELSE 'you' END, 'message', m.body, 'at', m.created_at) ORDER BY m.created_at)
                   FROM help_messages m WHERE m.ticket_id = t.id) AS messages
           FROM help_tickets t WHERE t.customer_id = $1 ORDER BY t.created_at`,
      ),
      subscriptions: await all(
        `SELECT s.number, s.sku, s.stage, s.qty, s.frequency, s.first_date, s.end_date, s.status, s.customer_name, s.delivery_address, s.pincode, s.created_at,
                (SELECT json_agg(json_build_object('scheduledFor', y.scheduled_for, 'deliveryDate', y.delivery_date, 'status', y.status, 'orderId', y.order_id) ORDER BY y.scheduled_for)
                   FROM subscription_cycles y WHERE y.subscription_id = s.id) AS deliveries
           FROM subscriptions s WHERE s.customer_id = $1 ORDER BY s.created_at`,
      ),
      // Which push service each browser uses and when; the endpoint and keys are capabilities, not data about the customer.
      notificationBrowsers: (await query('SELECT endpoint, created_at, last_sent_at FROM push_subscriptions WHERE customer_id = $1 ORDER BY created_at', [id])).rows.map(
        (r) => ({ pushService: new URL(r.endpoint).host, createdAt: r.created_at, lastSentAt: r.last_sent_at }),
      ),
    })
  }),
)

/** Orders need a mobile number: the rider calls it and WhatsApp updates go to it. */
export async function requirePhone(c, customerId) {
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
    // Signed in already, so a Turnstile outage doesn't lock them out of adding a number.
    // INT-18 (PROVIDER_CHECKS): only a number that already has an account counts as known, as at
    // sign-in, so a free Google account can't send codes to any number while Cloudflare is down.
    const known = env.PROVIDER_CHECKS ? (await query('SELECT 1 FROM customers WHERE phone = $1 AND deleted_at IS NULL', [phone])).rowCount > 0 : true
    await requireHuman(captchaToken, req.ip, { known })
    res.json(await issueCode(phone, channel, req.ip))
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
      const { rows: mine } = await c.query('SELECT * FROM customers WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [req.customer.id])
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
      await c.query(
        `INSERT INTO bulk_cart_lines (customer_id, listing_id, stage, qty, updated_at)
           SELECT $2, listing_id, stage, qty, updated_at FROM bulk_cart_lines WHERE customer_id = $1
         ON CONFLICT (customer_id, listing_id, stage) DO UPDATE SET qty = GREATEST(bulk_cart_lines.qty, EXCLUDED.qty)`,
        [me.id, target.id],
      )
      await c.query('DELETE FROM bulk_cart_lines WHERE customer_id = $1', [me.id])
      await c.query('DELETE FROM quotes WHERE customer_id = $1', [me.id])
      await c.query('UPDATE claim_photos SET customer_id = $2 WHERE customer_id = $1', [me.id, target.id])
      await c.query('UPDATE review_photos SET customer_id = $2 WHERE customer_id = $1', [me.id, target.id])
      await c.query('UPDATE reviews SET customer_id = $2 WHERE customer_id = $1', [me.id, target.id])
      // Hearts and notification browsers come along too (docs/app-feel.md); without this the delete below would fail on them.
      await moveFavourites(c, me.id, target.id)
      await movePushSubscriptions(c, me.id, target.id)
      // Help requests and subscriptions (docs/care.md) come along too.
      await c.query('UPDATE help_tickets SET customer_id = $2 WHERE customer_id = $1', [me.id, target.id])
      await c.query('UPDATE subscriptions SET customer_id = $2 WHERE customer_id = $1', [me.id, target.id])
      await c.query("UPDATE refresh_sessions SET revoked_at = $2 WHERE user_id = $1 AND user_type = 'customer' AND revoked_at IS NULL", [me.id, now()])
      await c.query('DELETE FROM customers WHERE id = $1', [me.id])
      // The shop language (docs/languages.md): the phone account's own choice wins; otherwise the joining account's.
      const up = await c.query('UPDATE customers SET google_sub = $2, email = $3, name = COALESCE(name, $4), language = COALESCE(language, $5) WHERE id = $1 RETURNING *', [
        target.id, me.google_sub, me.email, me.name, me.language ?? null,
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
    let bulkLines = []
    const pool = await tx(async (c) => {
      date = date ?? (await earliestDeliveryDate(c))
      const p = await availability(c, date)
      bulkLines = await bulkCartView(c, req.customer.id, p)
      return p
    })
    const lines = rows.map((l) => {
      const p = findProduct(l.sku)
      // A product taken off sale stays in the cart, shown as unavailable, until removed.
      const avail = p?.active ? (pool.get(`${l.sku}|${l.stage}`) ?? 0) : 0
      return { sku: l.sku, name: p?.name ?? l.sku, stage: l.stage, qty: l.qty, unitPrice: p?.price ?? 0, available: avail, insufficient: avail < l.qty }
    })
    // Bulk lines are priced by their listing's tiers; lines with a problem count as nothing until fixed.
    res.json({
      deliveryDate: date, lines, bulkLines,
      subtotal: lines.reduce((s, l) => s + l.unitPrice * l.qty, 0) + bulkLines.reduce((s, l) => s + l.linePrice, 0),
    })
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
  perCustomer('quote'),
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
      const pool = await availability(c, date)
      const bulk = await bulkQuoteLines(c, req.customer.id, pool, date)
      if (!rows.length && !bulk.length) throw badRequest('Your cart is empty', 'CART_EMPTY')
      const retail = rows.map((l) => {
        if (!sellable(l.sku)) throw conflict(`${findProduct(l.sku)?.name ?? l.sku} is no longer sold. Remove it from your cart.`, 'PRODUCT_UNAVAILABLE')
        if ((pool.get(`${l.sku}|${l.stage}`) ?? 0) < l.qty) throw new StockError(l.sku)
        const price = findProduct(l.sku).price
        return { sku: l.sku, name: findProduct(l.sku).name, stage: l.stage, qty: l.qty, unitPrice: price, linePrice: price * l.qty, eatBy: eatByFor(l.stage, date) }
      })
      // One order line per box and ripeness: the same box can't be both a regular and a bulk line.
      for (const b of bulk) {
        if (retail.some((l) => l.sku === b.sku && l.stage === b.stage)) {
          throw new HttpError(409, 'CART_CONFLICT', `${b.name} (${b.stage.toLowerCase().replace('_', '-')}) is in your cart both as a bulk deal and as regular boxes. Remove one of them.`, {
            sku: b.sku, stage: b.stage, listingId: b.listingId,
          })
        }
        // Two bulk deals for the same box and ripeness can't share one stock count either.
        if (bulk.some((o) => o !== b && o.sku === b.sku && o.stage === b.stage)) {
          throw new HttpError(409, 'CART_CONFLICT', `Two bulk deals in your cart are for ${b.name} (${b.stage.toLowerCase().replace('_', '-')}). Keep one of them.`, { sku: b.sku, stage: b.stage })
        }
      }
      // Stock is per box and ripeness, whichever line asks for it.
      const lines = [...retail, ...bulk]
      const subtotal = lines.reduce((s, l) => s + l.linePrice, 0)
      // Promo codes apply to regular boxes only: bulk deals already carry their own price.
      const retailSubtotal = retail.reduce((s, l) => s + l.linePrice, 0)
      // A full day fails here, not only at confirm (INV-I); confirm re-checks under lock.
      await checkCapacity(c, date, lines.reduce((s, l) => s + l.qty, 0), null, { lock: false })
      const slot = await quoteSlot(c, date, b.slotId ?? null, lines.reduce((s, l) => s + l.qty, 0))
      if (b.promoCode?.trim() && !retail.length) throw badRequest('Promo codes apply to regular boxes, not bulk deals', 'PROMO_NOT_FOR_BULK')
      const promo = b.promoCode?.trim() ? await applyPromo(c, b.promoCode, req.customer.id, retailSubtotal) : null
      const discount = promo?.discount ?? 0
      const data = {
        pincode: b.pincode, deliveryDate: date, slotId: slot?.id ?? null, slot, lines, subtotal,
        promo: promo ? { code: promo.code, description: promo.description ?? null } : null, discount, total: subtotal - discount,
      }
      const expiresAt = new Date(now().getTime() + getConfig().quoteMinutes * 60_000)
      const quoteId = newId('quo')
      await c.query('INSERT INTO quotes (id, customer_id, data, expires_at) VALUES ($1, $2, $3, $4)', [quoteId, req.customer.id, data, expiresAt])
      // UX-3: how long the boxes are held once Pay is tapped, from the live rule (the review step says so).
      // bills: the shop offers business details (name and GSTIN) for the bill only while bills are on.
      return { quoteId, ...data, expiresAt, holdMinutes: getConfig().holdMinutes, bills: isOn('BILLS_ENABLED') }
    })
    res.json(quote)
  }),
)

/** Checks the customer's slot choice at quote time; confirm re-checks it under lock. */
export async function quoteSlot(c, date, wanted, boxes) {
  const slots = await slotsForDate(c, date)
  if (!slots.length) return null
  if (!wanted) throw badRequest('Choose a delivery slot', 'SLOT_REQUIRED')
  const s = slots.find((x) => x.id === wanted)
  if (!s) throw badRequest('That delivery slot is not available', 'SLOT_INVALID')
  if (s.remainingBoxes != null && s.remainingBoxes < boxes) throw conflict(`The ${s.label} slot on ${date} is fully booked`, 'SLOT_FULL')
  return { id: s.id, label: s.label, startsAt: s.startsAt, endsAt: s.endsAt }
}

/** A business buyer's details for the bill: the name as on the GST certificate, and a valid GSTIN. */
export const businessSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter the business name as on its GST certificate').max(100),
    gstin: z
      .string()
      .max(20)
      .transform(normaliseGstin)
      .superRefine((g, ctx) => {
        const problem = gstinProblem(g)
        if (problem) ctx.addIssue({ code: 'custom', message: problem })
      }),
  })
  .strict()

/** The same request, whatever the key order: a retry must send what the first try sent. */
const stable = (v) => (Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v)
export const requestHash = (body) => createHash('sha256').update(JSON.stringify(stable(body))).digest('hex')

/**
 * What an earlier request with this key made, or null. The same key with a
 * different body is a client bug (or a reused key): refused, not replayed.
 */
export async function replayFor(key, hash, table) {
  const { rows } = await query(`SELECT k.request_hash AS idem_hash, t.* FROM idempotency_keys k JOIN ${table} t ON t.id = k.order_id WHERE k.key = $1`, [key])
  const r = rows[0]
  if (r?.idem_hash && r.idem_hash !== hash) {
    throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'This request does not match the one first sent with this Idempotency-Key. Use a new key for a new order.')
  }
  return r ?? null
}

/**
 * A replay of a request whose first try is still starting the payment (no
 * Razorpay order or link yet): 409, so the shop retries shortly instead of
 * opening a checkout with nothing to pay.
 */
export function startingPayment() {
  return new HttpError(409, 'PAYMENT_STARTING', 'Your payment is still being set up. Please try again in a moment.', { retryAfterSeconds: 2 })
}
export const stillStarting = (row, ref) => !row || (row.status === 'PAYMENT_PENDING' && !row[ref])

const confirmResponse = (o) => ({
  orderId: o.id, number: o.number, status: o.status, total: o.total, deliveryDate: o.delivery_date, slotId: o.slot_id ?? null,
  razorpayOrderId: o.razorpay_order_id, razorpayKeyId: env.RAZORPAY_KEY_ID || null, holdExpiresAt: o.hold_expires_at,
})

router.post(
  '/checkout/confirm',
  perCustomer('confirm'),
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
        // Optional: a business buying, printed on the bill (BILLS_ENABLED). The GSTIN's check character is verified.
        business: businessSchema.optional().nullable(),
        // FUNNEL_ANALYTICS: the shop's random per-browser id, so "paid" can be counted for it when the payment is captured.
        funnelId: z.string().regex(BROWSER_ID).optional().nullable(),
      }),
      req.body,
    )
    if (b.business && !isOn('BILLS_ENABLED')) throw badRequest('Business details for a bill are not taken at the moment', 'BILLS_OFF')
    const key = `${req.customer.id}:${rawKey}`
    const hash = requestHash(b)
    const existing = () => replayFor(key, hash, 'orders')
    const replay = await existing()
    if (replay && stillStarting(replay, 'razorpay_order_id')) {
      // PAY-B4: the first try committed the order but never stored its
      // Razorpay order (the instance died in between). After a short wait the
      // retry starts the payment itself, instead of 409 until the hold ends.
      if (!startedLongAgo(replay)) throw startingPayment()
      return res.status(200).json(confirmResponse(await startPayment(replay, key)))
    }
    if (replay) return res.status(200).json(confirmResponse(replay))

    const order = await tx(async (c) => {
      // Claimed first: a concurrent retry with the same key waits here, then replays.
      const ins = await c.query('INSERT INTO idempotency_keys (key, order_id, created_at, request_hash) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [key, 'pending', now(), hash])
      if (!ins.rowCount) return null
      const { rows } = await c.query('SELECT * FROM quotes WHERE id = $1 AND customer_id = $2 FOR UPDATE', [b.quoteId, req.customer.id])
      const q = rows[0]
      // A gift order's quote (MULTI_GIFT) is confirmed at /gifts/confirm, never here.
      if (!q || q.expires_at <= now() || q.data.kind === 'multi-gift') throw conflict('This quote has expired. Review your cart again.', 'QUOTE_EXPIRED')
      const { date } = await deliveryDateFor(c, q.data.pincode, q.data.deliveryDate)
      // Bulk lines are priced again from the listing as it is now (stale prices fail with PRICE_CHANGED).
      const quoted = await checkBulkLinesAtConfirm(c, q.data.lines)
      // PAY-B10: a product taken off sale after the quote is not sold on it.
      for (const l of quoted) {
        if (!sellable(l.sku)) {
          throw new HttpError(409, 'PRODUCT_UNAVAILABLE', `${findProduct(l.sku)?.name ?? l.sku} is no longer sold`, { sku: l.sku, stage: l.stage })
        }
      }
      await checkUnpaidLimit(c, req.customer.id, quoted.reduce((t, l) => t + l.qty, 0))
      if (b.name) await c.query('UPDATE customers SET name = $2 WHERE id = $1', [req.customer.id, b.name])
      const cust = await requirePhone(c, req.customer.id)
      const retailSubtotal = quoted.filter((l) => !l.listingId).reduce((t, l) => t + l.unitPrice * l.qty, 0)
      // The code is checked again, locked, so a limited code can't be over-used. Bulk lines never count toward it.
      const promo = q.data.promo ? await applyPromo(c, q.data.promo.code, req.customer.id, retailSubtotal, { lock: true }) : null
      const created = await createOrder(
        c,
        {
          customerId: req.customer.id, customerName: b.name ?? cust.name, phone: cust.phone, pincode: q.data.pincode, address: b.address,
          deliveryDate: date, slotId: q.data.slotId ?? null, strictSlot: Boolean(q.data.slotId), status: 'PAYMENT_PENDING', paymentStatus: 'INITIATED', allOrNothing: true,
          holdExpiresAt: new Date(now().getTime() + getConfig().holdMinutes * 60_000),
          lines: quoted.map((l) => ({ sku: l.sku, stage: l.stage, qty: l.qty, unitPrice: l.unitPrice, listingId: l.listingId ?? null, pricing: l.pricing ?? null })),
          discount: promo?.discount ?? 0, promoCode: promo?.code ?? null,
          gift: b.gift ? { recipientName: b.gift.recipientName, recipientPhone: b.gift.recipientPhone, message: b.gift.message || null } : null,
        },
        req.actor,
      )
      if (promo) await recordRedemption(c, { orderId: created.id, code: promo.code, customerId: req.customer.id, discount: promo.discount })
      if (b.funnelId) await rememberCheckout(c, created.id, b.funnelId)
      if (b.business) {
        await c.query('UPDATE orders SET buyer_business_name = $2, buyer_gstin = $3 WHERE id = $1', [created.id, b.business.name, b.business.gstin])
      }
      // A gift goes to someone else's address, which isn't ours to keep offering.
      if (!b.gift) await rememberAddress(c, req.customer.id, { name: b.name ?? cust.name, address: b.address, pincode: q.data.pincode })
      await c.query('UPDATE idempotency_keys SET order_id = $2 WHERE key = $1', [key, created.id])
      await c.query('DELETE FROM quotes WHERE id = $1', [q.id])
      await c.query('DELETE FROM carts WHERE customer_id = $1', [req.customer.id])
      await c.query('DELETE FROM bulk_cart_lines WHERE customer_id = $1', [req.customer.id])
      return (await c.query('SELECT * FROM orders WHERE id = $1', [created.id])).rows[0]
    })
    if (!order) {
      const first = await existing()
      if (stillStarting(first, 'razorpay_order_id')) throw startingPayment()
      return res.status(200).json(confirmResponse(first))
    }
    res.status(201).json(confirmResponse(await startPayment(order, key)))
  }),
)

/** How long a retry waits for the first try to store its Razorpay order before starting the payment itself (PAY-B4). */
const PAYMENT_START_GRACE_MS = 15_000
const startedLongAgo = (o) => o.hold_expires_at > now() && now() - o.placed_at >= PAYMENT_START_GRACE_MS

/**
 * Creates the Razorpay order for a placed order and stores it, unless another
 * request stored one first (then that one is used and ours is an unused
 * Razorpay order, which is harmless). If the gateway fails, the order is
 * abandoned and the key released, so a retry is a fresh attempt.
 */
async function startPayment(order, key) {
  try {
    const rzp = await createGatewayOrder({ amount: order.total, receipt: order.number, orderId: order.id })
    const { rows } = await query('UPDATE orders SET razorpay_order_id = $2 WHERE id = $1 AND razorpay_order_id IS NULL RETURNING *', [order.id, rzp])
    return rows[0] ?? (await query('SELECT * FROM orders WHERE id = $1', [order.id])).rows[0]
  } catch (err) {
    logger.error({ err, orderId: order.id }, 'could not create the gateway order')
    await tx(async (c) => {
      await processPayment(c, { orderId: order.id, outcome: 'abandoned' }, SYSTEM)
      // Let the key go, so a retry is a fresh attempt rather than a replay of
      // the cancelled order (the quote is spent: the shop quotes again).
      await c.query('DELETE FROM idempotency_keys WHERE key = $1', [key])
    })
    throw new HttpError(502, 'PAYMENT_GATEWAY_ERROR', 'Could not start the payment. Please try again.')
  }
}

/**
 * Pays for one delivery of a subscription (SUBSCRIPTIONS, docs/care.md): makes
 * the ordinary unpaid order for it (subscriptions.js orderCycle: the checkout's
 * unpaid-order limits, capacity, slot and stock rules) and starts its payment
 * exactly as checkout does. Needs an Idempotency-Key: a retry replays the order
 * instead of making a second one. The answer is checkout's.
 */
router.post(
  '/me/subscriptions/:id/cycles/:cycleId/pay',
  asyncHandler(async (req, res) => {
    if (!isOn('SUBSCRIPTIONS')) throw notFound()
    const rawKey = req.get('Idempotency-Key')
    if (!rawKey || rawKey.length > 100) throw badRequest('An Idempotency-Key header is required', 'IDEMPOTENCY_KEY_REQUIRED')
    const key = `${req.customer.id}:sub:${rawKey}`
    const hash = requestHash({ subscriptionId: req.params.id, cycleId: req.params.cycleId })
    const existing = () => replayFor(key, hash, 'orders')
    const replay = await existing()
    if (replay && stillStarting(replay, 'razorpay_order_id')) {
      if (!startedLongAgo(replay)) throw startingPayment()
      return res.status(200).json(confirmResponse(await startPayment(replay, key)))
    }
    if (replay) return res.status(200).json(confirmResponse(replay))
    const out = await tx(async (c) => {
      const ins = await c.query('INSERT INTO idempotency_keys (key, order_id, created_at, request_hash) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [key, 'pending', now(), hash])
      if (!ins.rowCount) return null
      const r = await orderCycle(c, { customerId: req.customer.id, subscriptionId: req.params.id, cycleId: req.params.cycleId }, req.actor)
      await c.query('UPDATE idempotency_keys SET order_id = $2 WHERE key = $1', [key, r.order.id])
      return r
    })
    if (!out) {
      const first = await existing()
      if (stillStarting(first, 'razorpay_order_id')) throw startingPayment()
      return res.status(200).json(confirmResponse(first))
    }
    // A payment already started for this delivery and still held: carry on with it.
    if (out.existing) return res.status(200).json(confirmResponse(out.order.razorpay_order_id ? out.order : await startPayment(out.order, key)))
    res.status(201).json(confirmResponse(await startPayment(out.order, key)))
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
    res.json(rows.map((o) => ({
      id: o.id, number: o.number, status: o.status, deliveryDate: o.delivery_date, total: o.total, itemCount: o.item_count, placedAt: o.placed_at,
      // Lets the shop point to an unpaid order that is still held (FE-5).
      holdExpiresAt: o.status === 'PAYMENT_PENDING' ? o.hold_expires_at : null,
      // A delivery of a gift order to many recipients (MULTI_GIFT): the shop links it to its gift order.
      ...(o.gift_order_id ? { giftOrderId: o.gift_order_id, giftRecipient: o.gift_recipient_name } : {}),
    })))
  }),
)

router.get(
  '/orders/:id',
  asyncHandler(async (req, res) => {
    const o = await ownOrder({ query }, req)
    const [items, events, slot, proof, rating, cancel, delivered, bill, tracking] = await Promise.all([
      query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY sku, stage', [o.id]),
      query(`SELECT status, created_at FROM order_events WHERE order_id = $1 AND from_status IS DISTINCT FROM status ORDER BY created_at, id`, [o.id]),
      o.slot_id ? query('SELECT * FROM delivery_slots WHERE id = $1', [o.slot_id]) : { rows: [] },
      customerDelivery({ query }, o),
      query('SELECT stars, comment, updated_at FROM order_ratings WHERE order_id = $1', [o.id]),
      o.status === 'CANCELLED'
        ? query(`SELECT reason, created_at FROM order_events WHERE order_id = $1 AND status = 'CANCELLED' ORDER BY created_at DESC, id DESC LIMIT 1`, [o.id])
        : { rows: [] },
      o.status === 'DELIVERED'
        ? query(`SELECT MAX(created_at) AS at FROM order_events WHERE order_id = $1 AND status = 'DELIVERED'`, [o.id])
        : { rows: [] },
      isOn('BILLS_ENABLED') ? billFor({ query }, o.id) : null,
      // LIVE_TRACKING: while out for delivery, stops before this one on the rider's run (a count, nothing more).
      isOn('LIVE_TRACKING') ? trackingFor({ query }, o) : null,
    ])
    const r = rating.rows[0]
    const cancelled = cancel.rows[0]
    // FE-3: the claim deadline from the live rule, the same sum POST /claims checks.
    const claimWindowHours = getConfig().claimWindowHours
    const deliveredAt = delivered.rows[0]?.at ?? null
    res.json({
      rating: r ? { stars: r.stars, comment: r.comment, at: r.updated_at } : null,
      slot: slot.rows[0] ? (({ id, label, startsAt, endsAt }) => ({ id, label, startsAt, endsAt }))(slotView(slot.rows[0])) : null,
      id: o.id, number: o.number, status: o.status, deliveryDate: o.delivery_date, placedAt: o.placed_at, pincode: o.pincode,
      deliveryAddress: o.delivery_address, subtotal: o.subtotal, discount: o.discount, promoCode: o.promo_code, total: o.total, paymentStatus: o.payment_status,
      gift: o.gift_recipient_name ? { recipientName: o.gift_recipient_name, recipientPhone: o.gift_recipient_phone, message: o.gift_message } : null,
      refundStatus: o.refunded_at ? 'REFUNDED' : o.refund_requested_at ? 'PENDING' : null, razorpayOrderId: o.razorpay_order_id,
      // The public key id, so checkout can be reopened from any device while unpaid.
      razorpayKeyId: o.status === 'PAYMENT_PENDING' && o.razorpay_order_id ? env.RAZORPAY_KEY_ID || null : null,
      holdExpiresAt: o.hold_expires_at,
      // Why it was cancelled, so the shop never says "nothing was charged" while
      // a late payment can still land on a hold that ran out (FE-1).
      cancelReason: !cancelled ? null : o.staff_cancelled_at ? 'STAFF' : cancelled.reason === HOLD_EXPIRED_REASON ? 'HOLD_EXPIRED' : 'OTHER',
      cancelledAt: cancelled?.created_at ?? null,
      claimWindowHours,
      claimUntil: deliveredAt ? new Date(deliveredAt.getTime() + claimWindowHours * 3_600_000) : null,
      // FE-2: after the last failed attempt nothing is rescheduled; staff call first.
      deliveryFailures: o.delivery_failures,
      // INV-E: a retry the boxes can't make (too old, no younger stock) waits for staff, who call.
      retryScheduled: o.status === 'DELIVERY_FAILED' ? o.delivery_failures < MAX_DELIVERY_ATTEMPTS && !o.at_risk : null,
      // INV-B: paid, but no stock for its date yet: the date may change and we'll message when it's settled.
      findingStock: Boolean(o.at_risk) && ['CONFIRMED', 'PROCESSING'].includes(o.status),
      // The bill, once the order is paid (BILLS_ENABLED): download it from /orders/:id/bill.
      bill: billView(bill),
      business: o.buyer_gstin ? { name: o.buyer_business_name, gstin: o.buyer_gstin } : null,
      // MULTI_GIFT: one delivery of a gift order; its payment, bill and cancel of the whole order are on the gift order.
      giftOrderId: o.gift_order_id ?? null,
      items: items.rows.map((i) => ({
        sku: i.sku, name: findProduct(i.sku)?.name ?? i.sku, stage: i.stage, quantity: i.quantity, unitPrice: i.unit_price, linePrice: i.line_price,
        eatBy: i.stage ? eatByFor(i.stage, o.delivery_date) : null, readyOn: i.stage ? readyOnFor(i.stage, o.delivery_date) : null,
        // A bulk deal line keeps the name and tier it was sold under.
        bulk: i.pricing?.kind === 'bulk' ? { listingId: i.listing_id, title: i.pricing.title, tier: i.pricing.tier } : null,
      })),
      timeline: events.rows.map((e) => ({ status: e.status, at: e.created_at })),
      tracking,
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

/** verify-payment calls per order per minute; each asks Razorpay (at least 2 seconds apart). */
const VERIFY_PER_MINUTE = 6

router.get(
  '/orders/:id/payment-status',
  asyncHandler(async (req, res) => {
    let o = await ownOrder({ query }, req)
    // OPS-24: still waiting a minute after checkout: ask Razorpay now rather
    // than wait for a late webhook or the next maintenance run (throttled per order).
    if (o.status === 'PAYMENT_PENDING' && (o.razorpay_order_id || o.payment_link_id)) {
      const r = await reconcileOrderNow(o.id, { minAgeMs: 60_000, throttleMs: 30_000 }).catch((err) => {
        logger.warn({ err, orderId: o.id }, 'payment status check at Razorpay failed')
        return null
      })
      if (r && r !== 'skipped') o = await ownOrder({ query }, req)
    }
    res.json({ status: o.payment_status, orderStatus: o.status })
  }),
)

/**
 * PAY-B3: Checkout's success handler posts what Razorpay gave it. The
 * signature (HMAC-SHA256 of `order_id|payment_id` with the key secret) proves
 * Razorpay issued it for this order; then the payment is fetched from
 * Razorpay and applied with the same checks as the webhook (amount, currency),
 * so nothing from the page itself is trusted. Rate-limited per order.
 */
router.post(
  '/orders/:id/verify-payment',
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({
        razorpay_payment_id: z.string().min(1).max(64),
        razorpay_order_id: z.string().min(1).max(64),
        razorpay_signature: z.string().min(1).max(128),
      }),
      req.body,
    )
    let o = await ownOrder({ query }, req)
    if (!o.razorpay_order_id || o.razorpay_order_id !== b.razorpay_order_id) throw badRequest('This payment is not for this order', 'PAYMENT_MISMATCH')
    if (!verifyCheckoutSignature(b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_signature)) {
      throw badRequest('The payment could not be verified', 'BAD_SIGNATURE')
    }
    const tries = await hit(`verify-payment:${o.id}`, 60_000)
    if (tries.hits > VERIFY_PER_MINUTE) throw new HttpError(429, 'RATE_LIMITED', 'Too many checks. Your order page updates on its own.')
    if (o.payment_status !== 'SUCCEEDED') {
      const r = await reconcileOrderNow(o.id, { throttleMs: 2_000 })
      if (r && r !== 'skipped') o = await ownOrder({ query }, req)
    }
    res.json({ status: o.payment_status, orderStatus: o.status })
  }),
)

router.post(
  '/orders/:id/cancel',
  perCustomer('cancel'),
  asyncHandler(async (req, res) => {
    const refundDue = await tx((c) => customerCancel(c, req.params.id, req.customer.id, req.actor))
    if (refundDue) await sendDueRefunds({ orderId: req.params.id })
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
    if (replay && stillStarting(replay, 'payment_link_url')) throw startingPayment()
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
    if (!pre) {
      const first = await existing()
      if (stillStarting(first, 'payment_link_url')) throw startingPayment()
      return res.status(200).json(preorderView(first))
    }
    if (pre.status !== 'PAYMENT_PENDING') return res.status(201).json(preorderView(pre))
    try {
      res.status(201).json(preorderView(await ensurePaymentLink(pre.id)))
    } catch (err) {
      logger.error({ err, preorderId: pre.id }, 'could not create the preorder payment link')
      await tx(async (c) => {
        await cancelPreorder(c, pre.id, req.customer.id, SYSTEM)
        // A retry with the same key books again instead of replaying the cancelled preorder.
        await c.query('DELETE FROM idempotency_keys WHERE key = $1', [key])
      })
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
    await sendDueRefunds({ orderId: r.refund === 'order' ? r.id : null, preorderId: r.refund === 'preorder' ? r.id : null })
    res.status(204).end()
  }),
)

// ---------------------------------------------------------------- claims

export const MAX_CLAIM_PHOTOS = 3

/** A claim photo is uploaded first (raw image body), then linked by id when the claim is sent. */
router.post(
  '/claims/photos',
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_PHOTO_BYTES, inflate: false }),
  asyncHandler(async (req, res) => {
    checkPhoto(req.body)
    const loose = await query('SELECT COUNT(*)::int AS n FROM claim_photos WHERE customer_id = $1 AND claim_id IS NULL', [req.customer.id])
    if (loose.rows[0].n >= 10) throw new HttpError(429, 'TOO_MANY_PHOTOS', 'Send your claim with the photos you have added first')
    // SEC-13: re-encoded, so EXIF (GPS, device) and anything hidden in the file stay behind.
    const { bytes, mime, ext } = await cleanImage(req.body)
    const id = newId('cph')
    const saved = await storePhoto(`claims/${req.customer.id}`, id, bytes, ext, mime)
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
        // Only a link into our own photo store; photos are normally attached by upload (photoIds).
        photoUrl: z.string().max(500).refine(isOwnPhotoUrl, 'Attach the photo instead of a link').optional().nullable(),
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
      // UX-4: "we got your report" on WhatsApp, once Meta approves mandi_claim_received.
      if (env.WHATSAPP_CLAIM_UPDATES) await enqueue(c, b.orderId, id, 'CLAIM_RECEIVED')
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
        rejectionReason: c.resolution === 'REJECTED' ? (c.resolution_note ?? null) : null,
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
    await sendDueRefunds(refundsFor({ ...r, orderId: b.orderId }))
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
    await sendDueRefunds(refundsFor({ result: r, preorderId: b.preorderId }))
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

devRouter.use(devGifts)
devRouter.use(devFarm)

devRouter.post('/reconcile', asyncHandler(async (_req, res) => res.json({ reconciled: await reconcilePendingPayments({ minAgeSeconds: 0 }) })))
