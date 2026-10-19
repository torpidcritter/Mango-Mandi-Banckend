// /admin/v1: the Mango Ops staff panel. Field names follow the panel's
// src/types.ts exactly.
import { googleOn, verifyGoogleCredential } from './google.js'
import bcrypt from 'bcryptjs'
import express from 'express'
import jwt from 'jsonwebtoken'
import { sharedLimiter } from './ratelimit.js'
import { z } from 'zod'
import { audit, auditStaffChanges, limitByRole, riderScope, ROLES } from './access.js'
import { ACCESS_TTL_S, issueRefresh, requireAdmin, requireManager, revokeRefresh, rotateRefresh, sameSiteOnly, signAccess } from './auth.js'
import { addDays, diffDays, isDate, now, todayIST } from './clock.js'
import { analytics, mondayOf } from './analytics.js'
import { currentConfig, rulesSchema, saveConfig } from './config.js'
import { sendPhoto } from './photos.js'
import { normaliseCode, promoView } from './promos.js'
import { hashRecovery, newRecoveryCodes, newSecret, otpauthUrl, verifyCode } from './totp.js'
import { attemptsFor, dispatchOrder, FAIL_REASONS, MAX_PHOTO_BYTES, photo, photoReviews, recordDelivery, recordStaffDelivery, reviewDelivery, savePhoto } from './delivery-proof.js'
import { query, tx } from './db.js'
import { orderableDates, slotsForDate, slotView } from './delivery.js'
import { env } from './env.js'
import { asyncHandler, badRequest, conflict, HttpError, notFound, parse, unauthorized } from './errors.js'
import { newId } from './ids.js'
import { availability, ledger, SELLABLE_STATUSES } from './inventory.js'
import { triggerRebalanceAll } from './maintenance.js'
import {
  allocateOrder,
  cancelOrder,
  createReplacement,
  eatByFor,
  MAX_DELIVERY_ATTEMPTS,
  moveOrderToDate,
  placeOnFirstDateWithStock,
  rebalanceBatchOrders,
  rebalanceOrder,
  setOrderStatus,
  takeBatchOutOfService,
} from './orders.js'
import { enqueue } from './notify.js'
import { isMonday, preorderView, PREORDER_STATUSES, promoteWaitlist, refundPreorder, staffCancelPreorder } from './preorders.js'
import { refundOrder } from './payments.js'
import { logger } from './logger.js'
import { allProducts, findProduct, loadProducts, productName, sellable, shopProducts } from './products.js'
import { STAGES } from './stage.js'
import {
  describeLabels, doorScan, dispatchScan, ensureLabels, fullyLoaded, labelsHtml, labelsOn, lookup, orderLabels, packScan, reprintLabel,
  requireLabels, runCheck, sendLoaded,
} from './labels.js'

export const router = express.Router()

const COOKIE = 'mango_admin_rt'
const cookieOptions = () => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAMESITE,
  path: '/admin/v1/auth',
})

// Password and two-step tries per address, shared by every instance.
const authLimiter = sharedLimiter('staff-auth', { windowMs: 15 * 60_000, limit: 30 })

// A real bcrypt hash of a random string, so an unknown email costs the same time.
const DUMMY_HASH = bcrypt.hashSync(newId('x'), 10)

// ---------------------------------------------------------------- auth

/**
 * Whether this role must use two-step sign-in (STAFF_TWO_STEP). "managers"
 * covers operators too: both can cancel orders, move stock and see every
 * customer's details.
 */
const OFFICE_ROLES = ['MANAGER', 'OPERATOR']
const twoStepRequired = (role) => env.STAFF_TWO_STEP === 'all' || (env.STAFF_TWO_STEP === 'managers' && OFFICE_ROLES.includes(role))

/** The access token. "setup" marks someone who must set up two-step sign-in before anything else. */
const staffAccess = (u) =>
  signAccess({ sub: u.id, email: u.email, role: u.role, typ: 'admin', ...(twoStepRequired(u.role) && !u.totp_enabled_at ? { setup: true } : {}) })

async function startSession(req, res, user, method) {
  const refresh = await issueRefresh(user.id, 'admin')
  await audit(user, 'auth.login', { detail: { method, twoStep: Boolean(user.totp_enabled_at) }, requestId: req.id })
  res.cookie(COOKIE, refresh.token, { ...cookieOptions(), expires: refresh.expiresAt })
  res.json({ accessToken: staffAccess(user), expiresIn: ACCESS_TTL_S })
}

const TICKET_TTL_S = 5 * 60
const TWO_STEP_MAX_FAILURES = 5
const TWO_STEP_LOCK_MS = 15 * 60_000
const STAFF_COLUMNS = 'id, email, role, totp_secret, totp_enabled_at, totp_last_step, two_step_failures, two_step_locked_until'

/**
 * After the password or Google: either the session, or, with two-step on, a
 * short ticket to send back with the code from the authenticator app.
 */
async function passFirstStep(req, res, user, method) {
  if (!user.totp_enabled_at) return startSession(req, res, user, method)
  const ticket = jwt.sign({ sub: user.id, typ: 'admin_two_step', method, iat: Math.floor(now().getTime() / 1000) }, env.JWT_SECRET, { expiresIn: TICKET_TTL_S, algorithm: 'HS256' })
  res.json({ twoStep: true, ticket, expiresIn: TICKET_TTL_S })
}

router.post(
  '/auth/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) }), req.body)
    const { rows } = await query(`SELECT ${STAFF_COLUMNS}, password_hash FROM admin_users WHERE email = $1`, [email])
    const user = rows[0]
    const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH)
    if (!user || !ok) throw unauthorized('Incorrect email or password', 'INVALID_CREDENTIALS')
    await passFirstStep(req, res, user, 'password')
  }),
)

