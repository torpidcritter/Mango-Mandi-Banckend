import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { RIPENESS_LABEL, date, istDate, rupees, type Tone } from '../format'
import { MANAGER_ONLY_HINT, can } from '../permissions'
import { useSession } from '../session'
import type { PreorderStatus } from '../types'
import { Badge, Dialog, EmptyState, FormError, GatedButton, QueryError, Spinner, scrollRegion, useToast } from '../ui'

const STATUS_LABEL: Record<PreorderStatus, string> = {
  PAYMENT_PENDING: 'Awaiting payment',
  BOOKED: 'Paid',
  WAITLISTED: 'Waitlist',
  CONVERTED: 'Order created',
  CANCELLED: 'Cancelled',
}
const STATUS_TONE: Record<PreorderStatus, Tone> = {
  PAYMENT_PENDING: 'warn',
  BOOKED: 'info',
  WAITLISTED: 'neutral',
  CONVERTED: 'good',
  CANCELLED: 'neutral',
}
const FILTERS: (PreorderStatus | null)[] = [null, 'BOOKED', 'WAITLISTED', 'PAYMENT_PENDING', 'CONVERTED', 'CANCELLED']
const weekLabel = (d: string) => `Week of ${date(d)}`

export default function Preorders() {
  return (
    <>
      <div className="topbar">
        <h1>Preorders</h1>
      </div>
      <Capacity />
      <PreorderList />
    </>
  )
}

/** Boxes customers can preorder per week and product. Bookings beyond it join the waitlist. */
function Capacity() {
  const { me } = useSession()
  const q = useQuery({ queryKey: ['preorder-capacity'], queryFn: api.preorderCapacity })
  const [open, setOpen] = useState(false)
  const allowed = can(me?.role, 'editRules')

  return (
    <section className="card">
      <div className="topbar" style={{ marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>Weekly capacity</h2>
        <span className="spacer" />
        <GatedButton allowed={allowed} className="btn" onClick={() => setOpen(true)}>
          Set capacity
        </GatedButton>
      </div>
      <p className="muted">
        Customers book a delivery week, not a date. Set capacity below the expected supply to leave room for regular
        orders and losses. A week before delivery, paid preorders become orders on a date with stock.
      </p>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState>No preorder weeks set up yet.</EmptyState>
      ) : (
        <div {...scrollRegion('Weekly capacity')}>
          <table>
            <thead>
              <tr>
                <th>Week</th>
                <th>Product</th>
                <th className="num">Capacity</th>
                <th className="num">Booked</th>
                <th className="num">Left</th>
                <th className="num">Waitlist</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((k) => (
                <tr key={`${k.weekStart}-${k.sku}`}>
                  <td>{weekLabel(k.weekStart)}</td>
                  <td>
                    {k.productName} <span className="muted small">{k.sku}</span>
                  </td>
                  <td className="num">{k.capacity}</td>
                  <td className="num">{k.reserved}</td>
                  <td className={`num${k.capacity - k.reserved <= 0 ? ' text-warn' : ''}`}>{Math.max(k.capacity - k.reserved, 0)}</td>
                  <td className="num">{k.waitlisted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!allowed && <p className="hint">Changing capacity: {MANAGER_ONLY_HINT.toLowerCase()}.</p>}
      {open && <CapacityDialog onClose={() => setOpen(false)} />}
    </section>
  )
}

function nextMonday(): string {
  const d = new Date(`${istDate(7)}T00:00:00Z`)
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

function CapacityDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const products = useQuery({ queryKey: ['products'], queryFn: api.products })
  const [week, setWeek] = useState(nextMonday())
  const [sku, setSku] = useState('')
  const [capacity, setCapacity] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const chosen = sku || products.data?.[0]?.sku || ''

  const save = useMutation({
    mutationFn: () => api.setPreorderCapacity(week, chosen, Number(capacity)),
    onSuccess: () => {
      toast.success(`Capacity saved for the week of ${date(week)}`)
      queryClient.invalidateQueries({ queryKey: ['preorder-capacity'] })
      queryClient.invalidateQueries({ queryKey: ['preorders'] })
      onClose()
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || new Date(`${week}T00:00:00Z`).getUTCDay() !== 1) {
      return setFormError('Pick the Monday the week starts on.')
    }
    if (!chosen) return setFormError('Pick a product.')
    if (!/^\d+$/.test(capacity)) return setFormError('Capacity must be a whole number of boxes.')
    save.mutate()
  }

  return (
    <Dialog
      title="Set preorder capacity"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="capacity-form" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="capacity-form" onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor="cap-week">Week starting (Monday)</label>
          <input id="cap-week" type="date" value={week} onChange={(e) => setWeek(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="cap-sku">Product</label>
          <select id="cap-sku" value={chosen} onChange={(e) => setSku(e.target.value)}>
            {(products.data ?? []).map((p) => (
              <option key={p.sku} value={p.sku}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cap-boxes">Boxes</label>
          <input id="cap-boxes" inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value.trim())} />
          <p className="hint">Lowering it never cancels bookings. Raising it offers the new boxes to the waitlist first.</p>
        </div>
        <FormError error={formError ?? save.error} />
      </form>
    </Dialog>
  )
}

function PreorderList() {
  const [params, setParams] = useSearchParams()
  const status = (params.get('status') as PreorderStatus | null) || null
  const q = useQuery({ queryKey: ['preorders', status], queryFn: () => api.preorders(status) })

  function setStatus(s: PreorderStatus | null) {
    const p = new URLSearchParams(params)
    if (s) p.set('status', s)
    else p.delete('status')
    setParams(p, { replace: true })
  }

  return (
    <section className="card">
      <h2>Bookings</h2>
      <div className="segmented" role="group" aria-label="Filter by status" style={{ marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        {FILTERS.map((s) => (
          <button key={s ?? 'all'} type="button" className="btn btn-small" aria-pressed={status === s} onClick={() => setStatus(s)}>
            {s ? STATUS_LABEL[s] : 'All'}
          </button>
        ))}
      </div>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState>No preorders here.</EmptyState>
      ) : (
        <div {...scrollRegion('Preorders')}>
          <table>
            <thead>
              <tr>
                <th>Preorder</th>
                <th>Customer</th>
                <th>Boxes</th>
                <th>Week</th>
                <th className="num">Total</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.number}</strong>
                    {p.channel === 'whatsapp' && <div className="muted small">via WhatsApp</div>}
                  </td>
                  <td>
                    {p.customerName ?? '—'}
                    <div className="muted small">{p.phone}</div>
                  </td>
                  <td>
                    {p.qty} × {p.productName}
                    <div className="muted small">{RIPENESS_LABEL[p.stage]}</div>
                  </td>
                  <td>
                    {weekLabel(p.weekStart)}
                    {p.movedCount > 0 && (
                      <div className="small text-warn">
                        Moved {p.movedCount === 1 ? 'once' : `${p.movedCount} times`}: no stock
                      </div>
                    )}
                  </td>
                  <td className="num">{rupees(p.total)}</td>
                  <td>
                    <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                    {p.order && (
                      <div className="small">
                        <Link to={`/orders/${p.order.id}`}>{p.order.number}</Link> on {date(p.order.deliveryDate)}
                      </div>
                    )}
                    {p.refund && (
                      <div className="small muted">{p.refund.refundedAt ? 'Refunded' : 'Refund pending'}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
