import './setup-env.js'
import { createHmac } from 'node:crypto'
import { createApp } from '../src/app.js'
import { drainBackground } from '../src/background.js'
import { addDays, now, setNow, todayIST } from '../src/clock.js'
import { loadConfig } from '../src/config.js'
import { pool, query } from '../src/db.js'
import { env } from '../src/env.js'
import { newId } from '../src/ids.js'
import { runMigrations } from '../src/migrate.js'
import { loadProducts } from '../src/products.js'
import { seed } from '../src/seed.js'

/** 10:00 IST on 2026-10-15: before the 18:00 cutoff, so the earliest delivery is 10-16. */
export const T0 = '2026-10-15T04:30:00Z'

export async function resetDb() {
  // Work a test left running after a response (refunds after a webhook) must not race the schema reset.
  await drainBackground()
  setNow(T0)
  await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  await runMigrations()
  await seed()
  await loadConfig()
  await loadProducts()
}

export async function startServer() {
  const server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, close: () => new Promise((r) => server.close(r)) }
}

export const closeAll = () => pool.end()

export function client(base) {
  const call = async (method, path, { body, token, headers = {}, raw } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = text
    }
    return { status: res.status, body: json, headers: res.headers }
  }
  return {
    get: (p, o) => call('GET', p, o),
    post: (p, b, o = {}) => call('POST', p, { ...o, body: b }),
    patch: (p, b, o = {}) => call('PATCH', p, { ...o, body: b }),
    put: (p, b, o = {}) => call('PUT', p, { ...o, body: b }),
    del: (p, o) => call('DELETE', p, o),
    raw: call,
  }
}

export async function adminToken(api, email = 'manager@mandimangoes.test', password = 'manager123') {
  const r = await api.post('/admin/v1/auth/login', { email, password })
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.accessToken
}

let phoneSeq = 0
export async function customerToken(api, phone = `98${String(10_000_000 + ++phoneSeq).slice(-8)}`) {
  const req = await api.post('/v1/auth/otp/request', { phone })
  const v = await api.post('/v1/auth/otp/verify', { phone, code: req.body.devCode })
  if (v.status !== 200) throw new Error(`otp verify failed: ${v.status} ${JSON.stringify(v.body)}`)
  return v.body
}

/**
 * Inserts a batch directly. `age` is days since pluck as of today (IST).
 * `rating` logs a QC reading now.
 */
export async function makeBatch({ variety = 'Alphonso', age, status = 'SELLING', rating = 'RIPE', condition = 'GOOD', lines }) {
  const id = newId('bat')
  const pluckedOn = addDays(todayIST(), -age)
  await query('INSERT INTO batches (id, variety, plucked_on, status, eta_date, arrived_at) VALUES ($1, $2, $3, $4, $5, $6)', [
    id, variety, pluckedOn, status, addDays(pluckedOn, 2), status === 'IN_TRANSIT' ? null : new Date(),
  ])
  for (const [sku, qty] of Object.entries(lines)) {
    await query('INSERT INTO batch_lines (id, batch_id, sku, on_hand) VALUES ($1, $2, $3, $4)', [newId('bl'), id, sku, qty])
    await query(
      `INSERT INTO batch_ledger (id, batch_id, event_type, sku, delta, actor_type, actor_id, created_at) VALUES ($1, $2, 'INTAKE', $3, $4, 'system', 'test', $5)`,
      [newId('led'), id, sku, qty, now()],
    )
  }
  if (rating) {
    await query(`INSERT INTO batch_qc (id, batch_id, ripeness_rating, condition, logged_by, logged_at) VALUES ($1, $2, $3, $4, 'test', $5)`, [
      newId('qc'), id, rating, condition, new Date(Date.parse(T0)),
    ])
  }
  return id
}

export async function line(batchId, sku) {
  const { rows } = await query('SELECT * FROM batch_lines WHERE batch_id = $1 AND sku = $2', [batchId, sku])
  return rows[0]
}

/** Cart → quote → confirm for one customer. Returns the confirm response. */
export async function checkout(api, token, items, { pincode = '560034', deliveryDate, slotId, key = newId('idem') } = {}) {
  for (const it of items) {
    const r = await api.post('/v1/cart/items', it, { token })
    if (r.status !== 204) throw new Error(`cart: ${r.status} ${JSON.stringify(r.body)}`)
  }
  const q = await api.post('/v1/checkout/quote', { pincode, deliveryDate, slotId }, { token })
  if (q.status !== 200) return q
  return api.post('/v1/checkout/confirm', { quoteId: q.body.quoteId, address: '12, 4th Cross, Koramangala, Bengaluru' }, { token, headers: { 'Idempotency-Key': key } })
}

export function signWebhook(body) {
  const raw = JSON.stringify(body)
  return { raw, signature: createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex') }
}
