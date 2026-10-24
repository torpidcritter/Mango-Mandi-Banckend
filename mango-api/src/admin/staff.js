// Staff accounts (managers only).
import bcrypt from 'bcryptjs'
import express from 'express'
import { z } from 'zod'
import { ROLES } from '../access.js'
import { forgetStaff, requireManager } from '../auth.js'
import { now } from '../clock.js'
import { query, tx } from '../db.js'
import { asyncHandler, badRequest, conflict, notFound, parse } from '../errors.js'
import { newId } from '../ids.js'
import { staffPassword } from '../passwords.js'
import { clearPasswordFailures, clearTwoStep, issueSetupCode } from './shared.js'

export const router = express.Router()

// ---------------------------------------------------------------- staff

const staffDto = (u) => ({ id: u.id, email: u.email, role: u.role, createdAt: u.created_at, twoStep: Boolean(u.totp_enabled_at) })
// SEC-09: 12 characters at least, and not a common password (src/passwords.js).
const password = staffPassword

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
    // Shown once: they need it to set up two-step sign-in where it is required.
    const setupCode = await issueSetupCode({ query }, rows[0].id)
    res.status(201).json({ ...staffDto(rows[0]), setupCode })
  }),
)

/** Changes a person's role or password. Their open sessions and access tokens end, so they sign in again under the change. */
router.patch(
  '/staff/:id',
  requireManager,
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ role: z.enum(ROLES).optional(), password: password.optional() }), req.body)
    if (req.params.id === req.admin.id && b.role && b.role !== 'MANAGER') throw badRequest('You cannot remove your own manager role', 'SELF_DEMOTE')
    const hash = b.password ? await bcrypt.hash(b.password, 10) : null
    const result = await tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE admin_users SET role = COALESCE($2, role), password_hash = COALESCE($3, password_hash), session_version = session_version + 1
         WHERE id = $1 RETURNING id, email, role, created_at, totp_enabled_at`,
        [req.params.id, b.role ?? null, hash],
      )
      if (!rows.length) throw notFound('No staff member with that id')
      await c.query("UPDATE refresh_sessions SET revoked_at = $2 WHERE user_id = $1 AND user_type = 'admin' AND revoked_at IS NULL", [req.params.id, now()])
      // A new password also lifts a lock from wrong passwords.
      if (hash) await clearPasswordFailures(rows[0].email, c)
      return rows[0]
    })
    forgetStaff(req.params.id)
    res.json(staffDto(result))
  }),
)

/**
 * For a lost phone: clears someone's two-step sign-in and ends their sessions.
 * They set it up again at next sign-in, with the setup code returned here (shown once).
 */
router.post(
  '/staff/:id/two-step/reset',
  requireManager,
  asyncHandler(async (req, res) => {
    const setupCode = await tx(async (c) => {
      const { rows } = await c.query('SELECT id FROM admin_users WHERE id = $1 FOR UPDATE', [req.params.id])
      if (!rows.length) throw notFound('No staff member with that id')
      await clearTwoStep(c, req.params.id)
      await c.query('UPDATE admin_users SET session_version = session_version + 1 WHERE id = $1', [req.params.id])
      await c.query("UPDATE refresh_sessions SET revoked_at = $2 WHERE user_id = $1 AND user_type = 'admin' AND revoked_at IS NULL", [req.params.id, now()])
      return issueSetupCode(c, req.params.id)
    })
    forgetStaff(req.params.id)
    res.json({ setupCode })
  }),
)

/** A new two-step setup code for someone who hasn't set it up (lost the first, or added before codes existed). Shown once. */
router.post(
  '/staff/:id/two-step/setup-code',
  requireManager,
  asyncHandler(async (req, res) => {
    const setupCode = await tx(async (c) => {
      const { rows } = await c.query('SELECT totp_enabled_at FROM admin_users WHERE id = $1 FOR UPDATE', [req.params.id])
      if (!rows.length) throw notFound('No staff member with that id')
      if (rows[0].totp_enabled_at) throw conflict('Two-step sign-in is already on for them. Reset it if they lost their phone.', 'TWO_STEP_ON')
      return issueSetupCode(c, req.params.id)
    })
    res.json({ setupCode })
  }),
)

/** Removes someone's access. Their open sessions end, and access tokens already issued stop working (see requireAdmin). */
router.delete(
  '/staff/:id',
  requireManager,
  asyncHandler(async (req, res) => {
    if (req.params.id === req.admin.id) throw badRequest('You cannot remove yourself', 'SELF_REMOVE')
    await tx(async (c) => {
      const r = await c.query('DELETE FROM admin_users WHERE id = $1', [req.params.id])
      if (!r.rowCount) throw notFound('No staff member with that id')
      // Their stops go back to the unassigned pool (SEC-02).
      await c.query('UPDATE orders SET rider_id = NULL WHERE rider_id = $1', [req.params.id])
      await c.query("UPDATE refresh_sessions SET revoked_at = $2 WHERE user_id = $1 AND user_type = 'admin' AND revoked_at IS NULL", [req.params.id, now()])
    })
    forgetStaff(req.params.id)
    res.status(204).end()
  }),
)
