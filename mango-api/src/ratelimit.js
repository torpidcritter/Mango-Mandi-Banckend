// Rate limits that hold across serverless instances. express-rate-limit's
// default store lives in one instance's memory, so on Vercel every new
// instance starts from zero and a burst spread over instances is never
// limited. The sign-in routes (login codes, staff passwords) count in
// Postgres instead; the general API limit stays in memory (a coarse guard,
// and one row write per request would cost more than it saves).
import rateLimit from 'express-rate-limit'
import { now } from './clock.js'
import { query } from './db.js'
import { env } from './env.js'

/** Adds one hit to `key` in a fixed window. Returns { hits, resetAt }. */
export async function hit(key, windowMs, at = now()) {
  const { rows } = await query(
    `INSERT INTO rate_limits (key, hits, reset_at) VALUES ($1, 1, $2)
     ON CONFLICT (key) DO UPDATE SET
       hits = CASE WHEN rate_limits.reset_at <= $3 THEN 1 ELSE rate_limits.hits + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at <= $3 THEN $2 ELSE rate_limits.reset_at END
     RETURNING hits, reset_at`,
    [key, new Date(at.getTime() + windowMs), at],
  )
  return { hits: rows[0].hits, resetAt: rows[0].reset_at }
}

/** An express-rate-limit store backed by the rate_limits table. */
export class PgStore {
  constructor(prefix) {
    this.prefix = prefix
    this.localKeys = false
  }

  init(options) {
    this.windowMs = options.windowMs
  }

  async increment(key) {
    const r = await hit(`${this.prefix}:${key}`, this.windowMs)
    return { totalHits: r.hits, resetTime: r.resetAt }
  }

  async decrement(key) {
    await query('UPDATE rate_limits SET hits = GREATEST(hits - 1, 0) WHERE key = $1', [`${this.prefix}:${key}`])
  }

  async resetKey(key) {
    await query('DELETE FROM rate_limits WHERE key = $1', [`${this.prefix}:${key}`])
  }
}

/**
 * A per-address limiter for sign-in routes, shared by every instance. If the
 * database can't be reached the request goes through (it would fail on the
 * database anyway) rather than locking everyone out.
 */
export function sharedLimiter(prefix, { windowMs, limit, message = 'Too many attempts. Try again later.', keyGenerator }) {
  return rateLimit({
    windowMs,
    limit,
    ...(keyGenerator ? { keyGenerator } : {}),
    store: new PgStore(prefix),
    passOnStoreError: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => env.NODE_ENV === 'test',
    handler: (req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message, requestId: req.id } }),
  })
}
