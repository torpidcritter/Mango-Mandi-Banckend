// Staff roles and the audit trail.
//
// MANAGER does everything. OPERATOR does everything except the manager-only
// routes (requireManager in admin.js). PACKER, QC and RIDER see only their own screens:
// anything not listed for them below is refused, so a new route is closed to
// them until someone adds it here.
import { background } from './background.js'
import { addDays, now, todayIST } from './clock.js'
import { query } from './db.js'
import { forbidden, notFound } from './errors.js'
import { newId } from './ids.js'
import { logger } from './logger.js'

export const ROLES = ['MANAGER', 'OPERATOR', 'PACKER', 'QC', 'RIDER']

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

// Box labels (labels.js): checking a run's van load and sending it out.
const VAN_SCAN = [
  route('GET', '/scan/dispatch'),
  route('POST', '/scan/dispatch'),
  route('POST', '/scan/dispatch/send'),
]

const LIMITED = {
  // Riders only see the day's run and record deliveries, with proof.
  RIDER: [...COMMON, ...DELIVERY, ...VAN_SCAN, route('POST', '/orders/:id/door-scan')],
  PACKER: [
    ...DELIVERY,
    ...COMMON,
    route('GET', '/pack-list'),
    route('GET', '/orders/:id'),
    route('GET', '/slots'),
    route('POST', '/orders/:id/allocate'),
    route('PATCH', '/orders/:id/status'),
    ...VAN_SCAN,
    route('POST', '/labels/print'),
    route('GET', '/orders/:id/labels'),
    route('POST', '/labels/:id/reprint'),
    route('POST', '/scan/pack'),
    route('GET', '/scan/lookup'),
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
    // Box labels, read only.
    route('GET', '/orders/:id/labels'),
    route('GET', '/scan/dispatch'),
    route('GET', '/scan/lookup'),
  ],
}

/** Refuses PACKER, QC and RIDER staff anything outside their own screens. */
export function limitByRole(req, _res, next) {
  const allowed = LIMITED[req.admin?.role]
  if (!allowed) return next()
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
    if ((req.path.startsWith('/manifest') || req.path.startsWith('/scan/dispatch')) && date !== undefined && !dates.includes(String(date))) {
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

// The customer's delivery code is a secret too, and so is a scanned label (it holds the QR token).
const SECRET_KEYS = /password|token|secret|^code$|^scan$/i

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
