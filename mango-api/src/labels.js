// Box labels and scanning. Every physical box gets a printed label: the order
// code, "box 2 of 3", the delivery date and slot, what is inside, its ripeness
// as delivered, when to eat it, its batch and a QR code. Packers scan each box
// into its order (the last box packs the order through the usual steps), the
// van is scanned before a run goes out, and a rider can scan a box at the door.
//
// The QR holds a link to the shop's /b/<token> page. The token is a random key
// plus an HMAC tag, so it says nothing about the order and can't be guessed or
// made up; the server checks the tag before it looks anything up. Staff can
// also type the short code printed under the QR (ORD-1042-2: order and box),
// which only the signed-in staff routes accept.
//
// Scanning only calls order steps that already exist (allocateOrder,
// setOrderStatus, dispatchOrder); it never changes what they do.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import qrcode from 'qrcode-generator'
import { now, todayIST } from './clock.js'
import { getConfig } from './config.js'
import { query, tx } from './db.js'
import { dispatchOrder } from './delivery-proof.js'
import { env } from './env.js'
import { HttpError, notFound } from './errors.js'
import { newId } from './ids.js'
import { allocateOrder, setOrderStatus } from './orders.js'
import { findProduct, productName } from './products.js'
import { eatByFor, readyOnFor } from './ripeness.js'

const KEY_BYTES = 16
const TAG_BYTES = 10
const KEY_CHARS = Math.ceil((KEY_BYTES * 4) / 3) // base64url, no padding: 22
const TAG_CHARS = Math.ceil((TAG_BYTES * 4) / 3) // 14
const TOKEN_RE = new RegExp(`^[A-Za-z0-9_-]{${KEY_CHARS + TAG_CHARS}}$`)
const CODE_RE = /^(ORD-\d+)-(\d{1,3})$/i

/** Orders whose labels can be printed: paid, not yet on the road. */
const PRINTABLE = ['CONFIRMED', 'PROCESSING', 'PACKED']
/** Orders that may be scanned onto the van. */
const READY_TO_GO = ['PACKED', 'SHIPPED', 'DELIVERY_FAILED']

export const labelsOn = () => getConfig().labels.enabled

export function requireLabels(_req, _res, next) {
  next(labelsOn() ? undefined : new HttpError(404, 'FEATURE_OFF', 'Box labels are turned off. A manager can turn them on under Planning, Selling rules.'))
}

// ---------------------------------------------------------------- tokens

const tag = (key) => createHmac('sha256', env.LABEL_TOKEN_SECRET).update(`box-label:${key}`).digest().subarray(0, TAG_BYTES)

const newKey = () => randomBytes(KEY_BYTES).toString('base64url')

export const tokenFor = (key) => `${key}${tag(key).toString('base64url')}`

/** The label key in a token, or null when the token is malformed or its tag is wrong. */
export function verifyToken(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null
  const key = token.slice(0, KEY_CHARS)
  // Compared as text, so a token is only valid in its one canonical spelling.
  const given = Buffer.from(token.slice(KEY_CHARS))
  const expected = Buffer.from(tag(key).toString('base64url'))
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  return key
}

/** The link the QR holds: the shop's public box page. */
export function qrUrl(key) {
  const shop = env.CUSTOMER_ORIGIN.split(',')[0].trim().replace(/\/$/, '')
  return `${shop}/b/${tokenFor(key)}`
}

