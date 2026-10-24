import type { Page, Route } from '@playwright/test'
import type { Attention, AuditEntry, LedgerEntry, Product, Promo, Review, ReviewInsights, StaffMember } from '../src/types'

/** A 1×1 PNG. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

// A small in-memory stand-in for mango-api's /admin/v1, so the UI can be
// exercised in CI without a database. Shapes follow the API reference (§6).

export type Role = 'MANAGER' | 'OPERATOR' | 'PACKER' | 'QC' | 'RIDER'

export interface MockOptions {
  /** Signed in already (refresh succeeds) or not (refresh returns 401). */
  signedIn?: boolean
  role?: Role
  /**
   * Two-step sign-in: on for this person (login asks for code 123456), required but not set up,
   * or required and set-up needs a manager's setup code (k7qd-2mxp).
   */
  twoStep?: 'on' | 'required' | 'required-with-code'
}

const json = (route: Route, status: number, body?: unknown) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: body === undefined ? '' : JSON.stringify(body),
  })

const EMAIL: Record<Role, string> = { MANAGER: 'manager@mandimangoes.test', OPERATOR: 'ops@mandimangoes.test', PACKER: 'packer@mandimangoes.test', QC: 'qc@mandimangoes.test', RIDER: 'rider@mandimangoes.test' }

function review(p: Partial<Review> & { id: string; rating: number }): Review {
  return {
    status: 'PENDING', flagged: false, flagReasons: [], taste: null, ripenessAccuracy: null, packaging: null, delivery: null, comment: null,
    displayName: 'Asha R.', anonymous: false, customerName: 'Asha Rao', orderId: 'o2', orderNumber: 'ORD-1043', sku: 'ALP-3', productName: 'Alphonso 3kg Box',
    variety: 'Alphonso', ripenessOrdered: 'RIPE', photos: [], reply: null, deliveredAt: '2026-10-13T08:00:00Z', createdAt: '2026-10-14T08:00:00Z',
    updatedAt: '2026-10-14T08:00:00Z', moderatedBy: null, moderatedAt: null, moderationReason: null, scrubbed: false, ...p,
  }
}

