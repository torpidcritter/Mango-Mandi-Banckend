// Every call to mango-api's customer routes (/v1) goes through request() here.
// Tokens live in localStorage: the access token is short-lived and refreshed
// once on a 401; a failed refresh signs the customer out.

export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '')

export type Stage = 'RAW' | 'SEMI_RIPE' | 'RIPE'
export type OrderStatus =
  | 'PAYMENT_PENDING'
  | 'CONFIRMED'
  | 'PROCESSING'
  | 'PACKED'
  | 'SHIPPED'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'DELIVERY_FAILED'
  | 'RTO'
  | 'CANCELLED'

export interface Slot {
  id: string
  label: string
  startsAt: string
  endsAt: string
}
export interface SlotOnDate extends Slot {
  remainingBoxes: number | null
  available: boolean
}
export interface DeliveryCheck {
  serviceable: boolean
  earliestDeliveryDate: string | null
  deliveryDates: string[]
  cutoffTime: string
}
export interface CatalogueItem {
  sku: string
  name: string
  variety: string
  boxSize: string
  price: number
  stage: Stage
  qty: number
  eatBy: string
  /** A line about the fruit. */
  description?: string
  /** When sold out on this day: the next bookable day it is in stock, if any. */
  nextAvailableDate?: string | null
}
export interface Catalogue {
  serviceable: boolean
  deliveryDate?: string
  deliveryDates?: string[]
  cutoffTime?: string
  items: CatalogueItem[]
}
export interface QuoteLine {
  sku: string
  name: string
  stage: Stage
  qty: number
  unitPrice: number
  linePrice: number
  eatBy: string
}
export interface Quote {
  quoteId: string
  pincode: string
  deliveryDate: string
  slot: Slot | null
  lines: QuoteLine[]
  subtotal: number
  promo: { code: string; description: string | null } | null
  discount: number
  total: number
  expiresAt: string
}
export interface Gift {
  recipientName: string
  recipientPhone: string
  message?: string | null
}
export interface Confirmed {
  orderId: string
  number: string
  status: OrderStatus
  total: number
  deliveryDate: string
  razorpayOrderId: string | null
  razorpayKeyId: string | null
  holdExpiresAt: string | null
}
export interface OrderSummary {
  id: string
  number: string
  status: OrderStatus
  deliveryDate: string
  total: number
  itemCount: number
  placedAt: string
}
export interface Order {
  id: string
  number: string
  status: OrderStatus
  deliveryDate: string
  placedAt: string
  pincode: string
  deliveryAddress: string | null
  subtotal: number
  discount: number
  promoCode: string | null
  total: number
  gift: Gift | null
  paymentStatus: 'INITIATED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | null
  refundStatus: 'PENDING' | 'REFUNDED' | null
  razorpayOrderId: string | null
  holdExpiresAt: string | null
  slot: Slot | null
  items: { sku: string; name: string; stage: Stage | null; quantity: number; unitPrice: number; linePrice: number; eatBy: string | null }[]
  timeline: { status: OrderStatus; at: string }[]
  /** Give this to the rider; set while the order is out for delivery. */
  deliveryCode?: string | null
  /** How the order was handed over, once delivered. */
  delivery?: { at: string; method: 'code' | 'photo' | 'staff' | null; receivedBy: string | null; hasPhoto: boolean } | null
  /** The customer's stars once delivered. */
  rating?: { stars: number; comment: string | null; at: string } | null
}
export interface SavedAddress {
  id: string
  name: string | null
  address: string
  pincode: string
  lastUsedAt: string
}
export type IssueType = 'DAMAGED' | 'WRONG_ITEM' | 'NOT_DELIVERED'
export interface Claim {
  id: string
  orderId: string
  orderNumber: string
  issueType: IssueType
  status: 'SUBMITTED' | 'UNDER_REVIEW' | 'RESOLVED'
  resolution: string | null
  replacementOrder: { id: string; number: string } | null
  createdAt: string
}

export interface PreorderWeek {
  sku: string
  name: string
  variety: string
  boxSize: string
  price: number
  /** The Monday the delivery week starts. */
  weekStart: string
  capacity: number
  remaining: number
}
export type PreorderStatus = 'PAYMENT_PENDING' | 'BOOKED' | 'WAITLISTED' | 'CONVERTED' | 'CANCELLED'
export interface Preorder {
  id: string
  number: string
  status: PreorderStatus
  sku: string
  productName: string
  stage: Stage
  qty: number
  unitPrice: number
  total: number
  weekStart: string
  pincode: string
  address: string | null
  paymentStatus: 'INITIATED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'REFUNDED' | null
  /** Razorpay payment link; set while waiting for payment. */
  paymentUrl: string | null
  holdExpiresAt: string | null
  /** The normal order the preorder became, once its delivery day was set. */
  orderId: string | null
  createdAt: string
  refund: { requestedAt: string; refundedAt: string | null } | null
}
export interface PreorderInput {
  sku: string
  stage: Stage
  qty: number
  weekStart: string
  pincode: string
  address: string
  name?: string
  waitlist?: boolean
}

