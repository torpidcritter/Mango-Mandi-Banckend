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

/**
 * The order steps a packer may make: packing, handing over and a missed
 * delivery. Not DELIVERED: that needs the customer's code or a photo
 * (POST /orders/:id/delivery), or a manager's override (ORD-3).
 */
export const PACKER_STATUSES = ['PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED']

const route = (method, pattern) => ({ method, re: new RegExp(`^${pattern.replace(/:\w+/g, '[^/]+')}$`) })

const COMMON = [
  route('GET', '/auth/me'),
  route('GET', '/products'),
  route('GET', '/summary'),
  route('POST', '/me/two-step/setup'),
  route('POST', '/me/two-step/enable'),
  route('POST', '/me/two-step/disable'),
  route('POST', '/me/password'),
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
  route('POST', '/batches/:id/lines/:lineId/short-arrival'),
  route('GET', '/batches/:id/ledger'),
  route('GET', '/orders'),
  route('GET', '/orders/:id'),
  route('PATCH', '/orders/:id/status'),
  route('POST', '/orders/:id/allocate'),
  route('POST', '/orders/:id/cancel'), // a paid order needs a manager (orders.js cancelOrder)
  route('POST', '/orders/:id/rebalance'),
  route('POST', '/orders/:id/reschedule'),
  route('POST', '/orders/:id/returned-stock'), // boxes back from a cancelled or returned order (INV-F)
  route('GET', '/pack-list'),
  // Giving stops to riders (SEC-02): riders see only their own.
  route('GET', '/riders'),
  route('POST', '/manifest/assign'),
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
  // Review moderation: the queue, publishing, rejecting, hiding and replies.
  route('GET', '/reviews'),
  route('GET', '/reviews/insights'),
  route('GET', '/reviews/:id'),
  route('GET', '/reviews/:id/photos/:photoId'),
  route('POST', '/reviews/:id/approve'),
  route('POST', '/reviews/:id/reject'),
  route('POST', '/reviews/:id/hide'),
  route('POST', '/reviews/bulk'),
  route('PUT', '/reviews/:id/reply'),
  route('DELETE', '/reviews/:id/reply'),
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
    route('POST', '/batches/:id/lines/:lineId/short-arrival'),
    // Ripeness accuracy from reviews, per batch and variety (read only).
    route('GET', '/reviews/insights'),
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
/** Unassigned orders a rider may take by sending them out (POST /orders/:id/dispatch). */
export const RIDER_TAKES = ['PACKED', 'SHIPPED', 'DELIVERY_FAILED']
const DISPATCH_PATH = /^\/orders\/[^/]+\/dispatch$/
/** Orders a packer may open: being packed or on the road. Not delivered ones (SEC-02). */
const PACKER_ORDER_STATUSES = ['CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED']
const ORDER_PATH = /^\/orders\/([^/]+)(?:\/|$)/
const DATED_LISTS = ['/manifest', '/pack-list']

/** A rider's run is yesterday (late finishes), today or tomorrow, IST. */
const riderDates = () => {
  const today = todayIST()
  return [addDays(today, -1), today, addDays(today, 1)]
}

/**
 * Object-level checks for riders and packers: limitByRole lets them reach the
 * delivery and packing routes, this keeps those routes to orders on the run
 * (yesterday for late finishes, today, tomorrow). Any other order id answers
 * 404, as if it didn't exist, and the manifest and pack list only open for
 * those dates, so neither role can page through every customer's address and
 * phone number. Packers also never see delivered orders (SEC-02), and their
 * views leave out phone numbers and addresses (see redactForPacker).
 *
 * Riders (SEC-02, 23 Oct): only their own stops, the orders whose rider_id is
 * theirs (staff assign them on the Deliveries page, or the rider takes an
 * unassigned packed order by sending it out). Another rider's stop answers
 * 404, and a delivered stop from before today is gone from their view.
 */
export async function riderScope(req, _res, next) {
  const role = req.admin?.role
  if (role !== 'RIDER' && role !== 'PACKER') return next()
  try {
    const dates = riderDates()
    const date = req.method === 'GET' ? req.query.date : req.body?.date
    if (DATED_LISTS.some((p) => req.path.startsWith(p)) && date !== undefined && !dates.includes(String(date))) {
      return next(forbidden(`${role === 'RIDER' ? 'Riders' : 'Packers'} can only open the run for today or tomorrow`))
    }
    const m = ORDER_PATH.exec(req.path)
    if (m) {
      const { rows } = await query('SELECT status, delivery_date, rider_id FROM orders WHERE id = $1', [m[1]])
      const o = rows[0]
      const statuses = role === 'RIDER' ? RIDER_STATUSES : PACKER_ORDER_STATUSES
      if (!o || !statuses.includes(o.status) || !dates.includes(o.delivery_date)) return next(notFound('Order not found'))
      if (role === 'RIDER' && !riderMaySee(req.admin.id, o, req)) return next(notFound('Order not found'))
    }
    next()
  } catch (err) {
    next(err)
  }
}

/**
 * A rider's own stop, or an unassigned packed one they are sending out (which
 * takes it: see dispatchOrder). Delivered stops only on or after today.
 */
function riderMaySee(riderId, o, req) {
  if (o.status === 'DELIVERED' && o.delivery_date < todayIST()) return false
  if (o.rider_id === riderId) return true
  return o.rider_id === null && RIDER_TAKES.includes(o.status) && req.method === 'POST' && DISPATCH_PATH.test(req.path)
}

/**
 * What a packer needs is boxes, not people: SKU, ripeness, quantity, the slot
 * and the area. Phone numbers, addresses, payments and messages are left out.
 */
export const isPacker = (req) => req.admin?.role === 'PACKER'
export function redactForPacker(order) {
  return {
    ...order,
    phone: null,
    deliveryAddress: null,
    ...(order.gift ? { gift: { ...order.gift, recipientPhone: null } } : {}),
    ...('payment' in order ? { payment: null } : {}),
    ...('notifications' in order ? { notifications: [] } : {}),
    ...('deliveryAttempts' in order ? { deliveryAttempts: order.deliveryAttempts.map((a) => ({ ...a, lat: null, lng: null })) } : {}),
  }
}

// The customer's delivery code is a secret too.
const SECRET_KEYS = /password|token|secret|^code$|setupcode/i
// SEC-R3: where the rider stood and who took the box are the customer's data. They are
// kept in delivery_attempts (erased with the account, anonymised after PII_RETENTION_MONTHS),
// not copied into the audit trail. A delivery note stays (staff read it there) and is
// removed from the order's audit rows with the rest (ORDER_AUDIT_PERSONAL_KEYS).
const PERSONAL_KEYS = /^(lat|lng|receivedBy)$/
/** Keys taken out of an order's audit rows when its customer details go (privacy.js, retention.js). */
export const ORDER_AUDIT_PERSONAL_KEYS = ['lat', 'lng', 'receivedBy', 'note']

function clean(body) {
  if (Buffer.isBuffer(body)) return body.length ? { bytes: body.length } : null
  if (!body || typeof body !== 'object' || !Object.keys(body).length) return null
  const out = {}
  for (const [k, v] of Object.entries(body)) out[k] = SECRET_KEYS.test(k) || PERSONAL_KEYS.test(k) ? '[removed]' : v
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
    // req.audited: the route wrote its own, fuller row inside its transaction (product changes).
    if (res.statusCode >= 400 || !req.admin || !req.route || req.audited) return
    const p = req.params ?? {}
    const target = p.lineId ? `${p.id}/${p.lineId}` : p.weekStart ? `${p.weekStart}/${p.sku}` : (p.id ?? p.pincode ?? p.date ?? p.code ?? p.sku ?? null)
    background(audit(req.admin, `${req.method} ${req.route.path}`, { target, detail: clean(req.body), requestId: req.id }))
  })
  next()
}
