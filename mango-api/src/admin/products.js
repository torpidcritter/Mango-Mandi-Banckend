// Products and their photos.
import express from 'express'
import { z } from 'zod'
import { requireManager } from '../auth.js'
import { now } from '../clock.js'
import { checkPhoto, cleanImage, dropPhoto, MAX_REVIEW_UPLOAD_BYTES, storePhoto } from '../photos.js'
import { query, tx } from '../db.js'
import { asyncHandler, conflict, notFound, parse } from '../errors.js'
import { newId } from '../ids.js'
import { allProducts, findProduct, loadProducts } from '../products.js'

export const router = express.Router()

// ---------------------------------------------------------------- products

/** Every product, hidden ones included (marked active: false), in display order. */
router.get('/products', (_req, res) => res.json(allProducts()))

const productFields = {
  name: z.string().trim().min(2, 'Give the product a name').max(80),
  variety: z.string().trim().min(2, 'Give the variety').max(40),
  boxSize: z.string().trim().max(20),
  price: z.number().int().positive('Price must be more than zero').max(10_000_000),
  gstRate: z.number().min(0).max(0.28),
  hsnCode: z.string().trim().regex(/^\d{4,8}$/, 'HSN is 4 to 8 digits').nullable(),
  description: z.string().trim().max(300),
  sortOrder: z.number().int().min(0).max(10_000),
  // What is in the box, shown on the product page when set (both optional).
  fruitsPerBox: z.number().int().min(1, 'At least 1 mango').max(200).nullable(),
  fruitWeightG: z.number().int().min(50, 'Give the weight of one mango in grams, 50 or more').max(3000).nullable(),
}
// Fresh mangoes: HSN 0804 50, nil GST.
const productDefaults = { boxSize: '', gstRate: 0, hsnCode: '08045020', description: '', sortOrder: 0, fruitsPerBox: null, fruitWeightG: null }

/** Adds a product. It goes on sale at once; stock arrives with the next batch. */
router.post(
  '/products',
  requireManager,
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({
        sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, 'Use 2 to 20 letters, digits and dashes, like KES-3'),
        ...Object.fromEntries(Object.entries(productFields).map(([k, v]) => [k, k in productDefaults ? v.default(productDefaults[k]) : v])),
      }),
      req.body,
    )
    const { rows } = await query(
      `INSERT INTO products (sku, name, variety, box_size, price, gst_rate, hsn_code, description, sort_order, created_at, fruits_per_box, fruit_weight_g)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (sku) DO NOTHING RETURNING sku`,
      [b.sku, b.name, b.variety, b.boxSize, b.price, b.gstRate, b.hsnCode, b.description, b.sortOrder, now(), b.fruitsPerBox, b.fruitWeightG],
    )
    if (!rows.length) throw conflict('A product with that SKU already exists', 'PRODUCT_EXISTS')
    await loadProducts()
    req.params.id = b.sku
    res.status(201).json(findProduct(b.sku))
  }),
)

/**
 * Renames or edits a product, or puts a removed one back on sale. The SKU never
 * changes. The variety is fixed once a batch holds the product, because a
 * batch is one variety. A new price applies to quotes from now on; orders
 * already placed keep theirs.
 */
