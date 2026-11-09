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
import { enqueueLinkPush, enqueueOrderPush } from './push.js'
import { eatByFor, readyOnFor, STAGE_WORDS, storageTip } from './ripeness.js'
import { otpMessageFailed } from './sms.js'
import { sendOutcome, templateName, whatsappSender } from './whatsapp.js'
import { refusal } from './wa/consent.js'
import { jitter, recordTemplateSent } from './wa/conversations.js'

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
  // The same order step as a browser notification, for a customer who turned them on (WEB_PUSH).
  await enqueueOrderPush(c, orderId, eventId, kind)
}

/** The Meta template a kind is sent with. The gift message reuses the out-for-delivery one, addressed to the recipient. */
export const templateFor = (kind) =>
  // The managers' evening summary (docs/growth.md) has its own full template name, without the prefix.
  kind === 'MANAGER_DAILY_SUMMARY' ? env.MANAGER_SUMMARY_TEMPLATE : templateName(kind === 'GIFT_OUT_FOR_DELIVERY' ? 'OUT_FOR_DELIVERY' : kind)

/**
 * The event a preorder message belongs to, the same however often it is queued, so a retried
 * step (a link sent again, a job run twice) adds no second message: booked and refunded
 * happen once per preorder, a spot opens once per promotion (payment_started_at) and a
 * move once per week moved (moved_count).
 */
const preorderEvent = (p, kind) => {
  if (kind === 'PREORDER_SPOT_OPEN') return `${p.id}:spot:${p.payment_started_at ? new Date(p.payment_started_at).getTime() : 0}`
  if (kind === 'PREORDER_MOVED') return `${p.id}:moved:${p.moved_count}`
  return p.id
}

/** Queues a preorder message (booked, spot open, moved, refunded). Queuing the same one again is a no-op. */
export async function enqueuePreorder(c, preorderId, kind) {
  const { rows } = await c.query('SELECT id, phone, payment_started_at, moved_count FROM preorders WHERE id = $1', [preorderId])
  if (!rows[0]?.phone) return
  const at = now()
  await c.query(
    `INSERT INTO notifications (id, preorder_id, event_id, kind, phone, next_attempt_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (event_id, kind) DO NOTHING`,
    [newId('ntf'), preorderId, preorderEvent(rows[0], kind), kind, rows[0].phone, at],
  )
}

/**
 * Customer care (docs/care.md): "we replied to your help request". The browser notification
 * goes whenever the customer has them on; WhatsApp only once Meta has approved
 * mandi_help_reply (WHATSAPP_CARE_UPDATES). `messageId` (the staff reply) makes a repeat a no-op.
 */
export async function enqueueHelpReply(c, ticketId, messageId) {
  const { rows } = await c.query('SELECT t.customer_id, cu.phone FROM help_tickets t JOIN customers cu ON cu.id = t.customer_id WHERE t.id = $1', [ticketId])
  const t = rows[0]
  if (!t) return
  if (env.WHATSAPP_CARE_UPDATES && t.phone) await addCareMessage(c, { helpTicketId: ticketId, eventId: messageId, kind: 'HELP_REPLY', phone: t.phone })
  await enqueueLinkPush(c, t.customer_id, messageId, 'HELP_REPLY', `/help/requests/${encodeURIComponent(ticketId)}`)
}

/**
 * Customer care: "your box for <date> is ready: pay for it here" when a subscription's cycle
 * is set up. Push as above; WhatsApp once Meta approves mandi_subscription_due. One per cycle
 * (the cycle id is the event), however often the scheduler runs.
 */
export async function enqueueCycleDue(c, cycleId) {
  const { rows } = await c.query(
    `SELECT s.id AS subscription_id, s.customer_id, cu.phone FROM subscription_cycles y JOIN subscriptions s ON s.id = y.subscription_id
       JOIN customers cu ON cu.id = s.customer_id WHERE y.id = $1`,
    [cycleId],
  )
  const y = rows[0]
  if (!y) return
  if (env.WHATSAPP_CARE_UPDATES && y.phone) await addCareMessage(c, { cycleId, eventId: cycleId, kind: 'SUBSCRIPTION_DUE', phone: y.phone })
  await enqueueLinkPush(c, y.customer_id, cycleId, 'SUBSCRIPTION_DUE', `/account/subscriptions/${encodeURIComponent(y.subscription_id)}`)
}

