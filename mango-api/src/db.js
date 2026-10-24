import { attachDatabasePool } from '@vercel/functions'
import pg from 'pg'
import { env, onVercel } from './env.js'
import { logger } from './logger.js'
import { metrics } from './metrics.js'

// DATE columns come back as plain "YYYY-MM-DD" strings, not JS Dates in local time.
pg.types.setTypeParser(1082, (v) => v)
// BIGINT counts (COUNT(*)) as numbers.
pg.types.setTypeParser(20, (v) => Number(v))

/**
 * Neon's pooler (PgBouncer, transaction mode) hands the server connection back
 * after every transaction, so session settings don't stick. There the timeout is
 * set on the role instead: ALTER ROLE mango_app SET statement_timeout = '10s'.
 * Row locks (FOR UPDATE) and transaction-scoped advisory locks still work.
 */
export const isPooledUrl = (url) => /-pooler\./.test(url)

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  ...(isPooledUrl(env.DATABASE_URL) ? {} : { statement_timeout: env.DB_STATEMENT_TIMEOUT_MS }),
  // Serverless instances come and go: don't hold idle connections for long.
  ...(onVercel ? { idleTimeoutMillis: 5_000 } : {}),
  // Under a burst every instance's few connections can be busy: wait at most
  // this long, then answer 503 "busy, retry" instead of hanging the request.
  connectionTimeoutMillis: env.DB_CONNECT_TIMEOUT_MS,
})

/** The error pg raises when no connection frees up in time. */
export const isPoolTimeout = (err) => /timeout exceeded when trying to connect/i.test(err?.message ?? '')

/**
 * The database can't be reached at all (OPS-08): refused, reset, unknown host,
 * a server shutting down (57P0x) or a connection-class SQLSTATE (08xxx).
 * Callers answer these with a retryable 503, not a 500.
 */
const NET_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'])
export const isDbUnavailable = (err) => {
  if (!err) return false
  const code = String(err.code ?? '')
  if (NET_CODES.has(code) || /^57P0[1-3]$/.test(code) || /^08/.test(code)) return true
  if (err instanceof AggregateError && err.errors?.some(isDbUnavailable)) return true
  return /Connection terminated|connection timeout|Client has encountered a connection error/i.test(err.message ?? '')
}

// Lets Vercel close idle connections before it suspends an instance.
if (onVercel) attachDatabasePool(pool)

pool.on('error', (err) => logger.error({ err }, 'idle pg client error'))

export const query = (text, params) => pool.query(text, params)

/** Deadlock and serialization failures: safe to run the whole transaction again. */
const RETRYABLE = new Set(['40P01', '40001'])

/**
 * Runs fn(client) inside a transaction. A deadlock or serialization failure
 * rolls it back and runs it again (up to `retries` more times, with jitter),
 * so two checkouts that lock the same stock in a different order both finish.
 * fn must only touch the database (or be safe to repeat) for that to be safe;
 * pass { retries: 0 } otherwise.
 */
export async function tx(fn, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await txOnce(fn)
    } catch (err) {
      if (!RETRYABLE.has(err?.code) || attempt >= retries) throw err
      metrics.dbRetries.inc({ code: err.code })
      logger.warn({ sqlState: err.code, attempt: attempt + 1 }, 'transaction retried')
      await new Promise((r) => {
        setTimeout(r, 10 + Math.random() * 40 * (attempt + 1))
      })
    }
  }
}

async function txOnce(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Linear backoff: attempt × baseMs, up to `retries` attempts. */
export async function connectWithRetry(retries = 10, baseMs = 1000) {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1')
      return
    } catch (err) {
      if (attempt >= retries) throw err
      logger.warn({ attempt, err: err.message }, 'database not ready, retrying')
      await new Promise((r) => {
        setTimeout(r, attempt * baseMs)
      })
    }
  }
}

export const closePool = () => pool.end()
