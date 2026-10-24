// Razorpay adapter, webhook verification and payment reconciliation.
// Without API keys (development and tests) an in-memory dev gateway stands in.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { background } from './background.js'
import { canStartCall } from './budget.js'
import { now } from './clock.js'
import { getConfig } from './config.js'
import { query, tx } from './db.js'
import { env, isProd } from './env.js'
import { HttpError } from './errors.js'
import { newId } from './ids.js'
import { logger } from './logger.js'
import { enqueue } from './notify.js'
import { addEvent, processPayment, SYSTEM } from './orders.js'
import { findPreorderId, processPreorderPayment, refundPreorder } from './preorders.js'

const hasKeys = () => Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET)
const RAZORPAY = 'https://api.razorpay.com/v1'
/** Each Razorpay call gives up after 10 seconds; loops stop when less than this is left. */
export const GATEWAY_CALL_MS = 12_000

/** razorpayOrderId or payment link id → { status: 'captured' | 'failed', id, amount } */
export const devGateway = new Map()

async function razorpay(method, path, body) {
  const res = await fetch(`${RAZORPAY}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Razorpay ${method} ${path} failed: ${res.status}`)
  return res.json()
}

/**
 * OPS-07: a 200 from Razorpay is checked before we store anything from it.
 * Ids carry Razorpay's prefixes (order_, plink_, rfnd_, pay_); a reply without
 * one throws, so the caller's existing abandon or retry path runs.
 */
export function gatewayId(obj, prefix, what) {
  const id = obj?.id
  if (typeof id !== 'string' || !id.startsWith(prefix) || id.length > 64) throw new Error(`Razorpay ${what} reply has no valid ${prefix} id`)
  return id
}

/** A list reply ({ items: [...] }) whose items each have a payment or refund id, a status and an integer amount. */
export function gatewayItems(obj, prefix, what) {
  const items = obj?.items ?? []
  if (!Array.isArray(items)) throw new Error(`Razorpay ${what} reply has no item list`)
  for (const it of items) {
    gatewayId(it, prefix, what)
    if (typeof it.status !== 'string' || !Number.isInteger(it.amount)) throw new Error(`Razorpay ${what} reply has an item without status or amount`)
  }
  return items
}

export async function createGatewayOrder({ amount, receipt, orderId }) {
  if (hasKeys()) {
    const o = await razorpay('POST', '/orders', { amount, currency: 'INR', receipt, notes: { orderId } })
    return gatewayId(o, 'order_', 'create order')
  }
  if (isProd) throw new HttpError(503, 'PAYMENTS_UNAVAILABLE', 'Payments are not configured')
  return `order_dev_${newId('rzp').slice(4)}`
}

/**
 * A Razorpay payment link for an order placed in the WhatsApp chat. Razorpay
 * does not send its own SMS or email; the link goes out in the chat.
 */
// After paying a preorder link, Razorpay sends the customer back to the shop.
const shopOrigin = () => env.CUSTOMER_ORIGIN.split(',')[0]?.trim().replace(/\/$/, '') || null

/**
 * When a payment link stops taking payments, in unix seconds. The hold is 10
 * minutes; Razorpay's shortest expiry is 15, so links close 16 minutes after
 * they are made. A payment in between is a late payment and is honoured (the
 * order goes to the next date with stock). Without an expiry a link could be
 * paid days later.
 */
export const linkExpiresAt = (at = now()) => Math.floor(at.getTime() / 1000) + Math.max(16 * 60, getConfig().holdMinutes * 60 + 6 * 60)

