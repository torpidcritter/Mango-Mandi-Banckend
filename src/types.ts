// DTO shapes and status enums mirroring mango-api /admin/v1.
// Money is always integer paise. Dates are "YYYY-MM-DD" (date-only columns)
// or ISO timestamps.

export type Role = 'MANAGER' | 'OPERATOR' | 'PACKER' | 'QC' | 'RIDER'

export interface Me {
  email: string
  role: Role
  /**
   * Two-step sign-in: whether it is on, whether this role must use it, and
   * whether setting it up needs the one-time setup code a manager hands over.
   */
  twoStep?: { enabled: boolean; required: boolean; setupCodeNeeded?: boolean }
}

/** A sign-in either lands, or asks for the code from the authenticator app first. */
export type SignInResult = { me: Me } | { ticket: string }

export type BatchStatus =
  | 'ARRIVING'
  | 'IN_TRANSIT'
  | 'ARRIVED'
  | 'RIPENING'
  | 'SELLING'
  | 'EXHAUSTED'
  | 'CONDEMNED'

/** Forward-only order of the batch lifecycle. CONDEMNED sits outside it. */
export const BATCH_FLOW: BatchStatus[] = [
  'ARRIVING',
  'IN_TRANSIT',
  'ARRIVED',
  'RIPENING',
  'SELLING',
  'EXHAUSTED',
]

export const ALL_BATCH_STATUSES: BatchStatus[] = [...BATCH_FLOW, 'CONDEMNED']

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

export const ALL_ORDER_STATUSES: OrderStatus[] = [
  'PAYMENT_PENDING',
  'CONFIRMED',
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'DELIVERY_FAILED',
  'RTO',
  'CANCELLED',
]

export type PaymentStatus = 'INITIATED' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED' | 'CANCELLED'

export type Ripeness = 'RAW' | 'SEMI_RIPE' | 'RIPE'
export type Condition = 'GOOD' | 'FAIR' | 'REJECT'

export type ClaimStatus = 'SUBMITTED' | 'UNDER_REVIEW' | 'RESOLVED'
export type ClaimResolution = 'REFUND_APPROVED' | 'REPLACEMENT_APPROVED' | 'REJECTED'
export type IssueType = 'DAMAGED' | 'WRONG_ITEM' | 'NOT_DELIVERED'

export interface Product {
  sku: string
  name: string
  variety: string
  boxSize: string
  /** Paise, GST included. */
  price?: number
  /** A fraction: 0 for fresh mangoes. */
  gstRate?: number
  hsnCode?: string | null
  description?: string
  /** False once a manager removes it from sale; it stays for old orders and batches. */
  active?: boolean
  sortOrder?: number
  /** The shop photo, a path on the API (add API_URL), or null for the drawn mango. */
  photoUrl?: string | null
  /** What is in the box, shown on the shop's product page when set: about how many mangoes, and grams each. */
  fruitsPerBox?: number | null
  fruitWeightG?: number | null
}

export interface ProductInput {
  name: string
  variety: string
  boxSize: string
  price: number
  gstRate: number
  hsnCode: string | null
  description: string
  sortOrder: number
  fruitsPerBox: number | null
  fruitWeightG: number | null
}

export interface Summary {
  orders: Partial<Record<OrderStatus, number>>
  openClaims: number
  batchesNearLimit: { id: string; variety: string; ageDays: number; available: number }[]
  lowStock: { sku: string; productName: string; available: number }[]
  /** Open orders the stock engine could not keep whole. Ops must act on these. */
  atRiskOrders?: { id: string; number: string; deliveryDate: string; reason: string | null }[]
  /** Paid orders past their delivery date, or out for delivery too long (INV-G). */
  overdueOrders?: OverdueOrder[]
  /** Batches this many days old or older are past the sell limit (the live rule). */
  maxSellableAge?: number
}

export interface OverdueOrder {
  id: string
  number: string
  status: OrderStatus
  deliveryDate: string
  daysLate: number
  outSince: string | null
  reason: string
}

