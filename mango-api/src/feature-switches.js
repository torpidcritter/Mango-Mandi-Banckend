// Feature switches managers may change on the panel's Settings page
// (PANEL_FEATURE_SWITCHES, docs/ops.md).
//
// The effective value of an allowlisted switch:
//   1. the environment sets it to false: off. The environment is a ceiling, a kill switch
//      nobody on the panel can overrule;
//   2. otherwise a manager's override (the feature_switches table), when there is one;
//   3. otherwise the environment's own value (its default when unset).
// With PANEL_FEATURE_SWITCHES off, or for any switch not listed here, it is the
// environment's value and nothing else.
//
// Overrides are read through a short per-instance cache (SWITCH_CACHE_MS): every
// API instance re-reads the table at most that long after a change, so a switch
// takes effect everywhere within about 30 seconds. The instance that saved the
// change forgets its cache at once.
import { now } from './clock.js'
import { query } from './db.js'
import { env, isProd } from './env.js'
import { HttpError } from './errors.js'
import { logger } from './logger.js'
import { trust } from './trust-config.js'

/**
 * The only switches the panel may change: customer-facing features that are safe to turn on
 * or off at any moment. One entry per switch; add yours here (key, label, description).
 * Security, payment, refund and inventory-safety switches never go in this list
 * (NEVER_FROM_PANEL below, checked when this file loads and by test/ops.test.js).
 */
export const PANEL_SWITCHES = [
  { key: 'FAVOURITES', label: 'Favourites', description: 'Hearts on the shop’s boxes and a Favourites list on the Account page.' },
  { key: 'SHOP_SORT_FILTER', label: 'Sort and filter', description: 'Sort and filter controls on the shop’s home page.' },
  { key: 'SHOP_INSTALL', label: 'Install app', description: 'The shop offers “Install app” and keeps its app shell for quick starts.' },
  { key: 'LIVE_TRACKING', label: 'Live tracking', description: '“Your rider is N stops away” on the shop’s order page, and the riders’ Route view on Deliveries.' },
  { key: 'BILLS_ENABLED', label: 'Bills', description: 'Numbered bills for paid orders (PDF in the shop and the panel) and the business name and GSTIN at checkout.' },
  { key: 'REFERRALS', label: 'Referrals', description: 'Customers share a code and both get the referral reward.' },
  { key: 'FUNNEL_ANALYTICS', label: 'Shop funnel', description: 'Counts how many visitors reach each step from the home page to paying.' },
  { key: 'MANAGER_DAILY_SUMMARY', label: 'Daily summary', description: 'A WhatsApp message to managers each evening with the day’s numbers.' },
  { key: 'STOCK_FORECAST', label: 'Stock forecast', description: 'The “boxes to buy” suggestion on the Planning page (managers).' },
  { key: 'PURCHASE_RECORDS', label: 'Farms and purchases', description: 'Farms, what each batch cost, and margins (costs are for managers only).' },
  { key: 'HELP_CENTRE', label: 'Help centre', description: 'Customers ask for help from an order or the Help page; staff answer on the Help desk.' },
  { key: 'SUBSCRIPTIONS', label: 'Subscriptions', description: 'A box every week or fortnight in the season, each one paid for as a normal order (no auto-debit).' },
  { key: 'MULTI_GIFT', label: 'Gifts to many addresses', description: 'One order can send gift boxes to several addresses.' },
  { key: 'SHOP_LANGUAGES', label: 'Shop languages', description: 'Customers can read the shop in another language.' },
  { key: 'FARM_EXPERIENCE', label: 'Farm Experience', description: 'Farm visits with 250 kg or more of mangoes in Bulk Deals, and the panel’s farm pages. Customers can book only once Farm Settings opens bookings.' },
  { key: 'PARTNER_NETWORK', label: 'Partner With Us', description: 'The shop’s Partner With Us page and enquiry form, and the panel’s Partner Network section.' },
]

/**
 * Switches that protect money, stock, sign-in or customers' data. None of them is ever
 * changed from the panel: a stolen manager session must not be able to turn a safeguard off.
 */
export const NEVER_FROM_PANEL = [
  'PANEL_FEATURE_SWITCHES', 'STAFF_STEP_UP', 'STAFF_AUDIT_TRAIL', 'STAFF_TWO_STEP', 'API_HARDENING', 'PROVIDER_CHECKS', 'OPS_ALERTS',
  'DELIVERY_CHECKS', 'REFUND_SAFETY_CHECKS', 'PAYMENT_DAILY_RECON', 'ORDER_RULE_CHECKS', 'STOCK_INTAKE_CHECKS', 'ENABLE_DEV_ROUTES',
  'SHOW_ERROR_DETAILS', 'OTP_CODE_IN_RESPONSE', 'LOG_OTP_CODES', 'CUSTOMER_PROFILES_ENABLED', 'STAFF_EXPORTS_ENABLED', 'WAREHOUSE_V2',
  'WAREHOUSE_STOCKTAKE', 'WAREHOUSE_REPACK', 'WAREHOUSE_CAMERA_SCAN', 'WEB_PUSH', 'WHATSAPP_REVIEW_REQUESTS', 'WHATSAPP_CLAIM_UPDATES',
  'WHATSAPP_ORDER_LINKS', 'BACKUP_HEARTBEAT_EXPECTED', 'SEED_DEMO_DATA', 'COOKIE_SECURE',
]

