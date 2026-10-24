// Deletes a customer's account and personal data for a request that came by
// email or WhatsApp instead of the app's "Delete my account" (DPDP Act,
// SEC-05). Same steps as DELETE /v1/me (src/privacy.js eraseCustomer).
//
//   node --env-file=.env ops/erase-customer.js --phone 9876543210          (shows who it would delete)
//   node --env-file=.env ops/erase-customer.js --phone 9876543210 --yes    (deletes)
//   node --env-file=.env ops/erase-customer.js --id cus_abc --yes
//   node --env-file=.env ops/erase-customer.js --email asha@example.com --yes
//
// Check first that the request really comes from the number's owner (reply on
// WhatsApp to that number, say). It refuses while an order or booking is still
// open or money is still owed back, like the app; finish those first.
// Keep the customer id it prints with the request: after a database restore,
// ops/reapply-deletions.js --ids <id> deletes it again.
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { closePool, query, tx } from '../src/db.js'
import { forgetCustomer } from '../src/auth.js'
import { dropPhoto } from '../src/photos.js'
import { eraseCustomer } from '../src/privacy.js'

/** +91XXXXXXXXXX from what the customer wrote (spaces, dashes, 0 or 91 in front). */
export const normalisePhone = (s) => {
  const digits = String(s).replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, '')
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { phone: { type: 'string' }, id: { type: 'string' }, email: { type: 'string' }, yes: { type: 'boolean' } } })
  let where
  if (values.id) where = ['id = $1', values.id]
  else if (values.phone) {
    const phone = normalisePhone(values.phone)
    if (!phone) throw new Error(`${values.phone} is not a 10-digit Indian mobile number`)
    where = ['phone = $1', phone]
  } else if (values.email) where = ['lower(email) = lower($1)', values.email.trim()]
  else {
    console.error('usage: ops/erase-customer.js --phone <number> | --id <cus_...> | --email <address>  [--yes]')
    process.exitCode = 2
    return
  }
  const { rows } = await query(
    `SELECT c.id, c.name, c.created_at, (SELECT COUNT(*)::int FROM orders o WHERE o.customer_id = c.id) AS orders
       FROM customers c WHERE ${where[0]} AND c.deleted_at IS NULL`,
    [where[1]],
  )
  if (!rows.length) {
    console.log('No live account matches. Nothing to delete.')
    return
  }
  if (rows.length > 1) throw new Error(`${rows.length} accounts match; run it again with --id`)
  const who = rows[0]
  console.log(`Account ${who.id} (${who.name ?? 'no name'}), since ${who.created_at.toISOString().slice(0, 10)}, ${who.orders} orders.`)
  if (!values.yes) {
    console.log('Run again with --yes to delete it.')
    return
  }
  const photos = await tx((c) => eraseCustomer(c, who.id))
  forgetCustomer(who.id)
  for (const p of photos) await dropPhoto(p)
  console.log(`Deleted ${who.id}. Keep this id with the request (ops/reapply-deletions.js --ids ${who.id} after a restore).`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (err) {
    console.error(err.status === 409 ? `Not deleted: ${err.message}` : err.message)
    process.exitCode = 1
  } finally {
    await closePool()
  }
}
