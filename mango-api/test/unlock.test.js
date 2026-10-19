// Neighborhood Unlock, phase 1: zones, campaigns, the shared count, the
// public progress card, the evaluation at the order-by time, weekly
// templates, roles and account deletion.
import { adminToken, client, closeAll, customerToken, makeBatch, resetDb, startServer, T0 } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { setNow } from '../src/clock.js'
import { loadConfig } from '../src/config.js'
import { query } from '../src/db.js'
import { newId } from '../src/ids.js'
import { runMaintenance } from '../src/maintenance.js'
import { countFor, evaluateDueCampaigns, runTemplates } from '../src/unlock.js'

let srv
let api
let admin
before(async () => {
  srv = await startServer()
  api = client(srv.base)
})
after(async () => {
  await srv.close()
  await closeAll()
})
beforeEach(async () => {
  await resetDb()
  admin = await adminToken(api)
  // Ripe fruit for each delivery date the tests use (16 to 18 Oct).
  await makeBatch({ age: 6, rating: 'RIPE', lines: { 'ALP-3': 200 } })
  for (const [age, rating] of [[5, 'SEMI_RIPE'], [4, 'SEMI_RIPE'], [3, 'RAW']]) await makeBatch({ age, rating, lines: { 'ALP-3': 200 } })
  const on = await api.put('/admin/v1/unlock/settings', { enabled: true }, { token: admin })
  assert.equal(on.status, 200, JSON.stringify(on.body))
})

// At T0 (10:00 IST on 15 Oct) the earliest delivery is 16 Oct, cutoff 18:00 IST on the 15th.
const DATE = '2026-10-16'
const CUTOFF = '2026-10-15T12:30:00.000Z'

/** Cart → quote → confirm → paid, for one customer. Returns the order id. */
async function order(token, { pincode = '560038', address = `${Math.random()} Main Road, Indiranagar`, qty = 1, deliveryDate, slotId, gift, pay = true } = {}) {
  assert.equal((await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty }, { token })).status, 204)
  const q = await api.post('/v1/checkout/quote', { pincode, deliveryDate, slotId }, { token })
  assert.equal(q.status, 200, JSON.stringify(q.body))
  const c = await api.post('/v1/checkout/confirm', { quoteId: q.body.quoteId, address, name: 'Asha', gift }, { token, headers: { 'Idempotency-Key': newId('k') } })
  assert.equal(c.status, 201, JSON.stringify(c.body))
  if (pay) assert.equal((await api.post('/v1/dev/pay', { orderId: c.body.orderId, outcome: 'captured' })).status, 200)
  return c.body.orderId
}

async function zone(label = 'Indiranagar', pincodes = ['560038', '560008']) {
  const r = await api.post('/admin/v1/zones', { label, pincodes }, { token: admin })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body
}

async function campaign(body, { open = true, token = admin } = {}) {
  const r = await api.post('/admin/v1/unlock/campaigns', { deliveryDate: DATE, threshold: 3, ...body }, { token })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  if (!open) return r.body
  const o = await api.post(`/admin/v1/unlock/campaigns/${r.body.id}/open`, {}, { token })
  assert.equal(o.status, 200, JSON.stringify(o.body))
  return o.body
}

const progress = async (pincode = '560038', date = DATE) => {
  const r = await api.get(`/v1/unlock/progress?pincode=${pincode}&date=${date}`)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body
}

const live = async (id) => (await api.get(`/admin/v1/unlock/campaigns/${id}`, { token: admin })).body

