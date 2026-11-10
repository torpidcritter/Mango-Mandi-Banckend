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
  /** The box-tracked warehouse: off unless the API has it switched on; the permissions this role holds there. */
  warehouse?: { enabled: boolean; permissions: string[] }
  /** Switchable panel parts: bills, customer profiles and CSV exports (docs/trust.md) and the riders' Route view
   *  (docs/app-feel.md). An older API leaves a field out, which means off. The role still decides who may use them. */
  features?: {
    bills?: boolean
    customerProfiles?: boolean
    exports?: boolean
    riderRoute?: boolean
    /** Growth (docs/growth.md), managers only: the Referrals view, the funnel on Analytics, the evening summary. */
    referrals?: boolean
    funnelAnalytics?: boolean
    managerDailySummary?: boolean
    /** Staff operations (docs/ops.md): the stock forecast, farms and purchases, and the Settings page's switches. */
    stockForecast?: boolean
    purchaseRecords?: boolean
    panelSwitches?: boolean
    /** Gift orders on Orders (MULTI_GIFT, docs/gifting.md). */
    multiGift?: boolean
    /** Customer care (docs/care.md): the Help desk and Subscriptions pages. */
    helpDesk?: boolean
    subscriptions?: boolean
    /** Partner Network (PARTNER_NETWORK, docs/partner-network.md). On unless the API says false. */
    partnerNetwork?: boolean
    /** Farm Experience (docs/farm-experience.md): Bulk Orders → Farm Experience Bookings and its pages. */
    farmExperience?: boolean
  }
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
  /** A delivery of a gift order to many recipients (MULTI_GIFT, docs/gifting.md). */
  giftOrderId?: string
}

/** A gift order to many recipients (MULTI_GIFT, docs/gifting.md): one payment, one bill, a delivery order per recipient. */
export interface GiftOrderListItem {
  id: string
  number: string
  status: 'PAYMENT_PENDING' | 'PAID' | 'CANCELLED'
  paymentStatus: 'INITIATED' | 'SUCCEEDED' | 'CANCELLED' | 'FAILED'
  customerName: string | null
  deliveryDate: string
  placedAt: string
  paidAt: string | null
  recipientCount: number
  boxes: number
  subtotal: number
  discount: number
  promoCode: string | null
  total: number
  business: { name: string; gstin: string } | null
  children: {
    id: string
    number: string
    position: number
    status: OrderStatus
    deliveryDate: string
    pincode: string | null
    recipientName: string | null
    total: number
    atRisk?: boolean
    box: { sku: string; name: string; stage: string; qty: number } | null
    refund: { requestedAt: string; refundedAt: string | null } | null
  }[]
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
  unitPrice?: number
  /** Sold under a bulk deal: the deal, its version and the tier, as at confirmation. */
  bulk?: { listingId: string; title: string; listingVersion: number | null; tier: { minQty: number; maxQty: number | null; unitPrice: number } } | null
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
  /** A missed delivery whose retry staff can move to another day (PLT-08, PLT-09; DELIVERY_CHECKS on the API). */
  retryDateMovable?: boolean
  replacementFor?: { id: string; number: string } | null
  /** One recipient's delivery of a gift order to many (MULTI_GIFT): the gift order, this delivery's place in it, how many recipients. */
  giftOrder?: { id: string; number: string; position: number; recipients: number } | null
  /** Only a manager may cancel it: a paid order, and (when the API checks it) a free replacement. */
  cancelNeedsManager?: boolean
  slot?: { id: string; label: string; startsAt: string; endsAt: string } | null
  channel?: 'app' | 'whatsapp'
  notifications?: OrderNotification[]
  deliveryAttempts?: DeliveryAttempt[]
  /** The customer's rating after delivery. */
  rating?: { stars: number; comment: string | null; at: string } | null
  /** Boxes on a cancelled or returned order still to put back on the shelf or write off. */
  returnedBoxes?: number
  /** The customer's account, for their profile (null on old guest orders). */
  customerId?: string | null
  /** A business name and GSTIN the buyer gave at checkout, printed on the bill. */
  business?: { name: string; gstin: string } | null
  /** The order's bill, once it is paid (while bills are switched on). */
  bill?: BillSummary | null
}

export type BillKind = 'RECEIPT' | 'BILL_OF_SUPPLY' | 'TAX_INVOICE' | 'INVOICE_CUM_BILL_OF_SUPPLY'

