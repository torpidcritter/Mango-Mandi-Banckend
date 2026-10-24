// Gives a load-test database enough stock and slot room for a peak-day run,
// through the staff API (as a manager would), so the ledger has every row.
//
//   API=http://localhost:3141 STAFF_EMAIL=manager@mandimangoes.test STAFF_PASSWORD=manager123 \
//     BOXES=1500 node ops/load/prepare.js
//
// Adds one Alphonso and one Badami batch (BOXES boxes split over the SKUs),
// moves them to SELLING and sets every slot's limit to SLOT_BOXES. Prints
// the stock the shop offers afterwards.
const API = process.env.API || 'http://localhost:3141'
const BOXES = Number(process.env.BOXES || 1500)
const SLOT_BOXES = process.env.SLOT_BOXES === 'none' ? null : Number(process.env.SLOT_BOXES || 2000)
const H = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.250.0.9' }

async function call(method, path, body, token) {
  const res = await fetch(`${API}${path}`, { method, headers: { ...H, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

const { accessToken: t } = await call('POST', '/admin/v1/auth/login', {
  email: process.env.STAFF_EMAIL || 'manager@mandimangoes.test', password: process.env.STAFF_PASSWORD || 'manager123',
})
const ist = new Date(Date.now() + 330 * 60_000)
const daysAgo = (n) => new Date(ist.getTime() - n * 86_400_000).toISOString().slice(0, 10)
const share = (f) => Math.round(BOXES * f)
for (const [variety, age, lines] of [
  ['Alphonso', 3, [['ALP-3', share(0.35)], ['ALP-5', share(0.2)]]],
  ['Badami', 3, [['BAD-3', share(0.3)], ['BAD-5', share(0.15)]]],
]) {
  const b = await call('POST', '/admin/v1/batches', { variety, pluckedOn: daysAgo(age), farm: 'Load test', lines: lines.map(([sku, onHand]) => ({ sku, onHand })) }, t)
  await call('PATCH', `/admin/v1/batches/${b.id}/status`, { status: 'ARRIVED' }, t)
  // New sales need an intake QC reading first.
  await call('POST', `/admin/v1/batches/${b.id}/qc`, { ripenessRating: 'RAW', condition: 'GOOD', notes: 'Load test intake' }, t)
  await call('PATCH', `/admin/v1/batches/${b.id}/status`, { status: 'SELLING' }, t)
  console.log(`batch ${b.id} ${variety}: ${lines.map(([s, n]) => `${s}=${n}`).join(' ')}`)
}
for (const s of await call('GET', '/admin/v1/slots', null, t)) {
  await call('PATCH', `/admin/v1/slots/${s.id}`, { maxBoxes: SLOT_BOXES }, t)
}
const cat = await call('GET', '/v1/catalogue?pincode=560034')
console.log(`delivery date ${cat.deliveryDate}; on offer: ${cat.items.filter((i) => i.qty).map((i) => `${i.sku}/${i.stage}=${i.qty}`).join(' ')}`)