/** The second step: a 6-digit code from the authenticator app, or a recovery code. */
router.post(
  '/auth/two-step',
  authLimiter,
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ ticket: z.string().min(20).max(2000), code: z.string().trim().min(6).max(20) }), req.body)
    let t
    try {
      t = jwt.verify(b.ticket, env.JWT_SECRET, { algorithms: ['HS256'], clockTimestamp: Math.floor(now().getTime() / 1000) })
      if (t.typ !== 'admin_two_step') throw new Error('wrong ticket')
    } catch {
      throw unauthorized('That took too long. Sign in again.', 'TICKET_EXPIRED')
    }
    const result = await tx(async (c) => {
      const { rows } = await c.query(`SELECT ${STAFF_COLUMNS} FROM admin_users WHERE id = $1 FOR UPDATE`, [t.sub])
      const user = rows[0]
      if (!user?.totp_enabled_at) return { error: unauthorized('Sign in again.', 'TICKET_EXPIRED') }
      const at = now()
      if (user.two_step_locked_until && user.two_step_locked_until > at) {
        return { error: new HttpError(429, 'TWO_STEP_LOCKED', 'Too many wrong codes. Try again in 15 minutes, or ask a manager to reset your two-step sign-in.') }
      }
      let ok = false
      const step = verifyCode(user.totp_secret, b.code.replace(/\s/g, ''), at.getTime(), user.totp_last_step)
      if (step != null) {
        ok = true
        await c.query('UPDATE admin_users SET totp_last_step = $2 WHERE id = $1', [user.id, step])
      } else if (/^[a-z0-9]{4}-?[a-z0-9]{4}$/i.test(b.code)) {
        const used = await c.query('UPDATE staff_recovery_codes SET used_at = $3 WHERE admin_id = $1 AND code_hash = $2 AND used_at IS NULL', [
          user.id, hashRecovery(b.code.includes('-') ? b.code : `${b.code.slice(0, 4)}-${b.code.slice(4)}`), at,
        ])
        ok = used.rowCount === 1
      }
      if (!ok) {
        const fails = user.two_step_failures + 1
        const lock = fails >= TWO_STEP_MAX_FAILURES
        await c.query('UPDATE admin_users SET two_step_failures = $2, two_step_locked_until = $3 WHERE id = $1', [
          user.id, lock ? 0 : fails, lock ? new Date(at.getTime() + TWO_STEP_LOCK_MS) : null,
        ])
        return { failed: true, user, triesLeft: lock ? 0 : TWO_STEP_MAX_FAILURES - fails }
      }
      await c.query('UPDATE admin_users SET two_step_failures = 0, two_step_locked_until = NULL WHERE id = $1', [user.id])
      return { user }
    })
    if (result.error) throw result.error
    if (result.failed) {
      await audit(result.user, 'auth.two_step_failed', { requestId: req.id })
      throw new HttpError(422, 'WRONG_CODE', result.triesLeft ? 'That code is not right. Check the app and try again.' : 'Too many wrong codes. Try again in 15 minutes.', {
        triesLeft: result.triesLeft,
      })
    }
    await startSession(req, res, result.user, t.method)
  }),
)

/** What the sign-in page offers. The Google client ID is public by design. */
router.get('/auth/config', (_req, res) => res.json({ googleClientId: googleOn() ? env.GOOGLE_CLIENT_ID.split(',')[0].trim() : null }))

// Staff sign in with Google when the Google account's verified email is their staff email.
router.post(
  '/auth/google',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { credential } = parse(z.object({ credential: z.string().min(20).max(4096) }), req.body)
    const g = await verifyGoogleCredential(credential)
    const { rows } = await query(`SELECT ${STAFF_COLUMNS} FROM admin_users WHERE email = $1`, [g.email])
    const user = rows[0]
    if (!user) throw unauthorized(`${g.email} is not a staff account. Ask a manager to add you.`, 'NOT_STAFF')
    await passFirstStep(req, res, user, 'google')
  }),
)

router.post(
  '/auth/refresh',
  sameSiteOnly,
  authLimiter,
  asyncHandler(async (req, res) => {
    const { userId, refresh } = await rotateRefresh(req.cookies?.[COOKIE], 'admin')
    const { rows } = await query('SELECT id, email, role, totp_enabled_at FROM admin_users WHERE id = $1', [userId])
    if (!rows.length) throw unauthorized('Session expired. Please sign in again.', 'INVALID_TOKEN')
    if (refresh) res.cookie(COOKIE, refresh.token, { ...cookieOptions(), expires: refresh.expiresAt })
    res.json({ accessToken: staffAccess(rows[0]), expiresIn: ACCESS_TTL_S })
  }),
)

router.post(
  '/auth/logout',
  sameSiteOnly,
  asyncHandler(async (req, res) => {
    await revokeRefresh(req.cookies?.[COOKIE])
    res.clearCookie(COOKIE, cookieOptions())
    res.status(204).end()
  }),
)

// Until someone who must use two-step sign-in has set it up, only these work.
const SETUP_ROUTES = new Set(['GET /auth/me', 'POST /me/two-step/setup', 'POST /me/two-step/enable'])
const needsSetupFirst = (req, _res, next) =>
  next(req.admin.setup && !SETUP_ROUTES.has(`${req.method} ${req.path}`) ? new HttpError(403, 'TWO_STEP_SETUP_REQUIRED', 'Set up two-step sign-in first') : undefined)

router.use(requireAdmin, needsSetupFirst, limitByRole, riderScope, auditStaffChanges)

router.get(
  '/auth/me',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT totp_enabled_at FROM admin_users WHERE id = $1', [req.admin.id])
    if (!rows.length) throw unauthorized('Session expired. Please sign in again.', 'INVALID_TOKEN')
    res.json({
      email: req.admin.email, role: req.admin.role,
      twoStep: { enabled: Boolean(rows[0].totp_enabled_at), required: twoStepRequired(req.admin.role) },
      // Optional features the panel shows only when they are on.
      features: { labels: labelsOn() },
    })
  }),
)

// ---------------------------------------------------------------- two-step sign-in (your own)

/** A new secret for the authenticator app. It only counts once a code from the app is confirmed. */
router.post(
  '/me/two-step/setup',
  asyncHandler(async (req, res) => {
    const secret = newSecret()
    const r = await query('UPDATE admin_users SET totp_pending = $2 WHERE id = $1 AND totp_enabled_at IS NULL', [req.admin.id, secret])
    if (!r.rowCount) throw conflict('Two-step sign-in is already on', 'TWO_STEP_ON')
    res.json({ secret, otpauthUrl: otpauthUrl(req.admin.email, secret) })
  }),
)

