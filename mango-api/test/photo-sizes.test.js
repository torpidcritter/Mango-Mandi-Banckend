// Phase 5: public photos at thumbnail widths (?w=) and how long they may be cached.
// ?w= takes one of PHOTO_WIDTHS; any other value is refused with 400 INVALID_WIDTH
// (no silent fallback, so caches never hold a full-size photo under a thumbnail URL).
import { adminToken, checkout, client, closeAll, customerToken, makeBatch, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import sharp from 'sharp'
import { now } from '../src/clock.js'
import { query } from '../src/db.js'
import { newId } from '../src/ids.js'
import { clearPhotoVariants, PHOTO_WIDTHS } from '../src/photos.js'

let srv
let api
let manager

before(async () => {
  srv = await startServer()
  api = client(srv.base)
})
after(async () => {
  await srv.close()
  await closeAll()
})
beforeEach(async () => {
  clearPhotoVariants()
  await resetDb()
  manager = await adminToken(api)
})

/** A photo-like JPEG (blurred noise, so it does not compress to nothing like a flat colour would). */
async function photo(width = 2000, height = 1500) {
  const noisy = await sharp({ create: { width, height, channels: 3, noise: { type: 'gaussian', mean: 140, sigma: 60 } } }).png().toBuffer()
  return sharp(noisy).blur(2).jpeg({ quality: 90 }).toBuffer()
}

const get = async (path) => {
  const res = await fetch(`${srv.base}${path}`)
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) }
}

async function productPhoto(sku = 'ALP-3') {
  const r = await api.raw('PUT', `/admin/v1/products/${sku}/photo`, { token: manager, headers: { 'Content-Type': 'image/jpeg' }, raw: await photo() })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body.photoUrl
}

describe('product photos at thumbnail widths', () => {
  test('?w= sends a smaller JPEG of that width, cached for a year when versioned', async () => {
    const url = await productPhoto()
    const full = await get(url)
    assert.equal(full.status, 200)
    assert.equal((await sharp(full.bytes).metadata()).width, 1200, 'stored at 1200 px')
    assert.equal(full.headers.get('cache-control'), 'public, max-age=31536000, immutable')

    for (const w of [160, 320, 480]) {
      const t = await get(`${url}&w=${w}`)
      assert.equal(t.status, 200)
      assert.equal(t.headers.get('content-type'), 'image/jpeg')
      assert.equal(t.headers.get('cache-control'), 'public, max-age=31536000, immutable')
      assert.equal(t.headers.get('cross-origin-resource-policy'), 'cross-origin')
      assert.equal((await sharp(t.bytes).metadata()).width, w)
      assert.ok(t.bytes.length < full.bytes.length, `${w} px is smaller than the full photo`)
    }
    const thumb = await get(`${url}&w=320`)
    assert.ok(thumb.bytes.length < 20 * 1024, `a 320 px thumbnail is under 20 KB (got ${thumb.bytes.length} bytes)`)

    // Never enlarged: asking for more than the stored width sends the stored width.
    // (1200 is the largest allowed width and the stored size.)
    assert.equal((await sharp((await get(`${url}&w=1200`)).bytes).metadata()).width, 1200)

    // An old or missing version: still served, but only cached for a minute.
    const stale = await get('/v1/products/ALP-3/photo?v=0&w=320')
    assert.equal(stale.status, 200)
    assert.equal(stale.headers.get('cache-control'), 'public, max-age=60')
  })

  test('any other width is refused with 400 INVALID_WIDTH', async () => {
    const url = await productPhoto()
    for (const w of ['100', '321', '0', '-160', '160.0', 'abc', '99999', '']) {
      const r = await api.get(`${url}&w=${encodeURIComponent(w)}`)
      assert.equal(r.status, 400, `w=${w}`)
      assert.equal(r.body.error.code, 'INVALID_WIDTH')
    }
    const twice = await api.get(`${url}&w=160&w=320`)
    assert.equal(twice.status, 400, 'w given twice')
    assert.deepEqual(PHOTO_WIDTHS, [160, 320, 480, 640, 960, 1200])
    // The width is checked first, so a bad width on a product with no photo is still a 400.
    assert.equal((await api.get('/v1/products/BAD-3/photo?w=7')).status, 400)
    assert.equal((await api.get('/v1/products/BAD-3/photo?w=160')).status, 404)
  })

  test('a removed and re-added photo gets a new URL, and its thumbnail is the new photo', async () => {
    const url = await productPhoto()
    const before = (await get(`${url}&w=160`)).bytes
    assert.equal((await api.del('/admin/v1/products/ALP-3/photo', { token: manager })).status, 200)
    const flat = await sharp({ create: { width: 1000, height: 800, channels: 3, background: { r: 20, g: 120, b: 40 } } }).jpeg().toBuffer()
    // The version is the upload time in seconds; a person can't remove and re-add within one.
    await new Promise((r) => setTimeout(r, 1000 - (Date.now() % 1000) + 10))
    const again = await api.raw('PUT', '/admin/v1/products/ALP-3/photo', { token: manager, headers: { 'Content-Type': 'image/jpeg' }, raw: flat })
    assert.notEqual(again.body.photoUrl, url, 'never the URL browsers cached for the removed photo')
    const after = (await get(`${again.body.photoUrl}&w=160`)).bytes
    assert.ok(!after.equals(before), 'not the cached thumbnail of the removed photo')
    const { dominant } = await sharp(after).stats()
    assert.ok(dominant.g > dominant.r, 'the new (green) photo')
  })
})

