// /admin/v1 routes for Neighborhood Unlock: zones, campaigns, weekly
// templates and the feature switch. Mounted inside the admin router, after
// sign-in, the role allowlist and the staff audit, so MANAGER and OPERATOR
// can use them, PACKER, QC and RIDER can't (access.js lists none of these
// for them), and every change lands in staff_audit.
import express from 'express'
import { z } from 'zod'
import { requireManager } from './auth.js'
import { isDate, now } from './clock.js'
import { currentConfig, saveConfig, unlockSettingsSchema } from './config.js'
import { query, tx } from './db.js'
import { asyncHandler, badRequest, conflict, notFound, parse } from './errors.js'
import { newId } from './ids.js'
import {
  CAMPAIGN_SELECT, CAMPAIGN_STATUSES, REWARD_TYPES, cancelCampaign, clustersFor, createCampaign, currentFor, forecastFor, openCampaign,
  staffView, updateDraft,
} from './unlock.js'

export const router = express.Router()

const PIN = z.string().regex(/^\d{6}$/, 'pincode must be 6 digits')
const DATE = z.string().refine(isDate, 'use YYYY-MM-DD')
const actorOf = (req) => req.admin.email

/** Postgres unique violations become a 409 with our wording. */
const unique = (message, code) => (err) => {
  if (err?.code === '23505') throw conflict(message, code)
  throw err
}

// ---------------------------------------------------------------- zones

async function zoneList(c, id = null) {
  const { rows } = await c.query(
    `SELECT z.*, COALESCE(array_agg(zp.pincode ORDER BY zp.pincode) FILTER (WHERE zp.pincode IS NOT NULL), '{}') AS pincodes,
            (SELECT COUNT(*)::int FROM unlock_campaigns u WHERE u.zone_id = z.id AND u.status IN ('DRAFT', 'OPEN')) AS live_campaigns
       FROM zones z LEFT JOIN zone_pincodes zp ON zp.zone_id = z.id
      WHERE ($1::text IS NULL OR z.id = $1)
      GROUP BY z.id ORDER BY z.active DESC, lower(z.label)`,
    [id],
  )
  return rows.map((z) => ({
    id: z.id, label: z.label, active: z.active, pincodes: z.pincodes, liveCampaigns: z.live_campaigns, createdBy: z.created_by, createdAt: z.created_at,
  }))
}

router.get('/zones', asyncHandler(async (_req, res) => res.json(await zoneList({ query }))))

/**
 * Replaces a zone's pincodes. A pincode already in another zone is refused
 * (naming that zone), and so is one with its own live campaign, which would
 * otherwise count the same customers twice.
 */
async function setPincodes(c, zoneId, pincodes, at) {
  const want = [...new Set(pincodes)].sort()
  if (want.length) {
    const known = await c.query('SELECT pincode FROM pincodes WHERE pincode = ANY($1)', [want])
    const missing = want.filter((p) => !known.rows.some((r) => r.pincode === p))
    if (missing.length) throw badRequest(`Add these pincodes on the Pincodes page first: ${missing.join(', ')}`, 'PINCODE_UNKNOWN')
    const taken = await c.query(
      `SELECT zp.pincode, z.label FROM zone_pincodes zp JOIN zones z ON z.id = zp.zone_id WHERE zp.pincode = ANY($1) AND zp.zone_id <> $2 FOR UPDATE OF zp`,
      [want, zoneId],
    )
    if (taken.rows.length) {
      throw conflict(`Already in another zone: ${taken.rows.map((r) => `${r.pincode} (${r.label})`).join(', ')}`, 'PINCODE_TAKEN')
    }
    const own = await c.query(`SELECT DISTINCT pincode FROM unlock_campaigns WHERE pincode = ANY($1) AND status IN ('DRAFT', 'OPEN')`, [want])
    if (own.rows.length) {
      throw conflict(`These pincodes have their own live campaign: ${own.rows.map((r) => r.pincode).join(', ')}. Cancel it first.`, 'PINCODE_HAS_CAMPAIGN')
    }
  }
  await c.query('DELETE FROM zone_pincodes WHERE zone_id = $1 AND NOT (pincode = ANY($2))', [zoneId, want])
  if (want.length) {
    await c.query(
      `INSERT INTO zone_pincodes (pincode, zone_id, added_at) SELECT p, $2, $3 FROM unnest($1::text[]) AS p ON CONFLICT (pincode) DO NOTHING`,
      [want, zoneId, at],
    )
    // A pincode taken by another zone between the check and the insert.
    const mine = await c.query('SELECT COUNT(*)::int AS n FROM zone_pincodes WHERE zone_id = $1', [zoneId])
    if (mine.rows[0].n !== want.length) throw conflict('Another zone just took one of these pincodes. Reload and try again.', 'PINCODE_TAKEN')
  }
}

