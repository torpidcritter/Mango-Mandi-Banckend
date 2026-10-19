// Neighborhood Unlock: customers in one zone, ordering for one delivery date,
// together unlock a reward when enough of them have ordered by the order-by
// time. It is a bonus only: a campaign never changes who is delivered to,
// when, or what they paid. Nothing here writes to orders, payments or stock;
// the count is read from orders by one query (countFor), which the public
// progress card, the panel and the evaluation all share, so they always agree.
import { addDays, now, todayIST } from './clock.js'
import { getConfig } from './config.js'
import { query, tx } from './db.js'
import { orderableDates } from './delivery.js'
import { badRequest, conflict, HttpError, notFound } from './errors.js'
import { newId } from './ids.js'
import { logger } from './logger.js'
import { outOfTime } from './budget.js'

export const CAMPAIGN_STATUSES = ['DRAFT', 'OPEN', 'UNLOCKED', 'MISSED', 'CANCELLED']
export const REWARD_TYPES = ['PROMO_FLAT', 'PROMO_PERCENT', 'POINTS', 'FEE_WAIVER']
/** Paid and not cancelled: these order statuses count towards a campaign. */
export const COUNTED_STATUSES = ['CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED']
/** Statuses that hold an area, date and slot (CANCELLED frees them). */
const LIVE = ['DRAFT', 'OPEN']

/** The only moves allowed, as to → from. Every move is one guarded UPDATE. */
const FROM = { OPEN: ['DRAFT'], CANCELLED: ['DRAFT', 'OPEN'], UNLOCKED: ['OPEN'], MISSED: ['OPEN'] }

/** Advisory lock namespace for "creating a campaign for one area and date". */
const AREA_DATE_LOCK = 427714400

export const unlockSettings = () => getConfig().unlock

/** The existing order cutoff for a delivery date: the cutoff hour (IST) the day before. */
export function cutoffFor(date) {
  const h = String(getConfig().cutoffHourIST).padStart(2, '0')
  return new Date(`${addDays(date, -1)}T${h}:00:00+05:30`)
}

export const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay()

// ---------------------------------------------------------------- counting

/**
 * The orders that count for a campaign, as SQL after FROM. Parameters:
 * $1 date, $2 slot, $3 zone, $4 pincode, $5 statuses, $6 minimum paid,
 * $7 order-by (null = no time limit, for the forecast's past weeks).
 *
 * - delivered on that date (in that slot, if the campaign has one), to a
 *   pincode in the zone as it is now (or to the campaign's own pincode);
 * - paid and not cancelled (COUNTED_STATUSES), so any cancel drops out;
 * - not a free replacement, and paid at least the minimum (after promo);
 * - placed by the order-by time. Orders moved onto the date later by the
 *   system (a retry, a late payment) were placed before it, so they count.
 * Gift orders go by the recipient's pincode and count for the buyer.
 */
const COUNTED_ORDERS = `orders o LEFT JOIN customers cu ON cu.id = o.customer_id
  WHERE o.delivery_date = $1
    AND ($2::text IS NULL OR o.slot_id = $2)
    AND (CASE WHEN $3::text IS NOT NULL THEN o.pincode IN (SELECT zp.pincode FROM zone_pincodes zp WHERE zp.zone_id = $3)
              ELSE o.pincode = $4 END)
    AND o.status = ANY($5)
    AND o.replacement_for IS NULL
    AND o.customer_id IS NOT NULL
    AND o.total >= $6
    AND ($7::timestamptz IS NULL OR o.placed_at <= $7)`

/** One customer, one count: accounts are joined on their phone (unique today), else the account. */
const PERSON = 'COALESCE(cu.phone, o.customer_id)'

const params = (camp, { date = camp.delivery_date, limitToOrderBy = true } = {}) => [
  date, camp.slot_id ?? null, camp.zone_id ?? null, camp.pincode ?? null, COUNTED_STATUSES, camp.min_order_value ?? 0,
  limitToOrderBy ? camp.order_by : null,
]