router.patch(
  '/products/:sku',
  requireManager,
  asyncHandler(async (req, res) => {
    const fields = Object.fromEntries(Object.entries(productFields).map(([k, v]) => [k, v.optional()]))
    // ADM-2: an optional reason, kept in the staff activity with the values before the change.
    const b = parse(z.object({ ...fields, active: z.boolean().optional(), reason: z.string().trim().max(300).optional() }).strict(), req.body)
    const sku = req.params.sku
    await tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM products WHERE sku = $1 FOR UPDATE', [sku])
      if (!rows.length) throw notFound('No product with that SKU')
      if (b.variety !== undefined && b.variety !== rows[0].variety) {
        const used = await c.query('SELECT 1 FROM batch_lines WHERE sku = $1 LIMIT 1', [sku])
        if (used.rows.length) throw conflict('The variety cannot change once a batch holds this product. Add a new product instead.', 'VARIETY_LOCKED')
      }
      const cols = {
        name: 'name', variety: 'variety', boxSize: 'box_size', price: 'price', gstRate: 'gst_rate', hsnCode: 'hsn_code', description: 'description', sortOrder: 'sort_order', active: 'active',
        fruitsPerBox: 'fruits_per_box', fruitWeightG: 'fruit_weight_g',
      }
      const set = Object.entries(cols).filter(([k]) => b[k] !== undefined)
      await c.query(
        `UPDATE products SET ${set.map(([, col], i) => `${col} = $${i + 2}`).concat(`updated_at = $${set.length + 2}`).join(', ')} WHERE sku = $1`,
        [sku, ...set.map(([k]) => b[k]), now()],
      )
      // ADM-2: the staff activity row, with what each changed field was before, written with the
      // change itself so it cannot be lost after the response. The generic after-response row is skipped.
      const was = (k, col) => (k === 'gstRate' ? Number(rows[0][col]) : rows[0][col])
      const before = Object.fromEntries(set.filter(([k, col]) => was(k, col) !== b[k]).map(([k, col]) => [k, was(k, col)]))
      await c.query(
        `INSERT INTO staff_audit (id, admin_id, email, role, action, target, detail, request_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [newId('aud'), req.admin.id ?? null, req.admin.email, req.admin.role, 'PATCH /products/:sku', sku, { ...b, before }, req.id ?? null, now()],
      )
      req.audited = true
    })
    await loadProducts()
    res.json(findProduct(sku))
  }),
)

/**
 * Removes a product. One that was never stocked, ordered or offered for
 * preorder is deleted outright. Otherwise it is taken off sale (hidden from
 * the shop, WhatsApp, preorders and new batches) and kept, so past orders and
 * batches keep its name; it can be put back on sale later.
 */
router.delete(
  '/products/:sku',
  requireManager,
  asyncHandler(async (req, res) => {
    const sku = req.params.sku
    const outcome = await tx(async (c) => {
      const { rows } = await c.query('SELECT 1 FROM products WHERE sku = $1 FOR UPDATE', [sku])
      if (!rows.length) throw notFound('No product with that SKU')
      const { rows: used } = await c.query(
        `SELECT EXISTS (SELECT 1 FROM batch_lines WHERE sku = $1) OR EXISTS (SELECT 1 FROM order_items WHERE sku = $1)
             OR EXISTS (SELECT 1 FROM preorders WHERE sku = $1) OR EXISTS (SELECT 1 FROM preorder_capacity WHERE sku = $1) AS used`,
        [sku],
      )
      if (used[0].used) {
        await c.query('UPDATE products SET active = FALSE, updated_at = $2 WHERE sku = $1', [sku, now()])
        return 'hidden'
      }
      await c.query('DELETE FROM carts WHERE sku = $1', [sku])
      await c.query('DELETE FROM products WHERE sku = $1', [sku])
      return 'deleted'
    })
    await loadProducts()
    res.json({ sku, outcome })
  }),
)

/**
 * Sets the product's photo: the image (JPEG, PNG or WebP) is the request body.
 * It is checked by its first bytes, re-encoded as a JPEG of at most 1200 px
 * without metadata, and replaces any earlier photo. The shop shows it at once.
 */
router.put(
  '/products/:sku/photo',
  requireManager,
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_REVIEW_UPLOAD_BYTES, inflate: false }),
  asyncHandler(async (req, res) => {
    const sku = req.params.sku
    if (!findProduct(sku)) throw notFound('No product with that SKU')
    checkPhoto(req.body, MAX_REVIEW_UPLOAD_BYTES)
    const img = await cleanImage(req.body, 1200)
    const { rows: old } = await query('SELECT version, blob_path FROM product_photos WHERE sku = $1', [sku])
    // Seconds since 1970, so a photo removed and added again never reuses an old version
    // (browsers cache each ?v= for a year). The +1 keeps two uploads in one second apart.
    const version = Math.max((old[0]?.version ?? 0) + 1, Math.floor(Date.now() / 1000))
    const saved = await storePhoto('products', `${sku}-${version}`, img.bytes, img.ext, img.mime)
    const { rows } = await query(
      `INSERT INTO product_photos (sku, mime, bytes, blob_path, version, updated_at, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (sku) DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, blob_path = EXCLUDED.blob_path,
         version = EXCLUDED.version, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
       RETURNING version`,
      [sku, img.mime, saved.bytes, saved.blobPath, version, now(), req.admin.id],
    ).catch(async (err) => {
      await dropPhoto({ blob_path: saved.blobPath })
      throw err.code === '23503' ? notFound('No product with that SKU') : err
    })
    if (old[0]?.blob_path && old[0].blob_path !== saved.blobPath) await dropPhoto(old[0])
    await loadProducts()
    res.json({ ...findProduct(sku), photoUrl: `/v1/products/${encodeURIComponent(sku)}/photo?v=${rows[0].version}` })
  }),
)

/** Removes the product's photo; the shop goes back to the drawn mango. */
router.delete(
  '/products/:sku/photo',
  requireManager,
  asyncHandler(async (req, res) => {
    const { rows } = await query('DELETE FROM product_photos WHERE sku = $1 RETURNING blob_path', [req.params.sku])
    if (!rows.length) throw notFound('This product has no photo')
    await dropPhoto(rows[0])
    await loadProducts()
    res.json(findProduct(req.params.sku))
  }),
)
