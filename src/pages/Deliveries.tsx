import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { RIPENESS_LABEL, date, istDate, telHref } from '../format'
import { MissedDialog, PhotoField, uploadPhoto } from '../MissedDialog'
import { canSee } from '../permissions'
import { currentPosition } from '../photo'
import { useSession } from '../session'
import type { Manifest, ManifestOrder, Rider } from '../types'
import { Badge, Dialog, EmptyState, FormError, OrderBadge, QueryError, Spinner, useToast, usePageTitle } from '../ui'

type Run = Manifest['runs'][number]

const runTitle = (r: Run) => (r.slot ? `${r.slot.label} · ${r.slot.startsAt}–${r.slot.endsAt}` : 'No slot')
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
/** Orders a rider can take out: packed, handed over, or back for a retry. */
const READY = new Set(['PACKED', 'SHIPPED', 'DELIVERY_FAILED'])

/** todo: the rider can act on it now; unpacked: not packed yet; done: delivered (or otherwise finished). */
type Group = 'todo' | 'unpacked' | 'done'
const groupOf = (o: ManifestOrder): Group =>
  READY.has(o.status) || o.status === 'OUT_FOR_DELIVERY' ? 'todo' : !o.packed ? 'unpacked' : 'done'
/** "delivered" when every finished order was delivered, "done" when some were returned or cancelled. */
const doneWord = (orders: ManifestOrder[]) => (orders.every((o) => o.status === 'DELIVERED') ? 'delivered' : 'done')

/** Days ahead the empty state looks for the next day with deliveries. */
const LOOK_AHEAD = 3

