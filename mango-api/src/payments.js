// Razorpay adapter, webhook verification and payment reconciliation.
// Without API keys (development and tests) an in-memory dev gateway stands in.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { now } from './clock.js'
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

export async function createGatewayOrder({ amount, receipt, orderId }) {
  if (hasKeys()) {
    const o = await razorpay('POST', '/orders', { amount, currency: 'INR', receipt, notes: { orderId } })
    return o.id
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

export async function createPaymentLink({ amount, number, orderId, preorderId, name, phone, description }) {
  if (hasKeys()) {
    const link = await razorpay('POST', '/payment_links', {
      amount, currency: 'INR', accept_partial: false, reference_id: number, description: description ?? `MandiMangoes order ${number}`,
      customer: { name: name ?? undefined, contact: phone }, notify: { sms: false, email: false }, reminder_enable: false,
      notes: preorderId ? { preorderId } : { orderId },
      ...(preorderId && shopOrigin() ? { callback_url: `${shopOrigin()}/preorders/${preorderId}`, callback_method: 'get' } : {}),
    })
    return { id: link.id, url: link.short_url }
  }
  if (isProd) throw new HttpError(503, 'PAYMENTS_UNAVAILABLE', 'Payments are not configured')
  const id = `plink_dev_${newId('l').slice(2)}`
  return { id, url: `https://rzp.io/i/${id}` }
}

export async function fetchLinkPayments(linkId) {
  if (hasKeys()) {
    const link = await razorpay('GET', `/payment_links/${encodeURIComponent(linkId)}`)
    return (link.payments ?? []).map((p) => ({ id: p.payment_id, status: p.status, amount: p.amount, method: p.method }))
  }
  if (isProd) return []
  const p = devGateway.get(linkId)
  return p ? [p] : []
}

async function fetchPayments(razorpayOrderId) {
  if (hasKeys()) return (await razorpay('GET', `/orders/${encodeURIComponent(razorpayOrderId)}/payments`)).items ?? []
  if (isProd) return []
  const p = devGateway.get(razorpayOrderId)
  return p ? [p] : []
}

export function verifySignature(raw, signature) {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false
  const expected = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest()
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'))
}

async function findOrderId(c, entity, link = null) {
  if (link) {
    const { rows } = await c.query('SELECT id FROM orders WHERE payment_link_id = $1 OR id = $2 LIMIT 1', [link.id ?? null, link.notes?.orderId ?? null])
    if (rows.length) return rows[0].id
  }
  const { rows } = await c.query('SELECT id FROM orders WHERE razorpay_order_id = $1 OR id = $2 LIMIT 1', [
    entity.order_id ?? null,
    entity.notes?.orderId ?? null,
  ])
  return rows[0]?.id ?? null
}

/** Records a webhook that failed or could not be matched, for the Needs attention view. Never throws. */
export async function recordWebhookFailure(source, reason, eventKey = null, c = { query }) {
  await c
    .query('INSERT INTO webhook_failures (id, source, reason, event_key, created_at) VALUES ($1, $2, $3, $4, $5)', [
      newId('whf'), source, String(reason).slice(0, 500), eventKey ? String(eventKey).slice(0, 200) : null, now(),
    ])
    .catch((err) => logger.error({ err }, 'could not record a webhook failure'))
}

/**
 * Handles one verified webhook body. The dedupe row is written in the same
 * transaction, so a processing error rolls it back and Razorpay's retry runs.
 */
export async function handleWebhook(event, eventId) {
  const kind = event?.event
  if (kind !== 'payment.captured' && kind !== 'payment.failed' && kind !== 'payment_link.paid') return { ignored: true }
  const entity = event.payload?.payment?.entity ?? {}
  const link = kind === 'payment_link.paid' ? (event.payload?.payment_link?.entity ?? {}) : null
  const dedupeKey = eventId || `${kind}:${entity.id ?? link?.id}`
  return tx(async (c) => {
    const ins = await c.query('INSERT INTO processed_webhooks (dedupe_key, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [dedupeKey, now()])
    if (!ins.rowCount) return { duplicate: true }
    const orderId = await findOrderId(c, entity, link)
    if (!orderId) {
      const preorderId = await findPreorderId(c, entity, link)
      if (preorderId) {
        const r = await processPreorderPayment(c, {
          preorderId, outcome: kind === 'payment.failed' ? 'failed' : 'captured', paymentId: entity.id ?? null,
          amount: typeof entity.amount === 'number' ? entity.amount : null, method: entity.method ?? null,
        })
        return { result: r, preorderId }
      }
      logger.warn({ razorpayOrderId: entity.order_id }, 'webhook for an unknown order')
      await recordWebhookFailure('razorpay', `${kind} for an order we don't have (${entity.order_id ?? link?.id ?? 'no id'})`, dedupeKey, c)
      return { unknownOrder: true }
    }
    const r = await processPayment(c, {
      orderId,
      outcome: kind === 'payment.failed' ? 'failed' : 'captured',
      paymentId: entity.id ?? null,
      amount: typeof entity.amount === 'number' ? entity.amount : null,
      method: entity.method ?? null,
    })
    return { result: r.result, orderId }
  }).then(async (out) => {
    if (out.result === 'refund_due' && out.orderId) await refundOrder(out.orderId).catch(() => {}) // maintenance retries
    if (out.result === 'refund_due' && out.preorderId) await refundPreorder(out.preorderId).catch(() => {})
    return out
  })
}

/** Catches up on missed webhooks for orders stuck in PAYMENT_PENDING. */
export async function reconcilePendingPayments({ minAgeSeconds = 120 } = {}) {
  if (!hasKeys() && isProd) return 0
  const { rows } = await query(
    `SELECT id, razorpay_order_id, payment_link_id FROM orders
      WHERE (razorpay_order_id IS NOT NULL OR payment_link_id IS NOT NULL) AND placed_at < $1
        AND (status = 'PAYMENT_PENDING'
             OR (status = 'CANCELLED' AND payment_status IN ('INITIATED', 'CANCELLED') AND placed_at > $2))
      ORDER BY placed_at LIMIT 100`,
    [new Date(now().getTime() - minAgeSeconds * 1000), new Date(now().getTime() - 86_400_000)],
  )
  let n = 0
  for (const o of rows) {
    try {
      const payments = o.razorpay_order_id ? await fetchPayments(o.razorpay_order_id) : await fetchLinkPayments(o.payment_link_id)
      const captured = payments.find((p) => p.status === 'captured')
      if (captured) {
        await tx((c) => processPayment(c, { orderId: o.id, outcome: 'captured', paymentId: captured.id, amount: captured.amount, method: captured.method }))
        n++
      }
    } catch (err) {
      logger.error({ err, orderId: o.id }, 'payment reconciliation failed for order')
    }
  }
  return n
}

/**
 * Refunds a payment in full at Razorpay, reusing a refund already made for it
 * so a retry never pays twice. Returns the refund id (null in production
 * without keys). Throws on gateway errors.
 */
const REFUND_LEASE_MS = 2 * 60_000

/**
 * Takes the refund for one order or preorder for the next two minutes, or
 * returns null when it is done, not due, or another worker holds it. Only the
 * holder calls Razorpay, so the cancel request, the webhook and the
 * maintenance loop (on any instance) can't send the same refund twice.
 */
export async function claimRefund(table, id, at = now()) {
  if (table !== 'orders' && table !== 'preorders') throw new Error(`no refunds on ${table}`)
  const { rows } = await query(
    `UPDATE ${table} SET refund_attempted_at = $2
      WHERE id = $1 AND refund_requested_at IS NOT NULL AND refunded_at IS NULL
        AND (refund_attempted_at IS NULL OR refund_attempted_at < $3)
      RETURNING *`,
    [id, at, new Date(at.getTime() - REFUND_LEASE_MS)],
  )
  return rows[0] ?? null
}

export async function gatewayRefund({ paymentId, amount, receipt, notes }) {
  if (hasKeys()) {
    if (!paymentId) throw new Error(`${receipt} has no payment id to refund`)
    const pid = encodeURIComponent(paymentId)
    const existing = ((await razorpay('GET', `/payments/${pid}/refunds`)).items ?? []).find((r) => r.status !== 'failed')
    return (existing ?? (await razorpay('POST', `/payments/${pid}/refund`, { amount, receipt, notes }))).id
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
  const refundId = await gatewayRefund({ paymentId: o.payment_id, amount: o.payment_amount ?? o.total, receipt: o.number, notes: { orderId: o.id } })
  if (!refundId) return null
  try {
    return await tx(async (c) => {
      const r = await c.query(
        `UPDATE orders SET payment_status = 'REFUNDED', refund_id = $2, refunded_at = $3 WHERE id = $1 AND refunded_at IS NULL RETURNING id`,
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
    try {
      if (await refundPreorder(p.id)) n++
    } catch (err) {
      logger.error({ err, preorderId: p.id }, 'preorder refund failed; will retry')
    }
  }
  for (const o of rows) {
    try {
      if (await refundOrder(o.id)) n++
    } catch (err) {
      logger.error({ err, orderId: o.id }, 'refund failed; will retry')
    }
  }
  return n
}
