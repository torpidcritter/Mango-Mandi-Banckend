// DTO shapes and status enums mirroring mango-api /admin/v1.
// Money is always integer paise. Dates are "YYYY-MM-DD" (date-only columns)
// or ISO timestamps.

export type Role = 'MANAGER' | 'OPERATOR' | 'PACKER' | 'QC' | 'RIDER'

export interface Me {
  email: string
  role: Role
  /** Two-step sign-in: whether it is on, and whether this role must use it. */
  twoStep?: { enabled: boolean; required: boolean }
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
}

export interface Summary {
  orders: Partial<Record<OrderStatus, number>>
  openClaims: number
  batchesNearLimit: { id: string; variety: string; ageDays: number; available: number }[]
  lowStock: { sku: string; productName: string; available: number }[]
  /** Open orders the stock engine could not keep whole. Ops must act on these. */
  atRiskOrders?: { id: string; number: string; deliveryDate: string; reason: string | null }[]
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
}

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
  reason: string | null
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
  createdAt?: string
  replacementOrder?: { id: string; number: string } | null
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
  phone: string
  deliveryAddress: string | null
  status: OrderStatus
  packed: boolean
  boxes: number
  /** A gift: the name and phone above are the recipient's. */
  gift?: { from: string | null; message: string | null } | null
  items: { sku: string; productName: string; stage: Ripeness | null; quantity: number }[]
}

/** A day's delivery run: one run per slot (or one with no slot), stops by pincode. */
export interface Manifest {
  date: string
  orders: number
  boxes: number
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
  wastageRate: number | null
  atRiskRate: number | null
}

export interface Analytics {
  from: string
  to: string
  weeks: AnalyticsWeek[]
  bySku: { sku: string; productName: string; boxes: number; revenue: number; received: number; wasted: number; wastageRate: number | null }[]
  totals: Omit<AnalyticsWeek, 'weekStart'>
}

/** Problems nobody would otherwise notice: the background loop, failed sends, stuck refunds, bad webhooks. */
export interface Attention {
  loop: { lastRunAt: string | null; stale: boolean; failingSteps: { step: string; since: string; error: string | null }[] }
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
  stuckRefunds: { type: 'order' | 'preorder'; id: string; number: string; requestedAt: string }[]
  webhookFailures: { id: string; source: 'razorpay' | 'whatsapp'; reason: string; eventKey: string | null; createdAt: string }[]
}

export interface StaffMember {
  id: string
  email: string
  role: Role
  createdAt: string
  twoStep?: boolean
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
