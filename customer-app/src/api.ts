// Every call to mango-api's customer routes (/v1) goes through request() here.
// The access token lives in memory and the refresh token in an httpOnly
// cookie. The access token is short-lived and refreshed once on a 401; a
// refresh the API refuses (401) signs the customer out.

import { ApiError, readAnswer } from './answer'
import { currentLang, t, type Key } from './i18n-core.ts'
import type { Answers, PartnerNetwork, PartnerSubmitted } from './partner-form.ts'

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
  /** Whether checkout takes a business name and GSTIN for the bill (bills switched on). Older APIs leave it out. */
  bills?: boolean
  /** The shop's switchable parts (docs/app-feel.md); an older API leaves it out, which means all off. */
  features?: ShopFeatures
  /** With "Send to many" on: the most recipients one gift order may have. */
  multiGiftMaxRecipients?: number
  /** Customer care (docs/care.md): present only while the help centre or subscriptions are on. */
  care?: { helpCentre: boolean; subscriptions: boolean; subscriptionsOpen: boolean }
}
/** Which app-feel parts the API has switched on. */
export interface ShopFeatures {
  /** The service worker (static app shell only) and the "Install app" offer. */
  installApp: boolean
  /** Browser notifications for order updates can be turned on (WEB_PUSH with a key). */
  push: boolean
  /** "Your rider is N stops away" on the order page. */
  tracking: boolean
  /** Hearts on boxes and the Favourites list. */
  favourites: boolean
  /** Sort and filter controls on the home page. */
  sortFilter: boolean
  /** Refer a friend on the Account page and at checkout (docs/growth.md). */
  referrals?: boolean
  /** Anonymous funnel steps: visit, box viewed, added to cart, checkout started (docs/growth.md). */
  funnel?: boolean
  /** "Send to many": one gift order to many recipients (MULTI_GIFT). */
  multiGift?: boolean
  /** The shop in Hindi and Kannada as well as English (SHOP_LANGUAGES, docs/languages.md). */
  languages?: boolean
  /** Partner With Us: the business enquiry pages and their links (PARTNER_NETWORK, docs/partner-network.md). */
  partnerNetwork?: boolean
  /** Farm Experience: the farm visit with 250 kg or more (FARM_EXPERIENCE, docs/farm-experience.md). */
  farmExperience?: boolean
}
/** The shop's languages (the API's GET/PUT /v1/me/language). */
export type ShopLanguage = 'en' | 'hi' | 'kn'
export interface LanguageView {
  /** Null until the customer chooses. */
  language: ShopLanguage | null
  languages: ShopLanguage[]
}
/** My refer-a-friend state (GET /v1/me/referral). Amounts in paise except the two rupee rules. */
export interface ReferralView {
  /** Null until the account has a phone number. */
  code: string | null
  shareUrl: string | null
  /** PERCENT: rewardPercent off (capped at rewardMaxRupees when set). FLAT: rewardRupees off. */
  rewardKind: 'PERCENT' | 'FLAT'
  rewardPercent: number | null
  rewardMaxRupees: number | null
  rewardRupees: number | null
  minOrderRupees: number
  /** A new customer who has not entered a code yet. */
  canEnterCode: boolean
  entered: { status: 'PENDING' | 'REWARDED' | 'VOID'; reason: string | null; at: string } | null
  friends: { pending: number; rewarded: number }
  rewards: {
    code: string
    kind: 'PERCENT' | 'FLAT'
    percent: number | null
    /** Paise, for FLAT only. */
    amount: number | null
    /** Paise cap for PERCENT, or null. */
    maxDiscount: number | null
    minSubtotal: number
    endsOn: string | null
    for: string
    state: 'READY' | 'USED' | 'WITHDRAWN' | 'EXPIRED'
  }[]
}
/** A hearted box (GET /v1/me/favourites). */
export interface Favourite {
  sku: string
  name: string
  variety: string | null
  boxSize: string | null
  price: number | null
  photoUrl: string | null
  /** False once the box is taken off sale: the list says so and offers nothing to buy. */
  onSale: boolean
  addedAt: string
}
export interface FavouriteList {
  items: Favourite[]
  max: number
}
/** While the order is out for delivery with a rider: stops before this one and a rough time. */
export interface Tracking {
  stopsAway: number
  minutesPerStop: number
  etaMinutes: number
}
/** What the Account page needs to offer browser notifications. */
export interface PushInfo {
  available: boolean
  /** The application server key (RFC 8292), base64url; null while push is off. */
  publicKey: string | null
  /** How many of the customer's browsers have notifications on. */
  browsers: number
}
/** What PushSubscription.toJSON() gives. */
export interface PushSubscriptionInput {
  endpoint: string
  expirationTime?: number | null
  keys: { p256dh: string; auth: string }
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
  /** Set on a bulk deal line: the deal it is bought under, and its name. */
  listingId?: string
  title?: string
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
  /** Whether business details for the bill are taken (bills switched on). Older APIs leave it out. */
  bills?: boolean
}
/** A business buying: printed on the bill. The GSTIN's check character is verified by the API too. */
export interface BusinessDetails {
  name: string
  gstin: string
}
/** The order's numbered bill, once it is paid. A cancelled order keeps its bill, marked cancelled. */
export interface OrderBill {
  id: string
  number: string
  kind: 'RECEIPT' | 'BILL_OF_SUPPLY' | 'TAX_INVOICE' | 'INVOICE_CUM_BILL_OF_SUPPLY'
  title: string
  issuedAt: string
  billDate: string
  total: number
  cancelled: boolean
  cancelledAt: string | null
}
export interface Gift {
  recipientName: string
  recipientPhone: string
  message?: string | null
}
/** One recipient of a gift order to many (MULTI_GIFT), as the shop sends it. */
export interface GiftRecipientInput {
  name: string
  phone: string
  address: string
  pincode: string
  sku: string
  stage: Stage
  qty: number
  note?: string | null
}
/** A recipient as the review prices it. */
export interface GiftQuoteRecipient extends GiftRecipientInput {
  boxName: string
  unitPrice: number
  linePrice: number
  eatBy: string
}
export interface GiftQuote {
  quoteId: string
  deliveryDate: string
  slot: Slot | null
  recipients: GiftQuoteRecipient[]
  boxes: number
  subtotal: number
  promo: { code: string; description: string | null } | null
  discount: number
  total: number
  expiresAt: string
  holdMinutes: number
  bills?: boolean
}
/** A problem with one recipient, by row (1 = the first), from RECIPIENTS_INVALID. */
export interface RecipientProblem {
  row: number
  field: string
  message: string
}
export interface GiftConfirmed {
  giftOrderId: string
  number: string
  status: GiftOrderStatus
  total: number
  deliveryDate: string
  recipientCount: number
  razorpayOrderId: string | null
  razorpayKeyId: string | null
  holdExpiresAt: string | null
}
export type GiftOrderStatus = 'PAYMENT_PENDING' | 'PAID' | 'CANCELLED'
export interface GiftOrderSummary {
  id: string
  number: string
  status: GiftOrderStatus
  deliveryDate: string
  recipientCount: number
  total: number
  placedAt: string
}
export interface GiftOrder extends GiftOrderSummary {
  paymentStatus: 'INITIATED' | 'SUCCEEDED' | 'CANCELLED' | 'FAILED'
  paidAt: string | null
  slot: Slot | null
  boxes: number
  subtotal: number
  discount: number
  promoCode: string | null
  business: BusinessDetails | null
  razorpayOrderId: string | null
  razorpayKeyId: string | null
  holdExpiresAt: string | null
  cancelReason: 'HOLD_EXPIRED' | 'OTHER' | null
  cancellable: boolean
  bill: OrderBill | null
  recipients: {
    orderId: string
    number: string
    position: number
    status: OrderStatus
    name: string
    phone: string
    note: string | null
    address: string
    pincode: string
    sku: string | null
    boxName: string | null
    stage: Stage | null
    qty: number
    linePrice: number
    discount: number
    total: number
    cancellable: boolean
    refundStatus: 'PENDING' | 'REFUNDED' | null
  }[]
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
  /** A delivery of a gift order to many recipients: its gift order, and who it goes to. */
  giftOrderId?: string
  giftRecipient?: string | null
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
  /** One delivery of a gift order to many recipients: its payment, bill and whole-order cancel are on the gift order. */
  giftOrderId?: string | null
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
  items: {
    sku: string
    name: string
    stage: Stage | null
    quantity: number
    unitPrice: number
    linePrice: number
    eatBy: string | null
    readyOn?: string | null
    /** Bought under a bulk deal: its name and the price tier it was sold at (kept from the day of the order). */
    bulk?: { listingId: string; title: string; tier: { minQty: number; maxQty: number | null; unitPrice: number } } | null
  }[]
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
  /** The bill, once paid (while bills are on); download it with api.billUrl. */
  bill?: OrderBill | null
  /** Business details given at checkout for the bill. */
  business?: BusinessDetails | null
  /** Live tracking (when switched on): set only while out for delivery with a rider. */
  tracking?: Tracking | null
}
// ---------- Customer care (docs/care.md) ----------

