// After a database restore: applies the Razorpay payments taken since the
// restore point, and finds payments whose order the restore lost.
//
//   node --env-file=.env ops/replay-payments.js --from 2026-05-02T09:30:00Z [--to <iso>] [--refund-missing]
//
// --from is the restore point (a few minutes earlier is fine; replaying is safe
// to repeat). Without --refund-missing, lost-order payments are only listed
// (and shown in the panel's Needs attention) so staff can rebuild the order or
// call the customer; with it they are refunded in full.
import { parseArgs } from 'node:util'
import { closePool } from '../src/db.js'
import { replayCapturedPayments } from '../src/payments.js'

const { values } = parseArgs({ options: { from: { type: 'string' }, to: { type: 'string' }, 'refund-missing': { type: 'boolean', default: false } } })
const from = new Date(values.from ?? '')
const to = values.to ? new Date(values.to) : new Date()
if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
  console.error('usage: ops/replay-payments.js --from <restore point, ISO time> [--to <ISO time>] [--refund-missing]')
  process.exit(2)
}
try {
  const r = await replayCapturedPayments({ from, to, refundMissing: values['refund-missing'] })
  console.log(`checked ${r.checked} orders and bookings; applied ${r.applied} payments`)
  if (r.lost.length) {
    console.log(`${r.lost.length} captured payments match no order:`)
    for (const l of r.lost) console.log(`  ${l.paymentId}  ₹${(l.amount ?? 0) / 100}  ${l.contact ?? ''}`)
    console.log(values['refund-missing'] ? `refunded ${r.refunded} (the rest retry in maintenance)` : 're-run with --refund-missing to refund them')
  }
} finally {
  await closePool()
}