router.post(
  '/zones',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ label: z.string().trim().min(2, 'Give the zone a name').max(60), pincodes: z.array(PIN).max(200).default([]) }).strict(), req.body)
    const at = now()
    const id = newId('zon')
    await tx(async (c) => {
      await c
        .query('INSERT INTO zones (id, label, active, created_by, created_at, updated_at) VALUES ($1, $2, TRUE, $3, $4, $4)', [id, b.label, actorOf(req), at])
        .catch(unique('A zone with that name already exists', 'ZONE_EXISTS'))
      await setPincodes(c, id, b.pincodes, at)
    })
    req.params.id = id
    res.status(201).json((await zoneList({ query }, id))[0])
  }),
)

/** Renames a zone, or switches it off (only with no live campaign; its pincodes are released). */
router.patch(
  '/zones/:id',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ label: z.string().trim().min(2).max(60).optional(), active: z.boolean().optional() }).strict(), req.body)
    const id = req.params.id
    await tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM zones WHERE id = $1 FOR UPDATE', [id])
      if (!rows.length) throw notFound('Zone not found')
      if (b.active === false && rows[0].active) {
        const live = await c.query(`SELECT 1 FROM unlock_campaigns WHERE zone_id = $1 AND status IN ('DRAFT', 'OPEN') LIMIT 1`, [id])
        if (live.rowCount) throw conflict('This zone has a live campaign. Cancel it before switching the zone off.', 'ZONE_IN_USE')
        await c.query('DELETE FROM zone_pincodes WHERE zone_id = $1', [id])
      }
      await c
        .query('UPDATE zones SET label = COALESCE($2, label), active = COALESCE($3, active), updated_at = $4 WHERE id = $1', [id, b.label ?? null, b.active ?? null, now()])
        .catch(unique('A zone with that name already exists', 'ZONE_EXISTS'))
    })
    res.json((await zoneList({ query }, id))[0])
  }),
)

router.put(
  '/zones/:id/pincodes',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ pincodes: z.array(PIN).max(200) }).strict(), req.body)
    const id = req.params.id
    await tx(async (c) => {
      const { rows } = await c.query('SELECT active FROM zones WHERE id = $1 FOR UPDATE', [id])
      if (!rows.length) throw notFound('Zone not found')
      if (!rows[0].active) throw conflict('Switch the zone on before giving it pincodes', 'ZONE_INACTIVE')
      await setPincodes(c, id, b.pincodes, now())
      await c.query('UPDATE zones SET updated_at = $2 WHERE id = $1', [id, now()])
    })
    res.json((await zoneList({ query }, id))[0])
  }),
)

// ---------------------------------------------------------------- campaigns

const money = z.number().int().min(0).max(100_000_000)
const rewardFields = {
  rewardType: z.enum(REWARD_TYPES).nullable().optional(),
  rewardValue: z.number().int().positive().max(100_000_000).nullable().optional(),
  rewardBudget: money.nullable().optional(),
}
const campaignBody = z
  .object({
    zoneId: z.string().min(1).optional(),
    pincode: PIN.optional(),
    deliveryDate: DATE,
    slotId: z.string().min(1).nullable().optional(),
    threshold: z.number().int().min(2, 'At least 2 customers').max(10_000),
    minOrderValue: money.default(0),
    orderBy: z.string().datetime({ offset: true }).nullable().optional(),
    ...rewardFields,
  })
  .strict()
  .refine((b) => Boolean(b.zoneId) !== Boolean(b.pincode), 'Choose a zone or one pincode, not both')