/** A numbered bill: its number never changes; a cancelled order's bill stays, marked cancelled. */
export interface BillSummary {
  id: string
  number: string
  kind: BillKind
  title: string
  issuedAt: string
  billDate: string
  total: number
  cancelled: boolean
  cancelledAt: string | null
}

/** One customer found by phone (the number is masked to its last 4 digits). */
export interface CustomerMatch {
  id: string
  name: string | null
  phoneMasked: string | null
  createdAt: string
  orders: number
  lastOrderAt: string | null
}

/** The staff view of one customer (GET /customers/:id; every view is audited). */
export interface CustomerProfile {
  id: string
  name: string | null
  phoneMasked: string | null
  emailMasked: string | null
  hasPhone: boolean
  hasEmail: boolean
  signIn: { phone: boolean; google: boolean }
  createdAt: string
  deletedAt: string | null
  consent: { privacyAcceptedAt: string | null; remindersOptIn: boolean; openStockAlerts: number }
  stats: {
    paidOrders: number
    allOrders: number
    replacements: number
    lifetimeSpend: number
    refunds: number
    firstOrderAt: string | null
    lastOrderAt: string | null
    claims: number
    reviews: number
    averageRating: number | null
    openPreorders: number
  }
  orders: {
    id: string
    number: string
    status: OrderStatus
    placedAt: string
    deliveryDate: string
    total: number
    discount: number
    boxes: number
    paymentStatus: PaymentStatus | null
    channel: 'app' | 'whatsapp'
    replacement: boolean
    refund: 'REFUNDED' | 'PENDING' | null
    business: { name: string; gstin: string } | null
    bill: { number: string; cancelled: boolean } | null
  }[]
  ordersShown: number
  claims: {
    id: string
    orderId: string
    orderNumber: string
    issueType: string
    status: ClaimStatus
    resolution: ClaimResolution | null
    createdAt: string
    resolvedAt: string | null
    replacementOrder: { id: string; number: string } | null
  }[]
  reviews: { id: string; orderId: string; orderNumber: string; sku: string; productName: string; rating: number; status: ReviewStatus; comment: string | null; createdAt: string }[]
  ratings: { orderId: string; orderNumber: string; stars: number; comment: string | null; at: string }[]
  addresses: { id: string; name: string | null; address: string; pincode: string; lastUsedAt: string }[]
}

