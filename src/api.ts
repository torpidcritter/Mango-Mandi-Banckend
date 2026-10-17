// Every HTTP call to mango-api goes through request<T>() here.
//
// The access token lives only in this module's closure: never in storage,
// never logged. The refresh token is the httpOnly `mango_admin_rt` cookie,
// invisible to JS, so auth calls send credentials and let the browser carry it.

import type {
  ApiErrorBody,
  BatchDetail,
  Analytics,
  Attention,
  AuditPage,
  BulkMoveResult,
  Manifest,
  BatchListItem,
  BatchStatus,
  Claim,
  ClaimResolution,
  ClaimStatus,
  Condition,
  LedgerEntry,
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
  Role,
  StaffMember,
  Summary,
} from './types'

export const API_URL: string = (import.meta.env.VITE_API_URL ?? '').trim().replace(/\/+$/, '')
const BASE = `${API_URL}/admin/v1`

export const SIGNOUT_EVENT = 'admin:signout'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

let accessToken: string | null = null
let refreshPromise: Promise<boolean> | null = null

async function toApiError(res: Response): Promise<ApiError> {
  let body: ApiErrorBody | null = null
  try {
    body = (await res.json()) as ApiErrorBody
  } catch {
    // Not JSON (proxy error page, empty body). Fall back to the status line.
  }
  return new ApiError(
    res.status,
    body?.error?.code ?? `HTTP_${res.status}`,
    body?.error?.message ?? (res.statusText || 'Request failed'),
    body?.error?.requestId,
  )
}

/** One shared refresh: a burst of parallel 401s issues a single refresh call. */
function refreshOnce(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const res = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' })
        if (!res.ok) return false
        const data = (await res.json()) as { accessToken?: string }
        if (!data.accessToken) return false
        accessToken = data.accessToken
        return true
      } catch {
        return false
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
    if (await refreshOnce()) return send(method, path, body, true)
    signOutLocally()
    throw new ApiError(401, 'SESSION_ENDED', 'Your session has ended. Please sign in again.')
  }
  if (!res.ok) throw await toApiError(res)
  return res
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, body)
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
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
    if (!(await refreshOnce())) return null
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
  twoStepSetup: () => request<{ secret: string; otpauthUrl: string }>('POST', '/me/two-step/setup'),
  /** Confirms a code from the app. Returns the recovery codes, shown this once. */
  async twoStepEnable(code: string): Promise<string[]> {
    const r = await request<{ recoveryCodes: string[]; accessToken: string }>('POST', '/me/two-step/enable', { code })
    accessToken = r.accessToken
    return r.recoveryCodes
  },
  twoStepDisable: (code: string) => request<void>('POST', '/me/two-step/disable', { code }),
  me: () => request<Me>('GET', '/auth/me'),
  resetTwoStep: (staffId: string) => request<void>('POST', `/staff/${id(staffId)}/two-step/reset`),

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
  products: () => request<Product[]>('GET', '/products'),

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
  setBatchStatus: (batchId: string, status: BatchStatus) =>
    request<{ rebalancedOrders?: string[]; atRiskOrders?: string[] } | undefined>(
      'PATCH',
      `/batches/${id(batchId)}/status`,
      { status },
    ),
  logQc: (batchId: string, input: { ripenessRating: Ripeness; condition: Condition; notes?: string }) =>
    request<{ id: string; warning?: string }>('POST', `/batches/${id(batchId)}/qc`, input),
  adjustLine: (
    batchId: string,
    lineId: string,
    input: { onHand?: number; reserveBuffer?: number; reason: string },
  ) => request<void>('PATCH', `/batches/${id(batchId)}/lines/${id(lineId)}`, input),

  orders: (f: { status?: string | null; from?: string | null; to?: string | null; q?: string | null; page?: number }) =>
    request<Paged<OrderListItem>>('GET', `/orders${qs(f)}`),
  order: (orderId: string) => request<OrderDetail>('GET', `/orders/${id(orderId)}`),
  setOrderStatus: (orderId: string, status: OrderStatus) =>
    request<void>('PATCH', `/orders/${id(orderId)}/status`, { status }),
  allocate: (orderId: string) => request<void>('POST', `/orders/${id(orderId)}/allocate`),
  cancelOrder: (orderId: string, reason: string) =>
    request<void>('POST', `/orders/${id(orderId)}/cancel`, { reason }),
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
  uploadDeliveryPhoto: (orderId: string, photo: Blob) => request<{ id: string }>('POST', `/orders/${id(orderId)}/delivery-photos`, photo),
  /** An object URL for a delivery photo (the image needs the staff sign-in, so it is fetched, not linked). */
  async deliveryPhotoUrl(orderId: string, photoId: string): Promise<string> {
    const res = await send('GET', `/orders/${id(orderId)}/delivery-photos/${id(photoId)}`)
    return URL.createObjectURL(await res.blob())
  },
  recordDelivery: (
    orderId: string,
    body:
      | { outcome: 'DELIVERED'; code?: string; photoId?: string; receivedBy?: string; lat?: number; lng?: number }
      | { outcome: 'FAILED'; reason: FailReason; note?: string; photoId?: string; lat?: number; lng?: number },
  ) => request<{ outcome: 'DELIVERED' | 'FAILED'; method?: string }>('POST', `/orders/${id(orderId)}/delivery`, body),

  claims: (status?: ClaimStatus | null) => request<Claim[]>('GET', `/claims${qs({ status })}`),
  /** An object URL for a claim photo (fetched with the staff sign-in). */
  async claimPhotoUrl(claimId: string, photoId: string): Promise<string> {
    const res = await send('GET', `/claims/${id(claimId)}/photos/${id(photoId)}`)
    return URL.createObjectURL(await res.blob())
  },
  reviewClaim: (claimId: string) => request<void>('POST', `/claims/${id(claimId)}/review`),
  /** MandiMangoes doesn't refund: a claim is resolved by a replacement or rejected. */
  resolveClaim: (claimId: string, resolution: Exclude<ClaimResolution, 'REFUND_APPROVED'>) =>
    request<void>('POST', `/claims/${id(claimId)}/resolve`, { resolution }),

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
