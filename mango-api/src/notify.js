// Customer order updates. A notification row is written in the same
// transaction as the order change that causes it (an outbox), so a rolled-back
// change sends nothing and a committed one is never lost; the maintenance loop
// sends due rows and retries failures with backoff.
import { outOfTime } from './budget.js'
import { now } from './clock.js'
import { query } from './db.js'
import { env, isProd } from './env.js'
import { newId } from './ids.js'
import { logger } from './logger.js'
import { metrics } from './metrics.js'
import { productName } from './products.js'
import { eatByFor, readyOnFor, STAGE_WORDS, storageTip } from './ripeness.js'
import { templateName, whatsappSender } from './whatsapp.js'

const RETRY_MINUTES = [1, 5, 15, 60, 180]
const MAX_AGE_MS = 24 * 3_600_000 // an update older than a day is no longer news
const CLAIM_MS = 5 * 60_000 // how long a claimed message is left alone if its sender dies
const SEND_CALL_MS = 12_000 // a WhatsApp call gives up after 10 seconds

/** The message an order event sends, if any. */
function kindFor(from, to, order) {
  if (from === to) return null
  if (to === 'CONFIRMED') return order.replacement_for ? 'REPLACEMENT_CONFIRMED' : 'ORDER_CONFIRMED'
  if (to === 'OUT_FOR_DELIVERY' || to === 'DELIVERED' || to === 'DELIVERY_FAILED') return to
  // Unpaid orders (abandoned checkouts, expired holds) are cancelled silently.
  if (to === 'CANCELLED' && from !== 'PAYMENT_PENDING' && from !== null) return 'CANCELLED'
  return null
}

export async function enqueue(c, orderId, eventId, kind, { delayMs = 0 } = {}) {
  const { rows } = await c.query('SELECT phone, gift_recipient_phone FROM orders WHERE id = $1', [orderId])
  const o = rows[0]
  const at = now()
  const add = (k, phone) =>
    c.query(
      `INSERT INTO notifications (id, order_id, event_id, kind, phone, next_attempt_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (event_id, kind) DO NOTHING`,
      [newId('ntf'), orderId, eventId, k, phone, new Date(at.getTime() + delayMs), at],
    )
  if (o?.phone) await add(kind, o.phone)
  // A gift: the recipient is at the door, so they get the delivery code too.
  if (kind === 'OUT_FOR_DELIVERY' && o?.gift_recipient_phone && o.gift_recipient_phone !== o.phone) await add('GIFT_OUT_FOR_DELIVERY', o.gift_recipient_phone)
}

/** The Meta template a kind is sent with. The gift message reuses the out-for-delivery one, addressed to the recipient. */
export const templateFor = (kind) => templateName(kind === 'GIFT_OUT_FOR_DELIVERY' ? 'OUT_FOR_DELIVERY' : kind)