/** The CSV exports a manager can download (GET /exports/:kind). */
export type ExportKind = 'orders' | 'order-lines' | 'claims' | 'reviews' | 'bulk-orders' | 'payments' | 'refunds'

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
  /** The customer's account, for their profile. */
  customerId?: string | null
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
  /** Live tracking: rough minutes a rider spends per stop, for "N stops away" (docs/app-feel.md). */
  minutesPerStop?: number
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
  error?: { code?: string; message?: string; requestId?: string; [extra: string]: unknown }
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
  /** failCount: failures in a row; lastDurationMs: how long the last try took (both absent from older servers). */
  loop: {
    lastRunAt: string | null
    stale: boolean
    failingSteps: { step: string; since: string; error: string | null; failCount?: number | null; lastDurationMs?: number | null }[]
  }
  /** Browser notifications given up on (FAILED), or overdue and not yet sent (PENDING); absent from older servers. */
  failedPushes?: {
    id: string
    kind: string
    status: 'FAILED' | 'PENDING'
    error: string | null
    attempts: number
    createdAt: string
    order: { id: string; number: string } | null
  }[]
  /** The Docker server's nightly backup; null (or absent) where none is expected, as on Vercel. */
  backup?: { lastOkAt: string | null; stale: boolean } | null
  failedMessages: {
    id: string
    kind: string
    /** SKIPPED: dropped unsent (waited over a day, or no WhatsApp provider set); absent from older servers. */
    status?: 'FAILED' | 'SKIPPED'
    phone: string | null
    error: string | null
    attempts: number
    createdAt: string
    order: { id: string; number: string } | null
    preorderNumber: string | null
  }[]
  /**
   * type 'payment': a payment that matched no order (id is its payment id). paymentId is set for a
   * second payment too. state 'unsent': still retrying (a manager may record it paid back another way);
   * 'held': not sent while a chargeback on the payment is open or was lost (PAY-06); 'needs_manager':
   * failed too many times (attempts) and no longer retried on its own.
   */
  stuckRefunds: {
    type: 'order' | 'preorder' | 'payment'
    id: string
    number: string
    requestedAt: string
    paymentId?: string | null
    state?: 'unsent' | 'unconfirmed' | 'held' | 'needs_manager'
    /** Refund attempts made so far. */
    attempts?: number
    /** On a held refund: the chargeback holding it. Open until the bank decides; once lost or closed it is settled as paid back. */
    dispute?: { id: string; status: string } | null
  }[]
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
  /** Warehouses whose labelled boxes disagree with the stock counters (the hourly box check; WAREHOUSE_V2 only). */
  boxMismatches?: {
    warehouseId: string
    name: string
    stockMismatches: number
    orderUnitMismatches: number
    impossibleStates: number
    lotCountMismatches: number
  }[]
  /** Preorder weeks whose reserved capacity disagrees with the bookings holding it (INV-06). */
  preorderCapacityDrift?: { sku: string; weekStart: string; reserved: number; booked: number }[]
  /** Batches still in transit after their arrival date; sellingPaused: their stock no longer sells to new orders (INV-08). */
  lateArrivals?: { id: string; variety: string; farm: string | null; etaDate: string; promised: number; sellingPaused: boolean }[]
  /** Paid orders past their date or out for delivery too long. */
  overdueOrders?: OverdueOrder[]
  /** Missed deliveries whose retry can't go out as packed (too old, no younger stock): a manager decides. */
  retryDecisions?: { id: string; number: string; deliveryDate: string; reason: string | null; /** day: no open day or no room for the retry (PLT-08, PLT-09); stock: the packed boxes can't go. */ kind?: 'stock' | 'day' }[]
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
  /** The customer's account, for their profile. */
  customerId?: string | null
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
  /** A manager who gets the evening WhatsApp summary (MANAGER_DAILY_SUMMARY). */
  dailySummary?: boolean
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

// ---------- Bulk Deals ----------

export type BulkStatus = 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED' | 'ARCHIVED'
/** A price tier: from minQty boxes, at unitPrice paise a box. Each runs up to the next tier's start. */
export interface BulkTierInput {
  minQty: number
  unitPrice: number
}
/** What a manager edits on a listing. */
export interface BulkListingInput {
  sku: string
  title: string
  description: string
  origin: string
  stages: Ripeness[]
  minQty: number
  qtyStep: number
  maxQty: number | null
  tiers: BulkTierInput[]
  startsAt: string | null
  endsAt: string | null
  sortOrder: number
}
export interface BulkListingSummary extends BulkListingInput {
  id: string
  status: BulkStatus
  version: number
  productName: string
  photoUrl: string | null
  photoCount: number
  onSale: boolean
  publishProblems: string[]
  updatedAt: string
}
export interface BulkListing extends BulkListingInput {
  id: string
  status: BulkStatus
  version: number
  createdAt: string
  updatedAt: string
  publishedAt: string | null
  product: { sku: string; name: string; variety: string; boxSize: string; price: number; active: boolean } | null
  photos: { id: string; primary: boolean; width: number | null; height: number | null; sizeBytes: number | null; url: string }[]
  publishProblems: string[]
  onSale: boolean
  /** The most boxes one order can take after the unpaid-box rule. */
  orderMax: number
  tierView: { minQty: number; maxQty: number | null; unitPrice: number; savingPerBox: number | null }[]
}
export interface BulkEvent {
  id: string
  action: string
  version: number
  changes: Record<string, unknown>
  by: string | null
  at: string
}

// ---------------------------------------------------------------- growth (docs/growth.md)

export type ReferralStatus = 'PENDING' | 'REWARDED' | 'VOID'
/** One person in a referral: name and a masked phone. */
export interface ReferralPerson {
  id: string
  name: string | null
  phone: string | null
}
export interface Referral {
  id: string
  code: string
  status: ReferralStatus
  /** Why it ended without a reward, in words. */
  reason: string | null
  /** The friend got their thank-you, the referrer did not: over the monthly cap. */
  referrerCapped: boolean
  createdAt: string
  settledAt: string | null
  referrer: ReferralPerson
  friend: ReferralPerson
  /** The friend's first paid order, once there is one. */
  order: { id: string; number: string } | null
  /** value is a percent for PERCENT, paise for FLAT; maxDiscount is a paise cap or null. */
  rewards: { role: 'REFERRER' | 'FRIEND'; code: string; kind: 'PERCENT' | 'FLAT'; value: number; maxDiscount: number | null; withdrawn: boolean; used: boolean }[]
}
export interface ReferralList {
  counts: Record<ReferralStatus, number>
  rules: {
    rewardKind: 'PERCENT' | 'FLAT'
    rewardPercent: number | null
    rewardMaxRupees: number | null
    rewardRupees: number | null
    minOrderRupees: number
    maxPerMonth: number
  }
  items: Referral[]
}

