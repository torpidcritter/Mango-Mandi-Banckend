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
import { env } from './env.js'
import { logger } from './logger.js'
import { hit } from './ratelimit.js'
import { READ_AUDITED_ROUTES } from './admin/policy.js'
import { ROLE_PERMISSIONS, WAREHOUSE_ROUTES } from './warehouse/permissions.js'

export const ROLES = ['MANAGER', 'OPERATOR', 'PACKER', 'QC', 'RIDER']

/** True when the role may call this route (managers may call all of them). */
export const roleAllows = (role, method, path) => role === 'MANAGER' || (LIMITED[role] ?? []).some((r) => r.method === method && r.re.test(path))

/**
 * The order steps a packer may make: packing, handing over and a missed
 * delivery. Not DELIVERED: that needs the customer's code or a photo
 * (POST /orders/:id/delivery), or a manager's override (ORD-3).
 */
export const PACKER_STATUSES = ['PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED']

/**
 * What a path parameter may look like. An id is our own (prefix_hex, a box code, an SKU):
 * letters, digits, _ and -, nothing else, so an allowlisted route can't be stretched to a
 * path the role was never given (an encoded slash, dots, a second segment).
 */
const PARAM_FORMATS = {
  pincode: '\\d{6}',
  date: '\\d{4}-\\d{2}-\\d{2}',
  weekStart: '\\d{4}-\\d{2}-\\d{2}',
}
export const ID_SEGMENT = '[A-Za-z0-9][A-Za-z0-9_-]{0,63}'
const route = (method, pattern) => ({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, (_m, name) => PARAM_FORMATS[name] ?? ID_SEGMENT)}$`) })

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

/** The warehouse routes a role's permissions cover (warehouse/permissions.js); managers have all of them. */
const warehouseFor = (role) => WAREHOUSE_ROUTES.filter(([, , perm]) => ROLE_PERMISSIONS[role].includes(perm)).map(([m, p]) => route(m, p))

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
  // Farms and a batch's purchases without any costs (PURCHASE_RECORDS; costs are for managers, admin/ops.js).
  route('GET', '/farms'),
  route('GET', '/batches/:id/purchases'),
  route('GET', '/orders'),
  route('GET', '/orders/:id'),
  route('PATCH', '/orders/:id/status'),
  route('POST', '/orders/:id/allocate'),
  route('POST', '/orders/:id/cancel'), // a paid order needs a manager (orders.js cancelOrder)
  route('POST', '/orders/:id/rebalance'),
  route('POST', '/orders/:id/reschedule'),
  route('POST', '/orders/:id/returned-stock'), // boxes back from a cancelled or returned order (INV-F)
  route('GET', '/orders/:id/bill'), // written to the audit (bill-routes.js)
  // Gift orders to many recipients with their deliveries (MULTI_GIFT), read only: as the order list.
  route('GET', '/gift-orders'),
  route('GET', '/gift-orders/:id'),
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
  // The customer profile: every look, search and reveal is written to the audit (admin/customers.js).
  route('POST', '/customers/search'),
  route('GET', '/customers/:id'),
  route('POST', '/customers/:id/reveal'),
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
  // Customer care (docs/care.md): the Help desk and the Subscriptions list. Replies, resolves,
  // pauses and cancels are written to the audit in their own transaction (admin/care.js).
  route('GET', '/help/requests'),
  route('GET', '/help/requests/:id'),
  route('POST', '/help/requests/:id/reply'),
  route('POST', '/help/requests/:id/resolve'),
  route('POST', '/help/requests/:id/reopen'),
  // The WhatsApp inbox (docs/whatsapp/CONVERSATIONS.md): read, reply, take over, assign, hand back,
  // close, record an opt-out, open a customer's photo, resend a failed reply. Set-up is managers'.
  route('GET', '/whatsapp/conversations'),
  route('GET', '/whatsapp/conversations/:id'),
  route('POST', '/whatsapp/conversations/:id/reply'),
  route('POST', '/whatsapp/conversations/:id/take-over'),
  route('POST', '/whatsapp/conversations/:id/hand-back'),
  route('POST', '/whatsapp/conversations/:id/close'),
  route('POST', '/whatsapp/conversations/:id/assign'),
  route('POST', '/whatsapp/conversations/:id/opt-out'),
  route('GET', '/whatsapp/media/:id'),
  route('POST', '/whatsapp/messages/:id/retry'),
  route('GET', '/subscriptions'),
  route('POST', '/subscriptions/:id/pause'),
  route('POST', '/subscriptions/:id/cancel'),
  // Partner Network (docs/partner-network.md): reading, notes, follow-ups, contact records, priority,
  // assignment and the everyday status moves. Approve, reject, close, reopen, convert, export and
  // category changes are managers' (and proposal decisions are refused to operators in partner/staff.js).
  route('GET', '/partner-network/overview'),
  route('GET', '/partner-network/enquiries'),
  route('GET', '/partner-network/enquiries/:id'),
  route('PATCH', '/partner-network/enquiries/:id'),
  route('POST', '/partner-network/enquiries/:id/notes'),
  route('POST', '/partner-network/enquiries/:id/followups'),
  route('PATCH', '/partner-network/enquiries/:id/followups/:followupId'),
  route('POST', '/partner-network/enquiries/:id/contact-attempts'),
  route('POST', '/partner-network/enquiries/:id/request-info'),
  route('GET', '/partner-network/enquiries/:id/documents/:documentId'),
  route('GET', '/partner-network/product-proposals'),
  route('GET', '/partner-network/product-proposals/:id'),
  route('PATCH', '/partner-network/product-proposals/:id'),
  route('POST', '/partner-network/product-proposals/:id/notes'),
  route('POST', '/partner-network/product-proposals/:id/request-sample'),
  route('GET', '/partner-network/categories'),
  // Farm Experience (docs/farm-experience.md): bookings, notes, the stay, rooms, the day at the farm and check-in.
  // Dates, cancelling, refunds, no-shows, prices, the calendar, harvest stock, rooms setup, settings and reports are managers'.
  route('GET', '/farm/overview'),
  route('GET', '/farm/bookings'),
  route('GET', '/farm/bookings/:id'),
  route('PATCH', '/farm/bookings/:id'),
  route('POST', '/farm/bookings/:id/notes'),
  route('POST', '/farm/bookings/:id/hospitality'),
  route('PUT', '/farm/bookings/:id/rooms'),
  route('POST', '/farm/bookings/:id/status'),
  route('POST', '/farm/bookings/:id/harvest'),
  route('POST', '/farm/bookings/:id/extras'),
  route('POST', '/farm/bookings/:id/extras/:extraId/withdraw'),
  route('GET', '/farm/check-in/:code'),
  route('POST', '/farm/check-in'),
  route('GET', '/farm/calendar'),
  route('GET', '/farm/varieties'),
  route('GET', '/farm/rooms'),
  route('GET', '/farm/settings'),
  ...warehouseFor('OPERATOR'),
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
    ...warehouseFor('PACKER'),
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
    // Farms and a batch's purchases without any costs (PURCHASE_RECORDS).
    route('GET', '/farms'),
    route('GET', '/batches/:id/purchases'),
    // Ripeness accuracy from reviews, per batch and variety (read only).
    route('GET', '/reviews/insights'),
    ...warehouseFor('QC'),
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
    // Bills and the customer profile are for managers and operators (docs/trust.md).
    ...('customerId' in order ? { customerId: null, business: null, bill: null } : {}),
    ...('deliveryAttempts' in order ? { deliveryAttempts: order.deliveryAttempts.map((a) => ({ ...a, lat: null, lng: null })) } : {}),
  }
}

// The customer's delivery code is a secret too.
const SECRET_KEYS = /password|token|secret|^code$|setupcode|confirmcode/i
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

const targetOf = (req) => {
  const p = req.params ?? {}
  return p.lineId ? `${p.id}/${p.lineId}` : p.weekStart ? `${p.weekStart}/${p.sku}` : (p.id ?? p.pincode ?? p.date ?? p.code ?? p.sku ?? null)
}

/**
 * SEC-08 (24 Oct 2026 audit, STAFF_AUDIT_TRAIL): the route's audit row written
 * inside its own transaction, so the change and its record commit or fail
 * together; the after-response row is then skipped. A no-op with the flag off,
 * unless `before` is given: the values a change replaced (a role, the shop
 * rules, a promo's limits) exist only inside the transaction, so that row is
 * always written there, as detail.before. `body` replaces the request body in
 * the detail (a big body cut down to what changed).
 */
export async function auditInTx(c, req, extra = {}) {
  const hasBefore = extra.before !== undefined
  if (!env.STAFF_AUDIT_TRAIL && !hasBefore) return
  const detail = clean({ ...(extra.body ?? req.body), ...extra.detail })
  await c.query(
    `INSERT INTO staff_audit (id, admin_id, email, role, action, target, detail, request_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      newId('aud'), req.admin.id ?? null, req.admin.email, req.admin.role, `${req.method} ${req.route.path}`, extra.target ?? targetOf(req),
      hasBefore ? { ...detail, before: extra.before } : detail, req.id ?? null, now(),
    ],
  )
  req.audited = true
}