export function seed() {
  return {
    staff: (['MANAGER', 'OPERATOR', 'PACKER', 'QC'] as Role[]).map(
      (role, i): StaffMember => ({ id: `adm${i + 1}`, email: EMAIL[role], role, createdAt: '2026-10-01T04:30:00Z', twoStep: role === 'OPERATOR' }),
    ),
    audit: [
      { id: 'aud2', at: '2026-10-16T05:10:00Z', email: 'packer@mandimangoes.test', role: 'PACKER', action: 'PATCH /orders/:id/status', target: 'o1', detail: { status: 'PACKED' } },
      { id: 'aud1', at: '2026-10-16T05:00:00Z', email: 'qc@mandimangoes.test', role: 'QC', action: 'POST /batches/:id/qc', target: 'b1', detail: { ripeness: 'SEMI_RIPE', condition: 'GOOD' } },
    ] as AuditEntry[],
    summary: {
      orders: { CONFIRMED: 3, PROCESSING: 1, PACKED: 2, SHIPPED: 0, OUT_FOR_DELIVERY: 1, DELIVERY_FAILED: 0, PAYMENT_PENDING: 5 },
      openClaims: 2,
      batchesNearLimit: [{ id: 'b1', variety: 'Alphonso', ageDays: 7, available: 12 }],
      lowStock: [{ sku: 'ALP-5', productName: 'Alphonso 5kg Box', available: 3 }],
      maxSellableAge: 7,
    },
    products: [
      { sku: 'ALP-3', name: 'Alphonso 3kg Box', variety: 'Alphonso', boxSize: '3kg', price: 189900, gstRate: 0, hsnCode: '08045020', description: 'Saffron flesh, rich and sweet.', active: true, sortOrder: 0, photoUrl: '/v1/products/ALP-3/photo?v=1' },
      { sku: 'ALP-5', name: 'Alphonso 5kg Box', variety: 'Alphonso', boxSize: '5kg', price: 299900, gstRate: 0, hsnCode: '08045020', description: '', active: true, sortOrder: 0, photoUrl: null },
      { sku: 'KES-3', name: 'Kesar 3kg Box', variety: 'Kesar', boxSize: '3kg', price: 159900, gstRate: 0, hsnCode: '08045020', description: '', active: true, sortOrder: 0, photoUrl: null },
      { sku: 'TOT-3', name: 'Totapuri 3kg Box', variety: 'Totapuri', boxSize: '3kg', price: 79900, gstRate: 0, hsnCode: '08045020', description: '', active: false, sortOrder: 0, photoUrl: null },
    ] as Product[],
    batch: {
      id: 'b1',
      variety: 'Alphonso',
      pluckedOn: '2026-10-08',
      ageDays: 7,
      farm: 'Ratnagiri',
      status: 'SELLING',
      lines: [
        { id: 'l1', sku: 'ALP-3', onHand: 20, held: 2, committed: 3, reserveBuffer: 1, available: 14 },
        { id: 'l2', sku: 'ALP-5', onHand: 10, held: 0, committed: 6, reserveBuffer: 1, available: 3 },
      ],
      qc: [
        { id: 'q1', ripenessRating: 'RIPE', condition: 'GOOD', notes: null, loggedBy: 'ops@mandimangoes.test', loggedAt: '2026-10-14T04:30:00Z' },
      ],
    },
    batches: [
      { id: 'b1', variety: 'Alphonso', pluckedOn: '2026-10-08', ageDays: 7, farm: 'Ratnagiri', status: 'SELLING', latestRating: 'RIPE', latestCondition: 'GOOD', onHand: 30, held: 2, committed: 9, available: 17 },
      { id: 'b2', variety: 'Kesar', pluckedOn: '2026-10-14', ageDays: 1, farm: null, status: 'ARRIVED', latestRating: null, latestCondition: null, onHand: 40, held: 0, committed: 0, available: 0 },
    ],
    ledger: [
      { eventType: 'INTAKE', sku: 'ALP-3', delta: 20, actorType: 'admin', actorId: 'ops@mandimangoes.test', reason: null, createdAt: '2026-10-08T05:00:00Z' },
      { eventType: 'PACK', sku: 'ALP-3', delta: -2, actorType: 'admin', actorId: 'ops@mandimangoes.test', reason: null, createdAt: '2026-10-10T05:00:00Z' },
    ] as LedgerEntry[],
    orders: {
      page: 1,
      pageSize: 50,
      total: 2,
      items: [
        { id: 'o1', number: 'ORD-1042', customerName: 'Asha Rao', phone: '9876543210', itemCount: 2, total: 249900, status: 'PROCESSING', deliveryDate: '2026-10-16', placedAt: '2026-10-14T06:00:00Z', channel: 'whatsapp' },
        { id: 'o2', number: 'ORD-1043', customerName: 'Vikram S', phone: '9123456780', itemCount: 1, total: 129900, status: 'DELIVERED', deliveryDate: '2026-10-13', placedAt: '2026-10-11T06:00:00Z' },
      ],
    },
    order: {
      id: 'o1',
      number: 'ORD-1042',
      status: 'PROCESSING',
      customerName: 'Asha Rao',
      phone: '9876543210',
      pincode: '400001',
      deliveryAddress: '12 Marine Drive, Mumbai',
      deliveryDate: '2026-10-16',
      placedAt: '2026-10-14T06:00:00Z',
      total: 249900,
      items: [
        { productName: 'Alphonso 3kg Box', sku: 'ALP-3', quantity: 1, stage: 'RIPE', linePrice: 129900 },
        { productName: 'Alphonso 5kg Box', sku: 'ALP-5', quantity: 1, stage: 'RIPE', linePrice: 120000 },
      ],
      stock: [
        { batchId: 'b1', sku: 'ALP-3', variety: 'Alphonso', pluckedOn: '2026-10-08', quantity: 1, state: 'committed' },
        { batchId: 'b1', sku: 'ALP-5', variety: 'Alphonso', pluckedOn: '2026-10-08', quantity: 1, state: 'committed' },
      ],
      events: [
        { status: 'PAYMENT_PENDING', actor: 'system', reason: null, createdAt: '2026-10-14T06:00:00Z' },
        { status: 'CONFIRMED', actor: 'webhook:razorpay', reason: null, createdAt: '2026-10-14T06:01:00Z' },
        { status: 'PROCESSING', actor: 'ops@mandimangoes.test', reason: null, createdAt: '2026-10-14T08:00:00Z' },
      ],
      payment: { status: 'SUCCEEDED', method: 'upi', amount: 249900 },
      slot: { id: 'slt1', label: 'Morning', startsAt: '07:00', endsAt: '11:00' },
      channel: 'whatsapp',
      notifications: [
        { kind: 'ORDER_CONFIRMED', channel: 'whatsapp', status: 'SENT', attempts: 1, createdAt: '2026-10-14T06:01:00Z', sentAt: '2026-10-14T06:01:05Z', error: null },
      ],
    },
    deliveredOrder: {
      id: 'o2',
      number: 'ORD-1043',
      status: 'DELIVERED',
      customerName: 'Vikram S',
      phone: '9123456780',
      pincode: '400002',
      deliveryAddress: '4 Hill Road, Mumbai',
      deliveryDate: '2026-10-13',
      placedAt: '2026-10-11T06:00:00Z',
      total: 129900,
      items: [{ productName: 'Alphonso 3kg Box', sku: 'ALP-3', quantity: 1, stage: 'RIPE', linePrice: 129900 }],
      stock: [{ batchId: 'b1', sku: 'ALP-3', variety: 'Alphonso', pluckedOn: '2026-10-08', quantity: 1, state: 'packed' }],
      events: [{ status: 'DELIVERED', actor: 'ops@mandimangoes.test', reason: null, createdAt: '2026-10-13T10:00:00Z' }],
      deliveryAttempts: [
        {
          id: 'dat1', outcome: 'DELIVERED', method: 'photo', receivedBy: 'Security at the gate', reason: null, reasonLabel: null, note: null,
          photoId: 'dph1', lat: 18.9438, lng: 72.8231, actor: 'rider@mandimangoes.test', at: '2026-10-13T10:00:00Z',
        },
      ],
      payment: { status: 'SUCCEEDED', method: 'card', amount: 129900 },
    },
    attention: { loop: { lastRunAt: '2026-10-15T04:29:00Z', stale: false, failingSteps: [] }, failedMessages: [], stuckRefunds: [], webhookFailures: [] } as Attention,
    analytics: {"from": "2026-09-28", "to": "2026-10-18", "weeks": [{"weekStart": "2026-09-28", "orders": 0, "boxes": 0, "revenue": 0, "replacements": 0, "delivered": 0, "deliveryFailed": 0, "customerCancels": 0, "refunded": 0, "received": 0, "wasted": 0, "condemned": 0, "atRisk": 0, "claims": 0, "claimsReplaced": 0, "wastageRate": null, "atRiskRate": null}, {"weekStart": "2026-10-05", "orders": 12, "boxes": 20, "revenue": 1800000, "replacements": 0, "delivered": 12, "deliveryFailed": 0, "customerCancels": 0, "refunded": 0, "received": 40, "wasted": 4, "condemned": 4, "atRisk": 1, "claims": 0, "claimsReplaced": 0, "wastageRate": 0.1, "atRiskRate": 0.083}, {"weekStart": "2026-10-12", "orders": 30, "boxes": 52, "revenue": 4680000, "replacements": 0, "delivered": 30, "deliveryFailed": 0, "customerCancels": 0, "refunded": 0, "received": 60, "wasted": 6, "condemned": 6, "atRisk": 3, "claims": 0, "claimsReplaced": 0, "wastageRate": 0.1, "atRiskRate": 0.1}], "bySku": [{"sku": "ALP-3", "productName": "Alphonso 3kg Box", "boxes": 72, "revenue": 6480000, "received": 100, "wasted": 10, "wastageRate": 0.1}], "totals": {"orders": 42, "boxes": 72, "revenue": 6480000, "replacements": 0, "delivered": 42, "deliveryFailed": 0, "customerCancels": 0, "refunded": 0, "received": 100, "wasted": 10, "condemned": 10, "atRisk": 4, "claims": 1, "claimsReplaced": 1, "wastageRate": 0.1, "atRiskRate": 0.095}},
    manifest: {
      date: '2026-10-16',
      orders: 2,
      boxes: 3,
      runs: [
        {
          slot: { id: 'slt1', label: 'Morning', startsAt: '07:00', endsAt: '11:00' },
          orders: 2,
          boxes: 3,
          stops: [
            {
              pincode: '400001',
              city: 'Mumbai',
              zone: 'South',
              orders: [
                {
                  id: 'o1', number: 'ORD-1042', customerName: 'Asha Rao', phone: '9876543210', deliveryAddress: '12 Marine Drive',
                  status: 'PACKED', packed: true, boxes: 2, attempt: 1, items: [{ sku: 'ALP-3', productName: 'Alphonso 3kg Box', stage: 'RIPE', quantity: 2 }],
                },
                {
                  id: 'o3', number: 'ORD-1044', customerName: 'Vikram Shah', phone: '9876500000', deliveryAddress: null,
                  status: 'CONFIRMED', packed: false, boxes: 1, items: [{ sku: 'ALP-3', productName: 'Alphonso 3kg Box', stage: 'SEMI_RIPE', quantity: 1 }],
                  gift: { from: 'Meera Iyer', message: 'Happy Diwali!' },
                },
              ],
            },
          ],
        },
      ],
    },
    packList: [
      {
        id: 'o1',
        number: 'ORD-1042',
        customerName: 'Asha Rao',
        pincode: '400001',
        status: 'PROCESSING',
        slot: { id: 'slt1', label: 'Morning' },
        gift: { recipientName: 'Asha Rao', recipientPhone: '9876543210', message: 'Happy Diwali!' },
        items: [
          { sku: 'ALP-3', productName: 'Alphonso 3kg Box', quantity: 1, picks: [{ batchId: 'b1', variety: 'Alphonso', pluckedOn: '2026-10-08', quantity: 1, packed: false }] },
          { sku: 'ALP-5', productName: 'Alphonso 5kg Box', quantity: 1, picks: [] },
        ],
      },
    ],
    promos: [
      { code: 'DIWALI10', kind: 'PERCENT', value: 10, maxDiscount: 30000, minSubtotal: 100000, startsOn: null, endsOn: '2026-11-05', maxUses: null, perCustomer: 1, firstOrderOnly: false, active: true, description: 'Diwali offer', uses: 4, discountGiven: 52000, createdBy: 'manager@mandimangoes.test', createdAt: '2026-10-10T05:00:00Z' },
    ] as Promo[],
    claims: [
      { id: 'c1', orderId: 'o2', orderNumber: 'ORD-1043', orderTotal: 129900, customerPhone: '9123456780', issueType: 'DAMAGED', description: 'Two mangoes were crushed.', affectedItems: ['ALP-3'], photoUrl: 'https://abc123.public.blob.vercel-storage.com/claims/p.jpg', photos: [{ id: 'cph1' }], status: 'SUBMITTED', resolution: null, rejectionReason: null, createdAt: '2026-10-14T07:00:00Z' },
      { id: 'c2', orderId: 'o2', orderNumber: 'ORD-1043', orderTotal: 129900, customerPhone: '9123456780', issueType: 'WRONG_ITEM', description: 'Got Kesar instead of Alphonso.', affectedItems: ['ALP-3'], photoUrl: null, status: 'UNDER_REVIEW', resolution: null, createdAt: '2026-10-14T07:30:00Z' },
    ],
    reviews: [
      review({ id: 'rvw1', rating: 5, comment: 'Perfectly ripe on day two. Sweetest Alphonso we have had.', photos: [{ id: 'rph1', url: '/admin/v1/reviews/rvw1/photos/rph1', approved: false }], taste: 5, ripenessAccuracy: 5 }),
      review({ id: 'rvw2', rating: 2, comment: 'Two were bruised. Call me on 98450 12345', flagged: true, flagReasons: ['PHONE'], orderNumber: 'ORD-1044', displayName: 'Vikram S.', customerName: 'Vikram Shah', ripenessAccuracy: 2 }),
      review({ id: 'rvw3', rating: 4, comment: 'Good, a bit firm.', status: 'APPROVED', reply: { body: 'Thank you!', at: '2026-10-15T09:00:00Z', by: EMAIL.MANAGER } }),
    ] as Review[],
    reviewInsights: {
      days: 90,
      byVariety: [{ variety: 'Alphonso', reviews: 3, averageRating: 3.7, ripenessAnswers: 2, ripenessAccuracy: 3.5, low: 1 }],
      byBatch: [{ batchId: 'b1', variety: 'Alphonso', pluckedOn: '2026-10-08', farm: 'Ratnagiri', reviews: 3, averageRating: 3.7, ripenessAnswers: 2, ripenessAccuracy: 3.5, notAsPromised: 1 }],
      lowRatingTrend: [{ week: '2026-10-12', reviews: 3, low: 1 }],
    } as ReviewInsights,
    pincodes: [
      { pincode: '400001', city: 'Mumbai', zone: 'South', active: true },
      { pincode: '411001', city: 'Pune', zone: null, active: false },
    ],
    coverage: [
      {
        date: '2026-10-16',
        slots: [
          { id: 'slt1', label: 'Morning', booked: 12, maxBoxes: 40 },
          { id: 'slt2', label: 'Evening', booked: 3, maxBoxes: null },
        ],
        stock: [
          { sku: 'ALP-3', stage: 'RAW', qty: 0 },
          { sku: 'ALP-3', stage: 'SEMI_RIPE', qty: 12 },
          { sku: 'ALP-3', stage: 'RIPE', qty: 4 },
        ],
      },
    ],
    slots: [
      { id: 'slt1', label: 'Morning', startsAt: '07:00', endsAt: '11:00', maxBoxes: 40, active: true, sort: 0 },
      { id: 'slt2', label: 'Evening', startsAt: '16:00', endsAt: '20:00', maxBoxes: null, active: true, sort: 1 },
    ],
    preorderCapacity: [
      { sku: 'ALP-3', productName: 'Alphonso 3kg Box', weekStart: '2027-03-01', capacity: 100, reserved: 100, waitlisted: 4 },
      { sku: 'KES-3', productName: 'Kesar 3kg Box', weekStart: '2027-03-01', capacity: 50, reserved: 12, waitlisted: 0 },
    ],
    preorders: [
      { id: 'p1', number: 'PRE-1001', status: 'BOOKED', sku: 'ALP-3', productName: 'Alphonso 3kg Box', stage: 'RIPE', qty: 2, unitPrice: 129900, total: 259800, weekStart: '2027-03-01', pincode: '560034', customerName: 'Asha Rao', phone: '+919876543210', channel: 'app', paymentStatus: 'SUCCEEDED', movedCount: 1, createdAt: '2027-01-05T06:00:00Z', refund: null, order: null },
      { id: 'p2', number: 'PRE-1002', status: 'CONVERTED', sku: 'KES-3', productName: 'Kesar 3kg Box', stage: 'SEMI_RIPE', qty: 1, unitPrice: 99900, total: 99900, weekStart: '2027-03-01', pincode: '560034', customerName: 'Vikram S', phone: '+919123456780', channel: 'whatsapp', paymentStatus: 'SUCCEEDED', movedCount: 0, createdAt: '2027-01-06T06:00:00Z', refund: null, order: { id: 'o1', number: 'ORD-1042', status: 'CONFIRMED', deliveryDate: '2027-03-02' } },
    ],
    calendar: [{ date: '2026-10-20', isOpen: false, maxBoxes: null, note: 'Diwali' }],
    config: {
      version: 3,
      rules: {
        maxSellableAge: 7,
        retireAge: 8,
        cutoffHourIST: 18,
        maxDaysAhead: 5,
        holdMinutes: 10,
        quoteMinutes: 5,
        forecastConfidence: 0.85,
        maxQcShift: 1,
        transitDays: 2,
        nearLimitAge: 5,
        lowStockThreshold: 5,
        claimWindowHours: 24,
        maxUnpaidOrders: 1,
        maxHeldBoxes: 40,
        outForDeliveryAlertHours: 8,
        maxPreorderMoves: 3,
        seasonEndsOn: null as string | null,
        stageProfiles: {
          default: [
            { stage: 'RAW', minAge: 3, maxAge: 3 },
            { stage: 'SEMI_RIPE', minAge: 4, maxAge: 5 },
            { stage: 'RIPE', minAge: 6, maxAge: 7 },
          ],
        },
      },
    },
  }
}