export type FunnelStep = 'visit' | 'product_view' | 'add_to_cart' | 'checkout_start' | 'paid'
export interface FunnelRow {
  day: string | null
  counts: Record<FunnelStep, number>
  /** From a visit to each step, in percent (one decimal); null with no visits. */
  conversion: Record<FunnelStep, number | null>
  /** From the step before. */
  stepConversion: Partial<Record<FunnelStep, number | null>>
}
export interface Funnel {
  from: string
  to: string
  steps: FunnelStep[]
  days: FunnelRow[]
  totals: FunnelRow
}

export interface DailySummarySetting {
  optedIn: boolean
  /** Masked. */
  phone: string | null
  /** IST, HH:MM. */
  time: string
}
export interface DailySummaryPreview {
  day: string
  numbers: {
    orders: number
    revenue: number
    boxesDelivered: number
    boxesFailed: number
    newClaims: number
    unhappyRatings: number
    needsAttention: number
  }
  /** The message as it would read now. */
  text: string
  sendsAt: string
  /** Managers who opted in with a number. */
  recipients: number
  /** Summaries already queued today. */
  sentToday: number
}

// ---------- Staff operations (docs/ops.md) ----------

/** One past day the forecast looked at: what sold, and whether it counted (days with no stock or closed don't). */
export interface ForecastSample {
  date: string
  sold: number
  counted: boolean
  reason: 'closed' | 'no stock' | null
}

export interface ForecastDay {
  date: string
  history: { samples: ForecastSample[]; average: number | null }
  booked: number
  bookAhead: number
  /** max(average, booked); null without enough history. */
  expected: number | null
  toSell: number
  fromStock: number
  short: number
}

export interface ForecastProduct {
  sku: string
  name: string
  boxSize: string
  enoughHistory: boolean
  note: string | null
  suggestedBoxes: number | null
  shortForBookings: number
  shortBoxes: number
  buyBy: string | null
  waste: { days: number; damagedBoxes: number; claimBoxes: number; soldBoxes: number; rate: number; capped: boolean }
  shortDays: { date: string; stage: Ripeness; boxes: number; pluckBy: string | null; fromHistory: boolean }[]
  batches: {
    batchId: string
    pluckedOn: string
    ageToday: number
    status: BatchStatus
    onHand: number
    waitingQc: boolean
    freeBoxes: number
    sellableUntil: string
    usedByForecast: number
    unsoldPastCap: number
    stages: { date: string; stage: Ripeness | null }[]
  }[]
  stages: { stage: Ripeness; enoughHistory: boolean; short: number; days: ForecastDay[] }[]
}

export interface StockForecast {
  today: string
  dates: string[]
  rules: {
    horizonDays: number
    historyWeeks: number
    minHistoryDays: number
    wasteWindowDays: number
    maxWasteRate: number
    maxSellableAge: number
    transitDays: number
    forecastConfidence: number
  }
  varieties: {
    variety: string
    enoughHistory: boolean
    suggestedBoxes: number | null
    note: string | null
    shortForBookings: number
    buyBy: string | null
    products: ForecastProduct[]
  }[]
  hidden: string[]
}

export interface Farm {
  id: string
  name: string
  place: string | null
  contactName: string | null
  phoneMasked: string | null
  hasPhone: boolean
  active: boolean
  createdAt: string
  updatedAt: string
  purchases: number
  lastPurchaseOn: string | null
}

export interface FarmInput {
  name: string
  place?: string | null
  contactName?: string | null
  /** Left out keeps the number; null removes it. */
  phone?: string | null
  active?: boolean
}