export interface BatchListItem {
  id: string
  variety: string
  pluckedOn: string
  ageDays: number
  farm: string | null
  status: BatchStatus
  latestRating: Ripeness | null
  latestCondition: Condition | null
  onHand: number
  held: number
  committed: number
  available: number
}

export interface BatchLine {
  id: string
  sku: string
  productName?: string
  onHand: number
  held: number
  committed: number
  reserveBuffer: number
  available: number
  /** Packed for orders that haven't left yet: off on hand but still on the shelf, so a count includes them. */
  packedNotDispatched?: number
}

/** Why staff changed a count (stored on the ledger row). */
export type AdjustReason = 'CORRECTION' | 'COUNT' | 'RECEIVED' | 'DAMAGED' | 'THEFT_LOSS' | 'RETURN_RESTOCK' | 'OTHER'

export interface QcEntry {
  id: string
  ripenessRating: Ripeness
  condition: Condition
  notes: string | null
  loggedBy: string
  loggedAt: string
}

export interface BatchDetail {
  id: string
  variety: string
  pluckedOn: string
  ageDays: number
  farm: string | null
  status: BatchStatus
  createdAt?: string
  lines: BatchLine[]
  qc: QcEntry[]
}

export interface LedgerEntry {
  id?: string
  eventType: 'INTAKE' | 'ADJUST' | 'HOLD' | 'COMMIT' | 'PACK' | 'RELEASE' | string
  sku: string | null
  delta: number
  actorType: string
  actorId: string
  /** The staff member's email, when actorId is a staff id. */
  actorEmail?: string | null
  reason: string | null
  reasonCode?: AdjustReason | null
  createdAt: string
}

export interface OrderListItem {
  id: string
  number: string
  customerName: string | null
  phone: string | null
  itemCount: number
  total: number
  status: OrderStatus
  deliveryDate: string
  placedAt: string
  atRisk?: boolean
  /** Where the customer placed it: the app or the WhatsApp chat. */
  channel?: 'app' | 'whatsapp'
}

export interface Paged<T> {
  page: number
  pageSize: number
  total: number
  items: T[]
}

export interface OrderItem {
  id?: string
  productName: string
  sku: string
  quantity: number
  stage: string | null
  linePrice: number
}

export type StockState = 'held' | 'committed' | 'packed' | 'released'

export interface OrderStock {
  id?: string
  batchId: string
  sku?: string
  stage?: string
  variety: string
  pluckedOn: string
  quantity: number
  state: StockState
}

export interface OrderEvent {
  status: OrderStatus
  actor: string | null
  reason: string | null
  createdAt: string
}

export interface OrderDetail {
  id: string
  number: string
  status: OrderStatus
  /** The delivery attempt a missed-delivery report made now is for. */
  attempt?: number
  customerName: string | null
  phone: string | null
  pincode: string | null
  deliveryAddress: string | null
  deliveryDate: string
  placedAt: string
  total: number
  subtotal?: number
  discount?: number
  promoCode?: string | null
  gift?: Gift | null
  items: OrderItem[]
  stock: OrderStock[]
  events: OrderEvent[]
  payment: {
    status: PaymentStatus | null
    method: string | null
    amount: number | null
    /** Set when the customer cancelled a paid order: the one case MandiMangoes refunds. */
    refund?: { requestedAt: string; refundedAt: string | null; id: string | null } | null
  } | null
  atRisk?: boolean
  atRiskReason?: string | null
  replacementFor?: { id: string; number: string } | null
  slot?: { id: string; label: string; startsAt: string; endsAt: string } | null
  channel?: 'app' | 'whatsapp'
  notifications?: OrderNotification[]
  deliveryAttempts?: DeliveryAttempt[]
  /** The customer's rating after delivery. */
  rating?: { stars: number; comment: string | null; at: string } | null
  /** Boxes on a cancelled or returned order still to put back on the shelf or write off. */
  returnedBoxes?: number
}

