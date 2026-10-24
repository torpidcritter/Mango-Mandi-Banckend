// Every call to mango-api's customer routes (/v1) goes through request() here.
// The access token lives in memory and the refresh token in an httpOnly
// cookie. The access token is short-lived and refreshed once on a 401; a
// refresh the API refuses (401) signs the customer out.

import { ApiError, readAnswer } from './answer'

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
  /** The product photo the shop team added (a path on the API), or null for the drawn mango. */
  photoUrl?: string | null
  /** When sold out on this day: the next bookable day it is in stock, if any. */
  nextAvailableDate?: string | null
  /** What is in the box, when the shop team has filled it in: about how many mangoes, and grams each. */
  fruitsPerBox?: number | null
  fruitWeightG?: number | null
}
/** The live rules the help and terms pages quote (GET /v1/policy). */
export interface ShopPolicy {
  holdMinutes: number
  /** "18:00 IST" */
  cutoffTime: string
  maxDaysAhead: number
  claimWindowHours: number
}
/** A box on sale with its price, known before a pincode (GET /v1/products): no stock or ripeness. */
export interface ProductListing {
  sku: string
  name: string
  variety: string
  boxSize: string
  price: number
  description: string
  photoUrl: string | null
  fruitsPerBox: number | null
  fruitWeightG: number | null
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
  /** How long the boxes are held once Pay is tapped (the live rule); older APIs leave it out. */
  holdMinutes?: number
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
  /** Set while the order waits for payment with its boxes held. */
  holdExpiresAt?: string | null
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
  paymentStatus: 'INITIATED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'REFUNDED' | null
  refundStatus: 'PENDING' | 'REFUNDED' | null
  razorpayOrderId: string | null
  /** Razorpay's public key id, while the order waits for payment, so checkout can be reopened anywhere. */
  razorpayKeyId?: string | null
  holdExpiresAt: string | null
  /** Why a cancelled order was cancelled. HOLD_EXPIRED: no payment arrived in time, but a late one can still confirm it. */
  cancelReason?: 'HOLD_EXPIRED' | 'STAFF' | 'OTHER' | null
  cancelledAt?: string | null
  slot: Slot | null
  items: { sku: string; name: string; stage: Stage | null; quantity: number; unitPrice: number; linePrice: number; eatBy: string | null; readyOn?: string | null }[]
  timeline: { status: OrderStatus; at: string }[]
  /** Give this to the rider; set while the order is out for delivery. */
  deliveryCode?: string | null
  /** How the order was handed over, once delivered. */
  delivery?: { at: string; method: 'code' | 'photo' | 'staff' | null; receivedBy: string | null; hasPhoto: boolean } | null
  /** The customer's stars once delivered. */
  rating?: { stars: number; comment: string | null; at: string } | null
  /** Hours after delivery a problem can be reported for a free replacement (the live rule). */
  claimWindowHours: number
  /** Until when a problem can be reported; set once delivered. */
  claimUntil: string | null
  /** Failed delivery attempts so far. */
  deliveryFailures: number
  /** On a failed delivery: true when another attempt is booked, false when we will call first. Null otherwise. */
  retryScheduled: boolean | null
  /** Paid, but no stock for its date yet: the day may change and we message once it's settled. */
  findingStock?: boolean
}
export interface SavedAddress {
  id: string
  name: string | null
  address: string
  pincode: string
  lastUsedAt: string
}
export interface StockAlert {
  id: string
  sku: string
  name: string
  stage: Stage
  pincode: string
  createdAt: string
  expiresAt: string
  /** Set once we have sent the WhatsApp message. */
  notifiedAt: string | null
  /** The first delivery day with stock, as told in the message. */
  availableOn: string | null
}
export interface Settings {
  remindersOptIn: boolean
}
export type IssueType = 'DAMAGED' | 'WRONG_ITEM' | 'NOT_DELIVERED'
export interface Claim {
  id: string
  orderId: string
  orderNumber: string
  issueType: IssueType
  status: 'SUBMITTED' | 'UNDER_REVIEW' | 'RESOLVED'
  resolution: string | null
  /** Why staff rejected the claim, in their words. */
  rejectionReason?: string | null
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

export type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'HIDDEN'
export interface SubRatings {
  taste: number | null
  ripenessAccuracy: number | null
  packaging: number | null
  delivery: number | null
}
export interface MyReview extends SubRatings {
  id: string
  orderId: string
  orderItemId: string
  status: ReviewStatus
  rating: number
  comment: string | null
  anonymous: boolean
  displayName: string
  sku: string
  productName: string
  variety: string
  ripenessOrdered: Stage | null
  photos: { id: string; url: string; approved: boolean }[]
  reply: { body: string; at: string } | null
  createdAt: string
  updatedAt: string
  editableUntil: string
  canEdit: boolean
  moderationReason: string | null
}
export interface Reviewable {
  orderItemId: string
  orderId: string
  orderNumber: string
  sku: string
  productName: string
  variety: string
  ripenessOrdered: Stage | null
  quantity: number
  deliveredAt: string
  reviewableUntil: string
}
/** What to offer after 1 or 2 stars: the claim form while it is open, else support. */
export type FollowUp = { type: 'CLAIM'; orderId: string; claimUntil: string } | { type: 'SUPPORT'; contact: string } | null
export interface ReviewInput extends Partial<SubRatings> {
  rating: number
  comment: string | null
  anonymous: boolean
  photoIds: string[]
}
export interface PublicReview extends SubRatings {
  id: string
  rating: number
  comment: string | null
  displayName: string
  verifiedPurchase: boolean
  sku: string
  productName: string
  variety: string
  ripenessOrdered: Stage | null
  photos: { id: string; url: string; width: number | null; height: number | null }[]
  reply: { body: string; at: string } | null
  createdAt: string
}
export interface RatingSummary {
  count: number
  average: number | null
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>
  withPhotos: number
}
export interface ReviewPage {
  product: { sku: string; name: string; variety: string }
  scope: 'variety' | 'sku'
  summary: RatingSummary
  items: PublicReview[]
  nextCursor: string | null
}

export { ApiError }

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
/** What this device keeps about the customer, removed on sign-out and account deletion. */
const PERSONAL_KEYS = ['mm.address', 'mm.cart']

/**
 * `forget`: the customer chose to sign out (or deleted the account), so their
 * address and cart go too. An expired session keeps them for the next sign-in.
 */
function signedOut(forget = false) {
  epoch++
  const was = profile
  accessToken = null
  profile = null
  save(PROFILE_KEY, null)
  if (forget) for (const key of PERSONAL_KEYS) save(key, null)
  if (was || forget) window.dispatchEvent(new CustomEvent(SIGNOUT_EVENT, { detail: { forget } }))
}

/** Goes up on every sign-out, so a refresh that was already on its way cannot sign the customer back in. */
let epoch = 0
let refreshing: Promise<boolean> | null = null
function refreshOnce(): Promise<boolean> {
  if (!profile) return Promise.resolve(false)
  refreshing ??= (async () => {
    const started = epoch
    try {
      const r = await raw<TokenResponse>('POST', '/auth/token/refresh', {})
      if (epoch !== started) return false
      signedIn(r)
      return true
    } catch (err) {
      // Only a refused session (401) is a sign-out. Offline, busy (429) or a
      // server error keeps the profile and lets this request fail.
      if (err instanceof ApiError && err.status === 401) signedOut()
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
  return readAnswer<T>(res.status, await res.text())
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

/** What Razorpay Checkout's success handler receives. */
export interface CheckoutReply {
  razorpay_payment_id: string
  razorpay_order_id: string
  razorpay_signature: string
}
export interface PaymentState {
  status: Order['paymentStatus']
  orderStatus: OrderStatus
}

export const api = {
  requestCode: (phone: string, channel?: 'sms' | 'whatsapp', captchaToken?: string) =>
    raw<{ sent: boolean; channel: 'sms' | 'whatsapp'; devCode?: string }>('POST', '/auth/otp/request', { phone, ...(channel ? { channel } : {}), ...(captchaToken ? { captchaToken } : {}) }),
  async verifyCode(phone: string, code: string) {
    signedIn(await raw<TokenResponse>('POST', '/auth/otp/verify', { phone, code }))
  },
  authConfig: () => raw<{ googleClientId: string | null; turnstileSiteKey?: string | null }>('GET', '/auth/config'),
  async signInWithGoogle(credential: string) {
    signedIn(await raw<TokenResponse>('POST', '/auth/google', { credential }))
  },
  /** Adds a mobile number to an account made with Google. */
  requestPhoneCode: (phone: string, channel?: 'sms' | 'whatsapp', captchaToken?: string) =>
    request<{ sent: boolean; channel: 'sms' | 'whatsapp'; devCode?: string }>('POST', '/me/phone/request', { phone, ...(channel ? { channel } : {}), ...(captchaToken ? { captchaToken } : {}) }),
  async verifyPhoneCode(phone: string, code: string) {
    signedIn(await request<TokenResponse>('POST', '/me/phone/verify', { phone, code }))
  },
  /** Deletes the account and its personal details, then signs out. */
  async deleteAccount() {
    await request<void>('DELETE', '/me')
    signedOut(true)
  },
  async signOut() {
    await raw('POST', '/auth/logout', {}).catch(() => undefined)
    signedOut(true)
  },
  /** Ends every session of the account, on every phone and computer, then signs out here too. */
  async signOutEverywhere() {
    await request<void>('POST', '/me/sign-out-everywhere')
    signedOut(true)
  },
  /** A copy of everything the shop holds about the customer, as JSON. */
  exportData: () => request<Record<string, unknown>>('GET', '/me/export'),

  checkPincode: (pincode: string) => request<DeliveryCheck>('GET', `/delivery/check${qs({ pincode })}`),
  products: () => request<{ items: ProductListing[] }>('GET', '/products'),
  policy: () => request<ShopPolicy>('GET', '/policy'),
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
  /** Asks the API for the payment state; a minute after checkout it also checks with Razorpay (throttled). */
  paymentStatus: (orderId: string) => request<PaymentState>('GET', `/orders/${id(orderId)}/payment-status`),
  /** Hands what Razorpay Checkout returned to the API, which verifies it and confirms the order at once. */
  verifyPayment: (orderId: string, reply: CheckoutReply) => request<PaymentState>('POST', `/orders/${id(orderId)}/verify-payment`, reply),
  reschedule: (orderId: string, deliveryDate: string, slotId: string | null) =>
    request<void>('POST', `/orders/${id(orderId)}/reschedule`, { deliveryDate, slotId }),
  rate: (orderId: string, stars: number, comment: string | null) => request<void>('PUT', `/orders/${id(orderId)}/rating`, { stars, comment }),
  settings: () => request<Settings>('GET', '/me'),
  saveSettings: (settings: Settings) => request<Settings>('PATCH', '/me', settings),
  stockAlerts: () => request<StockAlert[]>('GET', '/stock-alerts'),
  addStockAlert: (input: { sku: string; stage: Stage; pincode: string }) => request<StockAlert>('POST', '/stock-alerts', input),
  removeStockAlert: (alertId: string) => request<void>('DELETE', `/stock-alerts/${id(alertId)}`),
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

  myReviews: (orderId?: string) => request<{ reviews: MyReview[]; reviewable: Reviewable[] }>('GET', `/me/reviews${qs({ orderId })}`),
  sendReview: (input: ReviewInput & { orderItemId: string }, idempotencyKey: string) =>
    request<{ review: MyReview; followUp: FollowUp }>('POST', '/reviews', input, { 'Idempotency-Key': idempotencyKey }),
  editReview: (reviewId: string, input: Partial<ReviewInput>) => request<{ review: MyReview; followUp: FollowUp }>('PATCH', `/reviews/${id(reviewId)}`, input),
  deleteReview: (reviewId: string) => request<void>('DELETE', `/reviews/${id(reviewId)}`),
  /**
   * Uploads one review photo (already shrunk on the phone). With Vercel Blob
   * the photo goes straight to a private upload folder and the API then checks
   * and cleans it; otherwise it is posted to the API. Returns the photo id.
   */
  async uploadReviewPhoto(photo: Blob): Promise<{ id: string }> {
    const how = await request<{ mode: 'direct' | 'blob'; pathname?: string; clientToken?: string }>('POST', '/reviews/photos/upload-token', {})
    if (how.mode === 'blob' && how.pathname && how.clientToken) {
      const { put } = await import('@vercel/blob/client')
      await put(how.pathname, photo, { access: 'private', token: how.clientToken, contentType: photo.type, multipart: false })
      return request<{ id: string }>('POST', '/reviews/photos', { pathname: how.pathname })
    }
    return request<{ id: string }>('POST', '/reviews/photos', photo)
  },
  productReviews: (sku: string, params: { stars?: number | null; withPhotos?: boolean; cursor?: string | null; limit?: number; scope?: 'variety' | 'sku' } = {}) =>
    raw<ReviewPage>(
      'GET',
      `/products/${id(sku)}/reviews${qs({
        stars: params.stars ? String(params.stars) : null,
        withPhotos: params.withPhotos ? 'true' : null,
        cursor: params.cursor,
        limit: params.limit ? String(params.limit) : null,
        scope: params.scope,
      })}`,
    ),
  /** An approved review photo: public, so a plain URL. */
  publicPhotoUrl: (url: string) => `${API_URL}${url}`,
  /** My own review photo (any status), as an object URL: it needs the sign-in. */
  async myReviewPhotoUrl(url: string): Promise<string> {
    if (!accessToken && profile) await refreshOnce()
    const get = () => fetch(`${API_URL}${url}`, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} })
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
