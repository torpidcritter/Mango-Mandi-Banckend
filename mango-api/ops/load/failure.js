// Failure conditions (LOAD-TEST.md, scenario E). MODE picks one:
//
//   pool         far more traffic than the pool has connections (start the API
//                with DB_POOL_MAX=2): requests must end in 200 or a quick
//                503 BUSY with Retry-After, never a hang or a 500.
//   gateway      Razorpay stops answering order creation (stub mode "hang"):
//                confirm must give up after its 10 s timeout with a 502, the
//                order is cancelled and its boxes released; browsing is not
//                slowed down; after RECOVER_AT the gateway answers again.
//   sms          the SMS gateway answers after 6 s (over sms.js's 5 s timeout):
//                login-code requests fail cleanly with 502 OTP_NOT_SENT.
//   maintenance  checkout at the 3x rate with many abandoned payments, holds
//                of one minute, and three "crons" calling /internal/maintenance
//                every 2 s: the sweep and reconcile run against live checkouts.
//
//   k6 run -e API=http://localhost:3142 -e MODE=pool ops/load/failure.js
import { check, sleep } from 'k6'
import http from 'k6/http'
import { Counter, Trend } from 'k6/metrics'
import { api, captured, get, ipFor, phoneFor, placeOrder, post, signIn, sleepish, staffSignIn, STUB, webhook, PIN } from './lib.js'

const MODE = __ENV.MODE || 'pool'
const CRON = __ENV.CRON_SECRET || 'load-test-cron-secret-0123456789'
const expected502 = new Counter('expected_502')
const busyRetryAfter = new Counter('busy_with_retry_after')
const busyMs = new Trend('busy_503_ms', true)

const arrival = (perSec, dur, vus, startTime = '0s') => ({ executor: 'constant-arrival-rate', rate: Math.round(perSec * 60), timeUnit: '1m', duration: dur, preAllocatedVUs: vus, maxVUs: vus * 3, startTime })

const SCENARIOS = {
  pool: {
    browse: { executor: 'constant-vus', exec: 'browseTight', vus: 150, duration: '2m' },
    checkout: { executor: 'constant-vus', exec: 'checkout', vus: 40, duration: '2m' },
  },
  gateway: {
    browse: { ...arrival(10, '3m', 20), exec: 'browse' },
    checkout: { ...arrival(2, '3m', 60), exec: 'checkout' },
    recover: { executor: 'per-vu-iterations', exec: 'recover', vus: 1, iterations: 1, startTime: __ENV.RECOVER_AT || '2m' },
  },
  sms: {
    browse: { ...arrival(10, '1m', 20), exec: 'browse' },
    otp: { ...arrival(2, '1m', 30), exec: 'otpOnly' },
  },
  maintenance: {
    browse: { ...arrival(10, '5m', 20), exec: 'browse' },
    checkout: { ...arrival(1.5, '5m', 40), exec: 'checkoutAbandoning' },
    cron: { executor: 'constant-vus', exec: 'cron', vus: 3, duration: '5m' },
  },
}

export const options = {
  setupTimeout: '2m',
  summaryTrendStats: ['med', 'p(95)', 'p(99)', 'max'],
  scenarios: SCENARIOS[MODE],
  thresholds: {
    server_errors: ['count==0'],
    // Nobody waits forever: the pool gives up after DB_CONNECT_TIMEOUT_MS (5 s).
    http_req_duration: ['max<15000'],
    ...(MODE === 'gateway' ? { 'http_req_duration{name:catalogue}': ['p(95)<300'] } : {}),
  },
}