/** A batch's purchase. The money fields come only to managers. */
export interface Purchase {
  id: string
  batchId: string
  farmId: string
  farmName: string | null
  purchasedOn: string
  crates: number
  boxes: number
  note: string | null
  createdAt: string
  updatedAt: string | null
  costPerCrate?: number
  transportCost?: number
  otherCost?: number
  totalCost?: number
  costPerBox?: number
}

export interface PurchaseInput {
  farmId: string
  purchasedOn: string
  crates: number
  boxes: number
  costPerCrate: number
  transportCost: number
  otherCost: number
  note?: string | null
}

export interface BatchPurchases {
  batchId: string
  receivedBoxes: number
  purchasedBoxes: number
  costsShown: boolean
  items: Purchase[]
  totalCost?: number
}

export interface MarginRow {
  boughtBoxes: number
  totalCost: number
  soldBoxes: number
  revenue: number
  costOfSold: number
  margin: number
  marginPerBox: number | null
  unsoldBoxes: number
  costOfUnsold: number
}

export interface Margins {
  from: string
  to: string
  varieties: (MarginRow & { variety: string; batches: number; costPerBox: number | null })[]
  batches: (MarginRow & { batchId: string; variety: string; pluckedOn: string; status: BatchStatus; costPerBox: number })[]
}

export interface FeatureSwitch {
  key: string
  label: string
  description: string
  /** The environment's own value. */
  envValue: boolean
  /** The environment says false: off, whatever is chosen here. */
  killedByEnv: boolean
  /** A manager's choice, or null for "as the environment says". */
  override: boolean | null
  updatedBy: string | null
  updatedAt: string | null
  effective: boolean
}

// ---------- Customer care (docs/care.md) ----------

export type HelpStatus = 'OPEN' | 'WAITING_CUSTOMER' | 'RESOLVED'
export type HelpTopic = 'DELIVERY' | 'PAYMENT' | 'CHANGE_ORDER' | 'SUBSCRIPTION' | 'ACCOUNT' | 'OTHER'

/** A help request as the Help desk sees it. The phone is masked to its last 4 digits. */
export interface HelpRequest {
  id: string
  number: string
  topic: HelpTopic
  topicLabel: string
  status: HelpStatus
  customer: { id: string; name: string | null; phoneMasked: string | null }
  order: { id: string; number: string | null; status: OrderStatus | null; deliveryDate: string | null } | null
  createdAt: string
  updatedAt: string
  lastCustomerAt: string | null
  lastStaffAt: string | null
  resolvedAt: string | null
  resolvedBy: string | null
  messageCount?: number
}

export interface HelpMessage {
  id: string
  from: 'CUSTOMER' | 'STAFF'
  staffEmail: string | null
  body: string
  at: string
}

export interface HelpRequestDetail extends HelpRequest {
  messages: HelpMessage[]
}

export interface HelpInbox {
  items: HelpRequest[]
  counts: Record<HelpStatus, number>
  topics: Record<HelpTopic, string>
}

export type SubscriptionStatus = 'ACTIVE' | 'PAUSED' | 'CANCELLED' | 'ENDED'
export type CycleStatus = 'DUE' | 'ORDERED' | 'SKIPPED' | 'MISSED' | 'CANCELLED'

export interface SubscriptionCycle {
  id: string
  scheduledFor: string
  deliveryDate: string | null
  slotId: string | null
  status: CycleStatus
  note: string | null
  order: { id: string; number: string; status: OrderStatus; paymentStatus: string; holdExpiresAt: string | null } | null
  canPay: boolean
  paid: boolean
  awaitingPayment: boolean
}

/** A subscription on the staff list: no address, the phone masked. */
export interface StaffSubscription {
  id: string
  number: string
  status: SubscriptionStatus
  sku: string
  productName: string
  unitPrice: number | null
  stage: Ripeness
  qty: number
  frequency: 'WEEKLY' | 'FORTNIGHTLY'
  weekday: number
  firstDate: string
  endDate: string
  slotId: string | null
  pincode: string
  createdAt: string
  pausedAt: string | null
  cancelledAt: string | null
  cycles: SubscriptionCycle[]
  upcoming: string[]
  customer: { id: string; name: string | null; phoneMasked: string | null }
}

export interface SubscriptionList {
  items: StaffSubscription[]
  counts: Record<'ACTIVE' | 'PAUSED' | 'CANCELLED', number>
}

// ---------------------------------------------------------------- WhatsApp (docs/whatsapp/OPERATIONS.md)

