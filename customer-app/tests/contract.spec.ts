import { expect, test } from '../../tests/fixtures'
import type { Catalogue, CatalogueItem, Confirmed, DeliveryCheck, Order, OrderStatus, OrderSummary, ProductListing, Quote, QuoteLine, ShopPolicy, Slot, SlotOnDate, Stage, api } from '../src/api'

// TST-1: the shop's types (customer-app/src/api.ts) must match what the real
// API sends. Every endpoint the order journey uses is called here, and each
// answer is checked field by field against a hand-written map of the shop's
// type. The maps are typed against the shop's interfaces, so adding a field
// to a type without adding it here fails the typecheck.
//
// Stricter than the panel's contract spec: a null is a failure unless the
// type allows null, strings that name a state must be one of the type's
// values, dates must be dates, and the lists checked must not be empty.
// Orders are taken through each state the order page draws (waiting for
// payment, paid, cancelled and refunded, delivered, missed), so the fields
// that are only set in one state are checked with a value, not just as null.

const API = (process.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '')

test.beforeAll(async ({ request }) => {
  const ok = await request.get(`${API}/ready`).then((r) => r.ok()).catch(() => false)
  if (process.env.CI) expect(ok, `mango-api is not reachable at ${API}`).toBe(true)
  test.skip(!ok, `mango-api is not reachable at ${API}`)
})

// ---------------------------------------------------------------- the shape checker

type Spec =
  | 'string'
  | 'int'
  | 'number'
  | 'boolean'
  /** YYYY-MM-DD */
  | 'day'
  /** An ISO timestamp. */
  | 'time'
  | { enum: readonly string[] }
  | { nullable: Spec }
  /** The type marks the field optional (`?:`): it may be left out. */
  | { optional: Spec }
  | { array: Spec; nonEmpty?: boolean }
  | { object: { [k: string]: Spec } }

/** One entry per field of T, no more and no fewer. */
type Fields<T> = { [K in keyof T]-?: Spec }

const nullable = (s: Spec): Spec => ({ nullable: s })
const optional = (s: Spec): Spec => ({ optional: s })
const list = (s: Spec): Spec => ({ array: s, nonEmpty: true })
const object = <T>(fields: Fields<T>): Spec => ({ object: fields as { [k: string]: Spec } })
const oneOf = <T extends string>(values: readonly T[]): Spec => ({ enum: values })

/** Where the real value does not fit the shop's type. */
export function misfits(value: unknown, spec: Spec, at = '$', out: string[] = []): string[] {
  if (typeof spec === 'object' && 'optional' in spec) return misfits(value, spec.optional, at, out)
  if (typeof spec === 'object' && 'nullable' in spec) return value === null ? out : misfits(value, spec.nullable, at, out)
  if (value === null || value === undefined) {
    out.push(`${at}: ${value === null ? 'null' : 'missing'}, but the shop's type does not allow it`)
    return out
  }
  const fail = (what: string) => out.push(`${at}: expected ${what}, the API sends ${JSON.stringify(value)}`)
  if (spec === 'string') typeof value === 'string' || fail('a string')
  else if (spec === 'int') Number.isInteger(value) || fail('a whole number')
  else if (spec === 'number') (typeof value === 'number' && Number.isFinite(value)) || fail('a number')
  else if (spec === 'boolean') typeof value === 'boolean' || fail('true or false')
  else if (spec === 'day') (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) || fail('a YYYY-MM-DD day')
  else if (spec === 'time') (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))) || fail('an ISO time')
  else if ('enum' in spec) (typeof value === 'string' && spec.enum.includes(value)) || fail(`one of ${spec.enum.join(', ')}`)
  else if ('array' in spec) {
    if (!Array.isArray(value)) fail('a list')
    else if (spec.nonEmpty && value.length === 0) out.push(`${at}: an empty list proves nothing about its items`)
    else value.forEach((item, i) => misfits(item, spec.array, `${at}[${i}]`, out))
  } else if (typeof value !== 'object' || Array.isArray(value)) fail('an object')
  else {
    const o = value as Record<string, unknown>
    for (const [k, s] of Object.entries(spec.object)) {
      if (!(k in o)) {
        if (!(typeof s === 'object' && 'optional' in s)) out.push(`${at}.${k}: missing from the API`)
      } else misfits(o[k], s, `${at}.${k}`, out)
    }
  }
  return out
}