async function campaignRow(c, id) {
  const { rows } = await c.query(`${CAMPAIGN_SELECT} WHERE u.id = $1`, [id])
  if (!rows.length) throw notFound('Campaign not found')
  return rows[0]
}

const withCount = async (c, camp) => staffView(camp, await currentFor(c, camp))

router.get(
  '/unlock/campaigns',
  asyncHandler(async (req, res) => {
    const from = isDate(req.query.from) ? req.query.from : null
    const status = CAMPAIGN_STATUSES.includes(req.query.status) ? req.query.status : null
    const { rows } = await query(
      `${CAMPAIGN_SELECT}
        WHERE ($1::date IS NULL OR u.delivery_date >= $1) AND ($2::text IS NULL OR u.status = $2)
        ORDER BY u.delivery_date DESC, z.label NULLS LAST, u.pincode, u.created_at DESC LIMIT 200`,
      [from, status],
    )
    const out = []
    for (const camp of rows) out.push(await withCount({ query }, camp))
    res.json({ enabled: currentConfig().rules.unlock.enabled, campaigns: out })
  }),
)

/** One campaign with its forecast, history and the suspicious-cluster flags. */
router.get(
  '/unlock/campaigns/:id',
  asyncHandler(async (req, res) => {
    const c = { query }
    const camp = await campaignRow(c, req.params.id)
    const view = await withCount(c, camp)
    const live = view.current ?? (await currentFor(c, { ...camp, status: 'OPEN' }))
    const [events, forecast, clusters] = await Promise.all([
      query('SELECT * FROM unlock_events WHERE campaign_id = $1 ORDER BY created_at, id', [camp.id]),
      forecastFor(c, camp, live),
      clustersFor(c, camp),
    ])
    const participants = await query('SELECT COUNT(*)::int AS n FROM unlock_participants WHERE campaign_id = $1', [camp.id])
    res.json({
      ...view,
      forecast,
      clusters,
      snapshotCount: participants.rows[0].n,
      events: events.rows.map((e) => ({ from: e.from_status, to: e.to_status, actor: e.actor, counted: e.counted, note: e.note, at: e.created_at })),
    })
  }),
)

router.post(
  '/unlock/campaigns',
  asyncHandler(async (req, res) => {
    const b = parse(campaignBody, req.body)
    const camp = await tx((c) => createCampaign(c, b, actorOf(req))).catch(unique('This area already has a campaign for that date', 'CAMPAIGN_EXISTS'))
    req.params.id = camp.id
    res.status(201).json(await withCount({ query }, await campaignRow({ query }, camp.id)))
  }),
)

router.patch(
  '/unlock/campaigns/:id',
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({ threshold: z.number().int().min(2).max(10_000).optional(), minOrderValue: money.optional(), orderBy: z.string().datetime({ offset: true }).nullable().optional(), ...rewardFields }).strict(),
      req.body,
    )
    await tx((c) => updateDraft(c, req.params.id, b))
    res.json(await withCount({ query }, await campaignRow({ query }, req.params.id)))
  }),
)

router.post(
  '/unlock/campaigns/:id/open',
  asyncHandler(async (req, res) => {
    await tx((c) => openCampaign(c, req.params.id, actorOf(req)))
    res.json(await withCount({ query }, await campaignRow({ query }, req.params.id)))
  }),
)

router.post(
  '/unlock/campaigns/:id/cancel',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ note: z.string().trim().max(300).optional() }).strict(), req.body ?? {})
    await tx((c) => cancelCampaign(c, req.params.id, actorOf(req), b.note))
    res.json(await withCount({ query }, await campaignRow({ query }, req.params.id)))
  }),
)

// ---------------------------------------------------------------- weekly templates

const templateView = (t) => ({
  id: t.id, zoneIds: t.zone_ids, weekday: t.weekday, slotId: t.slot_id, threshold: t.threshold, minOrderValue: t.min_order_value,
  rewardType: t.reward_type, rewardValue: t.reward_value, rewardBudget: t.reward_budget, autoOpen: t.auto_open, active: t.active,
  createdBy: t.created_by, createdAt: t.created_at,
})