describe('counting', () => {
  test('counts unique paid customers in the zone; repeat orders, unpaid, other zones, replacements and small orders do not count', async () => {
    const z = await zone()
    const camp = await campaign({ zoneId: z.id })
    const a = await customerToken(api)
    const b = await customerToken(api)
    const firstA = await order(a.accessToken)
    await order(a.accessToken, { pincode: '560008' }) // same customer, other pincode in the zone: still one
    await order(b.accessToken, { pay: false }) // not paid yet
    await order((await customerToken(api)).accessToken, { pincode: '560034' }) // South, not in the zone
    assert.equal((await live(camp.id)).current, 1)

    await api.post('/v1/dev/pay', { orderId: (await query(`SELECT id FROM orders WHERE status = 'PAYMENT_PENDING'`)).rows[0].id, outcome: 'captured' })
    assert.equal((await live(camp.id)).current, 2)

    // A free replacement for a claim isn't a new customer order.
    const c = await customerToken(api)
    const replacement = await order(c.accessToken)
    await query('UPDATE orders SET replacement_for = $1 WHERE id = $2', [firstA, replacement])
    assert.equal((await live(camp.id)).current, 2)

    // A minimum counts what was paid.
    const { rows } = await query('SELECT total FROM orders WHERE id = $1', [firstA])
    const strict = await campaign({ zoneId: z.id, deliveryDate: '2026-10-17', minOrderValue: rows[0].total + 1 })
    const d = await customerToken(api)
    await order(d.accessToken, { deliveryDate: '2026-10-17' })
    await order((await customerToken(api)).accessToken, { deliveryDate: '2026-10-17', qty: 2 })
    assert.equal((await live(strict.id)).current, 1)
  })

  test('a gift counts for the buyer, in the area it is delivered to', async () => {
    const z = await zone()
    const camp = await campaign({ zoneId: z.id })
    const buyer = await customerToken(api)
    await order(buyer.accessToken, { pincode: '560038', gift: { recipientName: 'Meera Iyer', recipientPhone: '9845012345', message: 'For you' } })
    assert.equal((await live(camp.id)).current, 1)
    // The buyer also orders for themselves in the zone: still one person.
    await order(buyer.accessToken, { pincode: '560008' })
    assert.equal((await live(camp.id)).current, 1)
  })

  test('a customer cancelling before the cutoff lowers the count at once', async () => {
    const z = await zone()
    const camp = await campaign({ zoneId: z.id })
    const a = await customerToken(api)
    const id = await order(a.accessToken)
    await order((await customerToken(api)).accessToken)
    assert.equal((await progress()).campaigns[0].current, 2)
    assert.equal((await api.post(`/v1/orders/${id}/cancel`, {}, { token: a.accessToken })).status, 204)
    const p = await progress()
    assert.equal(p.campaigns[0].current, 1)
    assert.equal(p.campaigns[0].remaining, 2)
    assert.equal((await live(camp.id)).current, 1)
  })

  test('an unzoned pincode is its own area, and a slot campaign counts only its slot', async () => {
    const s1 = (await api.post('/admin/v1/slots', { label: 'Morning', startsAt: '08:00', endsAt: '11:00', maxBoxes: 50 }, { token: admin })).body
    const s2 = (await api.post('/admin/v1/slots', { label: 'Evening', startsAt: '17:00', endsAt: '20:00', maxBoxes: 50 }, { token: admin })).body
    const camp = await campaign({ pincode: '560034', slotId: s1.id })
    await order((await customerToken(api)).accessToken, { pincode: '560034', slotId: s1.id })
    await order((await customerToken(api)).accessToken, { pincode: '560034', slotId: s2.id })
    await order((await customerToken(api)).accessToken, { pincode: '560038', slotId: s1.id })
    const p = await progress('560034')
    assert.equal(p.campaigns.length, 1)
    assert.equal(p.campaigns[0].current, 1)
    assert.equal(p.campaigns[0].zoneLabel, 'Pincode 560034')
    assert.equal(p.campaigns[0].slotLabel, 'Morning')
    assert.equal((await live(camp.id)).current, 1)
    // The pincode can't join a zone while its own campaign is live.
    const z = await api.post('/admin/v1/zones', { label: 'Koramangala', pincodes: ['560034'] }, { token: admin })
    assert.equal(z.body.error.code, 'PINCODE_HAS_CAMPAIGN')
  })

  test('a zone change mid-campaign changes the live count at once', async () => {
    const z = await zone()
    const camp = await campaign({ zoneId: z.id })
    await order((await customerToken(api)).accessToken, { pincode: '560038' })
    await order((await customerToken(api)).accessToken, { pincode: '560008' })
    await order((await customerToken(api)).accessToken, { pincode: '560066' })
    assert.equal((await live(camp.id)).current, 2)
    const zones = await api.get('/admin/v1/zones', { token: admin })
    assert.equal(zones.body[0].liveCampaigns, 1, 'the panel can warn before an edit')
    await api.put(`/admin/v1/zones/${z.id}/pincodes`, { pincodes: ['560038', '560066'] }, { token: admin })
    assert.equal((await live(camp.id)).current, 2)
    assert.equal((await progress('560008')).campaigns.length, 0, '560008 left the zone')
    assert.equal((await progress('560066')).campaigns[0].current, 2)
  })
})