/** Unique customers who count for the campaign right now. */
export async function countFor(c, camp, opts) {
  const { rows } = await c.query(`SELECT COUNT(DISTINCT ${PERSON})::int AS n FROM ${COUNTED_ORDERS}`, params(camp, opts))
  return rows[0].n
}

/** Who counts, one row per person with their first qualifying order. */
export async function participantsFor(c, camp) {
  const { rows } = await c.query(
    `SELECT DISTINCT ON (${PERSON}) o.customer_id, o.id AS order_id FROM ${COUNTED_ORDERS}
      ORDER BY ${PERSON}, o.placed_at, o.id`,
    params(camp),
  )
  return rows
}

// ---------------------------------------------------------------- status machine

/**
 * Moves a campaign to `to` in one guarded UPDATE: it only happens if the
 * campaign is still in a status that may move there, so two staff clicks or
 * two maintenance runs can never both move it. Writes the unlock_events row.
 */
export async function moveStatus(c, id, to, { actor, counted = null, note = null, at = now() }) {
  const { rows } = await c.query(
    `UPDATE unlock_campaigns u SET status = $2::text, updated_at = $3,
            counted = COALESCE($4, u.counted), note = COALESCE($5, u.note),
            opened_at = CASE WHEN $2::text = 'OPEN' THEN $3 ELSE u.opened_at END,
            evaluated_at = CASE WHEN $2::text IN ('UNLOCKED', 'MISSED') THEN $3 ELSE u.evaluated_at END
       FROM (SELECT id, status FROM unlock_campaigns WHERE id = $1 FOR UPDATE) old
      WHERE u.id = old.id AND u.status = ANY($6)
      RETURNING u.*, old.status AS from_status`,
    [id, to, at, counted, note, FROM[to]],
  )
  if (!rows.length) {
    const cur = await c.query('SELECT status FROM unlock_campaigns WHERE id = $1', [id])
    if (!cur.rows.length) throw notFound('Campaign not found')
    throw conflict(`This campaign is ${cur.rows[0].status.toLowerCase()} and cannot be moved to ${to.toLowerCase()}`, 'CAMPAIGN_STATE')
  }
  const r = rows[0]
  await c.query(
    `INSERT INTO unlock_events (id, campaign_id, from_status, to_status, actor, counted, note, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [newId('uev'), id, r.from_status, to, actor, counted, note, at],
  )
  return r
}

// ---------------------------------------------------------------- campaigns

const isClosed = async (c, date) => (await c.query('SELECT 1 FROM delivery_calendar WHERE date = $1 AND NOT is_open', [date])).rowCount > 0

/** The zone a pincode belongs to (active zones only), or null. */
export async function zoneOf(c, pincode) {
  const { rows } = await c.query(
    `SELECT z.id, z.label FROM zone_pincodes zp JOIN zones z ON z.id = zp.zone_id AND z.active WHERE zp.pincode = $1`,
    [pincode],
  )
  return rows[0] ?? null
}

/**
 * Creates a DRAFT campaign. `b` is validated by the route: zoneId or pincode,
 * deliveryDate, slotId, threshold, minOrderValue, reward fields, orderBy.
 * The order-by time defaults to the date's cutoff and may be earlier, never
 * later. A campaign never opens a closed day or adds capacity: it only reads.
 */
export async function createCampaign(c, b, actor, at = now()) {
  if (b.zoneId) {
    const z = await c.query('SELECT active FROM zones WHERE id = $1', [b.zoneId])
    if (!z.rows.length || !z.rows[0].active) throw badRequest('That zone does not exist or is switched off', 'ZONE_INVALID')
  } else {
    const p = await c.query('SELECT active FROM pincodes WHERE pincode = $1', [b.pincode])
    if (!p.rows.length || !p.rows[0].active) throw badRequest('We do not deliver to that pincode', 'NOT_SERVICEABLE')
    const zone = await zoneOf(c, b.pincode)
    if (zone) throw conflict(`${b.pincode} is in the ${zone.label} zone: make the campaign for the zone`, 'PINCODE_IN_ZONE')
  }
  if (b.deliveryDate <= todayIST(at)) throw badRequest('Choose a delivery date after today', 'INVALID_DATE')
  if (await isClosed(c, b.deliveryDate)) throw conflict(`Deliveries are closed on ${b.deliveryDate}`, 'DATE_CLOSED')
  if (b.slotId) {
    const s = await c.query('SELECT active FROM delivery_slots WHERE id = $1', [b.slotId])
    if (!s.rows.length || !s.rows[0].active) throw badRequest('That delivery slot is not available', 'SLOT_INVALID')
  }
  const cutoff = cutoffFor(b.deliveryDate)
  const orderBy = b.orderBy ? new Date(b.orderBy) : cutoff
  if (orderBy > cutoff) throw badRequest(`The order-by time can't be after the order cutoff (${cutoff.toISOString()})`, 'ORDER_BY_TOO_LATE')
  if (orderBy <= at) throw badRequest('The order-by time has already passed', 'ORDER_BY_PAST')

  const area = b.zoneId ?? `pin:${b.pincode}`
  // Serialises campaign creation per area and date, so the check below and
  // the insert can't race. A whole-day campaign and a slot campaign on the
  // same area and date would count the same customers twice: one or the other.
  await c.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [AREA_DATE_LOCK, `${area}|${b.deliveryDate}`])
  const { rows: taken } = await c.query(
    `SELECT slot_id FROM unlock_campaigns WHERE COALESCE(zone_id, 'pin:' || pincode) = $1 AND delivery_date = $2 AND status <> 'CANCELLED'`,
    [area, b.deliveryDate],
  )
  if (taken.some((t) => t.slot_id == null || b.slotId == null || t.slot_id === b.slotId)) {
    throw conflict('This area already has a campaign for that date', 'CAMPAIGN_EXISTS')
  }
  const id = newId('unl')
  const { rows } = await c.query(
    `INSERT INTO unlock_campaigns (id, zone_id, pincode, delivery_date, slot_id, threshold, min_order_value, reward_type, reward_value,
                                   reward_budget, order_by, status, template_id, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'DRAFT', $12, $13, $14, $14) RETURNING *`,
    [id, b.zoneId ?? null, b.zoneId ? null : b.pincode, b.deliveryDate, b.slotId ?? null, b.threshold, b.minOrderValue ?? 0,
      b.rewardType ?? null, b.rewardValue ?? null, b.rewardBudget ?? null, orderBy, b.templateId ?? null, actor, at],
  )
  await c.query(
    `INSERT INTO unlock_events (id, campaign_id, from_status, to_status, actor, created_at) VALUES ($1, $2, NULL, 'DRAFT', $3, $4)`,
    [newId('uev'), id, actor, at],
  )
  return rows[0]
}