const bad = PANEL_SWITCHES.filter((s) => NEVER_FROM_PANEL.includes(s.key) || !/^[A-Z][A-Z0-9_]{1,63}$/.test(s.key))
if (bad.length) throw new Error(`These switches may not be changed from the panel: ${bad.map((s) => s.key).join(', ')}`)

const BY_KEY = new Map(PANEL_SWITCHES.map((s) => [s.key, s]))

/** How long an instance trusts the overrides it read. */
export const SWITCH_CACHE_MS = 30_000

let cache = { at: -Infinity, rows: new Map() }
let loading = null

/** The environment wrote false for this switch: off, whatever the panel says. */
export const killedByEnv = (key) => String(process.env[key] ?? '').trim().toLowerCase() === 'false'

/** The value without any override: the environment's (bills: trust-config.js, on outside production unless set). */
export function envValue(key) {
  if (key === 'BILLS_ENABLED') return Boolean(trust.bills)
  if (Object.hasOwn(env, key)) return env[key] === true
  return String(process.env[key] ?? '').trim().toLowerCase() === 'true'
}

/** A switch this build reads (others' switches are listed ahead of the release that adds them). */
export const knownSwitch = (key) => BY_KEY.has(key) && (key === 'BILLS_ENABLED' || Object.hasOwn(env, key))

export const switchable = (key) => BY_KEY.has(key)

/**
 * Re-reads the overrides when the cache is older than SWITCH_CACHE_MS (or `force`).
 * Called before every request (app.js) and every maintenance run, so the
 * synchronous isOn() below always has a recent answer. Nothing to do while
 * PANEL_FEATURE_SWITCHES is off.
 */
export async function refreshSwitches({ force = false } = {}) {
  if (!env.PANEL_FEATURE_SWITCHES) return
  if (!force && now().getTime() - cache.at < SWITCH_CACHE_MS) return
  loading ??= query('SELECT key, enabled, updated_by, updated_at FROM feature_switches')
    .then(({ rows }) => {
      cache = { at: now().getTime(), rows: new Map(rows.filter((r) => BY_KEY.has(r.key)).map((r) => [r.key, r])) }
    })
    .finally(() => {
      loading = null
    })
  await loading
}

/** Drops this instance's cache (after a save here, and in tests). */
export function forgetSwitches() {
  cache = { at: -Infinity, rows: new Map() }
}

/** Bills turned on from the panel still need the seller's details in production (preflight checks the env). */
const billsBlocked = () => isProd && trust.seller.placeholder

/** The switch's effective value (see the top of this file). Synchronous: reads the cache. */
export function isOn(key) {
  const base = envValue(key)
  if (!env.PANEL_FEATURE_SWITCHES || !BY_KEY.has(key)) return base
  if (killedByEnv(key)) return false
  const row = cache.rows.get(key)
  if (!row) return base
  if (key === 'BILLS_ENABLED' && row.enabled && billsBlocked()) return false
  return row.enabled
}

/** The Settings page's list: every switch this build reads, with where its value comes from. */
export function switchList() {
  return PANEL_SWITCHES.filter((s) => knownSwitch(s.key)).map((s) => {
    const row = cache.rows.get(s.key)
    return {
      key: s.key,
      label: s.label,
      description: s.description,
      envValue: envValue(s.key),
      killedByEnv: killedByEnv(s.key),
      override: row ? row.enabled : null,
      updatedBy: row?.updated_by ?? null,
      updatedAt: row?.updated_at ?? null,
      effective: isOn(s.key),
    }
  })
}

/** Why this change would not take effect (an HttpError), or null. Turning off or clearing is always allowed. */
export function switchRefusal(key, enabled) {
  if (enabled !== true) return null
  if (killedByEnv(key)) {
    return new HttpError(409, 'ENV_KILL_SWITCH', `${key} is set to false on the server, which always wins. Change it there to turn it on.`)
  }
  if (key === 'BILLS_ENABLED' && billsBlocked()) {
    return new HttpError(409, 'BILLS_NOT_CONFIGURED', 'Bills need the seller’s legal name, address and state code set on the server first (docs/trust.md).')
  }
  return null
}

/**
 * Saves (or, with enabled null, removes) a manager's override inside the caller's
 * transaction. Refuses what would not take effect (switchRefusal), so the page never
 * shows a change that did nothing. Returns the effective value before and the old override.
 */
export async function saveSwitch(c, key, enabled, who) {
  const refused = switchRefusal(key, enabled)
  if (refused) throw refused
  const before = isOn(key)
  const prev = (await c.query('SELECT enabled FROM feature_switches WHERE key = $1 FOR UPDATE', [key])).rows[0]?.enabled ?? null
  if (enabled === null) await c.query('DELETE FROM feature_switches WHERE key = $1', [key])
  else {
    await c.query(
      `INSERT INTO feature_switches (key, enabled, updated_by, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [key, enabled, who, now()],
    )
  }
  logger.info({ key, override: enabled }, 'feature switch changed')
  return { before, previousOverride: prev }
}
