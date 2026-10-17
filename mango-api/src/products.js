// Products load once into memory; lookups cost no round trip. A restart
// picks up catalogue changes.
import { query } from './db.js'

let bySku = new Map()

export async function loadProducts() {
  const { rows } = await query('SELECT sku, name, variety, box_size, price, gst_rate, hsn_code FROM products ORDER BY sku')
  bySku = new Map(
    rows.map((r) => [
      r.sku,
      { sku: r.sku, name: r.name, variety: r.variety, boxSize: r.box_size, price: r.price, gstRate: Number(r.gst_rate), hsnCode: r.hsn_code },
    ]),
  )
}

export const findProduct = (sku) => bySku.get(sku) ?? null
export const allProducts = () => [...bySku.values()]
export const productName = (sku) => bySku.get(sku)?.name ?? sku