/** The values in `was` of the fields this change names (`fields`: the body's keys). */
export const beforeOf = (was, fields) => Object.fromEntries(Object.keys(was).filter((k) => fields.includes(k)).map((k) => [k, was[k]]))

/**
 * SEC-08 (STAFF_AUDIT_TRAIL): GETs that show customers' personal details leave a
 * compact "viewed" row (who, which route, on what; never the search words).
 * At most one per person, route and target in READ_AUDIT_MS.
 */
const READ_AUDITED = new Set(READ_AUDITED_ROUTES.map((r) => r.replace(/^GET /, '')))
export const READ_AUDIT_MS = 10 * 60_000
async function auditRead(req) {
  const action = `GET ${req.route.path}`
  const target = targetOf(req) ?? (typeof req.query?.date === 'string' ? req.query.date.slice(0, 10) : null)
  const { hits } = await hit(`read-audit:${req.admin.id}:${action}:${target ?? ''}`, READ_AUDIT_MS)
  if (hits > 1) return
  await audit(req.admin, action, { target, detail: req.route.path === '/orders' ? { search: true } : null, requestId: req.id })
}
const auditsRead = (req) => READ_AUDITED.has(req.route.path) || (req.route.path === '/orders' && typeof req.query?.q === 'string' && req.query.q.trim() !== '')

