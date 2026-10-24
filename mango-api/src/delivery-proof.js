// Proof of delivery. When an order goes out for delivery it gets a 4-digit
// code, shown to the customer in the app and sent in the WhatsApp update. The
// rider marks it delivered by typing the code the customer reads out, or, when
// nobody can give the code (left with security, at the door), with a photo and
// who received it. A missed delivery needs a reason. Every attempt is a row in
// delivery_attempts. Marking an order delivered from the panel without proof
// is a manager's override with a reason (orders.js setOrderStatus), recorded
// as "staff" and queued for a second person to check, like a photo.
import { timingSafeEqual } from 'node:crypto'
import { now } from './clock.js'
import { badRequest, conflict, HttpError, notFound } from './errors.js'
import { newId } from './ids.js'
import { addEvent, setOrderStatus } from './orders.js'
import { query, tx } from './db.js'
import { checkPhoto, cleanImage, dropPhoto, MAX_PHOTO_BYTES, storePhoto } from './photos.js'

export const FAIL_REASONS = ['NOT_HOME', 'WRONG_ADDRESS', 'REFUSED', 'UNREACHABLE', 'OTHER']
export const FAIL_LABEL = {
  NOT_HOME: 'Customer not home',
  WRONG_ADDRESS: 'Address not found',
  REFUSED: 'Customer refused the order',
  UNREACHABLE: 'Customer did not answer the phone',
  OTHER: 'Could not deliver',
}
export const MAX_CODE_TRIES = 5
export { MAX_PHOTO_BYTES }

async function lockOrder(c, orderId) {
  const { rows } = await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId])
  if (!rows.length) throw notFound('Order not found')
  return rows[0]
}

/**
 * Puts a packed order (or one retrying after a missed delivery) on the road.
 * Refused (409) when its packed stock is condemned or too old, or its
 * attempts are used up, unless a manager overrides (opts.override, opts.reason).
 */
export async function dispatchOrder(c, orderId, actor, opts = {}) {
  const o = await lockOrder(c, orderId)
  if (o.status === 'OUT_FOR_DELIVERY') return false
  if (!['PACKED', 'SHIPPED', 'DELIVERY_FAILED'].includes(o.status)) {
    const why = ['CONFIRMED', 'PROCESSING'].includes(o.status) ? 'is not packed yet' : `is ${o.status.toLowerCase().replace(/_/g, ' ')}`
    throw badRequest(`Order ${o.number} ${why}`, 'INVALID_TRANSITION')
  }
  if (o.status === 'PACKED') await setOrderStatus(c, orderId, 'SHIPPED', actor, opts)
  await setOrderStatus(c, orderId, 'OUT_FOR_DELIVERY', actor, opts)
  return true
}

const notOut = () => badRequest('Photos are taken while the order is out for delivery', 'INVALID_TRANSITION')

/**
 * Stores a delivery photo for an order that is out for delivery. Returns its id.
 * OPS-26: the upload (Blob, no transaction) happens before the transaction
 * that locks the order, so a slow upload never holds the order lock or a
 * pooled connection. The short transaction re-checks the order and inserts
 * the row; if it fails, the uploaded file is deleted again.
 */
export async function savePhoto(orderId, bytes, actor) {
  checkPhoto(bytes)
  // SEC-13: re-encoded, so the phone's EXIF (GPS, device) and anything hidden in the file stay behind.
  const { bytes: clean, mime, ext } = await cleanImage(bytes)
  const { rows } = await query('SELECT number, status FROM orders WHERE id = $1', [orderId])
  if (!rows.length) throw notFound('Order not found')
  if (rows[0].status !== 'OUT_FOR_DELIVERY') throw notOut()
  const id = newId('dph')
  const stored = await storePhoto(`delivery/${rows[0].number}`, id, clean, ext, mime)
  try {
    await tx(async (c) => {
      const o = await lockOrder(c, orderId)
      if (o.status !== 'OUT_FOR_DELIVERY') throw notOut()
      await c.query('INSERT INTO delivery_photos (id, order_id, mime, bytes, blob_path, taken_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
        id, orderId, mime, stored.bytes, stored.blobPath, actor.label ?? actor.id, now(),
      ])
    })
  } catch (err) {
    if (stored.blobPath) await dropPhoto({ blob_path: stored.blobPath })
    throw err
  }
  return id
}

