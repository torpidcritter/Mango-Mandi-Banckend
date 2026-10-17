import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { RIPENESS_LABEL, date, istDate } from '../format'
import { canSee } from '../permissions'
import { currentPosition, shrinkPhoto } from '../photo'
import { useSession } from '../session'
import type { FailReason, Manifest, ManifestOrder } from '../types'
import { Badge, Dialog, EmptyState, FormError, OrderBadge, QueryError, Spinner, useToast } from '../ui'

type Run = Manifest['runs'][number]

const runTitle = (r: Run) => (r.slot ? `${r.slot.label} · ${r.slot.startsAt}–${r.slot.endsAt}` : 'No slot')
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
/** Orders a rider can take out: packed, handed over, or back for a retry. */
const READY = new Set(['PACKED', 'SHIPPED', 'DELIVERY_FAILED'])

const FAIL_OPTIONS: [FailReason, string][] = [
  ['NOT_HOME', 'Customer not home'],
  ['UNREACHABLE', 'Customer did not answer the phone'],
  ['WRONG_ADDRESS', 'Address not found'],
  ['REFUSED', 'Customer refused the order'],
  ['OTHER', 'Something else'],
]

/** Phones come back as +91… from the API; older rows may lack the country code. */
const telLink = (phone: string) => `tel:${phone.startsWith('+') ? phone : `+91${phone}`}`

const mapsLink = (o: ManifestOrder, pincode: string) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${o.deliveryAddress ?? ''} ${pincode}`.trim())}`

/**
 * The day's delivery run, slot by slot and stop by stop. Riders start a run,
 * then mark each order delivered with the customer's 4-digit code (or a
 * photo of the handover), or say why it couldn't be delivered.
 */
export default function Deliveries() {
  const [params, setParams] = useSearchParams()
  const { me } = useSession()
  const day = params.get('date') || istDate(me?.role === 'RIDER' ? 0 : 1)
  const q = useQuery({ queryKey: ['manifest', day], queryFn: () => api.manifest(day) })
  const [delivering, setDelivering] = useState<ManifestOrder | null>(null)
  const [missing, setMissing] = useState<ManifestOrder | null>(null)

  function setDay(value: string) {
    const p = new URLSearchParams(params)
    if (value) p.set('date', value)
    else p.delete('date')
    setParams(p, { replace: true })
  }

  return (
    <>
      <div className="print-only">
        <h1>Deliveries · {date(day)}</h1>
      </div>
      <div className="topbar no-print">
        <h1>Deliveries</h1>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="dl-date" className="sr-only">
            Delivery date
          </label>
          <input id="dl-date" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </div>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => window.print()}>
          Print
        </button>
      </div>

      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.runs.length === 0 ? (
        <EmptyState>No deliveries on {date(day)}.</EmptyState>
      ) : (
        <>
          <p className="muted">
            {count(q.data.orders, 'order', 'orders')}, {count(q.data.boxes, 'box', 'boxes')}. Every order is
            paid: riders collect nothing.
          </p>
          {q.data.runs.map((r) => (
            <RunSection key={r.slot?.id ?? 'none'} run={r} day={day} onDelivered={setDelivering} onMissed={setMissing} />
          ))}
        </>
      )}
      {delivering && <DeliveredDialog order={delivering} day={day} onClose={() => setDelivering(null)} />}
      {missing && <MissedDialog order={missing} day={day} onClose={() => setMissing(null)} />}
    </>
  )
}

function useRefresh(day: string) {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: ['manifest', day] })
    queryClient.invalidateQueries({ queryKey: ['orders'] })
    queryClient.invalidateQueries({ queryKey: ['order'] })
  }
}

