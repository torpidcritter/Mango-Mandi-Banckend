// Stand-ins for Razorpay and the Jio SMS gateway, for load tests only. No
// real provider is ever called: the API is started with
// `--import ./ops/load/provider-redirect.js`, which sends every request for
// api.razorpay.com here (and refuses anything else for that host), and with
// JIO_SMS_URL pointing here.
//
//   node ops/load/stub-providers.js            # listens on STUB_PORT (3145)
//
// Only the calls payments.js and sms.js already make are answered. The
// shapes are the ones that code reads (id, items, status, amount); nothing
// else of Razorpay's API is imitated.
//
// Control (for the k6 scripts):
//   GET  /ctl/otp?phone=+91...       the last login code sent to that number
//   POST /ctl/pay {order, status, amount}  a payment Razorpay would report for
//        that Razorpay order (reconcile finds it; no webhook is sent)
//   POST /ctl/mode {orders: 'ok'|'slow'|'hang', delayMs, sms: 'ok'|'slow'}
//        'hang' never answers order creation, so the API's 10 s timeout fires
//   GET  /ctl/stats                  calls answered, by route
import http from 'node:http'
import { randomBytes } from 'node:crypto'

const PORT = Number(process.env.STUB_PORT || 3145)
const codes = new Map() // phone -> code
const payments = new Map() // razorpay order id -> [{ id, status, amount, ... }]
const refunds = new Map() // payment id -> [{ id, status, amount }]
const stats = {}
let mode = { orders: 'ok', delayMs: 0, sms: 'ok' }

const id = (p) => `${p}_stub${randomBytes(7).toString('hex')}`
const count = (k) => (stats[k] = (stats[k] ?? 0) + 1)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function body(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://stub')
  const p = url.pathname
  const b = req.method === 'POST' ? await body(req) : {}

  // ---- control
  if (p === '/ctl/otp') return send(res, codes.has(url.searchParams.get('phone')) ? 200 : 404, { code: codes.get(url.searchParams.get('phone')) ?? null })
  if (p === '/ctl/pay') {
    const list = payments.get(b.order) ?? []
    const pay = { id: b.id ?? id('pay'), entity: 'payment', status: b.status ?? 'captured', amount: b.amount, currency: 'INR', method: 'upi', order_id: b.order, created_at: Math.floor(Date.now() / 1000) }
    list.push(pay)
    payments.set(b.order, list)
    return send(res, 200, pay)
  }
  if (p === '/ctl/mode') {
    mode = { ...mode, ...b }
    return send(res, 200, mode)
  }
  if (p === '/ctl/stats') return send(res, 200, { stats, mode, codes: codes.size, orders: payments.size })
  if (p === '/ctl/reset') {
    codes.clear(); payments.clear(); refunds.clear(); mode = { orders: 'ok', delayMs: 0, sms: 'ok' }
    for (const k of Object.keys(stats)) delete stats[k]
    return send(res, 200, { ok: true })
  }

  // ---- Jio SMS (sms.js jioSender posts { to, message, ... })
  if (p === '/jio/send' && req.method === 'POST') {
    count('jio.send')
    if (mode.sms === 'slow') await wait(mode.delayMs || 6000)
    const code = /(\d{6})/.exec(String(b.message ?? ''))?.[1]
    if (b.to && code) codes.set(`+${String(b.to).replace(/^\+/, '')}`, code)
    return send(res, 200, { status: 'accepted' })
  }

  // ---- Cloudflare Turnstile (turnstile.js): every token passes, for the shop's host and action.
  if (p === '/turnstile/siteverify') {
    count('turnstile.verify')
    return send(res, 200, { success: true, hostname: process.env.STUB_SHOP_HOST || 'shop.load.test', action: 'otp' })
  }
  // ---- Sentry (SENTRY_DSN points here): events are accepted and dropped.
  if (p.startsWith('/api/')) {
    count('sentry.envelope')
    return send(res, 200, {})
  }

  // ---- Razorpay (payments.js)
  if (!p.startsWith('/razorpay/v1/')) return send(res, 404, { error: 'not stubbed' })
  const r = p.slice('/razorpay/v1'.length)
  let m
  if (r === '/orders' && req.method === 'POST') {
    count('rzp.orders.create')
    if (mode.orders === 'hang') {
      count('rzp.orders.hung')
      return // never answers: the caller's AbortSignal.timeout(10_000) fires
    }
    if (mode.orders === 'slow') await wait(mode.delayMs || 3000)
    const o = { id: id('order'), entity: 'order', amount: b.amount, currency: 'INR', receipt: b.receipt, status: 'created' }
    payments.set(o.id, [])
    return send(res, 200, o)
  }
  if ((m = /^\/orders\/([^/]+)\/payments$/.exec(r))) {
    count('rzp.orders.payments')
    return send(res, 200, { entity: 'collection', count: (payments.get(decodeURIComponent(m[1])) ?? []).length, items: payments.get(decodeURIComponent(m[1])) ?? [] })
  }
  if ((m = /^\/payments\/([^/]+)\/capture$/.exec(r))) {
    count('rzp.payments.capture')
    return send(res, 200, { id: decodeURIComponent(m[1]), status: 'captured', amount: b.amount })
  }
  if ((m = /^\/payments\/([^/]+)\/refunds$/.exec(r))) {
    count('rzp.payments.refunds')
    return send(res, 200, { items: refunds.get(decodeURIComponent(m[1])) ?? [] })
  }
  if ((m = /^\/payments\/([^/]+)\/refund$/.exec(r))) {
    count('rzp.payments.refund')
    const rf = { id: id('rfnd'), status: 'processed', amount: b.amount ?? null }
    refunds.set(decodeURIComponent(m[1]), [...(refunds.get(decodeURIComponent(m[1])) ?? []), rf])
    return send(res, 200, rf)
  }
  if (r === '/payments') {
    count('rzp.payments.list')
    return send(res, 200, { entity: 'collection', count: 0, items: [] })
  }
  if (r === '/payment_links' && req.method === 'POST') {
    count('rzp.links.create')
    const l = id('plink')
    return send(res, 200, { id: l, short_url: `https://rzp.io/i/${l}` })
  }
  if ((m = /^\/payment_links\/([^/]+)$/.exec(r))) {
    count('rzp.links.get')
    return send(res, 200, { id: m[1], payments: [] })
  }
  count('rzp.unknown')
  return send(res, 404, { error: { description: `stub does not answer ${req.method} ${r}` } })
})

server.listen(PORT, '127.0.0.1', () => console.log(`provider stub on 127.0.0.1:${PORT}`))
