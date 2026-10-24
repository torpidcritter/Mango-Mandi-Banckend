// Every HTTP call to mango-api goes through request<T>() here.
//
// The access token lives only in this module's closure: never in storage,
// never logged. The refresh token is the httpOnly `mango_admin_rt` cookie,
// invisible to JS, so auth calls send credentials and let the browser carry it.

import { ApiError, errorFrom, parseAnswer } from './apiAnswer'
import type {
  BatchDetail,
  Analytics,
  Attention,
  LedgerRepairPlan,
  LineCounters,
  AuditPage,
  BulkMoveResult,
  ShortArrivalResult,
  Manifest,
  Rider,
  BatchListItem,
  BatchStatus,
  Claim,
  ClaimResolution,
  ClaimStatus,
  Condition,
  LedgerEntry,
  AdjustReason,
  Me,
  SignInResult,
  Promo,
  NewPromo,
  OrderDetail,
  OrderListItem,
  OrderStatus,
  PackListOrder,
  Paged,
  Pincode,
  Product,
  ProductInput,
  Ripeness,
  Rules,
  RulesVersion,
  CalendarDay,
  CoverageDay,
  FailReason,
  DeliverySlot,
  Preorder,
  PreorderCapacity,
  PreorderStatus,
  Review,
  ReviewDetail,
  ReviewFilters,
  ReviewInsights,
  ReviewQueue,
  Role,
  StaffMember,
  Summary,
} from './types'

export const API_URL: string = (import.meta.env.VITE_API_URL ?? '').trim().replace(/\/+$/, '')
const BASE = `${API_URL}/admin/v1`

export const SIGNOUT_EVENT = 'admin:signout'

export { ApiError }

let accessToken: string | null = null
let refreshPromise: Promise<'ok' | 'refused' | 'unavailable'> | null = null

async function toApiError(res: Response): Promise<ApiError> {
  return errorFrom(res.status, res.statusText, await res.text().catch(() => ''))
}

/**
 * One shared refresh: a burst of parallel 401s issues a single refresh call.
 * 'refused' only when the API says the refresh cookie is no good (401); a busy
 * API (503), a proxy error or being offline is 'unavailable', which must not
 * sign anyone out.
 */
type Refresh = 'ok' | 'refused' | 'unavailable'
function refreshOnce(): Promise<Refresh> {
  if (!refreshPromise) {
    refreshPromise = (async (): Promise<Refresh> => {
      try {
        const res = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' })
        if (res.status === 401) return 'refused'
        if (!res.ok) return 'unavailable'
        const data = (await res.json()) as { accessToken?: string }
        if (!data.accessToken) return 'refused'
        accessToken = data.accessToken
        return 'ok'
      } catch {
        return 'unavailable'
      }
    })().finally(() => {
      refreshPromise = null
    })
  }
  return refreshPromise
}

function signOutLocally() {
  accessToken = null
  window.dispatchEvent(new CustomEvent(SIGNOUT_EVENT, { detail: { reason: 'expired' } }))
}

/** A Blob body is sent as-is (photos); anything else as JSON. */
async function send(method: string, path: string, body?: unknown, retried = false): Promise<Response> {
  const headers: Record<string, string> = {}
  const blob = body instanceof Blob
  if (body !== undefined) headers['Content-Type'] = blob ? body.type : 'application/json'
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : blob ? body : JSON.stringify(body),
  })

  if (res.status === 401 && !retried) {
    const refreshed = await refreshOnce()
    if (refreshed === 'ok') return send(method, path, body, true)
    if (refreshed === 'unavailable') throw new ApiError(503, 'UNAVAILABLE', 'The server is busy or unreachable. Please try again in a minute.')
    signOutLocally()
    throw new ApiError(401, 'SESSION_ENDED', 'Your session has ended. Please sign in again.')
  }
  if (!res.ok) throw await toApiError(res)
  return res
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, body)
  if (res.status === 204) return undefined as T
  return parseAnswer<T>(res.status, await res.text())
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

