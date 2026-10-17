import { attachDatabasePool } from '@vercel/functions'
import pg from 'pg'
import { env, onVercel } from './env.js'
import { logger } from './logger.js'

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
})

// Lets Vercel close idle connections before it suspends an instance.
if (onVercel) attachDatabasePool(pool)

pool.on('error', (err) => logger.error({ err }, 'idle pg client error'))

export const query = (text, params) => pool.query(text, params)

/** Runs fn(client) inside a transaction. */
export async function tx(fn) {
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
      await new Promise((r) => setTimeout(r, attempt * baseMs))
    }
  }
}

export const closePool = () => pool.end()