export type MockState = ReturnType<typeof seed> & {
  signedIn: boolean
  role: Role
  twoStep: { enabled: boolean; required: boolean; setupCodeNeeded: boolean }
  calls: { method: string; path: string; body: unknown }[]
}

/** Routes every /admin/v1 call to the mock. Returns the mutable state and call log. */
export async function mockApi(page: Page, opts: MockOptions = {}): Promise<MockState> {
  const state: MockState = {
    ...seed(),
    signedIn: opts.signedIn ?? false,
    role: opts.role ?? 'MANAGER',
    twoStep: {
      enabled: opts.twoStep === 'on',
      required: opts.twoStep === 'required' || opts.twoStep === 'required-with-code',
      setupCodeNeeded: opts.twoStep === 'required-with-code',
    },
    calls: [],
  }

  // Product photos are served by the customer API (public).
  await page.route('**/v1/products/*/photo**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: TINY_PNG }))

  await page.route('**/admin/v1/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname.replace(/^.*\/admin\/v1/, '')
    const method = req.method()
    let body: unknown = undefined
    try {
      body = req.postDataJSON()
    } catch {
      body = req.postData()
    }
    state.calls.push({ method, path, body })

    if (path === '/auth/config') return json(route, 200, { googleClientId: null })
    if (path === '/auth/refresh') return state.signedIn ? json(route, 200, { accessToken: 'tok' }) : json(route, 401, { error: { code: 'INVALID_TOKEN', message: 'No session', requestId: 'req_x' } })
    if (path === '/auth/login') {
      const b = body as { email?: string; password?: string }
      if (b?.password === 'correct') {
        if (state.twoStep.enabled) return json(route, 200, { twoStep: true, ticket: 'ticket-0123456789abcdef', expiresIn: 300 })
        state.signedIn = true
        return json(route, 200, { accessToken: 'tok' })
      }
      return json(route, 401, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials', requestId: 'req_y' } })
    }
    if (path === '/auth/two-step') {
      const b = body as { code: string }
      if (b.code === '123456' || b.code === 'abcd-efgh') {
        state.signedIn = true
        return json(route, 200, { accessToken: 'tok' })
      }
      return json(route, 422, { error: { code: 'WRONG_CODE', message: 'That code is not right. Check the app and try again.', requestId: 'req_t', triesLeft: 4 } })
    }
    if (path === '/auth/logout') {
      state.signedIn = false
      return route.fulfill({ status: 204 })
    }
    if (!state.signedIn) return json(route, 401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: 'req_z' } })
    if (path === '/auth/me') return json(route, 200, { email: EMAIL[state.role], role: state.role, twoStep: state.twoStep })
    if (path === '/me/two-step/setup' && state.twoStep.setupCodeNeeded && (body as { setupCode?: string })?.setupCode !== 'k7qd-2mxp') {
      return json(route, 422, { error: { code: 'WRONG_SETUP_CODE', message: 'That setup code is not right, or it has expired. Ask a manager for a new one.', requestId: 'req_c' } })
    }
    if (path === '/me/two-step/setup') return json(route, 200, { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/MandiMangoes%20Ops%3Amanager%40mandimangoes.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=MandiMangoes%20Ops' })
    if (path === '/me/two-step/enable') {
      if ((body as { code: string }).code !== '123456') return json(route, 422, { error: { code: 'WRONG_CODE', message: 'That code is not right.', requestId: 'req_e' } })
      state.twoStep = { ...state.twoStep, enabled: true }
      return json(route, 200, { recoveryCodes: ['abcd-efgh', 'jkmn-pqrs', 'tuvw-xyz2', '3456-789a', 'bcde-fghj', 'kmnp-qrst', 'uvwx-yz23', '4567-89ab', 'cdef-ghjk', 'mnpq-rstu'], accessToken: 'tok', expiresIn: 900 })
    }
    if (path === '/me/password') {
      const b = body as { currentPassword: string; newPassword: string }
      if (b.currentPassword !== 'correct') return json(route, 422, { error: { code: 'WRONG_PASSWORD', message: 'Your current password is not right.', requestId: 'req_p' } })
      return json(route, 200, { accessToken: 'tok2', expiresIn: 900 })
    }
    if (path === '/me/two-step/disable') {
      state.twoStep = { ...state.twoStep, enabled: false }
      return route.fulfill({ status: 204 })
    }
    if (state.twoStep.required && !state.twoStep.enabled) return json(route, 403, { error: { code: 'TWO_STEP_SETUP_REQUIRED', message: 'Set up two-step sign-in first', requestId: 'req_s' } })
    if (path === '/staff/sign-out-all') {
      if (state.role !== 'MANAGER') return json(route, 403, { error: { code: 'FORBIDDEN', message: 'Requires manager role', requestId: 'req_f' } })
      return json(route, 200, { signedOut: state.staff.length - 1, keptMe: (body as { keepMe?: boolean })?.keepMe !== false })
    }
    if (/^\/staff\/[^/]+\/two-step\/reset$/.test(path)) {
      const staffId = path.split('/')[2]
      state.staff = state.staff.map((s) => (s.id === staffId ? { ...s, twoStep: false } : s))
      return json(route, 200, { setupCode: 'rstu-vwxy' })
    }
    if (/^\/staff\/[^/]+\/two-step\/setup-code$/.test(path)) return json(route, 200, { setupCode: 'abcd-2345' })

    if (path === '/staff' && method === 'GET') return json(route, 200, state.staff)
    if (path === '/staff' && method === 'POST') {
      const b = body as { email: string; role: Role }
      const s: StaffMember = { id: `adm${state.staff.length + 1}`, email: b.email, role: b.role, createdAt: '2026-10-16T06:00:00Z' }
      state.staff = [...state.staff, s]
      return json(route, 201, { ...s, setupCode: 'mnpq-7890' })
    }
    if (/^\/staff\/[^/]+$/.test(path)) {
      const staffId = path.split('/')[2]
      if (method === 'DELETE') {
        state.staff = state.staff.filter((s) => s.id !== staffId)
        return route.fulfill({ status: 204 })
      }
      state.staff = state.staff.map((s) => (s.id === staffId ? { ...s, ...((body as { role?: Role }).role ? { role: (body as { role: Role }).role } : {}) } : s))
      return json(route, 200, state.staff.find((s) => s.id === staffId))
    }
    if (path === '/audit') {
      const who = url.searchParams.get('staff')
      const items = who ? state.audit.filter((a) => a.email === who) : state.audit
      return json(route, 200, { page: 1, pageSize: 50, total: items.length, items, staff: state.staff.map(({ email, role }) => ({ email, role })) })
    }

    if (path === '/summary') return json(route, 200, state.summary)
    if (path === '/attention') return json(route, 200, state.attention)
    // Manager ways out of Needs attention items (src/admin/recovery.js). Each takes the item off the list.
    const managerOnly = () => json(route, 403, { error: { code: 'FORBIDDEN', message: 'Requires manager role', requestId: 'req_f' } })
    const repair = /^\/batches\/([^/]+)\/lines\/([^/]+)\/repair$/.exec(path)
    if (repair) {
      if (state.role !== 'MANAGER') return managerOnly()
      const d = (state.attention.ledgerDrift ?? []).find((x) => x.lineId === repair[2])
      const plan = d
        ? {
            lineId: d.lineId, batchId: d.batchId, sku: d.sku, drifting: true, canRepair: true, problem: null,
            before: { onHand: d.onHand[0], reserveBuffer: d.reserveBuffer[0], held: d.held[0], committed: d.committed[0] },
            after: { onHand: d.onHand[1], reserveBuffer: d.reserveBuffer[1], held: d.held[1], committed: d.committed[1] },
          }
        : { lineId: repair[2], batchId: repair[1], drifting: false, before: null, after: null, canRepair: false, problem: null }
      if (method === 'GET') return json(route, 200, plan)
      state.attention = { ...state.attention, ledgerDrift: (state.attention.ledgerDrift ?? []).filter((x) => x.lineId !== repair[2]) }
      return json(route, 200, { ...plan, repaired: true })
    }
    const hookAct = /^\/webhook-failures\/([^/]+)\/(resolve|refund)$/.exec(path)
    if (hookAct) {
      if (state.role !== 'MANAGER') return managerOnly()
      state.attention = { ...state.attention, webhookFailures: state.attention.webhookFailures.filter((w) => w.id !== hookAct[1]) }
      return json(route, 200, hookAct[2] === 'refund' ? { paymentId: 'pay_x', queued: true } : { id: hookAct[1] })
    }
    if (/^\/preorders\/[^/]+\/keep$/.test(path)) {
      if (state.role !== 'MANAGER') return managerOnly()
      state.attention = { ...state.attention, preorderDecisions: (state.attention.preorderDecisions ?? []).filter((p) => p.id !== path.split('/')[2]) }
      return json(route, 200, { id: path.split('/')[2], kept: true })
    }
    if (/^\/refunds\/[^/]+\/paid-another-way$/.test(path)) {
      if (state.role !== 'MANAGER') return managerOnly()
      const refundId = path.split('/')[2]
      if (((body as { reference?: string })?.reference ?? '').length < 3) {
        return json(route, 400, { error: { code: 'VALIDATION_ERROR', message: 'Give the reference of the payment you made', requestId: 'req_v' } })
      }
      state.attention = { ...state.attention, stuckRefunds: state.attention.stuckRefunds.filter((r) => r.id !== refundId && r.paymentId !== refundId) }
      return json(route, 200, { id: refundId, refundId: `manual:${(body as { reference: string }).reference}` })
    }
    if (/^\/notifications\/[^/]+\/retry$/.test(path)) return route.fulfill({ status: 204 })
    if (path === '/products' && method === 'GET') return json(route, 200, state.products)
    if (path === '/products' && method === 'POST') {
      const b = body as Product
      if (state.products.some((x) => x.sku === b.sku)) return json(route, 409, { error: { code: 'PRODUCT_EXISTS', message: 'A product with that SKU already exists', requestId: 'req_p' } })
      const made: Product = { ...b, active: true }
      state.products = [...state.products, made]
      return json(route, 201, made)
    }
    if (/^\/products\/[^/]+\/photo$/.test(path)) {
      const sku = decodeURIComponent(path.split('/')[2])
      const photoUrl = method === 'DELETE' ? null : `/v1/products/${sku}/photo?v=${Date.now()}`
      state.products = state.products.map((x) => (x.sku === sku ? { ...x, photoUrl } : x))
      return json(route, 200, state.products.find((x) => x.sku === sku))
    }
    if (/^\/products\/[^/]+$/.test(path)) {
      const sku = decodeURIComponent(path.split('/')[2])
      if (method === 'DELETE') {
        const used = sku !== 'KES-3'
        state.products = used ? state.products.map((x) => (x.sku === sku ? { ...x, active: false } : x)) : state.products.filter((x) => x.sku !== sku)
        return json(route, 200, { sku, outcome: used ? 'hidden' : 'deleted' })
      }
      state.products = state.products.map((x) => (x.sku === sku ? { ...x, ...(body as object) } : x))
      return json(route, 200, state.products.find((x) => x.sku === sku))
    }
    if (path === '/batches' && method === 'GET') return json(route, 200, state.batches)
    if (path === '/batches' && method === 'POST') return json(route, 201, { ...state.batch, id: 'b-new', status: 'ARRIVING', qc: [] })
    if (/^\/batches\/[^/]+$/.test(path)) return json(route, 200, state.batch)
    if (/\/ledger$/.test(path)) return json(route, 200, state.ledger)
    if (/^\/batches\/[^/]+\/status$/.test(path)) {
      const { status: s, reason } = body as { status: string; reason?: string }
      if (s === 'CONDEMNED') return json(route, 200, { rebalancedOrders: ['ORD-1042'], atRiskOrders: ['ORD-1043'] })
      // Writing off boxes still on hand needs a manager and a reason (mirrors the API).
      if (s === 'EXHAUSTED' && state.batch.lines.some((l) => l.onHand > 0)) {
        if (state.role !== 'MANAGER') return json(route, 403, { error: { code: 'FORBIDDEN', message: 'Only a manager can write them off.', requestId: 'req_x' } })
        if (!reason) return json(route, 400, { error: { code: 'REASON_REQUIRED', message: 'Say why', requestId: 'req_x' } })
      }
      state.batch = { ...state.batch, status: s }
      return route.fulfill({ status: 204 })
    }
    if (/\/qc$/.test(path)) return json(route, 201, { id: 'q2', warning: 'QC already logged today by this user' })
    if (/\/lines\/[^/]+\/short-arrival$/.test(path)) {
      return json(route, 200, { refilled: [], moved: [{ number: 'ORD-1044', deliveryDate: '2026-10-17' }], atRisk: [] })
    }
    if (/\/lines\//.test(path)) return route.fulfill({ status: 204 })

    if (path === '/orders') return json(route, 200, state.orders)
    if (path === '/orders/o1') return json(route, 200, state.order)
    if (path === '/orders/o2') return json(route, 200, state.deliveredOrder)
    if (path === '/orders/bulk-reschedule') {
      const picked = [
        { id: 'o1', number: 'ORD-1042', customerName: 'Asha Rao', pincode: '400001' },
        { id: 'o3', number: 'ORD-1044', customerName: 'Vikram Shah', pincode: '400001' },
      ]
      if ((body as { dryRun?: boolean }).dryRun) return json(route, 200, { matched: 2, orders: picked, moved: [], notMoved: [] })
      return json(route, 200, {
        matched: 2,
        orders: picked,
        moved: [{ ...picked[0], deliveryDate: '2026-10-16' }],
        notMoved: [{ ...picked[1], reason: 'No stock on 2026-10-16 or any later open date' }],
      })
    }
    if (/^\/orders\/[^/]+\/returned-stock$/.test(path)) return json(route, 200, { boxes: 2 })
    if (/^\/orders\/[^/]+\/status$/.test(path)) {
      // DELIVERED from the panel is a manager's override with a reason (mirrors the API).
      const b = body as { status: string; override?: boolean; reason?: string }
      if (b.override && state.role !== 'MANAGER') return json(route, 403, { error: { code: 'FORBIDDEN', message: 'Only a manager can override this', requestId: 'req_x' } })
      if (b.status === 'DELIVERED' && !b.override) return json(route, 403, { error: { code: 'FORBIDDEN', message: 'Only a manager can mark it delivered without proof.', requestId: 'req_x' } })
      if (b.override && !b.reason) return json(route, 400, { error: { code: 'REASON_REQUIRED', message: 'Say why', requestId: 'req_x' } })
      // Pack list orders move on too; PACKED needs every box packed first (mirrors the API's NOT_ALLOCATED).
      const packing = state.packList.find((o) => o.id === path.split('/')[2])
      if (packing) {
        if (b.status === 'PACKED' && !packing.items.every((it) => it.picks.length > 0 && it.picks.every((pk) => pk.packed))) {
          return json(route, 400, { error: { code: 'NOT_ALLOCATED', message: 'Allocate the stock before marking the order packed', requestId: 'req_x' } })
        }
        packing.status = b.status
      }
      return route.fulfill({ status: 204 })
    }
    if (/^\/orders\/[^/]+\/allocate$/.test(path)) {
      // Picks every box from b1 and packs it, without moving the order on (mirrors allocateOrder).
      const packing = state.packList.find((o) => o.id === path.split('/')[2])
      if (packing) {
        packing.items = packing.items.map((it) => ({
          ...it,
          picks: [{ batchId: 'b1', variety: 'Alphonso', pluckedOn: '2026-10-08', quantity: it.quantity, packed: true }],
        }))
      }
      return route.fulfill({ status: 204 })
    }
    if (/^\/orders\/[^/]+\/(cancel|reschedule)$/.test(path)) return route.fulfill({ status: 204 })

    if (path === '/pack-list') return json(route, 200, state.packList)
    if (path === '/manifest') return json(route, 200, state.manifest)
    // Giving stops to riders (SEC-02).
    if (path === '/riders') return json(route, 200, [{ id: 'adm9', email: 'rider@mandimangoes.test' }])
    if (path === '/manifest/assign') {
      const b = body as { riderId: string | null; orderIds?: string[] }
      const assigned: string[] = []
      for (const o of state.manifest.runs.flatMap((r) => r.stops.flatMap((st) => st.orders)) as { id: string; number: string; rider?: unknown }[]) {
        if (b.orderIds && !b.orderIds.includes(o.id)) continue
        o.rider = b.riderId ? { id: b.riderId, email: 'rider@mandimangoes.test' } : null
        assigned.push(o.number)
      }
      return json(route, 200, { assigned })
    }
    if (path === '/manifest/dispatch') {
      const dispatched: string[] = []
      for (const o of state.manifest.runs.flatMap((r) => r.stops.flatMap((st) => st.orders))) {
        if (o.status === 'PACKED') {
          o.status = 'OUT_FOR_DELIVERY'
          dispatched.push(o.number)
        }
      }
      return json(route, 200, { dispatched, skipped: [{ number: 'ORD-1044', reason: 'Not packed yet' }] })
    }
    if (/^\/orders\/[^/]+\/delivery-photos$/.test(path)) return json(route, 201, { id: 'dph9' })
    if (/^\/orders\/[^/]+\/delivery-photos\/[^/]+$/.test(path)) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL })
    }
    if (/^\/orders\/[^/]+\/delivery$/.test(path)) {
      const b = body as { outcome: string; code?: string }
      if (b.outcome === 'DELIVERED' && b.code && b.code !== '4821') {
        return json(route, 422, { error: { code: 'WRONG_CODE', message: 'That code is not right. 4 tries left.', requestId: 'req_c', triesLeft: 4 } })
      }
      const o = state.manifest.runs.flatMap((r) => r.stops.flatMap((st) => st.orders)).find((x) => x.id === path.split('/')[2])
      if (o) o.status = b.outcome === 'DELIVERED' ? 'DELIVERED' : 'DELIVERY_FAILED'
      return json(route, 200, { outcome: b.outcome })
    }
    if (path === '/analytics') return json(route, 200, state.analytics)
    if (path === '/claims') return json(route, 200, state.claims)
    if (/^\/claims\/[^/]+\/photos\/[^/]+$/.test(path)) return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL })
    if (/^\/claims\/[^/]+\/(review|resolve)$/.test(path)) return route.fulfill({ status: 204 })

    if (path === '/reviews' || path.startsWith('/reviews/')) {
      const moderator = state.role === 'MANAGER' || state.role === 'OPERATOR'
      if (path === '/reviews/insights') return state.role === 'PACKER' || state.role === 'RIDER' ? json(route, 403, { error: { code: 'FORBIDDEN', message: 'Not available', requestId: 'req_f' } }) : json(route, 200, state.reviewInsights)
      if (!moderator) return json(route, 403, { error: { code: 'FORBIDDEN', message: 'Not available to your role', requestId: 'req_f' } })
      if (path === '/reviews') {
        const status = url.searchParams.get('status') ?? 'PENDING'
        const flagged = url.searchParams.get('flagged')
        const items = state.reviews.filter((r) => r.status === status && (flagged == null || String(r.flagged) === flagged))
        const counts: Record<string, { total: number; flagged: number }> = {}
        for (const r of state.reviews) {
          counts[r.status] ??= { total: 0, flagged: 0 }
          counts[r.status].total++
          if (r.flagged) counts[r.status].flagged++
        }
        return json(route, 200, { items, nextCursor: null, counts })
      }
      if (path === '/reviews/bulk') {
        const b = body as { action: 'approve' | 'reject'; ids: string[]; reason?: string }
        const done: string[] = []
        for (const r of state.reviews) if (b.ids.includes(r.id) && r.status === 'PENDING') {
          r.status = b.action === 'approve' ? 'APPROVED' : 'REJECTED'
          r.moderationReason = b.reason ?? null
          done.push(r.id)
        }
        return json(route, 200, { done, failed: [] })
      }
      if (/^\/reviews\/[^/]+\/photos\/[^/]+$/.test(path)) return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL })
      const rid = path.split('/')[2]
      const r = state.reviews.find((x) => x.id === rid)
      if (!r) return json(route, 404, { error: { code: 'NOT_FOUND', message: 'Review not found', requestId: 'req_r' } })
      const act = path.split('/')[3]
      if (!act) {
        return json(route, 200, {
          ...r,
          events: [{ from: null, to: 'PENDING', actor: 'customer:cus1', reason: r.flagged ? 'flagged: PHONE' : null, at: r.createdAt }],
          batches: [{ batchId: 'b1', quantity: 1, variety: 'Alphonso', pluckedOn: '2026-10-08', farm: 'Ratnagiri' }],
        })
      }
      if (act === 'approve') {
        if (r.status !== 'PENDING') return json(route, 409, { error: { code: 'INVALID_TRANSITION', message: 'Not pending', requestId: 'req_t' } })
        const ids = (body as { photoIds: string[] }).photoIds
        r.status = 'APPROVED'
        r.photos = r.photos.map((ph) => ({ ...ph, approved: ids.includes(ph.id) }))
      }
      if (act === 'reject' || act === 'hide') {
        r.status = act === 'reject' ? 'REJECTED' : 'HIDDEN'
        r.moderationReason = (body as { reason: string }).reason
      }
      if (act === 'reply') {
        if (method === 'DELETE') {
          r.reply = null
          return route.fulfill({ status: 204 })
        }
        r.reply = { body: (body as { body: string }).body, at: '2026-10-16T06:00:00Z', by: EMAIL[state.role] }
      }
      return json(route, 200, r)
    }

    if (path === '/promos' || path.startsWith('/promos/')) {
      if (state.role !== 'MANAGER') return json(route, 403, { error: { code: 'FORBIDDEN', message: 'Requires manager role', requestId: 'req_f' } })
      if (method === 'GET') return json(route, 200, state.promos)
      if (method === 'POST') {
        const b = body as Partial<Promo> & { code: string }
        if (state.promos.some((x) => x.code === b.code.toUpperCase())) return json(route, 409, { error: { code: 'PROMO_EXISTS', message: 'That code already exists', requestId: 'req_p' } })
        const promo: Promo = { maxDiscount: null, minSubtotal: 0, startsOn: null, endsOn: null, maxUses: null, perCustomer: 1, firstOrderOnly: false, description: null, kind: 'PERCENT', value: 0, ...b, code: b.code.toUpperCase(), active: true, uses: 0, discountGiven: 0, createdBy: EMAIL.MANAGER, createdAt: '2026-10-17T05:00:00Z' }
        state.promos = [promo, ...state.promos]
        return json(route, 201, promo)
      }
      const code = decodeURIComponent(path.split('/')[2])
      state.promos = state.promos.map((x) => (x.code === code ? { ...x, ...(body as object) } : x))
      return json(route, 200, state.promos.find((x) => x.code === code))
    }
    if (path === '/pincodes' && method === 'GET') return json(route, 200, state.pincodes)
    if (path === '/pincodes' && method === 'POST') return json(route, 201, { ...(body as object), active: true })
    if (/^\/pincodes\//.test(path)) return route.fulfill({ status: 204 })

    if (path === '/coverage') return json(route, 200, state.coverage)
    if (path === '/preorders') {
      const status = url.searchParams.get('status')
      return json(route, 200, status ? state.preorders.filter((p) => p.status === status) : state.preorders)
    }
    if (/^\/preorders\/[^/]+\/cancel$/.test(path)) {
      if (state.role !== 'MANAGER') return json(route, 403, { error: { code: 'FORBIDDEN', message: 'Requires manager role', requestId: 'req_f' } })
      const p = state.preorders.find((x) => x.id === path.split('/')[2])
      if (p) p.status = 'CANCELLED'
      return json(route, 200, { refunded: p?.paymentStatus === 'SUCCEEDED' })
    }
    if (/^\/delivery-reviews\/[^/]+$/.test(path)) {
      state.attention = { ...state.attention, photoDeliveries: (state.attention.photoDeliveries ?? []).filter((d) => d.id !== path.split('/')[2]) }
      return route.fulfill({ status: 204 })
    }
    if (path === '/preorder-capacity') return json(route, 200, state.preorderCapacity)
    if (path.startsWith('/preorder-capacity/')) {
      if (state.role !== 'MANAGER') return json(route, 403, { error: { code: 'FORBIDDEN', message: 'Requires manager role', requestId: 'req_f' } })
      return json(route, 200, body)
    }
    if (path === '/slots' && method === 'GET') return json(route, 200, state.slots)
    if (path === '/slots' || path.startsWith('/slots/')) {
      if (state.role !== 'MANAGER') return json(route, 403, { error: { code: 'FORBIDDEN', message: 'Requires manager role', requestId: 'req_f' } })
      if (method === 'POST') {
        const slot = { id: `slt${state.slots.length + 1}`, active: true, sort: state.slots.length, ...(body as object) } as (typeof state.slots)[number]
        state.slots = [...state.slots, slot]
        return json(route, 201, slot)
      }
      const slotId = path.split('/')[2]
      state.slots = state.slots.map((x) => (x.id === slotId ? { ...x, ...(body as object) } : x))
      return json(route, 200, state.slots.find((x) => x.id === slotId))
    }
    if (path === '/calendar') return json(route, 200, state.calendar)
    if (/^\/calendar\//.test(path)) return route.fulfill({ status: 204 })
    if (path === '/config' && method === 'GET') return json(route, 200, state.config)
    if (path === '/config' && method === 'PUT') {
      if (state.role !== 'MANAGER') return json(route, 403, { error: { code: 'FORBIDDEN', message: 'Requires manager role', requestId: 'req_f' } })
      state.config = { version: state.config.version + 1, rules: (body as { rules: typeof state.config.rules }).rules }
      return json(route, 200, state.config)
    }

    return json(route, 404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'req_404' } })
  })

  return state
}

/** A 1x1 orange PNG. */
export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')
