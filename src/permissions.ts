// Which role may do what. There are no refunds: claims end in a replacement
// or a rejection.
// The backend enforces the same split independently (mango-api src/access.js);
// the UI hides screens a role can't open and renders manager-only buttons
// disabled for operators.
//
// MANAGER: everything, plus staff, products, bulk deals, promos and the activity log.
// OPERATOR: everything except the manager-only actions below.
// PACKER: the pack list, deliveries and order steps through delivery.
// QC: receiving batches, QC and stock counts.
// RIDER: the day's deliveries, marked with the customer's code or a photo.
// Partner Network (docs/partner-network.md): managers and operators; the decisions,
// the CSV export and category edits are for managers.

import type { Me, OrderStatus, Role } from './types'

export type Action = 'condemnBatch' | 'deletePincode' | 'editRules' | 'moveDay' | 'manageStaff' | 'changeOrder'

const MANAGER_ONLY: ReadonlySet<Action> = new Set<Action>([
  'condemnBatch',
  'deletePincode',
  'editRules',
  'moveDay',
  'manageStaff',
])

export const MANAGER_ONLY_HINT = 'Requires manager role'

export const ROLE_LABEL: Record<Role, string> = { MANAGER: 'Manager', OPERATOR: 'Operator', PACKER: 'Packer', QC: 'QC', RIDER: 'Rider' }
export const ALL_ROLES: Role[] = ['MANAGER', 'OPERATOR', 'PACKER', 'QC', 'RIDER']

/** Packers, QC and riders only get their own work; cancelling or moving orders is not theirs. */
const LIMITED: ReadonlySet<Role> = new Set<Role>(['PACKER', 'QC', 'RIDER'])

export function can(role: Role | null | undefined, action: Action): boolean {
  if (!role) return false
  if (LIMITED.has(role)) return false
  return !MANAGER_ONLY.has(action) || role === 'MANAGER'
}

/** The order steps a packer may make; mirrors PACKER_STATUSES in the API. */
/** Mirrors the API: DELIVERED needs the customer's code or a photo (Deliveries page), or a manager's override. */
export const PACKER_STATUSES: OrderStatus[] = ['PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED']

export type Screen =
  | 'today'
  | 'batches'
  | 'orders'
  | 'orderDetail'
  | 'packList'
  | 'deliveries'
  | 'claims'
  | 'pincodes'
  | 'planning'
  | 'preorders'
  | 'analytics'
  | 'staff'
  | 'promos'
  | 'products'
  | 'reviews'
  | 'bulkDeals'
  | 'customers'
  | 'farms'
  | 'settings'
  | 'helpDesk'
  | 'subscriptions'
  | 'whatsapp'
  | 'partnerNetwork'
  | 'farmExperience'
  | 'farmReports'

const SCREENS: Record<Role, ReadonlySet<Screen> | 'all'> = {
  MANAGER: 'all',
  // Operators see farms without costs (docs/ops.md); Settings is for managers.
  OPERATOR: new Set<Screen>(['today', 'batches', 'orders', 'orderDetail', 'packList', 'deliveries', 'claims', 'pincodes', 'planning', 'preorders', 'analytics', 'reviews', 'customers', 'farms', 'helpDesk', 'subscriptions', 'whatsapp', 'partnerNetwork', 'farmExperience']),
  PACKER: new Set<Screen>(['packList', 'deliveries', 'orderDetail']),
  // QC sees the Reviews page's ripeness accuracy only (no moderation).
  QC: new Set<Screen>(['batches', 'reviews']),
  RIDER: new Set<Screen>(['deliveries']),
}

/** Approve, reject, hide and reply to reviews: managers and operators (the API refuses everyone else). */
export const canModerate = (role: Role | null | undefined) => role === 'MANAGER' || role === 'OPERATOR'

export function canSee(role: Role | null | undefined, screen: Screen): boolean {
  if (!role) return false
  const s = SCREENS[role]
  return s === 'all' || s.has(screen)
}

/** Where a role lands after signing in. */
export function homeFor(role: Role | null | undefined): string {
  if (role === 'PACKER') return '/pack-list'
  if (role === 'QC') return '/batches'
  if (role === 'RIDER') return '/deliveries'
  return '/today'
}

/**
 * Bills, customer profiles and CSV exports (docs/trust.md): each needs its switch on (/auth/me
 * features) and the right role. Bills and profiles: managers and operators. Exports: managers.
 */
export function trustAllowed(me: Me | null | undefined, feature: 'bills' | 'customerProfiles' | 'exports'): boolean {
  if (!me?.features?.[feature]) return false
  if (feature === 'exports') return me.role === 'MANAGER'
  return me.role === 'MANAGER' || me.role === 'OPERATOR'
}

/**
 * Staff operations (docs/ops.md): each needs its switch on (/auth/me features) and the right role.
 * The stock forecast and the Settings switches: managers. Farms and purchases: managers and operators
 * see them, QC sees a batch's purchases; only managers see or enter costs.
 */
export function opsAllowed(me: Me | null | undefined, feature: 'stockForecast' | 'purchaseRecords' | 'panelSwitches'): boolean {
  if (!me?.features?.[feature]) return false
  if (feature === 'purchaseRecords') return me.role === 'MANAGER' || me.role === 'OPERATOR' || me.role === 'QC'
  return me.role === 'MANAGER'
}