/** Confirms the app works and turns two-step on. Returns the recovery codes, shown this once. */
router.post(
  '/me/two-step/enable',
  asyncHandler(async (req, res) => {
    const { code } = parse(z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }), req.body)
    const codes = newRecoveryCodes()
    const user = await tx(async (c) => {
      const { rows } = await c.query('SELECT id, email, role, totp_pending, totp_enabled_at FROM admin_users WHERE id = $1 FOR UPDATE', [req.admin.id])
      const u = rows[0]
      if (u.totp_enabled_at) throw conflict('Two-step sign-in is already on', 'TWO_STEP_ON')
      if (!u.totp_pending) throw badRequest('Start the set-up again', 'NO_SETUP')
      const step = verifyCode(u.totp_pending, code, now().getTime())
      if (step == null) throw new HttpError(422, 'WRONG_CODE', 'That code is not right. Check the time on your phone and try the newest code.')
      const at = now()
      await c.query(
        'UPDATE admin_users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled_at = $2, totp_last_step = $3, two_step_failures = 0 WHERE id = $1',
        [u.id, at, step],
      )
      await c.query('DELETE FROM staff_recovery_codes WHERE admin_id = $1', [u.id])
      for (const rc of codes) await c.query('INSERT INTO staff_recovery_codes (admin_id, code_hash) VALUES ($1, $2)', [u.id, hashRecovery(rc)])
      return { ...u, totp_enabled_at: at }
    })
    res.json({ recoveryCodes: codes, accessToken: staffAccess(user), expiresIn: ACCESS_TTL_S })
  }),
)

/** Turns your own two-step off, with a current code. Not allowed where it is required. */
router.post(
  '/me/two-step/disable',
  asyncHandler(async (req, res) => {
    const { code } = parse(z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }), req.body)
    if (twoStepRequired(req.admin.role)) throw new HttpError(403, 'TWO_STEP_REQUIRED', 'Two-step sign-in is required for your role')
    await tx(async (c) => {
      const { rows } = await c.query('SELECT totp_secret, totp_enabled_at, totp_last_step FROM admin_users WHERE id = $1 FOR UPDATE', [req.admin.id])
      if (!rows[0].totp_enabled_at) throw conflict('Two-step sign-in is already off', 'TWO_STEP_OFF')
      if (verifyCode(rows[0].totp_secret, code, now().getTime(), rows[0].totp_last_step) == null) throw new HttpError(422, 'WRONG_CODE', 'That code is not right.')
      await clearTwoStep(c, req.admin.id)
    })
    res.status(204).end()
  }),
)

async function clearTwoStep(c, adminId) {
  await c.query(
    `UPDATE admin_users SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, totp_last_step = NULL,
       two_step_failures = 0, two_step_locked_until = NULL WHERE id = $1`,
    [adminId],
  )
  await c.query('DELETE FROM staff_recovery_codes WHERE admin_id = $1', [adminId])
}

// ---------------------------------------------------------------- helpers

const AUDIT_PAGE = 50
const available = (l) => Math.max(0, l.on_hand - l.held - l.committed - l.reserve_buffer)

// ---------------------------------------------------------------- dashboard

router.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    const cfg = currentConfig().rules
    const today = todayIST()
    const [counts, claims, batches, stock, risky] = await Promise.all([
      query('SELECT status, COUNT(*)::int AS n FROM orders GROUP BY status'),
      query(`SELECT COUNT(*)::int AS n FROM claims WHERE status IN ('SUBMITTED', 'UNDER_REVIEW')`),
      query(
        `SELECT b.id, b.variety, b.plucked_on,
                COALESCE(SUM(GREATEST(l.on_hand - l.held - l.committed - l.reserve_buffer, 0)), 0)::int AS available
           FROM batches b LEFT JOIN batch_lines l ON l.batch_id = b.id
          WHERE b.status NOT IN ('EXHAUSTED', 'CONDEMNED') AND b.plucked_on <= $1
          GROUP BY b.id ORDER BY b.plucked_on`,
        [addDays(today, -cfg.nearLimitAge)],
      ),
      query(
        `SELECT l.sku, COALESCE(SUM(GREATEST(l.on_hand - l.held - l.committed - l.reserve_buffer, 0)), 0)::int AS available
           FROM batch_lines l JOIN batches b ON b.id = l.batch_id
          WHERE b.status = ANY($1) GROUP BY l.sku`,
        [SELLABLE_STATUSES],
      ),
      query(
        `SELECT id, number, delivery_date, at_risk_reason FROM orders
          WHERE at_risk AND status NOT IN ('DELIVERED', 'CANCELLED', 'RTO') ORDER BY delivery_date, number`,
      ),
    ])
    const bySku = new Map(stock.rows.map((r) => [r.sku, r.available]))
    res.json({
      orders: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
      openClaims: claims.rows[0].n,
      batchesNearLimit: batches.rows.map((b) => ({ id: b.id, variety: b.variety, ageDays: diffDays(today, b.plucked_on), available: b.available })),
      lowStock: shopProducts()
        .map((p) => ({ sku: p.sku, productName: p.name, available: bySku.get(p.sku) ?? 0 }))
        .filter((p) => p.available <= cfg.lowStockThreshold),
      atRiskOrders: risky.rows.map((o) => ({ id: o.id, number: o.number, deliveryDate: o.delivery_date, reason: o.at_risk_reason })),
    })
  }),
)

// ---------------------------------------------------------------- products

/** Every product, hidden ones included (marked active: false), in display order. */
router.get('/products', (_req, res) => res.json(allProducts()))

const productFields = {
  name: z.string().trim().min(2, 'Give the product a name').max(80),
  variety: z.string().trim().min(2, 'Give the variety').max(40),
  boxSize: z.string().trim().max(20),
  price: z.number().int().positive('Price must be more than zero').max(10_000_000),
  gstRate: z.number().min(0).max(0.28),
  hsnCode: z.string().trim().regex(/^\d{4,8}$/, 'HSN is 4 to 8 digits').nullable(),
  description: z.string().trim().max(300),
  sortOrder: z.number().int().min(0).max(10_000),
}
// Fresh mangoes: HSN 0804 50, nil GST.
const productDefaults = { boxSize: '', gstRate: 0, hsnCode: '08045020', description: '', sortOrder: 0 }

/** Adds a product. It goes on sale at once; stock arrives with the next batch. */
router.post(
  '/products',
  requireManager,
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({
        sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, 'Use 2 to 20 letters, digits and dashes, like KES-3'),
        ...Object.fromEntries(Object.entries(productFields).map(([k, v]) => [k, k in productDefaults ? v.default(productDefaults[k]) : v])),
      }),
      req.body,
    )
    const { rows } = await query(
      `INSERT INTO products (sku, name, variety, box_size, price, gst_rate, hsn_code, description, sort_order, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (sku) DO NOTHING RETURNING sku`,
      [b.sku, b.name, b.variety, b.boxSize, b.price, b.gstRate, b.hsnCode, b.description, b.sortOrder, now()],
    )
    if (!rows.length) throw conflict('A product with that SKU already exists', 'PRODUCT_EXISTS')
    await loadProducts()
    req.params.id = b.sku
    res.status(201).json(findProduct(b.sku))
  }),
)

