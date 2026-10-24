// What /ready says about the maintenance loop (holds, payments, messages).
import { deployEnv } from './env.js'

/**
 * /ready fails when the maintenance job hasn't finished a run in this long.
 * 4 minutes (three missed every-minute runs) so an uptime monitor checking
 * every minute alerts within 5 minutes of the last run, while one slow or
 * skipped run (up to 45 s budget plus the next tick) never trips it.
 */
export const MAINTENANCE_STALE_S = 240

/**
 * Whether the maintenance loop counts as alive, from the age of its last
 * finished run in seconds (null = it has never finished one).
 * In production "never" is a failure: the cron is missing, its secret is
 * wrong, or every run dies, and holds would never be released. Elsewhere
 * (development, tests, Vercel previews, which Vercel Cron doesn't call) a
 * fresh database with no run yet is fine.
 */
export function maintenanceReady(ageSeconds, { env = deployEnv, staleS = MAINTENANCE_STALE_S } = {}) {
  if (ageSeconds === null || ageSeconds === undefined) return env !== 'production'
  return ageSeconds <= staleS
}
