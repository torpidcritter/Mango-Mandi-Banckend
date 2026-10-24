// Helpers more than one admin area uses.
import { hit } from '../ratelimit.js'
import { now } from '../clock.js'
import { hashRecovery, newRecoveryCodes } from '../totp.js'
import { query } from '../db.js'
import { HttpError } from '../errors.js'

const PASSWORD_FAILURES = 10
const PASSWORD_WINDOW_MS = 15 * 60_000
const pwKey = (email) => `staff-pw:${email}`
export const PW_LOCKED = () =>
  new HttpError(429, 'ACCOUNT_LOCKED', 'Too many wrong passwords for this account. Try again in 15 minutes, sign in with Google, or ask a manager to set a new password.')

export async function passwordLocked(email) {
  const { rows } = await query('SELECT hits FROM rate_limits WHERE key = $1 AND reset_at > $2', [pwKey(email), now()])
  return (rows[0]?.hits ?? 0) >= PASSWORD_FAILURES
}

export const passwordFailed = (email) => hit(pwKey(email), PASSWORD_WINDOW_MS)

export const clearPasswordFailures = (email, c = { query }) => c.query('DELETE FROM rate_limits WHERE key = $1', [pwKey(email)])

// SEC-6: where two-step is required, setting it up needs a one-time code from
// a manager as well as the password, so someone holding only the password
// can't put their own authenticator app on the account. The first manager to
// set it up (no other manager has it yet) needs none: nobody could give them one.
const SETUP_CODE_TTL_MS = 7 * 86_400_000
export const SETUP_CODE_TRIES_PER_HOUR = 5

/** Issues a fresh setup code for a staff member (replacing any earlier one). Returns it, to show once. */
export async function issueSetupCode(c, adminId) {
  const [code] = newRecoveryCodes(1)
  await c.query('UPDATE admin_users SET setup_code_hash = $2, setup_code_expires_at = $3 WHERE id = $1', [
    adminId, hashRecovery(code), new Date(now().getTime() + SETUP_CODE_TTL_MS),
  ])
  return code
}

export async function clearTwoStep(c, adminId) {
  await c.query(
    `UPDATE admin_users SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, totp_last_step = NULL,
       two_step_failures = 0, two_step_locked_until = NULL WHERE id = $1`,
    [adminId],
  )
  await c.query('DELETE FROM staff_recovery_codes WHERE admin_id = $1', [adminId])
}

/** The most rows the claims and batches lists return (resolved claims: the newest). */
export const LIST_LIMIT = 500