/** Edits a DRAFT. Once OPEN the numbers customers see never change: cancel and make a new one. */
export async function updateDraft(c, id, b, at = now()) {
  const { rows } = await c.query('SELECT * FROM unlock_campaigns WHERE id = $1 FOR UPDATE', [id])
  const camp = rows[0]
  if (!camp) throw notFound('Campaign not found')
  if (camp.status !== 'DRAFT') throw conflict('Only a draft can be edited. Cancel this campaign and create a new one.', 'CAMPAIGN_STATE')
  let orderBy = camp.order_by
  if (b.orderBy !== undefined) {
    const cutoff = cutoffFor(camp.delivery_date)
    orderBy = b.orderBy ? new Date(b.orderBy) : cutoff
    if (orderBy > cutoff) throw badRequest(`The order-by time can't be after the order cutoff (${cutoff.toISOString()})`, 'ORDER_BY_TOO_LATE')
    if (orderBy <= at) throw badRequest('The order-by time has already passed', 'ORDER_BY_PAST')
  }
  const pick = (k, col) => (b[k] !== undefined ? b[k] : camp[col])
  const { rows: out } = await c.query(
    `UPDATE unlock_campaigns SET threshold = $2, min_order_value = $3, reward_type = $4, reward_value = $5, reward_budget = $6,
            order_by = $7, updated_at = $8
      WHERE id = $1 AND status = 'DRAFT' RETURNING *`,
    [id, pick('threshold', 'threshold'), pick('minOrderValue', 'min_order_value'), pick('rewardType', 'reward_type'),
      pick('rewardValue', 'reward_value'), pick('rewardBudget', 'reward_budget'), orderBy, at],
  )
  if (!out.length) throw conflict('Only a draft can be edited', 'CAMPAIGN_STATE')
  return out[0]
}

