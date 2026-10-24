// Photo storage for delivery proof and claims. With BLOB_READ_WRITE_TOKEN set
// (Vercel Blob), the image goes to a private blob and the row keeps its path,
// so the database stays small. Without it (local, Docker) the bytes are kept
// in the row. Either way the image is only ever served through the API, after
// the staff or customer sign-in is checked.
import { del, get, list, put } from '@vercel/blob'
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client'
import sharp from 'sharp'
import { deployEnv, env, isProd, onVercel } from './env.js'
import { badRequest, HttpError } from './errors.js'
import { logger } from './logger.js'

export const MAX_PHOTO_BYTES = 2 * 1024 * 1024

const MAGIC = [
  ['image/jpeg', 'jpg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', 'png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/webp', 'webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
]

/** Checks the upload is a real JPEG, PNG or WebP (by its first bytes, not its name) of at most `max` bytes. Returns { mime, ext }. */
export function checkPhoto(bytes, max = MAX_PHOTO_BYTES) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw badRequest('Send the photo as the request body', 'PHOTO_REQUIRED')
  if (bytes.length > max) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `The photo is too large (${Math.round(max / 1048576)} MB at most)`)
  const hit = MAGIC.find(([, , test]) => test(bytes))
  if (!hit) throw badRequest('The photo must be a JPEG, PNG or WebP image', 'PHOTO_INVALID')
  return { mime: hit[0], ext: hit[1] }
}

const blobStore = {
  async put(path, bytes, mime) {
    const r = await put(path, bytes, { access: 'private', contentType: mime, addRandomSuffix: false, token: env.BLOB_READ_WRITE_TOKEN })
    return r.pathname
  },
  async get(path) {
    const r = await get(path, { access: 'private', token: env.BLOB_READ_WRITE_TOKEN })
    if (!r || r.statusCode !== 200) return null
    return Buffer.from(await new Response(r.stream).arrayBuffer())
  },
  async del(path) {
    await del(path, { token: env.BLOB_READ_WRITE_TOKEN })
  },
  /** Paths under `prefix` uploaded before `before`, at most `limit`. */
  async listOld(prefix, before, limit) {
    const r = await list({ prefix, limit: 1000, token: env.BLOB_READ_WRITE_TOKEN })
    return r.blobs.filter((b) => new Date(b.uploadedAt) < before).slice(0, limit).map((b) => b.pathname)
  },
}

let store = env.BLOB_READ_WRITE_TOKEN ? blobStore : null

/** Tests swap in an in-memory store. */
export function usePhotoStore(s) {
  store = s
}

/** Saves the image. Returns the columns to write: { bytes } or { blobPath }. */
export async function storePhoto(folder, id, bytes, ext, mime) {
  if (!store) {
    // Never quietly fill the production database with images (preflight refuses this setup too).
    if (onVercel && isProd && deployEnv === 'production') throw new HttpError(503, 'PHOTOS_UNAVAILABLE', 'Photo storage is not set up. Please try again later.')
    return { bytes, blobPath: null }
  }
  return { bytes: null, blobPath: await store.put(`${folder}/${id}.${ext}`, bytes, mime) }
}

/**
 * SEC-9: whether a link is one of our own Blob store's (the only photo links
 * a claim may carry). Claims attach photos by upload now; any other link
 * would be a customer-chosen URL put in front of staff.
 */
export function isOwnPhotoUrl(link) {
  const store = /^vercel_blob_rw_([a-z0-9]+)_/i.exec(env.BLOB_READ_WRITE_TOKEN)
  if (!store || typeof link !== 'string') return false
  try {
    const u = new URL(link)
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false
    return u.hostname === `${store[1].toLowerCase()}.public.blob.vercel-storage.com` || u.hostname === `${store[1].toLowerCase()}.private.blob.vercel-storage.com`
  } catch {
    return false
  }
}

/** The image bytes for a row with `bytes` or `blob_path`. */
export async function photoBytes(row) {
  if (row.bytes) return row.bytes
  if (!row.blob_path || !store) throw new HttpError(404, 'NOT_FOUND', 'Photo not found')
  const b = await store.get(row.blob_path)
  if (!b) throw new HttpError(404, 'NOT_FOUND', 'Photo not found')
  return b
}

export async function dropPhoto(row) {
  if (row.blob_path && store) await store.del(row.blob_path).catch((err) => logger.warn({ err, path: row.blob_path }, 'blob delete failed'))
}

/** Sends a stored photo as the response. */
export async function sendPhoto(res, row, cache = 'private, max-age=86400') {
  const bytes = await photoBytes(row)
  res.set('Content-Type', row.mime).set('Cache-Control', cache).send(bytes)
}

// ---------------------------------------------------------------- thumbnails

/**
 * Widths a public photo (product or review) can be asked for with ?w=, so a
 * 170 px tile or an 88 px review thumbnail does not download the full photo.
 * A short list keeps the number of cached variants (here and at the CDN) small.
 */
export const PHOTO_WIDTHS = [160, 320, 480, 640, 960, 1200]