/** A Neighborhood Unlock campaign as anyone may see it: counts only, never who. */
export interface UnlockCampaign {
  zoneLabel: string
  slotLabel: string | null
  deliveryDate: string
  current: number
  threshold: number
  remaining: number
  closesAt: string
  status: 'OPEN' | 'UNLOCKED' | 'MISSED'
}
export interface UnlockProgress {
  enabled: boolean
  deliveryDate: string | null
  campaigns: UnlockCampaign[]
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public detail: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

// The refresh token lives in an httpOnly cookie set by the API ("X-Session:
// cookie"), so page scripts never see it. The short-lived access token is kept
// in memory only; after a reload the first request refreshes it. What this
// device remembers is just who is signed in, to show the right screens.
export interface Profile {
  id: string
  phone: string | null
  name: string | null
  email: string | null
}

const PROFILE_KEY = 'mm.profile'
export const SIGNOUT_EVENT = 'mm:signout'
export const PROFILE_EVENT = 'mm:profile'

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
function save(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private mode: the session lasts as long as the tab.
  }
}

try {
  localStorage.removeItem('mm.session') // tokens were kept here before the cookie
} catch {
  // ignore
}

let accessToken: string | null = null
let profile: Profile | null = load<Profile>(PROFILE_KEY)

export const signedInProfile = () => profile
export const signedInPhone = () => profile?.phone ?? null

interface TokenResponse {
  accessToken: string
  customer: Profile
}
function signedIn(r: TokenResponse) {
  accessToken = r.accessToken
  profile = r.customer
  save(PROFILE_KEY, profile)
  window.dispatchEvent(new CustomEvent(PROFILE_EVENT))
}
function signedOut() {
  const was = profile
  accessToken = null
  profile = null
  save(PROFILE_KEY, null)
  if (was) window.dispatchEvent(new CustomEvent(SIGNOUT_EVENT))
}