// ---------------------------------------------------------------- the shop's types, as maps

const STAGES = ['RAW', 'SEMI_RIPE', 'RIPE'] as const satisfies readonly Stage[]
const STATUSES = [
  'PAYMENT_PENDING', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED', 'RTO', 'CANCELLED',
] as const satisfies readonly OrderStatus[]
const PAYMENT = ['INITIATED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED'] as const satisfies readonly NonNullable<Order['paymentStatus']>[]
const REFUND = ['PENDING', 'REFUNDED'] as const satisfies readonly NonNullable<Order['refundStatus']>[]
const CANCEL_REASON = ['HOLD_EXPIRED', 'STAFF', 'OTHER'] as const satisfies readonly NonNullable<Order['cancelReason']>[]
type Delivery = NonNullable<Order['delivery']>
const DELIVERY_METHOD = ['code', 'photo', 'staff'] as const satisfies readonly NonNullable<Delivery['method']>[]

// Each list holds every value of its union: a value the type gains must be added here too.
type Missing<All, Listed> = Exclude<All, Listed> extends never ? true : never
const unionsListed: [
  Missing<Stage, (typeof STAGES)[number]>,
  Missing<OrderStatus, (typeof STATUSES)[number]>,
  Missing<NonNullable<Order['paymentStatus']>, (typeof PAYMENT)[number]>,
  Missing<NonNullable<Order['refundStatus']>, (typeof REFUND)[number]>,
  Missing<NonNullable<Order['cancelReason']>, (typeof CANCEL_REASON)[number]>,
  Missing<NonNullable<Delivery['method']>, (typeof DELIVERY_METHOD)[number]>,
] = [true, true, true, true, true, true]
void unionsListed

