// Proof of delivery: the rider role, the customer's delivery code, photos and missed deliveries.
import { closeAll, adminToken, checkout, client, customerToken, makeBatch, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { now, setNow } from '../src/clock.js'
import { cleanupExpired } from '../src/maintenance.js'
import { usePhotoStore } from '../src/photos.js'
import { query } from '../src/db.js'
import { sendDueNotifications } from '../src/notify.js'

let srv
let api
let admin
let rider

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
  const add = await api.post('/admin/v1/staff', { email: 'ravi@mandimangoes.test', role: 'RIDER', password: 'long-enough-1' }, { token: admin })
  assert.equal(add.status, 201, JSON.stringify(add.body))
  rider = await adminToken(api, 'ravi@mandimangoes.test', 'long-enough-1')
})

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)])

/** A paid order, packed and ready for the rider. */
async function packedOrder(cust) {
  const o = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
  assert.equal(o.status, 201, JSON.stringify(o.body))
  await api.post('/v1/dev/pay', { orderId: o.body.orderId, outcome: 'captured' })
  const id = o.body.orderId
  await api.patch(`/admin/v1/orders/${id}/status`, { status: 'PROCESSING' }, { token: admin })
  assert.equal((await api.post(`/admin/v1/orders/${id}/allocate`, undefined, { token: admin })).status, 204)
  assert.equal((await api.patch(`/admin/v1/orders/${id}/status`, { status: 'PACKED' }, { token: admin })).status, 204)
  return { id, date: o.body.deliveryDate }
}
const deliver = (id, body, token = rider) => api.post(`/admin/v1/orders/${id}/delivery`, body, { token })
const upload = (id, bytes, type = 'image/jpeg') =>
  api.raw('POST', `/admin/v1/orders/${id}/delivery-photos`, { token: rider, headers: { 'Content-Type': type }, raw: bytes })
const mine = (cust, id) => api.get(`/v1/orders/${id}`, { token: cust.accessToken })