describe('zones', () => {
  test('a pincode belongs to one zone; a zone with a live campaign cannot be switched off', async () => {
    const z = await zone()
    const other = await api.post('/admin/v1/zones', { label: 'Domlur', pincodes: ['560008', '560066'] }, { token: admin })
    assert.equal(other.status, 409)
    assert.equal(other.body.error.code, 'PINCODE_TAKEN')
    assert.match(other.body.error.message, /560008 \(Indiranagar\)/)
    assert.equal((await api.post('/admin/v1/zones', { label: 'indiranagar' }, { token: admin })).body.error.code, 'ZONE_EXISTS')
    assert.equal((await api.put(`/admin/v1/zones/${z.id}/pincodes`, { pincodes: ['999999'] }, { token: admin })).body.error.code, 'PINCODE_UNKNOWN')

    const camp = await campaign({ zoneId: z.id })
    assert.equal((await api.patch(`/admin/v1/zones/${z.id}`, { active: false }, { token: admin })).body.error.code, 'ZONE_IN_USE')
    await api.post(`/admin/v1/unlock/campaigns/${camp.id}/cancel`, {}, { token: admin })
    const off = await api.patch(`/admin/v1/zones/${z.id}`, { active: false }, { token: admin })
    assert.equal(off.status, 200)
    assert.deepEqual(off.body.pincodes, [], 'switching a zone off releases its pincodes')
    assert.equal((await api.post('/admin/v1/zones', { label: 'Domlur', pincodes: ['560008'] }, { token: admin })).status, 201)
  })
})