export type HelpStatus = 'OPEN' | 'WAITING_CUSTOMER' | 'RESOLVED'
export interface HelpTopic {
  id: string
  label: string
}
/** GET /v1/me/help: the topics to choose from and the limits the form shows. */
export interface HelpSetup {
  topics: HelpTopic[]
  messageMax: number
  firstMessageMin: number
  dailyLimit: number
}
export interface HelpRequestSummary {
  id: string
  number: string
  topic: string
  topicLabel: string
  status: HelpStatus
  order: { id: string; number: string | null } | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
  lastMessage?: { from: 'MandiMangoes' | 'You'; preview: string; at: string }
}
export interface HelpRequest extends HelpRequestSummary {
  messages: { id: string; from: 'MANDIMANGOES' | 'YOU'; body: string; at: string }[]
}

export type SubscriptionStatus = 'ACTIVE' | 'PAUSED' | 'CANCELLED' | 'ENDED'
export type Frequency = 'WEEKLY' | 'FORTNIGHTLY'
export interface SubscriptionCycle {
  id: string
  scheduledFor: string
  deliveryDate: string | null
  slotId: string | null
  status: 'DUE' | 'ORDERED' | 'SKIPPED' | 'MISSED' | 'CANCELLED'
  note: string | null
  order: { id: string; number: string; status: OrderStatus; paymentStatus: string; holdExpiresAt: string | null } | null
  /** Pay is offered: set up, not paid, the subscription running and a day still left. */
  canPay: boolean
  paid: boolean
  awaitingPayment: boolean
}
export interface Subscription {
  id: string
  number: string
  status: SubscriptionStatus
  sku: string
  productName: string
  unitPrice: number | null
  stage: Stage
  qty: number
  frequency: Frequency
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: number
  firstDate: string
  endDate: string
  slotId: string | null
  address: { name: string | null; address: string; pincode: string } | null
  pincode: string
  createdAt: string
  pausedAt: string | null
  cancelledAt: string | null
  cycles: SubscriptionCycle[]
  /** The next dates not set up yet: what can be skipped ahead of time. */
  upcoming: string[]
  history?: { action: string; reason: string | null; at: string }[]
}
export interface SubscriptionList {
  items: Subscription[]
  /** Whether a new subscription can start (the season has not ended). */
  open: boolean
  seasonEnd: string | null
  leadDays: number
}
export interface NewSubscription {
  sku: string
  stage: Stage
  qty: number
  frequency: Frequency
  weekday: number
  slotId: string | null
  addressId: string
  endDate: string
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

/** One price tier of a bulk deal: boxes from minQty up to maxQty (null: no upper end) at unitPrice each. */
export interface BulkTier {
  minQty: number
  maxQty: number | null
  unitPrice: number
  /** Less than the regular one-box price by this much; null when it isn't lower. */
  savingPerBox: number | null
}
/** Boxes available on one delivery day, per ripeness the deal offers. */
export interface BulkDay {
  date: string
  /** At least one ripeness has the minimum order in stock. */
  enough: boolean
  stages: { stage: Stage; available: number; enough: boolean; eatBy: string }[]
}
/** A bulk deal as the shop shows it (GET /v1/bulk-deals). */
export interface BulkDeal {
  id: string
  title: string
  description: string
  origin: string
  product: { sku: string; name: string; variety: string; boxSize: string; fruitsPerBox: number | null; fruitWeightG: number | null }
  /** The regular price of one box. */
  retailPrice: number
  stages: Stage[]
  minQty: number
  qtyStep: number
  /** The most boxes one order can take (already capped by the shop's unpaid-box rule). */
  maxQty: number
  tiers: BulkTier[]
  /** The lowest box price on any tier. */
  fromPrice: number
  photos: { id: string; url: string }[]
  endsAt: string | null
  version: number
  /** With a serviceable pincode: stock per open delivery day. */
  availability?: BulkDay[]
  serviceable?: boolean | null
}
export interface BulkPrice {
  qty: number
  unitPrice: number
  total: number
  tier: { minQty: number; maxQty: number | null; unitPrice: number }
  version: number
}
/** A bulk line in the account's cart as the API prices it now (GET /v1/cart). */
export interface ServerBulkLine {
  listingId: string
  title: string
  sku: string
  name: string
  stage: Stage
  qty: number
  unitPrice: number
  linePrice: number
  problem: string | null
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
const PERSONAL_KEYS = ['mm.address', 'mm.cart', 'mm.bulk']

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

/**
 * Run before a chosen sign-out while the session still works (push.ts sets it: this browser's
 * notifications are turned off, so the next person on a shared device doesn't get them).
 */
let beforeSignOut: (() => Promise<unknown>) | null = null
export const onBeforeSignOut = (fn: (() => Promise<unknown>) | null) => {
  beforeSignOut = fn
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
// Farm Experience (FARM_EXPERIENCE, docs/farm-experience.md). Money in paise; the API prices everything.
export type FarmStatus =
  | 'HOSPITALITY_REVIEW'
  | 'CONFIRMED'
  | 'PREPARING'
  | 'READY_FOR_VISIT'
  | 'CHECKED_IN'
  | 'HARVESTING'
  | 'WEIGHING'
  | 'PAYMENT_DUE'
  | 'PACKING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NO_SHOW'
export interface FarmMeals {
  breakfast: boolean
  lunch: boolean
  dinner: boolean
  refreshments: boolean
}
/** What the farm team wrote on Farm Settings (empty until they do: the shop never makes it up). */
export interface FarmSettings {
  farmName: string
  location: string
  mapUrl: string
  contactPhone: string
  contactEmail: string
  arrivalInstructions: string
  checkInTime: string
  checkOutTime: string
  stayNights: number
  sleepingArrangements: string
  bathroomFacilities: string
  otherFacilities: string
  groupCoordination: string
  meals: FarmMeals
  mealNotes: string
  transportIncluded: boolean
  transportPolicy: string
  weatherPolicy: string
  harvestPolicy: string
  noShowPolicy: string
  seasonStart: string
  seasonEnd: string
  leadDays: number
  maxDaysAhead: number
  maxOpenBookings: number
  /** Price per kg for kilograms picked beyond the booking; null: the booking's own price. */
  extraPricePerKg: number | null
  cancelDays: number
  rescheduleDays: number
  guestCharges: string
  faqs: { q: string; a: string }[]
}
export interface FarmVariety {
  id: string
  name: string
  sku: string | null
  description: string | null
  ripenessNote: string | null
  harvestFrom: string | null
  harvestTo: string | null
  pricePerKg: number
  tiers: { minKg: number; pricePerKg: number }[]
  photoUrl: string | null
  availableKg?: number
  bestDayKg?: number
  firstDate?: string | null
  available?: boolean
}
export interface FarmExperience {
  minKg: number
  bookingsOpen: boolean
  settings: FarmSettings
  varieties: FarmVariety[]
}
export interface FarmDate {
  date: string
  visitsLeft: number | null
  varieties: { varietyId: string; availableKg: number; readiness: string | null }[]
}
export interface FarmQuote {
  varietyId: string
  kg: number
  pricePerKg: number
  total: number
}
export interface FarmBookingInput {
  varietyId: string
  kg: number
  visitDate: string
  arrivalDate?: string
  departureDate?: string
  adults: number
  children: number
  overnightGuests: number
  food?: { veg?: number; nonVeg?: number; jain?: number; allergies?: string; requests?: string }
  accessibility?: string
  notes?: string
  contactName: string
  contactEmail?: string
  billingName?: string
  billingGstin?: string
  acceptPolicies: true
}
/** A booking just made: nothing is paid until after picking. */
export interface FarmBookingCreated {
  bookingId: string
  number: string
  status: FarmStatus
  /** What the booked kilograms would cost; the bill after weighing is what is paid. */
  estimate: number
  kg: number
  visitDate: string
}
/** The Razorpay order for paying the bill. */
export interface FarmPaymentStart {
  bookingId: string
  number: string
  amount: number
  razorpayOrderId: string
  razorpayKeyId: string | null
}
/** The bill after weighing, in paise. */
export interface FarmBill {
  acceptedKg: number
  bookedKg: number
  pricePerKg: number
  bookedPartKg: number
  extraKg: number
  extraPricePerKg: number | null
  amount: number
  at: string
}
export interface FarmBookingSummary {
  id: string
  number: string
  status: FarmStatus
  variety: string
  kg: number
  total: number
  billAmount: number | null
  paidAt: string | null
  visitDate: string
  guests: number
  createdAt: string
}
export interface FarmBooking {
  id: string
  number: string
  status: FarmStatus
  refundStatus: 'REFUNDED' | 'REFUND_PENDING' | null
  variety: { id: string; name: string }
  kg: number
  pricePerKg: number
  /** The estimate at booking. */
  total: number
  bill: FarmBill | null
  visitDate: string
  guests: {
    adults: number
    children: number
    total: number
    overnight: number
    arrivalDate: string
    departureDate: string
    food: { veg?: number; nonVeg?: number; jain?: number; allergies?: string; requests?: string }
    accessibility: string | null
    notes: string | null
  }
  contact: { name: string; phone: string; email: string | null }
  hospitality: {
    status: 'PENDING' | 'APPROVED' | 'ALTERNATIVE_PROPOSED' | 'CUSTOMER_ACCEPTED' | 'CUSTOMER_DECLINED'
    plan: string | null
    alternative: string | null
    overCapacity: boolean
    rooms: { roomId: string; name: string; fromDate: string; toDate: string; guests: number }[]
    mealPlan: { date: string; breakfast: number; lunch: number; dinner: number; refreshments: number }[]
  }
  harvest: { harvestedKg: number | null; acceptedKg: number | null; packingStatus: string | null }
  money: { paid: number; refunded: number; refunds: { id: string; amount: number; status: string }[] }
  request: { kind: 'CANCEL' | 'RESCHEDULE'; date: string | null; note: string | null; at: string } | null
  paidAt: string | null
  checkinCode: string | null
  payment:
    | { status: 'DUE'; amount: number; razorpayOrderId: string | null; failed: boolean }
    | { status: 'PAID'; amount: number; paidAt: string; method: string }
    | null
  razorpayKeyId: string | null
  canPay: boolean
  canCancel: 'CANCEL' | 'REQUEST' | null
  canMove: 'MOVE' | 'REQUEST' | null
  farm: {
    name: string | null
    location: string | null
    mapUrl: string | null
    contactPhone: string | null
    contactEmail: string | null
    arrivalInstructions: string | null
    checkInTime: string | null
    checkOutTime: string | null
    meals: FarmMeals
    mealNotes: string | null
    transportIncluded: boolean
    transportPolicy: string | null
  }
  policy: { cancelDays: number; rescheduleDays: number; extraPricePerKg: number | null }
}

export interface CheckoutReply {
  razorpay_payment_id: string
  razorpay_order_id: string
  razorpay_signature: string
}
export interface PaymentState {
  status: Order['paymentStatus']
  orderStatus: OrderStatus
}

/** A signed-in download (a gift order's bill, the recipients template), as an object URL. */
async function fileUrl(path: string, code: string, message: string): Promise<string> {
  if (!accessToken && profile) await refreshOnce()
  const get = () => fetch(`${API_URL}/v1${path}`, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} })
  let res = await get()
  if (res.status === 401 && profile && (await refreshOnce())) res = await get()
  if (!res.ok) throw new ApiError(res.status, code, message)
  return URL.createObjectURL(await res.blob())
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
    // A shared phone: this browser stops getting the account's order updates first, while still signed in.
    await beforeSignOut?.().catch(() => undefined)
    await raw('POST', '/auth/logout', {}).catch(() => undefined)
    signedOut(true)
  },
  /** Ends every session of the account, on every phone and computer, then signs out here too. */
  async signOutEverywhere() {
    await request<void>('POST', '/me/sign-out-everywhere')
    signedOut(true)
  },
  /** Browser notifications (WEB_PUSH): whether they can be turned on, and on how many browsers they are. */
  pushInfo: () => request<PushInfo>('GET', '/me/push'),
  savePushSubscription: (sub: PushSubscriptionInput) => request<{ subscribed: boolean }>('PUT', '/me/push/subscription', sub),
  removePushSubscription: (endpoint: string) => request<void>('DELETE', '/me/push/subscription', { endpoint }),
  /** Hearted boxes (FAVOURITES). */
  favourites: () => request<FavouriteList>('GET', '/me/favourites'),
  addFavourite: (sku: string) => request<FavouriteList>('PUT', `/me/favourites/${id(sku)}`),
  removeFavourite: (sku: string) => request<void>('DELETE', `/me/favourites/${id(sku)}`),
  /** The hearts a guest made on this device, sent once after signing in. */
  mergeFavourites: (skus: string[]) => request<FavouriteList & { ignored: string[] }>('POST', '/me/favourites/merge', { skus }),
  /** A copy of everything the shop holds about the customer, as JSON. */
  referral: () => request<ReferralView>('GET', '/me/referral'),
  applyReferral: (code: string) => request<ReferralView>('POST', '/me/referral/apply', { code }),
  exportData: () => request<Record<string, unknown>>('GET', '/me/export'),