/**
 * Renames or edits a product, or puts a removed one back on sale. The SKU never
 * changes. The variety is fixed once a batch holds the product, because a
 * batch is one variety. A new price applies to quotes from now on; orders
 * already placed keep theirs.
 */
router.patch(
  '/products/:sku',
  requireManager,
  asyncHandler(async (req, res) => {
    const fields = Object.fromEntries(Object.entries(productFields).map(([k, v]) => [k, v.optional()]))
    const b = parse(z.object({ ...fields, active: z.boolean().optional() }).strict(), req.body)
    const sku = req.params.sku
    await tx(async (c) => {
      const { rows } = await c.query('SELECT variety FROM products WHERE sku = $1 FOR UPDATE', [sku])
      if (!rows.length) throw notFound('No product with that SKU')
      if (b.variety !== undefined && b.variety !== rows[0].variety) {
        const used = await c.query('SELECT 1 FROM batch_lines WHERE sku = $1 LIMIT 1', [sku])
        if (used.rows.length) throw conflict('The variety cannot change once a batch holds this product. Add a new product instead.', 'VARIETY_LOCKED')
      }
      const cols = { name: 'name', variety: 'variety', boxSize: 'box_size', price: 'price', gstRate: 'gst_rate', hsnCode: 'hsn_code', description: 'description', sortOrder: 'sort_order', active: 'active' }
      const set = Object.entries(cols).filter(([k]) => b[k] !== undefined)
      await c.query(
        `UPDATE products SET ${set.map(([, col], i) => `${col} = $${i + 2}`).concat(`updated_at = $${set.length + 2}`).join(', ')} WHERE sku = $1`,
        [sku, ...set.map(([k]) => b[k]), now()],
      )
    })
    await loadProducts()
    res.json(findProduct(sku))
  }),
)

/**
 * Removes a product. One that was never stocked, ordered or offered for
 * preorder is deleted outright. Otherwise it is taken off sale (hidden from
 * the shop, WhatsApp, preorders and new batches) and kept, so past orders and
 * batches keep its name; it can be put back on sale later.
 */