describe('campaign rules', () => {
  test('one live campaign per area and date; a whole-day and a slot campaign cannot overlap; the order-by time defaults to the cutoff', async () => {
    const z = await zone()
    const camp = await campaign({ zoneId: z.id }, { open: false })
    assert.equal(new Date(camp.orderBy).toISOString(), CUTOFF)
    assert.equal(camp.status, 'DRAFT')
    const again = await api.post('/admin/v1/unlock/campaigns', { zoneId: z.id, deliveryDate: DATE, threshold: 5 }, { token: admin })
    assert.equal(again.body.error.code, 'CAMPAIGN_EXISTS')
    const slot = (await api.post('/admin/v1/slots', { label: 'Morning', startsAt: '08:00', endsAt: '11:00' }, { token: admin })).body
    const mixed = await api.post('/admin/v1/unlock/campaigns', { zoneId: z.id, deliveryDate: DATE, slotId: slot.id, threshold: 5 }, { token: admin })
    assert.equal(mixed.body.error.code, 'CAMPAIGN_EXISTS')
    // Cancelled frees the area and date.
    await api.post(`/admin/v1/unlock/campaigns/${camp.id}/cancel`, { note: 'wrong number' }, { token: admin })
    assert.equal((await api.post('/admin/v1/unlock/campaigns', { zoneId: z.id, deliveryDate: DATE, threshold: 5 }, { token: admin })).status, 201)

    // Later than the cutoff is refused; earlier is fine.
    const late = await api.post('/admin/v1/unlock/campaigns', { zoneId: z.id, deliveryDate: '2026-10-17', threshold: 5, orderBy: '2026-10-16T12:31:00Z' }, { token: admin })
    assert.equal(late.body.error.code, 'ORDER_BY_TOO_LATE')
    const early = await api.post('/admin/v1/unlock/campaigns', { zoneId: z.id, deliveryDate: '2026-10-17', threshold: 5, orderBy: '2026-10-16T06:30:00Z' }, { token: admin })
    assert.equal(early.status, 201)
    const both = await api.post('/admin/v1/unlock/campaigns', { zoneId: z.id, pincode: '560038', deliveryDate: '2026-10-18', threshold: 5 }, { token: admin })
    assert.equal(both.status, 400)
    const zoned = await api.post('/admin/v1/unlock/campaigns', { pincode: '560038', deliveryDate: '2026-10-18', threshold: 5 }, { token: admin })
    assert.equal(zoned.body.error.code, 'PINCODE_IN_ZONE')
  })

  test('status moves are guarded: no double open, a draft edits but an open campaign does not, nothing moves after the result', async () => {
    const z = await zone()
    const camp = await campaign({ zoneId: z.id }, { open: false })
    const edited = await api.patch(`/admin/v1/unlock/campaigns/${camp.id}`, { threshold: 4, minOrderValue: 50000 }, { token: admin })
    assert.equal(edited.body.threshold, 4)
    const [o1, o2] = await Promise.all([
      api.post(`/admin/v1/unlock/campaigns/${camp.id}/open`, {}, { token: admin }),
      api.post(`/admin/v1/unlock/campaigns/${camp.id}/open`, {}, { token: admin }),
    ])
    assert.deepEqual([o1.status, o2.status].sort(), [200, 409])
    assert.equal((await api.patch(`/admin/v1/unlock/campaigns/${camp.id}`, { threshold: 2 }, { token: admin })).body.error.code, 'CAMPAIGN_STATE')
    setNow('2026-10-15T12:45:00Z')
    await evaluateDueCampaigns()
    assert.equal((await live(camp.id)).status, 'MISSED')
    assert.equal((await api.post(`/admin/v1/unlock/campaigns/${camp.id}/cancel`, {}, { token: admin })).body.error.code, 'CAMPAIGN_STATE')
    assert.equal((await api.post(`/admin/v1/unlock/campaigns/${camp.id}/open`, {}, { token: admin })).body.error.code, 'CAMPAIGN_STATE')
    const events = (await live(camp.id)).events.map((e) => `${e.from ?? '-'}>${e.to}`)
    assert.deepEqual(events, ['->DRAFT', 'DRAFT>OPEN', 'OPEN>MISSED'])
  })

  test('cutoff and midnight IST: no campaign for a day whose cutoff passed, or for today', async () => {
    const z = await zone()
    setNow('2026-10-15T18:29:00Z') // 23:59 IST on the 15th
    const past = await api.post('/admin/v1/unlock/campaigns', { zoneId: z.id, deliveryDate: '2026-10-16', threshold: 3 }, { token: admin })
    assert.equal(past.body.error.code, 'ORDER_BY_PAST')
    const ok = await api.post('/admin/v1/unlock/campaigns', { zoneId: z.id, deliveryDate: '2026-10-17', threshold: 3 }, { token: admin })
    assert.equal(ok.status, 201)
    assert.equal(new Date(ok.body.orderBy).toISOString(), '2026-10-16T12:30:00.000Z')
    setNow('2026-10-15T18:31:00Z') // 00:01 IST on the 16th: the 16th is today
    const today = await api.post('/admin/v1/unlock/campaigns', { zoneId: z.id, deliveryDate: '2026-10-16', threshold: 3 }, { token: admin })
    assert.equal(today.body.error.code, 'INVALID_DATE')
  })

  test('a campaign never opens a closed day or adds capacity', async () => {
    const z = await zone()
    await api.put('/admin/v1/calendar/2026-10-17', { isOpen: false, note: 'Bandh' }, { token: admin })
    const closed = await api.post('/admin/v1/unlock/campaigns', { zoneId: z.id, deliveryDate: '2026-10-17', threshold: 3 }, { token: admin })
    assert.equal(closed.body.error.code, 'DATE_CLOSED')

    // A full day stays full with a campaign open.
    await api.put(`/admin/v1/calendar/${DATE}`, { isOpen: true, maxBoxes: 1 }, { token: admin })
    await campaign({ zoneId: z.id })
    await order((await customerToken(api)).accessToken)
    const t = (await customerToken(api)).accessToken
    await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 1 }, { token: t })
    const q = await api.post('/v1/checkout/quote', { pincode: '560038', deliveryDate: DATE }, { token: t })
    const full = q.status === 200
      ? await api.post('/v1/checkout/confirm', { quoteId: q.body.quoteId, address: '12, 4th Cross, Indiranagar, Bengaluru' }, { token: t, headers: { 'Idempotency-Key': newId('k') } })
      : q
    assert.equal(full.status, 409, JSON.stringify(full.body))

    // Staff close the day after the campaign opened: it ends, cancelled.
    await api.put(`/admin/v1/calendar/${DATE}`, { isOpen: false, note: 'Rain' }, { token: admin })
    setNow('2026-10-15T12:45:00Z')
    await evaluateDueCampaigns()
    const after = (await api.get('/admin/v1/unlock/campaigns', { token: admin })).body.campaigns[0]
    assert.equal(after.status, 'CANCELLED')
    assert.equal(after.note, 'Delivery day closed')
  })
})

