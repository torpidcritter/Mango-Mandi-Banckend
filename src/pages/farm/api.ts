// Every Farm Experience call (mango-api /admin/v1/farm/*, docs/farm-experience.md). The API
// checks every rule and role again; the panel only hides what a role can't do.
import { apiBlobUrl, apiRequest } from '../../api'

const F = '/farm'
const id = encodeURIComponent

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

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

export type HospitalityStatus = 'PENDING' | 'APPROVED' | 'ALTERNATIVE_PROPOSED' | 'CUSTOMER_ACCEPTED' | 'CUSTOMER_DECLINED'
export interface MealDay {
  date: string
  breakfast: number
  lunch: number
  dinner: number
  refreshments: number
}
export interface BookingRow {
  id: string
  number: string
  status: FarmStatus
  statusLabel: string
  customerName: string
  phone: string
  email: string | null
  variety: string
  varietyId: string
  kg: number
  /** The estimate at booking; billAmount is the bill after weighing (null until then). */
  total: number
  billAmount: number | null
  paidAt: string | null
  paymentId: string | null
  visitDate: string
  arrivalDate: string
  departureDate: string
  adults: number
  children: number
  guests: number
  overnight: number
  hospitalityStatus: HospitalityStatus
  overCapacity: boolean
  foodSummary: { veg?: number; nonVeg?: number; jain?: number; allergies?: string; requests?: string }
  harvestStatus: string
  packingStatus: string
  request: 'CANCEL' | 'RESCHEDULE' | null
  refundStatus: string | null
  createdAt: string
}
export interface BookingList {
  total: number
  page: number
  pageSize: number
  items: BookingRow[]
}
export interface BookingQuery {
  q?: string
  status?: string
  varietyId?: string
  visitFrom?: string
  visitTo?: string
  createdFrom?: string
  createdTo?: string
  payment?: string
  minKg?: string
  maxKg?: string
  minGuests?: string
  maxGuests?: string
  needsAction?: string
  sort?: string
  dir?: string
  page?: string
  pageSize?: string
}
export interface Overview {
  byStatus: Record<FarmStatus, number>
  needsAction: number
  refundsPending: number
  nextTwoWeeks: { visit_date: string; bookings: number; guests: number; overnight: number; kg: number }[]
}
export interface Booking {
  id: string
  number: string
  status: FarmStatus
  statusLabel: string
  refundStatus: string | null
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
    list: { name: string; child?: boolean }[]
  }
  contact: { name: string; phone: string; email: string | null }
  billing: { name: string | null; gstin: string | null } | null
  hospitality: {
    status: HospitalityStatus
    plan: string | null
    alternative: string | null
    overCapacity: boolean
    rooms: { roomId: string; name: string; fromDate: string; toDate: string; guests: number; extraBeds: number; note: string | null }[]
    mealPlan: MealDay[]
  }
  harvest: { status: string; harvestedKg: number | null; acceptedKg: number | null; inspectionNote: string | null; packingStatus: string }
  money: { paid: number; refunded: number; refunds: { id: string; amount: number; kind: string; reason: string | null; status: string; requestedAt: string; refundedAt: string | null }[] }
  request: { kind: 'CANCEL' | 'RESCHEDULE'; date: string | null; note: string | null; at: string } | null
  paidAt: string | null
  cancelledAt: string | null
  cancelReason: string | null
  completedAt: string | null
  checkedInAt: string | null
  createdAt: string
  version: number
  customer: { id: string; name: string | null; phone: string | null; email: string | null } | null
  checkinCode: string
  kgReserved: boolean
  harvestDay: { estimatedKg: number; bookableKg: number; reservedKg: number; readiness: string; qcStatus: string } | null
  payments: {
    id: string
    kind: 'ONLINE' | 'RECORDED'
    amount: number
    status: string
    razorpayOrderId: string | null
    paymentId: string | null
    method: string | null
    reference: string | null
    receivedOn: string | null
    note: string | null
    recordedBy: string | null
    failed: boolean
    createdAt: string
    paidAt: string | null
  }[]
  events: { id: string; from: string | null; to: string; action: string; detail: string | null; actor: string; actorKind: string; at: string }[]
  notes: { id: string; body: string; author: string; at: string }[]
  nextMoves: string[]
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
/** A payment taken at the farm: the full bill, the day it came in, and private remarks. */
export type RecordPaymentBody = { method: RecordedMethod; reference: string; amount: number; receivedOn: string; note?: string }