/** Queues a preorder message (booked, spot open, moved, refunded). */
export async function enqueuePreorder(c, preorderId, kind) {
  const { rows } = await c.query('SELECT phone FROM preorders WHERE id = $1', [preorderId])
  if (!rows[0]?.phone) return
  const at = now()
  await c.query(
    `INSERT INTO notifications (id, preorder_id, event_id, kind, phone, next_attempt_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [newId('ntf'), preorderId, newId('pev'), kind, rows[0].phone, at],
  )
}

/** Called for every order event; queues the matching update. */
export async function enqueueForEvent(c, orderId, eventId, from, to) {
  if (from === to) return
  const { rows } = await c.query('SELECT replacement_for FROM orders WHERE id = $1', [orderId])
  const kind = rows.length ? kindFor(from, to, rows[0]) : null
  if (kind) await enqueue(c, orderId, eventId, kind)
  // A minute after the confirmation: when each box is ready to eat and how to
  // keep it. Only when a box arrives raw or semi-ripe: for ripe boxes the answer
  // is "now", and one message fewer is better (and cheaper).
  if (kind === 'ORDER_CONFIRMED' || kind === 'REPLACEMENT_CONFIRMED') {
    const { rows: unripe } = await c.query(`SELECT 1 FROM order_items WHERE order_id = $1 AND stage <> 'RIPE' LIMIT 1`, [orderId])
    if (unripe.length) await enqueue(c, orderId, eventId, 'RIPENESS_GUIDE', { delayMs: 60_000 })
  }
}

/** Queues a back-in-stock message for an alert. */
export async function enqueueAlert(c, alertId, phone) {
  const at = now()
  await c.query(
    `INSERT INTO notifications (id, stock_alert_id, event_id, kind, phone, next_attempt_at, created_at) VALUES ($1, $2, $3, 'BACK_IN_STOCK', $4, $5, $5)`,
    [newId('ntf'), alertId, newId('aev'), phone, at],
  )
}

/** "Alphonso 3kg Box (raw): ready around Sat, 18 Oct; Kesar 3kg Box (ripe): ready on arrival, Thu, 16 Oct" */
export function readyWords(items, date) {
  const seen = new Map()
  for (const i of items ?? []) if (i.stage) seen.set(`${i.sku}|${i.stage}`, i)
  return [...seen.values()]
    .map((i) => {
      const ready = readyOnFor(i.stage, date)
      const when = ready === date ? `ready on arrival, ${dateWords(date)}` : `ready around ${dateWords(ready)}`
      return `${productName(i.sku)} (${STAGE_WORDS[i.stage]}): ${when}, best by ${dateWords(eatByFor(i.stage, date))}`
    })
    .join('; ')
}
const shopUrl = () => env.CUSTOMER_ORIGIN.split(',')[0]?.trim().replace(/\/$/, '') || 'https://mandimangoes.in'
const clip = (s, n = 900) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const IST_DATE = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
export const dateWords = (d) => IST_DATE.format(new Date(`${d}T00:00:00Z`))
/** "week of Mon, 2 Mar" */
export const weekWords = (d) => `the week of ${dateWords(d)}`
export const timeWords = (t) => {
  const [h, m] = String(t).split(':').map(Number)
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`
}
const slotWords = (n) => (n.starts_at ? `${timeWords(n.starts_at)} to ${timeWords(n.ends_at)}` : 'during the day')
export const rupees = (paise) => `Rs ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

/** Template body variables, in order, for each kind of update. */
export function paramsFor(n) {
  const name = n.customer_name?.trim() || 'there'
  switch (n.kind) {
    case 'ORDER_CONFIRMED':
    case 'REPLACEMENT_CONFIRMED':
      return [name, n.number, dateWords(n.delivery_date), slotWords(n)]
    case 'OUT_FOR_DELIVERY':
      return [name, n.number, slotWords(n), n.delivery_code ?? '']
    case 'GIFT_OUT_FOR_DELIVERY':
      return [n.gift_recipient_name?.trim() || 'there', n.number, slotWords(n), n.delivery_code ?? '']
    case 'RIPENESS_GUIDE':
      return [name, n.number, clip(readyWords(n.items, n.delivery_date)), storageTip((n.items ?? []).map((i) => i.stage))]
    case 'BACK_IN_STOCK':
      return [name, `${productName(n.alert_sku)} (${STAGE_WORDS[n.alert_stage]})`, n.alert_date ? dateWords(n.alert_date) : 'soon', shopUrl()]
    case 'REORDER_REMINDER':
      return [name, n.last_product ? productName(n.last_product) : 'mangoes', shopUrl()]
    case 'DATE_MOVED':
      return [name, n.number, dateWords(n.delivery_date), slotWords(n)]
    case 'DELIVERY_FAILED':
      return [name, n.number, dateWords(n.delivery_date)]
    case 'REFUNDED':
      return [name, n.number, rupees(n.payment_amount ?? n.total)]
    case 'PREORDER_BOOKED':
    case 'PREORDER_MOVED':
      return [name, n.number, `${n.pre_qty} × ${productName(n.pre_sku)}`, weekWords(n.week_start)]
    case 'PREORDER_SPOT_OPEN':
      return [name, `${n.pre_qty} × ${productName(n.pre_sku)}`, weekWords(n.week_start), n.payment_link_url ?? '']
    default:
      return [name, n.number]
  }
}

async function mark(id, fields) {
  const keys = Object.keys(fields)
  await query(`UPDATE notifications SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => fields[k])])
}