describe('evaluation', () => {
  test('waits for the grace minutes, then sets UNLOCKED once with a snapshot of who counted', async () => {
    const z = await zone()
    const camp = await campaign({ zoneId: z.id, threshold: 2 })
    const a = await customerToken(api)
    const b = await customerToken(api)
    const orderA = await order(a.accessToken)
    await order(a.accessToken)
    await order(b.accessToken)

    setNow('2026-10-15T12:39:00Z') // cutoff + 9 minutes
    assert.equal((await evaluateDueCampaigns()).evaluated, 0)
    setNow('2026-10-15T12:40:00Z') // cutoff + 10
    assert.equal((await evaluateDueCampaigns()).evaluated, 1)
    const r = await live(camp.id)
    assert.equal(r.status, 'UNLOCKED')
    assert.equal(r.counted, 2)
    assert.equal(r.snapshotCount, 2)
    const snap = await query('SELECT customer_id, order_id FROM unlock_participants WHERE campaign_id = $1 ORDER BY customer_id', [camp.id])
    assert.deepEqual(snap.rows.find((p) => p.customer_id === a.customer.id), { customer_id: a.customer.id, order_id: orderA }, 'first qualifying order')
    const p = await progress()
    assert.equal(p.campaigns[0].status, 'UNLOCKED')
    assert.equal(p.campaigns[0].current, 2)
    // Running again changes nothing.
    assert.equal((await evaluateDueCampaigns()).evaluated, 0)
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM unlock_events WHERE campaign_id = $1', [camp.id])).rows[0].n, 3)
  })

  test('two overlapping runs produce one result', async () => {
    const z = await zone()
    const camps = []
    for (const d of ['2026-10-16', '2026-10-17', '2026-10-18']) camps.push(await campaign({ zoneId: z.id, deliveryDate: d, threshold: 2 }))
    for (let i = 0; i < 3; i++) {
      const t = (await customerToken(api)).accessToken
      for (const d of ['2026-10-16', '2026-10-17', '2026-10-18']) await order(t, { deliveryDate: d })
    }
    setNow('2026-10-17T13:00:00Z')
    const runs = await Promise.all([evaluateDueCampaigns(), evaluateDueCampaigns(), evaluateDueCampaigns()])
    assert.equal(runs.reduce((s, r) => s + r.evaluated, 0), 3, JSON.stringify(runs))
    for (const camp of camps) {
      const ev = await query(`SELECT COUNT(*)::int AS n FROM unlock_events WHERE campaign_id = $1 AND to_status = 'UNLOCKED'`, [camp.id])
      assert.equal(ev.rows[0].n, 1)
      assert.equal((await query('SELECT COUNT(*)::int AS n FROM unlock_participants WHERE campaign_id = $1', [camp.id])).rows[0].n, 3)
    }
    // And through maintenance, where the lease also keeps runs apart.
    const both = await Promise.all([runMaintenance(), runMaintenance()])
    assert.ok(both.some((r) => r.skipped), 'one run holds the lease')
  })

  test('misses below the threshold; a draft never opened is cancelled; a failing evaluation shows on Needs attention', async () => {
    const z = await zone()
    const missed = await campaign({ zoneId: z.id, threshold: 5 })
    const draft = await campaign({ zoneId: z.id, deliveryDate: '2026-10-17', threshold: 5, orderBy: '2026-10-15T12:30:00Z' }, { open: false })
    await order((await customerToken(api)).accessToken)
    const broken = await campaign({ zoneId: z.id, deliveryDate: '2026-10-18', threshold: 2 })
    await order((await customerToken(api)).accessToken, { deliveryDate: '2026-10-18' })
    setNow('2026-10-15T13:00:00Z')
    await runMaintenance({ forceAll: true })
    assert.equal((await live(missed.id)).status, 'MISSED')
    assert.equal((await live(missed.id)).counted, 1)
    assert.equal((await live(draft.id)).status, 'CANCELLED')

    // The snapshot can't be written: the step fails, is recorded for the alert, and leaves nothing half-done.
    await query(`UPDATE unlock_campaigns SET order_by = '2026-10-15T12:00:00Z' WHERE id = $1`, [broken.id])
    await query('ALTER TABLE unlock_participants RENAME TO unlock_participants_gone')
    setNow('2026-10-15T13:05:00Z')
    await runMaintenance()
    await query('ALTER TABLE unlock_participants_gone RENAME TO unlock_participants')
    const att = await api.get('/admin/v1/attention', { token: admin })
    assert.ok(att.body.loop.failingSteps.some((s) => s.step === 'unlock-evaluate'), JSON.stringify(att.body.loop))
    assert.equal((await live(broken.id)).status, 'OPEN', 'nothing half-done')
    await runMaintenance()
    assert.equal((await live(broken.id)).status, 'MISSED', 'the next run carries on')
    assert.equal((await live(broken.id)).counted, 1)
  })
})

