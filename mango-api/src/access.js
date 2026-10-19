// Staff roles and the audit trail.
//
// MANAGER does everything. Every other role, OPERATOR included, gets only the
// routes listed for it below: anything not listed is refused, so a new route
// is closed to everyone but managers until someone adds it here (a test fails
// until every route is either listed for operators or manager-only).
import { background } from './background.js'
import { addDays, now, todayIST } from './clock.js'
import { query } from './db.js'
import { forbidden, notFound } from './errors.js'
import { newId } from './ids.js'
import { logger } from './logger.js'

export const ROLES = ['MANAGER', 'OPERATOR', 'PACKER', 'QC', 'RIDER']

/** True when the role may call this route (managers may call all of them). */
export const roleAllows = (role, method, path) => role === 'MANAGER' || (LIMITED[role] ?? []).some((r) => r.method === method && r.re.test(path))

/** The order steps a packer may make: packing, handing over and delivery. */
export const PACKER_STATUSES = ['PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED']

const route = (method, pattern) => ({ method, re: new RegExp(`^${pattern.replace(/:\w+/g, '[^/]+')}$`) })

const COMMON = [
  route('GET', '/auth/me'),
  route('GET', '/products'),
  route('GET', '/summary'),
  route('POST', '/me/two-step/setup'),
  route('POST', '/me/two-step/enable'),
  route('POST', '/me/two-step/disable'),
]

const DELIVERY = [
  route('GET', '/manifest'),
  route('POST', '/manifest/dispatch'),
  route('POST', '/orders/:id/dispatch'),
  route('POST', '/orders/:id/delivery-photos'),
  route('GET', '/orders/:id/delivery-photos/:photoId'),
  route('POST', '/orders/:id/delivery'),
]

/** The day-to-day running of the shop: everything except the manager-only routes (requireManager in admin.js). */
export const OPERATOR_ROUTES = [
  ...COMMON,
  ...DELIVERY,
  route('GET', '/batches'),
  route('POST', '/batches'),
  route('GET', '/batches/:id'),
  route('PATCH', '/batches/:id/status'), // condemning a batch also needs a manager
  route('POST', '/batches/:id/qc'),
  route('PATCH', '/batches/:id/lines/:lineId'),
  route('GET', '/batches/:id/ledger'),
  route('GET', '/orders'),
  route('GET', '/orders/:id'),
  route('PATCH', '/orders/:id/status'),
  route('POST', '/orders/:id/allocate'),
  route('POST', '/orders/:id/cancel'), // a paid order needs a manager (orders.js cancelOrder)
  route('POST', '/orders/:id/rebalance'),
  route('POST', '/orders/:id/reschedule'),
  route('GET', '/pack-list'),
  route('GET', '/delivery-reviews'),
  route('POST', '/delivery-reviews/:id'),
  route('GET', '/analytics'),
  route('GET', '/attention'),
  route('POST', '/notifications/:id/retry'),
  route('GET', '/claims'),
  route('GET', '/claims/:id/photos/:photoId'),
  route('POST', '/claims/:id/review'),
  route('POST', '/claims/:id/resolve'), // some replacements need a manager (claim limits)
  route('GET', '/pincodes'),
  route('POST', '/pincodes'),
  route('PATCH', '/pincodes/:pincode'),
  route('GET', '/config'),
  route('GET', '/calendar'),
  route('PUT', '/calendar/:date'),
  route('DELETE', '/calendar/:date'),
  route('GET', '/slots'),
  route('GET', '/preorders'),
  route('GET', '/preorder-capacity'),
  route('GET', '/coverage'),
  // Neighborhood Unlock (switching the feature on or off is manager-only).
  route('GET', '/zones'),
  route('POST', '/zones'),
  route('PATCH', '/zones/:id'),
  route('PUT', '/zones/:id/pincodes'),
  route('GET', '/unlock/campaigns'),
  route('POST', '/unlock/campaigns'),
  route('GET', '/unlock/campaigns/:id'),
  route('PATCH', '/unlock/campaigns/:id'),
  route('POST', '/unlock/campaigns/:id/open'),
  route('POST', '/unlock/campaigns/:id/cancel'),
  route('GET', '/unlock/templates'),
  route('POST', '/unlock/templates'),
  route('PATCH', '/unlock/templates/:id'),
  route('GET', '/unlock/settings'),
]