  checkPincode: (pincode: string) => request<DeliveryCheck>('GET', `/delivery/check${qs({ pincode })}`),
  products: () => request<{ items: ProductListing[] }>('GET', '/products'),
  policy: () => request<ShopPolicy>('GET', '/policy'),
  catalogue: (pincode: string, date: string | null) => request<Catalogue>('GET', `/catalogue${qs({ pincode, delivery_date: date })}`),
  slots: (pincode: string, date: string) =>
    request<{ deliveryDate: string; slots: SlotOnDate[] }>('GET', `/delivery/slots${qs({ pincode, delivery_date: date })}`),

  serverCart: () => request<{ lines: { sku: string; stage: Stage; qty: number }[]; bulkLines?: ServerBulkLine[] }>('GET', '/cart'),
  /** Sets a bulk line in the account's cart (0 removes it); the API checks the quantity against the deal. */
  setBulkLine: (listingId: string, stage: Stage, qty: number) => request<void>('POST', '/cart/bulk', { listingId, stage, qty }),
  bulkDeals: (pincode: string | null) => raw<{ items: BulkDeal[]; total: number; serviceable: boolean | null }>('GET', `/bulk-deals${qs({ pincode })}`),
  bulkDeal: (dealId: string, pincode: string | null) => raw<BulkDeal>('GET', `/bulk-deals/${id(dealId)}${qs({ pincode })}`),
  /** The API's price for a quantity (the shop shows it; checkout prices it again). */
  bulkPrice: (dealId: string, qty: number) => raw<BulkPrice>('GET', `/bulk-deals/${id(dealId)}/price${qs({ qty: String(qty) })}`),
  setCartLine: (sku: string, stage: Stage, qty: number) => request<void>('POST', '/cart/items', { sku, stage, qty }),
  quote: (input: { pincode: string; deliveryDate: string; slotId: string | null; promoCode?: string | null }) => request<Quote>('POST', '/checkout/quote', input),
  confirm: (
    input: { quoteId: string; address: string; name?: string; gift?: Gift | null; business?: BusinessDetails | null; funnelId?: string },
    idempotencyKey: string,
  ) =>
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
  /** SHOP_LANGUAGES: the language saved to the account (404 while the switch is off). */
  language: () => request<LanguageView>('GET', '/me/language'),
  saveLanguage: (language: ShopLanguage) => request<LanguageView>('PUT', '/me/language', { language }),
  stockAlerts: () => request<StockAlert[]>('GET', '/stock-alerts'),
  addStockAlert: (input: { sku: string; stage: Stage; pincode: string }) => request<StockAlert>('POST', '/stock-alerts', input),
  removeStockAlert: (alertId: string) => request<void>('DELETE', `/stock-alerts/${id(alertId)}`),
  addresses: () => request<SavedAddress[]>('GET', '/me/addresses'),
  // Customer care (docs/care.md): help requests and season subscriptions, the caller's own only.
  helpSetup: () => request<HelpSetup>('GET', '/me/help'),
  helpRequests: () => request<{ items: HelpRequestSummary[] }>('GET', '/me/help/requests'),
  helpRequest: (requestId: string) => request<HelpRequest>('GET', `/me/help/requests/${id(requestId)}`),
  openHelpRequest: (input: { topic: string; orderId: string | null; message: string }) => request<HelpRequest>('POST', '/me/help/requests', input),
  replyHelpRequest: (requestId: string, message: string) => request<HelpRequest>('POST', `/me/help/requests/${id(requestId)}/messages`, { message }),
  subscriptions: () => request<SubscriptionList>('GET', '/me/subscriptions'),
  subscription: (subId: string) => request<Subscription>('GET', `/me/subscriptions/${id(subId)}`),
  subscribe: (input: NewSubscription) => request<Subscription>('POST', '/me/subscriptions', input),
  pauseSubscription: (subId: string) => request<Subscription>('POST', `/me/subscriptions/${id(subId)}/pause`),
  resumeSubscription: (subId: string) => request<Subscription>('POST', `/me/subscriptions/${id(subId)}/resume`),
  cancelSubscription: (subId: string) => request<Subscription>('POST', `/me/subscriptions/${id(subId)}/cancel`),
  skipDelivery: (subId: string, scheduledFor: string) => request<Subscription>('POST', `/me/subscriptions/${id(subId)}/skip`, { scheduledFor }),
  /** Makes (or hands back) the ordinary unpaid order for one delivery; it is paid for on its order page. */
  payDelivery: (subId: string, cycleId: string, idempotencyKey: string) =>
    request<Confirmed>('POST', `/me/subscriptions/${id(subId)}/cycles/${id(cycleId)}/pay`, {}, { 'Idempotency-Key': idempotencyKey }),
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