/** DRAFT → OPEN: customers start seeing it (when the feature is on). */
export async function openCampaign(c, id, actor, at = now()) {
  const { rows } = await c.query('SELECT * FROM unlock_campaigns WHERE id = $1 FOR UPDATE', [id])
  const camp = rows[0]
  if (!camp) throw notFound('Campaign not found')
  if (camp.status === 'DRAFT') {
    if (camp.order_by <= at) throw conflict('The order-by time has already passed', 'ORDER_BY_PAST')
    if (await isClosed(c, camp.delivery_date)) throw conflict(`Deliveries are closed on ${camp.delivery_date}`, 'DATE_CLOSED')
  }
  return moveStatus(c, id, 'OPEN', { actor, at })
}

export const cancelCampaign = (c, id, actor, note, at = now()) => moveStatus(c, id, 'CANCELLED', { actor, note: note || null, at })

// ---------------------------------------------------------------- evaluation

/**
 * Judges one campaign, in the caller's transaction. The row is taken with
 * SKIP LOCKED: a second run that reaches it at the same moment gets nothing
 * and moves on; one that comes later finds it no longer OPEN. The snapshot of
 * who counted and the status change commit together or not at all.
 * Returns the new status, or null when there was nothing to do.
 */
export async function evaluateCampaign(c, id, at = now()) {
  const { rows } = await c.query('SELECT * FROM unlock_campaigns WHERE id = $1 FOR UPDATE SKIP LOCKED', [id])
  const camp = rows[0]
  if (!camp || camp.order_by > at) return null
  if (camp.status === 'DRAFT') {
    await moveStatus(c, id, 'CANCELLED', { actor: 'system', note: 'Never opened before the order-by time', at })
    return 'CANCELLED'
  }
  if (camp.status !== 'OPEN') return null
  if (await isClosed(c, camp.delivery_date)) {
    // Orders on a closed day are moved by the usual rules; the campaign just ends.
    await moveStatus(c, id, 'CANCELLED', { actor: 'system', note: 'Delivery day closed', at })
    return 'CANCELLED'
  }
  const people = await participantsFor(c, camp)
  if (people.length) {
    await c.query(
      `INSERT INTO unlock_participants (id, campaign_id, customer_id, order_id, counted_at)
       SELECT p.id, $1, p.customer_id, p.order_id, $5
         FROM unnest($2::text[], $3::text[], $4::text[]) AS p (id, customer_id, order_id)
       ON CONFLICT (campaign_id, customer_id) DO NOTHING`,
      [id, people.map(() => newId('upt')), people.map((p) => p.customer_id), people.map((p) => p.order_id), at],
    )
  }
  const to = people.length >= camp.threshold ? 'UNLOCKED' : 'MISSED'
  await moveStatus(c, id, to, { actor: 'system', counted: people.length, at })
  logger.info({ campaignId: id, counted: people.length, threshold: camp.threshold, status: to }, 'unlock campaign evaluated')
  return to
}

/**
 * Maintenance: judges every campaign past its order-by time plus the grace
 * minutes (DRAFTs past it are cancelled). Each campaign is its own short
 * transaction. Stops when the run's time is short and the next run carries
 * on. One campaign failing doesn't hold up the rest; the step still fails,
 * so it shows on the Needs attention card.
 */
