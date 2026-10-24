// Peak-evening load on the shop and the panel (LOAD-TEST.md, scenario A).
//
//   browse    customers checking a pincode, the catalogue and delivery days
//   checkout  sign in, add a box, quote, confirm, then pay (Razorpay's
//             payment.captured webhook, signed); a few pay late or never
//   staff     the panel's Today, Orders, Pack list and Needs attention
//
// Rates are per second at 1x of the planned peak (the 10x WhatsApp-broadcast
// spike on a 500-order day); X multiplies them (X=3 is the test target).
//
//   k6 run -e API=http://localhost:3141 -e X=3 ops/load/shop.js
//
// Checkout needs login codes: locally they come from stub-providers.js. On
// staging run with CHECKOUT=0 (browse and staff only), or with a stubbed SMS
// gateway on a staging-only deploy; never against production.
import { check, sleep } from 'k6'
import { captured, failed, get, ipFor, phoneFor, placeOrder, signIn, sleepish, staffSignIn, webhook, PIN } from './lib.js'

const X = Number(__ENV.X || 1)
const HOLD = __ENV.HOLD || '8m'
const CHECKOUT = __ENV.CHECKOUT !== '0'
// 1x: 10 browse requests/s (3 per iteration), 0.5 checkouts/s, 1.7 staff requests/s.
const rate = (perSec) => Math.max(1, Math.round(perSec * X * 60))

const ramp = (perMin, vus) => ({
  executor: 'ramping-arrival-rate', startRate: 0, timeUnit: '1m', preAllocatedVUs: vus, maxVUs: vus * 4,
  stages: [{ duration: '1m', target: perMin }, { duration: HOLD, target: perMin }, { duration: '30s', target: 0 }],
})

export const options = {
  scenarios: {
    browse: { ...ramp(rate(10 / 3), 20 * X), exec: 'browse' },
    ...(CHECKOUT ? { checkout: { ...ramp(rate(0.5), 20 * X), exec: 'checkout' } } : {}),
    ...(__ENV.STAFF !== '0' ? { staff: { ...ramp(rate(1.7), 5 * X), exec: 'staff' } } : {}),
  },
  summaryTrendStats: ['med', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    'http_req_duration{name:delivery_check}': ['p(95)<300'],
    'http_req_duration{name:slots}': ['p(95)<300'],
    'http_req_duration{name:catalogue}': ['p(95)<300'],
    'http_req_duration{name:quote}': ['p(95)<800'],
    'http_req_duration{name:confirm}': ['p(95)<800'],
    'http_req_duration{name:webhook}': ['p(95)<800'],
    http_req_failed: ['rate<0.005'],
    server_errors: ['count==0'],
  },
}

export function setup() {
  if (__ENV.STAFF === '0') return {}
  return { staff: staffSignIn(__ENV.STAFF_EMAIL || 'ops@mandimangoes.test', __ENV.STAFF_PASSWORD || 'operator123') }
}

export function browse() {
  const ip = ipFor(__VU, __ITER)
  const d = get(`/v1/delivery/check?pincode=${PIN}`, { ip, name: 'delivery_check' })
  check(d, { 'delivery check ok': (r) => r.status === 200 })
  const c = get(`/v1/catalogue?pincode=${PIN}`, { ip, name: 'catalogue' })
  check(c, { 'catalogue ok': (r) => r.status === 200 })
  const s = get(`/v1/delivery/slots?pincode=${PIN}`, { ip, name: 'slots' })
  check(s, { 'slots ok': (r) => r.status === 200 })
}

export function checkout() {
  const ip = ipFor(__VU + 5000, __ITER)
  const token = signIn(phoneFor(__VU, __ITER, 1), ip)
  if (!check(token, { 'signed in': (t) => Boolean(t) })) return
  const r = placeOrder(token, ip)
  check(r, { 'order placed or sold out': (x) => x.status === 201 || x.status === 409 })
  if (r.status !== 201) return
  sleep(sleepish(1, 4)) // paying in Razorpay Checkout
  const roll = Math.random()
  const pay = `pay_${r.order.orderId.slice(-12)}${__ITER}`
  if (roll < 0.9) {
    const w = webhook(captured(r.order, pay), { eventId: `evt_${pay}` })
    check(w, { 'payment accepted': (x) => x.status === 200 })
  } else if (roll < 0.95) {
    // A failed attempt; the hold lapses later and the sweep releases the boxes.
    webhook(failed(r.order, pay), { eventId: `evt_f_${pay}` })
  }
  // else: walked away; the hold expires.
}

export function staff(data) {
  const ip = ipFor(9000 + (__VU % 5))
  const t = data.staff
  const page = [
    () => get('/admin/v1/summary', { ip, token: t, name: 'staff_today' }),
    () => get('/admin/v1/orders?status=CONFIRMED', { ip, token: t, name: 'staff_orders' }),
    () => get('/admin/v1/orders', { ip, token: t, name: 'staff_orders' }),
    () => get('/admin/v1/pack-list', { ip, token: t, name: 'staff_pack_list' }),
    () => get('/admin/v1/attention', { ip, token: t, name: 'staff_attention' }),
  ][__ITER % 5]()
  check(page, { 'staff page ok': (r) => r.status === 200 })
}

export function handleSummary(data) {
  const out = __ENV.SUMMARY || 'summary-shop.json'
  return { [out]: JSON.stringify(data, null, 2), stdout: textSummary(data) }
}

function textSummary(data) {
  const lines = []
  for (const [k, v] of Object.entries(data.metrics)) {
    if (v.type === 'trend' && k.startsWith('http_req_duration')) lines.push(`${k} p50=${v.values.med?.toFixed(1)} p95=${v.values['p(95)']?.toFixed(1)} p99=${v.values['p(99)']?.toFixed(1)} max=${v.values.max?.toFixed(1)}`)
    else if (v.type === 'counter') lines.push(`${k} ${v.values.count}`)
    else if (v.type === 'rate') lines.push(`${k} ${(v.values.rate * 100).toFixed(3)}%`)
    if (v.thresholds) for (const [t, r] of Object.entries(v.thresholds)) lines.push(`  ${r.ok ? 'PASS' : 'FAIL'} ${t}`)
  }
  return `${lines.join('\n')}\n`
}


