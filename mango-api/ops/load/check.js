// After a load run: the books balance, nothing is oversold, every order is
// consistent with its stock and payment. Exits 1 on any problem.
//
//   DATABASE_URL=postgres://... node ops/load/check.js
//
// Read-only: safe on a staging database.
import pg from 'pg'
import { auditLedger } from '../../src/inventory.js'

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
const one = async (sql, params) => (await client.query(sql, params)).rows

const problems = []
const report = {}

const drift = await auditLedger(client)
report.ledgerDrift = drift.length
if (drift.length) problems.push(`ledger drift on ${drift.length} lines: ${JSON.stringify(drift.slice(0, 3))}`)

const oversold = await one(`SELECT id, sku, on_hand, held, committed, reserve_buffer FROM batch_lines
                             WHERE on_hand < 0 OR held < 0 OR committed < 0 OR on_hand - held - committed - reserve_buffer < 0`)
report.oversoldLines = oversold.length
if (oversold.length) problems.push(`oversold lines: ${JSON.stringify(oversold.slice(0, 3))}`)

// Every live order's items are backed by stock rows for the same quantity,
// unless it is flagged at risk (a late payment after its boxes were sold:
// honoured, and shown to staff in Needs attention, never silently short).
const unbacked = await one(`
  SELECT o.id, o.number, o.status, i.qty, COALESCE(s.qty, 0) AS stock
    FROM orders o
    JOIN (SELECT order_id, SUM(quantity)::int AS qty FROM order_items GROUP BY order_id) i ON i.order_id = o.id
    LEFT JOIN (SELECT order_id, SUM(quantity)::int AS qty FROM order_stock WHERE state <> 'released' GROUP BY order_id) s ON s.order_id = o.id
   WHERE o.status NOT IN ('CANCELLED', 'RTO') AND NOT o.at_risk AND i.qty <> COALESCE(s.qty, 0)`)
report.atRiskOrders = (await one("SELECT COUNT(*)::int AS n FROM orders WHERE at_risk AND status NOT IN ('CANCELLED', 'RTO', 'DELIVERED')"))[0].n
report.ordersWithoutMatchingStock = unbacked.length
if (unbacked.length) problems.push(`orders whose stock does not match their items: ${JSON.stringify(unbacked.slice(0, 3))}`)

// Stock state follows the order's state.
const wrongState = await one(`
  SELECT o.id, o.number, o.status, s.state, COUNT(*)::int AS n FROM orders o JOIN order_stock s ON s.order_id = o.id AND s.state <> 'released'
   WHERE (o.status = 'PAYMENT_PENDING' AND s.state <> 'held')
      OR (o.status IN ('CONFIRMED', 'PROCESSING') AND s.state NOT IN ('committed', 'packed'))
      OR (o.status IN ('PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED') AND s.state <> 'packed')
      OR (o.status = 'CANCELLED' AND s.state IN ('held', 'committed'))
   GROUP BY 1, 2, 3, 4`)
report.ordersWithWrongStockState = wrongState.length
if (wrongState.length) problems.push(`stock in the wrong state for its order: ${JSON.stringify(wrongState.slice(0, 3))}`)

// Paid orders are paid once, for the total; unpaid ones are not confirmed.
const badPaid = await one(`
  SELECT id, number, status, payment_status, payment_id, payment_amount, total FROM orders
   WHERE (status NOT IN ('PAYMENT_PENDING', 'CANCELLED') AND (payment_status NOT IN ('SUCCEEDED', 'REFUNDED') OR payment_id IS NULL OR payment_amount IS DISTINCT FROM total))
      OR (status = 'PAYMENT_PENDING' AND payment_status = 'SUCCEEDED')`)
report.ordersWithBadPayment = badPaid.length
if (badPaid.length) problems.push(`orders with inconsistent payment: ${JSON.stringify(badPaid.slice(0, 3))}`)

const dupPay = await one(`SELECT payment_id, COUNT(*)::int AS n FROM orders WHERE payment_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1`)
report.paymentsOnTwoOrders = dupPay.length
if (dupPay.length) problems.push(`one payment on several orders: ${JSON.stringify(dupPay.slice(0, 3))}`)

const doubleConfirm = await one(`SELECT order_id, COUNT(*)::int AS n FROM order_events WHERE status = 'CONFIRMED' AND from_status IS DISTINCT FROM 'CONFIRMED' GROUP BY 1 HAVING COUNT(*) > 1`)
report.ordersConfirmedTwice = doubleConfirm.length
if (doubleConfirm.length) problems.push(`orders confirmed twice: ${JSON.stringify(doubleConfirm.slice(0, 3))}`)

// Slots never take more boxes than their limit.
const overSlot = await one(`
  SELECT o.delivery_date, s.label, s.max_boxes, SUM(i.quantity)::int AS boxes
    FROM orders o JOIN delivery_slots s ON s.id = o.slot_id JOIN order_items i ON i.order_id = o.id
   WHERE o.status NOT IN ('CANCELLED', 'RTO') AND s.max_boxes IS NOT NULL
   GROUP BY 1, 2, 3 HAVING SUM(i.quantity) > s.max_boxes`)
report.slotsOverLimit = overSlot.length
if (overSlot.length) problems.push(`slots over their limit: ${JSON.stringify(overSlot)}`)

const counts = await one(`SELECT status, payment_status, COUNT(*)::int AS n FROM orders GROUP BY 1, 2 ORDER BY 1, 2`)
report.orders = Object.fromEntries(counts.map((r) => [`${r.status}/${r.payment_status}`, r.n]))
report.duplicatePaymentsLogged = (await one('SELECT COUNT(*)::int AS n FROM duplicate_payments'))[0].n
report.webhookFailures = (await one('SELECT COUNT(*)::int AS n FROM webhook_failures'))[0].n
report.processedWebhooks = (await one('SELECT COUNT(*)::int AS n FROM processed_webhooks'))[0].n
report.problems = problems

console.log(JSON.stringify(report, null, 2))
await client.end()
process.exit(problems.length ? 1 : 0)
