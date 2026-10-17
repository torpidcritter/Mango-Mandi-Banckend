// Stock engine: availability (read path), FEFO allocation with an atomic guard
// (write path), stock movements with ledger rows, and the ledger audit.
//
// Counters live on batch_lines; every movement also writes an append-only
// batch_ledger row. on_hand moves only through INTAKE, ADJUST, PACK, RESTOCK,
// CONDEMN and RETIRE rows, so their sum must equal on_hand. held and committed
// must equal the order_stock rows in those states. The nightly audit checks both.
import { getConfig } from './config.js'
import { addDays, now } from './clock.js'
import { newId } from './ids.js'
import { stageFor } from './stage.js'

export const SELLABLE_STATUSES = ['IN_TRANSIT', 'ARRIVED', 'RIPENING', 'SELLING']
const PHYSICAL_STATUSES = ['ARRIVED', 'RIPENING', 'SELLING']
const ON_HAND_EVENTS = ['INTAKE', 'ADJUST', 'PACK', 'RESTOCK', 'CONDEMN', 'RETIRE']

const LINE_SELECT = `
  SELECT l.id, l.batch_id, l.sku, l.on_hand, l.held, l.committed, l.reserve_buffer,
         b.variety, b.plucked_on, b.status, b.eta_date, b.arrived_at,
         q.ripeness_rating, q.condition, q.logged_at
    FROM batch_lines l
    JOIN batches b ON b.id = l.batch_id
    LEFT JOIN LATERAL (
      SELECT ripeness_rating, condition, logged_at FROM batch_qc
       WHERE batch_id = b.id ORDER BY logged_at DESC LIMIT 1
    ) q ON TRUE`

/**
 * Whether a line's batch can be sold for a delivery date, and as what.
 * Returns { stage, factor } or null. `existing` checks stock that is already
 * allocated rather than a new sale. `factor` scales on_hand: in-transit stock
 * counts at the forecast confidence until it arrives and passes QC.
 */
export function sellableAs(row, deliveryDate, cfg = getConfig(), { existing = false } = {}) {
  if (!SELLABLE_STATUSES.includes(row.status)) return null
  if (row.condition === 'REJECT') return null
  let factor = 1
  if (PHYSICAL_STATUSES.includes(row.status)) {
    // New sales need an intake QC first. Stock already promised while the
    // batch was in transit stays valid until QC says otherwise.
    if (!row.ripeness_rating && !existing) return null
  } else {
    const eta = row.eta_date ?? addDays(row.plucked_on, cfg.transitDays)
    if (deliveryDate <= eta) return null // not physically here in time
    factor = cfg.forecastConfidence
  }
  const qc = row.ripeness_rating ? { ripenessRating: row.ripeness_rating, loggedAt: row.logged_at } : null
  const stage = stageFor(cfg, { variety: row.variety, pluckedOn: row.plucked_on }, deliveryDate, qc)
  return stage ? { stage, factor } : null
}

const sellableQty = (r, factor) => Math.max(0, Math.floor(r.on_hand * factor) - r.held - r.committed - r.reserve_buffer)

/** Every line that could fill an order for `deliveryDate`, oldest batch first (FEFO). */
export async function candidateLines(c, deliveryDate, { sku = null, stage = null, excludeBatchIds = [] } = {}) {
  const { rows } = await c.query(
    `${LINE_SELECT}
      WHERE b.status = ANY($1) AND ($2::text IS NULL OR l.sku = $2) AND NOT (b.id = ANY($3))
      ORDER BY b.plucked_on, b.id, l.id`,
    [SELLABLE_STATUSES, sku, excludeBatchIds],
  )
  const cfg = getConfig()
  const out = []
  for (const r of rows) {
    const s = sellableAs(r, deliveryDate, cfg)
    if (!s || (stage && s.stage !== stage)) continue
    out.push({ ...r, stage: s.stage, factor: s.factor, sellable: sellableQty(r, s.factor) })
  }
  return out
}

/** Sellable boxes per SKU and stage for one delivery date: Map "sku|stage" → qty. */
export async function availability(c, deliveryDate) {
  const pool = new Map()
  for (const l of await candidateLines(c, deliveryDate)) {
    const key = `${l.sku}|${l.stage}`
    pool.set(key, (pool.get(key) ?? 0) + l.sellable)
  }
  return pool
}

export async function ledger(c, { batchId, eventType, sku, delta, actorType = 'admin', actorId, reason = null }) {
  await c.query(
    `INSERT INTO batch_ledger (id, batch_id, event_type, sku, delta, actor_type, actor_id, reason, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [newId('led'), batchId, eventType, sku, delta, actorType, actorId, reason, now()],
  )
}

/**
 * Takes up to `qty` boxes of sku+stage for an order, FEFO, as `state`
 * ('held' or 'committed'). Each take is a conditional UPDATE that only
 * succeeds if the stock is still there, so concurrent buyers can never
 * oversell. Returns the quantity actually taken; callers decide whether a
 * shortfall is fatal.
 */
export async function allocate(c, { orderId, orderNumber, deliveryDate, sku, stage, qty, state, actor, excludeBatchIds = [] }) {
  const col = state === 'held' ? 'held' : 'committed'
  let left = qty
  for (const line of await candidateLines(c, deliveryDate, { sku, stage, excludeBatchIds })) {
    if (left === 0) break
    let take = Math.min(left, line.sellable)
    for (let attempt = 0; take > 0 && attempt < 5; attempt++) {
      const upd = await c.query(
        `UPDATE batch_lines SET ${col} = ${col} + $2
          WHERE id = $1 AND floor(on_hand * $3::numeric) - held - committed - reserve_buffer >= $2
          RETURNING id`,
        [line.id, take, line.factor],
      )
      if (upd.rowCount === 1) {
        await c.query(
          `INSERT INTO order_stock (id, order_id, batch_id, line_id, sku, stage, quantity, state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [newId('ost'), orderId, line.batch_id, line.id, sku, stage, take, state],
        )
        await ledger(c, {
          batchId: line.batch_id,
          eventType: state === 'held' ? 'HOLD' : 'COMMIT',
          sku,
          delta: take,
          actorType: actor.type,
          actorId: actor.id,
          reason: orderNumber,
        })
        left -= take
        break
      }
      // Someone else took stock in between: re-read what is left and retry.
      const cur = await c.query(
        'SELECT floor(on_hand * $2::numeric)::int - held - committed - reserve_buffer AS n FROM batch_lines WHERE id = $1',
        [line.id, line.factor],
      )
      take = Math.min(left, Math.max(0, cur.rows[0]?.n ?? 0))
    }
  }
  return qty - left
}