export async function evaluateDueCampaigns(at = now()) {
  const grace = unlockSettings().evaluationGraceMinutes
  const { rows } = await query(
    `SELECT id FROM unlock_campaigns
      WHERE (status = 'OPEN' AND order_by + make_interval(mins => $2) <= $1) OR (status = 'DRAFT' AND order_by <= $1)
      ORDER BY order_by, id LIMIT 200`,
    [at, grace],
  )
  const out = { evaluated: 0, failed: 0 }
  let firstError = null
  for (const { id } of rows) {
    if (outOfTime(2_000)) return { partial: true, ...out }
    try {
      if (await tx((c) => evaluateCampaign(c, id, at))) out.evaluated++
    } catch (err) {
      out.failed++
      firstError ??= err
      logger.error({ err, campaignId: id }, 'unlock campaign evaluation failed')
    }
  }
  if (firstError) throw new Error(`${out.failed} campaign evaluation(s) failed: ${firstError.message}`)
  return out
}

// ---------------------------------------------------------------- templates

/**
 * Maintenance: for each active template, creates the campaign for every
 * matching weekday customers can book right now, once. A campaign a template
 * already made for that zone and date (even one staff cancelled) is never
 * made again. Creation goes through createCampaign, so closed days, slots and
 * the one-campaign rule are checked the same way as by hand.
 */
export async function runTemplates(at = now()) {
  const { rows: tpls } = await query('SELECT * FROM unlock_templates WHERE active ORDER BY created_at, id')
  if (!tpls.length) return { created: 0 }
  const dates = await orderableDates({ query }, at)
  let created = 0
  for (const t of tpls) {
    for (const date of dates.filter((d) => weekdayOf(d) === t.weekday)) {
      for (const zoneId of t.zone_ids) {
        if (outOfTime(2_000)) return { partial: true, created }
        const made = await tx(async (c) => {
          const seen = await c.query('SELECT 1 FROM unlock_campaigns WHERE template_id = $1 AND zone_id = $2 AND delivery_date = $3', [t.id, zoneId, date])
          if (seen.rowCount) return false
          try {
            const camp = await createCampaign(c, {
              zoneId, deliveryDate: date, slotId: t.slot_id, threshold: t.threshold, minOrderValue: t.min_order_value,
              rewardType: t.reward_type, rewardValue: t.reward_value, rewardBudget: t.reward_budget, templateId: t.id,
            }, 'system', at)
            if (t.auto_open) await moveStatus(c, camp.id, 'OPEN', { actor: 'system', note: 'Opened by its weekly template', at })
            return true
          } catch (err) {
            if (!(err instanceof HttpError)) throw err
            logger.info({ templateId: t.id, zoneId, date, code: err.code }, 'weekly template skipped a date')
            return false
          }
        })
        if (made) created++
      }
    }
  }
  return { created }
}

// ---------------------------------------------------------------- views, forecast, clusters

/** Live count for DRAFT/OPEN, the recorded count once judged. */
export async function currentFor(c, camp) {
  if (LIVE.includes(camp.status)) return countFor(c, camp)
  return camp.counted
}

/** What anyone may see: counts only, never who. */
export function publicView(camp, current) {
  return {
    zoneLabel: camp.zone_label ?? `Pincode ${camp.pincode}`,
    slotLabel: camp.slot_label ?? null,
    deliveryDate: camp.delivery_date,
    current,
    threshold: camp.threshold,
    remaining: Math.max(0, camp.threshold - (current ?? 0)),
    closesAt: camp.order_by,
    status: camp.status,
  }
}

export function staffView(camp, current) {
  return {
    id: camp.id,
    zoneId: camp.zone_id,
    pincode: camp.pincode,
    zoneLabel: camp.zone_label ?? `Pincode ${camp.pincode}`,
    deliveryDate: camp.delivery_date,
    slotId: camp.slot_id,
    slotLabel: camp.slot_label ?? null,
    threshold: camp.threshold,
    minOrderValue: camp.min_order_value,
    rewardType: camp.reward_type,
    rewardValue: camp.reward_value,
    rewardBudget: camp.reward_budget,
    orderBy: camp.order_by,
    status: camp.status,
    current,
    remaining: current == null ? null : Math.max(0, camp.threshold - current),
    counted: camp.counted,
    openedAt: camp.opened_at,
    evaluatedAt: camp.evaluated_at,
    note: camp.note,
    templateId: camp.template_id,
    createdBy: camp.created_by,
    createdAt: camp.created_at,
  }
}

