// Applies migrations/*.sql in filename order, each in its own transaction,
// under an advisory lock so concurrent deploys never race. The lock is a
// session lock, so on Neon this runs on the direct (unpooled) connection: on
// Vercel it is the API's build step (npm run vercel-build), and a failed
// migration fails the build, so that version never goes live.
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import pg from 'pg'
import { pool as appPool } from './db.js'
import { deployEnv, env } from './env.js'
import { logger } from './logger.js'

const MIGRATION_LOCK = 427714201
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/**
 * How long one migration statement may wait for a table lock. An ALTER TABLE
 * queued behind a long transaction would otherwise hold every order write up
 * behind it; with this it gives up, the transaction rolls back, and the
 * runner tries again a little later (then fails the build).
 */
export const MIGRATION_LOCK_TIMEOUT = process.env.MIGRATION_LOCK_TIMEOUT || '5s'
const LOCK_ATTEMPTS = 3
const LOCK_RETRY_MS = 3_000
const LOCK_NOT_AVAILABLE = '55P03'

export async function runMigrations() {
  const direct = env.DATABASE_URL_UNPOOLED ? new pg.Pool({ connectionString: env.DATABASE_URL_UNPOOLED, max: 1 }) : null
  try {
    await migrate(direct ?? appPool)
  } finally {
    await direct?.end()
  }
}

/**
 * Every database remembers which environment it belongs to (app_meta), set
 * by the first migration. A preview or development build pointed at the
 * production database (an env var copied to the wrong environment) is
 * refused before it can migrate, seed or serve it, and the other way round.
 * If a move is intended: UPDATE app_meta SET value = '<env>' WHERE key = 'environment'.
 */
export const isProductionEnv = (e) => e === 'production'

export async function checkDatabaseEnvironment(c, target = deployEnv, { claim = false } = {}) {
  if (claim) await c.query('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  else if (!(await c.query(`SELECT to_regclass('public.app_meta') AS t`)).rows[0].t) return target // not migrated yet
  const { rows } = await c.query(`SELECT value FROM app_meta WHERE key = 'environment'`)
  const owner = rows[0]?.value
  if (!owner) {
    if (claim) await c.query(`INSERT INTO app_meta (key, value) VALUES ('environment', $1) ON CONFLICT DO NOTHING`, [target])
    return target
  }
  if (isProductionEnv(owner) !== isProductionEnv(target)) {
    throw new Error(`This database belongs to ${owner}, and this is a ${target} deployment: refusing to use it. Point DATABASE_URL at the right Neon branch.`)
  }
  return owner
}

export async function migrate(pool, { dir = DIR, lockTimeout = MIGRATION_LOCK_TIMEOUT, attempts = LOCK_ATTEMPTS, retryMs = LOCK_RETRY_MS } = {}) {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK])
    await checkDatabaseEnvironment(client, deployEnv, { claim: true })
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version))
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
    for (const file of files) {
      if (done.has(file)) continue
      const sql = await readFile(path.join(dir, file), 'utf8')
      for (let attempt = 1; ; attempt++) {
        try {
          await client.query('BEGIN')
          await client.query(`SELECT set_config('lock_timeout', $1, true)`, [lockTimeout])
          await client.query(sql)
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file])
          await client.query('COMMIT')
          logger.info({ file }, 'migration applied')
          break
        } catch (err) {
          await client.query('ROLLBACK')
          if (err.code === LOCK_NOT_AVAILABLE && attempt < attempts) {
            logger.warn({ file, attempt }, 'migration waited too long for a table lock; trying again')
            await new Promise((r) => {
              setTimeout(r, retryMs)
            })
            continue
          }
          const hint = err.code === LOCK_NOT_AVAILABLE ? ` (a table it changes stayed locked for over ${lockTimeout}, ${attempts} times: look for a long transaction in pg_stat_activity)` : ''
          throw new Error(`Migration ${file} failed: ${err.message}${hint}`)
        }
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {})
    client.release()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(() => appPool.end())
    .catch((err) => {
      logger.error(err.message)
      process.exit(1)
    })
}