router.delete(
  '/products/:sku',
  requireManager,
  asyncHandler(async (req, res) => {
    const sku = req.params.sku
    const outcome = await tx(async (c) => {
      const { rows } = await c.query('SELECT 1 FROM products WHERE sku = $1 FOR UPDATE', [sku])
      if (!rows.length) throw notFound('No product with that SKU')
      const { rows: used } = await c.query(
        `SELECT EXISTS (SELECT 1 FROM batch_lines WHERE sku = $1) OR EXISTS (SELECT 1 FROM order_items WHERE sku = $1)
             OR EXISTS (SELECT 1 FROM preorders WHERE sku = $1) OR EXISTS (SELECT 1 FROM preorder_capacity WHERE sku = $1) AS used`,
        [sku],
      )
      if (used[0].used) {
        await c.query('UPDATE products SET active = FALSE, updated_at = $2 WHERE sku = $1', [sku, now()])
        return 'hidden'
      }
      await c.query('DELETE FROM carts WHERE sku = $1', [sku])
      await c.query('DELETE FROM products WHERE sku = $1', [sku])
      return 'deleted'
    })
    await loadProducts()
    res.json({ sku, outcome })
  }),
)

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
        GROUP BY b.id, q.ripeness_rating, q.condition ORDER BY b.plucked_on DESC, b.created_at DESC`,
      [status],
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
    c.query('SELECT * FROM batch_lines WHERE batch_id = $1 ORDER BY sku', [batchId]),
    c.query('SELECT * FROM batch_qc WHERE batch_id = $1 ORDER BY logged_at DESC', [batchId]),
  ])
  return {
    id: b.id, variety: b.variety, pluckedOn: b.plucked_on, ageDays: diffDays(todayIST(), b.plucked_on), farm: b.farm,
    status: b.status, etaDate: b.eta_date, arrivedAt: b.arrived_at, createdAt: b.created_at,
    // The QR printed on each box opens this page in the shop.
    lines: lines.rows.map((l) => ({
      id: l.id, sku: l.sku, productName: productName(l.sku), onHand: l.on_hand, held: l.held, committed: l.committed,
      reserveBuffer: l.reserve_buffer, available: available(l),
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
        if (l.onHand) await ledger(c, { batchId, eventType: 'INTAKE', sku: l.sku, delta: l.onHand, actorId: req.admin.email, reason: 'Batch received' })
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
    const { status } = parse(z.object({ status: z.enum(BATCH_STATUSES) }), req.body)
    if (status === 'CONDEMNED' && req.admin.role !== 'MANAGER') return requireManager(req, res, next)
    const result = await tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM batches WHERE id = $1 FOR UPDATE', [req.params.id])
      if (!rows.length) throw notFound('Batch not found')
      const b = rows[0]
      if (['EXHAUSTED', 'CONDEMNED'].includes(b.status)) throw badRequest(`This batch is ${b.status} and cannot change`, 'INVALID_TRANSITION')
      if (status !== 'CONDEMNED' && BATCH_FLOW.indexOf(status) <= BATCH_FLOW.indexOf(b.status)) {
        throw badRequest(`Cannot move a batch from ${b.status} back to ${status}`, 'INVALID_TRANSITION')
      }
      const arrivedAt = !b.arrived_at && ARRIVED_OR_LATER.includes(status) ? now() : b.arrived_at
      await c.query('UPDATE batches SET status = $2, arrived_at = $3 WHERE id = $1', [b.id, status, arrivedAt])
      await ledger(c, { batchId: b.id, eventType: 'STATUS', sku: null, delta: 0, actorId: req.admin.email, reason: `${b.status} → ${status}` })
      const actor = req.actor
      if (status === 'CONDEMNED' || status === 'EXHAUSTED') return takeBatchOutOfService(c, b.id, status, actor)
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
      const { rows } = await c.query('SELECT id, status FROM batches WHERE id = $1 FOR UPDATE', [req.params.id])
      if (!rows.length) throw notFound('Batch not found')
      if (['EXHAUSTED', 'CONDEMNED'].includes(rows[0].status)) throw badRequest(`This batch is ${rows[0].status}`, 'INVALID_TRANSITION')
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

router.patch(
  '/batches/:id/lines/:lineId',
  asyncHandler(async (req, res) => {
    const body = parse(
      z
        .object({
          onHand: z.number().int().min(0).max(100_000).optional(),
          reserveBuffer: z.number().int().min(0).max(100_000).optional(),
          reason: z.string().trim().min(1, 'reason is required').max(500),
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
        throw badRequest(`On hand cannot go below the ${l.held + l.committed} boxes already promised to orders`, 'BELOW_COMMITTED')
      }
      if (onHand - l.held - l.committed - buffer < 0) throw badRequest('The reserve buffer is larger than the free stock', 'BUFFER_TOO_LARGE')
      await c.query('UPDATE batch_lines SET on_hand = $2, reserve_buffer = $3 WHERE id = $1', [l.id, onHand, buffer])
      if (onHand !== l.on_hand) await ledger(c, { batchId: l.batch_id, eventType: 'ADJUST', sku: l.sku, delta: onHand - l.on_hand, actorId: req.admin.email, reason: body.reason })
      if (buffer !== l.reserve_buffer) {
        await ledger(c, { batchId: l.batch_id, eventType: 'ADJUST_BUFFER', sku: l.sku, delta: buffer - l.reserve_buffer, actorId: req.admin.email, reason: body.reason })
      }
    })
    res.status(204).end()
  }),
)

router.get(
  '/batches/:id/ledger',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM batch_ledger WHERE batch_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200', [req.params.id])
    res.json(
      rows.map((r) => ({ id: r.id, eventType: r.event_type, sku: r.sku, delta: r.delta, actorType: r.actor_type, actorId: r.actor_id, reason: r.reason, createdAt: r.created_at })),
    )
  }),
)

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
      where.push(`(o.number ILIKE $${params.length - 1} OR o.phone ILIKE $${params.length})`)
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
    events: events.rows.map((e) => ({ status: e.status, fromStatus: e.from_status, actor: e.actor, reason: e.reason, createdAt: e.created_at })),
    deliveryAttempts,
    payment: o.payment_status || o.payment_method
      ? { status: o.payment_status, method: o.payment_method, amount: o.payment_amount, id: o.payment_id, ...(o.payment_link_url ? { linkUrl: o.payment_link_url } : {}),
          refund: o.refund_requested_at ? { requestedAt: o.refund_requested_at, refundedAt: o.refunded_at, id: o.refund_id } : null }
      : null,
  }
}

router.get('/orders/:id', asyncHandler(async (req, res) => res.json(await orderDetail({ query }, req.params.id))))

router.patch(
  '/orders/:id/status',
  asyncHandler(async (req, res) => {
    const { status } = parse(z.object({ status: z.enum(ORDER_STATUSES) }), req.body)
    await tx(async (c) => {
      await setOrderStatus(c, req.params.id, status, req.actor)
      await recordStaffDelivery(c, req.params.id, status, req.actor)
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
        gift: o.gift_recipient_name ? { recipientName: o.gift_recipient_name, recipientPhone: o.gift_recipient_phone, message: o.gift_message } : null,
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

// ---------------------------------------------------------------- box labels and scanning

// Per staff member, not per address: a packing room shares one connection.
const scanLimiter = sharedLimiter('label-scan', {
  windowMs: 60_000, limit: 120, message: 'Too many scans in a minute. Wait a moment.', keyGenerator: (req) => req.admin.id,
})
const scanBody = z.string().trim().min(1, 'Scan a label or type its code').max(300)
const slotParam = z.string().max(64).nullable().optional()

/** Runs a scan in a transaction; a refused scan is logged there, then answered as an error. */
async function runScan(fn) {
  const r = await tx(fn)
  if (!r.ok) throw new HttpError(r.status, r.code, r.message)
  const { ok: _ok, ...rest } = r
  return rest
}

/** Labels for a run (a date, one slot or all) or for chosen orders, as a printable page. */
router.post(
  '/labels/print',
  requireLabels,
  asyncHandler(async (req, res) => {
    const b = parse(
      z
        .object({
          date: z.string().refine(isDate, 'date must be YYYY-MM-DD').optional(),
          slotId: slotParam,
          orderIds: z.array(z.string().max(64)).min(1).max(BULK_LIMIT).optional(),
        })
        .refine((x) => x.date || x.orderIds, 'Give a date or a list of orders'),
      req.body,
    )
    let ids = b.orderIds ?? []
    if (!b.orderIds) {
      const params = [b.date]
      let slotFilter = ''
      if (b.slotId === null) slotFilter = 'AND o.slot_id IS NULL'
      else if (b.slotId) {
        params.push(b.slotId)
        slotFilter = 'AND o.slot_id = $2'
      }
      const { rows } = await query(
        `SELECT o.id FROM orders o LEFT JOIN delivery_slots s ON s.id = o.slot_id
          WHERE o.delivery_date = $1 ${slotFilter} AND o.status IN ('CONFIRMED', 'PROCESSING', 'PACKED')
          ORDER BY s.sort NULLS LAST, s.starts_at NULLS LAST, o.number LIMIT ${BULK_LIMIT + 1}`,
        params,
      )
      if (rows.length > BULK_LIMIT) throw badRequest(`More than ${BULK_LIMIT} orders on this run; print one slot at a time`, 'TOO_MANY')
      ids = rows.map((r) => r.id)
    }
    const labels = []
    const skipped = []
    for (const id of ids) {
      const r = await tx((c) => ensureLabels(c, id, req.actor))
      if (r.skipped) skipped.push({ id, number: r.order.number, reason: r.skipped })
      else labels.push(...r.labels)
    }
    const contents = await describeLabels({ query }, labels)
    const html = labelsHtml(contents, { notes: skipped.map((s) => `${s.number}: ${s.reason}`) })
    res.json({ html, labels: contents.map(({ qrUrl: _q, ...l }) => l), skipped })
  }),
)

router.get(
  '/orders/:id/labels',
  requireLabels,
  asyncHandler(async (req, res) => res.json(await orderLabels({ query }, req.params.id))),
)

/** One damaged or lost label: a new QR (the old one stops working). The reason goes to the staff audit. */
router.post(
  '/labels/:id/reprint',
  requireLabels,
  asyncHandler(async (req, res) => {
    parse(z.object({ reason: z.string().trim().min(3, 'Say why the label is reprinted').max(200) }), req.body ?? {})
    const { label } = await tx((c) => reprintLabel(c, req.params.id, req.actor))
    const contents = await describeLabels({ query }, [label])
    res.json({ html: labelsHtml(contents), label: (({ qrUrl: _q, ...l }) => l)(contents[0]) })
  }),
)

router.post(
  '/scan/pack',
  requireLabels,
  scanLimiter,
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ orderId: z.string().min(1).max(64), scan: scanBody }), req.body)
    res.json(await runScan((c) => packScan(c, b, req.actor)))
  }),
)

const runQuery = z.object({ date: z.string().refine(isDate, 'date must be YYYY-MM-DD'), slotId: slotParam })
/** "none" in the query string means orders without a slot. */
const slotFromQuery = (v) => (v === 'none' ? null : v || undefined)

router.get(
  '/scan/dispatch',
  requireLabels,
  asyncHandler(async (req, res) => {
    const q = parse(runQuery, { date: req.query.date, slotId: slotFromQuery(req.query.slotId) })
    res.json(await runCheck({ query }, q))
  }),
)

router.post(
  '/scan/dispatch',
  requireLabels,
  scanLimiter,
  asyncHandler(async (req, res) => {
    const b = parse(runQuery.extend({ scan: scanBody }), req.body)
    res.json(await runScan((c) => dispatchScan(c, b, req.actor)))
  }),
)

/** Sends out every order on the run whose boxes are all on the van. */
router.post(
  '/scan/dispatch/send',
  requireLabels,
  asyncHandler(async (req, res) => {
    const b = parse(runQuery, req.body)
    res.json(await sendLoaded(b, req.actor))
  }),
)

router.post(
  '/orders/:id/door-scan',
  requireLabels,
  scanLimiter,
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ scan: scanBody }), req.body)
    res.json(await runScan((c) => doorScan(c, { orderId: req.params.id, scan: b.scan }, req.actor)))
  }),
)

router.get(
  '/scan/lookup',
  requireLabels,
  asyncHandler(async (req, res) => res.json(await lookup({ query }, parse(scanBody, req.query.scan)))),
)

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
    const { rows: orders } = await query(
      `SELECT o.id, o.number, o.customer_name, o.phone, o.pincode, o.delivery_address, o.status, o.slot_id,
              o.gift_recipient_name, o.gift_recipient_phone, o.gift_message,
              s.label AS slot_label, s.starts_at, s.ends_at, p.city, p.zone
         FROM orders o LEFT JOIN delivery_slots s ON s.id = o.slot_id LEFT JOIN pincodes p ON p.pincode = o.pincode
        WHERE o.delivery_date = $1 AND o.status = ANY($2)
        ORDER BY s.sort NULLS LAST, s.starts_at NULLS LAST, p.zone NULLS LAST, o.pincode, o.number`,
      [date, MANIFEST_STATUSES],
    )
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
      stop.orders.push({
        // A gift goes to the recipient: the rider sees and calls them.
        id: o.id, number: o.number, status: o.status, deliveryAddress: o.delivery_address,
        customerName: o.gift_recipient_name ?? o.customer_name, phone: o.gift_recipient_phone ?? o.phone,
        gift: o.gift_recipient_name ? { from: o.customer_name, message: o.gift_message } : null,
        packed: !['CONFIRMED', 'PROCESSING'].includes(o.status), boxes,
        items: lines.map((i) => ({ sku: i.sku, productName: productName(i.sku), stage: i.stage, quantity: i.quantity })),
      })
      run.orders++
      run.boxes += boxes
    }
    res.json({
      date,
      orders: orders.length,
      boxes: runs.reduce((n, r) => n + r.boxes, 0),
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
      z.object({ date: z.string().refine(isDate, 'date must be YYYY-MM-DD'), slotId: z.string().nullable().optional() }),
      req.body,
    )
    const params = [b.date]
    let slotFilter = ''
    if (b.slotId === null) slotFilter = 'AND slot_id IS NULL'
    else if (b.slotId) {
      params.push(b.slotId)
      slotFilter = 'AND slot_id = $2'
    }
    const { rows } = await query(
      `SELECT id, number, status FROM orders WHERE delivery_date = $1 ${slotFilter}
          AND status IN ('CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'DELIVERY_FAILED') ORDER BY number`,
      params,
    )
    const dispatched = []
    const skipped = []
    const scanRequired = labelsOn() && currentConfig().rules.labels.requireDispatchScan
    for (const o of rows) {
      if (['CONFIRMED', 'PROCESSING'].includes(o.status)) {
        skipped.push({ number: o.number, reason: 'Not packed yet' })
        continue
      }
      // Box labels on and van scanning required: only orders whose every box was scanned go out.
      if (scanRequired && !(await fullyLoaded({ query }, o.id, b.date))) {
        skipped.push({ number: o.number, reason: 'Not every box was scanned onto the van' })
        continue
      }
      try {
        if (await tx((c) => dispatchOrder(c, o.id, req.actor))) dispatched.push(o.number)
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
    await tx((c) => dispatchOrder(c, req.params.id, req.actor))
    res.status(204).end()
  }),
)