let refreshing: Promise<boolean> | null = null
function refreshOnce(): Promise<boolean> {
  if (!profile) return Promise.resolve(false)
  refreshing ??= (async () => {
    try {
      signedIn(await raw<TokenResponse>('POST', '/auth/token/refresh', {}))
      return true
    } catch (err) {
      // Offline is not signed out: keep the profile and let the request fail.
      if (err instanceof ApiError) signedOut()
      return false
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

/** A Blob body (a photo) is sent as-is; anything else as JSON. */
async function raw<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const blob = body instanceof Blob
  const res = await fetch(`${API_URL}/v1${path}`, {
    method,
    credentials: 'include',
    headers: {
      'X-Session': 'cookie',
      ...(body !== undefined ? { 'Content-Type': blob ? body.type : 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : blob ? body : JSON.stringify(body),
  })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const json = text ? JSON.parse(text) : null
  if (!res.ok) {
    const e = json?.error
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? `Request failed (${res.status})`, e ?? {})
  }
  return json as T
}

async function request<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  if (!accessToken && profile) await refreshOnce()
  try {
    return await raw<T>(method, path, body, headers)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && profile && (await refreshOnce())) {
      return raw<T>(method, path, body, headers)
    }
    throw err
  }
}

const qs = (params: Record<string, string | null | undefined>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v)
  const s = p.toString()
  return s ? `?${s}` : ''
}
const id = encodeURIComponent

export const api = {
  requestCode: (phone: string, channel?: 'sms' | 'whatsapp') =>
    raw<{ sent: boolean; channel: 'sms' | 'whatsapp'; devCode?: string }>('POST', '/auth/otp/request', channel ? { phone, channel } : { phone }),
  async verifyCode(phone: string, code: string) {
    signedIn(await raw<TokenResponse>('POST', '/auth/otp/verify', { phone, code }))
  },
  authConfig: () => raw<{ googleClientId: string | null }>('GET', '/auth/config'),
  async signInWithGoogle(credential: string) {
    signedIn(await raw<TokenResponse>('POST', '/auth/google', { credential }))
  },
  /** Adds a mobile number to an account made with Google. */
  requestPhoneCode: (phone: string, channel?: 'sms' | 'whatsapp') =>
    request<{ sent: boolean; channel: 'sms' | 'whatsapp'; devCode?: string }>('POST', '/me/phone/request', channel ? { phone, channel } : { phone }),
  async verifyPhoneCode(phone: string, code: string) {
    signedIn(await request<TokenResponse>('POST', '/me/phone/verify', { phone, code }))
  },
  /** Deletes the account and its personal details, then signs out. */
  async deleteAccount() {
    await request<void>('DELETE', '/me')
    signedOut()
  },
  async signOut() {
    await raw('POST', '/auth/logout', {}).catch(() => undefined)
    signedOut()
  },

  unlockProgress: (pincode: string, date: string | null) => raw<UnlockProgress>('GET', `/unlock/progress${qs({ pincode, date })}`),
  checkPincode: (pincode: string) => request<DeliveryCheck>('GET', `/delivery/check${qs({ pincode })}`),
  catalogue: (pincode: string, date: string | null) => request<Catalogue>('GET', `/catalogue${qs({ pincode, delivery_date: date })}`),
  slots: (pincode: string, date: string) =>
    request<{ deliveryDate: string; slots: SlotOnDate[] }>('GET', `/delivery/slots${qs({ pincode, delivery_date: date })}`),

  serverCart: () => request<{ lines: { sku: string; stage: Stage; qty: number }[] }>('GET', '/cart'),
  setCartLine: (sku: string, stage: Stage, qty: number) => request<void>('POST', '/cart/items', { sku, stage, qty }),
  quote: (input: { pincode: string; deliveryDate: string; slotId: string | null; promoCode?: string | null }) => request<Quote>('POST', '/checkout/quote', input),
  confirm: (input: { quoteId: string; address: string; name?: string; gift?: Gift | null }, idempotencyKey: string) =>
    request<Confirmed>('POST', '/checkout/confirm', input, { 'Idempotency-Key': idempotencyKey }),

  orders: () => request<OrderSummary[]>('GET', '/orders'),
  order: (orderId: string) => request<Order>('GET', `/orders/${id(orderId)}`),
  cancel: (orderId: string) => request<void>('POST', `/orders/${id(orderId)}/cancel`),
  reschedule: (orderId: string, deliveryDate: string, slotId: string | null) =>
    request<void>('POST', `/orders/${id(orderId)}/reschedule`, { deliveryDate, slotId }),
  rate: (orderId: string, stars: number, comment: string | null) => request<void>('PUT', `/orders/${id(orderId)}/rating`, { stars, comment }),
  addresses: () => request<SavedAddress[]>('GET', '/me/addresses'),
  forgetAddress: (addressId: string) => request<void>('DELETE', `/me/addresses/${id(addressId)}`),
  claims: () => request<Claim[]>('GET', '/claims'),
  raiseClaim: (input: { orderId: string; issueType: IssueType; description: string; itemSkus: string[]; photoIds: string[] }) =>
    request<{ id: string; status: string }>('POST', '/claims', input),
  /** Uploads one claim photo (a JPEG from shrinkPhoto); the id goes with the claim. */
  uploadClaimPhoto: (photo: Blob) => request<{ id: string }>('POST', '/claims/photos', photo),

  preorderWeeks: () => request<{ weeks: PreorderWeek[]; cancelPolicy: string }>('GET', '/preorders/weeks'),
  bookPreorder: (input: PreorderInput, idempotencyKey: string) =>
    request<Preorder>('POST', '/preorders', input, { 'Idempotency-Key': idempotencyKey }),
  preorders: () => request<Preorder[]>('GET', '/preorders'),
  preorder: (preorderId: string) => request<Preorder>('GET', `/preorders/${id(preorderId)}`),
  cancelPreorder: (preorderId: string) => request<void>('POST', `/preorders/${id(preorderId)}/cancel`),

  /** The rider's photo of the handover, as an object URL (it needs the sign-in, so it is fetched). */
  async deliveryPhotoUrl(orderId: string): Promise<string> {
    if (!accessToken && profile) await refreshOnce()
    const get = () => fetch(`${API_URL}/v1/orders/${id(orderId)}/delivery-photo`, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} })
    let res = await get()
    if (res.status === 401 && profile && (await refreshOnce())) res = await get()
    if (!res.ok) throw new ApiError(res.status, 'PHOTO_UNAVAILABLE', 'The photo could not be loaded.')
    return URL.createObjectURL(await res.blob())
  },

  /** Development only: the API's stand-in for Razorpay. */
  devPay: (orderId: string, outcome: 'captured' | 'failed') => raw<{ result: string }>('POST', '/dev/pay', { orderId, outcome }),
  devPayPreorder: (preorderId: string, outcome: 'captured' | 'failed') =>
    raw<{ result: string }>('POST', '/dev/pay-preorder', { preorderId, outcome }),
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof TypeError) return 'Could not reach MandiMangoes. Check your connection and try again.'
  if (err instanceof Error) return err.message
  return 'Something went wrong.'
}
