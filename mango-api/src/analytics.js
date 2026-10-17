// Season numbers for the owners: sales, wastage, at-risk and claims, week by
// week (weeks start on Monday, IST) and per SKU. Read-only SQL over the
// orders, ledger and claims tables; nothing here is cached or stored.
import { addDays } from './clock.js'
import { query } from './db.js'
import { productName } from './products.js'

const IST = (col) => `(${col} AT TIME ZONE 'Asia/Kolkata')::date`
const WEEK = (d) => `date_trunc('week', ${d})::date`
// Orders that count as sold: paid and not cancelled. Replacements are free and counted apart.
const SOLD = `o.status NOT IN ('PAYMENT_PENDING', 'CANCELLED')`

const ratio = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null)

/** Monday of the week a YYYY-MM-DD date falls in. */
export function mondayOf(d) {
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay()
  return addDays(d, -((dow + 6) % 7))
}

export async function analytics({ from, to }) {
  const p = [from, to]
  const [sold, delivered, failed, cancels, refunds, stock, risk, claims, skuSold, skuStock] = await Promise.all([
    query(
      `SELECT ${WEEK('o.delivery_date')} AS week,
              COUNT(*) FILTER (WHERE o.replacement_for IS NULL)::int AS orders,
              COUNT(*) FILTER (WHERE o.replacement_for IS NOT NULL)::int AS replacements,
              COALESCE(SUM(o.total) FILTER (WHERE o.replacement_for IS NULL), 0)::bigint AS revenue,
              COALESCE(SUM((SELECT SUM(quantity) FROM order_items i WHERE i.order_id = o.id)), 0)::int AS boxes
         FROM orders o WHERE ${SOLD} AND o.delivery_date BETWEEN $1 AND $2 GROUP BY 1`,
      p,
    ),
    query(`SELECT ${WEEK('o.delivery_date')} AS week, COUNT(*)::int AS n FROM orders o WHERE o.status = 'DELIVERED' AND o.delivery_date BETWEEN $1 AND $2 GROUP BY 1`, p),
    query(
      `SELECT ${WEEK(IST('e.created_at'))} AS week, COUNT(*)::int AS n FROM order_events e
        WHERE e.status = 'DELIVERY_FAILED' AND e.from_status IS DISTINCT FROM 'DELIVERY_FAILED' AND ${IST('e.created_at')} BETWEEN $1 AND $2 GROUP BY 1`,
      p,
    ),
    query(`SELECT ${WEEK(IST('customer_cancelled_at'))} AS week, COUNT(*)::int AS n FROM orders WHERE ${IST('customer_cancelled_at')} BETWEEN $1 AND $2 GROUP BY 1`, p),
    query(
      `SELECT week, SUM(amount)::bigint AS amount FROM (
         SELECT ${WEEK(IST('refunded_at'))} AS week, COALESCE(payment_amount, total) AS amount FROM orders WHERE ${IST('refunded_at')} BETWEEN $1 AND $2
         UNION ALL
         SELECT ${WEEK(IST('refunded_at'))}, COALESCE(paid_amount, total) FROM preorders WHERE ${IST('refunded_at')} BETWEEN $1 AND $2) r GROUP BY 1`,
      p,
    ),
    query(
      `SELECT ${WEEK(IST('created_at'))} AS week,
              COALESCE(SUM(delta) FILTER (WHERE event_type = 'INTAKE'), 0)::int AS received,
              COALESCE(-SUM(delta) FILTER (WHERE event_type IN ('CONDEMN', 'RETIRE')), 0)::int AS wasted,
              COALESCE(-SUM(delta) FILTER (WHERE event_type = 'CONDEMN'), 0)::int AS condemned
         FROM batch_ledger WHERE ${IST('created_at')} BETWEEN $1 AND $2 GROUP BY 1`,
      p,
    ),
    query(
      `SELECT ${WEEK(IST('e.created_at'))} AS week, COUNT(DISTINCT e.order_id)::int AS n FROM order_events e
        WHERE e.reason LIKE 'At risk:%' AND ${IST('e.created_at')} BETWEEN $1 AND $2 GROUP BY 1`,
      p,
    ),
    query(
      `SELECT ${WEEK(IST('created_at'))} AS week, COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE resolution = 'REPLACEMENT_APPROVED')::int AS replaced
         FROM claims WHERE ${IST('created_at')} BETWEEN $1 AND $2 GROUP BY 1`,
      p,
    ),
    query(
      `SELECT i.sku, SUM(i.quantity)::int AS boxes, COALESCE(SUM(i.line_price) FILTER (WHERE o.replacement_for IS NULL), 0)::bigint AS revenue
         FROM order_items i JOIN orders o ON o.id = i.order_id WHERE ${SOLD} AND o.delivery_date BETWEEN $1 AND $2 GROUP BY 1`,
      p,
    ),
    query(
      `SELECT sku, COALESCE(SUM(delta) FILTER (WHERE event_type = 'INTAKE'), 0)::int AS received,
              COALESCE(-SUM(delta) FILTER (WHERE event_type IN ('CONDEMN', 'RETIRE')), 0)::int AS wasted
         FROM batch_ledger WHERE sku IS NOT NULL AND ${IST('created_at')} BETWEEN $1 AND $2 GROUP BY 1`,
      p,
    ),
  ])

  const byWeek = (r) => new Map(r.rows.map((x) => [x.week, x]))
  const [s, d, f, c, rf, st, rk, cl] = [sold, delivered, failed, cancels, refunds, stock, risk, claims].map(byWeek)
  const weeks = []
  for (let w = mondayOf(from); w <= to; w = addDays(w, 7)) {
    const row = {
      weekStart: w,
      orders: s.get(w)?.orders ?? 0,
      boxes: s.get(w)?.boxes ?? 0,
      revenue: s.get(w)?.revenue ?? 0,
      replacements: s.get(w)?.replacements ?? 0,
      delivered: d.get(w)?.n ?? 0,
      deliveryFailed: f.get(w)?.n ?? 0,
      customerCancels: c.get(w)?.n ?? 0,
      refunded: rf.get(w)?.amount ?? 0,
      received: st.get(w)?.received ?? 0,
      wasted: st.get(w)?.wasted ?? 0,
      condemned: st.get(w)?.condemned ?? 0,
      atRisk: rk.get(w)?.n ?? 0,
      claims: cl.get(w)?.n ?? 0,
      claimsReplaced: cl.get(w)?.replaced ?? 0,
    }
    weeks.push({ ...row, wastageRate: ratio(row.wasted, row.received), atRiskRate: ratio(row.atRisk, row.orders) })
  }

  const skus = new Map()
  const sku = (k) => skus.get(k) ?? skus.set(k, { sku: k, productName: productName(k), boxes: 0, revenue: 0, received: 0, wasted: 0 }).get(k)
  for (const r of skuSold.rows) Object.assign(sku(r.sku), { boxes: r.boxes, revenue: r.revenue })
  for (const r of skuStock.rows) Object.assign(sku(r.sku), { received: r.received, wasted: r.wasted })
  const bySku = [...skus.values()].map((x) => ({ ...x, wastageRate: ratio(x.wasted, x.received) })).sort((a, b) => b.revenue - a.revenue || a.sku.localeCompare(b.sku))

  const sum = (k) => weeks.reduce((n, w) => n + w[k], 0)
  const totals = Object.fromEntries(Object.keys(weeks[0] ?? {}).filter((k) => typeof weeks[0][k] === 'number' && !k.endsWith('Rate')).map((k) => [k, sum(k)]))
  totals.wastageRate = ratio(totals.wasted ?? 0, totals.received ?? 0)
  totals.atRiskRate = ratio(totals.atRisk ?? 0, totals.orders ?? 0)
  return { from, to, weeks, bySku, totals }
}