/** Campaign rows with their zone and slot labels. */
export const CAMPAIGN_SELECT = `SELECT u.*, z.label AS zone_label, s.label AS slot_label
  FROM unlock_campaigns u LEFT JOIN zones z ON z.id = u.zone_id LEFT JOIN delivery_slots s ON s.id = u.slot_id`

/** Live campaigns customers can see for a pincode and date (when the feature is on). */
export async function progressFor(c, pincode, date) {
  const zone = await zoneOf(c, pincode)
  const { rows } = await c.query(
    `${CAMPAIGN_SELECT}
      WHERE u.delivery_date = $1 AND u.status IN ('OPEN', 'UNLOCKED', 'MISSED')
        AND (u.zone_id = $2 OR (u.zone_id IS NULL AND u.pincode = $3))
      ORDER BY s.sort NULLS FIRST, s.starts_at NULLS FIRST, u.id`,
    [date, zone?.id ?? null, pincode],
  )
  const out = []
  for (const camp of rows) out.push(publicView(camp, await currentFor(c, camp)))
  return out
}

/**
 * A rough forecast for staff: the pace since the campaign opened carried to
 * the order-by time, beside the customers the same area had on the last three
 * same weekdays (same rules, current zone). An estimate, labelled as one.
 */
export async function forecastFor(c, camp, current, at = now()) {
  let projected = null
  if (camp.status === 'OPEN' && camp.opened_at) {
    const hoursOpen = (at - camp.opened_at) / 3_600_000
    const hoursLeft = Math.max(0, (camp.order_by - at) / 3_600_000)
    if (hoursOpen >= 1) projected = Math.round(current + (current / hoursOpen) * hoursLeft)
  }
  const recent = []
  for (const weeks of [1, 2, 3]) {
    const date = addDays(camp.delivery_date, -7 * weeks)
    recent.push({ date, customers: await countFor(c, camp, { date, limitToOrderBy: false }) })
  }
  const recentAverage = Math.round(recent.reduce((s, r) => s + r.customers, 0) / recent.length)
  return { projected, recentSameWeekday: recent, recentAverage }
}

/**
 * Possible gaming, for staff to look at (nothing is blocked): counted orders
 * where several customers share one delivery address, or where several
 * orders from one address landed within minutes, or one phone on orders from
 * different accounts.
 */
export async function clustersFor(c, camp) {
  const { clusterWindowMinutes: win, clusterMinCustomers: min } = unlockSettings()
  const p = params(camp)
  const addr = await c.query(
    `SELECT COUNT(DISTINCT ${PERSON})::int AS customers, COUNT(*)::int AS orders,
            array_agg(o.number ORDER BY o.placed_at) AS numbers, MIN(o.placed_at) AS first_at, MAX(o.placed_at) AS last_at
       FROM ${COUNTED_ORDERS} AND o.delivery_address IS NOT NULL
      GROUP BY lower(regexp_replace(o.delivery_address, '[^a-zA-Z0-9]', '', 'g'))
     HAVING COUNT(DISTINCT ${PERSON}) >= $8
         OR (COUNT(*) >= $8 AND MAX(o.placed_at) - MIN(o.placed_at) <= make_interval(mins => $9))`,
    [...p, min, win],
  )
  const phone = await c.query(
    `SELECT COUNT(DISTINCT o.customer_id)::int AS customers, COUNT(*)::int AS orders, array_agg(o.number ORDER BY o.placed_at) AS numbers,
            MIN(o.placed_at) AS first_at, MAX(o.placed_at) AS last_at
       FROM ${COUNTED_ORDERS} AND o.phone IS NOT NULL AND o.phone <> ''
      GROUP BY o.phone HAVING COUNT(DISTINCT o.customer_id) >= 2`,
    p,
  )
  const view = (kind) => (r) => ({
    kind, customers: r.customers, orders: r.orders, orderNumbers: r.numbers, firstAt: r.first_at, lastAt: r.last_at,
    withinMinutes: Math.round((r.last_at - r.first_at) / 60_000),
  })
  return [...addr.rows.map(view('SAME_ADDRESS')), ...phone.rows.map(view('SAME_PHONE'))]
}
