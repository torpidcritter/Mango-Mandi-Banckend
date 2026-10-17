// Long-running server (local development, Docker). On Vercel, api/index.js is
// the entry point instead and this file is not used.
import { createApp } from './app.js'
import { closePool, connectWithRetry } from './db.js'
import { env } from './env.js'
import { logger } from './logger.js'
import { startMaintenance, stopMaintenance } from './maintenance.js'
import { runMigrations } from './migrate.js'
import { seed } from './seed.js'
import { flushErrors } from './sentry.js'

async function main() {
  await connectWithRetry(10, 1000)
  await runMigrations()
  await seed()

  const server = createApp().listen(env.PORT, () => logger.info({ port: env.PORT }, 'mango-api listening'))
  startMaintenance()

  const shutdown = (signal) => {
    logger.info({ signal }, 'shutting down')
    stopMaintenance()
    setTimeout(() => process.exit(1), 15_000).unref()
    server.close(async () => {
      await flushErrors()
      await closePool().catch(() => {})
      process.exit(0)
    })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  logger.fatal({ err }, 'startup failed')
  process.exit(1)
})