export type FailReason = 'NOT_HOME' | 'WRONG_ADDRESS' | 'REFUSED' | 'UNREACHABLE' | 'OTHER'

/** One delivery or missed delivery, with how it was proved. */
export interface DeliveryAttempt {
  id: string
  outcome: 'DELIVERED' | 'FAILED'
  /** code: the customer's code matched; photo: handed over with a photo; staff: marked from the panel, no proof */
  method: 'code' | 'photo' | 'staff' | null
  receivedBy: string | null
  reason: FailReason | null
  reasonLabel: string | null
  note: string | null
  photoId: string | null
  lat: number | null
  lng: number | null
  actor: string
  at: string
}

export type NotificationKind =
  | 'ORDER_CONFIRMED'
  | 'REPLACEMENT_CONFIRMED'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'DELIVERY_FAILED'
  | 'CANCELLED'
  | 'REFUNDED'
  | 'DATE_MOVED'
  | 'CLAIM_RECEIVED'
  | 'CLAIM_REJECTED'

/** A WhatsApp update to the customer, sent from an outbox with retries. */
export interface OrderNotification {
  kind: NotificationKind
  channel: string
  status: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED'
  attempts: number
  createdAt: string
  sentAt: string | null
  error: string | null
}

/** A delivery time window. maxBoxes caps boxes per day in this window (null = no cap). */
export interface DeliverySlot {
  id: string
  label: string
  startsAt: string
  endsAt: string
  maxBoxes: number | null
  active: boolean
  sort: number
}

export interface PackPick {
  batchId: string
  variety: string
  pluckedOn: string
  quantity: number
  packed: boolean
}

export interface PackListOrder {
  id: string
  number: string
  customerName: string | null
  pincode: string | null
  status: OrderStatus
  slot?: { id: string; label: string } | null
  gift?: Gift | null
  items: { sku: string; productName: string; quantity: number; picks: PackPick[] }[]
}

export interface Claim {
  id: string
  orderId: string
  orderNumber: string
  orderTotal: number
  customerPhone: string | null
  issueType: IssueType | string
  description: string
  affectedItems: string[]
  photoUrl?: string | null
  photos?: { id: string }[]
  status: ClaimStatus
  resolution?: ClaimResolution | null
  /** Why staff rejected it, as the customer sees it. */
  rejectionReason?: string | null
  createdAt?: string
  replacementOrder?: { id: string; number: string } | null
  /** Open claims only: the customer's last 90 days, and how the order was delivered. */
  history?: { claims90d: number; replacements90d: number }
  delivery?: { method: 'code' | 'photo' | 'staff'; at: string } | null
  /** Why a replacement needs a manager's approval, if it does. */
  managerNeeded?: string[] | null
}

export interface Pincode {
  pincode: string
  city: string
  zone: string | null
  active: boolean
}

export interface StageWindow {
  stage: Ripeness
  minAge: number
  maxAge: number
}

/** Versioned business rules (mango-api app_config). */
export interface Rules {
  maxSellableAge: number
  retireAge: number
  cutoffHourIST: number
  maxDaysAhead: number
  holdMinutes: number
  quoteMinutes: number
  forecastConfidence: number
  maxQcShift: number
  transitDays: number
  nearLimitAge: number
  lowStockThreshold: number
  claimWindowHours: number
  maxUnpaidOrders: number
  maxHeldBoxes: number
  /** An order out for delivery this long shows as overdue. */
  outForDeliveryAlertHours?: number
  /** A preorder moved forward more times than this waits for a manager. */
  maxPreorderMoves?: number
  /** The season's last delivery day (YYYY-MM-DD); preorders after it wait for a manager. */
  seasonEndsOn?: string | null
  stageProfiles: Record<string, StageWindow[]>
}

export interface RulesVersion {
  version: number
  rules: Rules
}

export interface CalendarDay {
  date: string
  isOpen: boolean
  maxBoxes: number | null
  note: string | null
}