const id = encodeURIComponent

/** Password, Google or the second step: either a session or a ticket for the code. */
async function firstStep(path: string, body: unknown): Promise<SignInResult> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await toApiError(res)
  const data = (await res.json()) as { accessToken?: string; twoStep?: boolean; ticket?: string }
  if (data.twoStep && data.ticket) return { ticket: data.ticket }
  accessToken = data.accessToken ?? null
  return { me: await request<Me>('GET', '/auth/me') }
}

export const api = {
  /** Restores a session from the refresh cookie. Returns null if there is none. */
  async bootstrap(): Promise<Me | null> {
    if (!API_URL) return null
    if ((await refreshOnce()) !== 'ok') return null
    try {
      return await request<Me>('GET', '/auth/me')
    } catch {
      accessToken = null
      return null
    }
  },

  async login(email: string, password: string): Promise<SignInResult> {
    return firstStep('/auth/login', { email, password })
  },

  /** The code from the authenticator app (or a recovery code) after the password or Google. */
  async twoStep(ticket: string, code: string): Promise<Me> {
    const r = await firstStep('/auth/two-step', { ticket, code })
    if (!('me' in r)) throw new ApiError(401, 'TICKET_EXPIRED', 'Sign in again.')
    return r.me
  },

  /** Whether "Sign in with Google" is set up. */
  async authConfig(): Promise<{ googleClientId: string | null }> {
    if (!API_URL) return { googleClientId: null }
    const res = await fetch(`${BASE}/auth/config`)
    if (!res.ok) return { googleClientId: null }
    return (await res.json()) as { googleClientId: string | null }
  },

  async loginWithGoogle(credential: string): Promise<SignInResult> {
    return firstStep('/auth/google', { credential })
  },

  /** Starts setting up two-step sign-in: the secret for the authenticator app. */
  twoStepSetup: (setupCode?: string) =>
    request<{ secret: string; otpauthUrl: string }>('POST', '/me/two-step/setup', setupCode ? { setupCode } : {}),
  /** Confirms a code from the app. Returns the recovery codes, shown this once. */
  async twoStepEnable(code: string): Promise<string[]> {
    const r = await request<{ recoveryCodes: string[]; accessToken: string }>('POST', '/me/two-step/enable', { code })
    accessToken = r.accessToken
    return r.recoveryCodes
  },
  twoStepDisable: (code: string) => request<void>('POST', '/me/two-step/disable', { code }),
  /** Changes your own password. Your other sessions end; this one carries on with a new token. */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const r = await request<{ accessToken: string }>('POST', '/me/password', { currentPassword, newPassword })
    accessToken = r.accessToken
  },
  me: () => request<Me>('GET', '/auth/me'),
  /** Clears someone's two-step sign-in. Returns the setup code they need to set it up again (shown once). */
  resetTwoStep: (staffId: string) => request<{ setupCode: string }>('POST', `/staff/${id(staffId)}/two-step/reset`),
  /** A new setup code for someone who hasn't set up two-step sign-in yet (shown once). */
  newSetupCode: (staffId: string) => request<{ setupCode: string }>('POST', `/staff/${id(staffId)}/two-step/setup-code`),

  /** Best-effort: a network failure still clears the local token. */
  async logout(): Promise<void> {
    try {
      await fetch(`${BASE}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      })
    } catch {
      // ignore
    }
    accessToken = null
    window.dispatchEvent(new CustomEvent(SIGNOUT_EVENT, { detail: { reason: 'logout' } }))
  },

  summary: () => request<Summary>('GET', '/summary'),
  attention: () => request<Attention>('GET', '/attention'),
  retryMessage: (notificationId: string) => request<void>('POST', `/notifications/${id(notificationId)}/retry`),
  // Manager ways out of Needs attention items. Each needs a reason and is written to the staff activity.
  ledgerRepairPlan: (batchId: string, lineId: string) => request<LedgerRepairPlan>('GET', `/batches/${id(batchId)}/lines/${id(lineId)}/repair`),
  repairLedger: (batchId: string, lineId: string, reason: string, expected: LineCounters) =>
    request<LedgerRepairPlan>('POST', `/batches/${id(batchId)}/lines/${id(lineId)}/repair`, { reason, expected }),
  resolveWebhookFailure: (failureId: string, note: string) => request<unknown>('POST', `/webhook-failures/${id(failureId)}/resolve`, { note }),
  refundUnmatchedPayment: (failureId: string, reason: string) =>
    request<{ paymentId: string; queued: boolean }>('POST', `/webhook-failures/${id(failureId)}/refund`, { reason }),
  keepPreorder: (preorderId: string, reason: string) => request<unknown>('POST', `/preorders/${id(preorderId)}/keep`, { reason }),
  refundPaidAnotherWay: (type: 'order' | 'preorder' | 'payment', refundId: string, reference: string, reason: string) =>
    request<{ id: string; refundId: string }>('POST', `/refunds/${id(refundId)}/paid-another-way`, { type, reference, reason }),
  signOutAllStaff: (reason: string, keepMe = true) => request<{ signedOut: number; keptMe: boolean }>('POST', '/staff/sign-out-all', { reason, keepMe }),
  /** Signs off a photo delivery, or flags it as doubtful (with a note) for a call to the customer. */
  reviewDelivery: (attemptId: string, ok: boolean, note?: string) => request<void>('POST', `/delivery-reviews/${id(attemptId)}`, { ok, note }),
  products: () => request<Product[]>('GET', '/products'),
  addProduct: (p: ProductInput & { sku: string }) => request<Product>('POST', '/products', p),
  /** `reason`: why (optional), kept in the staff activity with the values before the change (ADM-2). */
  updateProduct: (sku: string, patch: Partial<ProductInput> & { active?: boolean; reason?: string }) => request<Product>('PATCH', `/products/${id(sku)}`, patch),
  /** Deletes a product never stocked or sold; otherwise takes it off sale and keeps it. */
  removeProduct: (sku: string) => request<{ sku: string; outcome: 'deleted' | 'hidden' }>('DELETE', `/products/${id(sku)}`),
  /** Sets the product's shop photo (replacing any earlier one). */
  setProductPhoto: (sku: string, photo: Blob) => request<Product>('PUT', `/products/${id(sku)}/photo`, photo),
  removeProductPhoto: (sku: string) => request<Product>('DELETE', `/products/${id(sku)}/photo`),

  batches: (status?: BatchStatus | null) =>
    request<BatchListItem[]>('GET', `/batches${qs({ status })}`),
  batch: (batchId: string) => request<BatchDetail>('GET', `/batches/${id(batchId)}`),
  ledger: (batchId: string) => request<LedgerEntry[]>('GET', `/batches/${id(batchId)}/ledger`),
  createBatch: (input: {
    variety: string
    pluckedOn: string
    farm?: string
    lines: { sku: string; onHand: number }[]
  }) => request<BatchDetail>('POST', '/batches', input),
  /**
   * 204 for normal moves. CONDEMNED returns the orders moved to other batches
   * and the ones left at-risk; no order is cancelled.
   */
  setBatchStatus: (batchId: string, status: BatchStatus, reason?: string) =>
    request<{ rebalancedOrders?: string[]; atRiskOrders?: string[] } | undefined>(
      'PATCH',
      `/batches/${id(batchId)}/status`,
      reason ? { status, reason } : { status },
    ),
  logQc: (batchId: string, input: { ripenessRating: Ripeness; condition: Condition; notes?: string }) =>
    request<{ id: string; warning?: string }>('POST', `/batches/${id(batchId)}/qc`, input),
  adjustLine: (
    batchId: string,
    lineId: string,
    input: { onHand?: number; reserveBuffer?: number; reason: string; reasonCode?: AdjustReason },
  ) => request<void>('PATCH', `/batches/${id(batchId)}/lines/${id(lineId)}`, input),
  /**
   * Fewer boxes arrived than were already promised: lowers on hand, takes boxes
   * back from the youngest orders and re-fills them or moves them to the next date with stock.
   */
  shortArrival: (batchId: string, lineId: string, input: { onHand: number; reason: string; reasonCode?: AdjustReason }) =>
    request<ShortArrivalResult>('POST', `/batches/${id(batchId)}/lines/${id(lineId)}/short-arrival`, input),

  orders: (f: { status?: string | null; from?: string | null; to?: string | null; q?: string | null; page?: number }) =>
    request<Paged<OrderListItem>>('GET', `/orders${qs(f)}`),
  order: (orderId: string) => request<OrderDetail>('GET', `/orders/${id(orderId)}`),
  /**
   * A status move. DELIVERED without the customer's code or a photo, sending out
   * at-risk stock, or a retry after the last attempt need a manager's override with a reason.
   */
  setOrderStatus: (orderId: string, status: OrderStatus, override?: { reason: string }) =>
    request<void>('PATCH', `/orders/${id(orderId)}/status`, override ? { status, override: true, reason: override.reason } : { status }),
  allocate: (orderId: string) => request<void>('POST', `/orders/${id(orderId)}/allocate`),
  /** A paid order can only be cancelled by a manager, with a full refund (refund: true). */
  cancelOrder: (orderId: string, reason: string, refund = false) =>
    request<void>('POST', `/orders/${id(orderId)}/cancel`, { reason, refund }),
  /** Boxes back from an order cancelled or returned after dispatch: back on the shelf, or written off with a reason. */
  bookReturnedStock: (orderId: string, input: { action: 'RESTOCK' | 'WRITE_OFF'; reasonCode?: 'DAMAGED' | 'THEFT_LOSS' | 'OTHER'; reason: string }) =>
    request<{ boxes: number }>('POST', `/orders/${id(orderId)}/returned-stock`, input),
  /** Moves a confirmed order to another bookable date that has stock (409 if it doesn't), optionally into a slot. */
  rescheduleOrder: (orderId: string, deliveryDate: string, slotId?: string | null) =>
    request<void>('POST', `/orders/${id(orderId)}/reschedule`, slotId ? { deliveryDate, slotId } : { deliveryDate }),
  /** Moves every confirmed order on one date (optionally some pincodes) to another; managers only. */
  bulkReschedule: (input: { fromDate: string; toDate: string; pincodes?: string[]; reason: string; dryRun?: boolean }) =>
    request<BulkMoveResult>('POST', '/orders/bulk-reschedule', input),

  async packList(date: string): Promise<PackListOrder[]> {
    const res = await request<PackListOrder[] | { orders: PackListOrder[] }>(
      'GET',
      `/pack-list${qs({ date })}`,
    )
    return Array.isArray(res) ? res : (res?.orders ?? [])
  },

  analytics: (f: { from?: string | null; to?: string | null } = {}) => request<Analytics>('GET', `/analytics${qs(f)}`),
  manifest: (date: string) => request<Manifest>('GET', `/manifest${qs({ date })}`),
  /** Puts every packed order of a run (one slot, null for orders without one) out for delivery. */
  dispatchRun: (date: string, slotId: string | null) =>
    request<{ dispatched: string[]; skipped: { number: string; reason: string }[] }>('POST', '/manifest/dispatch', { date, slotId }),
  dispatch: (orderId: string) => request<void>('POST', `/orders/${id(orderId)}/dispatch`),
  /** A rider takes every packed stop on the date that nobody has yet, and sends them out with their own. */
  takeRun: (date: string) =>
    request<{ dispatched: string[]; skipped: { number: string; reason: string }[] }>('POST', '/manifest/dispatch', { date }),
  riders: () => request<Rider[]>('GET', '/riders'),
  /** Gives stops to a rider (null: to nobody): the listed orders, or every order still to deliver in a slot. */
  assignRiders: (input: { date: string; riderId: string | null; orderIds?: string[]; slotId?: string | null }) =>
    request<{ assigned: string[] }>('POST', '/manifest/assign', input),
  uploadDeliveryPhoto: (orderId: string, photo: Blob) => request<{ id: string }>('POST', `/orders/${id(orderId)}/delivery-photos`, photo),
  /** An object URL for a delivery photo (the image needs the staff sign-in, so it is fetched, not linked). */
  async deliveryPhotoUrl(orderId: string, photoId: string): Promise<string> {
    const res = await send('GET', `/orders/${id(orderId)}/delivery-photos/${id(photoId)}`)
    return URL.createObjectURL(await res.blob())
  },
  recordDelivery: (
    orderId: string,
    body:
      | { outcome: 'DELIVERED'; code?: string; photoId?: string; receivedBy?: string; lat?: number; lng?: number; attempt?: number }
      | { outcome: 'FAILED'; reason: FailReason; note?: string; photoId?: string; lat?: number; lng?: number; attempt?: number },
  ) => request<{ outcome: 'DELIVERED' | 'FAILED'; method?: string }>('POST', `/orders/${id(orderId)}/delivery`, body),

  claims: (status?: ClaimStatus | null) => request<Claim[]>('GET', `/claims${qs({ status })}`),
  /** An object URL for a claim photo (fetched with the staff sign-in). */
  async claimPhotoUrl(claimId: string, photoId: string): Promise<string> {
    const res = await send('GET', `/claims/${id(claimId)}/photos/${id(photoId)}`)
    return URL.createObjectURL(await res.blob())
  },
  reviews: (f: ReviewFilters) =>
    request<ReviewQueue>(
      'GET',
      `/reviews${qs({
        status: f.status,
        stars: f.stars,
        hasPhotos: f.hasPhotos == null ? null : String(f.hasPhotos),
        flagged: f.flagged == null ? null : String(f.flagged),
        variety: f.variety,
        cursor: f.cursor,
      })}`,
    ),
  review: (reviewId: string) => request<ReviewDetail>('GET', `/reviews/${id(reviewId)}`),
  approveReview: (reviewId: string, photoIds: string[], reason?: string | null) =>
    request<Review>('POST', `/reviews/${id(reviewId)}/approve`, { photoIds, reason: reason || null }),
  rejectReview: (reviewId: string, reason: string) => request<Review>('POST', `/reviews/${id(reviewId)}/reject`, { reason }),
  hideReview: (reviewId: string, reason: string) => request<Review>('POST', `/reviews/${id(reviewId)}/hide`, { reason }),
  bulkReviews: (action: 'approve' | 'reject', ids: string[], reason?: string | null) =>
    request<{ done: string[]; failed: { id: string; code: string; message: string }[] }>('POST', '/reviews/bulk', { action, ids, reason: reason || null }),
  replyToReview: (reviewId: string, body: string) => request<Review>('PUT', `/reviews/${id(reviewId)}/reply`, { body }),
  deleteReviewReply: (reviewId: string) => request<void>('DELETE', `/reviews/${id(reviewId)}/reply`),
  /** An object URL for a review photo (fetched with the staff sign-in; private until approved). */
  async reviewPhotoUrl(reviewId: string, photoId: string): Promise<string> {
    const res = await send('GET', `/reviews/${id(reviewId)}/photos/${id(photoId)}`)
    return URL.createObjectURL(await res.blob())
  },
  reviewInsights: (days = 90) => request<ReviewInsights>('GET', `/reviews/insights${qs({ days })}`),
  reviewClaim: (claimId: string) => request<void>('POST', `/claims/${id(claimId)}/review`),
  /** MandiMangoes doesn't refund: a claim is resolved by a replacement or rejected. */
  /** A rejection needs `reason` (5+ characters), which the customer sees. */
  resolveClaim: (claimId: string, resolution: Exclude<ClaimResolution, 'REFUND_APPROVED'>, reason?: string) =>
    request<void>('POST', `/claims/${id(claimId)}/resolve`, reason ? { resolution, reason } : { resolution }),

  promos: () => request<Promo[]>('GET', '/promos'),
  addPromo: (p: NewPromo) => request<Promo>('POST', '/promos', p),
  updatePromo: (code: string, patch: { active?: boolean; endsOn?: string | null; maxUses?: number | null; description?: string | null }) =>
    request<Promo>('PATCH', `/promos/${id(code)}`, patch),
  staff: () => request<StaffMember[]>('GET', '/staff'),
  addStaff: (input: { email: string; role: Role; password: string }) => request<StaffMember>('POST', '/staff', input),
  updateStaff: (staffId: string, patch: { role?: Role; password?: string }) =>
    request<StaffMember>('PATCH', `/staff/${id(staffId)}`, patch),
  removeStaff: (staffId: string) => request<void>('DELETE', `/staff/${id(staffId)}`),
  audit: (f: { staff?: string | null; from?: string | null; to?: string | null; page?: number } = {}) =>
    request<AuditPage>('GET', `/audit${qs(f)}`),

  pincodes: () => request<Pincode[]>('GET', '/pincodes'),
  addPincode: (input: { pincode: string; city: string; zone?: string }) =>
    request<Pincode>('POST', '/pincodes', input),
  updatePincode: (pincode: string, patch: Partial<Pick<Pincode, 'city' | 'zone' | 'active'>>) =>
    request<Pincode | undefined>('PATCH', `/pincodes/${id(pincode)}`, patch),
  deletePincode: (pincode: string) => request<void>('DELETE', `/pincodes/${id(pincode)}`),

  coverage: () => request<CoverageDay[]>('GET', '/coverage'),
  calendar: () => request<CalendarDay[]>('GET', '/calendar'),
  setCalendarDay: (day: CalendarDay) =>
    request<void>('PUT', `/calendar/${id(day.date)}`, { isOpen: day.isOpen, maxBoxes: day.maxBoxes, note: day.note }),
  clearCalendarDay: (date: string) => request<void>('DELETE', `/calendar/${id(date)}`),
  preorders: (status?: PreorderStatus | null) => request<Preorder[]>('GET', `/preorders${qs({ status })}`),
  preorderCapacity: () => request<PreorderCapacity[]>('GET', '/preorder-capacity'),
  /** Manager only: cancels a booking we can't fill; a paid one is refunded in full. */
  cancelPreorder: (preorderId: string, reason: string) =>
    request<{ refunded: boolean }>('POST', `/preorders/${id(preorderId)}/cancel`, { reason }),
  setPreorderCapacity: (weekStart: string, sku: string, capacity: number) =>
    request<unknown>('PUT', `/preorder-capacity/${id(weekStart)}/${id(sku)}`, { capacity }),
  slots: () => request<DeliverySlot[]>('GET', '/slots'),
  addSlot: (input: Omit<DeliverySlot, 'id' | 'active' | 'sort'> & { sort?: number }) =>
    request<DeliverySlot>('POST', '/slots', input),
  updateSlot: (slotId: string, patch: Partial<Omit<DeliverySlot, 'id'>>) =>
    request<DeliverySlot>('PATCH', `/slots/${id(slotId)}`, patch),
  rules: () => request<RulesVersion>('GET', '/config'),
  saveRules: (rules: Rules) => request<RulesVersion>('PUT', '/config', { rules }),
}

export interface ErrorInfo {
  message: string
  detail?: string
}

/** Turns any thrown value into display text, with the requestId for support. */
export function errorMessage(err: unknown): ErrorInfo {
  if (err instanceof ApiError) {
    return {
      message: err.message,
      detail: err.requestId ? `Reference: ${err.requestId}` : undefined,
    }
  }
  if (err instanceof TypeError) {
    return { message: 'Could not reach the server. Check your connection and try again.' }
  }
  if (err instanceof Error) return { message: err.message }
  return { message: 'Something went wrong.' }
}

export function isConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409
}

/** Someone else moved the record first (a plain 409), as opposed to a 409 that explains a business rule. */
export function isStale(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === 'CONFLICT'
}