/** What a scanner read: a shop link, a bare token, or a typed code. */
export function parseScan(input) {
  const s = String(input ?? '').trim()
  const code = CODE_RE.exec(s)
  if (code) return { code: { number: code[1].toUpperCase(), boxNo: Number(code[2]) } }
  const at = s.indexOf('/b/')
  return { token: at >= 0 ? s.slice(at + 3).split(/[/?#]/)[0] : s }
}

/** The live or voided label a scan points at, or null. Codes only find live labels. */
async function findLabel(c, scan, { lock = false } = {}) {
  const p = parseScan(scan)
  const forUpdate = lock ? ' FOR UPDATE OF l' : ''
  if (p.code) {
    const { rows } = await c.query(
      `SELECT l.* FROM box_labels l JOIN orders o ON o.id = l.order_id
        WHERE o.number = $1 AND l.box_no = $2 AND l.voided_at IS NULL${forUpdate}`,
      [p.code.number, p.code.boxNo],
    )
    return rows[0] ?? null
  }
  const key = verifyToken(p.token)
  if (!key) return null
  const { rows } = await c.query(`SELECT l.* FROM box_labels l WHERE l.token_key = $1${forUpdate}`, [key])
  return rows[0] ?? null
}

// ---------------------------------------------------------------- creating labels

const actorName = (actor) => actor.label ?? actor.id

const liveLabels = async (c, orderId) =>
  (await c.query('SELECT * FROM box_labels WHERE order_id = $1 AND voided_at IS NULL ORDER BY box_no', [orderId])).rows

/** The boxes an order should have labels for: each committed or packed stock row, once per box. */
async function wantedBoxes(c, orderId) {
  const { rows } = await c.query(
    `SELECT id, sku, stage, batch_id, quantity FROM order_stock
      WHERE order_id = $1 AND state IN ('committed', 'packed') ORDER BY sku, stage, id`,
    [orderId],
  )
  return rows.flatMap((r) => Array.from({ length: r.quantity }, () => r))
}

/**
 * Whether the order's live labels still describe it: same stock rows (so the
 * same batches and box count), same delivery date and slot. Labels go out of
 * date when the engine swaps stock before packing or the order is moved.
 */
async function labelsCurrent(c, o, labels = null) {
  labels ??= await liveLabels(c, o.id)
  if (!labels.length) return false
  const wanted = await wantedBoxes(c, o.id)
  if (wanted.length !== labels.length) return false
  const count = (list, key) => list.reduce((m, x) => m.set(key(x), (m.get(key(x)) ?? 0) + 1), new Map())
  const want = count(wanted, (r) => r.id)
  const have = count(labels, (l) => l.stock_id)
  if ([...want].some(([id, n]) => have.get(id) !== n)) return false
  return labels.every((l) => l.delivery_date === o.delivery_date && (l.slot_id ?? null) === (o.slot_id ?? null))
}

/** Every unpacked box of the order still needs a label: why not, or null. */
async function missingStock(c, o) {
  const { rows } = await c.query(
    `SELECT
       (SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE order_id = $1)::int AS boxes,
       (SELECT COALESCE(SUM(quantity), 0) FROM order_stock WHERE order_id = $1 AND state IN ('committed', 'packed'))::int AS ready`,
    [o.id],
  )
  return rows[0].ready < rows[0].boxes ? 'Not all of its stock is allocated yet; fix the order first' : null
}

/**
 * The order's labels, made once. While they still describe the order the same
 * labels come back (printing again gives the same QR codes); when the order
 * changed, the old labels are voided and a fresh set is made.
 * Returns { labels } or { skipped: reason }.
 */
export async function ensureLabels(c, orderId, actor) {
  const { rows } = await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId])
  const o = rows[0]
  if (!o) throw notFound('Order not found')
  if (!PRINTABLE.includes(o.status)) return { order: o, skipped: `It is ${o.status.toLowerCase().replace(/_/g, ' ')}` }
  const missing = await missingStock(c, o)
  if (missing) return { order: o, skipped: missing }
  const live = await liveLabels(c, o.id)
  if (await labelsCurrent(c, o, live)) return { order: o, labels: live }
  if (live.length) {
    await c.query(`UPDATE box_labels SET voided_at = $2, void_reason = 'Order changed; new labels printed' WHERE order_id = $1 AND voided_at IS NULL`, [o.id, now()])
  }
  const wanted = await wantedBoxes(c, o.id)
  const at = now()
  const labels = []
  for (const [i, r] of wanted.entries()) {
    const { rows: made } = await c.query(
      `INSERT INTO box_labels (id, order_id, stock_id, box_no, box_count, sku, stage, batch_id, delivery_date, slot_id, token_key, printed_at, printed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [newId('lbl'), o.id, r.id, i + 1, wanted.length, r.sku, r.stage, r.batch_id, o.delivery_date, o.slot_id ?? null, newKey(), at, actorName(actor)],
    )
    labels.push(made[0])
  }
  return { order: o, labels }
}

/** A replacement for one damaged or lost label: a new QR, the old one stops working. */
export async function reprintLabel(c, labelId, actor) {
  const { rows } = await c.query('SELECT * FROM box_labels WHERE id = $1 FOR UPDATE', [labelId])
  const l = rows[0]
  if (!l) throw notFound('Label not found')
  if (l.voided_at) throw new HttpError(409, 'LABEL_REPLACED', 'This label was already replaced. Print the order\'s labels again.')
  const { rows: o } = await c.query('SELECT * FROM orders WHERE id = $1', [l.order_id])
  if (!(await labelsCurrent(c, o[0]))) {
    throw new HttpError(409, 'LABELS_OUT_OF_DATE', 'This order changed since its labels were printed. Print all of its labels again.')
  }
  const { rows: next } = await c.query(
    'UPDATE box_labels SET token_key = $2, reprints = reprints + 1, printed_at = $3, printed_by = $4 WHERE id = $1 RETURNING *',
    [l.id, newKey(), now(), actorName(actor)],
  )
  return { order: o[0], label: next[0] }
}

// ---------------------------------------------------------------- printing

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

export const STAGE_WORDS = { RAW: 'Raw', SEMI_RIPE: 'Semi-ripe', RIPE: 'Ripe' }

const shortDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

/** Everything printed on one label. No name, phone or address. */
export function labelContent(l, { number, slotLabel, pluckedOn }) {
  const p = findProduct(l.sku)
  const readyFrom = readyOnFor(l.stage, l.delivery_date)
  const eatBy = eatByFor(l.stage, l.delivery_date)
  return {
    id: l.id,
    code: `${number}-${l.box_no}`,
    orderNumber: number,
    boxNo: l.box_no,
    boxCount: l.box_count,
    deliveryDate: l.delivery_date,
    slot: slotLabel ?? null,
    sku: l.sku,
    productName: productName(l.sku),
    variety: p?.variety ?? '',
    stage: l.stage,
    ripeness: STAGE_WORDS[l.stage],
    readyFrom,
    eatBy,
    batchId: l.batch_id,
    pluckedOn,
    packedOn: todayIST(l.packed_at ?? l.printed_at),
    footer: getConfig().labels.footer || null,
    qrUrl: qrUrl(l.token_key),
  }
}

/** Label rows with the order number, slot name and pluck date each one needs. */
export async function describeLabels(c, labels) {
  if (!labels.length) return []
  const { rows } = await c.query(
    `SELECT l.id, o.number, s.label AS slot_label, b.plucked_on
       FROM box_labels l JOIN orders o ON o.id = l.order_id JOIN batches b ON b.id = l.batch_id
       LEFT JOIN delivery_slots s ON s.id = l.slot_id
      WHERE l.id = ANY($1)`,
    [labels.map((l) => l.id)],
  )
  const extra = new Map(rows.map((r) => [r.id, r]))
  return labels.map((l) => {
    const e = extra.get(l.id)
    return labelContent(l, { number: e.number, slotLabel: e.slot_label, pluckedOn: e.plucked_on })
  })
}

function qrSvg(text) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true })
}

/** A printable page: one label per box, sized for the label printer. */
export function labelsHtml(contents, { notes = [] } = {}) {
  const { widthMm, heightMm } = getConfig().labels
  const body = contents
    .map(
      (c) => `<section class="label">
  <div class="top"><strong class="order">${esc(c.orderNumber)}</strong><span class="box">Box ${c.boxNo} of ${c.boxCount}</span></div>
  <div class="when">${esc(shortDate(c.deliveryDate))}${c.slot ? ` · ${esc(c.slot)}` : ''}</div>
  <div class="what">${esc(c.productName)}${c.variety && !c.productName.includes(c.variety) ? ` (${esc(c.variety)})` : ''}</div>
  <div class="stage">${esc(c.ripeness)} on delivery</div>
  <div class="eat">Ready ${esc(shortDate(c.readyFrom))} · Eat by ${esc(shortDate(c.eatBy))}</div>
  <div class="qr">${qrSvg(c.qrUrl)}</div>
  <div class="code">${esc(c.code)}</div>
  <div class="meta">Batch ${esc(c.batchId)} · Plucked ${esc(shortDate(c.pluckedOn))} · Packed ${esc(shortDate(c.packedOn))}</div>
  ${c.footer ? `<div class="footer">${esc(c.footer)}</div>` : ''}
</section>`,
    )
    .join('\n')
  const noteHtml = notes.length
    ? `<div class="notes"><strong>Not printed:</strong><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>`
    : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>MandiMangoes box labels</title>
<style>
@page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #000; background: #fff; }
.label { width: ${widthMm}mm; height: ${heightMm}mm; padding: 2.5mm; display: flex; flex-direction: column; gap: 0.6mm;
  overflow: hidden; page-break-after: always; break-after: page; font-size: 8pt; line-height: 1.2; }
.top { display: flex; justify-content: space-between; align-items: baseline; }
.order { font-size: 12pt; }
.box { font-size: 10pt; font-weight: 700; }
.what { font-weight: 700; }
.stage { font-size: 10pt; font-weight: 700; text-transform: uppercase; }
.qr { flex: 1; min-height: 0; display: flex; justify-content: center; align-items: center; }
.qr svg { height: 100%; max-width: 100%; }
.code { text-align: center; font-family: ui-monospace, monospace; font-size: 10pt; font-weight: 700; letter-spacing: 0.05em; }
.meta, .footer { font-size: 6.5pt; }
.notes { padding: 4mm; font-size: 10pt; border-bottom: 1px solid #000; }
@media print { .notes { display: none; } }
</style></head><body>
${noteHtml}
${body}
</body></html>`
}

// ---------------------------------------------------------------- scans

async function logScan(c, kind, outcome, { label = null, orderId = null, actor }) {
  await c.query('INSERT INTO label_scans (id, label_id, order_id, kind, outcome, actor, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
    newId('scn'), label?.id ?? null, orderId ?? label?.order_id ?? null, kind, outcome, actorName(actor), now(),
  ])
}

const STATUS_WORDS = (s) => s.toLowerCase().replace(/_/g, ' ')

/** A refused scan: logged, and turned into an error after the transaction commits. */
const refuse = (status, code, message, extra = {}) => ({ ok: false, status, code, message, ...extra })

const numberOf = async (c, orderId) => (await c.query('SELECT number FROM orders WHERE id = $1', [orderId])).rows[0]?.number

async function packProgress(c, orderId) {
  const labels = await liveLabels(c, orderId)
  return { packedBoxes: labels.filter((l) => l.packed_at).length, totalBoxes: labels.length }
}

/**
 * Last box scanned: allocate (the existing pack-time check) and mark the
 * order packed. Any refusal rolls back only this step; the box scans stay.
 */
async function finishPacking(c, o, actor) {
  await c.query('SAVEPOINT finish_pack')
  try {
    await allocateOrder(c, o.id, actor)
    const { rows } = await c.query('SELECT * FROM orders WHERE id = $1', [o.id])
    if (!(await labelsCurrent(c, rows[0]))) {
      await c.query('ROLLBACK TO SAVEPOINT finish_pack')
      return { ok: false, code: 'OUT_OF_DATE', message: `${o.number}'s stock changed while packing. Print its labels again.` }
    }
    await setOrderStatus(c, o.id, 'PACKED', actor)
    await c.query('RELEASE SAVEPOINT finish_pack')
    return { ok: true }
  } catch (err) {
    if (!(err instanceof HttpError)) throw err
    await c.query('ROLLBACK TO SAVEPOINT finish_pack')
    return { ok: false, code: err.code, message: err.message }
  }
}

/**
 * A box scanned while packing `orderId`. Marks it packed; the first box starts
 * the order (PROCESSING) and the last one packs it. Scanning a box again
 * answers the same as the first time. Refusals are returned, not thrown, so
 * the scan log commits.
 */
export async function packScan(c, { orderId, scan }, actor) {
  const { rows } = await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId])
  const o = rows[0]
  if (!o) throw notFound('Order not found')
  const label = await findLabel(c, scan, { lock: true })
  if (!label) {
    await logScan(c, 'PACK', 'UNKNOWN', { orderId, actor })
    return refuse(404, 'UNKNOWN_LABEL', "This label isn't one of ours, or the code is wrong. Check it, or print the order's labels again.")
  }
  if (label.order_id !== o.id) {
    await logScan(c, 'PACK', 'WRONG_ORDER', { label, orderId, actor })
    return refuse(409, 'WRONG_BOX', `Wrong box: this is box ${label.box_no} of ${await numberOf(c, label.order_id)}, not ${o.number}. Put it aside.`)
  }
  if (label.voided_at) {
    await logScan(c, 'PACK', 'OUT_OF_DATE', { label, actor })
    return refuse(409, 'LABEL_REPLACED', `This label was replaced (${label.void_reason ?? 'reprinted'}). Use the new label for box ${label.box_no}.`)
  }
  if (o.status === 'CANCELLED') {
    await logScan(c, 'PACK', 'CANCELLED', { label, actor })
    return refuse(409, 'ORDER_CANCELLED', `${o.number} was cancelled. Don't pack it; put the box back.`)
  }
  const done = !['CONFIRMED', 'PROCESSING'].includes(o.status)
  if (label.packed_at && done) {
    await logScan(c, 'PACK', 'REPEAT', { label, actor })
    return { ok: true, outcome: 'REPEAT', orderNumber: o.number, boxNo: label.box_no, orderPacked: true, ...(await packProgress(c, o.id)) }
  }
  if (done) {
    await logScan(c, 'PACK', 'NOT_READY', { label, actor })
    return refuse(409, 'INVALID_TRANSITION', `${o.number} is ${STATUS_WORDS(o.status)}; it can't be packed now.`)
  }
  if (!(await labelsCurrent(c, o))) {
    await logScan(c, 'PACK', 'OUT_OF_DATE', { label, actor })
    return refuse(409, 'LABELS_OUT_OF_DATE', `${o.number} changed since its labels were printed (stock, date or slot). Print its labels again.`)
  }
  let outcome = 'REPEAT'
  if (!label.packed_at) {
    if (o.status === 'CONFIRMED') await setOrderStatus(c, o.id, 'PROCESSING', actor)
    await c.query('UPDATE box_labels SET packed_at = $2, packed_by = $3 WHERE id = $1', [label.id, now(), actorName(actor)])
    outcome = 'OK'
  }
  const progress = await packProgress(c, o.id)
  let orderPacked = false
  if (progress.packedBoxes === progress.totalBoxes) {
    const r = await finishPacking(c, o, actor)
    if (!r.ok) {
      await logScan(c, 'PACK', r.code === 'OUT_OF_DATE' ? 'OUT_OF_DATE' : 'NOT_READY', { label, actor })
      return refuse(409, r.code === 'OUT_OF_DATE' ? 'LABELS_OUT_OF_DATE' : r.code, `Every box is scanned, but ${o.number} can't be packed: ${r.message}`)
    }
    orderPacked = true
  }
  await logScan(c, 'PACK', outcome, { label, actor })
  return { ok: true, outcome, orderNumber: o.number, boxNo: label.box_no, orderPacked, ...progress }
}