/** The ?w= of a photo request: null when absent, else one of PHOTO_WIDTHS. Anything else is a 400 (INVALID_WIDTH). */
export function photoWidth(raw) {
  if (raw === undefined) return null
  const w = typeof raw === 'string' && /^\d{1,4}$/.test(raw) ? Number(raw) : NaN
  if (!PHOTO_WIDTHS.includes(w)) throw badRequest(`The photo width (w) must be one of ${PHOTO_WIDTHS.join(', ')}`, 'INVALID_WIDTH')
  return w
}

/** Resized photos kept in memory, least recently used dropped first, at most this many bytes in all. */
const VARIANT_CACHE_BYTES = 16 * 1024 * 1024
const variants = new Map()
const resizing = new Map()
let variantBytes = 0

function remember(key, bytes) {
  if (bytes.length > VARIANT_CACHE_BYTES / 8) return
  variants.set(key, bytes)
  variantBytes += bytes.length
  for (const [k, b] of variants) {
    if (variantBytes <= VARIANT_CACHE_BYTES) break
    variants.delete(k)
    variantBytes -= b.length
  }
}

/** Tests: empty the resized-photo cache. Returns how many variants it held. */
export function clearPhotoVariants() {
  const n = variants.size
  variants.clear()
  variantBytes = 0
  return n
}

/**
 * The photo at `width` px wide (never wider than it was stored) as a JPEG.
 * `key` names the stored image and must change whenever its bytes do.
 */
export async function photoVariant(row, key, width) {
  const id = `${key}@${width}`
  const hit = variants.get(id)
  if (hit) {
    // Move to the back: most recently used.
    variants.delete(id)
    variants.set(id, hit)
    return hit
  }
  if (resizing.has(id)) return resizing.get(id)
  const job = (async () => {
    const original = await photoBytes(row)
    const out = await sharp(original, { failOn: 'none', limitInputPixels: 50_000_000 })
      .resize({ width, withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 72, mozjpeg: true })
      .toBuffer()
    remember(id, out)
    return out
  })().finally(() => resizing.delete(id))
  resizing.set(id, job)
  return await job
}

/** Sends a public photo, resized to `width` when one was asked for. */
export async function sendPublicPhoto(res, row, { key, width, cache }) {
  const bytes = width ? await photoVariant(row, key, width) : await photoBytes(row)
  res
    .set('Content-Type', width ? 'image/jpeg' : row.mime)
    .set('Cache-Control', cache)
    .set('X-Content-Type-Options', 'nosniff')
    // Public by design: the shop and panel, on other origins, show it in an <img>.
    .set('Cross-Origin-Resource-Policy', 'cross-origin')
    .send(bytes)
}

// ---------------------------------------------------------------- review photos

/** The largest photo a customer may upload for a review (before it is shrunk). */
export const MAX_REVIEW_UPLOAD_BYTES = 5 * 1024 * 1024
/** Review photos are kept at most this many pixels on the long side. */
const REVIEW_PHOTO_SIDE = 1600
/** Where the phone uploads straight to Blob before the API checks the photo. */
export const UPLOAD_PREFIX = 'review-uploads/'

/**
 * Re-encodes a checked image as a JPEG of at most 1600 px: a fresh file, so
 * EXIF, GPS and any other metadata (and anything hidden after the image data)
 * is left behind. Throws PHOTO_INVALID for a file that only looks like an image.
 */
export async function cleanImage(bytes, side = REVIEW_PHOTO_SIDE) {
  try {
    const { data, info } = await sharp(bytes, { failOn: 'error', limitInputPixels: 50_000_000 })
      .rotate() // apply the camera's orientation before the tag is dropped
      .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer({ resolveWithObject: true })
    return { bytes: data, mime: 'image/jpeg', ext: 'jpg', width: info.width, height: info.height }
  } catch {
    throw badRequest('The photo could not be read. Try another one.', 'PHOTO_INVALID')
  }
}

/** True when photos go to Vercel Blob (so phones can upload straight to it). */
export const blobUploadsOn = () => Boolean(env.BLOB_READ_WRITE_TOKEN && store === blobStore)

/**
 * A short-lived token that lets the phone put one image (5 MB at most) at one
 * private path in the upload folder, without the bytes passing through the
 * API (Vercel functions refuse bodies over 4.5 MB).
 */
export async function reviewUploadToken(pathname) {
  return await generateClientTokenFromReadWriteToken({
    token: env.BLOB_READ_WRITE_TOKEN,
    pathname,
    allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maximumSizeInBytes: MAX_REVIEW_UPLOAD_BYTES,
    validUntil: Date.now() + 10 * 60_000,
    addRandomSuffix: false,
  })
}

/** The bytes of a direct upload, or null if nothing is there. */
export async function readUpload(path) {
  if (!store) return null
  return await store.get(path)
}

export async function deleteUpload(path) {
  if (store) await store.del(path).catch((err) => logger.warn({ err, path }, 'blob delete failed'))
}

/** Direct uploads older than `before` that were never finished (the phone gave up). */
export async function staleUploads(before, limit) {
  if (!store?.listOld) return []
  return await store.listOld(UPLOAD_PREFIX, before, limit)
}
