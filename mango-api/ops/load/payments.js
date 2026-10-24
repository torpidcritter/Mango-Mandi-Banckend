// Payment storms (LOAD-TEST.md, scenario C).
//
//   storm    Razorpay redelivering payment.captured: each order's event sent
//            10 times at once (same event id), 3 more times without an id,
//            a stale payment.failed after it, and on every 10th order a
//            second, different payment (a double payment: refunded, never a
//            second confirmation). Then random redeliveries for 3 minutes.
//   delayed  orders whose webhook never comes: the payment is marked captured
//            at the (stubbed) gateway and the maintenance run (Vercel Cron's
//            /internal/maintenance, called by three "crons" at once) must find
//            it; their webhooks then arrive late.
//
//   k6 run -e API=http://localhost:3141 -e ORDERS=200 -e CRON_SECRET=... ops/load/payments.js
//
// Local only: it needs the provider stub for login codes and gateway state.
import { check, sleep } from 'k6'
import http from 'k6/http'
import crypto from 'k6/crypto'
import exec from 'k6/execution'
import { api, captured, failed, ipFor, note, phoneFor, placeOrder, signIn, STUB, WEBHOOK_SECRET } from './lib.js'

const N = Number(__ENV.ORDERS || 200)
const DELAYED = Math.round(N * 0.25)
const CRON = __ENV.CRON_SECRET || 'load-test-cron-secret-0123456789'

export const options = {
  setupTimeout: '10m',
  summaryTrendStats: ['med', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    storm: { executor: 'shared-iterations', exec: 'storm', vus: 50, iterations: N - DELAYED, maxDuration: '2m' },
    redeliver: { executor: 'constant-arrival-rate', exec: 'redeliver', rate: 50, timeUnit: '1s', duration: '3m', preAllocatedVUs: 50, maxVUs: 200 },
    cron: { executor: 'constant-vus', exec: 'cron', vus: 3, duration: '90s', startTime: '125s' },
    late: { executor: 'shared-iterations', exec: 'late', vus: 20, iterations: DELAYED, startTime: '220s', maxDuration: '1m' },
  },
  thresholds: { server_errors: ['count==0'], 'http_req_duration{name:webhook}': ['p(95)<800'] },
}

function signed(event, eventId) {
  const raw = JSON.stringify(event)
  return {
    method: 'POST', url: `${api()}/webhooks/razorpay`, body: raw,
    params: {
      headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': crypto.hmac('sha256', WEBHOOK_SECRET, raw, 'hex'), ...(eventId ? { 'X-Razorpay-Event-Id': eventId } : {}) },
      tags: { name: 'webhook' },
    },
  }
}

export function setup() {
  const orders = []
  for (let i = 1; orders.length < N && i <= N * 2; i++) {
    const ip = ipFor(i + 30000)
    const token = signIn(phoneFor(i, 0, 11), ip)
    const r = token ? placeOrder(token, ip) : { status: 0 }
    if (r.status === 201) orders.push(r.order)
  }
  // The delayed ones: paid at the gateway, but their webhook is lost.
  for (const o of orders.slice(N - DELAYED)) {
    http.post(`${STUB}/ctl/pay`, JSON.stringify({ order: o.razorpayOrderId, amount: o.total, id: `pay_late_${o.orderId.slice(-10)}`, status: 'captured' }), { headers: { 'Content-Type': 'application/json' }, tags: { name: 'stub' } })
  }
  console.log(`payments: ${orders.length} orders placed, ${DELAYED} with a lost webhook`)
  return { orders }
}

const payId = (o) => `pay_${o.orderId.slice(-12)}`

export function storm(data) {
  const i = exec.scenario.iterationInTest % (N - DELAYED)
  const o = data.orders[i]
  const reqs = []
  for (let k = 0; k < 10; k++) reqs.push(signed(captured(o, payId(o)), `evt_${o.orderId}`))
  for (let k = 0; k < 3; k++) reqs.push(signed(captured(o, payId(o))))
  if (i % 10 === 0) reqs.push(signed(captured(o, `${payId(o)}_2nd`), `evt_2nd_${o.orderId}`))
  const res = http.batch(reqs)
  for (const r of res) note(r, 'webhook')
  check(res, { 'every delivery answered 200': (rs) => rs.every((r) => r.status === 200) })
  sleep(0.2)
  note(http.batch([signed(failed(o, `${payId(o)}_f`), `evt_f_${o.orderId}`)])[0], 'webhook')
}

export function redeliver(data) {
  const o = data.orders[Math.floor(Math.random() * (N - DELAYED))]
  if (!o) return
  const r = note(http.batch([signed(captured(o, payId(o)), `evt_${o.orderId}`)])[0], 'webhook')
  check(r, { 'redelivery 200': (x) => x.status === 200 })
}

export function cron() {
  const r = note(http.get(`${api()}/internal/maintenance`, { headers: { Authorization: `Bearer ${CRON}` }, tags: { name: 'maintenance' }, timeout: '120s' }), 'maintenance')
  check(r, { 'maintenance ran or skipped': (x) => x.status === 200 })
  sleep(5)
}

export function late(data) {
  const o = data.orders[N - DELAYED + exec.scenario.iterationInTest]
  if (!o) return
  const r = note(http.batch([signed(captured(o, `pay_late_${o.orderId.slice(-10)}`), `evt_late_${o.orderId}`)])[0], 'webhook')
  check(r, { 'late webhook 200': (x) => x.status === 200 })
}
