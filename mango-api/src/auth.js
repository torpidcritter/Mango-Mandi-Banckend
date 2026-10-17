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
import { forbidden, unauthorized } from './errors.js'
import { logger } from './logger.js'

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
  return tx(async (c) => {
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

export function requireAdmin(req, _res, next) {
  try {
    const c = bearer(req, 'admin')
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

export function requireCustomer(req, _res, next) {
  try {
    const c = bearer(req, 'customer')
    req.customer = { id: c.sub, phone: c.phone }
    req.actor = { type: 'customer', id: c.sub, label: 'customer' }
    next()
  } catch (err) {
    next(err)
  }
}
