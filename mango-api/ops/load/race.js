// Many customers racing for the last boxes (LOAD-TEST.md, scenario B).
//
// setup() signs in CUSTOMERS customers; then all of them, at the same moment,
// put SKU/STAGE in the cart, quote and confirm, and the winners pay. Exactly
// as many orders as there were boxes may succeed; everyone else gets a 409.
//
//   k6 run -e API=http://localhost:3141 -e SKU=BAD-5 -e STAGE=RIPE -e CUSTOMERS=300 ops/load/race.js
//
// MODE=slot races for a slot's last places instead (any SKU with stock).
import { check, sleep } from 'k6'
import { Counter } from 'k6/metrics'
import { captured, get, ipFor, phoneFor, post, signIn, webhook, PIN } from './lib.js'

const N = Number(__ENV.CUSTOMERS || 300)
const SKU = __ENV.SKU || 'BAD-5'
const STAGE = __ENV.STAGE || 'RIPE'
const SLOT_MODE = __ENV.MODE === 'slot'
const won = new Counter('race_won')
const lost = new Counter('race_lost')

export const options = {
  setupTimeout: '10m',
  summaryTrendStats: ['med', 'p(95)', 'p(99)', 'max'],
  scenarios: { race: { executor: 'per-vu-iterations', vus: N, iterations: 1, maxDuration: '3m' } },
  thresholds: { server_errors: ['count==0'], 'http_req_duration{name:confirm}': ['p(95)<800'] },
}

export function setup() {
  const tokens = []
  for (let i = 1; i <= N; i++) tokens.push(signIn(phoneFor(i, 0, 7), ipFor(i + 20000)))
  const cat = get(`/v1/catalogue?pincode=${PIN}`, { ip: '10.250.1.1', name: 'catalogue' }).json()
  const slots = get(`/v1/delivery/slots?pincode=${PIN}`, { ip: '10.250.1.1', name: 'slots' }).json('slots')
  const left = (cat.items.find((i) => i.sku === SKU && i.stage === STAGE) || {}).qty
  console.log(`race: ${tokens.filter(Boolean).length} customers signed in; ${SKU}/${STAGE} has ${left} boxes; slots ${JSON.stringify(slots.map((s) => [s.label, s.remainingBoxes]))}`)
  return { tokens, slot: slots[0].id, items: cat.items.filter((i) => i.qty > 0) }
}

export default function (data) {
  const token = data.tokens[__VU - 1]
  if (!token) return
  const ip = ipFor(__VU + 20000)
  const item = SLOT_MODE ? data.items[__VU % data.items.length] : { sku: SKU, stage: STAGE }
  post('/v1/cart/items', { sku: item.sku, stage: item.stage, qty: 1 }, { ip, token, name: 'cart_add' })
  const q = post('/v1/checkout/quote', { pincode: PIN, slotId: data.slot }, { ip, token, name: 'quote' })
  if (q.status !== 200) {
    check(q, { 'refused with 409': (r) => r.status === 409 })
    lost.add(1, { at: 'quote', code: String(q.json('error.code')) })
    return
  }
  const c = post('/v1/checkout/confirm', { quoteId: q.json('quoteId'), address: '12, 4th Cross, Koramangala, Bengaluru' }, {
    ip, token, name: 'confirm', extra: { 'Idempotency-Key': `race-${__VU}` },
  })
  if (c.status !== 201) {
    check(c, { 'refused with 409': (r) => r.status === 409 })
    lost.add(1, { at: 'confirm', code: String(c.json('error.code')) })
    return
  }
  won.add(1)
  sleep(Math.random())
  const o = c.json()
  check(webhook(captured(o, `pay_race_${__VU}_${o.orderId.slice(-8)}`), { eventId: `evt_race_${o.orderId}` }), { 'paid': (r) => r.status === 200 })
}
