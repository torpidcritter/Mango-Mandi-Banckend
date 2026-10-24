// Shared helpers for the k6 scripts in this folder (see LOAD-TEST.md).
//
// Environment:
//   API      one or more API base URLs, comma-separated (each VU sticks to one,
//            as a browser sticks to the instance it reached)
//   STUB     provider stub (stub-providers.js), for login codes and payments.
//            Login codes are read back from it, so checkout needs it: on staging,
//            a copy reachable from the staging deployment (LOAD-TEST.md).
//   WEBHOOK_SECRET  the RAZORPAY_WEBHOOK_SECRET the API was started with
//   PINCODE  a serviceable pincode (560034)
import http from 'k6/http'
import crypto from 'k6/crypto'
import { Counter } from 'k6/metrics'

export const APIS = (__ENV.API || 'http://localhost:3141').split(',').map((s) => s.trim())
export const STUB = __ENV.STUB || 'http://127.0.0.1:3145'
export const PIN = __ENV.PINCODE || '560034'
export const WEBHOOK_SECRET = __ENV.WEBHOOK_SECRET || 'whsec_load_test_only'
export const RUN = __ENV.RUN_ID || String(Date.now()).slice(-6)

// A 409 (sold out, slot full, someone else just moved the order) is an answer, not a failure.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 409))

export const api = () => APIS[(__VU || 0) % APIS.length]

/** Counted by status class so the summary shows 4xx/5xx by kind. */
export const serverErrors = new Counter('server_errors') // 500, 502, 504: never expected
export const busy = new Counter('busy_503') // 503 BUSY: expected under pressure, must carry Retry-After
export const conflicts = new Counter('conflicts_409')
export const rateLimited = new Counter('rate_limited_429')
export const ordersConfirmed = new Counter('orders_created')
export const soldOut = new Counter('sold_out')

/** A distinct client address per VU (and per iteration when asked), as Vercel's edge would forward it. */
export function ipFor(vu, iter = 0) {
  const n = vu * 1000 + (iter % 1000)
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`
}

export const gateway502 = new Counter('gateway_502') // a provider failed and the API said so cleanly

const PROVIDER_CODES = ['PAYMENT_GATEWAY_ERROR', 'OTP_NOT_SENT']
const errorCode = (r) => {
  try {
    return r.json('error.code')
  } catch {
    return null
  }
}

export function note(r, name) {
  if (r.status === 503) busy.add(1, { name })
  else if (r.status === 502 && PROVIDER_CODES.includes(errorCode(r))) gateway502.add(1, { name })
  else if (r.status >= 500 || r.status === 0) serverErrors.add(1, { name, status: String(r.status) })
  else if (r.status === 409) conflicts.add(1, { name })
  else if (r.status === 429) rateLimited.add(1, { name })
  return r
}

export function headers(ip, token, extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-Forwarded-For': ip,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  }
}

export function get(path, { ip, token, name, base } = {}) {
  return note(http.get(`${base ?? api()}${path}`, { headers: headers(ip, token), tags: { name: name ?? path } }), name ?? path)
}

export function post(path, body, { ip, token, name, extra, base, timeout } = {}) {
  return note(
    http.post(`${base ?? api()}${path}`, body == null ? null : JSON.stringify(body), {
      headers: headers(ip, token, extra), tags: { name: name ?? path }, ...(timeout ? { timeout } : {}),
    }),
    name ?? path,
  )
}

/** A unique valid Indian mobile number for this run, VU and iteration. */
export function phoneFor(vu, iter, salt = 0) {
  const n = (Number(RUN) * 7919 + salt * 1_000_003 + vu * 10_007 + iter) % 1_000_000_000
  return `9${String(n).padStart(9, '0')}`
}

/** Signs a customer in the way the shop does (code by SMS, read back from the stub). */
export function signIn(phone, ip) {
  // The shop sends a Turnstile token; locally the stub passes any token.
  const req = post('/v1/auth/otp/request', { phone, captchaToken: __ENV.CAPTCHA_TOKEN || 'load-test' }, { ip, name: 'otp_request' })
  if (req.status !== 200) return null
  const code = http.get(`${STUB}/ctl/otp?phone=%2B91${phone}`, { tags: { name: 'stub' } })
  if (code.status !== 200) return null
  const v = post('/v1/auth/otp/verify', { phone, code: code.json('code') }, { ip, name: 'otp_verify' })
  return v.status === 200 ? v.json('accessToken') : null
}

export function staffSignIn(email, password, ip = '10.250.0.1') {
  const r = post('/admin/v1/auth/login', { email, password }, { ip, name: 'staff_login' })
  if (r.status !== 200 || !r.json('accessToken')) throw new Error(`staff login failed for ${email}: ${r.status} ${r.body}`)
  return r.json('accessToken')
}

/** A Razorpay-style webhook, signed with the API's webhook secret. */
export function webhook(event, { eventId, base, name = 'webhook' } = {}) {
  const raw = JSON.stringify(event)
  const sig = crypto.hmac('sha256', WEBHOOK_SECRET, raw, 'hex')
  return note(
    http.post(`${base ?? api()}/webhooks/razorpay`, raw, {
      headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig, ...(eventId ? { 'X-Razorpay-Event-Id': eventId } : {}) },
      tags: { name },
    }),
    name,
  )
}

export const captured = (order, payId) => ({
  event: 'payment.captured',
  payload: { payment: { entity: { id: payId, order_id: order.razorpayOrderId, amount: order.total, currency: 'INR', status: 'captured', method: 'upi' } } },
})
export const failed = (order, payId) => ({
  event: 'payment.failed',
  payload: { payment: { entity: { id: payId, order_id: order.razorpayOrderId, amount: order.total, currency: 'INR', status: 'failed', method: 'upi' } } },
})

/** Catalogue, cart, slots, quote, confirm. Returns { status, order } (order on 201). */
export function placeOrder(token, ip, pick) {
  const cat = get(`/v1/catalogue?pincode=${PIN}`, { ip, name: 'catalogue' })
  if (cat.status !== 200) return { status: cat.status }
  const items = (cat.json('items') || []).filter((i) => i.qty > 0 && (!pick || pick(i)))
  if (!items.length) {
    soldOut.add(1)
    return { status: 409 }
  }
  const item = items[Math.floor(Math.random() * items.length)]
  const add = post('/v1/cart/items', { sku: item.sku, stage: item.stage, qty: 1 }, { ip, token, name: 'cart_add' })
  if (add.status !== 204) return { status: add.status }
  const slots = get(`/v1/delivery/slots?pincode=${PIN}`, { ip, name: 'slots' })
  const list = slots.status === 200 ? slots.json('slots') || [] : []
  const slot = list.find((s) => s.available) ?? list[0]
  const q = post('/v1/checkout/quote', { pincode: PIN, slotId: slot?.id ?? null }, { ip, token, name: 'quote' })
  if (q.status !== 200) {
    if (q.status === 409) soldOut.add(1)
    return { status: q.status }
  }
  const c = post(
    '/v1/checkout/confirm',
    { quoteId: q.json('quoteId'), address: '12, 4th Cross, Koramangala, Bengaluru' },
    { ip, token, name: 'confirm', extra: { 'Idempotency-Key': `k6-${RUN}-${Math.random().toString(36).slice(2)}` }, timeout: '30s' },
  )
  if (c.status === 201) {
    ordersConfirmed.add(1)
    return { status: 201, order: c.json() }
  }
  if (c.status === 409) soldOut.add(1)
  return { status: c.status }
}

export const sleepish = (min, max) => min + Math.random() * (max - min)
