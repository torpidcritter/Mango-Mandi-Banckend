// Staff roles and the audit trail.
//
// MANAGER does everything. OPERATOR does everything except the manager-only
// routes (requireManager in admin.js). PACKER, QC and RIDER see only their own screens:
// anything not listed for them below is refused, so a new route is closed to
// them until someone adds it here.
import { background } from './background.js'
import { now } from './clock.js'
import { query } from './db.js'
import { forbidden } from './errors.js'
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

const LIMITED = {
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
    const target = p.lineId ? `${p.id}/${p.lineId}` : p.weekStart ? `${p.weekStart}/${p.sku}` : (p.id ?? p.pincode ?? p.date ?? p.code ?? null)
    background(audit(req.admin, `${req.method} ${req.route.path}`, { target, detail: clean(req.body), requestId: req.id }))
  })
  next()
}