/** SEC-08 (STAFF_AUDIT_TRAIL): a refused staff request (403) is logged with who and where, not only answered. */
export function watchRefusals(req, res, next) {
  if (env.STAFF_AUDIT_TRAIL) {
    res.on('finish', () => {
      if (res.statusCode !== 403 || !req.admin) return
      logger.warn({ staffId: req.admin.id, role: req.admin.role, method: req.method, path: `${req.baseUrl}${req.path}` }, 'staff request refused')
    })
  }
  next()
}

/**
 * Records every successful staff change (any non-GET request that ended below
 * 400) once the response is sent: who, which route, on what, with what body.
 */
export function auditStaffChanges(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (env.STAFF_AUDIT_TRAIL && req.method === 'GET') {
      res.on('finish', () => {
        if (res.statusCode >= 400 || !req.admin || !req.route || !auditsRead(req)) return
        background(auditRead(req))
      })
    }
    return next()
  }
  res.on('finish', () => {
    // req.audited: the route wrote its own, fuller row inside its transaction (product changes).
    if (res.statusCode >= 400 || !req.admin || !req.route || req.audited) return
    background(audit(req.admin, `${req.method} ${req.route.path}`, { target: targetOf(req), detail: clean(req.body), requestId: req.id }))
  })
  next()
}
