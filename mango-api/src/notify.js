// Customer order updates. A notification row is written in the same
// transaction as the order change that causes it (an outbox), so a rolled-back
// change sends nothing and a committed one is never lost; the maintenance loop
// sends due rows and retries failures with backoff.
import { canStartCall } from './budget.js'
import { now } from './clock.js'
import { query } from './db.js'
import { env, isProd } from './env.js'
import { newId } from './ids.js'
import { logger, maskPhone } from './logger.js'
import { metrics } from './metrics.js'
import { productName } from './products.js'
import { eatByFor, readyOnFor, STAGE_WORDS, storageTip } from './ripeness.js'
import { templateName, whatsappSender } from './whatsapp.js'

const RETRY_MINUTES = [1, 5, 15, 60, 180]
const MAX_AGE_MS = 24 * 3_600_000 // an update older than a day is no longer news
const CLAIM_MS = 5 * 60_000 // how long a claimed message is left alone if its sender dies
const SEND_CALL_MS = 12_000 // a WhatsApp call gives up after 10 seconds
const SEND_CONCURRENCY = 5

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
    case 'CLAIM_RECEIVED':
      return [name, n.number]
    case 'CLAIM_REJECTED':
      // One line: template variables may not hold line breaks.
      return [name, n.number, clip(n.claim_reason?.replace(/\s+/g, ' ').trim() || 'no reason given', 500)]
    default:
      return [name, n.number]
  }
}

/**
 * UX-7: order updates whose template carries an "Open order" URL button,
 * https://<shop>/orders/{{1}}; the button's one variable is the order id. The claim
 * templates are new and have the button from the start. The older ones get it only
 * once Meta approves their new versions, so it is sent only with WHATSAPP_ORDER_LINKS=true
 * (sending a button variable to a template without the button fails at Meta).
 * The gift recipient's out-for-delivery message shares the template, so it carries the
 * button too; the page asks them to sign in as the buyer.
 */
const ORDER_LINK_ALWAYS = new Set(['CLAIM_RECEIVED', 'CLAIM_REJECTED'])
const ORDER_LINK_WITH_FLAG = new Set(['ORDER_CONFIRMED', 'REPLACEMENT_CONFIRMED', 'OUT_FOR_DELIVERY', 'GIFT_OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED', 'DATE_MOVED'])
export function orderLinkFor(n) {
  if (!n.order_id) return null
  if (ORDER_LINK_ALWAYS.has(n.kind) || (env.WHATSAPP_ORDER_LINKS && ORDER_LINK_WITH_FLAG.has(n.kind))) return n.order_id
  return null
}

