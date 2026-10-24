// A delivery day in the panel (LOAD-TEST.md, scenario D), on the orders a
// shop run (shop.js) left behind.
//
//   pack      six packers work down the confirmed orders: allocate, then
//             PROCESSING, then PACKED. Every fifth order is also grabbed by
//             the next packer, as happens on a shared screen: one wins, the
//             other gets a 409/400, never a 500.
//   lists     the panel's Today, Orders, Pack list, Manifest, Needs attention
//   dispatch  two managers press "Start run" for the day at the same time
//   deliver   riders report every order: photo delivery (60%), not home
//             (25%), or a manager marks it delivered without proof (15%)
//
//   k6 run -e API=http://localhost:3141 -e DATE=2026-10-25 ops/load/ops.js
/* global open */ // k6's file reader, init context only
import { check, sleep } from 'k6'
import http from 'k6/http'
import exec from 'k6/execution'
import { Counter } from 'k6/metrics'
import { api, get, ipFor, note, post, staffSignIn } from './lib.js'

const DATE = __ENV.DATE
const PACKERS = 6
const raced = new Counter('pack_race_lost')

export const options = {
  setupTimeout: '5m',
  summaryTrendStats: ['med', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    pack: { executor: 'shared-iterations', exec: 'pack', vus: PACKERS, iterations: Number(__ENV.MAX_ORDERS || 2000), maxDuration: '6m' },
    lists: { executor: 'constant-arrival-rate', exec: 'lists', rate: 5, timeUnit: '1s', duration: __ENV.LISTS_FOR || '4m', preAllocatedVUs: 10, maxVUs: 40 },
    dispatch: { executor: 'per-vu-iterations', exec: 'dispatch', vus: 2, iterations: 1, startTime: __ENV.DISPATCH_AT || '1m', maxDuration: '3m' },
    deliver: { executor: 'shared-iterations', exec: 'deliver', vus: 8, iterations: Number(__ENV.MAX_ORDERS || 2000), startTime: __ENV.DELIVER_AT || '2m', maxDuration: '4m' },
  },
  thresholds: {
    server_errors: ['count==0'],
    'http_req_duration{name:staff_status}': ['p(95)<800'],
    'http_req_duration{name:staff_allocate}': ['p(95)<800'],
    'http_req_duration{name:staff_orders}': ['p(95)<800'],
    'http_req_duration{name:staff_delivery}': ['p(95)<800'],
  },
}

function allConfirmed(t) {
  const out = []
  for (let page = 1; page < 100; page++) {
    const r = get(`/admin/v1/orders?status=CONFIRMED&page=${page}`, { ip: '10.250.2.1', token: t, name: 'staff_orders' }).json()
    const rows = r.items ?? []
    if (!rows.length) break
    out.push(...rows.filter((o) => !DATE || o.deliveryDate === DATE).map((o) => o.id))
    if (page * r.pageSize >= r.total) break
  }
  return out
}

export function setup() {
  const ops = staffSignIn('ops@mandimangoes.test', 'operator123', '10.250.2.1')
  const manager = staffSignIn('manager@mandimangoes.test', 'manager123', '10.250.2.2')
  const ids = allConfirmed(ops)
  const date = DATE || get('/admin/v1/manifest', { ip: '10.250.2.1', token: ops, name: 'staff_manifest' }).json('date')
  console.log(`ops: ${ids.length} confirmed orders; run date ${date}`)
  return { ops, manager, ids, date }
}

const ip = () => ipFor(9100 + (__VU % 8))

function packOne(t, id) {
  const a = post(`/admin/v1/orders/${id}/allocate`, null, { ip: ip(), token: t, name: 'staff_allocate' })
  if (a.status !== 204) return a.status
  for (const status of ['PROCESSING', 'PACKED']) {
    const s = http.patch(`${api()}/admin/v1/orders/${id}/status`, JSON.stringify({ status }), {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'X-Forwarded-For': ip() }, tags: { name: 'staff_status' },
    })
    note(s, 'staff_status')
    if (s.status !== 204) return s.status
  }
  return 204
}