async function addCareMessage(c, { helpTicketId = null, cycleId = null, eventId, kind, phone }) {
  const at = now()
  await c.query(
    `INSERT INTO notifications (id, help_ticket_id, subscription_cycle_id, event_id, kind, phone, next_attempt_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (event_id, kind) DO NOTHING`,
    [newId('ntf'), helpTicketId, cycleId, eventId, kind, phone, at],
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

/** Queues a back-in-stock message for an alert: one per alert (the alert id is the event), however often it is queued. */
export async function enqueueAlert(c, alertId, phone) {
  const at = now()
  await c.query(
    `INSERT INTO notifications (id, stock_alert_id, event_id, kind, phone, next_attempt_at, created_at) VALUES ($1, $2, $3, 'BACK_IN_STOCK', $4, $5, $5)
     ON CONFLICT (event_id, kind) DO NOTHING`,
    [newId('ntf'), alertId, alertId, phone, at],
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
    case 'REFERRAL_REWARD':
      // "{{2}} off your next order of {{5}} or more: code {{3}}, until {{4}}" (docs/growth.md).
      // {{2}} is "10%" for a percent code, "Rs 100" for a flat one.
      return [name, n.reward_kind === 'PERCENT' ? `${n.reward_amount ?? 0}%` : rupees(n.reward_amount ?? 0), n.reward_code ?? '', n.reward_ends_on ? dateWords(n.reward_ends_on) : 'soon', rupees(n.reward_min ?? 0)]
    case 'FARM_BOOKING_UPDATE':
    case 'FARM_TEAM_ALERT':
      // Fixed when queued (farm/notify.js), so a late retry still says what happened then.
      return (n.farm_params ?? []).map(String)
    case 'PARTNER_ENQUIRY_RECEIVED':
    case 'PARTNER_TEAM_ALERT':
      // Fixed when queued (partner/alerts.js), so a late retry still says what happened then.
      return (n.partner_params ?? []).map(String)
    case 'MANAGER_DAILY_SUMMARY':
      // Made when the summary was taken (manager-summary.js), so a late retry still says what the day was.
      return (n.summary_params ?? []).map(String)
    case 'CLAIM_RECEIVED':
      return [name, n.number]
    case 'HELP_REPLY':
      return [name, n.help_number ?? '', `${shopUrl()}/help/requests/${n.help_ticket_id}`]
    case 'SUBSCRIPTION_DUE':
      return [name, `${n.sub_qty} × ${productName(n.sub_sku)}`, n.cycle_date ? dateWords(n.cycle_date) : 'your next delivery day', `${shopUrl()}/account/subscriptions/${n.sub_id}`]
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
            s.starts_at, s.ends_at, p.week_start, p.sku AS pre_sku, p.qty AS pre_qty, p.payment_link_url, p.status AS preorder_status,
            (SELECT json_agg(json_build_object('sku', i.sku, 'stage', i.stage) ORDER BY i.sku) FROM order_items i WHERE i.order_id = o.id) AS items,
            (SELECT i.sku FROM order_items i WHERE i.order_id = o.id ORDER BY i.line_price DESC LIMIT 1) AS last_product,
            a.sku AS alert_sku, a.stage AS alert_stage, a.available_on AS alert_date, a.cancelled_at AS alert_cancelled_at,
            COALESCE(o.customer_name, p.customer_name, ac.name, rc.name, cc.name) AS customer_name,
            (SELECT cl.resolution_note FROM claims cl WHERE cl.id = n.event_id AND n.kind = 'CLAIM_REJECTED') AS claim_reason,
            rr.promo_code AS reward_code, rr.amount AS reward_amount, rp.kind AS reward_kind, rp.ends_on AS reward_ends_on, rp.min_subtotal AS reward_min,
            rc.deleted_at AS reward_customer_deleted_at, rr.withdrawn_at AS reward_withdrawn_at,
            ms.params AS summary_params, ma.role AS summary_role, ma.daily_summary_opt_in AS summary_opt_in, ma.daily_summary_phone AS summary_phone,
            ht.number AS help_number, sb.id AS sub_id, sb.sku AS sub_sku, sb.qty AS sub_qty, sy.delivery_date AS cycle_date, sy.status AS cycle_status,
            sb.status AS subscription_status,
            COALESCE(o.customer_id, p.customer_id) AS target_customer_id,
            (SELECT cu.reminders_opt_in FROM customers cu WHERE cu.id = o.customer_id) AS reminders_opt_in,
            wc.updates AS consent_updates, wc.marketing AS consent_marketing, wau.enabled AS automation_enabled
       FROM notifications n LEFT JOIN orders o ON o.id = n.order_id LEFT JOIN preorders p ON p.id = n.preorder_id
       LEFT JOIN wa_consent wc ON wc.phone = n.phone LEFT JOIN wa_automations wau ON wau.kind = n.kind
       LEFT JOIN delivery_slots s ON s.id = o.slot_id
       LEFT JOIN stock_alerts a ON a.id = n.stock_alert_id LEFT JOIN customers ac ON ac.id = a.customer_id
       LEFT JOIN referral_rewards rr ON rr.id = n.referral_reward_id LEFT JOIN customers rc ON rc.id = rr.customer_id
       LEFT JOIN promo_codes rp ON rp.code = rr.promo_code
       LEFT JOIN manager_summaries ms ON ms.id = n.manager_summary_id LEFT JOIN admin_users ma ON ma.id = ms.admin_id
       LEFT JOIN help_tickets ht ON ht.id = n.help_ticket_id
       LEFT JOIN subscription_cycles sy ON sy.id = n.subscription_cycle_id LEFT JOIN subscriptions sb ON sb.id = sy.subscription_id
       LEFT JOIN customers cc ON cc.id = COALESCE(ht.customer_id, sb.customer_id)
      WHERE n.id = ANY($1) ORDER BY n.created_at`,
    [claimed.rows.map((r) => r.id)],
  )
  // Meta's last word on each template (empty until the first template sync): a paused or
  // rejected template is not used, and its messages wait as SKIPPED with the reason.
  const templates = new Map((await query('SELECT name, status, body_params FROM wa_templates WHERE language = $1', [env.WHATSAPP_LANGUAGE])).rows.map((t) => [t.name, t]))
  for (const n of rows) n.templates = templates
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
  if (env.PROVIDER_CHECKS) {
    const why = staleSince(n)
    if (why) return why
  }
  // docs/growth.md: a thank-you for an account deleted since, and a summary for someone who
  // opted out, stopped being a manager or changed the number since it was made.
  if (n.kind === 'REFERRAL_REWARD' && n.reward_customer_deleted_at) return 'account deleted since'
  if (n.kind === 'REFERRAL_REWARD' && n.reward_withdrawn_at) return 'thank-you code withdrawn since'
  if (n.kind === 'MANAGER_DAILY_SUMMARY') {
    if (n.summary_role !== 'MANAGER' || !n.summary_opt_in) return 'summary turned off since'
    if (n.summary_phone !== n.phone) return 'number changed since'
  }
  // A "pay for this box" reminder once the box is paid for, skipped or the subscription stopped is no longer true.
  if (n.kind === 'SUBSCRIPTION_DUE' && (n.cycle_status !== 'DUE' || n.subscription_status !== 'ACTIVE')) return `cycle is ${n.cycle_status ?? 'gone'} now`
  const s = n.order_status
  if (!s) return null
  if ((n.kind === 'ORDER_CONFIRMED' || n.kind === 'REPLACEMENT_CONFIRMED' || n.kind === 'DATE_MOVED') && s === 'CANCELLED') return 'order cancelled since'
  if (n.kind === 'OUT_FOR_DELIVERY' && s !== 'OUT_FOR_DELIVERY') return `order is ${s} now`
  if (n.kind === 'DELIVERY_FAILED' && (s === 'DELIVERED' || s === 'CANCELLED')) return `order is ${s} now`
  return null
}

/**
 * INT-04 (24 Oct audit, PROVIDER_CHECKS): the messages staleReason did not
 * re-check. A ripeness guide or review request for an order cancelled since;
 * a booking's "booked" or "moved" after it was cancelled; a "spot open" link
 * once the spot is paid, lapsed or cancelled; back-in-stock for an alert the
 * customer cancelled.
 */
function staleSince(n) {
  const s = n.order_status
  if ((n.kind === 'RIPENESS_GUIDE' || n.kind === 'REVIEW_REQUEST') && s === 'CANCELLED') return 'order cancelled since'
  if (n.kind === 'REVIEW_REQUEST' && s && s !== 'DELIVERED') return `order is ${s} now`
  const p = n.preorder_status
  if ((n.kind === 'PREORDER_BOOKED' || n.kind === 'PREORDER_MOVED') && p === 'CANCELLED') return 'booking cancelled since'
  if (n.kind === 'PREORDER_SPOT_OPEN' && p && p !== 'PAYMENT_PENDING') return `booking is ${p} now`
  if (n.kind === 'BACK_IN_STOCK' && n.alert_cancelled_at) return 'alert cancelled since'
  return null
}

/** Sends one claimed message and records the outcome. Returns true when sent. */
async function sendOne(n, sender, at) {
  if (at - n.created_at > MAX_AGE_MS) {
    // OPS_ALERTS: next_attempt_at records when it was given up, for checkHealth (INT-06).
    await mark(n.id, { status: 'SKIPPED', last_error: 'older than a day', ...(env.OPS_ALERTS ? { next_attempt_at: at } : {}) })
    return false
  }
  const stale = staleReason(n)
  if (stale) {
    await mark(n.id, { status: 'SKIPPED', last_error: stale })
    return false
  }
  // docs/whatsapp/CONSENT.md and AUTOMATIONS: a manager's switch, the customer's STOP, and
  // promotional messages only with an opt-in. Checked at send time, so a STOP sent after the
  // message was queued still counts.
  const gate = sendGate(n)
  if (gate) {
    await mark(n.id, { status: 'SKIPPED', last_error: gate })
    return false
  }
  const params = paramsFor(n)
  const known = n.templates?.get(templateFor(n.kind))
  if (known && known.status !== 'APPROVED') {
    await mark(n.id, { status: 'SKIPPED', last_error: `template ${templateFor(n.kind)} is ${known.status} at Meta, not approved` })
    return false
  }
  if (known && known.body_params != null && known.body_params !== params.length) {
    // Meta would refuse it (wrong number of variables): stop before calling, with the reason.
    await mark(n.id, { status: 'FAILED', last_error: `template ${templateFor(n.kind)} takes ${known.body_params} variables, this message has ${params.length}` })
    metrics.notificationsFailed.inc({ kind: n.kind })
    return false
  }
  if (!sender) {
    if (isProd) {
      logger.warn({ orderId: n.order_id, kind: n.kind }, 'no WhatsApp provider configured; update not sent')
      await mark(n.id, { status: 'SKIPPED', last_error: 'no WhatsApp provider configured', ...(env.OPS_ALERTS ? { next_attempt_at: at } : {}) })
      return false
    }
    logger.info({ phone: maskPhone(n.phone), kind: n.kind, params, orderLink: orderLinkFor(n) }, `WhatsApp ${templateFor(n.kind)}`)
    await mark(n.id, { status: 'SENT', sent_at: at, provider_id: 'log' })
    await recordTemplateSent({ phone: n.phone, customerId: n.target_customer_id, template: templateFor(n.kind), summary: updateSummary(n), providerId: null, notificationId: n.id })
    return true
  }
  let providerId
  try {
    providerId = await sender({ phone: n.phone, template: templateFor(n.kind), params, urlParam: orderLinkFor(n) })
  } catch (err) {
    const attempts = n.attempts + 1
    const outcome = sendOutcome(err)
    logger.warn({ err, orderId: n.order_id, kind: n.kind, attempts, outcome }, 'WhatsApp update failed')
    if (outcome === 'unknown') {
      // No answer in time: Meta may have sent it. Not resent automatically (two delivery codes,
      // two "confirmed" messages); a delivered or read status that comes later can't be matched
      // without Meta's id, so staff decide on the WhatsApp page (Send again).
      await mark(n.id, { status: 'FAILED', delivery_status: 'unknown', attempts, last_error: `UNKNOWN: ${String(err.message).slice(0, 380)}. WhatsApp may have delivered it; not resent automatically` })
      metrics.notificationsFailed.inc({ kind: n.kind })
      return false
    }
    // Meta refusing the request itself (bad number, unknown or paused template) won't change on a retry.
    const wait = err?.permanent || outcome === 'permanent' ? null : RETRY_MINUTES.at(attempts - 1)
    if (wait == null) {
      await mark(n.id, { status: 'FAILED', attempts, last_error: String(err.message).slice(0, 500) })
      metrics.notificationsFailed.inc({ kind: n.kind })
    } else {
      await mark(n.id, { attempts, last_error: String(err.message).slice(0, 500), next_attempt_at: new Date(at.getTime() + jitter(wait * 60_000)) })
    }
    return false
  }
  // Sent: record it outside the send's error handling, so a database hiccup
  // here can't schedule a second copy of a message that already went out.
  const fields = { status: 'SENT', sent_at: at, provider_id: providerId ?? null, attempts: n.attempts + 1, last_error: null }
  await mark(n.id, fields).catch(() => mark(n.id, fields)).catch((err) => logger.error({ err, id: n.id }, 'message sent but not recorded'))
  metrics.notificationsSent.inc({ kind: n.kind })
  await recordTemplateSent({ phone: n.phone, customerId: n.target_customer_id, template: templateFor(n.kind), summary: updateSummary(n), providerId: providerId ?? null, notificationId: n.id })
  return true
}

/** How an order update reads in its conversation (no delivery code: staff never need it there). */
const updateSummary = (n) => `Update sent: ${n.kind.toLowerCase().replaceAll('_', ' ')}${n.number ? ` (${n.number})` : ''}`

/** Why a queued message may not go now (switch, consent), or null. */
function sendGate(n) {
  if (n.automation_enabled === false) return 'turned off on the WhatsApp page'
  return refusal(n.kind, { updates: n.consent_updates ?? 'ALLOWED', marketing: n.consent_marketing ?? 'NONE' }, { optIn: n.kind === 'REORDER_REMINDER' && Boolean(n.reminders_opt_in) })
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
    // INT-10: not an order update: perhaps a login code (sms.js).
    else if (env.PROVIDER_CHECKS && (await otpMessageFailed(st.id))) return 1
    return r.rowCount
  }
  const r = await query(`UPDATE notifications SET delivery_status = $2 WHERE provider_id = $1 AND (delivery_status IS DISTINCT FROM 'read')`, [st.id, st.status])
  return r.rowCount
}
