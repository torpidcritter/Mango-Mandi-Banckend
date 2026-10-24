// Tokens for staff and customers. Access tokens are 15-minute JWTs. Refresh
// tokens are JWTs whose jti is a refresh_sessions row: each use rotates it.
// Re-presenting a rotated token inside a short grace window (two tabs
// refreshing at once) is allowed; after it, the reuse is treated as theft and
// every session of that user is revoked.
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { now } from './clock.js'
import { query, tx } from './db.js'
import { env } from './env.js'
import { forbidden, HttpError, unauthorized } from './errors.js'
import { logger } from './logger.js'
import { sharedLimiter } from './ratelimit.js'

export const ACCESS_TTL_S = 15 * 60
const REFRESH_TTL_S = { admin: 7 * 86_400, customer: 30 * 86_400 }

export const signAccess = (claims) => jwt.sign(claims, env.JWT_SECRET, { expiresIn: ACCESS_TTL_S, algorithm: 'HS256' })

export async function issueRefresh(userId, userType, c = { query }) {
  const jti = randomUUID()
  const expiresAt = new Date(now().getTime() + REFRESH_TTL_S[userType] * 1000)
  await c.query('INSERT INTO refresh_sessions (jti, user_id, user_type, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)', [
    jti, userId, userType, expiresAt, now(),
  ])
  const token = jwt.sign({ sub: userId, typ: `${userType}_refresh` }, env.JWT_SECRET, {
    jwtid: jti,
    expiresIn: REFRESH_TTL_S[userType],
    algorithm: 'HS256',
  })
  return { token, jti, expiresAt }
}

const invalid = () => unauthorized('Session expired. Please sign in again.', 'INVALID_TOKEN')

/**
 * Rotates a refresh token. Returns { userId, refresh } where refresh is the
 * new token, or null inside the grace window (the caller already has it).
 */
export async function rotateRefresh(token, userType) {
  let claims
  try {
    claims = jwt.verify(token ?? '', env.JWT_SECRET, { algorithms: ['HS256'] })
  } catch {
    throw invalid()
  }
  if (claims.typ !== `${userType}_refresh` || !claims.jti) throw invalid()
  return await tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM refresh_sessions WHERE jti = $1 FOR UPDATE', [claims.jti])
    const s = rows[0]
    if (!s || s.user_type !== userType || s.expires_at <= now()) throw invalid()
    if (s.revoked_at) {
      const inGrace = s.replaced_by && now().getTime() - s.revoked_at.getTime() <= env.REFRESH_REUSE_GRACE_MS
      if (inGrace) return { userId: s.user_id, refresh: userType === 'customer' ? await issueRefresh(s.user_id, userType, c) : null }
      if (s.replaced_by) {
        logger.warn({ userId: s.user_id, userType }, 'refresh token reuse detected; revoking all sessions')
        await c.query(
          'UPDATE refresh_sessions SET revoked_at = $3 WHERE user_id = $1 AND user_type = $2 AND revoked_at IS NULL',
          [s.user_id, userType, now()],
        )
      }
      // Commit the revocation before refusing.
      return { reuse: true }
    }
    const next = await issueRefresh(s.user_id, userType, c)
    await c.query('UPDATE refresh_sessions SET revoked_at = $2, replaced_by = $3 WHERE jti = $1', [s.jti, now(), next.jti])
    return { userId: s.user_id, refresh: next }
  }).then((r) => {
    if (r.reuse) throw invalid()
    return r
  })
}

/**
 * Refresh has its own limit, kept apart from the sign-in limits: many
 * customers share one carrier-NAT address, so a per-address count signed
 * everyone on a busy address out. A valid refresh token is counted per person
 * (generous: a tab refreshes about once in 15 minutes); anything else (no
 * token, a forged or expired one) per address.
 */
export function refreshLimiter(userType, cookieName, { perUser = 60, perAddress = 300 } = {}) {
  const who = (req) => {
    if (req.refreshKey) return req.refreshKey
    let key = `ip:${req.ip}`
    try {
      const c = jwt.verify(req.body?.refreshToken || req.cookies?.[cookieName] || '', env.JWT_SECRET, { algorithms: ['HS256'] })
      if (c.typ === `${userType}_refresh` && c.sub) key = `user:${c.sub}`
    } catch {
      // Not a valid refresh token: counted per address.
    }
    req.refreshKey = key
    return key
  }
  return sharedLimiter(`refresh-${userType}`, {
    windowMs: 15 * 60_000,
    limit: (req) => (who(req).startsWith('user:') ? perUser : perAddress),
    keyGenerator: who,
    message: 'Too many sign-in refreshes. Try again in a few minutes.',
  })
}

export async function revokeRefresh(token) {
  try {
    const claims = jwt.verify(token ?? '', env.JWT_SECRET, { algorithms: ['HS256'] })
    await query('UPDATE refresh_sessions SET revoked_at = $2 WHERE jti = $1 AND revoked_at IS NULL', [claims.jti, now()])
  } catch {
    // Already invalid: nothing to revoke.
  }
}