export function pack(data) {
  const i = exec.scenario.iterationInTest
  if (i >= data.ids.length) return
  const s = packOne(data.ops, data.ids[i])
  check(s, { 'packed or lost a race (4xx)': (x) => x === 204 || (x >= 400 && x < 500) })
  if (i % 5 === 0 && i + 1 < data.ids.length) {
    // The next packer's order, grabbed at the same moment.
    const r = packOne(data.ops, data.ids[i + 1])
    if (r !== 204) raced.add(1)
  }
}

export function lists(data) {
  const t = data.ops
  const pages = [
    `/admin/v1/summary`, `/admin/v1/orders?page=1`, `/admin/v1/orders?status=PACKED`, `/admin/v1/pack-list?date=${data.date}`,
    `/admin/v1/manifest?date=${data.date}`, `/admin/v1/attention`,
  ]
  const r = get(pages[__ITER % pages.length], { ip: ip(), token: t, name: ['staff_today', 'staff_orders', 'staff_orders', 'staff_pack_list', 'staff_manifest', 'staff_attention'][__ITER % pages.length] })
  check(r, { 'panel page 200': (x) => x.status === 200 })
}

export function dispatch(data) {
  const r = post('/admin/v1/manifest/dispatch', { date: data.date }, { ip: ip(), token: data.manager, name: 'staff_dispatch', timeout: '170s' })
  check(r, { 'run started': (x) => x.status === 200 })
  if (r.status === 200) console.log(`dispatch VU ${__VU}: ${r.json('dispatched').length} dispatched, ${r.json('skipped').length} skipped`)
}

// A real 1024x768 JPEG of 130 KB, like a phone photo after the app shrinks it:
// the API decodes and re-encodes it (SEC-13), which is the expensive part.
const PHOTO = open('./photo.jpg', 'b')

let manifest = null
export function deliver(data) {
  if (!manifest) {
    const m = get(`/admin/v1/manifest?date=${data.date}`, { ip: ip(), token: data.ops, name: 'staff_manifest' }).json()
    manifest = (m.runs ?? []).flatMap((run) => (run.stops ?? []).flatMap((s) => s.orders ?? []))
      .filter((o) => ['OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED'].includes(o.status)).sort((a, b) => (a.id < b.id ? -1 : 1))
  }
  const o = manifest[exec.scenario.iterationInTest]
  if (!o) return
  const roll = Math.random()
  let r
  if (roll < 0.6) {
    const p = note(http.post(`${api()}/admin/v1/orders/${o.id}/delivery-photos`, PHOTO, {
      headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${data.ops}`, 'X-Forwarded-For': ip() }, tags: { name: 'staff_photo' },
    }), 'staff_photo')
    if (p.status !== 201) return
    r = post(`/admin/v1/orders/${o.id}/delivery`, { outcome: 'DELIVERED', photoId: p.json('id'), attempt: o.attempt, receivedBy: 'Customer' }, { ip: ip(), token: data.ops, name: 'staff_delivery' })
  } else if (roll < 0.85) {
    r = post(`/admin/v1/orders/${o.id}/delivery`, { outcome: 'FAILED', reason: 'NOT_HOME', attempt: o.attempt }, { ip: ip(), token: data.ops, name: 'staff_delivery' })
  } else {
    r = note(http.patch(`${api()}/admin/v1/orders/${o.id}/status`, JSON.stringify({ status: 'DELIVERED', override: true, reason: 'Handed over, rider phone died' }), {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.manager}`, 'X-Forwarded-For': ip() }, tags: { name: 'staff_status' },
    }), 'staff_status')
  }
  check(r, { 'delivery recorded or already done': (x) => x.status < 300 || x.status === 409 })
  sleep(0.2)
}
