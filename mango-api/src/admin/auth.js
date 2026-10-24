// Staff sign-in (before the gate in admin.js) and your own account (after it).
import { googleOn, verifyGoogleCredential } from '../google.js'
import bcrypt from 'bcryptjs'
import express from 'express'
import jwt from 'jsonwebtoken'
import { hit, sharedLimiter } from '../ratelimit.js'
import { z } from 'zod'
import { audit } from '../access.js'
import { ACCESS_TTL_S, forgetStaff, issueRefresh, refreshLimiter, revokeRefresh, rotateRefresh, sameSiteOnly, signAccess } from '../auth.js'
import { now } from '../clock.js'
import { hashRecovery, newRecoveryCodes, newSecret, otpauthUrl, verifyCode } from '../totp.js'
import { query, tx } from '../db.js'
import { env } from '../env.js'
import { asyncHandler, badRequest, conflict, HttpError, parse, unauthorized } from '../errors.js'
import { newId } from '../ids.js'
import { staffPassword } from '../passwords.js'
import { clearPasswordFailures, clearTwoStep, passwordFailed, passwordLocked, PW_LOCKED, SETUP_CODE_TRIES_PER_HOUR } from './shared.js'

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
 * Whether this role must use two-step sign-in (STAFF_TWO_STEP). In production
 * the default is "all": riders and packers see customers' names, phones and
 * addresses too. "managers" covers operators as well: both can cancel orders,
 * move stock and see every customer's details.
 */
const OFFICE_ROLES = ['MANAGER', 'OPERATOR']
const twoStepRequired = (role) => env.STAFF_TWO_STEP === 'all' || (env.STAFF_TWO_STEP === 'managers' && OFFICE_ROLES.includes(role))

/** The access token. "setup" marks someone who must set up two-step sign-in before anything else. */
const staffAccess = (u) =>
  signAccess({
    sub: u.id, email: u.email, role: u.role, typ: 'admin', sv: u.session_version ?? 0,
    ...(twoStepRequired(u.role) && !u.totp_enabled_at ? { setup: true } : {}),
  })

async function startSession(req, res, user, method) {
  const refresh = await issueRefresh(user.id, 'admin')
  await audit(user, 'auth.login', { detail: { method, twoStep: Boolean(user.totp_enabled_at) }, requestId: req.id })
  res.cookie(COOKIE, refresh.token, { ...cookieOptions(), expires: refresh.expiresAt })
  res.json({ accessToken: staffAccess(user), expiresIn: ACCESS_TTL_S })
}

const TICKET_TTL_S = 5 * 60
const TWO_STEP_MAX_FAILURES = 5
const TWO_STEP_LOCK_MS = 15 * 60_000
const STAFF_COLUMNS = 'id, email, role, session_version, totp_secret, totp_enabled_at, totp_last_step, two_step_failures, two_step_locked_until'

// SEC-4: wrong passwords per account (unknown emails too, so the answer never
// shows whether an account exists), on top of the per-address limit. After 10
// in 15 minutes the account's password sign-in waits out the rest of the
// window: slow enough to stop guessing, short enough that someone locking a
// colleague out on purpose only delays them (Google sign-in still works).

/** Whether this sign-in must give a manager's setup code before setting up two-step. */
async function setupCodeNeeded(adminId, setupSession) {
  if (!setupSession) return false
  const { rows } = await query("SELECT 1 FROM admin_users WHERE role = 'MANAGER' AND totp_enabled_at IS NOT NULL AND id <> $1 LIMIT 1", [adminId])
  return rows.length > 0
}

/**
 * After the password or Google: either the session, or, with two-step on, a
 * short ticket to send back with the code from the authenticator app.
 */
async function passFirstStep(req, res, user, method) {
  if (!user.totp_enabled_at) return await startSession(req, res, user, method)
  const ticket = jwt.sign({ sub: user.id, typ: 'admin_two_step', method, iat: Math.floor(now().getTime() / 1000) }, env.JWT_SECRET, { expiresIn: TICKET_TTL_S, algorithm: 'HS256' })
  res.json({ twoStep: true, ticket, expiresIn: TICKET_TTL_S })
}

