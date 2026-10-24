// Products load into memory so lookups cost no round trip. Each instance
// reloads them every minute (app.js), and right away after its own edit.
//
// A product can be hidden (active = false): it stays known so past orders and
// batches keep its name, but nothing new can be sold or stocked with it.
import { query } from './db.js'

let bySku = new Map()

const view = (r) => ({
  sku: r.sku, name: r.name, variety: r.variety, boxSize: r.box_size, price: r.price, gstRate: Number(r.gst_rate), hsnCode: r.hsn_code,
  description: r.description, active: r.active, sortOrder: r.sort_order,
  // What is in the box (optional): about how many mangoes, and about how heavy each one is.
  fruitsPerBox: r.fruits_per_box ?? null, fruitWeightG: r.fruit_weight_g ?? null,
  // Served by the API (GET /v1/products/:sku/photo); the version makes a new photo a new URL.
  photoUrl: r.photo_version ? `/v1/products/${encodeURIComponent(r.sku)}/photo?v=${r.photo_version}` : null,
})

export async function loadProducts() {
  const { rows } = await query(
    `SELECT p.sku, p.name, p.variety, p.box_size, p.price, p.gst_rate, p.hsn_code, p.description, p.active, p.sort_order, p.fruits_per_box, p.fruit_weight_g, ph.version AS photo_version
       FROM products p LEFT JOIN product_photos ph ON ph.sku = p.sku ORDER BY p.sort_order, p.name, p.sku`,
  )
  bySku = new Map(rows.map((r) => [r.sku, view(r)]))
}

/** Any product, hidden or not: for names on past orders, batches and reports. */
export const findProduct = (sku) => bySku.get(sku) ?? null
/** Every product, in display order, hidden ones included. */
export const allProducts = () => [...bySku.values()]
/** Products on sale: shown in the shop and WhatsApp, and allowed on new batches and preorders. */
export const shopProducts = () => allProducts().filter((p) => p.active)
/** The product when it is on sale, else null. */
export const sellable = (sku) => {
  const p = bySku.get(sku)
  return p?.active ? p : null
}
export const productName = (sku) => bySku.get(sku)?.name ?? sku

/** Test hook: an instance that has not loaded anything yet (a cold start). */
export const forgetProductsForTests = () => {
  bySku = new Map()
}
