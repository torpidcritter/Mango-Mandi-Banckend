// Razorpay adapter, webhook verification and payment reconciliation.
// Without API keys (development and tests) an in-memory dev gateway stands in.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { outOfTime } from './budget.js'
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
const GATEWAY_CALL_MS = 12_000

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

/**
 * When a payment link stops taking payments, in unix seconds. The hold is 10
 * minutes; Razorpay's shortest expiry is 15, so links close 16 minutes after
 * they are made. A payment in between is a late payment and is honoured (the
 * order goes to the next date with stock). Without an expiry a link could be
 * paid days later.
 */
export const linkExpiresAt = (at = now()) => Math.floor(at.getTime() / 1000) + Math.max(16 * 60, getConfig().holdMinutes * 60 + 6 * 60)

export async function createPaymentLink({ amount, number, orderId, preorderId, name, phone, description }) {
  if (hasKeys()) {
    const link = await razorpay('POST', '/payment_links', {
      amount, currency: 'INR', accept_partial: false, reference_id: number, expire_by: linkExpiresAt(), description: description ?? `MandiMangoes order ${number}`,
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
    if (out.result === 'duplicate_payment') await refundDuplicatePayments().catch(() => {})
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
    if (outOfTime(GATEWAY_CALL_MS)) break // the next run carries on
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
    if (outOfTime(GATEWAY_CALL_MS)) return n
    try {
      if (await refundPreorder(p.id)) n++
    } catch (err) {
      logger.error({ err, preorderId: p.id }, 'preorder refund failed; will retry')
    }
  }
  for (const o of rows) {
    if (outOfTime(GATEWAY_CALL_MS)) return n
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
    `UPDATE duplicate_payments SET attempted_at = $1
      WHERE payment_id IN (SELECT payment_id FROM duplicate_payments
                            WHERE refunded_at IS NULL AND (attempted_at IS NULL OR attempted_at < $2)
                            ORDER BY found_at LIMIT 20 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [at, new Date(at.getTime() - REFUND_LEASE_MS)],
  )
  let n = 0
  for (const d of rows) {
    if (outOfTime(GATEWAY_CALL_MS)) break // leased rows are retried after the lease
    try {
      const refundId = await gatewayRefund({
        paymentId: d.payment_id, amount: d.amount ?? undefined, receipt: `dup-${d.payment_id}`.slice(0, 40),
        notes: { reason: 'duplicate payment', ...(d.order_id ? { orderId: d.order_id } : { preorderId: d.preorder_id }) },
      })
      if (!refundId) continue
      await tx(async (c) => {
        await c.query('UPDATE duplicate_payments SET refund_id = $2, refunded_at = $3, last_error = NULL WHERE payment_id = $1', [d.payment_id, refundId, now()])
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

async function knownPayment(id) {
  const { rows } = await query(
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
 *    refundMissing it is refunded in full (the customer is told by staff).
 * Safe to run more than once: applying a payment twice is a no-op.
 */
export async function replayCapturedPayments({ from, to = now(), refundMissing = false }) {
  const out = { checked: 0, applied: 0, lost: [], refunded: 0 }
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
      await tx((c) => processPayment(c, { orderId: o.id, outcome: 'captured', paymentId: p.id, amount: p.amount, method: p.method }))
      out.applied++
    }
  }
  const pre = await query(
    `SELECT id, payment_link_id, payment_id FROM preorders WHERE payment_link_id IS NOT NULL AND created_at BETWEEN $1 AND $2`,
    [since, to],
  )
  for (const p of pre.rows) {
    out.checked++
    for (const pay of (await fetchLinkPayments(p.payment_link_id)).filter((x) => x.status === 'captured' && x.id !== p.payment_id)) {
      if (await knownPayment(pay.id)) continue
      await tx((c) => processPreorderPayment(c, { preorderId: p.id, outcome: 'captured', paymentId: pay.id, amount: pay.amount, method: pay.method }))
      out.applied++
    }
  }

  for (const p of await listGatewayPayments(from, to)) {
    if (p.status !== 'captured' || (await knownPayment(p.id))) continue
    const orderId = await findOrderId({ query }, p)
    const preorderId = orderId ? null : await findPreorderId({ query }, p, null)
    if (orderId || preorderId) {
      await tx((c) => orderId
        ? processPayment(c, { orderId, outcome: 'captured', paymentId: p.id, amount: p.amount, method: p.method })
        : processPreorderPayment(c, { preorderId, outcome: 'captured', paymentId: p.id, amount: p.amount, method: p.method }))
      out.applied++
      continue
    }
    out.lost.push({ paymentId: p.id, amount: p.amount, contact: p.contact ?? null })
    await recordWebhookFailure('razorpay', `After a restore: captured payment ${p.id} (${p.amount} paise) matches no order`, `replay:${p.id}`)
    if (refundMissing) {
      await query('INSERT INTO duplicate_payments (payment_id, amount, found_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [p.id, p.amount ?? null, now()])
    }
  }
  if (refundMissing && out.lost.length) out.refunded = await refundDuplicatePayments()
  // Refunds owed by what was just applied (a payment after a cancel).
  await processDueRefunds().catch((err) => logger.error({ err }, 'refunds after replay will be retried by maintenance'))
  return out
}
