// Time-based one-time codes (RFC 6238: SHA-1, 30 seconds, 6 digits), the kind
// Google Authenticator, Microsoft Authenticator and 1Password show.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const STEP_S = 30
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s) {
  const clean = s.replace(/[\s=-]/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out = []
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch)
    if (i < 0) throw new Error('not base32')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** A new 160-bit secret, base32 as authenticator apps expect. */
export const newSecret = () => base32Encode(randomBytes(20))

export const stepAt = (ms) => Math.floor(ms / 1000 / STEP_S)

export function codeAt(secret, step) {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(step))
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest()
  const off = h[h.length - 1] & 15
  const n = (h.readUInt32BE(off) & 0x7fffffff) % 1_000_000
  return String(n).padStart(6, '0')
}

/**
 * Checks a code, allowing one step either side for a phone clock that is a
 * little off. Returns the matching step, or null. A step at or before
 * `lastStep` is refused so a code can't be used twice.
 */
export function verifyCode(secret, code, atMs, lastStep = null) {
  if (!/^\d{6}$/.test(code ?? '')) return null
  const now = stepAt(atMs)
  for (const step of [now, now - 1, now + 1]) {
    if (lastStep != null && step <= Number(lastStep)) continue
    const want = Buffer.from(codeAt(secret, step))
    if (timingSafeEqual(want, Buffer.from(code))) return step
  }
  return null
}

export function otpauthUrl(email, secret, issuer = 'MandiMangoes Ops') {
  const label = encodeURIComponent(`${issuer}:${email}`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_S}`
}

/** Ten single-use recovery codes like "k7qd-2mxp". */
export function newRecoveryCodes(n = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'
  return Array.from({ length: n }, () => {
    const b = randomBytes(8)
    const s = [...b].map((x) => chars[x % chars.length]).join('')
    return `${s.slice(0, 4)}-${s.slice(4)}`
  })
}

export const hashRecovery = (code) => createHash('sha256').update(code.trim().toLowerCase().replace(/\s/g, '')).digest('hex')