/** The photo is the raw request body (Content-Type image/jpeg, png or webp). */
router.post(
  '/orders/:id/delivery-photos',
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_PHOTO_BYTES }),
  asyncHandler(async (req, res) => {
    const id = await tx((c) => savePhoto(c, req.params.id, req.body, req.actor), { retries: 0 }) // uploads the photo
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
      }),
      req.body,
    )
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

// ---------------------------------------------------------------- analytics

/** Week-by-week season numbers. Defaults to the last 8 weeks up to the end of this week. */
router.get(
  '/analytics',
  asyncHandler(async (req, res) => {
    const date = z.string().refine(isDate, 'dates must be YYYY-MM-DD')
    const f = parse(z.object({ from: date.optional(), to: date.optional() }), Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '')))
    const to = f.to ?? addDays(mondayOf(todayIST()), 6)
    const from = f.from ?? addDays(mondayOf(to), -49)
    if (from > to) throw badRequest('from must be on or before to', 'INVALID_DATE')
    if (diffDays(to, from) > 366) throw badRequest('Pick at most a year', 'INVALID_DATE')
    res.json(await analytics({ from, to }))
  }),
)

// ---------------------------------------------------------------- needs attention

const LOOP_STALE_MS = 5 * 60_000
const REFUND_STUCK_MS = 30 * 60_000
const maskPhone = (p) => (p ? `${p.slice(0, -6)}••••${p.slice(-2)}` : null)

