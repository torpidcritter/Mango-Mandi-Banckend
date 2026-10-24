// Staff password rules (SEC-09, OWASP ASVS 2.1.1 and 2.1.7): at least 12
// characters, at most 200, and not a well-known password. The list is the
// common passwords of 12 characters or more from SecLists (src/data), checked
// ignoring case; shorter ones already fail the length rule.
import { readFileSync } from 'node:fs'
import { z } from 'zod'

export const MIN_PASSWORD = 12

let common = null
/** True for a password on the bundled list of common passwords (or one character repeated). */
export function isCommonPassword(pw) {
  common ??= new Set(
    readFileSync(new URL('./data/common-passwords.txt', import.meta.url), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  )
  const p = String(pw).toLowerCase()
  // "Password1234!" style: a listed password with symbols tacked on is just as guessable.
  return common.has(p) || common.has(p.replace(/[^a-z0-9]+$/, '')) || /^(.)\1+$/.test(p)
}

export const staffPassword = z
  .string()
  .min(MIN_PASSWORD, `Use at least ${MIN_PASSWORD} characters`)
  .max(200)
  .refine((pw) => !isCommonPassword(pw), 'That password is too common. Pick a longer phrase only you would think of.')