export const signIn = express.Router()

signIn.post(
  '/auth/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) }), req.body)
    if (await passwordLocked(email)) throw PW_LOCKED()
    const { rows } = await query(`SELECT ${STAFF_COLUMNS}, password_hash FROM admin_users WHERE email = $1`, [email])
    const user = rows[0]
    const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH)
    if (!user || !ok) {
      await passwordFailed(email)
      throw unauthorized('Incorrect email or password', 'INVALID_CREDENTIALS')
    }
    await clearPasswordFailures(email)
    await passFirstStep(req, res, user, 'password')
  }),
)

/** The second step: a 6-digit code from the authenticator app, or a recovery code. */
signIn.post(
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
signIn.get('/auth/config', (_req, res) => res.json({ googleClientId: googleOn() ? env.GOOGLE_CLIENT_ID.split(',')[0].trim() : null }))

// Staff sign in with Google when the Google account's verified email is their staff email.
signIn.post(
  '/auth/google',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { credential } = parse(z.object({ credential: z.string().min(20).max(4096) }), req.body)
    const g = await verifyGoogleCredential(credential)
    // SEC-13: optionally only the shop's own Google Workspace accounts (Google's hd claim).
    if (env.STAFF_GOOGLE_HD && g.hd !== env.STAFF_GOOGLE_HD.trim().toLowerCase()) {
      throw unauthorized(`Sign in with your ${env.STAFF_GOOGLE_HD} Google account.`, 'NOT_STAFF')
    }
    const { rows } = await query(`SELECT ${STAFF_COLUMNS} FROM admin_users WHERE email = $1`, [g.email])
    const user = rows[0]
    if (!user) throw unauthorized(`${g.email} is not a staff account. Ask a manager to add you.`, 'NOT_STAFF')
    await passFirstStep(req, res, user, 'google')
  }),
)

signIn.post(
  '/auth/refresh',
  sameSiteOnly,
  refreshLimiter('admin', COOKIE),
  asyncHandler(async (req, res) => {
    const { userId, refresh } = await rotateRefresh(req.cookies?.[COOKIE], 'admin')
    const { rows } = await query('SELECT id, email, role, session_version, totp_enabled_at FROM admin_users WHERE id = $1', [userId])
    if (!rows.length) throw unauthorized('Session expired. Please sign in again.', 'INVALID_TOKEN')
    if (refresh) res.cookie(COOKIE, refresh.token, { ...cookieOptions(), expires: refresh.expiresAt })
    res.json({ accessToken: staffAccess(rows[0]), expiresIn: ACCESS_TTL_S })
  }),
)

signIn.post(
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
export const needsSetupFirst = (req, _res, next) =>
  next(req.admin.setup && !SETUP_ROUTES.has(`${req.method} ${req.path}`) ? new HttpError(403, 'TWO_STEP_SETUP_REQUIRED', 'Set up two-step sign-in first') : undefined)

export const me = express.Router()

me.get(
  '/auth/me',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT totp_enabled_at FROM admin_users WHERE id = $1', [req.admin.id])
    if (!rows.length) throw unauthorized('Session expired. Please sign in again.', 'INVALID_TOKEN')
    res.json({
      email: req.admin.email, role: req.admin.role,
      twoStep: {
        enabled: Boolean(rows[0].totp_enabled_at),
        required: twoStepRequired(req.admin.role),
        setupCodeNeeded: !rows[0].totp_enabled_at && (await setupCodeNeeded(req.admin.id, req.admin.setup)),
      },
    })
  }),
)

// ---------------------------------------------------------------- two-step sign-in (your own)

