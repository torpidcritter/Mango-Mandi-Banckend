// After a database restore: deletes again the accounts that were deleted after
// the restore point, so a restore never brings personal data back.
//
//   node --env-file=.env ops/reapply-deletions.js --old-url <pre-restore DB URL> --since <restore point>
//   node --env-file=.env ops/reapply-deletions.js --ids cus_a,cus_b
//
// --old-url is the database as it was before the restore. Neon keeps it as a
// backup branch when you restore main; copy that branch's connection string.
// Without it, take the ids from the API logs ("customer deleted their account").
import { parseArgs } from 'node:util'
import pg from 'pg'
import { now } from '../src/clock.js'
import { closePool, tx } from '../src/db.js'
import { dropPhoto } from '../src/photos.js'
import { eraseCustomer } from '../src/privacy.js'

const { values } = parseArgs({ options: { 'old-url': { type: 'string' }, since: { type: 'string' }, ids: { type: 'string' } } })
let targets = (values.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((id) => ({ id, deleted_at: now() }))
if (values['old-url']) {
  const since = new Date(values.since ?? '')
  if (Number.isNaN(since.getTime())) {
    console.error('--old-url needs --since <restore point, ISO time>')
    process.exit(2)
  }
  const old = new pg.Client({ connectionString: values['old-url'] })
  await old.connect()
  const { rows } = await old.query('SELECT id, deleted_at FROM customers WHERE deleted_at >= $1', [since])
  await old.end()
  targets = [...targets, ...rows]
}
if (!targets.length) {
  console.error('usage: ops/reapply-deletions.js --old-url <url> --since <iso>  |  --ids <id,id>')
  process.exit(2)
}
let done = 0
try {
  for (const t of targets) {
    try {
      const photos = await tx((c) => eraseCustomer(c, t.id, { force: true, deletedAt: t.deleted_at }))
      for (const p of photos) await dropPhoto(p)
      done++
    } catch (err) {
      if (err.status === 404) continue // never existed in the restored copy, or already deleted
      throw err
    }
  }
  console.log(`re-deleted ${done} of ${targets.length} accounts (the rest were already gone)`)
} finally {
  await closePool()
}