const sameSlot = (a, slotId) => slotId === undefined || (a ?? null) === (slotId ?? null)

/**
 * A box scanned onto the van for the run on `date` (one slot, or all when
 * slotId is undefined). The box must be packed and on this run.
 */
export async function dispatchScan(c, { date, slotId, scan }, actor) {
  const label = await findLabel(c, scan, { lock: true })
  if (!label) {
    await logScan(c, 'DISPATCH', 'UNKNOWN', { actor })
    return refuse(404, 'UNKNOWN_LABEL', "This label isn't one of ours, or the code is wrong.")
  }
  if (label.voided_at) {
    await logScan(c, 'DISPATCH', 'OUT_OF_DATE', { label, actor })
    return refuse(409, 'LABEL_REPLACED', `This label was replaced. Use the new label for box ${label.box_no}.`)
  }
  const { rows } = await c.query('SELECT * FROM orders WHERE id = $1', [label.order_id])
  const o = rows[0]
  if (o.status === 'CANCELLED') {
    await logScan(c, 'DISPATCH', 'CANCELLED', { label, actor })
    return refuse(409, 'ORDER_CANCELLED', `${o.number} was cancelled. Take this box off the van.`)
  }
  if (o.delivery_date !== date || !sameSlot(o.slot_id, slotId)) {
    await logScan(c, 'DISPATCH', 'WRONG_RUN', { label, actor })
    return refuse(409, 'WRONG_RUN', `This box is for ${o.number} on ${o.delivery_date}, not this run. Take it off the van.`)
  }
  if (label.dispatched_on === date) {
    await logScan(c, 'DISPATCH', 'REPEAT', { label, actor })
    return { ok: true, outcome: 'REPEAT', orderNumber: o.number, boxNo: label.box_no, ...(await vanProgress(c, o.id, date)) }
  }
  if (!READY_TO_GO.includes(o.status) && o.status !== 'OUT_FOR_DELIVERY') {
    await logScan(c, 'DISPATCH', 'NOT_READY', { label, actor })
    return refuse(409, 'NOT_PACKED', `${o.number} is ${STATUS_WORDS(o.status)}, not packed yet. It can't go out.`)
  }
  await c.query('UPDATE box_labels SET dispatched_on = $2, dispatched_at = $3, dispatched_by = $4 WHERE id = $1', [label.id, date, now(), actorName(actor)])
  await logScan(c, 'DISPATCH', 'OK', { label, actor })
  return { ok: true, outcome: 'OK', orderNumber: o.number, boxNo: label.box_no, ...(await vanProgress(c, o.id, date)) }
}