describe('public progress', () => {
  test('shows counts only, never who; nothing when the feature is off', async () => {
    const z = await zone()
    await campaign({ zoneId: z.id })
    const a = await customerToken(api)
    await order(a.accessToken, { address: '7, Secret Lane, Indiranagar', gift: { recipientName: 'Meera Iyer', recipientPhone: '9845012345', message: 'hi' } })
    const r = await api.get(`/v1/unlock/progress?pincode=560038&date=${DATE}`)
    assert.match(r.headers.get('cache-control'), /public, max-age=15/)
    assert.deepEqual(Object.keys(r.body).sort(), ['campaigns', 'deliveryDate', 'enabled'])
    assert.deepEqual(Object.keys(r.body.campaigns[0]).sort(), ['closesAt', 'current', 'deliveryDate', 'remaining', 'slotLabel', 'status', 'threshold', 'zoneLabel'])
    assert.deepEqual(
      { ...r.body.campaigns[0], closesAt: new Date(r.body.campaigns[0].closesAt).toISOString() },
      { zoneLabel: 'Indiranagar', slotLabel: null, deliveryDate: DATE, current: 1, threshold: 3, remaining: 2, closesAt: CUTOFF, status: 'OPEN' },
    )
    const text = JSON.stringify(r.body)
    const { rows } = await query('SELECT o.id, o.number, c.phone FROM orders o JOIN customers c ON c.id = o.customer_id')
    for (const leak of [rows[0].id, rows[0].number, rows[0].phone, a.customer.id, 'Secret', 'Asha', 'Meera', '9845012345']) assert.ok(!text.includes(leak), `leaks ${leak}`)
    // Without a date it uses the first date customers can order for.
    assert.equal((await api.get('/v1/unlock/progress?pincode=560038')).body.deliveryDate, DATE)
    assert.equal((await api.get('/v1/unlock/progress?pincode=56003')).status, 400)
    // Drafts and other areas are not shown.
    assert.equal((await progress('560034')).campaigns.length, 0)

    await api.put('/admin/v1/unlock/settings', { enabled: false }, { token: admin })
    assert.deepEqual(await progress(), { enabled: false, deliveryDate: null, campaigns: [] })
  })

  test('the flag is off on a new database and survives the Planning page saving rules', async () => {
    await query('DELETE FROM app_config')
    await loadConfig()
    assert.equal((await api.get('/admin/v1/unlock/settings', { token: admin })).body.enabled, false)
    await api.put('/admin/v1/unlock/settings', { enabled: true }, { token: admin })
    const { rules } = (await api.get('/admin/v1/config', { token: admin })).body
    const { unlock, ...withoutUnlock } = rules
    assert.equal(unlock.enabled, true)
    assert.equal((await api.put('/admin/v1/config', { rules: { ...withoutUnlock, lowStockThreshold: 7 } }, { token: admin })).status, 200)
    assert.equal((await api.get('/admin/v1/unlock/settings', { token: admin })).body.enabled, true)
  })
})