export async function photo(c, orderId, photoId) {
  const { rows } = await c.query('SELECT mime, bytes, blob_path FROM delivery_photos WHERE id = $1 AND order_id = $2', [photoId, orderId])
  if (!rows.length) throw notFound('Photo not found')
  return rows[0]
}

async function insertAttempt(c, orderId, a, actor) {
  await c.query(
    `INSERT INTO delivery_attempts (id, order_id, outcome, method, received_by, reason, note, photo_id, lat, lng, actor, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [newId('dat'), orderId, a.outcome, a.method ?? null, a.receivedBy ?? null, a.reason ?? null, a.note ?? null, a.photoId ?? null,
      a.lat ?? null, a.lng ?? null, actor.label ?? actor.id, now()],
  )
}

const codesMatch = (given, expected) => {
  const a = Buffer.from(String(given))
  const b = Buffer.from(String(expected))
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Records a delivery or a missed delivery with its proof and moves the order.
 * A wrong code is counted and returned (not thrown) so the count commits.
 */
export async function recordDelivery(c, orderId, input, actor) {
  const o = await lockOrder(c, orderId)
  if (o.status !== 'OUT_FOR_DELIVERY') {
    if (['DELIVERED', 'DELIVERY_FAILED'].includes(o.status)) throw conflict('This delivery was already recorded.')
    throw badRequest(`Order ${o.number} is not out for delivery`, 'INVALID_TRANSITION')
  }
  // ORD-4: a report for an earlier attempt (resent after the order went out again) must not count against this one.
  if (input.attempt !== undefined && input.attempt !== o.delivery_failures + 1) {
    throw conflict(`This report is for delivery attempt ${input.attempt}; the order is now on attempt ${o.delivery_failures + 1}.`, 'STALE_ATTEMPT')
  }
  if (input.photoId) {
    const { rows } = await c.query('SELECT 1 FROM delivery_photos WHERE id = $1 AND order_id = $2', [input.photoId, orderId])
    if (!rows.length) throw badRequest('That photo is not from this order', 'PHOTO_INVALID')
  }
  const where = { lat: input.lat ?? null, lng: input.lng ?? null }

  if (input.outcome === 'FAILED') {
    if (!FAIL_REASONS.includes(input.reason)) throw badRequest('Say why the delivery could not be made', 'REASON_REQUIRED')
    await insertAttempt(c, orderId, { outcome: 'FAILED', reason: input.reason, note: input.note, photoId: input.photoId, ...where }, actor)
    const reason = input.reason === 'OTHER' && input.note ? input.note : FAIL_LABEL[input.reason]
    await setOrderStatus(c, orderId, 'DELIVERY_FAILED', actor, { reason })
    return { outcome: 'FAILED' }
  }

  let method
  if (input.code) {
    if (o.delivery_code_tries >= MAX_CODE_TRIES) {
      throw new HttpError(429, 'CODE_LOCKED', 'Too many wrong codes. Take a photo of the handover instead.')
    }
    if (!o.delivery_code || !codesMatch(input.code, o.delivery_code)) {
      const { rows } = await c.query('UPDATE orders SET delivery_code_tries = delivery_code_tries + 1 WHERE id = $1 RETURNING delivery_code_tries', [orderId])
      return { wrongCode: true, triesLeft: Math.max(0, MAX_CODE_TRIES - rows[0].delivery_code_tries) }
    }
    method = 'code'
  } else if (input.photoId) {
    if (!input.receivedBy?.trim()) throw badRequest('Say who took the order, or where it was left', 'RECEIVER_REQUIRED')
    method = 'photo'
  } else {
    throw badRequest("Enter the customer's code, or take a photo of the handover", 'PROOF_REQUIRED')
  }
  await insertAttempt(c, orderId, { outcome: 'DELIVERED', method, receivedBy: input.receivedBy?.trim() || null, note: input.note, photoId: input.photoId, ...where }, actor)
  await setOrderStatus(c, orderId, 'DELIVERED', actor, { proof: method })
  return { outcome: 'DELIVERED', method }
}

/** Staff moved the order from the panel: recorded as an attempt without proof, with the reason given. */
export async function recordStaffDelivery(c, orderId, status, actor, note = null) {
  if (status === 'DELIVERED') await insertAttempt(c, orderId, { outcome: 'DELIVERED', method: 'staff', note: note?.trim() || null }, actor)
  if (status === 'DELIVERY_FAILED') await insertAttempt(c, orderId, { outcome: 'FAILED', method: 'staff', reason: 'OTHER', note: note?.trim() || null }, actor)
}

const attemptView = (a) => ({
  id: a.id, outcome: a.outcome, method: a.method, receivedBy: a.received_by, reason: a.reason, reasonLabel: a.reason ? FAIL_LABEL[a.reason] : null,
  note: a.note, photoId: a.photo_id, lat: a.lat === null ? null : Number(a.lat), lng: a.lng === null ? null : Number(a.lng), actor: a.actor, at: a.created_at,
})

export async function attemptsFor(c, orderId) {
  const { rows } = await c.query('SELECT * FROM delivery_attempts WHERE order_id = $1 ORDER BY created_at, id', [orderId])
  return rows.map(attemptView)
}

/** What the customer sees: the code while it's on the way, then how it was delivered. */
export async function customerDelivery(c, o) {
  const { rows } = await c.query(
    "SELECT * FROM delivery_attempts WHERE order_id = $1 AND outcome = 'DELIVERED' ORDER BY created_at DESC LIMIT 1",
    [o.id],
  )
  const d = rows[0]
  return {
    deliveryCode: o.status === 'OUT_FOR_DELIVERY' ? o.delivery_code : null,
    delivery: d && o.status === 'DELIVERED' ? { at: d.created_at, method: d.method, receivedBy: d.received_by, hasPhoto: Boolean(d.photo_id) } : null,
  }
}

export async function customerPhoto(c, o) {
  const { rows } = await c.query(
    `SELECT p.mime, p.bytes, p.blob_path FROM delivery_attempts a JOIN delivery_photos p ON p.id = a.photo_id
      WHERE a.order_id = $1 AND a.outcome = 'DELIVERED' ORDER BY a.created_at DESC LIMIT 1`,
    [o.id],
  )
  if (!rows.length || o.status !== 'DELIVERED') throw notFound('No delivery photo for this order')
  return rows[0]
}

/**
 * Deliveries proven only by a photo, or marked delivered by a manager with no
 * proof at all ("staff"), not yet checked by someone else. A photo after wrong
 * codes, or with no location, is flagged: those are how a delivery would be faked.
 */
export async function photoReviews(c, limit = 50) {
  const { rows } = await c.query(
    `SELECT a.*, o.number, o.delivery_code_tries, o.customer_name, o.gift_recipient_name
       FROM delivery_attempts a JOIN orders o ON o.id = a.order_id
      WHERE a.outcome = 'DELIVERED' AND a.method IN ('photo', 'staff') AND a.reviewed_at IS NULL
      ORDER BY a.created_at LIMIT $1`,
    [limit],
  )
  return rows.map((a) => ({
    ...attemptView(a),
    order: { id: a.order_id, number: a.number, name: a.gift_recipient_name ?? a.customer_name },
    flags: [
      ...(a.method === 'staff' ? ['no proof: marked delivered from the panel'] : []),
      ...(a.delivery_code_tries > 0 ? [`${a.delivery_code_tries} wrong code${a.delivery_code_tries === 1 ? '' : 's'} first`] : []),
      ...(a.lat === null && a.method === 'photo' ? ['no location'] : []),
    ],
  }))
}

/** Marks a photo delivery checked. A doubtful one goes on the order's history for follow-up. */
export async function reviewDelivery(c, attemptId, { ok, note }, actor) {
  const { rows } = await c.query(
    `SELECT a.*, o.status FROM delivery_attempts a JOIN orders o ON o.id = a.order_id WHERE a.id = $1 FOR UPDATE OF a`,
    [attemptId],
  )
  const a = rows[0]
  if (!a || !['photo', 'staff'].includes(a.method) || a.outcome !== 'DELIVERED') throw notFound('Photo delivery not found')
  if (a.reviewed_at) throw conflict('This delivery was already checked.')
  if (a.actor === (actor.label ?? actor.id)) throw new HttpError(403, 'FORBIDDEN', 'Someone other than the rider has to check this delivery.')
  if (!ok && !note?.trim()) throw badRequest('Say what looks wrong', 'NOTE_REQUIRED')
  await c.query('UPDATE delivery_attempts SET reviewed_at = $2, reviewed_by = $3, review_note = $4 WHERE id = $1', [
    a.id, now(), actor.label ?? actor.id, ok ? note?.trim() || null : `Doubtful: ${note.trim()}`,
  ])
  if (!ok) {
    await addEvent(c, a.order_id, a.status, a.status, actor, `Delivery photo doubted: ${note.trim()}. Call the customer.`)
  }
}