export type RecordedMethod = 'UPI' | 'CARD' | 'CASH' | 'BANK_TRANSFER'
export interface HarvestCell {
  varietyId: string
  name: string
  estimatedKg: number
  bookableKg: number
  confirmedKg: number | null
  reservedKg: number
  availableKg: number
  readiness: string
  qcStatus: string
  note: string | null
}
export interface CalendarDay {
  date: string
  open: boolean
  closedReason: string | null
  maxBookings: number | null
  note: string | null
  harvest: HarvestCell[]
  visits: { id: string; number: string; status: FarmStatus; name: string; variety: string; kg: number; guests: number; hospitalityStatus: HospitalityStatus; overCapacity: boolean }[]
  overnightGuests: number
  roomsInUse: number
  overlaps: string[]
}
export interface Calendar {
  from: string
  to: string
  rooms: number
  beds: number
  days: CalendarDay[]
}
export interface Variety {
  id: string
  name: string
  sku: string | null
  description: string
  ripenessNote: string
  harvestFrom: string | null
  harvestTo: string | null
  pricePerKg: number
  tiers: { minKg: number; pricePerKg: number }[]
  active: boolean
  sortOrder: number
  version: number
}
export interface Room {
  id: string
  name: string
  description: string
  sleeps: number
  beds: number
  extraBeds: number
  active: boolean
  maintenance: boolean
  note: string | null
  sortOrder: number
}
export type FarmSettings = Record<string, unknown> & {
  meals: { breakfast: boolean; lunch: boolean; dinner: boolean; refreshments: boolean }
  faqs: { q: string; a: string }[]
  bookingsOpen: boolean
  transportIncluded: boolean
}
export interface SettingsAnswer {
  settings: FarmSettings
  version: number
  updatedAt: string | null
  problems: string[]
}
export interface Report {
  from: string
  to: string
  bookings: number
  kgBooked: number
  kgHarvested: number
  revenue: number
  paidBookings: number
  avgKg: number
  guestsHosted: number
  avgGroup: number
  completed: number
  cancelled: number
  noShows: number
  cancellationRate: number
  conversion: { started: number; paid: number; rate: number }
  refunds: { count: number; value: number }
  extras: { revenue: number; kg: number }
  varieties: { name: string; bookings: number; kg: number; revenue: number }[]
  utilisation: { openDays: number; visitSlots: number | null; visitRate: number | null; roomNights: number; roomNightsAvailable: number; roomRate: number | null; guestNights: number }
}

const withCode = <T extends object>(body: T, confirmCode?: string) => (confirmCode ? { ...body, confirmCode } : body)

