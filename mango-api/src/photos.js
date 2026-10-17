// Photo storage for delivery proof and claims. With BLOB_READ_WRITE_TOKEN set
// (Vercel Blob), the image goes to a private blob and the row keeps its path,
// so the database stays small. Without it (local, Docker) the bytes are kept
// in the row. Either way the image is only ever served through the API, after
// the staff or customer sign-in is checked.
import { del, get, put } from '@vercel/blob'
import { env } from './env.js'
import { badRequest, HttpError } from './errors.js'
import { logger } from './logger.js'

export const MAX_PHOTO_BYTES = 2 * 1024 * 1024

const MAGIC = [
  ['image/jpeg', 'jpg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', 'png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/webp', 'webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
]

/** Checks the upload is a real JPEG, PNG or WebP of at most 2 MB. Returns { mime, ext }. */
export function checkPhoto(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw badRequest('Send the photo as the request body', 'PHOTO_REQUIRED')
  if (bytes.length > MAX_PHOTO_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The photo is too large (2 MB at most)')
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
}

let store = env.BLOB_READ_WRITE_TOKEN ? blobStore : null

/** Tests swap in an in-memory store. */
export function usePhotoStore(s) {
  store = s
}

/** Saves the image. Returns the columns to write: { bytes } or { blobPath }. */
export async function storePhoto(folder, id, bytes, ext, mime) {
  if (!store) return { bytes, blobPath: null }
  return { bytes: null, blobPath: await store.put(`${folder}/${id}.${ext}`, bytes, mime) }
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
export async function sendPhoto(res, row) {
  res.set('Content-Type', row.mime).set('Cache-Control', 'private, max-age=86400').send(await photoBytes(row))
}
