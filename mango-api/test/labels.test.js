// Box labels: signed QR tokens, printing, scan-to-pack, scan-to-dispatch,
// the rider's doorstep scan and the public box page.
import { closeAll, adminToken, checkout, client, customerToken, makeBatch, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { addDays } from '../src/clock.js'
import { query } from '../src/db.js'
import { labelContent, parseScan, tokenFor, verifyToken } from '../src/labels.js'

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
})

async function setLabels(patch) {
  const cur = await api.get('/admin/v1/config', { token: admin })
  const r = await api.put('/admin/v1/config', { rules: { ...cur.body.rules, labels: { ...cur.body.rules.labels, ...patch } } }, { token: admin })
  assert.equal(r.status, 200, JSON.stringify(r.body))
}

async function staff(role, email) {
  const add = await api.post('/admin/v1/staff', { email, role, password: 'long-enough-1' }, { token: admin })
  assert.equal(add.status, 201, JSON.stringify(add.body))
  return adminToken(api, email, 'long-enough-1')
}

/** A paid order (CONFIRMED, stock committed). */
async function paidOrder(items, opts) {
  const cust = await customerToken(api)
  const o = await checkout(api, cust.accessToken, items, opts)
  assert.equal(o.status, 201, JSON.stringify(o.body))
  await api.post('/v1/dev/pay', { orderId: o.body.orderId, outcome: 'captured' })
  return { id: o.body.orderId, date: o.body.deliveryDate, cust }
}

const print = (body, token = admin) => api.post('/admin/v1/labels/print', body, { token })
const pack = (orderId, scan, token = admin) => api.post('/admin/v1/scan/pack', { orderId, scan }, { token })
const orderOf = async (id) => (await query('SELECT * FROM orders WHERE id = $1', [id])).rows[0]
const tokenOf = (label) => label.qrUrl.split('/b/')[1]
/** The labels with their QR links, which only the printed page carries. */
async function printed(body) {
  const r = await print(body)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const keys = (await query('SELECT id, token_key FROM box_labels WHERE id = ANY($1)', [r.body.labels.map((l) => l.id)])).rows
  const byId = new Map(keys.map((k) => [k.id, k.token_key]))
  return { ...r.body, labels: r.body.labels.map((l) => ({ ...l, token: tokenFor(byId.get(l.id)) })) }
}

describe('label tokens', () => {
  test('a tampered, truncated or made-up token is refused', () => {
    const t = tokenFor('A'.repeat(22))
    assert.equal(verifyToken(t), 'A'.repeat(22))
    const flip = (s, i) => s.slice(0, i) + (s[i] === 'B' ? 'C' : 'B') + s.slice(i + 1)
    assert.equal(verifyToken(flip(t, 3)), null, 'changed key')
    assert.equal(verifyToken(flip(t, 30)), null, 'changed tag')
    assert.equal(verifyToken(flip(t, t.length - 1)), null, 'changed last character')
    assert.equal(verifyToken(t.slice(0, -1)), null, 'truncated')
    assert.equal(verifyToken(`${t}A`), null, 'too long')
    assert.equal(verifyToken('x'.repeat(36)), null, 'random')
    assert.equal(verifyToken(null), null)
  })

  test('scans are read from shop links, bare tokens and typed codes', () => {
    const t = tokenFor('B'.repeat(22))
    assert.deepEqual(parseScan(`https://mandimangoes.in/b/${t}?utm=x`), { token: t })
    assert.deepEqual(parseScan(` ${t} `), { token: t })
    assert.deepEqual(parseScan('ord-1042-3'), { code: { number: 'ORD-1042', boxNo: 3 } })
  })

  test('label content follows the ripeness sold and the delivery date', () => {
    const base = { id: 'lbl_1', box_no: 1, box_count: 2, sku: 'ALP-3', batch_id: 'bat_1', token_key: 'K'.repeat(22), printed_at: new Date('2026-10-15T04:30:00Z') }
    const raw = labelContent({ ...base, stage: 'RAW', delivery_date: '2026-10-16' }, { number: 'ORD-1', pluckedOn: '2026-10-12' })
    assert.deepEqual([raw.ripeness, raw.readyFrom, raw.eatBy], ['Raw', '2026-10-21', '2026-10-24'])
    const ripe = labelContent({ ...base, stage: 'RIPE', delivery_date: '2026-10-18' }, { number: 'ORD-1', pluckedOn: '2026-10-12' })
    assert.deepEqual([ripe.ripeness, ripe.readyFrom, ripe.eatBy], ['Ripe', '2026-10-18', '2026-10-21'])
    const semi = labelContent({ ...base, stage: 'SEMI_RIPE', delivery_date: '2026-10-17' }, { number: 'ORD-1', pluckedOn: '2026-10-12' })
    // The QR holds only the shop link and a token that verifies back to the label's key.
    assert.match(semi.qrUrl, /^http:\/\/localhost:5174\/b\/[A-Za-z0-9_-]{36}$/)
    assert.equal(verifyToken(semi.qrUrl.split('/b/')[1]), 'K'.repeat(22))
    assert.deepEqual([semi.readyFrom, semi.eatBy, semi.code, semi.packedOn], ['2026-10-19', '2026-10-22', 'ORD-1-1', '2026-10-15'])
  })
})

