import { expect, test } from './fixtures'
import { seed } from './mock-api'

// TST-3: the panel's mock (tests/mock-api.ts) must not drift from the real API.
// For every read the mock answers, this calls the real mango-api and checks
// that the real response has every field the mock's has, with the same JSON
// type (null on either side counts as "may be null"). Extra fields on the
// server are fine; a field the mock invents, renames or retypes fails here, so
// a mock-only UI test cannot pass against a shape the server does not send.
//
// Needs a seeded API like day-in-the-life (E2E_EMAIL / E2E_PASSWORD, VITE_API_URL);
// CI runs it in the e2e job.

const email = process.env.E2E_EMAIL
const password = process.env.E2E_PASSWORD
const API = (process.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '')

test.skip(!email || !password, 'Set E2E_EMAIL and E2E_PASSWORD and run mango-api to enable')

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
const kind = (v: unknown) => (v === null || v === undefined ? 'null' : Array.isArray(v) ? 'array' : typeof v)

/** Every mock element's keys together: one sample per list. */
function mergeSamples(items: Json[]): Json {
  const objects = items.filter((x): x is { [k: string]: Json } => kind(x) === 'object')
  if (!objects.length) return items[0] ?? null
  const merged: { [k: string]: Json } = {}
  for (const o of objects) for (const [k, v] of Object.entries(o)) if (!(k in merged) || merged[k] === null) merged[k] = v
  return merged
}

/**
 * Where the real value does not match the mock's shape. A null from the API is
 * allowed (the field may be null); a null in the mock pins no type, so when the
 * API sends a value there the path goes into `unchecked`, to be reported.
 */
export function drift(real: unknown, mock: unknown, at = '$', out: string[] = [], unchecked: string[] = []): string[] {
  const r = kind(real)
  const m = kind(mock)
  if (m === 'null' && r !== 'null') unchecked.push(at)
  if (r === 'null' || m === 'null') return out
  if (r !== m) {
    out.push(`${at}: the API sends ${r}, the mock ${m}`)
    return out
  }
  if (m === 'array') {
    const sample = mergeSamples(mock as Json[])
    if (sample !== null) for (const [i, item] of (real as unknown[]).entries()) drift(item, sample, `${at}[${i}]`, out, unchecked)
    return out
  }
  if (m === 'object') {
    const ro = real as Record<string, unknown>
    for (const [k, v] of Object.entries(mock as Record<string, unknown>)) {
      if (!(k in ro)) {
        // Mock maps keyed by data (status counts, dates) need not have every key on the server.
        if (KEYED_BY_DATA.some((re) => re.test(`${at}.${k}`))) continue
        out.push(`${at}.${k}: missing from the API`)
      } else drift(ro[k], v, `${at}.${k}`, out, unchecked)
    }
  }
  return out
}

/** Objects whose keys are data, not field names: their entries are compared, not their key sets. */
const KEYED_BY_DATA = [/^\$\.orders\.[A-Z_]+$/, /^\$\.counts\.[A-Z_]+$/, /\.detail\.[^.]+$/ /* an audit entry's detail depends on its action */]

test('the mock answers in the shapes the real API sends', async ({ request }) => {
  const login = await request.post(`${API}/admin/v1/auth/login`, { data: { email, password } })
  expect(login.ok(), await login.text()).toBeTruthy()
  const auth = { headers: { Authorization: `Bearer ${(await login.json()).accessToken}` } }
  const get = async (path: string) => {
    const res = await request.get(`${API}/admin/v1${path}`, auth)
    expect(res.ok(), `${path}: ${res.status()} ${await res.text()}`).toBeTruthy()
    return res.json()
  }

  const mock = seed()
  const batches = await get('/batches')
  const orders = await get('/orders')
  const firstOrder = (Array.isArray(orders) ? orders : orders.items)?.[0]
  const reads: [string, unknown][] = [
    ['/auth/me', { email: 'manager@mandimangoes.test', role: 'MANAGER', twoStep: { enabled: false, required: false } }],
    ['/summary', mock.summary],
    ['/attention', mock.attention],
    ['/products', mock.products],
    ['/batches', mock.batches],
    ['/orders', mock.orders],
    ['/pack-list', mock.packList],
    ['/manifest', mock.manifest],
    ['/analytics', mock.analytics],
    ['/claims', mock.claims],
    ['/promos', mock.promos],
    ['/pincodes', mock.pincodes],
    ['/coverage', mock.coverage],
    ['/preorders', mock.preorders],
    ['/preorder-capacity', mock.preorderCapacity],
    ['/slots', mock.slots],
    ['/calendar', mock.calendar],
    ['/config', mock.config],
    ['/staff', mock.staff],
    ['/audit', { page: 1, pageSize: 50, total: mock.audit.length, items: mock.audit, staff: [{ email: 'a', role: 'MANAGER' }] }],
    ['/reviews', { items: mock.reviews, nextCursor: null, counts: {} }],
    ['/reviews/insights', mock.reviewInsights],
  ]
  if (batches.length) {
    reads.push([`/batches/${batches[0].id}`, mock.batch])
    reads.push([`/batches/${batches[0].id}/ledger`, mock.ledger])
  }
  if (firstOrder) reads.push([`/orders/${firstOrder.id}`, mock.order])

  const problems: string[] = []
  const empty: string[] = []
  const nullInMock = new Set<string>()
  for (const [path, sample] of reads) {
    const real = await get(path)
    if (Array.isArray(real) && !real.length) empty.push(path)
    const unchecked: string[] = []
    for (const p of drift(real, sample, '$', [], unchecked)) problems.push(`GET ${path} ${p}`)
    // One entry per field, not per list item.
    for (const u of unchecked) nullInMock.add(`GET ${path} ${u.replace(/\[\d+\]/g, '[]')}`)
  }
  // An empty list proves nothing about its items: say which ones went unchecked.
  if (empty.length) test.info().annotations.push({ type: 'unchecked (empty on the server)', description: empty.join(', ') })
  // Nor does a null in the mock where the API sends a value: give the mock a value there to check it.
  if (nullInMock.size) test.info().annotations.push({ type: 'unchecked (null in the mock)', description: [...nullInMock].join(', ') })
  expect(problems).toEqual([])
})

test('drift() catches a renamed, missing or retyped field', () => {
  expect(drift({ a: 1, b: 'x' }, { a: 1, b: 'y' })).toEqual([])
  expect(drift({ a: 1 }, { a: 1, b: 'y' })).toEqual(['$.b: missing from the API'])
  expect(drift({ a: '1' }, { a: 1 })).toEqual(['$.a: the API sends string, the mock number'])
  expect(drift([{ a: 1 }, { a: null }], [{ a: 2 }])).toEqual([])
  expect(drift({ list: [{ a: { b: 1 } }] }, { list: [{ a: { b: true } }] })).toEqual(['$.list[0].a.b: the API sends number, the mock boolean'])
  // A null in the mock checks nothing, and says so.
  const unchecked: string[] = []
  expect(drift({ a: { b: 1 }, c: null }, { a: null, c: null }, '$', [], unchecked)).toEqual([])
  expect(unchecked).toEqual(['$.a'])
})