describe('proof of delivery', () => {
  test('riders see only the run; the customer code marks the order delivered', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const { id, date } = await packedOrder(cust)

    assert.equal((await api.get('/admin/v1/orders', { token: rider })).status, 403)
    assert.equal((await api.patch(`/admin/v1/orders/${id}/status`, { status: 'SHIPPED' }, { token: rider })).status, 403)
    assert.equal((await mine(cust, id)).body.deliveryCode, null)

    const run = await api.post('/admin/v1/manifest/dispatch', { date }, { token: rider })
    assert.equal(run.status, 200, JSON.stringify(run.body))
    assert.equal(run.body.dispatched.length, 1)
    const manifest = await api.get(`/admin/v1/manifest?date=${date}`, { token: rider })
    assert.equal(manifest.body.runs[0].stops[0].orders[0].status, 'OUT_FOR_DELIVERY')

    const code = (await mine(cust, id)).body.deliveryCode
    assert.match(code, /^\d{4}$/)
    // The WhatsApp update carries the code as its last variable.
    const sent = []
    await sendDueNotifications({ sender: async (m) => (sent.push(m), 'wamid.x') })
    assert.equal(sent.find((m) => m.template === 'mandi_out_for_delivery').params.at(-1), code)

    const wrong = await deliver(id, { outcome: 'DELIVERED', code: code === '0000' ? '1111' : '0000' })
    assert.equal(wrong.status, 422)
    assert.equal(wrong.body.error.code, 'WRONG_CODE')
    assert.equal(wrong.body.error.triesLeft, 4)
    assert.equal((await deliver(id, { outcome: 'DELIVERED' })).body.error.code, 'PROOF_REQUIRED')

    const ok = await deliver(id, { outcome: 'DELIVERED', code, lat: 12.9352, lng: 77.6245 })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.deepEqual(ok.body, { outcome: 'DELIVERED', method: 'code' })
    assert.equal((await deliver(id, { outcome: 'DELIVERED', code })).status, 409)

    const seen = (await mine(cust, id)).body
    assert.equal(seen.status, 'DELIVERED')
    assert.equal(seen.deliveryCode, null)
    assert.equal(seen.delivery.method, 'code')
    const staffView = (await api.get(`/admin/v1/orders/${id}`, { token: admin })).body
    assert.deepEqual(staffView.deliveryAttempts.map((a) => [a.outcome, a.method, a.actor, a.lat]), [['DELIVERED', 'code', 'ravi@mandimangoes.test', 12.9352]])
  })

  test('a photo and who took it, when nobody can give the code', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const { id } = await packedOrder(cust)
    assert.equal((await upload(id, JPEG)).body.error.code, 'INVALID_TRANSITION')
    assert.equal((await api.post(`/admin/v1/orders/${id}/dispatch`, undefined, { token: rider })).status, 204)

    assert.equal((await upload(id, Buffer.from('not an image at all'), 'image/png')).body.error.code, 'PHOTO_INVALID')
    const up = await upload(id, JPEG)
    assert.equal(up.status, 201, JSON.stringify(up.body))
    assert.equal((await deliver(id, { outcome: 'DELIVERED', photoId: up.body.id })).body.error.code, 'RECEIVER_REQUIRED')
    const ok = await deliver(id, { outcome: 'DELIVERED', photoId: up.body.id, receivedBy: 'Security guard at the gate' })
    assert.deepEqual(ok.body, { outcome: 'DELIVERED', method: 'photo' })

    assert.deepEqual((await mine(cust, id)).body.delivery, {
      at: (await mine(cust, id)).body.delivery.at, method: 'photo', receivedBy: 'Security guard at the gate', hasPhoto: true,
    })
    const pic = await fetch(`${srv.base}/v1/orders/${id}/delivery-photo`, { headers: { Authorization: `Bearer ${cust.accessToken}` } })
    assert.equal(pic.headers.get('content-type'), 'image/jpeg')
    assert.ok(Buffer.from(await pic.arrayBuffer()).equals(JPEG))
    const stranger = await customerToken(api)
    assert.equal((await api.get(`/v1/orders/${id}/delivery-photo`, { token: stranger.accessToken })).status, 404)
    const staffPic = await fetch(`${srv.base}/admin/v1/orders/${id}/delivery-photos/${up.body.id}`, { headers: { Authorization: `Bearer ${admin}` } })
    assert.equal(staffPic.status, 200)
  })

  test('a missed delivery needs a reason, retries the next day with the same code, and five wrong codes lock it', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const { id, date } = await packedOrder(cust)
    setNow(`${date}T04:00:00Z`) // the delivery day, 9:30 IST
    await api.post(`/admin/v1/orders/${id}/dispatch`, undefined, { token: rider })
    const code = (await mine(cust, id)).body.deliveryCode

    assert.equal((await deliver(id, { outcome: 'FAILED' })).body.error.code, 'REASON_REQUIRED')
    assert.equal((await deliver(id, { outcome: 'FAILED', reason: 'NOT_HOME', note: 'Called twice' })).status, 200)
    const failed = (await api.get(`/admin/v1/orders/${id}`, { token: admin })).body
    assert.equal(failed.status, 'DELIVERY_FAILED')
    assert.notEqual(failed.deliveryDate, date)
    assert.match(failed.events.at(-1).reason, /^Customer not home; retrying on /)
    assert.equal(failed.deliveryAttempts[0].note, 'Called twice')

    const retry = await api.post('/admin/v1/manifest/dispatch', { date: failed.deliveryDate }, { token: rider })
    assert.deepEqual(retry.body.dispatched, [failed.number])
    assert.equal((await mine(cust, id)).body.deliveryCode, code)

    const bad = code === '0000' ? '1111' : '0000'
    for (let i = 0; i < 5; i++) assert.equal((await deliver(id, { outcome: 'DELIVERED', code: bad })).status, 422)
    const locked = await deliver(id, { outcome: 'DELIVERED', code })
    assert.equal(locked.status, 429)
    assert.equal(locked.body.error.code, 'CODE_LOCKED')
  })

  test('staff marking delivered from the panel is recorded without proof; unpacked orders are skipped', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const { id, date } = await packedOrder(cust)
    const unpacked = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    await api.post('/v1/dev/pay', { orderId: unpacked.body.orderId, outcome: 'captured' })

    const run = await api.post('/admin/v1/manifest/dispatch', { date }, { token: admin })
    assert.equal(run.body.dispatched.length, 1)
    assert.deepEqual(run.body.skipped.map((s) => s.reason), ['Not packed yet'])
    assert.equal((await api.patch(`/admin/v1/orders/${id}/status`, { status: 'DELIVERED' }, { token: admin })).status, 204)
    const o = (await api.get(`/admin/v1/orders/${id}`, { token: admin })).body
    assert.deepEqual(o.deliveryAttempts.map((a) => [a.outcome, a.method]), [['DELIVERED', 'staff']])
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM delivery_attempts')).rows[0].n, 1)
  })
})

