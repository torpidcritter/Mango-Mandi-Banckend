import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { BATCH_STATUS_LABEL, ORDER_STATUS_LABEL, dateTime, rupees } from '../format'
import { ALL_ROLES, ROLE_LABEL } from '../permissions'
import { useSession } from '../session'
import type { AuditEntry, BatchStatus, OrderStatus, Role, StaffMember } from '../types'
import { ConfirmDialog, Dialog, EmptyState, FormError, QueryError, ReasonDialog, Spinner, useToast, scrollRegion, usePageTitle } from '../ui'

const ROLE_HINT: Record<Role, string> = {
  MANAGER: 'Everything, including staff, rules and condemning batches',
  OPERATOR: 'Everything except the manager-only actions',
  PACKER: 'Pack list, deliveries and order steps through delivery',
  QC: 'Receiving batches, QC and stock counts',
  RIDER: "The day's deliveries, marked with the customer's code or a photo",
}

/** Managers add staff, set roles and see who did what. */
export default function Staff() {
  usePageTitle('Staff')
  const { me } = useSession()
  const toast = useToast()
  const queryClient = useQueryClient()
  const q = useQuery({ queryKey: ['staff'], queryFn: api.staff })
  const [adding, setAdding] = useState(false)
  const [resetting, setResetting] = useState<StaffMember | null>(null)
  const [removing, setRemoving] = useState<StaffMember | null>(null)
  const [unlocking, setUnlocking] = useState<StaffMember | null>(null)
  // A role picked in the table, waiting for the manager to confirm it (the select shows it meanwhile).
  const [changing, setChanging] = useState<{ staff: StaffMember; role: Role } | null>(null)
  // A two-step setup code, shown once to hand over in person.
  const [shownCode, setShownCode] = useState<{ email: string; code: string } | null>(null)

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['staff'] })
    void queryClient.invalidateQueries({ queryKey: ['audit'] })
  }

  const setRole = useMutation({
    mutationFn: (p: { id: string; role: Role }) => api.updateStaff(p.id, { role: p.role }),
    onSuccess: (s) => {
      toast.success(`${s.email} is now ${ROLE_LABEL[s.role]}. They will need to sign in again.`)
      setChanging(null)
      refresh()
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.removeStaff(id),
    onSuccess: () => {
      toast.success(`${removing?.email} removed`)
      setRemoving(null)
      refresh()
    },
  })

  // Everyone's sessions end at once (optionally not this one): a leaked password or a lost device.
  const [signingOut, setSigningOut] = useState(false)
  const [keepMe, setKeepMe] = useState(true)
  const signOutAll = useMutation({
    mutationFn: (b: { reason: string; keepMe: boolean }) => api.signOutAllStaff(b.reason, b.keepMe),
    onSuccess: (r) => {
      setSigningOut(false)
      refresh()
      // Signed out too: this session is gone, so go back to sign-in.
      if (!r.keptMe) return void api.logout()
      toast.success(`${r.signedOut} ${r.signedOut === 1 ? 'person' : 'people'} signed out. They sign in again to carry on.`)
    },
  })

  const resetTwoStep = useMutation({
    mutationFn: (id: string) => api.resetTwoStep(id),
    onSuccess: (r) => {
      if (unlocking) setShownCode({ email: unlocking.email, code: r.setupCode })
      setUnlocking(null)
      refresh()
    },
  })
  const newSetupCode = useMutation({
    mutationFn: (s: StaffMember) => api.newSetupCode(s.id).then((r) => ({ email: s.email, code: r.setupCode })),
    onSuccess: (c) => setShownCode(c),
    onError: (err) => toast.error(err),
  })

  return (
    <>
      <div className="topbar">
        <h1>Staff</h1>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => setSigningOut(true)}>
          Sign out all staff
        </button>
        <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
          Add person
        </button>
      </div>

      <section className="card">
        <h2>People</h2>
        {q.isPending ? (
          <Spinner />
        ) : q.isError ? (
          <QueryError error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <div {...scrollRegion('People')}>
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Two-step</th>
                  <th>Added</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {q.data.map((s) => {
                  const self = s.email === me?.email
                  return (
                    <tr key={s.id}>
                      <td>
                        {s.email}
                        {self && <span className="muted small"> (you)</span>}
                      </td>
                      <td>
                        <label htmlFor={`role-${s.id}`} className="sr-only">
                          Role for {s.email}
                        </label>
                        <select
                          id={`role-${s.id}`}
                          value={changing?.staff.id === s.id ? changing.role : s.role}
                          disabled={self || setRole.isPending}
                          onChange={(e) => {
                            const role = e.target.value as Role
                            setRole.reset()
                            setChanging(role === s.role ? null : { staff: s, role })
                          }}
                        >
                          {ALL_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>{s.twoStep ? 'On' : 'Off'}</td>
                      <td>{dateTime(s.createdAt)}</td>
                      <td>
                        <div className="btn-row">
                          {s.twoStep && !self && (
                            <button type="button" className="btn btn-small" onClick={() => setUnlocking(s)}>
                              Reset two-step<span className="sr-only"> for {s.email}</span>
                            </button>
                          )}
                          {!s.twoStep && !self && (
                            <button type="button" className="btn btn-small" disabled={newSetupCode.isPending} onClick={() => newSetupCode.mutate(s)}>
                              Setup code<span className="sr-only"> for {s.email}</span>
                            </button>
                          )}
                          <button type="button" className="btn btn-small" onClick={() => setResetting(s)}>
                            Set password<span className="sr-only"> for {s.email}</span>
                          </button>
                          {!self && (
                            <button type="button" className="btn btn-small btn-danger" onClick={() => setRemoving(s)}>
                              Remove<span className="sr-only"> {s.email}</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <ul className="muted small role-hints">
          {ALL_ROLES.map((r) => (
            <li key={r}>
              <strong>{ROLE_LABEL[r]}:</strong> {ROLE_HINT[r]}
            </li>
          ))}
        </ul>
      </section>

      <Activity />

      {changing && (
        <ConfirmDialog
          title={`Make ${changing.staff.email} ${/^[AEIOU]/.test(ROLE_LABEL[changing.role]) ? 'an' : 'a'} ${ROLE_LABEL[changing.role]}?`}
          confirmLabel={`Make ${ROLE_LABEL[changing.role]}`}
          busy={setRole.isPending}
          error={setRole.error}
          onClose={() => setChanging(null)}
          onConfirm={() => setRole.mutate({ id: changing.staff.id, role: changing.role })}
        >
          <p>
            They go from {ROLE_LABEL[changing.staff.role]} to {ROLE_LABEL[changing.role]}: {ROLE_HINT[changing.role].charAt(0).toLowerCase() + ROLE_HINT[changing.role].slice(1)}.
            They'll be signed out and need to sign in again.
          </p>
        </ConfirmDialog>
      )}

      {adding && (
        <AddDialog
          onClose={() => setAdding(false)}
          onDone={(s) => {
            refresh()
            if (s.setupCode) setShownCode({ email: s.email, code: s.setupCode })
          }}
        />
      )}
      {shownCode && (
        <Dialog
          title={`Setup code for ${shownCode.email}`}
          onClose={() => setShownCode(null)}
          footer={
            <button type="button" className="btn btn-primary" onClick={() => setShownCode(null)}>
              Done
            </button>
          }
        >
          <p>They enter this when they set up two-step sign-in. Give it to them in person. It works once, for 7 days, and is not shown again.</p>
          <p>
            Setup code: <strong className="secret-key">{shownCode.code}</strong>
          </p>
        </Dialog>
      )}
      {resetting && <PasswordDialog member={resetting} onClose={() => setResetting(null)} />}
      {unlocking && (
        <ConfirmDialog
          title={`Reset two-step sign-in for ${unlocking.email}?`}
          confirmLabel="Reset"
          busy={resetTwoStep.isPending}
          error={resetTwoStep.error}
          onClose={() => setUnlocking(null)}
          onConfirm={() => resetTwoStep.mutate(unlocking.id)}
        >
          <p>
            Use this when they have lost their phone. They are signed out, and set up two-step sign-in again with their new phone, using the setup code
            shown next.
          </p>
        </ConfirmDialog>
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.email}?`}
          tone="danger"
          confirmLabel="Remove"
          busy={remove.isPending}
          error={remove.error}
          onClose={() => setRemoving(null)}
          onConfirm={() => remove.mutate(removing.id)}
        >
          <p>They are signed out and can no longer sign in. What they did stays in the activity log.</p>
        </ConfirmDialog>
      )}
      {signingOut && (
        <ReasonDialog
          title="Sign out all staff?"
          label="Why"
          confirmLabel="Sign everyone out"
          hint="For a leaked password or a lost device. Everyone signs in again; their passwords and two-step stay as they are."
          maxLength={500}
          busy={signOutAll.isPending}
          error={signOutAll.error}
          onClose={() => setSigningOut(false)}
          onSubmit={(reason) => signOutAll.mutate({ reason, keepMe })}
        >
          <div className="field radio-row">
            <label>
              <input type="checkbox" checked={keepMe} onChange={(e) => setKeepMe(e.target.checked)} /> Keep me signed in on this device
            </label>
          </div>
        </ReasonDialog>
      )}
    </>
  )
}

function AddDialog({ onClose, onDone }: { onClose: () => void; onDone: (s: StaffMember) => void }) {
  const toast = useToast()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('PACKER')
  const [password, setPassword] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const add = useMutation({
    mutationFn: () => api.addStaff({ email: email.trim(), role, password }),
    onSuccess: (s) => {
      toast.success(`${s.email} added as ${ROLE_LABEL[s.role]}`)
      onClose()
      onDone(s)
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setFormError('Enter a work email.')
    if (password.length < 12) return setFormError('Use a password of at least 12 characters.')
    add.mutate()
  }

  return (
    <Dialog
      title="Add person"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="staff-form" className="btn btn-primary" disabled={add.isPending}>
            {add.isPending ? 'Saving…' : 'Add'}
          </button>
        </>
      }
    >
      <form id="staff-form" onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor="staff-email">Work email</label>
          <input id="staff-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="staff-role">Role</label>
          <select id="staff-role" value={role} onChange={(e) => setRole(e.target.value as Role)} aria-describedby="staff-role-hint">
            {ALL_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
          <p className="hint" id="staff-role-hint">
            {ROLE_HINT[role]}.
          </p>
        </div>
        <div className="field">
          <label htmlFor="staff-password">First password</label>
          <input id="staff-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="hint">At least 12 characters, not a common one. Give it to them in person.</p>
        </div>
        <FormError error={formError ?? add.error} />
      </form>
    </Dialog>
  )
}

function PasswordDialog({ member, onClose }: { member: StaffMember; onClose: () => void }) {
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: () => api.updateStaff(member.id, { password }),
    onSuccess: () => {
      toast.success(`Password changed for ${member.email}`)
      onClose()
    },
  })
  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (password.length < 12) return setFormError('Use a password of at least 12 characters.')
    save.mutate()
  }
  return (
    <Dialog
      title={`Set password for ${member.email}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="pw-form" className="btn btn-primary" disabled={save.isPending}>
            Save
          </button>
        </>
      }
    >
      <form id="pw-form" onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor="pw-new">New password</label>
          <input id="pw-new" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="hint">They are signed out everywhere and sign in again with this.</p>
        </div>
        <FormError error={formError ?? save.error} />
      </form>
    </Dialog>
  )
}

// ---------------------------------------------------------------- activity

const ACTION_LABEL: Record<string, string | ((d: Record<string, unknown>) => string)> = {
  'auth.login': 'Signed in',
  'auth.two_step_failed': 'Entered a wrong two-step code',
  'auth.setup_code_failed': 'Entered a wrong two-step setup code',
  'POST /batches': 'Received a batch',
  'PATCH /batches/:id/status': (d) => `Moved batch to ${BATCH_STATUS_LABEL[d.status as BatchStatus] ?? d.status}`,
  'POST /batches/:id/qc': 'Logged QC',
  'PATCH /batches/:id/lines/:lineId': 'Changed a stock count',
  'PATCH /orders/:id/status': (d) => `Set order to ${ORDER_STATUS_LABEL[d.status as OrderStatus] ?? d.status}`,
  'POST /orders/:id/allocate': 'Allocated stock',
  'POST /orders/:id/cancel': 'Cancelled an order',
  'POST /orders/:id/rebalance': 'Rechecked an order’s stock',
  'POST /orders/:id/reschedule': 'Moved an order’s date',
  'POST /orders/bulk-reschedule': 'Moved a whole day',
  'POST /manifest/dispatch': 'Started a delivery run',
  'POST /orders/:id/dispatch': 'Sent an order out for delivery',
  'POST /orders/:id/delivery-photos': 'Took a delivery photo',
  'POST /orders/:id/delivery': (d) => (d.outcome === 'FAILED' ? 'Recorded a missed delivery' : 'Recorded a delivery'),
  'POST /notifications/:id/retry': 'Sent a WhatsApp message again',
  'POST /claims/:id/review': 'Started reviewing a claim',
  'POST /claims/:id/resolve': 'Resolved a claim',
  'POST /pincodes': 'Added a pincode',
  'PATCH /pincodes/:pincode': 'Changed a pincode',
  'DELETE /pincodes/:pincode': 'Deleted a pincode',
  'PUT /config': 'Changed the rules',
  'PUT /calendar/:date': 'Changed a delivery day',
  'DELETE /calendar/:date': 'Reset a delivery day',
  'POST /slots': 'Added a delivery slot',
  'PATCH /slots/:id': 'Changed a delivery slot',
  'PUT /preorder-capacity/:weekStart/:sku': 'Set preorder capacity',
  // ADM-2: the row holds the values before the change (`before`) and an optional reason.
  'PATCH /products/:sku': (d) => {
    const was = (d.before ?? {}) as Record<string, unknown>
    if (typeof was.price === 'number' && typeof d.price === 'number') return `Changed a price from ${rupees(was.price)} to ${rupees(d.price)}`
    if (d.active === true) return 'Put a product back on sale'
    return 'Changed a product'
  },
  'POST /products': 'Added a product',
  'DELETE /products/:sku': 'Removed a product',
  'POST /staff': 'Added a person',
  'PATCH /staff/:id': 'Changed a person',
  'DELETE /staff/:id': 'Removed a person',
  'POST /staff/:id/two-step/reset': 'Reset two-step sign-in',
  'POST /staff/:id/two-step/setup-code': 'Gave out a two-step setup code',
  'POST /me/two-step/enable': 'Turned on two-step sign-in',
  'POST /me/two-step/disable': 'Turned off two-step sign-in',
}

function describe(a: AuditEntry) {
  const l = ACTION_LABEL[a.action]
  if (typeof l === 'function') return l(a.detail ?? {})
  return l ?? a.action
}

function details(a: AuditEntry) {
  if (!a.detail) return ''
  return Object.entries(a.detail)
    .filter(([k, v]) => v !== '[removed]' && !(k === 'status' && a.action.endsWith('/status')) && k !== 'before')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(', ')
}

function Target({ a }: { a: AuditEntry }) {
  if (!a.target) return <>—</>
  if (a.action.includes('/orders/:id')) return <Link to={`/orders/${a.target}`}>Open order</Link>
  if (a.action.includes('/batches/:id')) return <Link to={`/batches/${a.target.split('/')[0]}`}>Open batch</Link>
  return <span className="small">{a.target}</span>
}

function Activity() {
  const [params, setParams] = useSearchParams()
  const staff = params.get('staff') || null
  const from = params.get('from') || null
  const to = params.get('to') || null
  const page = Number(params.get('page') || 1)
  const q = useQuery({
    queryKey: ['audit', staff, from, to, page],
    queryFn: () => api.audit({ staff, from, to, page }),
    placeholderData: keepPreviousData,
  })

  function set(key: string, value: string | null) {
    const p = new URLSearchParams(params)
    if (value) p.set(key, value)
    else p.delete(key)
    if (key !== 'page') p.delete('page')
    setParams(p, { replace: true })
  }

  const totalPages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.pageSize)) : 1

  return (
    <section className="card">
      <h2>Activity</h2>
      <p className="muted small">Every change made in the panel, newest first, and each sign-in.</p>
      <div className="btn-row mb-3">
        <div className="field m-0">
          <label htmlFor="act-staff" className="sr-only">
            Person
          </label>
          <select id="act-staff" value={staff ?? ''} onChange={(e) => set('staff', e.target.value)}>
            <option value="">Everyone</option>
            {q.data?.staff.map((s) => (
              <option key={s.email} value={s.email}>
                {s.email}
              </option>
            ))}
          </select>
        </div>
        <div className="field m-0">
          <label htmlFor="act-from" className="sr-only">
            From
          </label>
          <input id="act-from" type="date" value={from ?? ''} onChange={(e) => set('from', e.target.value)} />
        </div>
        <div className="field m-0">
          <label htmlFor="act-to" className="sr-only">
            To
          </label>
          <input id="act-to" type="date" value={to ?? ''} onChange={(e) => set('to', e.target.value)} />
        </div>
      </div>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <EmptyState>Nothing recorded for these filters.</EmptyState>
      ) : (
        <>
          <div {...scrollRegion('Activity')}>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                  <th>Details</th>
                  <th>On</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((a) => (
                  <tr key={a.id}>
                    <td>{dateTime(a.at)}</td>
                    <td>
                      {a.email}
                      <br />
                      <span className="muted small">{ROLE_LABEL[a.role] ?? a.role}</span>
                    </td>
                    <td>{describe(a)}</td>
                    <td className="small">{details(a) || '—'}</td>
                    <td>
                      <Target a={a} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <span className="muted small">
              {q.data.total} changes · page {q.data.page} of {totalPages}
            </span>
            <button type="button" className="btn btn-small" disabled={page <= 1} onClick={() => set('page', String(page - 1))}>
              Previous
            </button>
            <button type="button" className="btn btn-small" disabled={page >= totalPages} onClick={() => set('page', String(page + 1))}>
              Next
            </button>
          </div>
        </>
      )}
    </section>
  )
}