/** Sends due updates. `sender` is injectable for tests. Returns how many were sent. */
export async function sendDueNotifications({ sender = whatsappSender, limit = 50 } = {}) {
  const at = now()
  // Claim due rows first: SKIP LOCKED plus pushing next_attempt_at out a few
  // minutes means a second sender (another instance, an overlapping run) never
  // picks up the same message. Each outcome below sets the real next state.
  const claimed = await query(
    `UPDATE notifications SET next_attempt_at = $3
      WHERE id IN (SELECT id FROM notifications WHERE status = 'PENDING' AND next_attempt_at <= $1
                    ORDER BY next_attempt_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING id`,
    [at, limit, new Date(at.getTime() + CLAIM_MS)],
  )
  if (!claimed.rows.length) return 0
  const { rows } = await query(
    `SELECT n.*, COALESCE(o.number, p.number) AS number,
            o.delivery_date, o.delivery_code, o.gift_recipient_name, COALESCE(o.total, p.total) AS total, COALESCE(o.payment_amount, p.paid_amount) AS payment_amount,
            s.starts_at, s.ends_at, p.week_start, p.sku AS pre_sku, p.qty AS pre_qty, p.payment_link_url,
            (SELECT json_agg(json_build_object('sku', i.sku, 'stage', i.stage) ORDER BY i.sku) FROM order_items i WHERE i.order_id = o.id) AS items,
            (SELECT i.sku FROM order_items i WHERE i.order_id = o.id ORDER BY i.line_price DESC LIMIT 1) AS last_product,
            a.sku AS alert_sku, a.stage AS alert_stage, a.available_on AS alert_date,
            COALESCE(o.customer_name, p.customer_name, ac.name) AS customer_name
       FROM notifications n LEFT JOIN orders o ON o.id = n.order_id LEFT JOIN preorders p ON p.id = n.preorder_id
       LEFT JOIN delivery_slots s ON s.id = o.slot_id
       LEFT JOIN stock_alerts a ON a.id = n.stock_alert_id LEFT JOIN customers ac ON ac.id = a.customer_id
      WHERE n.id = ANY($1) ORDER BY n.created_at`,
    [claimed.rows.map((r) => r.id)],
  )
  let sent = 0
  for (const [i, n] of rows.entries()) {
    if (outOfTime(SEND_CALL_MS)) {
      // Out of time: hand the rest back so the next run sends them straight away.
      await query('UPDATE notifications SET next_attempt_at = $2 WHERE id = ANY($1)', [rows.slice(i).map((r) => r.id), at])
      break
    }
    if (at - n.created_at > MAX_AGE_MS) {
      await mark(n.id, { status: 'SKIPPED', last_error: 'older than a day' })
      continue
    }
    if (!sender) {
      if (isProd) {
        logger.warn({ orderId: n.order_id, kind: n.kind }, 'no WhatsApp provider configured; update not sent')
        await mark(n.id, { status: 'SKIPPED', last_error: 'no WhatsApp provider configured' })
      } else {
        logger.info({ phone: n.phone, kind: n.kind, params: paramsFor(n) }, `WhatsApp ${templateFor(n.kind)}`)
        await mark(n.id, { status: 'SENT', sent_at: at, provider_id: 'log' })
        sent++
      }
      continue
    }
    try {
      const providerId = await sender({ phone: n.phone, template: templateFor(n.kind), params: paramsFor(n) })
      await mark(n.id, { status: 'SENT', sent_at: at, provider_id: providerId, attempts: n.attempts + 1, last_error: null })
      metrics.notificationsSent.inc({ kind: n.kind })
      sent++
    } catch (err) {
      const attempts = n.attempts + 1
      const wait = RETRY_MINUTES.at(attempts - 1)
      logger.warn({ err, orderId: n.order_id, kind: n.kind, attempts }, 'WhatsApp update failed')
      if (wait == null) {
        await mark(n.id, { status: 'FAILED', attempts, last_error: String(err.message).slice(0, 500) })
        metrics.notificationsFailed.inc({ kind: n.kind })
      } else {
        await mark(n.id, { attempts, last_error: String(err.message).slice(0, 500), next_attempt_at: new Date(at.getTime() + wait * 60_000) })
      }
    }
  }
  return sent
}
