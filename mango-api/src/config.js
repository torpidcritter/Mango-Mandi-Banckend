// Versioned business rules from app_config. The live (highest) version is
// cached in memory; every order stores the version it was placed under.
import { z } from 'zod'
import { query, tx } from './db.js'
import { STAGES } from './stage.js'

const window = z.object({
  stage: z.enum(STAGES),
  minAge: z.number().int().min(0),
  maxAge: z.number().int().min(0),
})

const profile = z
  .array(window)
  .min(1)
  .refine((p) => p.every((w) => w.minAge <= w.maxAge), 'minAge must be <= maxAge')
  .refine((p) => p.every((w, i) => i === 0 || w.minAge > p[i - 1].maxAge), 'windows must be in age order without overlap')
  .refine(
    (p) => p.every((w, i) => i === 0 || STAGES.indexOf(w.stage) > STAGES.indexOf(p[i - 1].stage)),
    'stages must run RAW → SEMI_RIPE → RIPE',
  )

/** Neighborhood Unlock settings. Off until a manager turns it on. */
export const unlockSettingsSchema = z
  .object({
    enabled: z.boolean(),
    // Minutes after the order-by time before a campaign is judged, so a
    // payment started before the cutoff can finish (the payment hold).
    evaluationGraceMinutes: z.number().int().min(0).max(120),
    publicCacheSeconds: z.number().int().min(0).max(300),
    // Suspicious clusters: this many customers at one address, or orders from
    // one address within this many minutes.
    clusterWindowMinutes: z.number().int().min(1).max(1440),
    clusterMinCustomers: z.number().int().min(2).max(50),
  })
  .strict()

export const DEFAULT_UNLOCK = {
  enabled: false,
  evaluationGraceMinutes: 10,
  publicCacheSeconds: 10,
  clusterWindowMinutes: 30,
  clusterMinCustomers: 3,
}

export const rulesSchema = z
  .object({
    maxSellableAge: z.number().int().min(1).max(30),
    retireAge: z.number().int().min(1).max(31),
    cutoffHourIST: z.number().int().min(0).max(23),
    maxDaysAhead: z.number().int().min(1).max(30),
    holdMinutes: z.number().int().min(1).max(60),
    quoteMinutes: z.number().int().min(1).max(60),
    forecastConfidence: z.number().min(0).max(1),
    maxQcShift: z.number().int().min(0).max(3),
    transitDays: z.number().int().min(0).max(10),
    nearLimitAge: z.number().int().min(0),
    lowStockThreshold: z.number().int().min(0),
    claimWindowHours: z.number().int().min(1),
    stageProfiles: z.record(profile).refine((p) => 'default' in p, 'a "default" profile is required'),
    unlock: unlockSettingsSchema.default(DEFAULT_UNLOCK),
  })
  .strict()
  .refine((r) => r.retireAge > r.maxSellableAge, { message: 'retireAge must be greater than maxSellableAge' })

/** Playbook defaults: raw at 3, semi-ripe 4–5, ripe 6–7, retired at 8. */
export const DEFAULT_RULES = {
  maxSellableAge: 7,
  retireAge: 8,
  cutoffHourIST: 18,
  maxDaysAhead: 5,
  holdMinutes: 10,
  quoteMinutes: 5,
  forecastConfidence: 0.85,
  maxQcShift: 1,
  transitDays: 2,
  nearLimitAge: 5,
  lowStockThreshold: 5,
  claimWindowHours: 24,
  stageProfiles: {
    default: [
      { stage: 'RAW', minAge: 3, maxAge: 3 },
      { stage: 'SEMI_RIPE', minAge: 4, maxAge: 5 },
      { stage: 'RIPE', minAge: 6, maxAge: 7 },
    ],
  },
  unlock: DEFAULT_UNLOCK,
}

let live = { version: 0, rules: DEFAULT_RULES }

export const getConfig = () => live.rules
export const configVersion = () => live.version
export const currentConfig = () => live

/** Loads the live version, creating version 1 from the defaults on a fresh database. */
export async function loadConfig() {
  await query(
    `INSERT INTO app_config (version, value, changed_by) VALUES (1, $1, 'system') ON CONFLICT DO NOTHING`,
    [DEFAULT_RULES],
  )
  const { rows } = await query('SELECT version, value FROM app_config ORDER BY version DESC LIMIT 1')
  live = { version: rows[0].version, rules: rulesSchema.parse(rows[0].value) }
  return live
}

/** Saves a new version. `rules` must already be validated. */
export async function saveConfig(rules, actor) {
  const version = await tx(async (c) => {
    await c.query('LOCK TABLE app_config IN EXCLUSIVE MODE')
    const { rows } = await c.query('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM app_config')
    await c.query('INSERT INTO app_config (version, value, changed_by) VALUES ($1, $2, $3)', [rows[0].v, rules, actor])
    return rows[0].v
  })
  live = { version, rules }
  return live
}