function RunSection({
  run,
  day,
  onDelivered,
  onMissed,
}: {
  run: Run
  day: string
  onDelivered: (o: ManifestOrder) => void
  onMissed: (o: ManifestOrder) => void
}) {
  const toast = useToast()
  const refresh = useRefresh(day)
  const { me } = useSession()
  const orders = run.stops.flatMap((s) => s.orders)
  const ready = orders.filter((o) => READY.has(o.status)).length
  const out = orders.filter((o) => o.status === 'OUT_FOR_DELIVERY').length
  const done = orders.filter((o) => o.status === 'DELIVERED').length

  const start = useMutation({
    mutationFn: () => api.dispatchRun(day, run.slot?.id ?? null),
    onSuccess: (r) => {
      toast.success(`${count(r.dispatched.length, 'order', 'orders')} out for delivery`)
      if (r.skipped.length) toast.info(`Not sent: ${r.skipped.map((s) => `${s.number} (${s.reason.toLowerCase()})`).join(', ')}`)
      refresh()
    },
    onError: (err) => toast.error(err),
  })
  const sendOne = useMutation({
    mutationFn: (orderId: string) => api.dispatch(orderId),
    onSuccess: () => {
      toast.success('Out for delivery')
      refresh()
    },
    onError: (err) => toast.error(err),
  })

  return (
    <section className="card pack-order" aria-label={runTitle(run)}>
      <div className="topbar" style={{ marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>{runTitle(run)}</h2>
        <span className="muted small">
          {count(run.orders, 'order', 'orders')}, {count(run.boxes, 'box', 'boxes')}
          {out + done > 0 && ` · ${done} of ${out + done} delivered`}
        </span>
        <span className="spacer" />
        {ready > 0 && (
          <button type="button" className="btn btn-primary no-print" disabled={start.isPending} onClick={() => start.mutate()}>
            Start run<span className="sr-only"> {runTitle(run)}</span> ({ready})
          </button>
        )}
      </div>
      {run.stops.map((s) => (
        <div key={s.pincode} style={{ marginTop: '0.75rem' }}>
          <h3 style={{ margin: '0 0 0.25rem' }}>
            {s.pincode}
            {s.city ? ` · ${s.city}` : ''}
            {s.zone ? ` · ${s.zone}` : ''}
          </h3>
          <ul className="stops" aria-label={`${runTitle(run)}, ${s.pincode}`}>
            {s.orders.map((o) => (
              <li key={o.id} className="stop" aria-label={o.number}>
                <div className="stop-head">
                  <strong>{canSee(me?.role, 'orderDetail') ? <Link to={`/orders/${o.id}`}>{o.number}</Link> : o.number}</strong>
                  {o.packed ? <OrderBadge status={o.status} /> : <Badge tone="warn">Not packed yet</Badge>}
                  <span className="print-only" aria-hidden="true">
                    ☐ Delivered
                  </span>
                </div>
                <div>
                  {o.customerName ?? '—'} ·{' '}
                  <a href={telLink(o.phone)}>{o.phone}</a>
                </div>
                {o.gift && (
                  <div className="small">
                    <Badge tone="info">Gift</Badge> from {o.gift.from ?? 'a customer'}
                    {o.gift.message && <> · “{o.gift.message}”</>}
                  </div>
                )}
                <div>
                  {o.deliveryAddress ?? 'No address'}{' '}
                  {o.deliveryAddress && (
                    <a className="small no-print" href={mapsLink(o, s.pincode)} target="_blank" rel="noreferrer">
                      Map<span className="sr-only"> for {o.number}</span>
                    </a>
                  )}
                </div>
                <div className="small muted">
                  {o.items.map((i) => `${i.quantity} × ${i.productName}${i.stage ? ` (${RIPENESS_LABEL[i.stage]})` : ''}`).join(', ')}
                </div>
                {(READY.has(o.status) || o.status === 'OUT_FOR_DELIVERY') && (
                  <div className="btn-row no-print" style={{ marginTop: '0.5rem' }}>
                    {o.status === 'OUT_FOR_DELIVERY' ? (
                      <>
                        <button type="button" className="btn btn-primary" onClick={() => onDelivered(o)}>
                          Delivered<span className="sr-only"> {o.number}</span>
                        </button>
                        <button type="button" className="btn" onClick={() => onMissed(o)}>
                          Couldn't deliver<span className="sr-only"> {o.number}</span>
                        </button>
                      </>
                    ) : (
                      <button type="button" className="btn btn-small" disabled={sendOne.isPending} onClick={() => sendOne.mutate(o.id)}>
                        Send out<span className="sr-only"> {o.number}</span>
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}

function PhotoField({ onChange, label }: { onChange: (f: File | null) => void; label: string }) {
  return (
    <div className="field">
      <label htmlFor="dl-photo">{label}</label>
      <input id="dl-photo" type="file" accept="image/*" capture="environment" onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
    </div>
  )
}

async function uploadPhoto(orderId: string, file: File | null) {
  if (!file) return undefined
  return (await api.uploadDeliveryPhoto(orderId, await shrinkPhoto(file))).id
}

function DeliveredDialog({ order, day, onClose }: { order: ManifestOrder; day: string; onClose: () => void }) {
  const toast = useToast()
  const refresh = useRefresh(day)
  const [mode, setMode] = useState<'code' | 'photo'>('code')
  const [code, setCode] = useState('')
  const [receivedBy, setReceivedBy] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: async () => {
      const where = (await currentPosition()) ?? {}
      if (mode === 'code') return api.recordDelivery(order.id, { outcome: 'DELIVERED', code, ...where })
      const photoId = await uploadPhoto(order.id, file)
      return api.recordDelivery(order.id, { outcome: 'DELIVERED', photoId, receivedBy: receivedBy.trim(), ...where })
    },
    onSuccess: () => {
      toast.success(`${order.number} delivered`)
      refresh()
      onClose()
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (mode === 'code' && !/^\d{4}$/.test(code)) return setProblem('Enter the 4-digit code the customer gives you.')
    if (mode === 'photo' && !file) return setProblem('Take a photo of the order where you left it.')
    if (mode === 'photo' && receivedBy.trim().length < 2) return setProblem('Say who took it, or where you left it.')
    setProblem(null)
    save.mutate()
  }

  return (
    <Dialog
      title={`Deliver ${order.number}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Back
          </button>
          <button type="submit" form="deliver-form" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Mark delivered'}
          </button>
        </>
      }
    >
      <form id="deliver-form" onSubmit={onSubmit} noValidate>
        <p style={{ marginTop: 0 }}>
          {order.customerName ?? 'Customer'} · {count(order.items.reduce((n, i) => n + i.quantity, 0), 'box', 'boxes')}
        </p>
        {mode === 'code' ? (
          <>
            <div className="field">
              <label htmlFor="dl-code">Customer's delivery code</label>
              <input
                id="dl-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={4}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                data-autofocus
                aria-describedby="dl-code-hint"
              />
              <p id="dl-code-hint" className="small muted">
                The customer has it in the MandiMangoes app and on WhatsApp.
              </p>
            </div>
            <button type="button" className="btn-link" onClick={() => setMode('photo')}>
              No code? Leave it with someone and take a photo
            </button>
          </>
        ) : (
          <>
            <PhotoField label="Photo of the handover" onChange={setFile} />
            <div className="field">
              <label htmlFor="dl-who">Who took it, or where you left it</label>
              <input id="dl-who" value={receivedBy} maxLength={80} onChange={(e) => setReceivedBy(e.target.value)} placeholder="Security at the gate" />
            </div>
            <button type="button" className="btn-link" onClick={() => setMode('code')}>
              Use the customer's code instead
            </button>
          </>
        )}
        {problem && (
          <p role="alert" className="text-danger">
            {problem}
          </p>
        )}
        <FormError error={save.error} />
      </form>
    </Dialog>
  )
}

function MissedDialog({ order, day, onClose }: { order: ManifestOrder; day: string; onClose: () => void }) {
  const toast = useToast()
  const refresh = useRefresh(day)
  const [reason, setReason] = useState<FailReason | null>(null)
  const [note, setNote] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: async () => {
      const where = (await currentPosition()) ?? {}
      const photoId = await uploadPhoto(order.id, file)
      return api.recordDelivery(order.id, { outcome: 'FAILED', reason: reason!, note: note.trim() || undefined, photoId, ...where })
    },
    onSuccess: () => {
      toast.success(`${order.number} will be tried again on the next delivery day`)
      refresh()
      onClose()
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!reason) return setProblem('Pick what happened.')
    if (reason === 'OTHER' && note.trim().length < 3) return setProblem('Say what happened.')
    setProblem(null)
    save.mutate()
  }

  return (
    <Dialog
      title={`Couldn't deliver ${order.number}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Back
          </button>
          <button type="submit" form="missed-form" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="missed-form" onSubmit={onSubmit} noValidate>
        <p style={{ marginTop: 0 }}>The order comes back and goes out again on the next delivery day. Nothing is refunded.</p>
        <fieldset>
          <legend>What happened?</legend>
          <div className="radio-row" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
            {FAIL_OPTIONS.map(([value, label]) => (
              <label key={value}>
                <input type="radio" name="reason" checked={reason === value} onChange={() => setReason(value)} />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="field">
          <label htmlFor="dl-note">Note (optional)</label>
          <input id="dl-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
        </div>
        <PhotoField label="Photo (optional)" onChange={setFile} />
        {problem && (
          <p role="alert" className="text-danger">
            {problem}
          </p>
        )}
        <FormError error={save.error} />
      </form>
    </Dialog>
  )
}