const SLOT = object<Slot>({ id: 'string', label: 'string', startsAt: 'string', endsAt: 'string' })
const SLOT_ON_DATE = object<SlotOnDate>({ id: 'string', label: 'string', startsAt: 'string', endsAt: 'string', remainingBoxes: nullable('int'), available: 'boolean' })
const DELIVERY_CHECK = object<DeliveryCheck>({ serviceable: 'boolean', earliestDeliveryDate: nullable('day'), deliveryDates: list('day'), cutoffTime: 'string' })
const CATALOGUE_ITEM = object<CatalogueItem>({
  sku: 'string', name: 'string', variety: 'string', boxSize: 'string', price: 'int', stage: oneOf(STAGES), qty: 'int', eatBy: 'day',
  description: optional('string'), photoUrl: optional(nullable('string')), nextAvailableDate: optional(nullable('day')),
  fruitsPerBox: optional(nullable('int')), fruitWeightG: optional(nullable('int')),
})
const CATALOGUE = object<Catalogue>({
  serviceable: 'boolean', deliveryDate: optional('day'), deliveryDates: optional(list('day')), cutoffTime: optional('string'), items: list(CATALOGUE_ITEM),
})
// UX-5 and UX-3: the boxes and prices before a pincode, and the live rules the help and terms pages quote.
const PRODUCTS = object<{ items: ProductListing[] }>({
  items: list(
    object<ProductListing>({
      sku: 'string', name: 'string', variety: 'string', boxSize: 'string', price: 'int', description: 'string', photoUrl: nullable('string'),
      fruitsPerBox: nullable('int'), fruitWeightG: nullable('int'),
    }),
  ),
})
const POLICY = object<ShopPolicy>({ holdMinutes: 'int', cutoffTime: 'string', maxDaysAhead: 'int', claimWindowHours: 'int' })
type SlotsAnswer = Awaited<ReturnType<typeof api.slots>>
const SLOTS = object<SlotsAnswer>({ deliveryDate: 'day', slots: list(SLOT_ON_DATE) })
type CartLine = Awaited<ReturnType<typeof api.serverCart>>['lines'][number]
const CART = object<Awaited<ReturnType<typeof api.serverCart>>>({ lines: list(object<CartLine>({ sku: 'string', stage: oneOf(STAGES), qty: 'int' })) })
const QUOTE = object<Quote>({
  quoteId: 'string', pincode: 'string', deliveryDate: 'day', slot: nullable(SLOT),
  lines: list(object<QuoteLine>({ sku: 'string', name: 'string', stage: oneOf(STAGES), qty: 'int', unitPrice: 'int', linePrice: 'int', eatBy: 'day' })),
  subtotal: 'int', promo: nullable(object<NonNullable<Quote['promo']>>({ code: 'string', description: nullable('string') })), discount: 'int', total: 'int', expiresAt: 'time',
  holdMinutes: optional('int'),
})
const CONFIRMED = object<Confirmed>({
  orderId: 'string', number: 'string', status: oneOf(STATUSES), total: 'int', deliveryDate: 'day',
  razorpayOrderId: nullable('string'), razorpayKeyId: nullable('string'), holdExpiresAt: nullable('time'),
})
const ORDER_SUMMARY = object<OrderSummary>({
  id: 'string', number: 'string', status: oneOf(STATUSES), deliveryDate: 'day', total: 'int', itemCount: 'int', placedAt: 'time', holdExpiresAt: optional(nullable('time')),
})
type Item = Order['items'][number]
const ORDER = object<Order>({
  id: 'string', number: 'string', status: oneOf(STATUSES), deliveryDate: 'day', placedAt: 'time', pincode: 'string', deliveryAddress: nullable('string'),
  subtotal: 'int', discount: 'int', promoCode: nullable('string'), total: 'int',
  gift: nullable(object<NonNullable<Order['gift']>>({ recipientName: 'string', recipientPhone: 'string', message: optional(nullable('string')) })),
  paymentStatus: nullable(oneOf(PAYMENT)), refundStatus: nullable(oneOf(REFUND)), razorpayOrderId: nullable('string'), razorpayKeyId: optional(nullable('string')),
  holdExpiresAt: nullable('time'), cancelReason: optional(nullable(oneOf(CANCEL_REASON))), cancelledAt: optional(nullable('time')), slot: nullable(SLOT),
  items: list(object<Item>({
    sku: 'string', name: 'string', stage: nullable(oneOf(STAGES)), quantity: 'int', unitPrice: 'int', linePrice: 'int', eatBy: nullable('day'), readyOn: optional(nullable('day')),
  })),
  timeline: list(object<Order['timeline'][number]>({ status: oneOf(STATUSES), at: 'time' })),
  deliveryCode: optional(nullable('string')),
  delivery: optional(nullable(object<Delivery>({ at: 'time', method: nullable(oneOf(DELIVERY_METHOD)), receivedBy: nullable('string'), hasPhoto: 'boolean' }))),
  rating: optional(nullable(object<NonNullable<Order['rating']>>({ stars: 'int', comment: nullable('string'), at: 'time' }))),
  claimWindowHours: 'number', claimUntil: nullable('time'), deliveryFailures: 'int', retryScheduled: nullable('boolean'), findingStock: optional('boolean'),
})
// The shop does not call it today; checked so a payment poll written later starts from the truth.
const PAYMENT_STATUS: Spec = { object: { status: nullable(oneOf(PAYMENT)), orderStatus: oneOf(STATUSES) } }
/** What raw() in api.ts reads from a refusal: error.code, error.message, and the rest as detail. */
const ERROR = (code: string, detail: { [k: string]: Spec } = {}): Spec => ({ object: { error: { object: { code: oneOf([code]), message: 'string', ...detail } } } })

// ---------------------------------------------------------------- the journey

test('misfits() catches a null, a missing field, a wrong enum, a bad date and an empty list', () => {
  const spec: Spec = { object: { a: 'int', b: nullable('day'), c: oneOf(['X', 'Y']), d: list('string'), e: optional('string') } }
  expect(misfits({ a: 1, b: null, c: 'X', d: ['s'] }, spec)).toEqual([])
  expect(misfits({ a: null, b: '2026-10-22T00:00:00Z', c: 'Z', d: [] }, spec)).toEqual([
    "$.a: null, but the shop's type does not allow it",
    '$.b: expected a YYYY-MM-DD day, the API sends "2026-10-22T00:00:00Z"',
    '$.c: expected one of X, Y, the API sends "Z"',
    '$.d: an empty list proves nothing about its items',
  ])
  expect(misfits({ b: null, c: 'Y', d: ['s'], e: 3 }, spec)).toEqual(['$.a: missing from the API', '$.e: expected a string, the API sends 3'])
})