async function mark(id, fields) {
  const keys = Object.keys(fields)
  await query(`UPDATE notifications SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => fields[k])])
}

/** Batches one call may claim, so a call outside a time budget (a test, a script) still ends. */
const MAX_BATCHES = 40

/**
 * Sends due updates. `sender` is injectable for tests. Returns how many were sent.
 * OPS-30: claims batch after batch while the run's time allows (a dispatch
 * burst of hundreds of delivery codes goes out in one run, not 50 a minute).
 * Only messages due when the call started are claimed, and every outcome
 * moves a message's next attempt past that time, so nothing is sent twice.
 */
export async function sendDueNotifications({ sender = whatsappSender, limit = 50, maxBatches = MAX_BATCHES } = {}) {
  const at = now()
  let sent = 0
  for (let b = 0; b < maxBatches; b++) {
    if (b > 0 && !canStartCall(SEND_CALL_MS)) break
    const r = await sendBatch(sender, limit, at)
    sent += r.sent
    if (r.claimed < limit || r.outOfTime) break
  }
  return sent
}

/** Claims and sends up to `limit` messages due at `at`. */
async function sendBatch(sender, limit, at) {
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
  if (!claimed.rows.length) return { sent: 0, claimed: 0, outOfTime: false }
  const { rows } = await query(
    `SELECT n.*, COALESCE(o.number, p.number) AS number, o.status AS order_status,
            o.delivery_date, o.delivery_code, o.gift_recipient_name, COALESCE(o.total, p.total) AS total, COALESCE(o.payment_amount, p.paid_amount) AS payment_amount,
            s.starts_at, s.ends_at, p.week_start, p.sku AS pre_sku, p.qty AS pre_qty, p.payment_link_url,
            (SELECT json_agg(json_build_object('sku', i.sku, 'stage', i.stage) ORDER BY i.sku) FROM order_items i WHERE i.order_id = o.id) AS items,
            (SELECT i.sku FROM order_items i WHERE i.order_id = o.id ORDER BY i.line_price DESC LIMIT 1) AS last_product,
            a.sku AS alert_sku, a.stage AS alert_stage, a.available_on AS alert_date,
            COALESCE(o.customer_name, p.customer_name, ac.name) AS customer_name,
            (SELECT cl.resolution_note FROM claims cl WHERE cl.id = n.event_id AND n.kind = 'CLAIM_REJECTED') AS claim_reason
       FROM notifications n LEFT JOIN orders o ON o.id = n.order_id LEFT JOIN preorders p ON p.id = n.preorder_id
       LEFT JOIN delivery_slots s ON s.id = o.slot_id
       LEFT JOIN stock_alerts a ON a.id = n.stock_alert_id LEFT JOIN customers ac ON ac.id = a.customer_id
      WHERE n.id = ANY($1) ORDER BY n.created_at`,
    [claimed.rows.map((r) => r.id)],
  )
  let sent = 0
  // A few at a time: a dispatch burst queues hundreds of delivery codes, and one
  // by one at Meta's latency they would arrive late.
  for (let i = 0; i < rows.length; i += SEND_CONCURRENCY) {
    if (!canStartCall(SEND_CALL_MS)) {
      // Out of time: hand the rest back so the next run sends them straight away.
      await query('UPDATE notifications SET next_attempt_at = $2 WHERE id = ANY($1)', [rows.slice(i).map((r) => r.id), at])
      return { sent, claimed: claimed.rows.length, outOfTime: true }
    }
    const results = await Promise.all(rows.slice(i, i + SEND_CONCURRENCY).map((n) => sendOne(n, sender, at)))
    sent += results.filter(Boolean).length
  }
  return { sent, claimed: claimed.rows.length, outOfTime: false }
}

/**
 * A message about an order that has moved on is no longer true: a "confirmed"
 * for an order since cancelled, or a delivery code for an order no longer out
 * for delivery. Those are skipped, not sent late.
 */
function staleReason(n) {
  const s = n.order_status
  if (!s) return null
  if ((n.kind === 'ORDER_CONFIRMED' || n.kind === 'REPLACEMENT_CONFIRMED' || n.kind === 'DATE_MOVED') && s === 'CANCELLED') return 'order cancelled since'
  if (n.kind === 'OUT_FOR_DELIVERY' && s !== 'OUT_FOR_DELIVERY') return `order is ${s} now`
  if (n.kind === 'DELIVERY_FAILED' && (s === 'DELIVERED' || s === 'CANCELLED')) return `order is ${s} now`
  return null
}

/** Sends one claimed message and records the outcome. Returns true when sent. */
async function sendOne(n, sender, at) {
  if (at - n.created_at > MAX_AGE_MS) {
    await mark(n.id, { status: 'SKIPPED', last_error: 'older than a day' })
    return false
  }
  const stale = staleReason(n)
  if (stale) {
    await mark(n.id, { status: 'SKIPPED', last_error: stale })
    return false
  }
  if (!sender) {
    if (isProd) {
      logger.warn({ orderId: n.order_id, kind: n.kind }, 'no WhatsApp provider configured; update not sent')
      await mark(n.id, { status: 'SKIPPED', last_error: 'no WhatsApp provider configured' })
      return false
    }
    logger.info({ phone: maskPhone(n.phone), kind: n.kind, params: paramsFor(n), orderLink: orderLinkFor(n) }, `WhatsApp ${templateFor(n.kind)}`)
    await mark(n.id, { status: 'SENT', sent_at: at, provider_id: 'log' })
    return true
  }
  let providerId
  try {
    providerId = await sender({ phone: n.phone, template: templateFor(n.kind), params: paramsFor(n), urlParam: orderLinkFor(n) })
  } catch (err) {
    const attempts = n.attempts + 1
    // Meta refusing the request itself (bad number, unknown or paused template) won't change on a retry.
    const wait = err?.permanent ? null : RETRY_MINUTES.at(attempts - 1)
    logger.warn({ err, orderId: n.order_id, kind: n.kind, attempts }, 'WhatsApp update failed')
    if (wait == null) {
      await mark(n.id, { status: 'FAILED', attempts, last_error: String(err.message).slice(0, 500) })
      metrics.notificationsFailed.inc({ kind: n.kind })
    } else {
      await mark(n.id, { attempts, last_error: String(err.message).slice(0, 500), next_attempt_at: new Date(at.getTime() + wait * 60_000) })
    }
    return false
  }
  // Sent: record it outside the send's error handling, so a database hiccup
  // here can't schedule a second copy of a message that already went out.
  const fields = { status: 'SENT', sent_at: at, provider_id: providerId ?? null, attempts: n.attempts + 1, last_error: null }
  await mark(n.id, fields).catch(() => mark(n.id, fields)).catch((err) => logger.error({ err, id: n.id }, 'message sent but not recorded'))
  metrics.notificationsSent.inc({ kind: n.kind })
  return true
}

/**
 * Meta's delivery reports for messages we sent. "Accepted" at send time does
 * not mean delivered: a number not on WhatsApp, a paused template or a closed
 * window comes back later as a failed status. Returns how many rows changed.
 */
export async function recordDeliveryStatus(st) {
  if (!st?.id || !['delivered', 'read', 'failed'].includes(st.status)) return 0
  if (st.status === 'failed') {
    const why = (st.errors ?? []).map((e) => `${e.code ?? ''} ${e.title ?? e.message ?? ''}`.trim()).join('; ') || 'failed at WhatsApp'
    const r = await query(
      `UPDATE notifications SET status = 'FAILED', delivery_status = 'failed', last_error = $2 WHERE provider_id = $1 AND status = 'SENT'`,
      [st.id, `Not delivered: ${why}`.slice(0, 500)],
    )
    if (r.rowCount) metrics.notificationsFailed.inc({ kind: 'delivery' })
    return r.rowCount
  }
  const r = await query(`UPDATE notifications SET delivery_status = $2 WHERE provider_id = $1 AND (delivery_status IS DISTINCT FROM 'read')`, [st.id, st.status])
  return r.rowCount
}