export function setup() {
  if (MODE === 'gateway') http.post(`${STUB}/ctl/mode`, JSON.stringify({ orders: 'hang' }), { headers: { 'Content-Type': 'application/json' } })
  if (MODE === 'sms') http.post(`${STUB}/ctl/mode`, JSON.stringify({ sms: 'slow', delayMs: 6000 }), { headers: { 'Content-Type': 'application/json' } })
  if (MODE === 'maintenance') {
    const m = staffSignIn('manager@mandimangoes.test', 'manager123', '10.250.3.1')
    const cfg = get('/admin/v1/config', { ip: '10.250.3.1', token: m, name: 'staff_config' }).json('rules')
    const r = http.put(`${api()}/admin/v1/config`, JSON.stringify({ rules: { ...cfg, holdMinutes: 1, quoteMinutes: 1 } }), {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${m}`, 'X-Forwarded-For': '10.250.3.1' },
    })
    if (r.status !== 200) throw new Error(`config: ${r.status} ${r.body}`)
  }
  return {}
}

export function teardown() {
  http.post(`${STUB}/ctl/mode`, JSON.stringify({ orders: 'ok', sms: 'ok', delayMs: 0 }), { headers: { 'Content-Type': 'application/json' } })
}

function busyCheck(r) {
  if (r.status === 503) {
    busyMs.add(r.timings.duration)
    if (r.headers['Retry-After'] && r.json('error.code') === 'BUSY') busyRetryAfter.add(1)
  }
  return r
}

export function browse() {
  const ip = ipFor(__VU, __ITER)
  busyCheck(get(`/v1/delivery/check?pincode=${PIN}`, { ip, name: 'delivery_check' }))
  busyCheck(get(`/v1/catalogue?pincode=${PIN}`, { ip, name: 'catalogue' }))
  busyCheck(get(`/v1/delivery/slots?pincode=${PIN}`, { ip, name: 'slots' }))
}

export function browseTight() {
  const ip = ipFor(__VU, __ITER)
  const r = busyCheck(get(`/v1/catalogue?pincode=${PIN}`, { ip, name: 'catalogue' }))
  check(r, { '200 or 503 BUSY': (x) => x.status === 200 || x.status === 503 })
  // A browser told to retry after 2 s does so.
  if (r.status === 503) sleep(2)
}

function payOrRecord(r) {
  if (r.status === 502) expected502.add(1)
  if (r.status !== 201) return
  sleep(sleepish(0.5, 2))
  webhook(captured(r.order, `pay_${r.order.orderId.slice(-12)}`), { eventId: `evt_${r.order.orderId}` })
}

export function checkout() {
  const ip = ipFor(__VU + 40000, __ITER)
  const token = signIn(phoneFor(__VU, __ITER, 21 + MODE.length), ip)
  if (!token) return
  const r = placeOrder(token, ip)
  check(r, { 'placed, sold out, busy or gateway error': (x) => [201, 409, 503, 502].includes(x.status) })
  payOrRecord(r)
}

export function checkoutAbandoning() {
  const ip = ipFor(__VU + 45000, __ITER)
  const token = signIn(phoneFor(__VU, __ITER, 41), ip)
  if (!token) return
  const r = placeOrder(token, ip)
  if (r.status !== 201) return
  const roll = Math.random()
  if (roll < 0.5) return payOrRecord(r) // pays at once
  if (roll < 0.7) {
    // Pays after the one-minute hold has lapsed: a late payment.
    sleep(sleepish(60, 90))
    webhook(captured(r.order, `pay_l_${r.order.orderId.slice(-12)}`), { eventId: `evt_l_${r.order.orderId}` })
  }
  // else walks away: the sweep must release the boxes.
}

export function otpOnly() {
  const ip = ipFor(__VU + 50000, __ITER)
  const r = post('/v1/auth/otp/request', { phone: phoneFor(__VU, __ITER, 31), captchaToken: 'load-test' }, { ip, name: 'otp_request' })
  if (r.status === 502 && r.json('error.code') === 'OTP_NOT_SENT') expected502.add(1)
  check(r, { 'sent, or a clean 502 OTP_NOT_SENT': (x) => x.status === 200 || (x.status === 502 && x.json('error.code') === 'OTP_NOT_SENT') })
}

export function recover() {
  http.post(`${STUB}/ctl/mode`, JSON.stringify({ orders: 'ok' }), { headers: { 'Content-Type': 'application/json' } })
  console.log('gateway answering again')
}

export function cron() {
  const r = http.get(`${api()}/internal/maintenance`, { headers: { Authorization: `Bearer ${CRON}` }, tags: { name: 'maintenance' }, timeout: '120s' })
  if (r.status >= 500) console.error(`maintenance ${r.status} ${r.body}`)
  check(r, { 'maintenance 200': (x) => x.status === 200 })
  sleep(2)
}
