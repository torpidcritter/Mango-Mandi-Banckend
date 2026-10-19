// Which role may do what. There are no refunds: claims end in a replacement
// or a rejection.
// The backend enforces the same split independently (mango-api src/access.js);
// the UI hides screens a role can't open and renders manager-only buttons
// disabled for operators.
//
// MANAGER: everything, plus staff, products, promos and the activity log.
// OPERATOR: everything except the manager-only actions below.
// PACKER: the pack list, deliveries and order steps through delivery.
// QC: receiving batches, QC and stock counts.
// RIDER: the day's deliveries, marked with the customer's code or a photo.

import type { OrderStatus, Role } from './types'

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
export const PACKER_STATUSES: OrderStatus[] = ['PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED']

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
  | 'scan'

const SCREENS: Record<Role, ReadonlySet<Screen> | 'all'> = {
  MANAGER: 'all',
  OPERATOR: new Set<Screen>(['today', 'batches', 'orders', 'orderDetail', 'packList', 'deliveries', 'claims', 'pincodes', 'planning', 'preorders', 'analytics', 'scan']),
  PACKER: new Set<Screen>(['packList', 'deliveries', 'orderDetail', 'scan']),
  QC: new Set<Screen>(['batches']),
  RIDER: new Set<Screen>(['deliveries', 'scan']),
}

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