export type WaMode = 'BOT' | 'STAFF'
export type WaConversationStatus = 'OPEN' | 'WAITING' | 'CLOSED'
export type WaMessageStatus = 'RECEIVED' | 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'UNKNOWN'
export type WaInboxView = 'waiting' | 'mine' | 'staff' | 'all'

/** A conversation in the inbox: the phone shows only its last 4 digits. */
export interface WaConversation {
  id: string
  phone: string | null
  customer: { id: string; name: string | null } | null
  mode: WaMode
  status: WaConversationStatus
  assignedTo: { id: string; email: string | null } | null
  handoffReason: string | null
  waitingSince: string | null
  lastInboundAt: string | null
  lastOutboundAt: string | null
  /** Free-form replies are allowed until this time (24 hours after the customer's last message). */
  windowOpenUntil: string | null
  windowOpen: boolean
  unread: number
  updatedAt: string
  preview: string | null
}

export interface WaInbox {
  conversations: WaConversation[]
  counts: { waiting: number; staff: number; mine: number }
}

export interface WaMessage {
  id: string
  direction: 'IN' | 'OUT'
  type: string
  body: string | null
  template: string | null
  author: { kind: 'customer' | 'bot' | 'system' } | { kind: 'staff'; id: string; email: string | null }
  status: WaMessageStatus
  error: string | null
  createdAt: string
  statusAt: string | null
  media: { kind: string; mime: string | null; filename: string | null; caption: string | null; location: { name: string | null; address: string | null } | null; canOpen: boolean } | null
}

export interface WaConversationDetail {
  conversation: WaConversation
  messages: WaMessage[]
  consent: { updates: 'ALLOWED' | 'STOPPED'; marketing: 'NONE' | 'OPTED_IN' | 'OPTED_OUT' }
  recentOrders: { id: string; number: string; status: OrderStatus; deliveryDate: string; total: number }[]
}

export type WaAutomationState = 'OFF' | 'FLAG_OFF' | 'NOT_CHECKED' | 'AWAITING_TEMPLATE' | 'AWAITING_APPROVAL' | 'VARIABLES_MISMATCH' | 'READY'

export interface WaAutomation {
  kind: string
  template: string
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION'
  consent: 'updates' | 'requested' | 'marketing'
  params: string[]
  example: string[] | null
  trigger: string
  flag: string | null
  enabled: boolean
  state: WaAutomationState
  meta: { status: string; category: string | null; bodyParams: number | null; urlButton: boolean | null; reason: string | null } | null
}

export interface WaTemplateReport {
  language: string
  synced: boolean
  lastSyncedAt: string | null
  automations: WaAutomation[]
}

export interface WaReadinessItem {
  key: string
  label: string
  ok: boolean
  detail: string
  required: boolean
}

export interface WaConnectionCheck {
  at: string
  configured: boolean
  ok: boolean
  phone: { ok: boolean; problem?: string; number?: string | null; name?: string | null; quality?: string | null; limit?: string | null; nameStatus?: string | null; status?: string | null; message?: string | null } | null
  subscription: { ok: boolean; problem?: string; apps?: string[]; message?: string | null } | null
}

export interface WaOverview {
  readiness: { complete: boolean; missing: string[]; items: WaReadinessItem[]; environment: string }
  lastCheck: (WaConnectionCheck & { by?: string | null }) | null
  metrics: {
    inbound: number
    replies: number
    updates_sent: number
    updates_delivered: number
    updates_read: number
    updates_failed: number
    updates_skipped: number
    messages_failed: number
    messages_queued: number
    waiting: number
    oldest_waiting: string | null
    stopped: number
    last_webhook_at: string | null
    webhooks_unprocessed: number
    webhooks_given_up: number
  }
  health: { field: string; event: string | null; detail: Record<string, unknown>; at: string }[]
  templates: WaTemplateReport
  webhookUrl: string | null
}

export interface WaFailures {
  updates: { id: string; kind: string; number: string | null; phone: string | null; unknown: boolean; error: string | null; attempts: number; createdAt: string }[]
  messages: { id: string; conversationId: string; type: string; status: WaMessageStatus; error: string | null; attempts: number; phone: string | null; createdAt: string }[]
  events: { id: string; receivedAt: string; attempts: number; error: string | null; gaveUp: boolean }[]
}