export async function createPaymentLink({ amount, number, orderId, preorderId, name, phone, description, holdUntil = null }) {
  if (hasKeys()) {
    // PAY-01: a link must stay open as long as the hold it pays for (a waitlist spot is held for hours).
    const expireBy = Math.max(linkExpiresAt(), holdUntil ? Math.floor(new Date(holdUntil).getTime() / 1000) + 6 * 60 : 0)
    const link = await razorpay('POST', '/payment_links', {
      amount, currency: 'INR', accept_partial: false, reference_id: number, expire_by: expireBy, description: description ?? `MandiMangoes order ${number}`,
      customer: { name: name ?? undefined, contact: phone }, notify: { sms: false, email: false }, reminder_enable: false,
      notes: preorderId ? { preorderId } : { orderId },
      ...(preorderId && shopOrigin() ? { callback_url: `${shopOrigin()}/preorders/${preorderId}`, callback_method: 'get' } : {}),
    })
    if (typeof link?.short_url !== 'string' || !/^https:\/\//.test(link.short_url)) throw new Error('Razorpay payment link reply has no https short_url')
    return { id: gatewayId(link, 'plink_', 'payment link'), url: link.short_url }
  }
  if (isProd) throw new HttpError(503, 'PAYMENTS_UNAVAILABLE', 'Payments are not configured')
  const id = `plink_dev_${newId('l').slice(2)}`
  return { id, url: `https://rzp.io/i/${id}` }
}

export async function fetchLinkPayments(linkId) {
  if (hasKeys()) {
    const link = await razorpay('GET', `/payment_links/${encodeURIComponent(linkId)}`)
    const list = link?.payments ?? []
    if (!Array.isArray(list)) throw new Error('Razorpay payment link reply has no payment list')
    const payments = list.map((p) => ({ id: p.payment_id, status: p.status, amount: p.amount, method: p.method }))
    gatewayItems({ items: payments }, 'pay_', 'payment link payments')
    return payments
  }
  if (isProd) return []
  const p = devGateway.get(linkId)
  return p ? [p] : []
}

async function fetchPayments(razorpayOrderId) {
  if (hasKeys()) return gatewayItems(await razorpay('GET', `/orders/${encodeURIComponent(razorpayOrderId)}/payments`), 'pay_', 'order payments')
  if (isProd) return []
  const p = devGateway.get(razorpayOrderId)
  return p ? [p] : []
}

const hmacMatches = (secret, data, signature) => {
  if (!secret || typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false
  return timingSafeEqual(createHmac('sha256', secret).update(data).digest(), Buffer.from(signature, 'hex'))
}

/**
 * Checks a webhook's x-razorpay-signature against the raw body. During a
 * secret rotation (PAY-B12) Razorpay may still retry older events signed with
 * the old secret, so RAZORPAY_WEBHOOK_SECRET_PREVIOUS is accepted too while it
 * is set (remove it a day after the rotation).
 */
export function verifySignature(raw, signature) {
  return hmacMatches(env.RAZORPAY_WEBHOOK_SECRET, raw, signature) || hmacMatches(env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS, raw, signature)
}

/** Without keys (development, tests) Checkout replies are signed with this stand-in secret. */
export const DEV_CHECKOUT_SECRET = 'rzp_dev_checkout_secret'

/**
 * PAY-B3: Razorpay Standard Checkout hands the page razorpay_order_id,
 * razorpay_payment_id and razorpay_signature, the HMAC-SHA256 of
 * `order_id|payment_id` keyed with the API key secret. Constant-time compare.
 */
export function verifyCheckoutSignature(razorpayOrderId, paymentId, signature) {
  const secret = hasKeys() ? env.RAZORPAY_KEY_SECRET : isProd ? null : DEV_CHECKOUT_SECRET
  return hmacMatches(secret, `${razorpayOrderId}|${paymentId}`, signature)
}

/**
 * Finds our order for a Razorpay payment. Only ids Razorpay itself assigned
 * are trusted: our Razorpay order id, or the payment link's id. The payment's
 * `notes` are set by whoever opens Checkout, so a notes-only match is used
 * just for payment-link orders (Razorpay copies the link's notes onto its
 * payments), and the amount check in checkCapture still has to pass.
 */
async function findOrderId(c, entity, link = null) {
  if (link?.id) {
    const { rows } = await c.query('SELECT id FROM orders WHERE payment_link_id = $1', [link.id])
    if (rows.length) return rows[0].id
  }
  if (entity.order_id) {
    const { rows } = await c.query('SELECT id FROM orders WHERE razorpay_order_id = $1', [entity.order_id])
    if (rows.length) return rows[0].id
  }
  const noted = link?.notes?.orderId ?? entity.notes?.orderId
  if (typeof noted === 'string' && noted) {
    const { rows } = await c.query('SELECT id FROM orders WHERE id = $1 AND payment_link_id IS NOT NULL', [noted])
    if (rows.length) return rows[0].id
  }
  return null
}

/**
 * Applies one captured payment found by polling Razorpay (reconcile, replay)
 * after the same checks a webhook gets. Returns the result, or 'rejected'.
 */
export async function applyCapture(c, table, id, p) {
  if (await checkCapture(c, { table, id, paymentId: p.id, amount: p.amount, currency: p.currency })) return 'rejected'
  if (table === 'preorders') {
    return processPreorderPayment(c, { preorderId: id, outcome: 'captured', paymentId: p.id, amount: p.amount, method: p.method })
  }
  return (await processPayment(c, { orderId: id, outcome: 'captured', paymentId: p.id, amount: p.amount, method: p.method })).result
}

/**
 * Checks a captured payment against what we charged before it may confirm
 * anything: it has a payment id, it is in rupees, and it is for the full
 * amount. A payment that fails the check confirms nothing; it is logged for
 * the Needs attention view and, when it has an id, refunded like a duplicate
 * (it bought nothing). Returns null when the payment is fine, else a reason.
 */
export async function checkCapture(c, { table, id, paymentId, amount, currency }) {
  const { rows } = await c.query(`SELECT total, payment_id FROM ${table === 'preorders' ? 'preorders' : 'orders'} WHERE id = $1`, [id])
  const total = rows[0]?.total
  let reason = null
  if (!paymentId) reason = 'captured payment has no payment id'
  else if (currency != null && currency !== 'INR') reason = `captured payment is in ${currency}, not INR`
  else if (typeof amount !== 'number') reason = 'captured payment has no amount'
  else if (amount !== total) reason = `captured ${amount} but the total is ${total}`
  if (!reason) return null
  // Already rejected once (a webhook retry, or the reconcile loop seeing it again): don't log it twice.
  if (paymentId && (await c.query('SELECT 1 FROM duplicate_payments WHERE payment_id = $1', [paymentId])).rowCount) return reason
  logger.error({ table, id, paymentId, amount, currency, total }, `payment rejected: ${reason}`)
  await recordWebhookFailure('razorpay', `Payment ${paymentId ?? '(no id)'} for ${id} not accepted: ${reason}`, paymentId, c)
  if (paymentId && paymentId !== rows[0]?.payment_id) {
    await c.query(
      `INSERT INTO duplicate_payments (payment_id, order_id, preorder_id, amount, found_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [paymentId, table === 'preorders' ? null : id, table === 'preorders' ? id : null, typeof amount === 'number' ? amount : null, now()],
    )
  }
  return reason
}

/** Records a webhook that failed or could not be matched, for the Needs attention view. Never throws. */
export async function recordWebhookFailure(source, reason, eventKey = null, c = { query }, paymentId = null) {
  await c
    .query('INSERT INTO webhook_failures (id, source, reason, event_key, created_at, payment_id) VALUES ($1, $2, $3, $4, $5, $6)', [
      newId('whf'), source, String(reason).slice(0, 500), eventKey ? String(eventKey).slice(0, 200) : null, now(),
      typeof paymentId === 'string' && paymentId ? paymentId.slice(0, 64) : null,
    ])
    .catch((err) => logger.error({ err }, 'could not record a webhook failure'))
}

/**
 * The ids in a Razorpay webhook that tie it to Razorpay's dashboard: the event
 * id (x-razorpay-event-id header) and the payment, order, link and refund ids
 * in the body. No personal data. Logged with our request id for each webhook.
 */
export function razorpayIds(event, eventId) {
  const id = (v) => (typeof v === 'string' && v ? v.slice(0, 64) : undefined)
  const p = event?.payload ?? {}
  return {
    razorpayEvent: id(event?.event),
    razorpayEventId: id(eventId),
    paymentId: id(p.payment?.entity?.id) ?? id(p.refund?.entity?.payment_id),
    razorpayOrderId: id(p.payment?.entity?.order_id),
    paymentLinkId: id(p.payment_link?.entity?.id),
    refundId: id(p.refund?.entity?.id),
  }
}

/**
 * Handles one verified webhook body. The dedupe row is written in the same
 * transaction, so a processing error rolls it back and Razorpay's retry runs.
 */
export async function handleWebhook(event, eventId) {
  const kind = event?.event
  if (kind === 'refund.processed' || kind === 'refund.failed') return handleRefundEvent(event, eventId)
  if (typeof kind === 'string' && kind.startsWith('payment.dispute.')) return handleDisputeEvent(event, eventId)
  if (kind === 'payment.authorized') {
    // PAY-B1: the capture call can take seconds; Razorpay gets its 200 first.
    // The payment.captured webhook (or the reconcile loop) confirms the order.
    background(captureAuthorized(event.payload?.payment?.entity ?? {}))
    return { result: 'capture_queued' }
  }
  if (kind !== 'payment.captured' && kind !== 'payment.failed' && kind !== 'payment_link.paid') return { ignored: true }
  const entity = event.payload?.payment?.entity ?? {}
  const link = kind === 'payment_link.paid' ? (event.payload?.payment_link?.entity ?? {}) : null
  const dedupeKey = eventId || `${kind}:${entity.id ?? link?.id}`
  return await tx(async (c) => {
    const ins = await c.query('INSERT INTO processed_webhooks (dedupe_key, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [dedupeKey, now()])
    if (!ins.rowCount) return { duplicate: true }
    const orderId = await findOrderId(c, entity, link)
    if (!orderId) {
      const preorderId = await findPreorderId(c, entity, link)
      if (preorderId) {
        if (kind !== 'payment.failed') {
          const bad = await checkCapture(c, { table: 'preorders', id: preorderId, paymentId: entity.id, amount: entity.amount, currency: entity.currency })
          if (bad) return { result: 'rejected', preorderId, reason: bad }
        }
        const r = await processPreorderPayment(c, {
          preorderId, outcome: kind === 'payment.failed' ? 'failed' : 'captured', paymentId: entity.id ?? null,
          amount: typeof entity.amount === 'number' ? entity.amount : null, method: entity.method ?? null,
        })
        return { result: r, preorderId }
      }
      // A payment on a booking's link: its notes name the booking, but notes
      // can be set by whoever pays (PAY-B11), so it is not applied from here.
      // payment_link.paid (or the preorder reconcile) books it.
      const noted = typeof entity.notes?.preorderId === 'string' ? entity.notes.preorderId : null
      if (!link && noted && (await c.query('SELECT 1 FROM preorders WHERE id = $1 AND payment_link_id IS NOT NULL', [noted])).rowCount) {
        return { ignored: true, awaiting: 'payment_link.paid' }
      }
      logger.warn({ razorpayOrderId: entity.order_id }, 'webhook for an unknown order')
      // The payment id is kept for a captured payment, so a manager can refund it from Needs attention.
      const captured = kind !== 'payment.failed' ? entity.id : null
      await recordWebhookFailure('razorpay', `${kind} for an order we don't have (${entity.order_id ?? link?.id ?? 'no id'}${captured ? `, payment ${captured}` : ''})`, dedupeKey, c, captured)
      return { unknownOrder: true }
    }
    if (kind !== 'payment.failed') {
      const bad = await checkCapture(c, { table: 'orders', id: orderId, paymentId: entity.id, amount: entity.amount, currency: entity.currency })
      if (bad) return { result: 'rejected', orderId, reason: bad }
    }
    const r = await processPayment(c, {
      orderId,
      outcome: kind === 'payment.failed' ? 'failed' : 'captured',
      paymentId: entity.id ?? null,
      amount: typeof entity.amount === 'number' ? entity.amount : null,
      method: entity.method ?? null,
    })
    return { result: r.result, orderId }
  }).then((out) => {
    // PAY-B1: Razorpay waits 5 seconds for the answer, and a refund is up to
    // two gateway calls, so refunds go out after the response.
    background(sendDueRefunds(refundsFor(out)))
    return out
  })
}

/** Which refunds a payment result made due: { orderId, preorderId, duplicates }. */
export function refundsFor(out) {
  const due = out?.result === 'refund_due'
  return {
    orderId: due ? (out.orderId ?? null) : null,
    preorderId: due ? (out.preorderId ?? null) : null,
    duplicates: out?.result === 'duplicate_payment' || out?.result === 'rejected',
  }
}

/**
 * The one way a request sends refunds it made due: the webhook (after its
 * response), the customer cancel and the dev routes. Each refund is leased
 * (claimRefund) and looked up at Razorpay before anything is posted, so this
 * and the maintenance loop can't pay twice, and anything that fails here is
 * retried by maintenance (processDueRefunds, refundDuplicatePayments). Never throws.
 */
export async function sendDueRefunds({ orderId = null, preorderId = null, duplicates = false } = {}) {
  const log = (what) => (err) => logger.error({ err, orderId, preorderId }, `${what} refund failed; maintenance will retry`)
  if (orderId) await refundOrder(orderId).catch(log('order'))
  if (preorderId) await refundPreorder(preorderId).catch(log('preorder'))
  if (duplicates) await refundDuplicatePayments().catch(log('duplicate payment'))
}

const DISPUTE_DONE = ['won', 'lost', 'closed']

/**
 * PAY-B12: a chargeback. Recorded (one row per dispute, updated by each
 * later event) and shown in Needs attention until it is won, lost or closed;
 * the response to the bank is made in the Razorpay dashboard. Nothing is
 * automated. The fields read here (payload.dispute.entity with id,
 * payment_id, amount, currency, reason_code, respond_by, status) are not yet
 * checked against a recorded payload (PAY-B8), so every one is optional.
 */
async function handleDisputeEvent(event, eventId) {
  const kind = event.event
  const d = event.payload?.dispute?.entity ?? {}
  const pay = event.payload?.payment?.entity ?? {}
  const paymentId = typeof d.payment_id === 'string' ? d.payment_id : typeof pay.id === 'string' ? pay.id : null
  const disputeId = typeof d.id === 'string' && d.id ? d.id.slice(0, 64) : paymentId ? `payment:${paymentId}` : null
  if (!disputeId) {
    await recordWebhookFailure('razorpay', `${kind} without a dispute or payment id`, eventId ?? kind)
    return { ignored: true }
  }
  const dedupeKey = eventId || `${kind}:${disputeId}`
  return tx(async (c) => {
    const ins = await c.query('INSERT INTO processed_webhooks (dedupe_key, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [dedupeKey, now()])
    if (!ins.rowCount) return { duplicate: true }
    const o = paymentId ? (await c.query('SELECT id, status FROM orders WHERE payment_id = $1', [paymentId])).rows[0] : null
    const p = paymentId && !o ? (await c.query('SELECT id FROM preorders WHERE payment_id = $1', [paymentId])).rows[0] : null
    const status = String(d.status ?? kind.slice('payment.dispute.'.length) ?? 'open').slice(0, 40) || 'open'
    const respondBy = Number.isInteger(d.respond_by) ? new Date(d.respond_by * 1000) : null
    await c.query(
      `INSERT INTO payment_disputes (dispute_id, payment_id, order_id, preorder_id, amount, currency, status, reason_code, respond_by, last_event, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
       ON CONFLICT (dispute_id) DO UPDATE SET status = EXCLUDED.status, last_event = EXCLUDED.last_event, updated_at = EXCLUDED.updated_at,
         amount = COALESCE(EXCLUDED.amount, payment_disputes.amount), respond_by = COALESCE(EXCLUDED.respond_by, payment_disputes.respond_by),
         reason_code = COALESCE(EXCLUDED.reason_code, payment_disputes.reason_code)`,
      [
        disputeId, paymentId, o?.id ?? null, p?.id ?? null, Number.isInteger(d.amount) ? d.amount : null,
        typeof d.currency === 'string' ? d.currency.slice(0, 8) : null, status,
        typeof d.reason_code === 'string' ? d.reason_code.slice(0, 80) : null, respondBy, kind.slice(0, 60), now(),
      ],
    )
    if (o) await addEvent(c, o.id, o.status, o.status, SYSTEM, `Payment dispute (chargeback) ${disputeId}: ${status}`)
    logger.error({ disputeId, paymentId, orderId: o?.id, preorderId: p?.id, status }, 'payment dispute from Razorpay')
    return { result: 'dispute_recorded', disputeId, open: !DISPUTE_DONE.includes(status) }
  })
}

/**
 * If the Razorpay account is set to capture payments by hand, a payment stops
 * at "authorized" and Razorpay refunds it on its own days later. We capture
 * any authorized payment that matches an order in full, so confirmation never
 * depends on that dashboard setting. (With automatic capture, which is the
 * expected setting, Razorpay answers that it is already captured.) The
 * payment.captured webhook that follows confirms the order as usual.
 */
async function captureAuthorized(entity) {
  if (!entity.id || !entity.order_id) return { ignored: true }
  const { rows } = await query('SELECT id, total FROM orders WHERE razorpay_order_id = $1', [entity.order_id])
  const o = rows[0]
  if (!o || entity.amount !== o.total || (entity.currency ?? 'INR') !== 'INR') return { ignored: true }
  if (!hasKeys()) return { ignored: true }
  try {
    await razorpay('POST', `/payments/${encodeURIComponent(entity.id)}/capture`, { amount: entity.amount, currency: 'INR' })
    return { result: 'capture_requested', orderId: o.id }
  } catch (err) {
    logger.info({ err, paymentId: entity.id }, 'capture of an authorized payment not needed or not possible')
    return { result: 'capture_skipped', orderId: o.id }
  }
}

/**
 * Razorpay tells us how a refund ended. A refund is recorded as done when
 * Razorpay accepts it (refunded_at), because most finish within days; if one
 * later fails, the record is reopened so the maintenance loop sends a new one,
 * and it shows in Needs attention.
 */
async function handleRefundEvent(event, eventId) {
  const r = event.payload?.refund?.entity ?? {}
  if (!r.id) return { ignored: true }
  const dedupeKey = eventId || `${event.event}:${r.id}`
  const failed = event.event === 'refund.failed'
  return await tx(async (c) => {
    const ins = await c.query('INSERT INTO processed_webhooks (dedupe_key, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [dedupeKey, now()])
    if (!ins.rowCount) return { duplicate: true }
    const hit = await applyRefundOutcome(c, r.id, failed)
    if (failed) {
      logger.error({ refundId: r.id, paymentId: r.payment_id }, 'refund failed at Razorpay; will retry')
      await recordWebhookFailure(
        'razorpay',
        hit
          ? `Refund ${r.id} for payment ${r.payment_id ?? '?'} failed at Razorpay; a new refund will be sent`
          : `Refund ${r.id} for payment ${r.payment_id ?? '?'} failed at Razorpay and matches no refund we recorded: check the payment in Razorpay`,
        r.id,
        c,
      )
    }
    return { result: failed ? 'refund_failed' : 'refund_processed', matched: hit }
  })
}

/**
 * Records how a refund ended at Razorpay on whichever row holds it. A failed
 * refund reopens the row, so the maintenance loop sends a new one. Returns
 * how many rows matched.
 */
async function applyRefundOutcome(c, refundId, failed) {
  let hit = 0
  for (const table of ['orders', 'preorders']) {
    const { rows } = await c.query(`SELECT id, status FROM ${table} WHERE refund_id = $1 FOR UPDATE`, [refundId])
    for (const row of rows) {
      hit++
      if (!failed) {
        await c.query(`UPDATE ${table} SET refund_status = 'processed', refund_checked_at = $2 WHERE id = $1`, [row.id, now()])
        continue
      }
      await c.query(
        `UPDATE ${table} SET refund_status = 'failed', refunded_at = NULL, refund_id = NULL, refund_attempted_at = NULL,
                payment_status = 'SUCCEEDED', refund_checked_at = $2 WHERE id = $1`,
        [row.id, now()],
      )
      if (table === 'orders') await addEvent(c, row.id, row.status, row.status, SYSTEM, `Refund ${refundId} failed at Razorpay; sending it again`)
    }
  }
  const d = await c.query(
    failed
      ? `UPDATE duplicate_payments SET refund_status = 'failed', refunded_at = NULL, refund_id = NULL, attempted_at = NULL, refund_checked_at = $2 WHERE refund_id = $1`
      : `UPDATE duplicate_payments SET refund_status = 'processed', refund_checked_at = $2 WHERE refund_id = $1`,
    [refundId, now()],
  )
  return hit + d.rowCount
}

const REFUND_RECHECK_MS = 60 * 60_000
const REFUND_SETTLE_MS = 30 * 60_000

/**
 * PAY-02: asks Razorpay how pending refunds ended, so a lost or early
 * refund webhook can't leave a failed refund recorded as paid. Each pending
 * refund older than 30 minutes is checked about once an hour, matched by its
 * payment id and refund id (GET /payments/:id/refunds, the call
 * gatewayRefund already makes). Returns how many changed.
 */
export async function reconcileRefunds(at = now()) {
  if (!hasKeys()) return 0
  const { rows } = await query(
    `SELECT 'orders' AS t, id::text AS key, payment_id, refund_id FROM orders
      WHERE refund_status = 'pending' AND refund_id IS NOT NULL AND refunded_at < $1 AND (refund_checked_at IS NULL OR refund_checked_at < $2)
     UNION ALL
     SELECT 'preorders', id::text, payment_id, refund_id FROM preorders
      WHERE refund_status = 'pending' AND refund_id IS NOT NULL AND refunded_at < $1 AND (refund_checked_at IS NULL OR refund_checked_at < $2)
     UNION ALL
     SELECT 'duplicate_payments', payment_id, payment_id, refund_id FROM duplicate_payments
      WHERE refund_status = 'pending' AND refund_id IS NOT NULL AND refunded_at < $1 AND (refund_checked_at IS NULL OR refund_checked_at < $2)
     LIMIT 20`,
    [new Date(at.getTime() - REFUND_SETTLE_MS), new Date(at.getTime() - REFUND_RECHECK_MS)],
  )
  let changed = 0
  for (const row of rows) {
    if (!canStartCall(GATEWAY_CALL_MS)) break
    const keyCol = row.t === 'duplicate_payments' ? 'payment_id' : 'id'
    try {
      const items = gatewayItems(await razorpay('GET', `/payments/${encodeURIComponent(row.payment_id)}/refunds`), 'rfnd_', 'refund list')
      const r = items.find((x) => x?.id === row.refund_id)
      if (r?.status === 'processed' || r?.status === 'failed') {
        changed += await tx((c) => applyRefundOutcome(c, row.refund_id, r.status === 'failed'))
      } else {
        await query(`UPDATE ${row.t} SET refund_checked_at = $2 WHERE ${keyCol} = $1`, [row.key, at])
        if (!r) logger.error({ refundId: row.refund_id, paymentId: row.payment_id }, 'a recorded refund is not listed at Razorpay')
      }
    } catch (err) {
      logger.error({ err, refundId: row.refund_id }, 'could not check a refund at Razorpay; will retry')
      await query(`UPDATE ${row.t} SET refund_checked_at = $2 WHERE ${keyCol} = $1`, [row.key, at]).catch(() => {})
    }
  }
  return changed
}

/**
 * Catches up on missed webhooks. Orders still waiting for payment come first,
 * newest first; orders the sweeper already cancelled (a payment can still land
 * after the hold) are checked for a day with a back-off of 15 minutes, so a
 * day of abandoned checkouts can't crowd out the orders that matter.
 */
export async function reconcilePendingPayments({ minAgeSeconds = 120 } = {}) {
  if (!hasKeys() && isProd) return 0
  const at = now()
  const { rows } = await query(
    `SELECT id, razorpay_order_id, payment_link_id FROM orders
      WHERE (razorpay_order_id IS NOT NULL OR payment_link_id IS NOT NULL) AND placed_at < $1
        AND ((status = 'PAYMENT_PENDING' AND (reconcile_checked_at IS NULL OR reconcile_checked_at < $4))
             OR (status = 'CANCELLED' AND payment_status IN ('INITIATED', 'CANCELLED') AND placed_at > $2
                 AND (reconcile_checked_at IS NULL OR reconcile_checked_at < $3)))
      ORDER BY (status = 'PAYMENT_PENDING') DESC, reconcile_checked_at NULLS FIRST, placed_at DESC LIMIT 100`,
    [new Date(at.getTime() - minAgeSeconds * 1000), new Date(at.getTime() - 86_400_000), new Date(at.getTime() - 15 * 60_000), new Date(at.getTime() - 50_000)],
  )
  let n = 0
  for (const o of rows) {
    if (!canStartCall(GATEWAY_CALL_MS)) break // the next run carries on
    try {
      await query('UPDATE orders SET reconcile_checked_at = $2 WHERE id = $1', [o.id, now()])
      const r = await reconcileOrder(o)
      if (r && r !== 'rejected') n++
    } catch (err) {
      logger.error({ err, orderId: o.id }, 'payment reconciliation failed for order')
    }
  }
  return n
}

/**
 * Asks Razorpay about one order (its Razorpay order or payment link) and
 * applies a captured payment as the webhook would. Returns the payment
 * result, or null when nothing was captured. Refunds it makes due are sent
 * by the caller (sendDueRefunds) or the maintenance loop.
 */
async function reconcileOrder(o) {
  const payments = o.razorpay_order_id ? await fetchPayments(o.razorpay_order_id) : await fetchLinkPayments(o.payment_link_id)
  const captured = payments.find((p) => p.status === 'captured')
  if (captured) return tx((c) => applyCapture(c, 'orders', o.id, captured))
  if (o.razorpay_order_id) {
    // PAY-05: a missed payment.authorized webhook (manual capture set in the
    // dashboard) would leave the money blocked; capture it the same way.
    // The capture webhook, or the next run, then confirms the order.
    const authorized = payments.find((p) => p.status === 'authorized')
    if (authorized) await captureAuthorized({ id: authorized.id, order_id: o.razorpay_order_id, amount: authorized.amount, currency: authorized.currency })
  }
  return null
}

/**
 * PAY-B3, OPS-24: reconciles one unpaid order now, when the customer is
 * waiting on it (back from Checkout, or the order page asking for the payment
 * status), instead of on the next maintenance run. At most one gateway check
 * per order every `throttleMs`, across instances: the reconcile_checked_at
 * claim is taken in one UPDATE. Only orders placed at least `minAgeMs` ago are
 * checked (a fresh order's webhook normally arrives first). Returns the
 * payment result, 'throttled', or null.
 */
export async function reconcileOrderNow(orderId, { minAgeMs = 0, throttleMs = 10_000 } = {}) {
  if (!hasKeys() && isProd) return null
  const at = now()
  const { rows } = await query(
    `UPDATE orders SET reconcile_checked_at = $2
      WHERE id = $1 AND (razorpay_order_id IS NOT NULL OR payment_link_id IS NOT NULL) AND placed_at <= $3
        AND (status = 'PAYMENT_PENDING' OR (status = 'CANCELLED' AND payment_status IN ('INITIATED', 'CANCELLED')))
        AND (reconcile_checked_at IS NULL OR reconcile_checked_at < $4)
      RETURNING id, razorpay_order_id, payment_link_id`,
    [orderId, at, new Date(at.getTime() - minAgeMs), new Date(at.getTime() - throttleMs)],
  )
  if (!rows.length) return 'skipped'
  const r = await reconcileOrder(rows[0])
  if (r) background(sendDueRefunds(refundsFor({ result: r, orderId })))
  return r
}

/**
 * Refunds a payment in full at Razorpay, reusing a refund already made for it
 * so a retry never pays twice. Returns the refund id (null in production
 * without keys). Throws on gateway errors.
 */
export const REFUND_LEASE_MS = 2 * 60_000

/**
 * Takes the refund for one order or preorder for the next two minutes, or
 * returns null when it is done, not due, or another worker holds it. Only the
 * holder calls Razorpay, so the cancel request, the webhook and the
 * maintenance loop (on any instance) can't send the same refund twice.
 */
export async function claimRefund(table, id, at = now()) {
  if (table !== 'orders' && table !== 'preorders') throw new Error(`no refunds on ${table}`)
  const { rows } = await query(
    `UPDATE ${table} SET refund_attempted_at = $2, refund_attempts = refund_attempts + 1
      WHERE id = $1 AND refund_requested_at IS NOT NULL AND refunded_at IS NULL
        AND (refund_attempted_at IS NULL OR refund_attempted_at < $3)
      RETURNING *`,
    [id, at, new Date(at.getTime() - REFUND_LEASE_MS)],
  )
  return rows[0] ?? null
}

/**
 * PAY-B2: Razorpay treats a refund's `receipt` as an idempotency key ("Create
 * a Normal Refund"), so a refund sent again after one failed needs a new one.
 * Each attempt gets `<base>-r<attempt>`, at most 40 characters. What stops a
 * second refund is not the receipt but the lookup in gatewayRefund (refunds
 * already at Razorpay count) and the lease in claimRefund.
 */
export function refundReceipt(base, attempt) {
  const suffix = `-r${Math.max(1, attempt ?? 1)}`
  return `${String(base).slice(0, 40 - suffix.length)}${suffix}`
}

/**
 * The refunds Razorpay holds for a payment that have not failed (the lookup
 * gatewayRefund makes first). Development has none. Throws when Razorpay can't be asked.
 */
export async function liveGatewayRefunds(paymentId) {
  if (!hasKeys() || !paymentId) return []
  return gatewayItems(await razorpay('GET', `/payments/${encodeURIComponent(paymentId)}/refunds`), 'rfnd_', 'refund list').filter((r) => r.status !== 'failed')
}

export async function gatewayRefund({ paymentId, amount, receipt, notes }) {
  if (hasKeys()) {
    if (!paymentId) throw new Error(`${receipt} has no payment id to refund`)
    const pid = encodeURIComponent(paymentId)
    // Refunds already made for this payment (by an earlier attempt, or by hand
    // in the Razorpay dashboard) count; only what is still owed is sent.
    const live = gatewayItems(await razorpay('GET', `/payments/${pid}/refunds`), 'rfnd_', 'refund list').filter((r) => r.status !== 'failed')
    const done = live.reduce((sum, r) => sum + (r.amount ?? 0), 0)
    const owed = amount == null ? null : amount - done
    if (live.length && (owed == null || owed <= 0)) return live[0].id
    return gatewayId(await razorpay('POST', `/payments/${pid}/refund`, { ...(owed == null ? {} : { amount: owed }), receipt, notes }), 'rfnd_', 'refund')
  }
  if (isProd) return null
  return `rfnd_dev_${newId('r').slice(2)}`
}

/**
 * Sends the full refund for an order whose customer cancelled after paying.
 * Safe to repeat: it looks for a refund already made for the order before
 * creating one, and the database is updated only once. Throws on gateway
 * errors so the caller (or the maintenance loop) can retry.
 */
export async function refundOrder(orderId) {
  const o = await claimRefund('orders', orderId)
  if (!o) return null
  const refundId = await gatewayRefund({
    paymentId: o.payment_id, amount: o.payment_amount ?? o.total, receipt: refundReceipt(o.number, o.refund_attempts), notes: { orderId: o.id },
  })
  if (!refundId) return null
  try {
    return await tx(async (c) => {
      const r = await c.query(
        `UPDATE orders SET payment_status = 'REFUNDED', refund_id = $2, refunded_at = $3, refund_status = 'pending', refund_checked_at = NULL WHERE id = $1 AND refunded_at IS NULL RETURNING id`,
        [o.id, refundId, now()],
      )
      if (r.rowCount) {
        const eventId = await addEvent(c, o.id, 'CANCELLED', 'CANCELLED', SYSTEM, `Refunded in full (${refundId})`)
        await enqueue(c, o.id, eventId, 'REFUNDED')
      }
      return refundId
    })
  } catch (err) {
    logger.error({ err, orderId: o.id, refundId }, 'refund sent but not recorded; the next run will pick up the existing refund')
    throw err
  }
}

/** Retries refunds that were requested but not yet sent. */
export async function processDueRefunds() {
  const { rows } = await query(
    'SELECT id FROM orders WHERE refund_requested_at IS NOT NULL AND refunded_at IS NULL ORDER BY refund_requested_at LIMIT 50',
  )
  let n = 0
  const pre = await query('SELECT id FROM preorders WHERE refund_requested_at IS NOT NULL AND refunded_at IS NULL ORDER BY refund_requested_at LIMIT 50')
  for (const p of pre.rows) {
    if (!canStartCall(GATEWAY_CALL_MS)) return n
    try {
      if (await refundPreorder(p.id)) n++
    } catch (err) {
      logger.error({ err, preorderId: p.id }, 'preorder refund failed; will retry')
    }
  }
  for (const o of rows) {
    if (!canStartCall(GATEWAY_CALL_MS)) return n
    try {
      if (await refundOrder(o.id)) n++
    } catch (err) {
      logger.error({ err, orderId: o.id }, 'refund failed; will retry')
    }
  }
  return n
}

/**
 * Refunds second payments taken for orders or preorders that were already
 * paid (a customer paying twice, two tabs, a retried link). Only that payment
 * is refunded; the order stays as it is. Each row is leased like order
 * refunds, and gatewayRefund reuses a refund already made at Razorpay, so a
 * retry never refunds twice.
 */
export async function refundDuplicatePayments(at = now()) {
  const { rows } = await query(
    `UPDATE duplicate_payments SET attempted_at = $1, refund_attempts = refund_attempts + 1
      WHERE payment_id IN (SELECT payment_id FROM duplicate_payments
                            WHERE refunded_at IS NULL AND (attempted_at IS NULL OR attempted_at < $2)
                            ORDER BY found_at LIMIT 20 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [at, new Date(at.getTime() - REFUND_LEASE_MS)],
  )
  let n = 0
  for (const d of rows) {
    if (!canStartCall(GATEWAY_CALL_MS)) break // leased rows are retried after the lease
    try {
      const refundId = await gatewayRefund({
        paymentId: d.payment_id, amount: d.amount ?? undefined, receipt: refundReceipt(`dup-${d.payment_id}`, d.refund_attempts),
        notes: { reason: 'duplicate payment', ...(d.order_id ? { orderId: d.order_id } : { preorderId: d.preorder_id }) },
      })
      if (!refundId) continue
      await tx(async (c) => {
        await c.query(`UPDATE duplicate_payments SET refund_id = $2, refunded_at = $3, refund_status = 'pending', last_error = NULL WHERE payment_id = $1`, [d.payment_id, refundId, now()])
        if (d.order_id) {
          const { rows: o } = await c.query('SELECT status FROM orders WHERE id = $1', [d.order_id])
          await addEvent(c, d.order_id, o[0].status, o[0].status, SYSTEM, `Second payment ${d.payment_id} refunded (${refundId})`)
        }
      })
      n++
    } catch (err) {
      logger.error({ err, paymentId: d.payment_id }, 'duplicate payment refund failed; will retry')
      await query('UPDATE duplicate_payments SET last_error = $2 WHERE payment_id = $1', [d.payment_id, String(err.message).slice(0, 500)]).catch(() => {})
    }
  }
  return n
}

async function listGatewayPayments(from, to) {
  if (hasKeys()) {
    const out = []
    for (let skip = 0; ; skip += 100) {
      const page = await razorpay('GET', `/payments?from=${Math.floor(from / 1000)}&to=${Math.floor(to / 1000)}&count=100&skip=${skip}`)
      out.push(...(page.items ?? []))
      if ((page.items ?? []).length < 100) return out
    }
  }
  if (isProd) return []
  return [...devGateway.entries()].map(([ref, p]) => ({ ...p, order_id: ref.startsWith('order_') ? ref : undefined }))
}

/**
 * Every refund Razorpay made in a window: Razorpay's "Fetch all refunds"
 * (GET /v1/refunds with from/to in unix seconds, count up to 100, skip),
 * paged like listGatewayPayments. Development has no gateway refunds to list.
 */
async function listGatewayRefunds(from, to) {
  if (!hasKeys()) return []
  const out = []
  for (let skip = 0; ; skip += 100) {
    const page = gatewayItems(await razorpay('GET', `/refunds?from=${Math.floor(from / 1000)}&to=${Math.floor(to / 1000)}&count=100&skip=${skip}`), 'rfnd_', 'refund list')
    out.push(...page)
    if (page.length < 100) return out
  }
}

/**
 * PAY-B9: refunds made after the restore point are not in the restored
 * database, so an order refunded at Razorpay can come back as paid and be
 * delivered for free. Each refund in the window that we have no record of,
 * on a payment we show as paid, is listed in Needs attention (once) for
 * staff to check. Nothing is changed on the order. Returns what was flagged.
 */
async function flagGatewayRefunds(from, to) {
  const flagged = []
  for (const r of await listGatewayRefunds(from, to)) {
    if (r.status === 'failed' || typeof r.payment_id !== 'string') continue
    const { rows } = await query(
      `SELECT 'order' AS type, number, payment_status, refund_id FROM orders WHERE payment_id = $1
       UNION ALL SELECT 'preorder', number, payment_status, refund_id FROM preorders WHERE payment_id = $1
       UNION ALL SELECT 'second payment', COALESCE(o.number, p.number), 'SUCCEEDED', d.refund_id FROM duplicate_payments d
         LEFT JOIN orders o ON o.id = d.order_id LEFT JOIN preorders p ON p.id = d.preorder_id WHERE d.payment_id = $1`,
      [r.payment_id],
    )
    const row = rows[0]
    if (!row || row.refund_id === r.id || row.payment_status !== 'SUCCEEDED') continue
    const key = `replay-refund:${r.id}`
    if ((await query('SELECT 1 FROM webhook_failures WHERE event_key = $1', [key])).rowCount) continue
    flagged.push({ refundId: r.id, paymentId: r.payment_id, amount: r.amount, number: row.number })
    await recordWebhookFailure(
      'razorpay',
      `After a restore: ${row.type} ${row.number ?? '?'} shows as paid, but Razorpay refunded its payment ${r.payment_id} (${r.id}, ${r.amount} paise). Check it before delivering.`,
      key,
    )
  }
  return flagged
}

export async function knownPayment(id, c = { query }) {
  const { rows } = await c.query(
    `SELECT 1 FROM orders WHERE payment_id = $1
      UNION ALL SELECT 1 FROM preorders WHERE payment_id = $1
      UNION ALL SELECT 1 FROM duplicate_payments WHERE payment_id = $1 LIMIT 1`,
    [id],
  )
  return rows.length > 0
}

/**
 * After the database is restored to an earlier point, Razorpay still holds the
 * payments taken since then. This brings them back:
 * 1. every order and preorder placed in the window that has a Razorpay order or
 *    link is checked at Razorpay, and captured payments are applied as the
 *    webhook would (paid, late payment, duplicate, or refund after a cancel);
 * 2. any captured payment in the window that still matches nothing belongs to
 *    an order the restore lost. It is listed in Needs attention, and with
 *    refundMissing it is refunded in full (the customer is told by staff);
 * 3. refunds Razorpay made in the window on payments we show as paid are
 *    listed in Needs attention (flagGatewayRefunds).
 * Safe to run more than once: applying a payment twice is a no-op.
 */
export async function replayCapturedPayments({ from, to = now(), refundMissing = false }) {
  const out = { checked: 0, applied: 0, lost: [], refunded: 0, refundedAtGateway: [] }
  const since = new Date(from.getTime() - 86_400_000) // late payments land up to a day after the order
  const orders = await query(
    `SELECT id, razorpay_order_id, payment_link_id, payment_id FROM orders
      WHERE (razorpay_order_id IS NOT NULL OR payment_link_id IS NOT NULL) AND placed_at BETWEEN $1 AND $2`,
    [since, to],
  )
  for (const o of orders.rows) {
    out.checked++
    const payments = o.razorpay_order_id ? await fetchPayments(o.razorpay_order_id) : await fetchLinkPayments(o.payment_link_id)
    for (const p of payments.filter((x) => x.status === 'captured' && x.id !== o.payment_id)) {
      if (await knownPayment(p.id)) continue
      if ((await tx((c) => applyCapture(c, 'orders', o.id, p))) !== 'rejected') out.applied++
    }
  }
  const pre = await query(
    `SELECT id, payment_link_id, payment_id FROM preorders WHERE payment_link_id IS NOT NULL
      AND COALESCE(payment_started_at, created_at) BETWEEN $1 AND $2`,
    [since, to],
  )
  for (const p of pre.rows) {
    out.checked++
    for (const pay of (await fetchLinkPayments(p.payment_link_id)).filter((x) => x.status === 'captured' && x.id !== p.payment_id)) {
      if (await knownPayment(pay.id)) continue
      if ((await tx((c) => applyCapture(c, 'preorders', p.id, pay))) !== 'rejected') out.applied++
    }
  }

  for (const p of await listGatewayPayments(from, to)) {
    if (p.status !== 'captured' || (await knownPayment(p.id))) continue
    const orderId = await findOrderId({ query }, p)
    const preorderId = orderId ? null : await findPreorderId({ query }, p, null)
    if (orderId || preorderId) {
      if ((await tx((c) => applyCapture(c, orderId ? 'orders' : 'preorders', orderId ?? preorderId, p))) !== 'rejected') out.applied++
      continue
    }
    out.lost.push({ paymentId: p.id, amount: p.amount, contact: p.contact ?? null })
    await recordWebhookFailure('razorpay', `After a restore: captured payment ${p.id} (${p.amount} paise) matches no order`, `replay:${p.id}`, { query }, p.id)
    if (refundMissing) {
      await query('INSERT INTO duplicate_payments (payment_id, amount, found_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [p.id, p.amount ?? null, now()])
    }
  }
  out.refundedAtGateway = await flagGatewayRefunds(from, to)
  if (refundMissing && out.lost.length) out.refunded = await refundDuplicatePayments()
  // Refunds owed by what was just applied (a payment after a cancel).
  await processDueRefunds().catch((err) => logger.error({ err }, 'refunds after replay will be retried by maintenance'))
  return out
}