function bearer(req, typ) {
  const h = req.headers.authorization ?? ''
  if (!h.startsWith('Bearer ')) throw unauthorized()
  try {
    const claims = jwt.verify(h.slice(7), env.JWT_SECRET, { algorithms: ['HS256'] })
    if (claims.typ !== typ) throw new Error('wrong token type')
    return claims
  } catch {
    throw unauthorized('Invalid or expired token', 'INVALID_TOKEN')
  }
}

// SEC-8: an access token is checked against the staff row, so removing
// someone, changing their role or password, or resetting their two-step
// sign-in ends their access at once rather than when the token lapses. The
// row is cached briefly per instance (one primary-key read per person every
// few seconds); a change made on this instance clears it straight away.
const STAFF_CACHE_MS = 5_000
const staffCache = new Map()

/** Drops the cached staff row after a change to it (role, password, two-step, removal). */
export function forgetStaff(id) {
  staffCache.delete(id)
}

async function staffRow(id) {
  const hit = staffCache.get(id)
  if (hit && Date.now() - hit.at < STAFF_CACHE_MS) return hit.row
  const { rows } = await query('SELECT role, session_version FROM admin_users WHERE id = $1', [id])
  const row = rows[0] ?? null
  staffCache.set(id, { at: Date.now(), row })
  if (staffCache.size > 1000) staffCache.delete(staffCache.keys().next().value)
  return row
}

export async function requireAdmin(req, res, next) {
  try {
    const c = bearer(req, 'admin')
    const current = (row) => row && row.role === c.role && row.session_version === (c.sv ?? 0)
    let row = await staffRow(c.sub)
    // A token newer than the cached row (signed in again after a change made on another instance).
    if (!current(row)) {
      forgetStaff(c.sub)
      row = await staffRow(c.sub)
    }
    if (!current(row)) {
      throw unauthorized('Your access has changed. Please sign in again.', 'INVALID_TOKEN')
    }
    // SEC-06: signed-in answers carry personal data; no browser or proxy may keep them. Photos set their own (private) caching.
    res.set('Cache-Control', 'no-store')
    req.admin = { id: c.sub, email: c.email, role: c.role, setup: Boolean(c.setup) }
    req.actor = { type: 'admin', id: c.sub, label: c.email }
    next()
  } catch (err) {
    next(err)
  }
}

export function requireManager(req, _res, next) {
  next(req.admin?.role === 'MANAGER' ? undefined : forbidden())
}

// SEC-01: a token outlives an account deletion by up to its lifetime, so the
// account is checked too. Live accounts are remembered briefly per instance;
// deleting an account forgets it here at once (forgetCustomer).
const customerCache = new Map()
const CUSTOMER_CACHE_MS = 30_000

export function forgetCustomer(id) {
  customerCache.delete(id)
}

/** The live account's session version, or null when the account is gone. */
async function customerLive(id) {
  const hit = customerCache.get(id)
  if (hit && Date.now() - hit.at < CUSTOMER_CACHE_MS) return hit.sv
  const { rows } = await query('SELECT session_version FROM customers WHERE id = $1 AND deleted_at IS NULL', [id])
  if (!rows.length) return null
  customerCache.set(id, { at: Date.now(), sv: rows[0].session_version })
  if (customerCache.size > 5000) customerCache.delete(customerCache.keys().next().value)
  return rows[0].session_version
}

export async function requireCustomer(req, res, next) {
  try {
    const c = bearer(req, 'customer')
    const sv = await customerLive(c.sub)
    if (sv === null) throw unauthorized('This account no longer exists. Please sign in again.', 'INVALID_TOKEN')
    // "Sign out everywhere" raised the version: tokens from before it end (other instances within 30 s).
    if ((c.sv ?? 0) !== sv) throw unauthorized('You signed out on every device. Please sign in again.', 'INVALID_TOKEN')
    res.set('Cache-Control', 'no-store')
    req.customer = { id: c.sub, phone: c.phone }
    req.actor = { type: 'customer', id: c.sub, label: 'customer' }
    next()
  } catch (err) {
    next(err)
  }
}

const allowedOrigins = () =>
  `${env.ADMIN_ORIGIN},${env.CUSTOMER_ORIGIN}`.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean)

/**
 * For routes that act on the refresh cookie (refresh, logout). Browsers send
 * an Origin header on cross-site POSTs, and with SameSite=none (previews) the
 * cookie would go along, so a page on another site could rotate or end a
 * session. Requests from another origin are refused; apps that send the token
 * in the body (no Origin header) are unaffected.
 */
export function sameSiteOnly(req, _res, next) {
  const origin = req.get('origin')
  if (!origin || allowedOrigins().includes(origin)) return next()
  logger.warn({ origin, path: req.path }, 'cross-site request to a session route refused')
  next(new HttpError(403, 'CROSS_SITE', 'This request must come from the MandiMangoes site'))
}