/**
 * The dead-letter view nobody has to go looking for: is the loop alive, which
 * steps are failing, WhatsApp messages given up on, refunds that haven't gone
 * through, and webhooks that failed or named an unknown order.
 */
router.get(
  '/attention',
  asyncHandler(async (_req, res) => {
    const at = now()
    const week = new Date(at.getTime() - 7 * 86_400_000)
    const [runs, failed, refunds, hooks, calls, photos] = await Promise.all([
      query('SELECT * FROM maintenance_runs ORDER BY step'),
      query(
        `SELECT n.id, n.kind, n.phone, n.last_error, n.created_at, n.attempts, o.id AS order_id, o.number AS order_number, p.number AS preorder_number
           FROM notifications n LEFT JOIN orders o ON o.id = n.order_id LEFT JOIN preorders p ON p.id = n.preorder_id
          WHERE n.status = 'FAILED' AND n.created_at >= $1 ORDER BY n.created_at DESC LIMIT 50`,
        [week],
      ),
      query(
        `SELECT 'order' AS type, id, number, refund_requested_at FROM orders WHERE refund_requested_at < $1 AND refunded_at IS NULL
         UNION ALL
         SELECT 'preorder', id, number, refund_requested_at FROM preorders WHERE refund_requested_at < $1 AND refunded_at IS NULL
         UNION ALL
         SELECT CASE WHEN d.order_id IS NOT NULL THEN 'order' ELSE 'preorder' END, COALESCE(d.order_id, d.preorder_id),
                COALESCE(o.number, p.number) || ' (second payment)', d.found_at
           FROM duplicate_payments d LEFT JOIN orders o ON o.id = d.order_id LEFT JOIN preorders p ON p.id = d.preorder_id
          WHERE d.found_at < $1 AND d.refunded_at IS NULL
         ORDER BY refund_requested_at LIMIT 50`,
        [new Date(at.getTime() - REFUND_STUCK_MS)],
      ),
      query('SELECT * FROM webhook_failures WHERE created_at >= $1 ORDER BY created_at DESC LIMIT 50', [week]),
      query(
        `SELECT id, number, customer_name, phone, gift_recipient_name, gift_recipient_phone, delivery_failures FROM orders
          WHERE status = 'DELIVERY_FAILED' AND delivery_failures >= $1 ORDER BY placed_at LIMIT 50`,
        [MAX_DELIVERY_ATTEMPTS],
      ),
      photoReviews({ query }),
    ])
    const tick = runs.rows.find((r) => r.step === 'tick')
    res.json({
      loop: {
        lastRunAt: tick?.last_ok_at ?? null,
        stale: !tick?.last_ok_at || at - tick.last_ok_at > LOOP_STALE_MS,
        failingSteps: runs.rows
          .filter((r) => r.last_err_at && (!r.last_ok_at || r.last_err_at > r.last_ok_at))
          .map((r) => ({ step: r.step, since: r.last_err_at, error: r.last_error })),
      },
      failedMessages: failed.rows.map((n) => ({
        id: n.id, kind: n.kind, phone: maskPhone(n.phone), error: n.last_error, attempts: n.attempts, createdAt: n.created_at,
        order: n.order_id ? { id: n.order_id, number: n.order_number } : null, preorderNumber: n.preorder_number,
      })),
      stuckRefunds: refunds.rows.map((r) => ({ type: r.type, id: r.id, number: r.number, requestedAt: r.refund_requested_at })),
      // Missed too many times: someone calls the customer, then sends it out again from the order page.
      failedDeliveries: calls.rows.map((o) => ({
        id: o.id, number: o.number, name: o.gift_recipient_name ?? o.customer_name, phone: o.gift_recipient_phone ?? o.phone, attempts: o.delivery_failures,
      })),
      // Delivered with only a photo: someone other than the rider checks it.
      photoDeliveries: photos,
      webhookFailures: hooks.rows.map((w) => ({ id: w.id, source: w.source, reason: w.reason, eventKey: w.event_key, createdAt: w.created_at })),
    })
  }),
)

/** Sends a failed WhatsApp message again: back to the outbox as new. */
router.post(
  '/notifications/:id/retry',
  asyncHandler(async (req, res) => {
    const r = await query(
      `UPDATE notifications SET status = 'PENDING', attempts = 0, last_error = NULL, next_attempt_at = $2, created_at = $2
        WHERE id = $1 AND status IN ('FAILED', 'SKIPPED') RETURNING id`,
      [req.params.id, now()],
    )
    if (!r.rowCount) throw notFound('No failed message with that id')
    res.status(204).end()
  }),
)

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

// ---------------------------------------------------------------- staff

const staffDto = (u) => ({ id: u.id, email: u.email, role: u.role, createdAt: u.created_at, twoStep: Boolean(u.totp_enabled_at) })
const password = z.string().min(10, 'Use at least 10 characters').max(200)

router.get(
  '/staff',
  requireManager,
  asyncHandler(async (_req, res) => res.json((await query('SELECT id, email, role, created_at, totp_enabled_at FROM admin_users ORDER BY email')).rows.map(staffDto))),
)

router.post(
  '/staff',
  requireManager,
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(ROLES), password }), req.body)
    const { rows } = await query(
      `INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING RETURNING id, email, role, created_at`,
      [newId('adm'), b.email, await bcrypt.hash(b.password, 10), b.role],
    )
    if (!rows.length) throw conflict('Someone already has that email', 'STAFF_EXISTS')
    req.params.id = rows[0].id
    res.status(201).json(staffDto(rows[0]))
  }),
)