describe('box labels', () => {
  test('everything is off until a manager turns labels on', async () => {
    const r = await print({ date: '2026-10-16' })
    assert.equal(r.status, 404)
    assert.equal(r.body.error.code, 'FEATURE_OFF')
    assert.deepEqual((await api.get(`/v1/box/${tokenFor('C'.repeat(22))}`)).body, { found: false })
  })

  test('print, pack box by box, refuse the wrong box, and repeat scans change nothing', async () => {
    await setLabels({ enabled: true, footer: 'Thank you for buying from farmers' })
    await makeBatch({ age: 6, rating: 'RIPE', lines: { 'ALP-3': 1 } })
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    await makeBatch({ age: 4, rating: 'SEMI_RIPE', lines: { 'BAD-3': 10 } })
    const a = await paidOrder([{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])
    const b = await paidOrder([{ sku: 'BAD-3', stage: 'SEMI_RIPE', qty: 1 }])

    const first = await printed({ date: a.date })
    assert.equal(first.labels.length, 3)
    const aNum = (await orderOf(a.id)).number
    const la = first.labels.filter((l) => l.orderNumber === aNum)
    const [lb] = first.labels.filter((l) => l.orderNumber !== la[0].orderNumber)
    assert.deepEqual(la.map((l) => `${l.boxNo}/${l.boxCount}`), ['1/2', '2/2'])
    assert.equal(lb.ripeness, 'Semi-ripe')
    assert.equal(lb.eatBy, addDays(b.date, 5))
    assert.notEqual(la[0].batchId, la[1].batchId, 'each box carries its own batch')
    assert.equal(la[0].footer, 'Thank you for buying from farmers')

    // No personal data on the page or in the QR.
    const ord = await orderOf(a.id)
    for (const secret of [ord.phone, ord.customer_name, ord.delivery_address, a.id].filter(Boolean)) {
      assert.ok(!first.html.includes(secret), `label page shows ${secret}`)
    }
    assert.match(first.html, /@page \{ size: 50mm 75mm/)
    assert.match(first.html, /<svg/)
    assert.ok(!first.html.includes(la[0].token), 'the token is only inside the QR drawing')

    // Printing again gives the same labels.
    const again = await printed({ date: a.date })
    assert.deepEqual(again.labels.map((l) => l.token).sort(), first.labels.map((l) => l.token).sort())

    const wrong = await pack(a.id, lb.token)
    assert.equal(wrong.status, 409)
    assert.equal(wrong.body.error.code, 'WRONG_BOX')
    assert.match(wrong.body.error.message, new RegExp(lb.orderNumber))
    assert.equal((await orderOf(a.id)).status, 'CONFIRMED')

    const one = await pack(a.id, `https://shop.example/b/${la[0].token}`)
    assert.equal(one.status, 200, JSON.stringify(one.body))
    assert.deepEqual([one.body.outcome, one.body.packedBoxes, one.body.totalBoxes, one.body.orderPacked], ['OK', 1, 2, false])
    assert.equal((await orderOf(a.id)).status, 'PROCESSING')
    const repeat = await pack(a.id, la[0].token)
    assert.deepEqual([repeat.body.outcome, repeat.body.packedBoxes], ['REPEAT', 1])

    // The typed code works for staff (a scanner with no camera).
    const two = await pack(a.id, la[1].code)
    assert.equal(two.status, 200, JSON.stringify(two.body))
    assert.equal(two.body.orderPacked, true)
    assert.equal((await orderOf(a.id)).status, 'PACKED')
    const { rows: stock } = await query("SELECT state FROM order_stock WHERE order_id = $1 AND state <> 'released'", [a.id])
    assert.ok(stock.every((s) => s.state === 'packed'), 'the usual pack step moved the stock')
    const after = await pack(a.id, la[1].token)
    assert.deepEqual([after.status, after.body.outcome, after.body.orderPacked], [200, 'REPEAT', true])

    // Every scan, refused or not, is logged; tokens are not.
    const { rows: log } = await query('SELECT outcome FROM label_scans WHERE order_id = $1 ORDER BY created_at, id', [a.id])
    assert.deepEqual(log.map((r) => r.outcome), ['WRONG_ORDER', 'OK', 'REPEAT', 'OK', 'REPEAT'])
    const { rows: audits } = await query("SELECT detail FROM staff_audit WHERE action = 'POST /scan/pack'")
    assert.ok(audits.length >= 4 && audits.every((r) => r.detail.scan === '[removed]'))
  })

  test('a cancelled order, an unknown label and labels gone out of date are refused', async () => {
    await setLabels({ enabled: true })
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const a = await paidOrder([{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    const b = await paidOrder([{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    const { labels } = await printed({ date: a.date })
    const [la, lb] = [labels.find((l) => l.orderNumber === labels[0].orderNumber), labels.find((l) => l.orderNumber !== labels[0].orderNumber)]
    const aId = (await query('SELECT id FROM orders WHERE number = $1', [la.orderNumber])).rows[0].id
    const bId = aId === a.id ? b.id : a.id

    assert.equal((await api.post(`/admin/v1/orders/${bId}/cancel`, { reason: 'Customer called' }, { token: admin })).status, 204)
    const cancelled = await pack(bId, lb.token)
    assert.deepEqual([cancelled.status, cancelled.body.error.code], [409, 'ORDER_CANCELLED'])

    const unknown = await pack(aId, tokenFor('Z'.repeat(22)))
    assert.deepEqual([unknown.status, unknown.body.error.code], [404, 'UNKNOWN_LABEL'])
    const forged = await pack(aId, la.token.slice(0, -2) + (la.token.endsWith('AA') ? 'BB' : 'AA'))
    assert.equal(forged.body.error.code, 'UNKNOWN_LABEL')

    // Moved to another day after printing: the date on the box is wrong.
    const moved = await api.post(`/admin/v1/orders/${aId}/reschedule`, { deliveryDate: addDays(a.date, 1) }, { token: admin })
    assert.equal(moved.status, 204, JSON.stringify(moved.body))
    const stale = await pack(aId, la.token)
    assert.deepEqual([stale.status, stale.body.error.code], [409, 'LABELS_OUT_OF_DATE'])
    assert.equal((await api.get(`/admin/v1/orders/${aId}/labels`, { token: admin })).body.current, false)

    // Printing again replaces them; the old QR stops working.
    const fresh = await printed({ orderIds: [aId] })
    assert.equal(fresh.labels[0].deliveryDate, addDays(a.date, 1))
    assert.equal((await pack(aId, la.token)).body.error.code, 'LABEL_REPLACED')
    const ok = await pack(aId, fresh.labels[0].token)
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.orderPacked, true)
  })

  test('a reprint needs a reason, goes to the staff audit and retires the old QR', async () => {
    await setLabels({ enabled: true })
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const a = await paidOrder([{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    const [label] = (await printed({ orderIds: [a.id] })).labels
    assert.equal((await api.get(`/v1/box/${label.token}`)).body.found, true)

    assert.equal((await api.post(`/admin/v1/labels/${label.id}/reprint`, {}, { token: admin })).status, 400)
    const r = await api.post(`/admin/v1/labels/${label.id}/reprint`, { reason: 'Label got wet' }, { token: admin })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal((await api.get(`/v1/box/${label.token}`)).body.found, false, 'old QR no longer resolves')
    assert.equal((await pack(a.id, label.token)).body.error.code, 'UNKNOWN_LABEL')
    const { rows } = await query("SELECT target, detail FROM staff_audit WHERE action = 'POST /labels/:id/reprint'")
    assert.deepEqual(rows.map((x) => [x.target, x.detail.reason]), [[label.id, 'Label got wet']])
    const { rows: reprints } = await query('SELECT reprints FROM box_labels WHERE id = $1', [label.id])
    assert.equal(reprints[0].reprints, 1)
  })

  test('the van scan lists missing boxes and only sends out fully loaded orders', async () => {
    await setLabels({ enabled: true })
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const a = await paidOrder([{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])
    const b = await paidOrder([{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    const { labels } = await printed({ date: a.date })
    const aNum = (await orderOf(a.id)).number
    const la = labels.filter((l) => l.orderNumber === aNum)
    const lb = labels.filter((l) => l.orderNumber !== aNum)
    for (const l of la) assert.equal((await pack(a.id, l.token)).status, 200)
    for (const l of lb) assert.equal((await pack(b.id, l.token)).status, 200)

    const van = (scan) => api.post('/admin/v1/scan/dispatch', { date: a.date, scan }, { token: admin })
    assert.equal((await van(la[0].token)).body.loadedBoxes, 1)
    assert.equal((await van(la[0].token)).body.outcome, 'REPEAT')
    assert.equal((await van(lb[0].token)).status, 200)
    const wrongRun = await api.post('/admin/v1/scan/dispatch', { date: addDays(a.date, 1), scan: la[1].token }, { token: admin })
    assert.deepEqual([wrongRun.status, wrongRun.body.error.code], [409, 'WRONG_RUN'])

    const check = await api.get(`/admin/v1/scan/dispatch?date=${a.date}`, { token: admin })
    const rowA = check.body.orders.find((o) => o.id === a.id)
    assert.deepEqual([rowA.state, rowA.missing], ['missing', [2]])
    assert.equal(check.body.orders.find((o) => o.id === b.id).state, 'ready')

    const sent = await api.post('/admin/v1/scan/dispatch/send', { date: a.date }, { token: admin })
    assert.equal(sent.status, 200, JSON.stringify(sent.body))
    assert.deepEqual(sent.body.dispatched, [(await orderOf(b.id)).number])
    assert.deepEqual(sent.body.skipped, [{ number: aNum, reason: 'Boxes not scanned: 2' }])
    assert.equal((await orderOf(b.id)).status, 'OUT_FOR_DELIVERY')
    assert.equal((await orderOf(a.id)).status, 'PACKED')

    // With scanning required, the old Start run button leaves A behind too.
    await setLabels({ requireDispatchScan: true })
    const run = await api.post('/admin/v1/manifest/dispatch', { date: a.date }, { token: admin })
    assert.deepEqual(run.body.skipped, [{ number: aNum, reason: 'Not every box was scanned onto the van' }])
    await van(la[1].token)
    const run2 = await api.post('/admin/v1/manifest/dispatch', { date: a.date }, { token: admin })
    assert.deepEqual(run2.body.dispatched, [aNum])
  })

  test('riders scan only their run; packers and QC get their parts', async () => {
    await setLabels({ enabled: true })
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const rider = await staff('RIDER', 'ravi@mandimangoes.test')
    const packer = await staff('PACKER', 'pooja@mandimangoes.test')
    const qc = await staff('QC', 'quinn@mandimangoes.test')
    const a = await paidOrder([{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    const later = await paidOrder([{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }], { deliveryDate: '2026-10-17' })

    assert.equal((await print({ date: a.date }, rider)).status, 403)
    assert.equal((await print({ date: a.date }, qc)).status, 403)
    const p = await print({ orderIds: [a.id, later.id] }, packer)
    assert.equal(p.status, 200, JSON.stringify(p.body))
    const { labels } = await printed({ orderIds: [a.id, later.id] })
    const [la, ll] = [labels.find((l) => l.deliveryDate === a.date), labels.find((l) => l.deliveryDate === '2026-10-17')]
    assert.equal((await pack(a.id, la.token, rider)).status, 403)
    assert.equal((await pack(a.id, la.token, qc)).status, 403)
    assert.equal((await pack(a.id, la.token, packer)).status, 200)
    assert.equal((await pack(later.id, ll.token, packer)).status, 200)
    assert.equal((await api.get(`/admin/v1/orders/${a.id}/labels`, { token: qc })).status, 200)
    assert.equal((await api.get(`/admin/v1/scan/lookup?scan=${la.code}`, { token: qc })).body.orderNumber, la.orderNumber)

    // Rider: today's or tomorrow's run only.
    const own = await api.post('/admin/v1/scan/dispatch', { date: a.date, scan: la.token }, { token: rider })
    assert.equal(own.status, 200, JSON.stringify(own.body))
    const far = await api.post('/admin/v1/scan/dispatch', { date: '2026-10-17', scan: ll.token }, { token: rider })
    assert.equal(far.status, 403)
    assert.equal((await api.post('/admin/v1/scan/dispatch/send', { date: a.date }, { token: rider })).body.dispatched.length, 1)

    // Door scan: the box must belong to the order, and the order must be on the rider's run.
    const door = (id, scan) => api.post(`/admin/v1/orders/${id}/door-scan`, { scan }, { token: rider })
    const ok = await door(a.id, la.token)
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.deepEqual([ok.body.checkedBoxes, ok.body.totalBoxes], [1, 1])
    assert.equal((await door(a.id, ll.token)).body.error.code, 'WRONG_BOX')
    assert.equal((await door(later.id, ll.token)).status, 404, 'an order off the run looks like it does not exist')
    assert.equal((await orderOf(a.id)).status, 'OUT_FOR_DELIVERY', 'the door scan never marks the order delivered')
  })

  test('the public box page shows the fruit, never the order or the customer', async () => {
    await setLabels({ enabled: true })
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const a = await paidOrder([{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    const [label] = (await printed({ orderIds: [a.id] })).labels
    const r = await api.get(`/v1/box/${label.token}`)
    assert.equal(r.status, 200)
    assert.deepEqual(Object.keys(r.body).sort(), ['description', 'eatBy', 'found', 'pluckedOn', 'productName', 'readyFrom', 'stage', 'variety'])
    assert.equal(r.body.stage, 'RIPE')
    assert.equal(r.body.eatBy, addDays(a.date, 3))
    // Typed codes are guessable, so the public page never accepts them.
    assert.deepEqual((await api.get(`/v1/box/${label.code}`)).body, { found: false })
    assert.deepEqual((await api.get(`/v1/box/${label.token.slice(0, -1)}A`)).body, { found: false })
    await setLabels({ enabled: false })
    assert.deepEqual((await api.get(`/v1/box/${label.token}`)).body, { found: false })
  })

  test('label tables hold no personal data, so account deletion has nothing to remove there', async () => {
    const { rows } = await query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('box_labels', 'label_scans')`,
    )
    assert.ok(rows.length > 10)
    const personal = rows.filter((r) => /phone|name|address|email|pincode|customer/.test(r.column_name))
    assert.deepEqual(personal, [])
  })
})