async function vanProgress(c, orderId, date) {
  const labels = await liveLabels(c, orderId)
  return { loadedBoxes: labels.filter((l) => l.dispatched_on === date).length, totalBoxes: labels.length }
}

/** The run's orders with their boxes: which are on the van and which are missing. */
export async function runCheck(c, { date, slotId }) {
  const params = [date]
  let slotFilter = ''
  if (slotId === null) slotFilter = 'AND o.slot_id IS NULL'
  else if (slotId) {
    params.push(slotId)
    slotFilter = 'AND o.slot_id = $2'
  }
  const { rows: orders } = await c.query(
    `SELECT o.id, o.number, o.status, o.slot_id, s.label AS slot_label FROM orders o LEFT JOIN delivery_slots s ON s.id = o.slot_id
      WHERE o.delivery_date = $1 ${slotFilter}
        AND o.status IN ('CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED')
      ORDER BY s.sort NULLS LAST, s.starts_at NULLS LAST, o.number`,
    params,
  )
  const { rows: labels } = await c.query(
    'SELECT order_id, box_no, dispatched_on FROM box_labels WHERE order_id = ANY($1) AND voided_at IS NULL ORDER BY box_no',
    [orders.map((o) => o.id)],
  )
  const out = orders.map((o) => {
    const mine = labels.filter((l) => l.order_id === o.id)
    const missing = mine.filter((l) => l.dispatched_on !== date).map((l) => l.box_no)
    const packed = READY_TO_GO.includes(o.status) || o.status === 'OUT_FOR_DELIVERY'
    let state = 'ready'
    if (o.status === 'OUT_FOR_DELIVERY') state = 'out'
    else if (!packed) state = 'not_packed'
    else if (!mine.length) state = 'no_labels'
    else if (missing.length) state = 'missing'
    return {
      id: o.id, number: o.number, status: o.status, slot: o.slot_id ? { id: o.slot_id, label: o.slot_label } : null,
      boxes: mine.length, loaded: mine.length - missing.length, missing, state,
    }
  })
  const count = (s) => out.filter((o) => o.state === s).length
  return { date, orders: out, ready: count('ready'), missing: count('missing'), notPacked: count('not_packed'), noLabels: count('no_labels'), out: count('out') }
}

