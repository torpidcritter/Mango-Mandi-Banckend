// Customer order updates. A notification row is written in the same
// transaction as the order change that causes it (an outbox), so a rolled-back
// change sends nothing and a committed one is never lost; the maintenance loop
// sends due rows and retries failures with backoff.
import { now } from './clock.js'
import { query } from './db.js'
import { isProd } from './env.js'
import { newId } from './ids.js'
import { logger } from './logger.js'
import { metrics } from './metrics.js'
import { productName } from './products.js'
import { templateName, whatsappSender } from './whatsapp.js'

const RETRY_MINUTES = [1, 5, 15, 60, 180]
const MAX_AGE_MS = 24 * 3_600_000 // an update older than a day is no longer news
const CLAIM_MS = 5 * 60_000 // how long a claimed message is left alone if its sender dies

/** The message an order event sends, if any. */
function kindFor(from, to, order) {
  if (from === to) return null
  if (to === 'CONFIRMED') return order.replacement_for ? 'REPLACEMENT_CONFIRMED' : 'ORDER_CONFIRMED'
  if (to === 'OUT_FOR_DELIVERY' || to === 'DELIVERED' || to === 'DELIVERY_FAILED') return to
  // Unpaid orders (abandoned checkouts, expired holds) are cancelled silently.
  if (to === 'CANCELLED' && from !== 'PAYMENT_PENDING' && from !== null) return 'CANCELLED'
  return null
}

export async function enqueue(c, orderId, eventId, kind) {
  const { rows } = await c.query('SELECT phone FROM orders WHERE id = $1', [orderId])
  if (!rows[0]?.phone) return
  const at = now()
  await c.query(
    `INSERT INTO notifications (id, order_id, event_id, kind, phone, next_attempt_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (event_id, kind) DO NOTHING`,
    [newId('ntf'), orderId, eventId, kind, rows[0].phone, at],
  )
}

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
}

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
    `SELECT n.*, COALESCE(o.number, p.number) AS number, COALESCE(o.customer_name, p.customer_name) AS customer_name,
            o.delivery_date, o.delivery_code, COALESCE(o.total, p.total) AS total, COALESCE(o.payment_amount, p.paid_amount) AS payment_amount,
            s.starts_at, s.ends_at, p.week_start, p.sku AS pre_sku, p.qty AS pre_qty, p.payment_link_url
       FROM notifications n LEFT JOIN orders o ON o.id = n.order_id LEFT JOIN preorders p ON p.id = n.preorder_id
       LEFT JOIN delivery_slots s ON s.id = o.slot_id
      WHERE n.id = ANY($1) ORDER BY n.created_at`,
    [claimed.rows.map((r) => r.id)],
  )
  let sent = 0
  for (const n of rows) {
    if (at - n.created_at > MAX_AGE_MS) {
      await mark(n.id, { status: 'SKIPPED', last_error: 'older than a day' })
      continue
    }
    if (!sender) {
      if (isProd) {
        logger.warn({ orderId: n.order_id, kind: n.kind }, 'no WhatsApp provider configured; update not sent')
        await mark(n.id, { status: 'SKIPPED', last_error: 'no WhatsApp provider configured' })
      } else {
        logger.info({ phone: n.phone, kind: n.kind, params: paramsFor(n) }, `WhatsApp ${templateName(n.kind)}`)
        await mark(n.id, { status: 'SENT', sent_at: at, provider_id: 'log' })
        sent++
      }
      continue
    }
    try {
      const providerId = await sender({ phone: n.phone, template: templateName(n.kind), params: paramsFor(n) })
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