  /** The bill PDF of my own paid order, as an object URL (it needs the sign-in, so it is fetched). */
  async billUrl(orderId: string): Promise<string> {
    if (!accessToken && profile) await refreshOnce()
    const get = () => fetch(`${API_URL}/v1/orders/${id(orderId)}/bill`, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} })
    let res = await get()
    if (res.status === 401 && profile && (await refreshOnce())) res = await get()
    if (!res.ok) throw new ApiError(res.status, 'BILL_UNAVAILABLE', 'The bill could not be downloaded. Try again in a minute.')
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

  // Gift orders to many recipients (MULTI_GIFT).
  giftQuote: (input: { recipients: GiftRecipientInput[]; deliveryDate: string | null; slotId: string | null; promoCode?: string | null }) =>
    request<GiftQuote>('POST', '/gifts/quote', input),
  giftConfirm: (input: { quoteId: string; name?: string; business?: BusinessDetails | null }, idempotencyKey: string) =>
    request<GiftConfirmed>('POST', '/gifts/confirm', input, { 'Idempotency-Key': idempotencyKey }),
  giftOrders: () => request<GiftOrderSummary[]>('GET', '/gifts'),
  giftOrder: (giftOrderId: string) => request<GiftOrder>('GET', `/gifts/${id(giftOrderId)}`),
  verifyGiftPayment: (giftOrderId: string, reply: CheckoutReply) => request<PaymentState>('POST', `/gifts/${id(giftOrderId)}/verify-payment`, reply),
  cancelGiftOrder: (giftOrderId: string) => request<void>('POST', `/gifts/${id(giftOrderId)}/cancel`),
  cancelGiftRecipient: (giftOrderId: string, orderId: string) => request<void>('POST', `/gifts/${id(giftOrderId)}/recipients/${id(orderId)}/cancel`),
  giftBillUrl: (giftOrderId: string) => fileUrl(`/gifts/${id(giftOrderId)}/bill`, 'BILL_UNAVAILABLE', 'The bill could not be downloaded. Try again in a minute.'),
  giftTemplateUrl: () => fileUrl('/gifts/template.csv', 'TEMPLATE_UNAVAILABLE', 'The template could not be downloaded. Try again in a minute.'),

  /** Partner With Us (docs/partner-network.md): the categories and the questionnaire. 404 while the switch is off. */
  partnerNetwork: () => raw<PartnerNetwork>('GET', '/partner-network'),
  /** Sends an enquiry. The key is made once per form fill, so a retry never makes a second one. */
  submitPartnerEnquiry: (input: { questionnaireVersion: string; answers: Answers; captchaToken?: string }, idempotencyKey: string) =>
    raw<PartnerSubmitted>('POST', '/partner-network/enquiries', input, { 'Idempotency-Key': idempotencyKey }),
  /** Uploads one supporting document after the enquiry is saved: the raw file, with the upload token. */
  uploadPartnerDocument: (reference: string, uploadToken: string, file: File, category: string) =>
    raw<{ id: string; name: string; category: string; size: number }>(
      'POST',
      `/partner-network/enquiries/${id(reference)}/documents${qs({ category, name: file.name })}`,
      file,
      { 'X-Upload-Token': uploadToken },
    ),

  /** Farm Experience (docs/farm-experience.md): 404 while the switch is off. */
  farmExperience: () => raw<FarmExperience>('GET', '/farm-experience'),
  farmDates: (varietyId: string | null, kg: number | null) =>
    raw<{ dates: FarmDate[] }>('GET', `/farm-experience/dates${qs({ varietyId, kg: kg == null ? null : String(kg) })}`),
  farmQuote: (varietyId: string, kg: number) => raw<FarmQuote>('POST', '/farm-experience/quote', { varietyId, kg }),
  /** Holds the mangoes and starts the payment. The key is made once per booking form, so a retry never books twice. */
  bookFarm: (input: FarmBookingInput, idempotencyKey: string) =>
    request<FarmBookingCreated>('POST', '/farm-bookings', input, { 'Idempotency-Key': idempotencyKey }),
  farmBookings: () => request<FarmBookingSummary[]>('GET', '/farm-bookings'),
  farmBooking: (bookingId: string) => request<FarmBooking>('GET', `/farm-bookings/${id(bookingId)}`),
  farmQrUrl: (bookingId: string) => fileUrl(`/farm-bookings/${id(bookingId)}/qr.svg`, 'PHOTO_UNAVAILABLE', 'The check-in code could not be loaded.'),
  verifyFarmPayment: (bookingId: string, reply: CheckoutReply) =>
    request<{ paymentStatus: string; status: FarmStatus }>('POST', `/farm-bookings/${id(bookingId)}/verify-payment`, reply),
  /** Starts (or picks up) the online payment of the bill after picking. */
  payFarm: (bookingId: string) => request<FarmPaymentStart>('POST', `/farm-bookings/${id(bookingId)}/pay`),
  cancelFarmBooking: (bookingId: string, reason?: string) =>
    request<{ requested: boolean; booking: FarmBooking }>('POST', `/farm-bookings/${id(bookingId)}/cancel`, reason ? { reason } : {}),
  moveFarmBooking: (bookingId: string, date: string, note?: string) =>
    request<{ requested: boolean; booking: FarmBooking }>('POST', `/farm-bookings/${id(bookingId)}/reschedule`, note ? { date, note } : { date }),
  answerFarmArrangement: (bookingId: string, accept: boolean) => request<FarmBooking>('POST', `/farm-bookings/${id(bookingId)}/hospitality`, { accept }),
  /** Development only: the API's stand-in for Razorpay. */
  devPay: (orderId: string, outcome: 'captured' | 'failed') => raw<{ result: string }>('POST', '/dev/pay', { orderId, outcome }),
  devPayPreorder: (preorderId: string, outcome: 'captured' | 'failed') =>
    raw<{ result: string }>('POST', '/dev/pay-preorder', { preorderId, outcome }),
  devPayGift: (giftOrderId: string, outcome: 'captured' | 'failed') => raw<{ result: string }>('POST', '/dev/pay-gift', { giftOrderId, outcome }),
  devPayFarm: (bookingId: string, outcome: 'captured' | 'failed') => raw<{ result: string }>('POST', '/dev/pay-farm', { bookingId, outcome }),
}