describe('review photos at thumbnail widths', () => {
  /** An approved review of ALP-3 with one approved photo. Returns the photo's public URL. */
  async function approvedPhoto() {
    await makeBatch({ age: 6, rating: 'RIPE', lines: { 'ALP-3': 30 } })
    const cust = await customerToken(api)
    const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal(c.status, 201, JSON.stringify(c.body))
    await api.post('/v1/dev/pay', { orderId: c.body.orderId, outcome: 'captured' })
    await query(`UPDATE orders SET status = 'DELIVERED' WHERE id = $1`, [c.body.orderId])
    await query(`INSERT INTO order_events (id, order_id, from_status, status, actor, created_at) VALUES ($1, $2, 'OUT_FOR_DELIVERY', 'DELIVERED', 'test', $3)`, [
      newId('evt'), c.body.orderId, now(),
    ])
    const { rows } = await query('SELECT id FROM order_items WHERE order_id = $1', [c.body.orderId])
    const up = await api.raw('POST', '/v1/reviews/photos', { token: cust.accessToken, raw: await photo(), headers: { 'Content-Type': 'image/jpeg' } })
    assert.equal(up.status, 201, JSON.stringify(up.body))
    const r = await api.post('/v1/reviews', { orderItemId: rows[0].id, rating: 5, photoIds: [up.body.id] }, { token: cust.accessToken, headers: { 'Idempotency-Key': newId('k') } })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal((await api.post(`/admin/v1/reviews/${r.body.review.id}/approve`, { photoIds: [up.body.id] }, { token: manager })).status, 200)
    const list = await api.get('/v1/products/ALP-3/reviews')
    return { url: list.body.items[0].photos[0].url, reviewId: r.body.review.id }
  }

  test('a thumbnail is under 20 KB, and review photos are cached for 30 days (10 minutes in shared caches)', async () => {
    const { url } = await approvedPhoto()
    const full = await get(url)
    assert.equal(full.status, 200)
    assert.equal((await sharp(full.bytes).metadata()).width, 1600)
    const cache = 'public, max-age=2592000, s-maxage=600, immutable'
    assert.equal(full.headers.get('cache-control'), cache)

    for (const w of [160, 320]) {
      const t = await get(`${url}?w=${w}`)
      assert.equal(t.status, 200)
      assert.equal(t.headers.get('cache-control'), cache)
      assert.equal(t.headers.get('content-type'), 'image/jpeg')
      assert.equal(t.headers.get('cross-origin-resource-policy'), 'cross-origin')
      assert.equal((await sharp(t.bytes).metadata()).width, w)
      assert.ok(t.bytes.length < 20 * 1024, `${w} px thumbnail under 20 KB (got ${t.bytes.length} bytes)`)
    }
    const bad = await api.get(`${url}?w=88`)
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error.code, 'INVALID_WIDTH')
  })

  test('a hidden review’s photo is not found at any width, even after its thumbnail was made', async () => {
    const { url, reviewId } = await approvedPhoto()
    assert.equal((await get(`${url}?w=160`)).status, 200)
    await api.post(`/admin/v1/reviews/${reviewId}/hide`, { reason: 'off topic' }, { token: manager })
    assert.equal((await get(`${url}?w=160`)).status, 404)
    assert.equal((await get(url)).status, 404)
  })
})
