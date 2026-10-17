// Running on Vercel: the cron-driven maintenance endpoint, its lock, and /ready.
import { client, closeAll, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { setNow } from '../src/clock.js'
import { query } from '../src/db.js'
import { runMaintenance, triggerRebalanceAll } from '../src/maintenance.js'

let srv
let api
const cron = { headers: { Authorization: 'Bearer cron_test_secret_0123456789' } }

before(async () => {
  srv = await startServer()
  api = client(srv.base)
})
after(async () => {
  await srv.close()
  await closeAll()
})
beforeEach(resetDb)

const lastOk = async (step) => (await query('SELECT last_ok_at FROM maintenance_runs WHERE step = $1', [step])).rows[0]?.last_ok_at ?? null

describe('maintenance on a schedule', () => {
  test('the endpoint needs the cron secret', async () => {
    assert.equal((await api.get('/internal/maintenance')).status, 401)
    assert.equal((await api.get('/internal/maintenance', { headers: { Authorization: 'Bearer wrong' } })).status, 401)
    const r = await api.get('/internal/maintenance', cron)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.notEqual(r.body.skipped, true)
    assert.ok(await lastOk('tick'))
  })

  test('two runs at once: one works, the other skips', async () => {
    const [a, b] = await Promise.all([runMaintenance(), runMaintenance()])
    assert.equal([a, b].filter((r) => r.skipped).length, 1)
    // The lock is released with the transaction, so the next run works.
    assert.notEqual((await runMaintenance()).skipped, true)
  })

  test('the daily and hourly passes are remembered in the database, not in memory', async () => {
    await runMaintenance()
    const full = await lastOk('rebalance-all')
    assert.ok(full, 'the first run on a fresh database re-checks every order')
    await runMaintenance()
    assert.equal((await lastOk('rebalance-all')).getTime(), full.getTime(), 'not again within the day')

    setNow(new Date(full.getTime() + 61 * 60_000))
    await runMaintenance()
    assert.ok(await lastOk('rebalance-at-risk'), 'at-risk orders are retried after an hour')

    setNow(new Date(full.getTime() + 62 * 60_000))
    await triggerRebalanceAll()
    setNow(new Date(full.getTime() + 63 * 60_000))
    await runMaintenance()
    assert.ok((await lastOk('rebalance-all')) > full, 'a rules change asks the next run for a full pass')
  })

  test('/ready fails once maintenance has not run for 5 minutes', async () => {
    let r = await api.get('/ready')
    assert.equal(r.status, 200)
    assert.equal(r.body.maintenanceAgeSeconds, null)
    await runMaintenance()
    r = await api.get('/ready')
    assert.equal(r.status, 200)
    assert.ok(r.body.maintenanceAgeSeconds <= 1)
    const ran = await lastOk('tick')
    setNow(new Date(ran.getTime() + 6 * 60_000))
    r = await api.get('/ready')
    assert.equal(r.status, 503)
    assert.equal(r.body.ready, false)
  })
})