/** Returns a held or committed order_stock row to the pool (all of it, or `qty`). */
export async function release(c, row, actor, reason, qty = row.quantity) {
  const col = row.state === 'held' ? 'held' : 'committed'
  await c.query(`UPDATE batch_lines SET ${col} = ${col} - $2 WHERE id = $1`, [row.line_id, qty])
  if (qty === row.quantity) {
    await c.query(`UPDATE order_stock SET state = 'released' WHERE id = $1`, [row.id])
  } else {
    await c.query('UPDATE order_stock SET quantity = quantity - $2 WHERE id = $1', [row.id, qty])
    await c.query(
      `INSERT INTO order_stock (id, order_id, batch_id, line_id, sku, stage, quantity, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'released')`,
      [newId('ost'), row.order_id, row.batch_id, row.line_id, row.sku, row.stage, qty],
    )
  }
  await ledger(c, { batchId: row.batch_id, eventType: 'RELEASE', sku: row.sku, delta: -qty, actorType: actor.type, actorId: actor.id, reason })
}

/** held → committed, after payment. */
export async function commitHeld(c, row, actor, reason) {
  await c.query('UPDATE batch_lines SET held = held - $2, committed = committed + $2 WHERE id = $1', [row.line_id, row.quantity])
  await c.query(`UPDATE order_stock SET state = 'committed' WHERE id = $1`, [row.id])
  await ledger(c, { batchId: row.batch_id, eventType: 'COMMIT', sku: row.sku, delta: row.quantity, actorType: actor.type, actorId: actor.id, reason })
}

/** committed → packed: the boxes leave the shelf. */
export async function pack(c, row, actor, reason) {
  await c.query('UPDATE batch_lines SET committed = committed - $2, on_hand = on_hand - $2 WHERE id = $1', [row.line_id, row.quantity])
  await c.query(`UPDATE order_stock SET state = 'packed' WHERE id = $1`, [row.id])
  await ledger(c, { batchId: row.batch_id, eventType: 'PACK', sku: row.sku, delta: -row.quantity, actorType: actor.type, actorId: actor.id, reason })
}

/** packed → back on the shelf (an order cancelled before it shipped). */
export async function restock(c, row, actor, reason) {
  await c.query('UPDATE batch_lines SET on_hand = on_hand + $2 WHERE id = $1', [row.line_id, row.quantity])
  await c.query(`UPDATE order_stock SET state = 'released' WHERE id = $1`, [row.id])
  await ledger(c, { batchId: row.batch_id, eventType: 'RESTOCK', sku: row.sku, delta: row.quantity, actorType: actor.type, actorId: actor.id, reason })
}

/** One line's sellability on a date, even if its batch is no longer sellable. */
export async function lineInfo(c, lineId) {
  const { rows } = await c.query(`${LINE_SELECT} WHERE l.id = $1`, [lineId])
  return rows[0] ?? null
}

/**
 * Compares counters against their sources. Returns one entry per drifting
 * line; an empty array means the books balance.
 */
export async function auditLedger(c) {
  const { rows } = await c.query(
    `SELECT l.id, l.batch_id, l.sku, l.on_hand, l.held, l.committed, l.reserve_buffer,
            COALESCE((SELECT SUM(delta) FROM batch_ledger g
                       WHERE g.batch_id = l.batch_id AND g.sku = l.sku AND g.event_type = ANY($1)), 0)::int AS ledger_on_hand,
            COALESCE((SELECT SUM(delta) FROM batch_ledger g
                       WHERE g.batch_id = l.batch_id AND g.sku = l.sku AND g.event_type = 'ADJUST_BUFFER'), 0)::int AS ledger_buffer,
            COALESCE((SELECT SUM(quantity) FROM order_stock s WHERE s.line_id = l.id AND s.state = 'held'), 0)::int AS stock_held,
            COALESCE((SELECT SUM(quantity) FROM order_stock s WHERE s.line_id = l.id AND s.state = 'committed'), 0)::int AS stock_committed
       FROM batch_lines l`,
    [ON_HAND_EVENTS],
  )
  return rows
    .filter(
      (r) =>
        r.on_hand !== r.ledger_on_hand ||
        r.reserve_buffer !== r.ledger_buffer ||
        r.held !== r.stock_held ||
        r.committed !== r.stock_committed,
    )
    .map((r) => ({
      lineId: r.id,
      batchId: r.batch_id,
      sku: r.sku,
      onHand: [r.on_hand, r.ledger_on_hand],
      reserveBuffer: [r.reserve_buffer, r.ledger_buffer],
      held: [r.held, r.stock_held],
      committed: [r.committed, r.stock_committed],
    }))
}