/** Changes a person's role or password. Their open sessions end, so they sign in again under the change. */
router.patch(
  '/staff/:id',
  requireManager,
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ role: z.enum(ROLES).optional(), password: password.optional() }), req.body)
    if (req.params.id === req.admin.id && b.role && b.role !== 'MANAGER') throw badRequest('You cannot remove your own manager role', 'SELF_DEMOTE')
    const hash = b.password ? await bcrypt.hash(b.password, 10) : null
    const result = await tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE admin_users SET role = COALESCE($2, role), password_hash = COALESCE($3, password_hash) WHERE id = $1
         RETURNING id, email, role, created_at`,
        [req.params.id, b.role ?? null, hash],
      )
      if (!rows.length) throw notFound('No staff member with that id')
      await c.query("UPDATE refresh_sessions SET revoked_at = $2 WHERE user_id = $1 AND user_type = 'admin' AND revoked_at IS NULL", [req.params.id, now()])
      return rows[0]
    })
    res.json(staffDto(result))
  }),
)

/** For a lost phone: clears someone's two-step sign-in and ends their sessions. They set it up again at next sign-in. */
router.post(
  '/staff/:id/two-step/reset',
  requireManager,
  asyncHandler(async (req, res) => {
    await tx(async (c) => {
      const { rows } = await c.query('SELECT id FROM admin_users WHERE id = $1 FOR UPDATE', [req.params.id])
      if (!rows.length) throw notFound('No staff member with that id')
      await clearTwoStep(c, req.params.id)
      await c.query("UPDATE refresh_sessions SET revoked_at = $2 WHERE user_id = $1 AND user_type = 'admin' AND revoked_at IS NULL", [req.params.id, now()])
    })
    res.status(204).end()
  }),
)

/** Removes someone's access. Their open sessions end; an access token already issued lapses within 15 minutes. */
router.delete(
  '/staff/:id',
  requireManager,
  asyncHandler(async (req, res) => {
    if (req.params.id === req.admin.id) throw badRequest('You cannot remove yourself', 'SELF_REMOVE')
    await tx(async (c) => {
      const r = await c.query('DELETE FROM admin_users WHERE id = $1', [req.params.id])
      if (!r.rowCount) throw notFound('No staff member with that id')
      await c.query("UPDATE refresh_sessions SET revoked_at = $2 WHERE user_id = $1 AND user_type = 'admin' AND revoked_at IS NULL", [req.params.id, now()])
    })
    res.status(204).end()
  }),
)

/** The staff audit trail, newest first. Managers only. */
router.get(
  '/audit',
  requireManager,
  asyncHandler(async (req, res) => {
    const f = parse(
      z.object({
        staff: z.string().trim().toLowerCase().max(200).optional(),
        target: z.string().trim().max(100).optional(),
        from: z.string().refine(isDate).optional(),
        to: z.string().refine(isDate).optional(),
        page: z.coerce.number().int().min(1).max(10_000).default(1),
      }),
      req.query,
    )
    const where = []
    const params = []
    const add = (sql, v) => {
      params.push(v)
      where.push(sql.replace('?', `$${params.length}`))
    }
    if (f.staff) add('email = ?', f.staff)
    if (f.target) add('target LIKE ?', `${f.target.replace(/[%_\\]/g, '\\$&')}%`)
    if (f.from) add("created_at >= (?::date)::timestamp AT TIME ZONE 'Asia/Kolkata'", f.from)
    if (f.to) add("created_at < ((?::date) + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'", f.to)
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = (await query(`SELECT COUNT(*)::int AS n FROM staff_audit ${w}`, params)).rows[0].n
    const { rows } = await query(
      `SELECT * FROM staff_audit ${w} ORDER BY created_at DESC, id DESC LIMIT ${AUDIT_PAGE} OFFSET ${(f.page - 1) * AUDIT_PAGE}`,
      params,
    )
    const staff = (await query('SELECT email, role FROM admin_users ORDER BY email')).rows
    res.json({
      page: f.page,
      pageSize: AUDIT_PAGE,
      total,
      staff,
      items: rows.map((a) => ({ id: a.id, at: a.created_at, email: a.email, role: a.role, action: a.action, target: a.target, detail: a.detail })),
    })
  }),
)

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
  const since = new Date(now().getTime() - 90 * 86_400_000)
  const [hist, del] = await Promise.all([
    c.query(
      `SELECT COUNT(*)::int AS claims, COUNT(*) FILTER (WHERE resolution = 'REPLACEMENT_APPROVED')::int AS replacements
         FROM claims WHERE customer_id = $1 AND created_at >= $2 AND id <> $3`,
      [claim.customer_id, since, claim.id],
    ),
    c.query(`SELECT method, created_at FROM delivery_attempts WHERE order_id = $1 AND outcome = 'DELIVERED' ORDER BY created_at DESC LIMIT 1`, [claim.order_id]),
  ])
  const h = hist.rows[0]
  const d = del.rows[0]
  const reasons = []
  if (h.replacements >= CLAIM_MANAGER_AFTER) reasons.push(`${h.replacements} replacements in the last 90 days`)
  if (claim.issue_type === 'NOT_DELIVERED' && d?.method === 'code') reasons.push("the customer's own code confirmed the delivery")
  return {
    history: { claims90d: h.claims, replacements90d: h.replacements },
    delivery: d ? { method: d.method, at: d.created_at } : null,
    managerNeeded: reasons.length ? reasons : null,
  }
}

router.get(
  '/claims',
  asyncHandler(async (req, res) => {
    const status = req.query.status ? parse(z.enum(['SUBMITTED', 'UNDER_REVIEW', 'RESOLVED']), req.query.status) : null
    const { rows } = await query(
      `SELECT c.*, o.number AS order_number, o.total AS order_total, o.phone, r.number AS replacement_number
         FROM claims c JOIN orders o ON o.id = c.order_id LEFT JOIN orders r ON r.id = c.replacement_order_id
        WHERE ($1::text IS NULL AND c.status IN ('SUBMITTED', 'UNDER_REVIEW')) OR c.status = $1
        ORDER BY c.created_at`,
      [status],
    )
    const pics = await query('SELECT id, claim_id FROM claim_photos WHERE claim_id = ANY($1) ORDER BY created_at', [rows.map((c) => c.id)])
    const risks = new Map()
    for (const c of rows) if (c.status !== 'RESOLVED') risks.set(c.id, await claimRisk({ query }, c))
    res.json(
      rows.map((c) => ({
        ...(risks.has(c.id) ? risks.get(c.id) : {}),
        photos: pics.rows.filter((p) => p.claim_id === c.id).map((p) => ({ id: p.id })),
        id: c.id, orderId: c.order_id, orderNumber: c.order_number, orderTotal: c.order_total, customerPhone: c.phone,
        issueType: c.issue_type, description: c.description, affectedItems: c.affected_items, photoUrl: c.photo_url,
        status: c.status, resolution: c.resolution, createdAt: c.created_at,
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
    const { resolution } = parse(z.object({ resolution: z.enum(['REPLACEMENT_APPROVED', 'REJECTED']) }), req.body)
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
        `UPDATE claims SET status = 'RESOLVED', resolution = $2, replacement_order_id = $3, resolved_by = $4, resolved_at = $5 WHERE id = $1`,
        [claim.id, resolution, replacementId, req.admin.email, now()],
      )
    })
    res.status(204).end()
  }),
)

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