export const farm = {
  overview: () => apiRequest<Overview>('GET', `${F}/overview`),
  bookings: (q: BookingQuery) => apiRequest<BookingList>('GET', `${F}/bookings${qs({ ...q })}`),
  booking: (bookingId: string) => apiRequest<Booking>('GET', `${F}/bookings/${id(bookingId)}`),
  patch: (bookingId: string, body: { hospitalityPlan?: string; mealPlan?: MealDay[]; version?: number }) =>
    apiRequest<Booking>('PATCH', `${F}/bookings/${id(bookingId)}`, body),
  note: (bookingId: string, body: string) => apiRequest<Booking>('POST', `${F}/bookings/${id(bookingId)}/notes`, { body }),
  hospitality: (bookingId: string, action: 'APPROVE' | 'PROPOSE', text?: string) =>
    apiRequest<Booking>('POST', `${F}/bookings/${id(bookingId)}/hospitality`, text ? { action, text } : { action }),
  rooms: (bookingId: string, allocations: { roomId: string; fromDate: string; toDate: string; guests: number; extraBeds?: number; note?: string }[]) =>
    apiRequest<Booking>('PUT', `${F}/bookings/${id(bookingId)}/rooms`, { allocations }),
  status: (bookingId: string, to: string, note?: string) => apiRequest<Booking>('POST', `${F}/bookings/${id(bookingId)}/status`, note ? { to, note } : { to }),
  harvest: (
    bookingId: string,
    body: { harvestedKg?: number; acceptedKg?: number; inspectionNote?: string; harvestStatus?: string; packingStatus?: string },
  ) => apiRequest<Booking>('POST', `${F}/bookings/${id(bookingId)}/harvest`, body),
  /** The bill after weighing (or a corrected one before it is paid). */
  bill: (bookingId: string, acceptedKg?: number) => apiRequest<Booking>('POST', `${F}/bookings/${id(bookingId)}/bill`, acceptedKg == null ? {} : { acceptedKg }),
  /** A manager records the bill paid at the farm (always confirmed with the manager's password). */
  recordPayment: (bookingId: string, body: RecordPaymentBody, confirmCode?: string) =>
    apiRequest<Booking>('POST', `${F}/bookings/${id(bookingId)}/record-payment`, withCode(body, confirmCode)),
  move: (bookingId: string, date: string, reason: string, outsideWindow = false) =>
    apiRequest<Booking>('POST', `${F}/bookings/${id(bookingId)}/move`, { date, reason, ...(outsideWindow && { outsideWindow }) }),
  cancel: (bookingId: string, reason: string) => apiRequest<Booking>('POST', `${F}/bookings/${id(bookingId)}/cancel`, { reason }),
  declineRequest: (bookingId: string, reason: string) => apiRequest<Booking>('POST', `${F}/bookings/${id(bookingId)}/request/decline`, { reason }),
  noShow: (bookingId: string, note?: string) => apiRequest<Booking>('POST', `${F}/bookings/${id(bookingId)}/no-show`, note ? { note } : {}),
  settleRefund: (refundId: string, reference: string, confirmCode?: string) =>
    apiRequest<Booking>('POST', `${F}/refunds/${id(refundId)}/settle`, withCode({ reference }, confirmCode)),

  findByCode: (code: string) => apiRequest<Booking>('GET', `${F}/check-in/${id(code)}`),
  checkIn: (code: string, override = false) => apiRequest<Booking>('POST', `${F}/check-in`, override ? { code, override } : { code }),

  calendar: (from: string, to?: string) => apiRequest<Calendar>('GET', `${F}/calendar${qs({ from, to })}`),
  saveDay: (date: string, body: { open: boolean; closedReason?: string | null; maxBookings?: number | null; note?: string | null }) =>
    apiRequest<{ bookingsToMove: string[] }>('PUT', `${F}/days/${id(date)}`, body),
  saveDays: (body: { from: string; to: string; weekdays?: number[]; day: { open: boolean; closedReason?: string | null; maxBookings?: number | null; note?: string | null } }) =>
    apiRequest<{ days: number; bookingsToMove: string[] }>('POST', `${F}/days`, body),
  saveHarvest: (
    varietyId: string,
    date: string,
    body: { estimatedKg?: number; bookableKg?: number; confirmedKg?: number | null; readiness?: string; qcStatus?: string; note?: string | null },
  ) => apiRequest<HarvestCell>('PUT', `${F}/harvest/${id(varietyId)}/${id(date)}`, body),

  varieties: () => apiRequest<Variety[]>('GET', `${F}/varieties`),
  addVariety: (body: Partial<Variety>, confirmCode?: string) => apiRequest<Variety>('POST', `${F}/varieties`, withCode(body, confirmCode)),
  patchVariety: (varietyId: string, body: Partial<Variety> & { version: number }, confirmCode?: string) =>
    apiRequest<Variety>('PATCH', `${F}/varieties/${id(varietyId)}`, withCode(body, confirmCode)),

  roomList: () => apiRequest<Room[]>('GET', `${F}/rooms`),
  addRoom: (body: Partial<Room>) => apiRequest<Room>('POST', `${F}/rooms`, body),
  patchRoom: (roomId: string, body: Partial<Room>) => apiRequest<Room>('PATCH', `${F}/rooms/${id(roomId)}`, body),

  settings: () => apiRequest<SettingsAnswer>('GET', `${F}/settings`),
  saveSettings: (settings: Partial<FarmSettings>, version: number, confirmCode?: string) =>
    apiRequest<SettingsAnswer>('PUT', `${F}/settings`, withCode({ settings, version }, confirmCode)),

  report: (q: { from: string; to: string; varietyId?: string }) => apiRequest<Report>('GET', `${F}/reports${qs(q)}`),
  csvUrl: (q: { from: string; to: string; varietyId?: string }) => apiBlobUrl(`${F}/reports/bookings.csv${qs(q)}`),
}