/** Sellable boxes per SKU and stage for one bookable delivery date. */
export interface CoverageDay {
  date: string
  /** Boxes booked per delivery slot; empty when slots aren't in use. */
  slots?: { id: string; label: string; booked: number; maxBoxes: number | null }[]
  stock: { sku: string; stage: Ripeness; qty: number }[]
}

export interface ApiErrorBody {
  error?: { code?: string; message?: string; requestId?: string }
}

export type PreorderStatus = 'PAYMENT_PENDING' | 'BOOKED' | 'WAITLISTED' | 'CONVERTED' | 'CANCELLED'

/** A customer's booking for a delivery week, before the fruit exists. */
export interface Preorder {
  id: string
  number: string
  status: PreorderStatus
  sku: string
  productName: string
  stage: Ripeness
  qty: number
  unitPrice: number
  total: number
  weekStart: string
  pincode: string
  customerName: string | null
  phone: string
  channel: 'app' | 'whatsapp'
  paymentStatus: string | null
  movedCount: number
  createdAt: string
  refund: { requestedAt: string; refundedAt: string | null; id: string | null } | null
  order: { id: string; number: string; status: OrderStatus; deliveryDate: string } | null
}

export interface PreorderCapacity {
  sku: string
  productName: string
  weekStart: string
  capacity: number
  reserved: number
  waitlisted: number
}

/** One order picked by a bulk reschedule. */
export interface BulkMoveOrder {
  id: string
  number: string
  customerName: string
  pincode: string
}

/** What a bulk reschedule matched and did. With dryRun, moved and notMoved are empty. */
/** What a short arrival did to the orders on the line. */
export interface ShortArrivalResult {
  refilled: string[]
  moved: { number: string; deliveryDate: string }[]
  atRisk: string[]
}

export interface BulkMoveResult {
  matched: number
  orders: BulkMoveOrder[]
  moved: (BulkMoveOrder & { deliveryDate: string })[]
  notMoved: (BulkMoveOrder & { reason: string })[]
}

/** One delivery on the rider manifest. Every order is prepaid: nothing to collect. */
export interface ManifestOrder {
  id: string
  number: string
  customerName: string
  /** Left out (null) for packers: they handle boxes, riders handle people. */
  phone: string | null
  deliveryAddress: string | null
  status: OrderStatus
  packed: boolean
  boxes: number
  /** Which delivery attempt this is; sent back with the delivery report. */
  attempt?: number
  /** A gift: the name and phone above are the recipient's. */
  gift?: { from: string | null; message: string | null } | null
  /** The rider the stop is given to (riders only see their own stops). */
  rider?: { id: string; email: string | null } | null
  items: { sku: string; productName: string; stage: Ripeness | null; quantity: number }[]
}

/** A rider, for giving them stops on the Deliveries page. */
export interface Rider {
  id: string
  email: string
}

/** A day's delivery run: one run per slot (or one with no slot), stops by pincode. */
export interface Manifest {
  date: string
  orders: number
  boxes: number
  /** Riders only: packed stops on the date given to nobody yet (starting the run takes them). */
  unassigned?: number
  runs: {
    slot: { id: string; label: string; startsAt: string; endsAt: string } | null
    orders: number
    boxes: number
    stops: { pincode: string; city: string | null; zone: string | null; orders: ManifestOrder[] }[]
  }[]
}

/** One week (Monday start, by delivery date for sales) of season numbers. Money is in paise. */
export interface AnalyticsWeek {
  weekStart: string
  orders: number
  boxes: number
  revenue: number
  replacements: number
  delivered: number
  deliveryFailed: number
  customerCancels: number
  refunded: number
  received: number
  wasted: number
  condemned: number
  atRisk: number
  claims: number
  claimsReplaced: number
  /** Customer ratings of orders delivered that week, and their stars added up. */
  ratings?: number
  ratingStars?: number
  /** Average stars (1 to 5), one decimal; null when nobody rated. */
  averageRating?: number | null
  wastageRate: number | null
  atRiskRate: number | null
}