describe('photos in Blob storage', () => {
  const blobs = new Map()
  const fake = {
    put: async (path, bytes) => (blobs.set(path, Buffer.from(bytes)), path),
    get: async (path) => blobs.get(path) ?? null,
    del: async (path) => void blobs.delete(path),
  }
  beforeEach(() => {
    blobs.clear()
    usePhotoStore(fake)
  })
  after(() => usePhotoStore(null))

  const claimPhoto = (cust, bytes = JPEG) =>
    api.raw('POST', '/v1/claims/photos', { token: cust.accessToken, headers: { 'Content-Type': 'image/jpeg' }, raw: bytes })

  test('delivery and claim photos go to the store, not the database, and only the owner and staff see them', async () => {
    await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const { id } = await packedOrder(cust)
    await api.post(`/admin/v1/orders/${id}/dispatch`, undefined, { token: rider })
    const up = await upload(id, JPEG)
    assert.equal(up.status, 201, JSON.stringify(up.body))
    const row = (await query('SELECT bytes, blob_path FROM delivery_photos WHERE id = $1', [up.body.id])).rows[0]
    assert.equal(row.bytes, null)
    assert.ok(blobs.has(row.blob_path))
    await deliver(id, { outcome: 'DELIVERED', photoId: up.body.id, receivedBy: 'Neighbour' })
    const pic = await fetch(`${srv.base}/v1/orders/${id}/delivery-photo`, { headers: { Authorization: `Bearer ${cust.accessToken}` } })
    assert.ok(Buffer.from(await pic.arrayBuffer()).equals(JPEG))

    // Claim photos: uploaded first, then sent with the claim.
    assert.equal((await claimPhoto(cust, Buffer.from('nope'))).body.error.code, 'PHOTO_INVALID')
    const ids = []
    for (let i = 0; i < 4; i++) ids.push((await claimPhoto(cust)).body.id)
    const stranger = await customerToken(api)
    const theirs = (await claimPhoto(stranger)).body.id
    const body = { orderId: id, issueType: 'DAMAGED', description: 'Box crushed on one side', itemSkus: ['ALP-3'] }
    assert.equal((await api.post('/v1/claims', { ...body, photoIds: ids }, { token: cust.accessToken })).status, 400)
    assert.equal((await api.post('/v1/claims', { ...body, photoIds: [ids[0], theirs] }, { token: cust.accessToken })).body.error.code, 'PHOTO_NOT_FOUND')
    const claim = await api.post('/v1/claims', { ...body, photoIds: ids.slice(0, 2) }, { token: cust.accessToken })
    assert.equal(claim.status, 201, JSON.stringify(claim.body))
    assert.equal(claim.body.photos, 2)

    const listed = (await api.get('/admin/v1/claims', { token: admin })).body[0]
    assert.deepEqual(listed.photos.map((p) => p.id), ids.slice(0, 2))
    const staffPic = await fetch(`${srv.base}/admin/v1/claims/${claim.body.id}/photos/${ids[0]}`, { headers: { Authorization: `Bearer ${admin}` } })
    assert.equal(staffPic.status, 200)
    assert.ok(Buffer.from(await staffPic.arrayBuffer()).equals(JPEG))
    assert.equal((await api.get(`/admin/v1/claims/${claim.body.id}/photos/${ids[3]}`, { token: admin })).status, 404)

    // Photos never sent with a claim are cleared after a day, blobs too.
    const before = blobs.size
    await cleanupExpired(new Date(now().getTime() + 2 * 86_400_000))
    assert.equal(blobs.size, before - 3)
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM claim_photos')).rows[0].n, 2)
  })
})