/**
 * Answers the shop shows in the customer's language (docs/languages.md): the shop's own
 * (a page the API could not answer, a file that would not download) and the API's commonest
 * fixed ones. Any other API message is shown as the API wrote it, in English.
 */
const TRANSLATED_ERRORS: Record<string, Key> = {
  BAD_RESPONSE: 'error.badResponse',
  UNAVAILABLE: 'error.unavailable',
  PHOTO_UNAVAILABLE: 'error.photoUnavailable',
  BILL_UNAVAILABLE: 'error.billUnavailable',
  TEMPLATE_UNAVAILABLE: 'error.templateUnavailable',
  NOT_SERVICEABLE: 'error.notServiceable',
  CART_EMPTY: 'error.cartEmpty',
  PHONE_REQUIRED: 'error.phoneRequired',
  PHONE_TAKEN: 'error.phoneTaken',
  PHONE_ALREADY_SET: 'error.phoneAlreadySet',
  SLOT_REQUIRED: 'error.slotRequired',
  SLOT_INVALID: 'error.slotInvalid',
  QUOTE_EXPIRED: 'error.quoteExpired',
  PROMO_NOT_FOR_BULK: 'error.promoNotForBulk',
  OTP_INVALID: 'error.otpInvalid',
  OTP_LIMIT: 'error.otpLimit',
  OTP_PAUSED: 'error.otpPaused',
  RATE_LIMITED: 'error.rateLimited',
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const key = currentLang() === 'en' ? undefined : TRANSLATED_ERRORS[err.code]
    return key ? t(key) : err.message
  }
  if (err instanceof TypeError) return t('error.network')
  if (err instanceof Error) return err.message
  return t('error.generic')
}
