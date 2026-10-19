// Cloudflare Turnstile: a check, usually invisible, that a person and not a
// script is asking for a login code. On only when TURNSTILE_SECRET_KEY is set.
import { env } from './env.js'
import { HttpError } from './errors.js'
import { logger } from './logger.js'

const VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export async function requireHuman(token, ip) {
  if (!env.TURNSTILE_SECRET_KEY) return
  if (typeof token !== 'string' || !token || token.length > 2048) throw new HttpError(400, 'CAPTCHA_REQUIRED', 'Please complete the check, then ask for a code again.')
  let ok = false
  try {
    const res = await fetch(VERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(5_000),
    })
    ok = Boolean((await res.json()).success)
  } catch (err) {
    // Cloudflare unreachable: let the code go. The daily budget still caps the cost.
    logger.warn({ err }, 'Turnstile check failed to run; allowing the request')
    return
  }
  if (!ok) throw new HttpError(400, 'CAPTCHA_FAILED', 'That check did not pass. Please try again.')
}
