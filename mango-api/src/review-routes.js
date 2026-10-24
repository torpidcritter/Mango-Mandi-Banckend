// Review routes. customerReviews is mounted inside the /v1 router (the
// /reviews and /me paths there require a signed-in customer; the product
// review list and approved photos are public). staffReviews is mounted inside
// /admin/v1, after its sign-in, role (access.js) and audit middleware.
import express from 'express'
import { z } from 'zod'
import { now } from './clock.js'
import { query, tx } from './db.js'
import { asyncHandler, badRequest, conflict, HttpError, notFound, parse } from './errors.js'
import { newId } from './ids.js'
import { logger } from './logger.js'
import {
  blobUploadsOn,
  checkPhoto,
  cleanImage,
  deleteUpload,
  dropPhoto,
  MAX_REVIEW_UPLOAD_BYTES,
  photoWidth,
  readUpload,
  reviewUploadToken,
  sendPhoto,
  sendPublicPhoto,
  storePhoto,
  UPLOAD_PREFIX,
} from './photos.js'
import { findProduct } from './products.js'
import { hit } from './ratelimit.js'
import {
  alreadyReviewed,
  bodyHash,
  decodeCursor,
  deliveredAt,
  displayName,
  EDIT_HOURS,
  encodeCursor,
  flagReasons,
  lowRatingFollowUp,
  MAX_COMMENT,
  MAX_REVIEW_PHOTOS,
  ownReview,
  ownView,
  photosFor,
  publicView,
  repliesFor,
  REVIEW_STATUSES,
  REVIEW_WINDOW_DAYS,
  reviewableUntil,
  staffView,
  statsView,
  transition,
} from './reviews.js'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
/** Per customer per hour: review sends and edits, and photo uploads. */
export const REVIEW_SUBMITS_PER_HOUR = 30
export const PHOTO_UPLOADS_PER_HOUR = 30
/** Photos uploaded but not yet sent with a review, per customer. */
const MAX_LOOSE_PHOTOS = 10
export const MAX_BULK = 50
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']

async function rateLimit(key, max, message) {
  const r = await hit(key, HOUR_MS)
  if (r.hits > max) throw new HttpError(429, 'RATE_LIMITED', message)
}