/** Orders whose every box is on the van for `date` (used by the old Start run button when scanning is required). */
export async function fullyLoaded(c, orderId, date) {
  const labels = await liveLabels(c, orderId)
  return labels.length > 0 && labels.every((l) => l.dispatched_on === date)
}

/** Sends out every order on the run whose boxes are all on the van, with the usual dispatch step. */
export async function sendLoaded({ date, slotId }, actor) {
  const check = await runCheck({ query }, { date, slotId })
  const dispatched = []
  const skipped = []
  for (const o of check.orders) {
    if (o.state === 'out') continue
    if (o.state !== 'ready') {
      const why = { missing: `Boxes not scanned: ${o.missing.join(', ')}`, not_packed: 'Not packed yet', no_labels: 'No labels printed' }[o.state]
      skipped.push({ number: o.number, reason: why })
      continue
    }
    try {
      if (await tx((t) => dispatchOrder(t, o.id, actor))) dispatched.push(o.number)
    } catch (err) {
      skipped.push({ number: o.number, reason: err.message })
    }
  }
  return { dispatched, skipped }
}

/** A rider checks at the door that the box in hand belongs to this order. Proof of delivery still follows. */
export async function doorScan(c, { orderId, scan }, actor) {
  const { rows } = await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId])
  const o = rows[0]
  if (!o) throw notFound('Order not found')
  const label = await findLabel(c, scan, { lock: true })
  if (!label) {
    await logScan(c, 'DOOR', 'UNKNOWN', { orderId, actor })
    return refuse(404, 'UNKNOWN_LABEL', "This label isn't one of ours, or the code is wrong.")
  }
  if (label.order_id !== o.id) {
    await logScan(c, 'DOOR', 'WRONG_ORDER', { label, orderId, actor })
    return refuse(409, 'WRONG_BOX', `Wrong box: this is for ${await numberOf(c, label.order_id)}, not ${o.number}. Don't hand it over.`)
  }
  if (label.voided_at) {
    await logScan(c, 'DOOR', 'OUT_OF_DATE', { label, actor })
    return refuse(409, 'LABEL_REPLACED', 'This label was replaced; call the office before handing it over.')
  }
  if (o.status !== 'OUT_FOR_DELIVERY') {
    await logScan(c, 'DOOR', 'NOT_READY', { label, actor })
    return refuse(409, 'INVALID_TRANSITION', `${o.number} is ${STATUS_WORDS(o.status)}, not out for delivery.`)
  }
  const repeat = Boolean(label.door_scanned_at)
  if (!repeat) await c.query('UPDATE box_labels SET door_scanned_at = $2 WHERE id = $1', [label.id, now()])
  await logScan(c, 'DOOR', repeat ? 'REPEAT' : 'OK', { label, actor })
  const labels = await liveLabels(c, o.id)
  return {
    ok: true, outcome: repeat ? 'REPEAT' : 'OK', orderNumber: o.number, boxNo: label.box_no,
    checkedBoxes: labels.filter((l) => l.door_scanned_at || l.id === label.id).length, totalBoxes: labels.length,
  }
}