describe('roles and audit', () => {
  test('managers and operators run campaigns; packers, QC and riders get nothing; only managers flip the switch; changes are audited', async () => {
    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    const packer = await adminToken(api, 'packer@mandimangoes.test', 'packer123')
    const qc = await adminToken(api, 'qc@mandimangoes.test', 'qc123')
    await api.post('/admin/v1/staff', { email: 'ravi@mandimangoes.test', role: 'RIDER', password: 'long-enough-1' }, { token: admin })
    const rider = await adminToken(api, 'ravi@mandimangoes.test', 'long-enough-1')

    const z = await api.post('/admin/v1/zones', { label: 'Indiranagar', pincodes: ['560038'] }, { token: ops })
    assert.equal(z.status, 201)
    const camp = await campaign({ zoneId: z.body.id }, { token: ops })
    assert.equal(camp.status, 'OPEN')
    assert.equal((await api.post('/admin/v1/unlock/templates', { zoneIds: [z.body.id], weekday: 6, threshold: 5 }, { token: ops })).status, 201)
    assert.equal((await api.put('/admin/v1/unlock/settings', { enabled: false }, { token: ops })).status, 403)

    const routes = [
      ['get', '/admin/v1/zones'], ['post', '/admin/v1/zones', { label: 'X', pincodes: [] }], ['patch', `/admin/v1/zones/${z.body.id}`, { label: 'Y' }],
      ['put', `/admin/v1/zones/${z.body.id}/pincodes`, { pincodes: [] }], ['get', '/admin/v1/unlock/campaigns'], ['get', `/admin/v1/unlock/campaigns/${camp.id}`],
      ['post', '/admin/v1/unlock/campaigns', { zoneId: z.body.id, deliveryDate: '2026-10-17', threshold: 3 }], ['post', `/admin/v1/unlock/campaigns/${camp.id}/cancel`, {}],
      ['get', '/admin/v1/unlock/templates'], ['get', '/admin/v1/unlock/settings'], ['put', '/admin/v1/unlock/settings', { enabled: false }],
    ]
    for (const token of [packer, qc, rider]) {
      for (const [m, p, b] of routes) {
        const r = m === 'get' ? await api.get(p, { token }) : await api[m](p, b, { token })
        assert.equal(r.status, 403, `${m} ${p}`)
      }
    }
    assert.equal((await live(camp.id)).status, 'OPEN')
    await new Promise((r) => setTimeout(r, 100)) // the audit is written after the response
    const { rows } = await query(`SELECT action, role, target FROM staff_audit WHERE action LIKE '%unlock%' OR action LIKE '%zones%' ORDER BY created_at`)
    const actions = rows.map((r) => `${r.role} ${r.action}`)
    for (const a of ['OPERATOR POST /zones', 'OPERATOR POST /unlock/campaigns', 'OPERATOR POST /unlock/campaigns/:id/open', 'OPERATOR POST /unlock/templates', 'MANAGER PUT /unlock/settings']) {
      assert.ok(actions.includes(a), `${a} in ${actions.join(', ')}`)
    }
    assert.ok(rows.some((r) => r.target === camp.id))
  })
})