/** Plain text only: control characters out, runs of blank lines squeezed. Never rendered as HTML. */
const cleanText = (s) =>
  s == null
    ? null
    : String(s)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮]/g, '')
        .replace(/\r\n?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim() || null

const stars = z.number().int().min(1).max(5)
const subStars = stars.optional().nullable()
const comment = z.string().max(MAX_COMMENT * 2).transform(cleanText).refine((s) => s == null || s.length <= MAX_COMMENT, `Keep the review to ${MAX_COMMENT} characters`)
const photoIds = z.array(z.string().max(40)).max(MAX_REVIEW_PHOTOS, `Add at most ${MAX_REVIEW_PHOTOS} photos`)

const createSchema = z.object({
  orderItemId: z.string().min(1).max(64),
  rating: stars,
  taste: subStars,
  ripenessAccuracy: subStars,
  packaging: subStars,
  delivery: subStars,
  comment: comment.optional().nullable(),
  anonymous: z.boolean().optional().default(false),
  photoIds: photoIds.default([]),
})

const editSchema = z
  .object({
    rating: stars.optional(),
    taste: subStars,
    ripenessAccuracy: subStars,
    packaging: subStars,
    delivery: subStars,
    comment: comment.optional().nullable(),
    anonymous: z.boolean().optional(),
    photoIds: photoIds.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change')

const SUB_COLUMNS = { taste: 'taste', ripenessAccuracy: 'ripeness_accuracy', packaging: 'packaging', delivery: 'delivery' }

// ================================================================ customer

export const customerReviews = express.Router()

/** Attaches the customer's loose photos to a review; fails if any isn't theirs or is already used. */
async function attachPhotos(c, reviewId, customerId, ids) {
  const unique = [...new Set(ids)]
  if (!unique.length) return
  const r = await c.query(
    'UPDATE review_photos SET review_id = $1 WHERE id = ANY($2) AND customer_id = $3 AND review_id IS NULL AND removed_at IS NULL',
    [reviewId, unique, customerId],
  )
  if (r.rowCount !== unique.length) throw badRequest('One of the photos was not found. Add it again.', 'PHOTO_NOT_FOUND')
}

/** Removes a review's photos (all, or all but `keep`). Returns the rows whose stored image must be dropped. */
async function removePhotos(c, reviewId, keep = []) {
  const { rows } = await c.query(
    `SELECT id, blob_path FROM review_photos WHERE review_id = $1 AND removed_at IS NULL AND NOT (id = ANY($2)) FOR UPDATE`,
    [reviewId, keep],
  )
  if (rows.length) await c.query('UPDATE review_photos SET removed_at = $2, bytes = NULL, blob_path = NULL WHERE id = ANY($1)', [rows.map((r) => r.id), now()])
  return rows
}

const customerName = async (c, customerId) => (await c.query('SELECT name FROM customers WHERE id = $1', [customerId])).rows[0]?.name ?? null

/** My reviews, and the delivered items I can still review (newest first). */
customerReviews.get(
  '/me/reviews',
  asyncHandler(async (req, res) => {
    const orderId = req.query.orderId ? String(req.query.orderId) : null
    const at = now()
    const [mine, open] = await Promise.all([
      query(
        `SELECT * FROM reviews WHERE customer_id = $1 AND status <> 'DELETED' AND ($2::text IS NULL OR order_id = $2) ORDER BY created_at DESC, id DESC LIMIT 100`,
        [req.customer.id, orderId],
      ),
      query(
        `SELECT i.id, i.order_id, o.number, i.sku, i.stage, i.quantity, d.at AS delivered_at
           FROM orders o JOIN order_items i ON i.order_id = o.id
           JOIN LATERAL (SELECT MAX(created_at) AS at FROM order_events e WHERE e.order_id = o.id AND e.status = 'DELIVERED') d ON TRUE
          WHERE o.customer_id = $1 AND o.status = 'DELIVERED' AND d.at > $2 AND ($3::text IS NULL OR o.id = $3)
            AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.order_item_id = i.id)
          ORDER BY d.at DESC, i.sku, i.stage LIMIT 100`,
        [req.customer.id, new Date(at.getTime() - REVIEW_WINDOW_DAYS * DAY_MS), orderId],
      ),
    ])
    const ids = mine.rows.map((r) => r.id)
    const [photos, replies] = await Promise.all([photosFor({ query }, ids), repliesFor({ query }, ids)])
    res.json({
      reviews: mine.rows.map((r) => ownView(r, photos.get(r.id), replies.get(r.id), at)),
      reviewable: open.rows.map((i) => {
        const p = findProduct(i.sku)
        return {
          orderItemId: i.id, orderId: i.order_id, orderNumber: i.number, sku: i.sku, productName: p?.name ?? i.sku, variety: p?.variety ?? '',
          ripenessOrdered: i.stage, quantity: i.quantity, deliveredAt: i.delivered_at, reviewableUntil: reviewableUntil(i.delivered_at),
        }
      }),
    })
  }),
)

/**
 * Where the phone should send a review photo. With Vercel Blob it gets a
 * 10-minute token for one private path in the upload folder (5 MB, images
 * only) and uploads there directly; otherwise it posts the photo here.
 */
customerReviews.post(
  '/reviews/photos/upload-token',
  asyncHandler(async (req, res) => {
    if (!blobUploadsOn()) return res.json({ mode: 'direct', maxBytes: MAX_REVIEW_UPLOAD_BYTES })
    await rateLimit(`review-photo:${req.customer.id}`, PHOTO_UPLOADS_PER_HOUR, 'Too many photos this hour. Try again later.')
    const pathname = `${UPLOAD_PREFIX}${req.customer.id}/${newId('up')}`
    res.json({ mode: 'blob', pathname, clientToken: await reviewUploadToken(pathname), maxBytes: MAX_REVIEW_UPLOAD_BYTES })
  }),
)

/**
 * Adds a photo for a review that is about to be sent: either the image as the
 * request body, or { pathname } of a direct Blob upload. The image is checked
 * by its first bytes, re-encoded without metadata and kept privately; it is
 * attached when the review is sent. Returns its id.
 */
customerReviews.post(
  '/reviews/photos',
  express.raw({ type: IMAGE_TYPES, limit: MAX_REVIEW_UPLOAD_BYTES, inflate: false }),
  asyncHandler(async (req, res) => {
    const me = req.customer.id
    let bytes = req.body
    let upload = null
    if (!Buffer.isBuffer(bytes) && req.is('application/json')) {
      const b = parse(z.object({ pathname: z.string().max(200) }), req.body)
      // Only the customer's own upload folder: another customer's path is "not found".
      if (!b.pathname.startsWith(`${UPLOAD_PREFIX}${me}/`) || !/^[\w./-]+$/.test(b.pathname) || b.pathname.includes('..')) throw notFound('Upload not found')
      bytes = await readUpload(b.pathname)
      if (!bytes) throw notFound('Upload not found')
      upload = b.pathname
    }
    try {
      // The token route already counted a direct upload.
      if (!upload) await rateLimit(`review-photo:${me}`, PHOTO_UPLOADS_PER_HOUR, 'Too many photos this hour. Try again later.')
      checkPhoto(bytes, MAX_REVIEW_UPLOAD_BYTES)
      const loose = await query('SELECT COUNT(*)::int AS n FROM review_photos WHERE customer_id = $1 AND review_id IS NULL AND removed_at IS NULL', [me])
      if (loose.rows[0].n >= MAX_LOOSE_PHOTOS) throw new HttpError(429, 'TOO_MANY_PHOTOS', 'Send your review with the photos you have added first')
      const img = await cleanImage(bytes)
      const id = newId('rph')
      const saved = await storePhoto(`reviews/${me}`, id, img.bytes, img.ext, img.mime)
      await query(
        'INSERT INTO review_photos (id, customer_id, mime, width, height, bytes, blob_path, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [id, me, img.mime, img.width, img.height, saved.bytes, saved.blobPath, now()],
      )
      res.status(201).json({ id, width: img.width, height: img.height })
    } finally {
      // The original (with its metadata) is never kept.
      if (upload) await deleteUpload(upload)
    }
  }),
)

customerReviews.get(
  '/reviews/:id/photos/:photoId',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT p.mime, p.bytes, p.blob_path FROM review_photos p JOIN reviews r ON r.id = p.review_id
        WHERE p.id = $1 AND r.id = $2 AND r.customer_id = $3 AND r.status <> 'DELETED' AND p.removed_at IS NULL`,
      [req.params.photoId, req.params.id, req.customer.id],
    )
    if (!rows.length) throw notFound('Photo not found')
    await sendPhoto(res, rows[0])
  }),
)

/**
 * Sends a review of one delivered order line. Needs an Idempotency-Key: a
 * retry with the same key and body returns the same review; the same key with
 * a different body is refused. One review per line, however many requests
 * race (the unique index decides).
 */
customerReviews.post(
  '/reviews',
  asyncHandler(async (req, res) => {
    const rawKey = req.get('Idempotency-Key')
    if (!rawKey || rawKey.length > 100) throw badRequest('An Idempotency-Key header is required', 'IDEMPOTENCY_KEY_REQUIRED')
    const b = parse(createSchema, req.body)
    const me = req.customer.id
    const key = `${me}:rev:${rawKey}`
    const hash = bodyHash(b)

    const replay = async () => {
      const { rows } = await query('SELECT k.request_hash, r.* FROM idempotency_keys k JOIN reviews r ON r.id = k.order_id WHERE k.key = $1', [key])
      if (!rows.length) return false
      if (rows[0].request_hash !== hash) throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different review')
      await respond(rows[0], 200)
      return true
    }
    const respond = async (r, status) => {
      const photos = await photosFor({ query }, [r.id])
      res.status(status).json({ review: ownView(r, photos.get(r.id)), followUp: lowRatingFollowUp(r) })
    }
    if (await replay()) return

    await rateLimit(`review-submit:${me}`, REVIEW_SUBMITS_PER_HOUR, 'Too many reviews this hour. Try again later.')
    const review = await tx(async (c) => {
      // Claimed first: a retry with the same key waits here, then replays.
      const ins = await c.query('INSERT INTO idempotency_keys (key, order_id, created_at, request_hash) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [
        key, 'pending', now(), hash,
      ])
      if (!ins.rowCount) return null
      const { rows } = await c.query(
        `SELECT i.id, i.sku, i.stage, o.id AS order_id, o.status, o.customer_name FROM order_items i JOIN orders o ON o.id = i.order_id
          WHERE i.id = $1 AND o.customer_id = $2`,
        [b.orderItemId, me],
      )
      const item = rows[0]
      // Someone else's order line looks exactly like one that doesn't exist.
      if (!item) throw notFound('Order item not found')
      if (item.status !== 'DELIVERED') throw badRequest('You can review an item once it is delivered', 'NOT_DELIVERED')
      const delivered = await deliveredAt(c, item.order_id)
      if (!delivered) throw badRequest('You can review an item once it is delivered', 'NOT_DELIVERED')
      const at = now()
      if (at > reviewableUntil(delivered)) throw badRequest(`Reviews can be written up to ${REVIEW_WINDOW_DAYS} days after delivery`, 'REVIEW_WINDOW_CLOSED')
      const product = findProduct(item.sku)
      const name = (await customerName(c, me)) ?? item.customer_name
      const flags = flagReasons(b.comment)
      const id = newId('rvw')
      const { rows: made } = await c.query(
        `INSERT INTO reviews (id, order_id, order_item_id, customer_id, sku, variety, stage, rating, taste, ripeness_accuracy, packaging, delivery,
                              comment, anonymous, display_name, flagged, flag_reasons, delivered_at, created_at, updated_at, editable_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19, $20)
         ON CONFLICT (order_item_id) DO NOTHING RETURNING *`,
        [
          id, item.order_id, item.id, me, item.sku, product?.variety || item.sku, item.stage, b.rating, b.taste ?? null, b.ripenessAccuracy ?? null,
          b.packaging ?? null, b.delivery ?? null, b.comment ?? null, b.anonymous, displayName(name, b.anonymous), flags.length > 0, flags,
          delivered, at, new Date(at.getTime() + EDIT_HOURS * HOUR_MS),
        ],
      )
      if (!made.length) throw alreadyReviewed()
      await attachPhotos(c, id, me, b.photoIds)
      // Which batches filled this line, for ripeness accuracy per batch. Read only.
      await c.query(
        `INSERT INTO review_batches (review_id, batch_id, quantity)
           SELECT $1, batch_id, SUM(quantity) FROM order_stock
            WHERE order_id = $2 AND sku = $3 AND ($4::text IS NULL OR stage = $4) AND state <> 'released'
            GROUP BY batch_id`,
        [id, item.order_id, item.sku, item.stage],
      )
      await c.query('INSERT INTO review_events (id, review_id, from_status, to_status, actor, reason, created_at) VALUES ($1, $2, NULL, $3, $4, $5, $6)', [
        newId('rev'), id, 'PENDING', `customer:${me}`, flags.length ? `flagged: ${flags.join(', ')}` : null, at,
      ])
      await c.query('UPDATE idempotency_keys SET order_id = $2 WHERE key = $1', [key, id])
      return made[0]
    })
    if (!review) {
      if (await replay()) return
      throw conflict('This request is still being processed. Try again.', 'IN_PROGRESS')
    }
    if (review.rating <= 2) logger.info({ reviewId: review.id, rating: review.rating }, 'low rating received')
    await respond(review, 201)
  }),
)

/** Changes a review within 48 hours of sending it. It goes back to staff for a fresh look. */
customerReviews.patch(
  '/reviews/:id',
  asyncHandler(async (req, res) => {
    const b = parse(editSchema, req.body)
    const me = req.customer.id
    await rateLimit(`review-submit:${me}`, REVIEW_SUBMITS_PER_HOUR, 'Too many changes this hour. Try again later.')
    const out = await tx(async (c) => {
      const cur = await ownReview(c, req.params.id, me, { lock: true })
      if (cur.editable_until <= now()) throw conflict(`Reviews can be changed for ${EDIT_HOURS} hours after you send them`, 'EDIT_WINDOW_CLOSED')
      const set = {}
      if (b.rating !== undefined) set.rating = b.rating
      for (const [k, col] of Object.entries(SUB_COLUMNS)) if (b[k] !== undefined) set[col] = b[k] ?? null
      if (b.comment !== undefined) {
        set.comment = b.comment ?? null
        const flags = flagReasons(set.comment)
        set.flagged = flags.length > 0
        set.flag_reasons = flags
      }
      if (b.anonymous !== undefined) {
        set.anonymous = b.anonymous
        set.display_name = displayName(await customerName(c, me), b.anonymous)
      }
      let dropped = []
      const { review } = await transition(c, cur.id, 'EDIT', {
        actor: `customer:${me}`,
        customerId: me,
        set,
        reason: 'edited by the customer',
        // Photos change after the old version left the totals.
        beforeCount: async () => {
          if (b.photoIds === undefined) return
          const keep = [...new Set(b.photoIds)]
          dropped = await removePhotos(c, cur.id, keep)
          const { rows } = await c.query('SELECT id FROM review_photos WHERE review_id = $1 AND removed_at IS NULL', [cur.id])
          const have = new Set(rows.map((r) => r.id))
          await attachPhotos(c, cur.id, me, keep.filter((id) => !have.has(id)))
        },
      })
      return { review, dropped }
    })
    for (const p of out.dropped) await dropPhoto(p)
    const photos = await photosFor({ query }, [out.review.id])
    res.json({ review: ownView(out.review, photos.get(out.review.id)), followUp: lowRatingFollowUp(out.review) })
  }),
)

/** Deletes my review: text and photos are removed and it leaves the totals. */
customerReviews.delete(
  '/reviews/:id',
  asyncHandler(async (req, res) => {
    const me = req.customer.id
    const dropped = await tx(async (c) => {
      let rows = []
      await transition(c, req.params.id, 'DELETE', {
        actor: `customer:${me}`,
        customerId: me,
        set: { comment: null },
        beforeCount: async () => {
          rows = await removePhotos(c, req.params.id)
          await c.query('DELETE FROM review_replies WHERE review_id = $1', [req.params.id])
        },
      })
      return rows
    })
    for (const p of dropped) await dropPhoto(p)
    res.status(204).end()
  }),
)

// ---------------------------------------------------------------- public

const PUBLIC_CACHE = 'public, max-age=60, s-maxage=60'

const listQuery = z.object({
  scope: z.enum(['variety', 'sku']).default('variety'),
  stars: z.coerce.number().int().min(1).max(5).optional(),
  withPhotos: z.enum(['true', 'false', '1', '0']).optional().transform((v) => v === 'true' || v === '1'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
})

/**
 * Approved reviews of a product (or, by default, of its whole variety, since
 * a 3 kg and a 5 kg box are the same fruit), newest first, with the totals.
 * No sign-in; nothing that identifies the customer or their order.
 */
customerReviews.get(
  '/products/:sku/reviews',
  asyncHandler(async (req, res) => {
    const product = findProduct(req.params.sku)
    if (!product) throw notFound('Product not found')
    const q = parse(listQuery, req.query)
    const cur = decodeCursor(q.cursor)
    const key = q.scope === 'sku' ? product.sku : product.variety || product.sku
    const col = q.scope === 'sku' ? 'sku' : 'variety'
    const [list, stats] = await Promise.all([
      query(
        `SELECT r.* FROM reviews r
          WHERE r.status = 'APPROVED' AND r.${col} = $1
            AND ($2::int IS NULL OR r.rating = $2)
            AND (NOT $3 OR EXISTS (SELECT 1 FROM review_photos p WHERE p.review_id = r.id AND p.approved_at IS NOT NULL AND p.removed_at IS NULL))
            AND ($4::timestamptz IS NULL OR (r.created_at, r.id) < ($4::timestamptz, $5::text))
          ORDER BY r.created_at DESC, r.id DESC LIMIT $6`,
        [key, q.stars ?? null, q.withPhotos, cur?.at ?? null, cur?.id ?? '', q.limit + 1],
      ),
      query('SELECT * FROM review_stats WHERE scope = $1 AND key = $2', [q.scope === 'sku' ? 'SKU' : 'VARIETY', key]),
    ])
    const page = list.rows.slice(0, q.limit)
    const ids = page.map((r) => r.id)
    const [photos, replies] = await Promise.all([photosFor({ query }, ids, { publicOnly: true }), repliesFor({ query }, ids)])
    res.set('Cache-Control', PUBLIC_CACHE).json({
      product: { sku: product.sku, name: product.name, variety: product.variety },
      scope: q.scope,
      summary: statsView(stats.rows[0]),
      items: page.map((r) => publicView(r, photos.get(r.id), replies.get(r.id))),
      nextCursor: list.rows.length > q.limit ? encodeCursor(page.at(-1)) : null,
    })
  }),
)

/**
 * Review photos never change once uploaded (a new photo gets a new id; a removed one loses its
 * bytes and turns "not found"), so browsers keep them for 30 days. Shared caches keep them only
 * 10 minutes, so a photo taken down by moderation or erasure stops being served soon after.
 */
export const REVIEW_PHOTO_CACHE = 'public, max-age=2592000, s-maxage=600, immutable'

/** An approved photo of an approved review. Anything else is "not found". ?w= sends a thumbnail (see PHOTO_WIDTHS). */
customerReviews.get(
  '/review-photos/:id',
  asyncHandler(async (req, res) => {
    const width = photoWidth(req.query.w)
    const { rows } = await query(
      `SELECT p.mime, p.bytes, p.blob_path FROM review_photos p JOIN reviews r ON r.id = p.review_id
        WHERE p.id = $1 AND p.approved_at IS NOT NULL AND p.removed_at IS NULL AND r.status = 'APPROVED'`,
      [req.params.id],
    )
    if (!rows.length) throw notFound('Photo not found')
    await sendPublicPhoto(res, rows[0], { key: `review:${req.params.id}`, width, cache: REVIEW_PHOTO_CACHE })
  }),
)

// ================================================================ staff

export const staffReviews = express.Router()

const reason = z.string().trim().min(3, 'Give a short reason').max(500)

const queueQuery = z.object({
  status: z.enum(REVIEW_STATUSES).default('PENDING'),
  stars: z.coerce.number().int().min(1).max(5).optional(),
  hasPhotos: z.enum(['true', 'false']).optional(),
  flagged: z.enum(['true', 'false']).optional(),
  variety: z.string().max(80).optional(),
  sku: z.string().max(40).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

const STAFF_SELECT = `SELECT r.*, o.number AS order_number, c.name AS customer_name FROM reviews r
  JOIN orders o ON o.id = r.order_id LEFT JOIN customers c ON c.id = r.customer_id`

async function staffViews(rows) {
  const ids = rows.map((r) => r.id)
  const [photos, replies] = await Promise.all([photosFor({ query }, ids), repliesFor({ query }, ids)])
  return rows.map((r) => staffView(r, photos.get(r.id), replies.get(r.id)))
}

/** The moderation queue: pending by default, flagged ones first. */
staffReviews.get(
  '/reviews',
  asyncHandler(async (req, res) => {
    const q = parse(queueQuery, req.query)
    const cur = decodeCursor(q.cursor)
    const hasPhotos = q.hasPhotos === undefined ? null : q.hasPhotos === 'true'
    const flagged = q.flagged === undefined ? null : q.flagged === 'true'
    const { rows } = await query(
      `${STAFF_SELECT}
        WHERE r.status = $1 AND ($2::int IS NULL OR r.rating = $2)
          AND ($3::bool IS NULL OR $3 = EXISTS (SELECT 1 FROM review_photos p WHERE p.review_id = r.id AND p.removed_at IS NULL))
          AND ($4::bool IS NULL OR r.flagged = $4) AND ($5::text IS NULL OR r.variety = $5) AND ($6::text IS NULL OR r.sku = $6)
          AND ($7::timestamptz IS NULL OR (r.created_at, r.id) < ($7::timestamptz, $8::text))
        ORDER BY r.created_at DESC, r.id DESC LIMIT $9`,
      [q.status, q.stars ?? null, hasPhotos, flagged, q.variety ?? null, q.sku ?? null, cur?.at ?? null, cur?.id ?? '', q.limit + 1],
    )
    const page = rows.slice(0, q.limit)
    const counts = await query(`SELECT status, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE flagged)::int AS flagged FROM reviews GROUP BY status`)
    res.json({
      items: await staffViews(page),
      nextCursor: rows.length > q.limit ? encodeCursor(page.at(-1)) : null,
      counts: Object.fromEntries(counts.rows.map((r) => [r.status, { total: r.n, flagged: r.flagged }])),
    })
  }),
)

const insightsQuery = z.object({
  days: z.coerce.number().int().min(7).max(365).default(90),
  variety: z.string().max(80).optional(),
  batchId: z.string().max(64).optional(),
})

/**
 * Quality data for managers and QC: average stars by variety, "ripe as
 * promised" per batch, and the weekly share of 1 and 2 star reviews. Counts
 * every review except rejected and deleted ones (pending ones too: this is
 * about the fruit, not what is public).
 */
staffReviews.get(
  '/reviews/insights',
  asyncHandler(async (req, res) => {
    const q = parse(insightsQuery, req.query)
    const since = new Date(now().getTime() - q.days * DAY_MS)
    const live = `r.status IN ('PENDING', 'APPROVED', 'HIDDEN') AND r.created_at >= $1 AND ($2::text IS NULL OR r.variety = $2)`
    const avg = (col) => `ROUND(AVG(${col})::numeric, 2)::float`
    const [byVariety, byBatch, trend] = await Promise.all([
      query(
        `SELECT r.variety, COUNT(*)::int AS reviews, ${avg('r.rating')} AS average_rating,
                COUNT(r.ripeness_accuracy)::int AS ripeness_answers, ${avg('r.ripeness_accuracy')} AS ripeness_accuracy,
                COUNT(*) FILTER (WHERE r.rating <= 2)::int AS low
           FROM reviews r WHERE ${live} GROUP BY r.variety ORDER BY r.variety`,
        [since, q.variety ?? null],
      ),
      query(
        `SELECT b.id AS batch_id, b.variety, b.plucked_on, b.farm, COUNT(DISTINCT r.id)::int AS reviews,
                ${avg('r.rating')} AS average_rating, COUNT(r.ripeness_accuracy)::int AS ripeness_answers,
                ${avg('r.ripeness_accuracy')} AS ripeness_accuracy, COUNT(*) FILTER (WHERE r.ripeness_accuracy <= 2)::int AS not_as_promised
           FROM review_batches rb JOIN reviews r ON r.id = rb.review_id JOIN batches b ON b.id = rb.batch_id
          WHERE ${live} AND ($3::text IS NULL OR b.id = $3)
          GROUP BY b.id ORDER BY b.plucked_on DESC, b.id LIMIT 100`,
        [since, q.variety ?? null, q.batchId ?? null],
      ),
      query(
        `SELECT to_char(date_trunc('week', r.created_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS week,
                COUNT(*)::int AS reviews, COUNT(*) FILTER (WHERE r.rating <= 2)::int AS low
           FROM reviews r WHERE ${live} GROUP BY 1 ORDER BY 1`,
        [since, q.variety ?? null],
      ),
    ])
    res.json({
      days: q.days,
      byVariety: byVariety.rows.map((r) => ({
        variety: r.variety, reviews: r.reviews, averageRating: r.average_rating, ripenessAnswers: r.ripeness_answers, ripenessAccuracy: r.ripeness_accuracy, low: r.low,
      })),
      byBatch: byBatch.rows.map((r) => ({
        batchId: r.batch_id, variety: r.variety, pluckedOn: r.plucked_on, farm: r.farm, reviews: r.reviews, averageRating: r.average_rating,
        ripenessAnswers: r.ripeness_answers, ripenessAccuracy: r.ripeness_accuracy, notAsPromised: r.not_as_promised,
      })),
      lowRatingTrend: trend.rows,
    })
  }),
)

async function staffReview(id) {
  const { rows } = await query(`${STAFF_SELECT} WHERE r.id = $1`, [id])
  if (!rows.length) throw notFound('Review not found')
  return rows[0]
}

staffReviews.get(
  '/reviews/:id',
  asyncHandler(async (req, res) => {
    const r = await staffReview(req.params.id)
    const [[view], events, batches] = await Promise.all([
      staffViews([r]),
      query('SELECT from_status, to_status, actor, reason, created_at FROM review_events WHERE review_id = $1 ORDER BY created_at, id', [r.id]),
      query(
        `SELECT rb.batch_id, rb.quantity, b.variety, b.plucked_on, b.farm FROM review_batches rb JOIN batches b ON b.id = rb.batch_id
          WHERE rb.review_id = $1 ORDER BY b.plucked_on, b.id`,
        [r.id],
      ),
    ])
    res.json({
      ...view,
      events: events.rows.map((e) => ({ from: e.from_status, to: e.to_status, actor: e.actor, reason: e.reason, at: e.created_at })),
      batches: batches.rows.map((b) => ({ batchId: b.batch_id, quantity: b.quantity, variety: b.variety, pluckedOn: b.plucked_on, farm: b.farm })),
    })
  }),
)

staffReviews.get(
  '/reviews/:id/photos/:photoId',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT mime, bytes, blob_path FROM review_photos WHERE id = $1 AND review_id = $2 AND removed_at IS NULL', [
      req.params.photoId, req.params.id,
    ])
    if (!rows.length) throw notFound('Photo not found')
    await sendPhoto(res, rows[0])
  }),
)

const moderated = (req, why) => ({ moderated_by: req.admin.email, moderated_at: now(), moderation_reason: why ?? null })

/** Approves a pending review, and the photos named in photoIds (others stay private). */
async function approve(c, req, id, { reason: why = null, photoIds: approvedPhotos = [] } = {}) {
  return await transition(c, id, 'APPROVE', {
    actor: `staff:${req.admin.email}`,
    reason: why,
    set: moderated(req, why),
    beforeCount: async () => {
      const ids = [...new Set(approvedPhotos)]
      if (!ids.length) return
      const r = await c.query(
        'UPDATE review_photos SET approved_at = $3, approved_by = $4 WHERE review_id = $1 AND id = ANY($2) AND removed_at IS NULL',
        [id, ids, now(), req.admin.email],
      )
      if (r.rowCount !== ids.length) throw badRequest('One of the photos is not on this review', 'PHOTO_NOT_FOUND')
    },
  })
}

const reject = (c, req, id, why) => transition(c, id, 'REJECT', { actor: `staff:${req.admin.email}`, reason: why, set: moderated(req, why) })

staffReviews.post(
  '/reviews/:id/approve',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ reason: z.string().trim().max(500).optional().nullable(), photoIds: z.array(z.string().max(40)).max(MAX_REVIEW_PHOTOS).default([]) }), req.body ?? {})
    await tx((c) => approve(c, req, req.params.id, b))
    res.json((await staffViews([await staffReview(req.params.id)]))[0])
  }),
)

staffReviews.post(
  '/reviews/:id/reject',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ reason }), req.body)
    await tx((c) => reject(c, req, req.params.id, b.reason))
    res.json((await staffViews([await staffReview(req.params.id)]))[0])
  }),
)

staffReviews.post(
  '/reviews/:id/hide',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ reason }), req.body)
    await tx((c) => transition(c, req.params.id, 'HIDE', { actor: `staff:${req.admin.email}`, reason: b.reason, set: moderated(req, b.reason) }))
    res.json((await staffViews([await staffReview(req.params.id)]))[0])
  }),
)

/** Approves or rejects up to 50 pending reviews; each one stands alone. Bulk approval never approves photos. */
staffReviews.post(
  '/reviews/bulk',
  asyncHandler(async (req, res) => {
    const b = parse(
      z
        .object({
          action: z.enum(['approve', 'reject']),
          ids: z.array(z.string().max(64)).min(1).max(MAX_BULK, `At most ${MAX_BULK} reviews at a time`),
          reason: z.string().trim().max(500).optional().nullable(),
        })
        .refine((v) => v.action !== 'reject' || (v.reason && v.reason.length >= 3), 'Give a short reason for rejecting'),
      req.body,
    )
    const done = []
    const failed = []
    for (const id of [...new Set(b.ids)]) {
      try {
        await tx((c) => (b.action === 'approve' ? approve(c, req, id, { reason: b.reason ?? null }) : reject(c, req, id, b.reason)))
        done.push(id)
      } catch (err) {
        if (!(err instanceof HttpError)) throw err
        failed.push({ id, code: err.code, message: err.message })
      }
    }
    res.json({ done, failed })
  }),
)

/** The brand's one public reply to a review (sending again replaces it). */
staffReviews.put(
  '/reviews/:id/reply',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ body: z.string().max(MAX_COMMENT * 2).transform(cleanText).refine((s) => s && s.length <= MAX_COMMENT, `Keep the reply between 1 and ${MAX_COMMENT} characters`) }), req.body)
    const r = await staffReview(req.params.id)
    if (r.status === 'DELETED') throw notFound('Review not found')
    const at = now()
    await query(
      `INSERT INTO review_replies (review_id, body, admin_id, admin_email, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (review_id) DO UPDATE SET body = EXCLUDED.body, admin_id = EXCLUDED.admin_id, admin_email = EXCLUDED.admin_email, updated_at = EXCLUDED.updated_at`,
      [r.id, b.body, req.admin.id ?? null, req.admin.email, at],
    )
    res.json((await staffViews([await staffReview(r.id)]))[0])
  }),
)

staffReviews.delete(
  '/reviews/:id/reply',
  asyncHandler(async (req, res) => {
    const r = await query('DELETE FROM review_replies WHERE review_id = $1', [req.params.id])
    if (!r.rowCount) throw notFound('Reply not found')
    res.status(204).end()
  }),
)