const LIMITED = {
  OPERATOR: OPERATOR_ROUTES,
  // Riders only see the day's run and record deliveries, with proof.
  RIDER: [...COMMON, ...DELIVERY],
  PACKER: [
    ...DELIVERY,
    ...COMMON,
    route('GET', '/pack-list'),
    route('GET', '/orders/:id'),
    route('GET', '/slots'),
    route('POST', '/orders/:id/allocate'),
    route('PATCH', '/orders/:id/status'),
  ],
  QC: [
    ...COMMON,
    route('GET', '/batches'),
    route('POST', '/batches'),
    route('GET', '/batches/:id'),
    route('GET', '/batches/:id/ledger'),
    route('PATCH', '/batches/:id/status'),
    route('POST', '/batches/:id/qc'),
    route('PATCH', '/batches/:id/lines/:lineId'),
  ],
}

/** Refuses everyone but managers anything not listed for their role. */
export function limitByRole(req, _res, next) {
  if (req.admin?.role === 'MANAGER') return next()
  const allowed = LIMITED[req.admin?.role] ?? []
  const ok = allowed.some((r) => r.method === req.method && r.re.test(req.path))
  if (!ok) return next(forbidden(`Not available to the ${req.admin.role.toLowerCase()} role`))
  if (req.admin.role === 'PACKER' && req.method === 'PATCH' && !PACKER_STATUSES.includes(req.body?.status)) {
    return next(forbidden('Packers can only move orders through packing and delivery'))
  }
  next()
}

/** Orders a rider may touch: on the road or ready to go. */
const RIDER_STATUSES = ['PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'DELIVERED']
const ORDER_PATH = /^\/orders\/([^/]+)\//

/** A rider's run is yesterday (late finishes), today or tomorrow, IST. */
const riderDates = () => {
  const today = todayIST()
  return [addDays(today, -1), today, addDays(today, 1)]
}

/**
 * Object-level checks for riders: limitByRole lets them reach the delivery
 * routes, this keeps those routes to orders on their run. Any other order id
 * (an old one, or one not packed yet) answers 404, as if it didn't exist,
 * and the manifest only opens for the run's dates, so a rider can't page
 * through every customer's address and phone number.
 */
export async function riderScope(req, _res, next) {
  if (req.admin?.role !== 'RIDER') return next()
  try {
    const dates = riderDates()
    const date = req.method === 'GET' ? req.query.date : req.body?.date
    if (req.path.startsWith('/manifest') && date !== undefined && !dates.includes(String(date))) {
      return next(forbidden('Riders can only open the run for today or tomorrow'))
    }
    const m = ORDER_PATH.exec(req.path)
    if (m) {
      const { rows } = await query('SELECT status, delivery_date FROM orders WHERE id = $1', [m[1]])
      const o = rows[0]
      if (!o || !RIDER_STATUSES.includes(o.status) || !dates.includes(o.delivery_date)) return next(notFound('Order not found'))
    }
    next()
  } catch (err) {
    next(err)
  }
}

// The customer's delivery code is a secret too.
const SECRET_KEYS = /password|token|secret|^code$/i

function clean(body) {
  if (Buffer.isBuffer(body)) return body.length ? { bytes: body.length } : null
  if (!body || typeof body !== 'object' || !Object.keys(body).length) return null
  const out = {}
  for (const [k, v] of Object.entries(body)) out[k] = SECRET_KEYS.test(k) ? '[removed]' : v
  const json = JSON.stringify(out)
  return json.length > 4000 ? { truncated: json.slice(0, 4000) } : out
}

export async function audit(admin, action, { target = null, detail = null, requestId = null } = {}) {
  try {
    await query(
      `INSERT INTO staff_audit (id, admin_id, email, role, action, target, detail, request_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [newId('aud'), admin.id ?? null, admin.email, admin.role, action, target, detail, requestId, now()],
    )
  } catch (err) {
    logger.error({ err, action }, 'staff audit write failed')
  }
}

/**
 * Records every successful staff change (any non-GET request that ended below
 * 400) once the response is sent: who, which route, on what, with what body.
 */
export function auditStaffChanges(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next()
  res.on('finish', () => {
    if (res.statusCode >= 400 || !req.admin || !req.route) return
    const p = req.params ?? {}
    const target = p.lineId ? `${p.id}/${p.lineId}` : p.weekStart ? `${p.weekStart}/${p.sku}` : (p.id ?? p.pincode ?? p.date ?? p.code ?? p.sku ?? null)
    background(audit(req.admin, `${req.method} ${req.route.path}`, { target, detail: clean(req.body), requestId: req.id }))
  })
  next()
}