describe('staff tools', () => {
  test('forecast and the suspicious-cluster flag', async () => {
    const z = await zone()
    // Last week's Friday-for-Saturday orders give the history.
    const camp = await campaign({ zoneId: z.id, deliveryDate: '2026-10-17', threshold: 5 })
    for (let i = 0; i < 3; i++) await order((await customerToken(api)).accessToken, { deliveryDate: '2026-10-17', address: 'Flat 1, Rose Apartments, Indiranagar' })
    setNow('2026-10-15T07:30:00Z') // three hours after opening
    const d = await live(camp.id)
    assert.equal(d.current, 3)
    assert.equal(d.forecast.recentSameWeekday.length, 3)
    assert.ok(d.forecast.projected >= 3)
    assert.equal(d.clusters.length, 1)
    assert.equal(d.clusters[0].kind, 'SAME_ADDRESS')
    assert.equal(d.clusters[0].customers, 3)
    assert.equal(d.clusters[0].orderNumbers.length, 3)
  })

  test('a weekly template makes each matching campaign once, and never brings back one staff cancelled', async () => {
    const z = await zone()
    const z2 = await zone('Domlur', ['560066'])
    // 17 Oct 2026 is a Saturday (6).
    const t = await api.post('/admin/v1/unlock/templates', { zoneIds: [z.id, z2.id], weekday: 6, threshold: 4, autoOpen: true }, { token: admin })
    assert.equal(t.status, 201, JSON.stringify(t.body))
    assert.equal((await runTemplates()).created, 2)
    assert.equal((await runTemplates()).created, 0)
    const list = (await api.get('/admin/v1/unlock/campaigns', { token: admin })).body.campaigns
    assert.deepEqual(list.map((c) => [c.deliveryDate, c.status, c.threshold]), [['2026-10-17', 'OPEN', 4], ['2026-10-17', 'OPEN', 4]])
    await api.post(`/admin/v1/unlock/campaigns/${list[0].id}/cancel`, {}, { token: admin })
    assert.equal((await runTemplates()).created, 0)
    // A week on, the next Saturday is made.
    setNow('2026-10-21T04:30:00Z')
    assert.equal((await runTemplates()).created, 2)
    // A closed Saturday is skipped.
    await api.patch(`/admin/v1/unlock/templates/${t.body.id}`, { threshold: 6 }, { token: admin })
    setNow('2026-10-28T04:30:00Z')
    await api.put('/admin/v1/calendar/2026-10-31', { isOpen: false }, { token: admin })
    assert.equal((await runTemplates()).created, 0)
  })
})

describe('account deletion', () => {
  test('deleting an account removes who counted, but keeps the count', async () => {
    const z = await zone()
    const camp = await campaign({ zoneId: z.id, threshold: 2 })
    const a = await customerToken(api)
    const id = await order(a.accessToken)
    await order((await customerToken(api)).accessToken)
    setNow('2026-10-15T13:00:00Z')
    await evaluateDueCampaigns()
    await query(`UPDATE orders SET status = 'DELIVERED' WHERE id = $1`, [id])
    assert.equal((await api.del('/v1/me', { token: a.accessToken })).status, 204)
    const { rows } = await query('SELECT customer_id, order_id FROM unlock_participants WHERE campaign_id = $1', [camp.id])
    assert.equal(rows.length, 2)
    assert.ok(!rows.some((r) => r.customer_id === a.customer.id || r.order_id === id))
    assert.equal(rows.filter((r) => r.customer_id === null && r.order_id === null).length, 1)
    assert.equal((await live(camp.id)).counted, 2)
    assert.equal((await progress()).campaigns[0].current, 2)
  })
})

test('countFor ignores orders placed after an early order-by time', async () => {
  setNow(T0)
  const z = await zone()
  const camp = await campaign({ zoneId: z.id, orderBy: '2026-10-15T08:00:00Z' })
  await order((await customerToken(api)).accessToken)
  setNow('2026-10-15T09:00:00Z')
  await order((await customerToken(api)).accessToken)
  const row = (await query('SELECT * FROM unlock_campaigns WHERE id = $1', [camp.id])).rows[0]
  assert.equal(await countFor({ query }, row), 1)
})