/** What a scan points at, for staff. */
export async function lookup(c, scan) {
  const label = await findLabel(c, scan)
  if (!label) throw notFound("This label isn't one of ours, or the code is wrong.")
  const { rows } = await c.query('SELECT number, status FROM orders WHERE id = $1', [label.order_id])
  const [content] = await describeLabels(c, [label])
  const { qrUrl: _hidden, ...rest } = content
  return { ...rest, orderId: label.order_id, orderStatus: rows[0].status, replaced: Boolean(label.voided_at), packed: Boolean(label.packed_at) }
}

/** The order's live labels and how far each has got, for the order page. */
export async function orderLabels(c, orderId) {
  const { rows } = await c.query('SELECT * FROM orders WHERE id = $1', [orderId])
  if (!rows.length) throw notFound('Order not found')
  const labels = await liveLabels(c, orderId)
  const described = await describeLabels(c, labels)
  return {
    current: labels.length ? await labelsCurrent(c, rows[0], labels) : false,
    labels: labels.map((l, i) => {
      const { qrUrl: _hidden, ...d } = described[i]
      return { ...d, packedAt: l.packed_at, dispatchedOn: l.dispatched_on, doorScannedAt: l.door_scanned_at, reprints: l.reprints }
    }),
  }
}

/**
 * The public box page: what is inside and when to eat it. No order, name,
 * phone, address or delivery details. Anything unknown answers the same.
 */
export async function publicBox(c, token) {
  const none = { found: false }
  if (!labelsOn()) return none
  const key = verifyToken(token)
  if (!key) return none
  const { rows } = await c.query(
    `SELECT l.sku, l.stage, l.delivery_date, l.voided_at, b.plucked_on FROM box_labels l JOIN batches b ON b.id = l.batch_id
      WHERE l.token_key = $1`,
    [key],
  )
  const l = rows[0]
  if (!l || l.voided_at) return none
  const p = findProduct(l.sku)
  const readyFrom = readyOnFor(l.stage, l.delivery_date)
  const eatBy = eatByFor(l.stage, l.delivery_date)
  return {
    found: true,
    productName: productName(l.sku),
    variety: p?.variety ?? '',
    description: p?.description ?? '',
    pluckedOn: l.plucked_on,
    stage: l.stage,
    readyFrom,
    eatBy,
  }
}