/** A new secret for the authenticator app. It only counts once a code from the app is confirmed. */
me.post(
  '/me/two-step/setup',
  asyncHandler(async (req, res) => {
    const { setupCode } = parse(z.object({ setupCode: z.string().trim().max(20).optional() }), req.body ?? {})
    if (await setupCodeNeeded(req.admin.id, req.admin.setup)) {
      if (!setupCode) throw new HttpError(403, 'SETUP_CODE_REQUIRED', 'Enter the setup code a manager gave you. Ask a manager if you don’t have one.')
      const tries = await hit(`staff-setup-code:${req.admin.id}`, 3_600_000)
      if (tries.hits > SETUP_CODE_TRIES_PER_HOUR) throw new HttpError(429, 'RATE_LIMITED', 'Too many tries. Try again in an hour.')
      const { rows } = await query('SELECT setup_code_hash, setup_code_expires_at FROM admin_users WHERE id = $1', [req.admin.id])
      const u = rows[0]
      const norm = /^[a-z0-9]{8}$/i.test(setupCode) ? `${setupCode.slice(0, 4)}-${setupCode.slice(4)}` : setupCode
      if (!u?.setup_code_hash || u.setup_code_expires_at <= now() || hashRecovery(norm) !== u.setup_code_hash) {
        await audit(req.admin, 'auth.setup_code_failed', { requestId: req.id })
        throw new HttpError(422, 'WRONG_SETUP_CODE', 'That setup code is not right, or it has expired. Ask a manager for a new one.')
      }
    }
    const secret = newSecret()
    const r = await query('UPDATE admin_users SET totp_pending = $2 WHERE id = $1 AND totp_enabled_at IS NULL', [req.admin.id, secret])
    if (!r.rowCount) throw conflict('Two-step sign-in is already on', 'TWO_STEP_ON')
    res.json({ secret, otpauthUrl: otpauthUrl(req.admin.email, secret) })
  }),
)

/** Confirms the app works and turns two-step on. Returns the recovery codes, shown this once. */
me.post(
  '/me/two-step/enable',
  asyncHandler(async (req, res) => {
    const { code } = parse(z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }), req.body)
    const codes = newRecoveryCodes()
    const user = await tx(async (c) => {
      const { rows } = await c.query('SELECT id, email, role, session_version, totp_pending, totp_enabled_at FROM admin_users WHERE id = $1 FOR UPDATE', [req.admin.id])
      const u = rows[0]
      if (u.totp_enabled_at) throw conflict('Two-step sign-in is already on', 'TWO_STEP_ON')
      if (!u.totp_pending) throw badRequest('Start the set-up again', 'NO_SETUP')
      const step = verifyCode(u.totp_pending, code, now().getTime())
      if (step == null) throw new HttpError(422, 'WRONG_CODE', 'That code is not right. Check the time on your phone and try the newest code.')
      const at = now()
      await c.query(
        `UPDATE admin_users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled_at = $2, totp_last_step = $3, two_step_failures = 0,
           setup_code_hash = NULL, setup_code_expires_at = NULL WHERE id = $1`,
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
me.post(
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

/**
 * Changes your own password (SEC-09), with the current one. Every other
 * session of yours ends (session version and refresh sessions), and this one
 * carries on with fresh tokens. Wrong current passwords count towards the
 * same per-account lock as sign-in.
 */
me.post(
  '/me/password',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ currentPassword: z.string().min(1).max(200), newPassword: staffPassword }), req.body)
    if (await passwordLocked(req.admin.email)) throw PW_LOCKED()
    const { rows } = await query('SELECT password_hash FROM admin_users WHERE id = $1', [req.admin.id])
    if (!rows.length || !(await bcrypt.compare(b.currentPassword, rows[0].password_hash))) {
      await passwordFailed(req.admin.email)
      throw new HttpError(422, 'WRONG_PASSWORD', 'Your current password is not right.')
    }
    if (b.currentPassword === b.newPassword) throw badRequest('Pick a new password, not the one you have now', 'SAME_PASSWORD')
    const hash = await bcrypt.hash(b.newPassword, 10)
    const user = await tx(async (c) => {
      const up = await c.query(`UPDATE admin_users SET password_hash = $2, session_version = session_version + 1 WHERE id = $1 RETURNING ${STAFF_COLUMNS}`, [req.admin.id, hash])
      await c.query("UPDATE refresh_sessions SET revoked_at = $2 WHERE user_id = $1 AND user_type = 'admin' AND revoked_at IS NULL", [req.admin.id, now()])
      await clearPasswordFailures(req.admin.email, c)
      return up.rows[0]
    })
    forgetStaff(req.admin.id)
    await startSession(req, res, user, 'password-change')
  }),
)