export interface Analytics {
  from: string
  to: string
  weeks: AnalyticsWeek[]
  bySku: { sku: string; productName: string; boxes: number; revenue: number; received: number; wasted: number; wastageRate: number | null }[]
  totals: Omit<AnalyticsWeek, 'weekStart'>
  /** Ratings of 1 or 2 stars, newest first, to call back. */
  lowRatings?: { orderId: string; number: string; deliveryDate: string; stars: number; comment: string | null; at: string }[]
}

/** Problems nobody would otherwise notice: the background loop, failed sends, stuck refunds, bad webhooks. */
export interface Attention {
  loop: { lastRunAt: string | null; stale: boolean; failingSteps: { step: string; since: string; error: string | null }[] }
  /** The Docker server's nightly backup; null (or absent) where none is expected, as on Vercel. */
  backup?: { lastOkAt: string | null; stale: boolean } | null
  failedMessages: {
    id: string
    kind: string
    phone: string | null
    error: string | null
    attempts: number
    createdAt: string
    order: { id: string; number: string } | null
    preorderNumber: string | null
  }[]
  /**
   * type 'payment': a payment that matched no order (id is its payment id). paymentId is set for a
   * second payment too. state 'unsent': still retrying (a manager may record it paid back another way).
   */
  stuckRefunds: { type: 'order' | 'preorder' | 'payment'; id: string; number: string; requestedAt: string; paymentId?: string | null; state?: 'unsent' | 'unconfirmed' }[]
  /** Not yet marked resolved. refundable: a captured payment that still matches nothing (a manager may refund it). */
  webhookFailures: { id: string; source: 'razorpay' | 'whatsapp'; reason: string; eventKey: string | null; createdAt: string; paymentId?: string | null; refundable?: boolean }[]
  /** Chargebacks still open at Razorpay; answered in the Razorpay dashboard. */
  disputes?: {
    id: string
    paymentId: string | null
    status: string
    amount: number | null
    reasonCode: string | null
    respondBy: string | null
    createdAt: string
    order: { id: string; number: string } | null
    preorderNumber: string | null
  }[]
  /** Orders missed too many times: call the customer before sending them out again. */
  failedDeliveries?: { id: string; number: string; name: string | null; phone: string | null; attempts: number }[]
  /** New 1 and 2 star reviews still waiting for a look. */
  lowRatings?: { id: string; rating: number; comment: string | null; sku: string; productName: string; createdAt: string; order: { id: string; number: string } }[]
  /** Delivered with only a photo, or marked delivered by a manager without proof: someone else checks it. */
  photoDeliveries?: PhotoDelivery[]
  /** Stock lines whose counters disagree with the ledger: [counter, source] pairs. */
  ledgerDrift?: LedgerDrift[]
  /** Paid orders past their date or out for delivery too long. */
  overdueOrders?: OverdueOrder[]
  /** Missed deliveries whose retry can't go out as packed (too old, no younger stock): a manager decides. */
  retryDecisions?: { id: string; number: string; deliveryDate: string; reason: string | null }[]
  /** Paid preorders moved forward too often or booked past the season end. */
  preorderDecisions?: { id: string; number: string; customerName: string | null; sku: string; qty: number; weekStart: string; movedCount: number; reason: string }[]
  /** Cancelled or returned orders whose boxes are still to be put back or written off. */
  returnedStock?: { id: string; number: string; status: OrderStatus; boxes: number }[]
}

/** Stock counters: on hand, the reserve buffer, held for unpaid orders and to pack for paid ones. */
export interface LineCounters {
  onHand: number
  reserveBuffer: number
  held: number
  committed: number
}

/** What repairing a drifting line from the ledger would change (GET /batches/:id/lines/:lineId/repair). */
export interface LedgerRepairPlan {
  lineId: string
  batchId: string
  sku?: string
  drifting: boolean
  before: LineCounters | null
  after: LineCounters | null
  canRepair: boolean
  problem: string | null
  repaired?: boolean
}

export interface LedgerDrift {
  lineId: string
  batchId: string
  sku: string
  onHand: [number, number]
  reserveBuffer: [number, number]
  held: [number, number]
  committed: [number, number]
}