test('the API answers the order journey in the shapes the shop expects', async ({ request }, info) => {
  test.setTimeout(60_000)
  const problems: string[] = []
  const check = (what: string, value: unknown, spec: Spec) => {
    for (const p of misfits(value, spec)) problems.push(`${what} ${p}`)
  }

  const phone = `6${String(Date.now()).slice(-8)}${info.project.name === 'phone' ? 7 : 8}`
  const asked = await request.post(`${API}/v1/auth/otp/request`, { data: { phone } })
  expect(asked.ok(), await asked.text()).toBeTruthy()
  const signIn = await request.post(`${API}/v1/auth/otp/verify`, { data: { phone, code: (await asked.json()).devCode } })
  expect(signIn.ok(), await signIn.text()).toBeTruthy()
  const auth = { Authorization: `Bearer ${(await signIn.json()).accessToken}` }
  const call = async (method: 'GET' | 'POST', path: string, data?: unknown, headers: Record<string, string> = {}) => {
    const res = await request.fetch(`${API}${path}`, { method, data, headers: { ...auth, ...headers } })
    return { status: res.status(), body: res.status() === 204 ? null : await res.json() }
  }
  const ok = async (method: 'GET' | 'POST', path: string, data?: unknown, headers?: Record<string, string>) => {
    const r = await call(method, path, data, headers)
    expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300)
    return r.body
  }

  const check1 = await ok('GET', '/v1/delivery/check?pincode=560034')
  check('GET /delivery/check', check1, DELIVERY_CHECK)
  const cat = await ok('GET', '/v1/catalogue?pincode=560034')
  check('GET /catalogue', cat, CATALOGUE)
  check('GET /products', await ok('GET', '/v1/products'), PRODUCTS)
  check('GET /policy', await ok('GET', '/v1/policy'), POLICY)
  const slots = await ok('GET', `/v1/delivery/slots?pincode=560034&delivery_date=${cat.deliveryDate}`)
  check('GET /delivery/slots', slots, SLOTS)
  const slotId = slots.slots.find((s: SlotOnDate) => s.available)?.id ?? null

  /** Cart, quote and confirm for one box: the confirm's raw answer. */
  let placed = 0
  const place = async () => {
    const item = (await ok('GET', '/v1/catalogue?pincode=560034')).items.find((i: CatalogueItem) => i.qty > 0)
    expect(item, 'something in stock').toBeTruthy()
    expect(await call('POST', '/v1/cart/items', { sku: item.sku, stage: item.stage, qty: 1 })).toEqual({ status: 204, body: null })
    check('GET /cart', await ok('GET', '/v1/cart'), CART)
    const quote = await ok('POST', '/v1/checkout/quote', { pincode: '560034', deliveryDate: cat.deliveryDate, slotId })
    check('POST /checkout/quote', quote, QUOTE)
    return call('POST', '/v1/checkout/confirm', { quoteId: quote.quoteId, address: '12, 4th Cross, Koramangala, Bengaluru' }, { 'Idempotency-Key': `contract-${phone}-${placed++}` })
  }
  const order = async (id: string, state: string) => {
    const o = await ok('GET', `/v1/orders/${id}`)
    check(`GET /orders/:id (${state})`, o, ORDER)
    return o as Order
  }
  const paymentStatus = async (id: string) => {
    const p = await ok('GET', `/v1/orders/${id}/payment-status`)
    check('GET /orders/:id/payment-status', p, PAYMENT_STATUS)
    return p
  }
  const pay = (orderId: string) => ok('POST', '/v1/dev/pay', { orderId, outcome: 'captured' })

  // Waiting for payment.
  const first = await place()
  expect(first.status, JSON.stringify(first.body)).toBe(201)
  check('POST /checkout/confirm', first.body, CONFIRMED)
  const firstId: string = first.body.orderId
  const pending = await order(firstId, 'waiting for payment')
  expect([pending.status, pending.paymentStatus, pending.claimUntil, pending.retryScheduled]).toEqual(['PAYMENT_PENDING', 'INITIATED', null, null])
  expect(pending.holdExpiresAt).not.toBeNull()
  expect(await paymentStatus(firstId)).toEqual({ status: 'INITIATED', orderStatus: 'PAYMENT_PENDING' })

  // A second checkout while it is unpaid: the refusal names the unpaid order (Checkout links to it).
  const second = await place()
  expect(second.status).toBe(409)
  check('POST /checkout/confirm (unpaid order exists)', second.body, ERROR('UNPAID_ORDER_EXISTS', { orderId: 'string', number: 'string', holdExpiresAt: nullable('time') }))
  expect(second.body.error.orderId).toBe(firstId)

  // Paid, then cancelled for a refund.
  await pay(firstId)
  expect((await order(firstId, 'paid')).paymentStatus).toBe('SUCCEEDED')
  expect(await paymentStatus(firstId)).toEqual({ status: 'SUCCEEDED', orderStatus: 'CONFIRMED' })
  expect(await call('POST', `/v1/orders/${firstId}/cancel`)).toEqual({ status: 204, body: null })
  const cancelled = await order(firstId, 'cancelled')
  expect(cancelled.status).toBe('CANCELLED')
  expect(cancelled.cancelReason).toBe('OTHER')
  expect(cancelled.refundStatus).not.toBeNull()
  // Cancelling again is refused in the error shape the shop reads.
  const again = await call('POST', `/v1/orders/${firstId}/cancel`)
  expect(again.status).toBe(409)
  check('POST /orders/:id/cancel (not cancellable)', again.body, ERROR('NOT_CANCELLABLE'))

  // Staff take two more orders out: one is delivered, one is missed.
  const login = await request.post(`${API}/admin/v1/auth/login`, { data: { email: 'manager@mandimangoes.test', password: 'manager123' } })
  expect(login.ok(), await login.text()).toBeTruthy()
  const staff = { headers: { Authorization: `Bearer ${(await login.json()).accessToken}` } }
  const outForDelivery = async () => {
    const r = await place()
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const id: string = r.body.orderId
    await pay(id)
    for (const step of [
      () => request.patch(`${API}/admin/v1/orders/${id}/status`, { data: { status: 'PROCESSING' }, ...staff }),
      () => request.post(`${API}/admin/v1/orders/${id}/allocate`, staff),
      () => request.patch(`${API}/admin/v1/orders/${id}/status`, { data: { status: 'PACKED' }, ...staff }),
      () => request.post(`${API}/admin/v1/orders/${id}/dispatch`, staff),
    ]) {
      const s = await step()
      expect(s.ok(), await s.text()).toBeTruthy()
    }
    return id
  }

  const deliveredId = await outForDelivery()
  const out = await order(deliveredId, 'out for delivery')
  expect(out.deliveryCode).toMatch(/^\d+$/)
  const handed = await request.patch(`${API}/admin/v1/orders/${deliveredId}/status`, {
    data: { status: 'DELIVERED', override: true, reason: 'Test run: handed over in person' },
    ...staff,
  })
  expect(handed.ok(), await handed.text()).toBeTruthy()
  const delivered = await order(deliveredId, 'delivered')
  expect(delivered.status).toBe('DELIVERED')
  // The claim deadline is the last delivery plus the live window, as POST /claims counts it.
  const deliveredAt = delivered.timeline.filter((e) => e.status === 'DELIVERED').slice(-1)[0].at
  expect(delivered.claimUntil).not.toBeNull()
  expect(Date.parse(delivered.claimUntil!) - Date.parse(deliveredAt)).toBe(delivered.claimWindowHours * 3_600_000)
  const late = await call('POST', `/v1/orders/${deliveredId}/cancel`)
  expect(late.status).toBe(409)
  check('POST /orders/:id/cancel (delivered)', late.body, ERROR('NOT_CANCELLABLE'))

  const missedId = await outForDelivery()
  const { attempt } = await (await request.get(`${API}/admin/v1/orders/${missedId}`, staff)).json()
  const failed = await request.post(`${API}/admin/v1/orders/${missedId}/delivery`, { data: { outcome: 'FAILED', reason: 'NOT_HOME', attempt }, ...staff })
  expect(failed.ok(), await failed.text()).toBeTruthy()
  const missed = await order(missedId, 'missed')
  expect([missed.status, missed.deliveryFailures, missed.retryScheduled, missed.claimUntil]).toEqual(['DELIVERY_FAILED', 1, true, null])

  // My orders, and an order that isn't there.
  const orders = await ok('GET', '/v1/orders')
  check('GET /orders', orders, list(ORDER_SUMMARY))
  expect(orders.map((o: OrderSummary) => o.id)).toEqual(expect.arrayContaining([firstId, deliveredId, missedId]))
  const unknown = await call('GET', '/v1/orders/no-such-order')
  expect(unknown.status).toBe(404)
  check('GET /orders/:id (unknown)', unknown.body, ERROR('NOT_FOUND'))

  expect(problems).toEqual([])
})
