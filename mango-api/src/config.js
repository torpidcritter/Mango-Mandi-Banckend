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

const rulesFields = z.object({
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
  // Unpaid orders one customer may have waiting at once, and the boxes they
  // may hold across them (INV-02). Older rule versions get the defaults.
  maxUnpaidOrders: z.number().int().min(1).max(5).default(1),
  maxHeldBoxes: z.number().int().min(1).max(500).default(40),
  // Needs attention (INV-G, INV-H): an order out for delivery this long is
  // overdue; a preorder moved more than this many weeks, or booked past the
  // season's last day, waits for a manager's decision.
  outForDeliveryAlertHours: z.number().int().min(1).max(48).default(8),
  maxPreorderMoves: z.number().int().min(1).max(20).default(3),
  seasonEndsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)').nullable().default(null),
  stageProfiles: z.record(z.string(), profile).refine((p) => 'default' in p, 'a "default" profile is required'),
})
const retireAfterSellable = [(r) => r.retireAge > r.maxSellableAge, { message: 'retireAge must be greater than maxSellableAge' }]

/** What a manager may save: unknown keys are a typo and are refused. */
export const rulesSchema = rulesFields.strict().refine(...retireAfterSellable)

/**
 * What the API reads back. Unknown keys are dropped, not refused, so a rollback
 * to this release still starts after a newer release saved rules with keys this
 * one doesn't know (PLT-01). Missing keys take their defaults, as before.
 */
export const storedRulesSchema = rulesFields.strip().refine(...retireAfterSellable)

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
  maxUnpaidOrders: 1,
  maxHeldBoxes: 40,
  outForDeliveryAlertHours: 8,
  maxPreorderMoves: 3,
  seasonEndsOn: null,
  stageProfiles: {
    default: [
      { stage: 'RAW', minAge: 3, maxAge: 3 },
      { stage: 'SEMI_RIPE', minAge: 4, maxAge: 5 },
      { stage: 'RIPE', minAge: 6, maxAge: 7 },
    ],
  },
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
  live = { version: rows[0].version, rules: storedRulesSchema.parse(rows[0].value) }
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