export interface PhotoDelivery {
  id: string
  /** photo: handed over with a photo; staff: a manager marked it delivered without proof. */
  method?: 'photo' | 'staff'
  /** The manager's reason, for a delivery marked without proof. */
  note?: string | null
  receivedBy: string | null
  photoId: string | null
  actor: string
  at: string
  order: { id: string; number: string; name: string | null }
  flags: string[]
}

// ---------- Reviews ----------

export type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'HIDDEN' | 'DELETED'
export type ReviewFlag = 'LINK' | 'EMAIL' | 'PHONE' | 'PROFANITY'

export interface Review {
  id: string
  status: ReviewStatus
  flagged: boolean
  flagReasons: ReviewFlag[]
  rating: number
  taste: number | null
  ripenessAccuracy: number | null
  packaging: number | null
  delivery: number | null
  comment: string | null
  displayName: string
  anonymous: boolean
  customerName: string | null
  orderId: string
  orderNumber: string | null
  sku: string
  productName: string
  variety: string
  ripenessOrdered: Ripeness | null
  photos: { id: string; url: string; approved: boolean }[]
  reply: { body: string; at: string; by: string | null } | null
  deliveredAt: string
  createdAt: string
  updatedAt: string
  moderatedBy: string | null
  moderatedAt: string | null
  moderationReason: string | null
  scrubbed: boolean
}

export interface ReviewDetail extends Review {
  events: { from: ReviewStatus | null; to: ReviewStatus; actor: string; reason: string | null; at: string }[]
  batches: { batchId: string; quantity: number; variety: string; pluckedOn: string; farm: string | null }[]
}

export interface ReviewQueue {
  items: Review[]
  nextCursor: string | null
  counts: Partial<Record<ReviewStatus, { total: number; flagged: number }>>
}

export interface ReviewFilters {
  status: ReviewStatus
  stars?: number | null
  hasPhotos?: boolean | null
  flagged?: boolean | null
  variety?: string | null
  cursor?: string | null
}

export interface ReviewInsights {
  days: number
  byVariety: { variety: string; reviews: number; averageRating: number | null; ripenessAnswers: number; ripenessAccuracy: number | null; low: number }[]
  byBatch: {
    batchId: string
    variety: string
    pluckedOn: string
    farm: string | null
    reviews: number
    averageRating: number | null
    ripenessAnswers: number
    ripenessAccuracy: number | null
    notAsPromised: number
  }[]
  lowRatingTrend: { week: string; reviews: number; low: number }[]
}

export interface StaffMember {
  id: string
  email: string
  role: Role
  createdAt: string
  twoStep?: boolean
  /** Only when the person is added: the one-time code they need to set up two-step sign-in. */
  setupCode?: string
}

/** One staff change. `action` is the route ("PATCH /orders/:id/status") or "auth.login". */
export interface AuditEntry {
  id: string
  at: string
  email: string
  role: Role
  action: string
  target: string | null
  detail: Record<string, unknown> | null
}

export interface AuditPage extends Paged<AuditEntry> {
  staff: { email: string; role: Role }[]
}

export interface Promo {
  code: string
  kind: 'PERCENT' | 'FLAT'
  /** Percent (1 to 90), or paise off. */
  value: number
  maxDiscount: number | null
  minSubtotal: number
  startsOn: string | null
  endsOn: string | null
  maxUses: number | null
  perCustomer: number
  firstOrderOnly: boolean
  active: boolean
  description: string | null
  uses: number
  discountGiven?: number
  createdBy: string | null
  createdAt: string
}

export interface NewPromo {
  code: string
  kind: 'PERCENT' | 'FLAT'
  value: number
  maxDiscount?: number | null
  minSubtotal?: number
  startsOn?: string | null
  endsOn?: string | null
  maxUses?: number | null
  perCustomer?: number
  firstOrderOnly?: boolean
  description?: string | null
}

export interface Gift {
  recipientName: string
  recipientPhone: string
  message: string | null
}