/** YYYY-MM-DD plus n days. */
function addDays(day: string, n: number) {
  const t = new Date(`${day}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() + n)
  return t.toISOString().slice(0, 10)
}

const mapsLink = (o: ManifestOrder, pincode: string) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${o.deliveryAddress ?? ''} ${pincode}`.trim())}`

/**
 * The day's delivery run, slot by slot and stop by stop. Riders start a run,
 * then mark each order delivered with the customer's 4-digit code (or a
 * photo of the handover), or say why it couldn't be delivered. Riders see the
 * stops still to deliver first; delivered and not-packed orders fold away.
 */
export default function Deliveries() {
  usePageTitle('Deliveries')
  const [params, setParams] = useSearchParams()
  const { me } = useSession()
  const rider = me?.role === 'RIDER'
  const today = istDate(0)
  const tomorrow = istDate(1)
  const day = params.get('date') || (rider ? today : tomorrow)
  const q = useQuery({ queryKey: ['manifest', day], queryFn: () => api.manifest(day) })
  const [delivering, setDelivering] = useState<ManifestOrder | null>(null)
  const [missing, setMissing] = useState<ManifestOrder | null>(null)
  // Riders get the to-deliver view by default; anyone can switch it.
  const [focusChoice, setFocusChoice] = useState<boolean | null>(null)
  const focus = focusChoice ?? rider
  const refresh = useRefresh(day)
  // Managers and operators give stops to riders; riders see only their own (SEC-02).
  const canAssign = me?.role === 'MANAGER' || me?.role === 'OPERATOR'
  const ridersQ = useQuery({ queryKey: ['riders'], queryFn: api.riders, enabled: canAssign, staleTime: 60_000 })
  const riders = canAssign ? (ridersQ.data ?? []) : []

  function setDay(value: string) {
    const p = new URLSearchParams(params)
    if (value) p.set('date', value)
    else p.delete('date')
    setParams(p, { replace: true })
  }

  const all = q.data?.runs.flatMap((r) => r.stops.flatMap((s) => s.orders)) ?? []
  const todo = all.filter((o) => groupOf(o) === 'todo').length
  const delivered = all.filter((o) => o.status === 'DELIVERED').length
  const unpacked = all.filter((o) => groupOf(o) === 'unpacked').length

  return (
    <>
      <div className="print-only">
        <h1>Deliveries · {date(day)}</h1>
      </div>
      <div className="topbar no-print">
        <h1>Deliveries</h1>
        <div className="field m-0">
          <label htmlFor="dl-date" className="sr-only">
            Delivery date
          </label>
          <input id="dl-date" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </div>
        <div className="segmented" role="group" aria-label="Pick a day">
          <button type="button" className="btn" aria-pressed={day === today} onClick={() => setDay(today)}>
            Today
          </button>
          <button type="button" className="btn" aria-pressed={day === tomorrow} onClick={() => setDay(tomorrow)}>
            Tomorrow
          </button>
        </div>
        <span className="spacer" />
        {!rider && (
          <button type="button" className="btn" onClick={() => window.print()}>
            Print
          </button>
        )}
      </div>

      {rider && (q.data?.unassigned ?? 0) > 0 && <TakeStops day={day} count={q.data!.unassigned!} />}
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.runs.length === 0 ? (
        <>
          <EmptyState>No deliveries on {date(day)}.</EmptyState>
          <NextDay day={day} onPick={setDay} />
        </>
      ) : (
        <>
          <div className="run-summary no-print">
            <span role="status" aria-label="Run summary">
              <strong>{todo}</strong> to deliver · <strong>{delivered}</strong> delivered
              {unpacked > 0 && (
                <>
                  {' '}
                  · <strong>{unpacked}</strong> not packed yet
                </>
              )}
            </span>
            <label className="check-inline small">
              <input type="checkbox" checked={focus} onChange={(e) => setFocusChoice(e.target.checked)} />
              To deliver first
            </label>
          </div>
          <p className="muted">
            {count(q.data.orders, 'order', 'orders')}, {count(q.data.boxes, 'box', 'boxes')}. Every order is
            paid: riders collect nothing.
          </p>
          {q.data.runs.map((r) => (
            <RunSection key={r.slot?.id ?? 'none'} run={r} day={day} focus={focus} riders={riders} onDelivered={setDelivering} onMissed={setMissing} />
          ))}
        </>
      )}
      {delivering && <DeliveredDialog order={delivering} day={day} onClose={() => setDelivering(null)} />}
      {missing && <MissedDialog order={missing} onClose={() => setMissing(null)} onDone={refresh} />}
    </>
  )
}

/** On an empty day, points at the next day (within a few) that has deliveries. */
function NextDay({ day, onPick }: { day: string; onPick: (d: string) => void }) {
  const days = Array.from({ length: LOOK_AHEAD }, (_, i) => addDays(day, i + 1))
  const results = useQueries({
    queries: days.map((d) => ({ queryKey: ['manifest', d], queryFn: () => api.manifest(d), staleTime: 60_000 })),
  })
  if (results.some((r) => r.isPending)) return null
  const i = results.findIndex((r) => (r.data?.runs.length ?? 0) > 0)
  if (i < 0) return <p className="muted small">Nothing in the next {LOOK_AHEAD} days either.</p>
  const next = results[i].data!
  return (
    <p>
      <button type="button" className="btn btn-primary" onClick={() => onPick(days[i])}>
        Go to {date(days[i])} ({count(next.orders, 'order', 'orders')})
      </button>
    </p>
  )
}

/** For a rider: packed stops nobody has yet. Starting the run takes them (and sends them out). */
function TakeStops({ day, count: n }: { day: string; count: number }) {
  const toast = useToast()
  const refresh = useRefresh(day)
  const take = useMutation({
    mutationFn: () => api.takeRun(day),
    onSuccess: (r) => {
      toast.success(`${count(r.dispatched.length, 'order', 'orders')} out for delivery`)
      refresh()
    },
    onError: (err) => toast.error(err),
  })
  return (
    <div className="card no-print" role="status" aria-label="Stops nobody has yet">
      <p className="mt-0">
        {count(n, 'packed stop is', 'packed stops are')} not given to a rider yet. Take {n === 1 ? 'it' : 'them'} to see the address and start
        delivering, or ask the manager to share them out.
      </p>
      <button type="button" className="btn btn-primary" disabled={take.isPending} onClick={() => take.mutate()}>
        Take {n === 1 ? 'it' : 'them'} and start
      </button>
    </div>
  )
}

/** Picks a rider for one stop or a whole slot; "Nobody" takes the stops off anyone. */
function RiderPicker({ label, riders, value, busy, onPick }: { label: string; riders: Rider[]; value: string; busy: boolean; onPick: (riderId: string | null) => void }) {
  return (
    <label className="check-inline small no-print">
      <span className="sr-only">{label}</span>
      <select aria-label={label} value={value} disabled={busy} onChange={(e) => onPick(e.target.value || null)}>
        <option value="">{value ? 'Nobody' : 'Give to a rider…'}</option>
        {riders.map((r) => (
          <option key={r.id} value={r.id}>
            {r.email}
          </option>
        ))}
      </select>
    </label>
  )
}

function useAssign(day: string) {
  const toast = useToast()
  const refresh = useRefresh(day)
  return useMutation({
    mutationFn: (input: { riderId: string | null; orderIds?: string[]; slotId?: string | null }) => api.assignRiders({ date: day, ...input }),
    onSuccess: (r, input) => {
      toast.success(input.riderId ? `${count(r.assigned.length, 'stop', 'stops')} given to the rider` : `${count(r.assigned.length, 'stop', 'stops')} given to nobody`)
      refresh()
    },
    onError: (err) => toast.error(err),
  })
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
  focus,
  riders,
  onDelivered,
  onMissed,
}: {
  run: Run
  day: string
  focus: boolean
  riders: Rider[]
  onDelivered: (o: ManifestOrder) => void
  onMissed: (o: ManifestOrder) => void
}) {
  const toast = useToast()
  const refresh = useRefresh(day)
  const assign = useAssign(day)
  const [open, setOpen] = useState<Record<'done' | 'unpacked', boolean>>({ done: false, unpacked: false })
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

  // In the to-deliver view only actionable orders get full cards; the rest fold into the lists below.
  const stops = focus ? run.stops.map((s) => ({ ...s, orders: s.orders.filter((o) => groupOf(o) === 'todo') })).filter((s) => s.orders.length > 0) : run.stops
  const folded = (g: 'done' | 'unpacked') => run.stops.flatMap((s) => s.orders.filter((o) => groupOf(o) === g).map((o) => ({ o, pincode: s.pincode })))
  const finished = folded('done')
  const notPacked = folded('unpacked')
  const finishedWord = doneWord(finished.map((f) => f.o))

  return (
    <section className="card pack-order" aria-label={runTitle(run)}>
      <div className="topbar section-head">
        <h2>{runTitle(run)}</h2>
        <span className="muted small">
          {count(run.orders, 'order', 'orders')}, {count(run.boxes, 'box', 'boxes')}
          {out + done > 0 && ` · ${done} of ${out + done} delivered`}
        </span>
        <span className="spacer" />
        {riders.length > 0 && (
          <RiderPicker
            label={`Give ${runTitle(run)} to`}
            riders={riders}
            value=""
            busy={assign.isPending}
            onPick={(riderId) => assign.mutate({ riderId, slotId: run.slot?.id ?? null })}
          />
        )}
        {ready > 0 && (
          <button type="button" className="btn btn-primary no-print" disabled={start.isPending} onClick={() => start.mutate()}>
            Start run<span className="sr-only"> {runTitle(run)}</span> ({ready})
          </button>
        )}
      </div>
      {focus && stops.length === 0 && <p className="muted">Nothing left to deliver in this slot.</p>}
      {stops.map((s) => (
        <div key={s.pincode} className="mt-3">
          <h3 className="mb-1">
            {s.pincode}
            {s.city ? ` · ${s.city}` : ''}
            {s.zone ? ` · ${s.zone}` : ''}
          </h3>
          <ul className="stops" aria-label={`${runTitle(run)}, ${s.pincode}`}>
            {s.orders.map((o) => (
              <StopCard
                key={o.id}
                o={o}
                pincode={s.pincode}
                sending={sendOne.isPending}
                onSend={() => sendOne.mutate(o.id)}
                onDelivered={onDelivered}
                onMissed={onMissed}
                picker={
                  riders.length > 0 && o.status !== 'DELIVERED' ? (
                    <RiderPicker label={`Rider for ${o.number}`} riders={riders} value={o.rider?.id ?? ''} busy={assign.isPending} onPick={(riderId) => assign.mutate({ riderId, orderIds: [o.id] })} />
                  ) : null
                }
              />
            ))}
          </ul>
        </div>
      ))}
      {focus && (finished.length > 0 || notPacked.length > 0) && (
        <div className="folded no-print">
          {(
            [
              ['done', finished, finishedWord],
              ['unpacked', notPacked, 'not packed yet'],
            ] as const
          ).map(([g, list, word]) =>
            list.length === 0 ? null : (
              <div key={g}>
                <button
                  type="button"
                  className="btn"
                  aria-expanded={open[g]}
                  onClick={() => setOpen((v) => ({ ...v, [g]: !v[g] }))}
                >
                  {open[g] ? 'Hide' : 'Show'} {word} ({list.length})
                </button>
                {open[g] && (
                  <ul className="stops stops-compact" aria-label={`${runTitle(run)}, ${word}`}>
                    {list.map(({ o, pincode }) => (
                      <li key={o.id} className="stop-line" aria-label={o.number}>
                        <strong>{o.number}</strong>
                        <span className="stop-line-who">
                          {o.customerName ?? '—'} · {pincode}
                        </span>
                        {o.packed ? <OrderBadge status={o.status} /> : <Badge tone="warn">Not packed yet</Badge>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ),
          )}
        </div>
      )}
    </section>
  )
}

function StopCard({
  o,
  pincode,
  sending,
  onSend,
  onDelivered,
  onMissed,
  picker,
}: {
  o: ManifestOrder
  pincode: string
  sending: boolean
  onSend: () => void
  onDelivered: (o: ManifestOrder) => void
  onMissed: (o: ManifestOrder) => void
  picker?: ReactNode
}) {
  const { me } = useSession()
  return (
    <li className="stop" aria-label={o.number}>
      <div className="stop-head">
        <strong>{canSee(me?.role, 'orderDetail') ? <Link to={`/orders/${o.id}`}>{o.number}</Link> : o.number}</strong>
        {o.packed ? <OrderBadge status={o.status} /> : <Badge tone="warn">Not packed yet</Badge>}
        <span className="print-only" aria-hidden="true">
          ☐ Delivered
        </span>
        {!picker && me?.role !== 'RIDER' && o.rider?.email && <span className="small muted">Rider: {o.rider.email}</span>}
        {picker}
      </div>
      <div>
        {o.customerName ?? '—'}
        {o.phone && <> · {o.phone}</>}
      </div>
      {o.gift && (
        <div className="small">
          <Badge>Gift</Badge> from {o.gift.from ?? 'a customer'}
          {o.gift.message && <> · “{o.gift.message}”</>}
        </div>
      )}
      <div>{o.deliveryAddress ?? (me?.role === 'PACKER' ? `Area ${pincode}` : 'No address')}</div>
      <div className="small muted">
        {o.items.map((i) => `${i.quantity} × ${i.productName}${i.stage ? ` (${RIPENESS_LABEL[i.stage]})` : ''}`).join(', ')}
      </div>
      <div className="btn-row no-print mt-2">
        {o.status === 'OUT_FOR_DELIVERY' && (
          <>
            <button type="button" className="btn btn-primary" onClick={() => onDelivered(o)}>
              Delivered<span className="sr-only"> {o.number}</span>
            </button>
            <button type="button" className="btn" onClick={() => onMissed(o)}>
              Couldn't deliver<span className="sr-only"> {o.number}</span>
            </button>
          </>
        )}
        {READY.has(o.status) && (
          <button type="button" className="btn" disabled={sending} onClick={onSend}>
            Send out<span className="sr-only"> {o.number}</span>
          </button>
        )}
        {o.phone && (
          <a className="btn" href={telHref(o.phone)}>
            Call<span className="sr-only"> {o.number}</span>
          </a>
        )}
        {o.deliveryAddress && (
          <a className="btn" href={mapsLink(o, pincode)} target="_blank" rel="noreferrer">
            Map<span className="sr-only"> for {o.number}</span>
          </a>
        )}
      </div>
    </li>
  )
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
      // The attempt number lets the API refuse a report resent after the order went out again.
      const where = { ...((await currentPosition()) ?? {}), ...(order.attempt ? { attempt: order.attempt } : {}) }
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

  /** A wrong code's error doesn't belong on the photo form, and the other way round. */
  function switchMode(next: 'code' | 'photo') {
    setMode(next)
    setProblem(null)
    save.reset()
  }

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
        <p className="mt-0">
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
            <button type="button" className="link-btn" onClick={() => switchMode('photo')}>
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
            <button type="button" className="link-btn" onClick={() => switchMode('code')}>
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
