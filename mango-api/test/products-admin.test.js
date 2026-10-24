// Managers add, rename and remove products. A removed product that was ever
// stocked, ordered or preordered is hidden instead of deleted, so history
// keeps its name.
import { adminToken, checkout, client, closeAll, customerToken, makeBatch, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { todayIST } from '../src/clock.js'
import { query } from '../src/db.js'
import { seed } from '../src/seed.js'

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

const KESAR = { sku: 'kes-3', name: 'Kesar 3kg Box', variety: 'Kesar', boxSize: '3kg', price: 159_900, description: 'Kesar from Junagadh: saffron-sweet.' }
const shopItem = async (sku, stage = 'RIPE') => (await api.get('/v1/catalogue?pincode=560034')).body.items.find((i) => i.sku === sku && i.stage === stage)
const newBatch = (variety, sku) =>
  api.post('/admin/v1/batches', { variety, pluckedOn: todayIST(), farm: 'Junagadh', lines: [{ sku, onHand: 10 }] }, { token: admin })

describe('products', () => {
  test('a manager adds a product; it is on sale at once and can be stocked; operators cannot', async () => {
    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    assert.equal((await api.post('/admin/v1/products', KESAR, { token: ops })).status, 403)
    assert.equal((await api.post('/admin/v1/products', { ...KESAR, sku: 'k' }, { token: admin })).status, 400)
    assert.equal((await api.post('/admin/v1/products', { ...KESAR, price: 0 }, { token: admin })).status, 400)

    const made = await api.post('/admin/v1/products', KESAR, { token: admin })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    assert.deepEqual([made.body.sku, made.body.active, made.body.hsnCode, made.body.gstRate], ['KES-3', true, '08045020', 0])
    assert.equal((await api.post('/admin/v1/products', KESAR, { token: admin })).body.error.code, 'PRODUCT_EXISTS')

    const list = (await api.get('/admin/v1/products', { token: ops })).body
    assert.ok(list.some((p) => p.sku === 'KES-3' && p.variety === 'Kesar'))
    const item = await shopItem('KES-3')
    assert.equal(item.name, 'Kesar 3kg Box')
    assert.equal(item.qty, 0, 'on sale, but no stock until a batch arrives')
    assert.equal((await newBatch('Kesar', 'KES-3')).status, 201)
  })

  test('renaming and repricing show up in the shop; the variety is fixed once stocked', async () => {
    await makeBatch({ age: 6, rating: 'RIPE', lines: { 'ALP-3': 10 } })
    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    assert.equal((await api.patch('/admin/v1/products/ALP-3', { name: 'x' }, { token: ops })).status, 403)
    const r = await api.patch('/admin/v1/products/ALP-3', { name: 'Alphonso Premium 3kg', price: 199_900 }, { token: admin })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.name, 'Alphonso Premium 3kg')
    const item = await shopItem('ALP-3')
    assert.deepEqual([item.name, item.price], ['Alphonso Premium 3kg', 199_900])
    assert.equal((await api.patch('/admin/v1/products/ALP-3', { variety: 'Badami' }, { token: admin })).body.error.code, 'VARIETY_LOCKED')
    assert.equal((await api.patch('/admin/v1/products/ALP-3', { sku: 'NEW' }, { token: admin })).status, 400, 'the SKU never changes')
    assert.equal((await api.patch('/admin/v1/products/NOPE', { name: 'Nope box' }, { token: admin })).status, 404)
    // Never stocked: the variety can still be corrected.
    assert.equal((await api.patch('/admin/v1/products/BAD-5', { variety: 'Banganapalli' }, { token: admin })).body.variety, 'Banganapalli')
  })

  test('removing a never-used product deletes it, and a later deploy does not bring it back', async () => {
    const r = await api.del('/admin/v1/products/BAD-5', { token: admin })
    assert.deepEqual(r.body, { sku: 'BAD-5', outcome: 'deleted' })
    assert.ok(!(await api.get('/admin/v1/products', { token: admin })).body.some((p) => p.sku === 'BAD-5'))
    await seed()
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM products WHERE sku = 'BAD-5'`)).rows[0].n, 0)
    assert.equal((await api.del('/admin/v1/products/BAD-5', { token: admin })).status, 404)
  })

  test('removing a sold product hides it everywhere new, keeps its name on old orders, and it can come back', async () => {
    await makeBatch({ age: 6, rating: 'RIPE', lines: { 'ALP-3': 10 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal(c.status, 201, JSON.stringify(c.body))
    // Someone else has it in their cart when it is removed.
    const other = await customerToken(api)
    await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 1 }, { token: other.accessToken })

    assert.deepEqual((await api.del('/admin/v1/products/ALP-3', { token: admin })).body, { sku: 'ALP-3', outcome: 'hidden' })
    assert.equal(await shopItem('ALP-3'), undefined)
    assert.equal((await api.get('/admin/v1/products', { token: admin })).body.find((p) => p.sku === 'ALP-3').active, false)
    assert.equal((await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 1 }, { token: cust.accessToken })).body.error.code, 'INVALID_SKU')
    const cart = (await api.get('/v1/cart', { token: other.accessToken })).body
    assert.deepEqual([cart.lines[0].available, cart.lines[0].insufficient], [0, true])
    const q = await api.post('/v1/checkout/quote', { pincode: '560034' }, { token: other.accessToken })
    assert.equal(q.body.error.code, 'PRODUCT_UNAVAILABLE')
    assert.match(q.body.error.message, /Alphonso 3kg Box is no longer sold/)
    // They can still take it out of the cart.
    assert.equal((await api.post('/v1/cart/items', { sku: 'ALP-3', stage: 'RIPE', qty: 0 }, { token: other.accessToken })).status < 300, true)
    assert.equal((await newBatch('Alphonso', 'ALP-3')).body.error.code, 'PRODUCT_INACTIVE')

    const old = (await api.get(`/v1/orders/${c.body.orderId}`, { token: cust.accessToken })).body
    assert.equal(old.items[0].name, 'Alphonso 3kg Box')

    assert.equal((await api.patch('/admin/v1/products/ALP-3', { active: true }, { token: admin })).body.active, true)
    assert.ok((await shopItem('ALP-3')).qty > 0)
  })

  test('a manager adds, replaces and removes a product photo; the shop shows it', async () => {
    const sharp = (await import('sharp')).default
    const png = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#f59e0b' } }).png().toBuffer()
    const put = (bytes, token = admin, type = 'image/png') =>
      api.raw('PUT', '/admin/v1/products/ALP-3/photo', { token, headers: { 'Content-Type': type }, raw: bytes })

    const ops = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    assert.equal((await put(png, ops)).status, 403)
    assert.equal((await put(Buffer.from('not an image'))).body.error.code, 'PHOTO_INVALID')
    assert.equal((await api.raw('PUT', '/admin/v1/products/NOPE-1/photo', { token: admin, headers: { 'Content-Type': 'image/png' }, raw: png })).status, 404)

    const first = await put(png)
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.match(first.body.photoUrl, /^\/v1\/products\/ALP-3\/photo\?v=\d+$/)
    const v1 = Number(first.body.photoUrl.split('v=')[1])
    assert.equal((await shopItem('ALP-3', 'RAW')).photoUrl, first.body.photoUrl)
    assert.equal((await shopItem('BAD-3', 'RAW')).photoUrl, null)

    // Public, shrunk to 1200 px, re-encoded as a JPEG, and cacheable for good at its version.
    const pic = await fetch(`${srv.base}${first.body.photoUrl}`)
    assert.equal(pic.status, 200)
    assert.equal(pic.headers.get('content-type'), 'image/jpeg')
    assert.match(pic.headers.get('cache-control'), /immutable/)
    assert.equal(pic.headers.get('cross-origin-resource-policy'), 'cross-origin')
    const meta = await sharp(Buffer.from(await pic.arrayBuffer())).metadata()
    assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 1200, 800])

    const second = await put(png)
    const v2 = Number(second.body.photoUrl.split('v=')[1])
    assert.ok(v2 > v1, `${v2} > ${v1}`)
    assert.match((await fetch(`${srv.base}/v1/products/ALP-3/photo?v=${v1}`)).headers.get('cache-control'), /max-age=60\b/)

    assert.equal((await api.del('/admin/v1/products/ALP-3/photo', { token: ops })).status, 403)
    const gone = await api.del('/admin/v1/products/ALP-3/photo', { token: admin })
    assert.equal(gone.body.photoUrl, null)
    assert.equal((await fetch(`${srv.base}/v1/products/ALP-3/photo?v=${v2}`)).status, 404)
    assert.equal((await api.del('/admin/v1/products/ALP-3/photo', { token: admin })).status, 404)

    // Added again after removal: the version is the upload time in seconds, so it never
    // goes back to an old number a browser may still have cached for a year.
    const before = Math.floor(Date.now() / 1000)
    const again = await put(png)
    assert.ok(Number(again.body.photoUrl.split('v=')[1]) >= before)
    await api.del('/admin/v1/products/ALP-3/photo', { token: admin })

    // A product deleted outright takes its photo with it.
    await api.post('/admin/v1/products', KESAR, { token: admin })
    await api.raw('PUT', '/admin/v1/products/KES-3/photo', { token: admin, headers: { 'Content-Type': 'image/png' }, raw: png })
    assert.equal((await api.del('/admin/v1/products/KES-3', { token: admin })).body.outcome, 'deleted')
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM product_photos')).rows[0].n, 0)
  })
})