const templateFields = {
  zoneIds: z.array(z.string().min(1)).min(1, 'Choose at least one zone').max(50),
  weekday: z.number().int().min(0).max(6),
  slotId: z.string().min(1).nullable().optional(),
  threshold: z.number().int().min(2).max(10_000),
  minOrderValue: money.default(0),
  autoOpen: z.boolean().default(false),
  ...rewardFields,
}

async function checkTemplateRefs(c, b) {
  if (b.zoneIds) {
    const ids = [...new Set(b.zoneIds)]
    const { rows } = await c.query('SELECT id FROM zones WHERE id = ANY($1) AND active', [ids])
    if (rows.length !== ids.length) throw badRequest('Every zone must exist and be switched on', 'ZONE_INVALID')
    b.zoneIds = ids
  }
  if (b.slotId) {
    const s = await c.query('SELECT 1 FROM delivery_slots WHERE id = $1 AND active', [b.slotId])
    if (!s.rowCount) throw badRequest('That delivery slot is not available', 'SLOT_INVALID')
  }
}

router.get(
  '/unlock/templates',
  asyncHandler(async (_req, res) => {
    const { rows } = await query('SELECT * FROM unlock_templates ORDER BY active DESC, weekday, created_at')
    res.json(rows.map(templateView))
  }),
)

router.post(
  '/unlock/templates',
  asyncHandler(async (req, res) => {
    const b = parse(z.object(templateFields).strict(), req.body)
    await checkTemplateRefs({ query }, b)
    const id = newId('utp')
    const at = now()
    const { rows } = await query(
      `INSERT INTO unlock_templates (id, zone_ids, weekday, slot_id, threshold, min_order_value, reward_type, reward_value, reward_budget,
                                     auto_open, active, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, $11, $12, $12) RETURNING *`,
      [id, b.zoneIds, b.weekday, b.slotId ?? null, b.threshold, b.minOrderValue, b.rewardType ?? null, b.rewardValue ?? null, b.rewardBudget ?? null,
        b.autoOpen, actorOf(req), at],
    )
    req.params.id = id
    res.status(201).json(templateView(rows[0]))
  }),
)

/** Edits apply to campaigns the template makes from now on; ones already made keep theirs. */
router.patch(
  '/unlock/templates/:id',
  asyncHandler(async (req, res) => {
    const fields = Object.fromEntries(Object.entries(templateFields).map(([k, v]) => [k, v instanceof z.ZodDefault ? v.removeDefault().optional() : v.optional()]))
    const b = parse(z.object({ ...fields, active: z.boolean().optional() }).strict(), req.body)
    await checkTemplateRefs({ query }, b)
    const cols = { zoneIds: 'zone_ids', weekday: 'weekday', slotId: 'slot_id', threshold: 'threshold', minOrderValue: 'min_order_value', rewardType: 'reward_type',
      rewardValue: 'reward_value', rewardBudget: 'reward_budget', autoOpen: 'auto_open', active: 'active' }
    const sets = []
    const vals = [req.params.id, now()]
    for (const [k, col] of Object.entries(cols)) {
      if (b[k] === undefined) continue
      vals.push(b[k])
      sets.push(`${col} = $${vals.length}`)
    }
    const { rows } = await query(`UPDATE unlock_templates SET ${[...sets, 'updated_at = $2'].join(', ')} WHERE id = $1 RETURNING *`, vals)
    if (!rows.length) throw notFound('Template not found')
    res.json(templateView(rows[0]))
  }),
)

// ---------------------------------------------------------------- the switch

router.get('/unlock/settings', (_req, res) => res.json(currentConfig().rules.unlock))

/** Saves a new rules version with these Neighborhood Unlock settings. Managers only, like other rules. */
router.put(
  '/unlock/settings',
  requireManager,
  asyncHandler(async (req, res) => {
    const unlock = parse(unlockSettingsSchema, { ...currentConfig().rules.unlock, ...(req.body ?? {}) })
    const saved = await saveConfig({ ...currentConfig().rules, unlock }, req.admin.email)
    res.json({ version: saved.version, ...saved.rules.unlock })
  }),
)
