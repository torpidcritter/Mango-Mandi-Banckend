import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { RIPENESS_LABEL, date, istDate } from '../format'
import { can } from '../permissions'
import { useSession } from '../session'
import type { BulkMoveResult, CalendarDay, DeliverySlot, Ripeness, Rules, StageWindow } from '../types'
import { Badge, ConfirmDialog, Dialog, EmptyState, FormError, GatedButton, ManagerOnlyNote, QueryError, Spinner, scrollRegion, useToast, usePageTitle } from '../ui'

const STAGES: Ripeness[] = ['RAW', 'SEMI_RIPE', 'RIPE']

export default function Planning() {
  usePageTitle('Planning')
  return (
    <>
      <div className="topbar">
        <h1>Planning</h1>
      </div>
      <Coverage />
      <Calendar />
      <Slots />
      <RulesCard />
    </>
  )
}

/** Sellable boxes per SKU and ripeness for every date customers can book. Zeros are supply gaps. */
function Coverage() {
  const q = useQuery({ queryKey: ['coverage'], queryFn: api.coverage, refetchInterval: 60_000 })
  const products = useQuery({ queryKey: ['products'], queryFn: api.products })
  const name = (sku: string) => products.data?.find((p) => p.sku === sku)?.name ?? sku

  return (
    <section className="card">
      <h2>Stock by delivery date</h2>
      <p className="muted">
        Boxes customers can still book for each date, by ripeness on that date. A dash means none: receive a batch
        that will be at that stage then.
      </p>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState>No delivery dates are open.</EmptyState>
      ) : (
        q.data.map((day) => {
          const skus = [...new Set(day.stock.map((s) => s.sku))]
          const qty = (sku: string, stage: Ripeness) => day.stock.find((s) => s.sku === sku && s.stage === stage)?.qty ?? 0
          return (
            <div key={day.date} className="mt-4">
              <h3>{date(day.date)}</h3>
              {day.slots && day.slots.length > 0 && (
                <p className="muted small mt-0">
                  Booked:{' '}
                  {day.slots
                    .map((sl) => `${sl.label} ${sl.booked}${sl.maxBoxes == null ? '' : ` of ${sl.maxBoxes}`} boxes`)
                    .join(' · ')}
                </p>
              )}
              <div {...scrollRegion(`Stock for ${date(day.date)}`)}>
                <table>
                  <thead>
                    <tr>
                      <th>Product</th>
                      {STAGES.map((s) => (
                        <th key={s} className="num">
                          {RIPENESS_LABEL[s]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {skus.map((sku) => (
                      <tr key={sku}>
                        <td>
                          {name(sku)} <span className="muted small">{sku}</span>
                        </td>
                        {STAGES.map((s) => {
                          const n = qty(sku, s)
                          return (
                            <td key={s} className={`num${n === 0 ? ' text-warn' : ''}`}>
                              {n === 0 ? (
                                <>
                                  <span aria-hidden="true">—</span>
                                  <span className="sr-only">none</span>
                                </>
                              ) : (
                                n
                              )}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        })
      )}
    </section>
  )
}

/** Closed days (festivals, bandhs) and per-day box limits. */
function Calendar() {
  const { me } = useSession()
  const toast = useToast()
  const queryClient = useQueryClient()
  const q = useQuery({ queryKey: ['calendar'], queryFn: api.calendar })
  const [editing, setEditing] = useState<CalendarDay | null>(null)
  const [moving, setMoving] = useState(false)
  const [resetting, setResetting] = useState<CalendarDay | null>(null)
  const canMove = can(me?.role, 'moveDay')

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['calendar'] })
    queryClient.invalidateQueries({ queryKey: ['coverage'] })
  }
  const clear = useMutation({
    mutationFn: (d: string) => api.clearCalendarDay(d),
    onSuccess: (_r, d) => {
      toast.success(`${date(d)} is back to normal`)
      setResetting(null)
      refresh()
    },
  })

  return (
    <section className="card">
      <div className="topbar section-head">
        <h2>Delivery calendar</h2>
        <span className="spacer" />
        <GatedButton allowed={canMove} className="btn" onClick={() => setMoving(true)}>
          Move a day's orders
        </GatedButton>
        <button
          type="button"
          className="btn"
          onClick={() => setEditing({ date: istDate(1), isOpen: true, maxBoxes: null, note: null })}
        >
          Change a day
        </button>
      </div>
      <p className="muted">Every day is open with no box limit unless it is listed here.</p>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState>No closed days or limits coming up.</EmptyState>
      ) : (
        <div {...scrollRegion('Delivery calendar')}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Deliveries</th>
                <th className="num">Box limit</th>
                <th>Note</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((d) => (
                <tr key={d.date}>
                  <td>{date(d.date)}</td>
                  <td>
                    <Badge tone={d.isOpen ? 'good' : 'bad'}>{d.isOpen ? 'Open' : 'Closed'}</Badge>
                  </td>
                  <td className="num">{d.maxBoxes ?? '—'}</td>
                  <td>{d.note ?? '—'}</td>
                  <td>
                    <div className="btn-row">
                      <button type="button" className="btn btn-small" onClick={() => setEditing(d)}>
                        Edit<span className="sr-only"> {date(d.date)}</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={clear.isPending}
                        onClick={() => {
                          clear.reset()
                          setResetting(d)
                        }}
                      >
                        Reset<span className="sr-only"> {date(d.date)}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!canMove && <ManagerOnlyNote what="Moving a day's orders" />}
      {editing && <DayDialog day={editing} onClose={() => setEditing(null)} onDone={refresh} />}
      {moving && <MoveDayDialog onClose={() => setMoving(false)} />}
      {resetting && (
        <ConfirmDialog
          title={`Reset ${date(resetting.date)}?`}
          confirmLabel="Reset day"
          busy={clear.isPending}
          error={clear.error}
          onClose={() => setResetting(null)}
          onConfirm={() => clear.mutate(resetting.date)}
        >
          <p>
            {resetting.isOpen ? 'Its box limit' : 'Its closure'}
            {resetting.note ? ` ("${resetting.note}")` : ''} is removed: the day goes back to open, with no box limit, and customers can book it.
          </p>
        </ConfirmDialog>
      )}
    </section>
  )
}

function DayDialog({ day, onClose, onDone }: { day: CalendarDay; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [when, setWhen] = useState(day.date)
  const [isOpen, setIsOpen] = useState(day.isOpen)
  const [limit, setLimit] = useState(day.maxBoxes == null ? '' : String(day.maxBoxes))
  const [note, setNote] = useState(day.note ?? '')
  const [formError, setFormError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () =>
      api.setCalendarDay({
        date: when,
        isOpen,
        maxBoxes: isOpen && limit !== '' ? Number(limit) : null,
        note: note.trim() || null,
      }),
    onSuccess: () => {
      toast.success(`${date(when)} saved`)
      onDone()
      onClose()
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(when)) return setFormError('Pick a date.')
    if (limit !== '' && !/^\d+$/.test(limit)) return setFormError('The box limit must be a whole number.')
    save.mutate()
  }

  return (
    <Dialog
      title="Change a delivery day"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="day-form" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="day-form" onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor="day-date">Date</label>
          <input id="day-date" type="date" min={istDate(0)} value={when} onChange={(e) => setWhen(e.target.value)} />
        </div>
        <fieldset>
          <legend>Deliveries</legend>
          <div className="radio-row">
            <label>
              <input type="radio" name="day-open" checked={!isOpen} onChange={() => setIsOpen(false)} />
              Closed
            </label>
            <label>
              <input type="radio" name="day-open" checked={isOpen} onChange={() => setIsOpen(true)} />
              Open
            </label>
          </div>
        </fieldset>
        {isOpen && (
          <div className="field">
            <label htmlFor="day-limit">Box limit (optional)</label>
            <input id="day-limit" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value.trim())} />
            <p className="hint">Checkout stops taking orders for this date once this many boxes are booked.</p>
          </div>
        )}
        <div className="field">
          <label htmlFor="day-note">Note (optional)</label>
          <input id="day-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Diwali, bandh…" />
        </div>
        {!isOpen && (
          <p className="hint">Orders already booked for this date stay booked. Use Move a day's orders to move them.</p>
        )}
        <FormError error={formError ?? save.error} />
      </form>
    </Dialog>
  )
}

/**
 * Moves every confirmed order on one date to another (a rain-out, a holiday).
 * Checks first, so the manager sees how many orders it touches before anything moves.
 */
function MoveDayDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const coverage = useQuery({ queryKey: ['coverage'], queryFn: api.coverage })
  const [fromDate, setFromDate] = useState(istDate(1))
  const [toDate, setToDate] = useState('')
  const [pincodes, setPincodes] = useState('')
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<BulkMoveResult | null>(null)
  const [result, setResult] = useState<BulkMoveResult | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const targets = (coverage.data ?? []).map((d) => d.date).filter((d) => d !== fromDate)

  const input = () => {
    const pins = pincodes.split(/[\s,]+/).filter(Boolean)
    return { fromDate, toDate, reason: reason.trim(), ...(pins.length ? { pincodes: pins } : {}) }
  }
  const check = useMutation({ mutationFn: () => api.bulkReschedule({ ...input(), dryRun: true }), onSuccess: setPreview })
  const move = useMutation({
    mutationFn: () => api.bulkReschedule(input()),
    onSuccess: (r) => {
      setResult(r)
      toast.success(`${r.moved.length} of ${r.matched} orders moved`)
      for (const key of ['orders', 'coverage', 'summary', 'pack-list']) queryClient.invalidateQueries({ queryKey: [key] })
    },
  })
  const changed = () => setPreview(null)

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) return setFormError('Pick the day to move orders from.')
    if (!toDate) return setFormError('Pick the day to move them to.')
    if (pincodes.split(/[\s,]+/).filter(Boolean).some((p) => !/^\d{6}$/.test(p))) {
      return setFormError('Pincodes must be 6 digits, separated by commas.')
    }
    if (!reason.trim()) return setFormError('Say why, for example Heavy rain. It goes on each order.')
    if (preview) move.mutate()
    else check.mutate()
  }

  if (result) {
    return (
      <Dialog
        title="Orders moved"
        onClose={onClose}
        footer={
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        }
      >
        <p>
          {result.moved.length} of {result.matched} orders moved from {date(fromDate)}. Each customer gets a WhatsApp
          message with the new date.
        </p>
        {result.notMoved.length > 0 && (
          <>
            <h3>Not moved ({result.notMoved.length})</h3>
            <p className="muted small">These stay on {date(fromDate)}. Open each one to move or fix it by hand.</p>
            <ul>
              {result.notMoved.map((o) => (
                <li key={o.id}>
                  <Link to={`/orders/${o.id}`}>{o.number}</Link> {o.customerName}: {o.reason}
                </li>
              ))}
            </ul>
          </>
        )}
      </Dialog>
    )
  }

  const busy = check.isPending || move.isPending
  return (
    <Dialog
      title="Move a day's orders"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="move-form" className="btn btn-primary" disabled={busy || preview?.matched === 0}>
            {busy ? 'Working…' : preview ? `Move ${preview.matched} orders` : 'Check orders'}
          </button>
        </>
      }
    >
      <form id="move-form" onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor="move-from">Move orders from</label>
          <input
            id="move-from"
            type="date"
            min={istDate(0)}
            value={fromDate}
            onChange={(e) => {
              setFromDate(e.target.value)
              changed()
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="move-to">To</label>
          <select
            id="move-to"
            value={toDate}
            onChange={(e) => {
              setToDate(e.target.value)
              changed()
            }}
          >
            <option value="">Pick a delivery date</option>
            {targets.map((d) => (
              <option key={d} value={d}>
                {date(d)}
              </option>
            ))}
          </select>
          <p className="hint">An order with no stock that day goes to the next open date that has it.</p>
        </div>
        <div className="field">
          <label htmlFor="move-pins">Only these pincodes (optional)</label>
          <input
            id="move-pins"
            inputMode="numeric"
            value={pincodes}
            onChange={(e) => {
              setPincodes(e.target.value)
              changed()
            }}
            placeholder="560034, 560095"
          />
        </div>
        <div className="field">
          <label htmlFor="move-reason">Reason</label>
          <input
            id="move-reason"
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Heavy rain"
          />
        </div>
        {preview && (
          <p role="status">
            {preview.matched === 0
              ? `No confirmed orders on ${date(fromDate)} match.`
              : `${preview.matched} confirmed orders on ${date(fromDate)} will move. Packed orders are left alone.`}
          </p>
        )}
        <FormError error={formError ?? check.error ?? move.error} />
      </form>
    </Dialog>
  )
}

const slotTime = (s: Pick<DeliverySlot, 'startsAt' | 'endsAt'>) => `${s.startsAt}–${s.endsAt}`

/** Delivery time windows customers pick at checkout, each with an optional daily box limit. */
function Slots() {
  const { me } = useSession()
  const toast = useToast()
  const queryClient = useQueryClient()
  const q = useQuery({ queryKey: ['slots'], queryFn: api.slots })
  const [editing, setEditing] = useState<DeliverySlot | 'new' | null>(null)
  const [switchingOff, setSwitchingOff] = useState<DeliverySlot | null>(null)
  const allowed = can(me?.role, 'editRules')

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['slots'] })
    queryClient.invalidateQueries({ queryKey: ['coverage'] })
  }
  const toggle = useMutation({
    mutationFn: (s: DeliverySlot) => api.updateSlot(s.id, { active: !s.active }),
    onSuccess: (_r, s) => {
      toast.success(s.active ? `${s.label} switched off` : `${s.label} switched on`)
      setSwitchingOff(null)
      refresh()
    },
    onError: (err, s) => {
      if (!s.active) toast.error(err)
    },
  })

  return (
    <section className="card">
      <div className="topbar section-head">
        <h2>Delivery slots</h2>
        <span className="spacer" />
        <GatedButton allowed={allowed} className="btn" onClick={() => setEditing('new')}>
          Add slot
        </GatedButton>
      </div>
      <p className="muted">
        Customers pick one of the slots that are on when they check out. With no slots on, orders have no time window.
      </p>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState>No delivery slots yet.</EmptyState>
      ) : (
        <div {...scrollRegion('Delivery slots')}>
          <table>
            <thead>
              <tr>
                <th>Slot</th>
                <th>Time</th>
                <th className="num">Boxes per day</th>
                <th>State</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((s) => (
                <tr key={s.id}>
                  <td>{s.label}</td>
                  <td>{slotTime(s)}</td>
                  <td className="num">{s.maxBoxes ?? 'No limit'}</td>
                  <td>
                    <Badge tone={s.active ? 'good' : 'neutral'}>{s.active ? 'On' : 'Off'}</Badge>
                  </td>
                  <td>
                    <div className="btn-row">
                      <GatedButton allowed={allowed} className="btn btn-small" onClick={() => setEditing(s)}>
                        Edit<span className="sr-only"> {s.label}</span>
                      </GatedButton>
                      <GatedButton
                        allowed={allowed}
                        className="btn btn-small"
                        disabled={toggle.isPending}
                        onClick={() => {
                          // Switching on is safe; switching off takes the slot away from checkout, so it asks first.
                          if (s.active) {
                            toggle.reset()
                            setSwitchingOff(s)
                          } else toggle.mutate(s)
                        }}
                      >
                        {s.active ? 'Switch off' : 'Switch on'}
                        <span className="sr-only"> {s.label}</span>
                      </GatedButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!allowed && <ManagerOnlyNote what="Changing slots" />}
      {switchingOff && (
        <ConfirmDialog
          title={`Switch off ${switchingOff.label}?`}
          confirmLabel="Switch off"
          tone="danger"
          busy={toggle.isPending}
          error={toggle.error}
          onClose={() => setSwitchingOff(null)}
          onConfirm={() => toggle.mutate(switchingOff)}
        >
          <p>
            Customers can no longer pick {switchingOff.label} ({slotTime(switchingOff)}) at checkout. Orders already booked in it keep their slot.
          </p>
        </ConfirmDialog>
      )}
      {editing && (
        <SlotDialog slot={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={refresh} />
      )}
    </section>
  )
}

function SlotDialog({ slot, onClose, onDone }: { slot: DeliverySlot | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [label, setLabel] = useState(slot?.label ?? '')
  const [startsAt, setStartsAt] = useState(slot?.startsAt ?? '07:00')
  const [endsAt, setEndsAt] = useState(slot?.endsAt ?? '11:00')
  const [limit, setLimit] = useState(slot?.maxBoxes == null ? '' : String(slot.maxBoxes))
  const [formError, setFormError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => {
      const input = { label: label.trim(), startsAt, endsAt, maxBoxes: limit === '' ? null : Number(limit) }
      return slot ? api.updateSlot(slot.id, input) : api.addSlot(input)
    },
    onSuccess: (s) => {
      toast.success(`${s?.label ?? label.trim()} saved`)
      onDone()
      onClose()
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!label.trim()) return setFormError('Give the slot a name, like Morning.')
    if (!/^\d{2}:\d{2}$/.test(startsAt) || !/^\d{2}:\d{2}$/.test(endsAt)) return setFormError('Set a start and end time.')
    if (endsAt <= startsAt) return setFormError('The slot must end after it starts.')
    if (limit !== '' && !/^\d+$/.test(limit)) return setFormError('The box limit must be a whole number.')
    save.mutate()
  }

  return (
    <Dialog
      title={slot ? `Edit ${slot.label}` : 'Add a delivery slot'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="slot-form" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="slot-form" onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor="slot-label">Name</label>
          <input id="slot-label" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} placeholder="Morning" />
        </div>
        <div className="field">
          <label htmlFor="slot-start">Starts</label>
          <input id="slot-start" type="time" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="slot-end">Ends</label>
          <input id="slot-end" type="time" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="slot-limit">Boxes per day (optional)</label>
          <input id="slot-limit" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value.trim())} />
          <p className="hint">Checkout stops offering this slot on a day once this many boxes are booked in it.</p>
        </div>
        <FormError error={formError ?? save.error} />
      </form>
    </Dialog>
  )
}

const RULE_FIELDS: { key: keyof Rules; label: string; hint: string }[] = [
  { key: 'cutoffHourIST', label: 'Order cutoff (hour, IST)', hint: 'Orders before this hour deliver the next day; later ones the day after.' },
  { key: 'maxSellableAge', label: 'Oldest age sold (days)', hint: 'Checked on the delivery date. Day of pluck is age 0.' },
  { key: 'retireAge', label: 'Retire batches at age (days)', hint: 'Must be more than the oldest age sold.' },
  { key: 'maxDaysAhead', label: 'Days customers can book ahead', hint: 'Counted from the earliest delivery date.' },
  { key: 'holdMinutes', label: 'Checkout hold (minutes)', hint: 'Unpaid orders are cancelled after this.' },
  { key: 'maxUnpaidOrders', label: 'Unpaid orders per customer', hint: 'A customer must pay or cancel before placing another.' },
  { key: 'maxHeldBoxes', label: 'Unpaid boxes per customer', hint: 'Most boxes one customer can hold while not yet paid.' },
  { key: 'lowStockThreshold', label: 'Low stock alert (boxes)', hint: 'Shown on Today at or below this.' },
  { key: 'outForDeliveryAlertHours', label: 'Out for delivery alert (hours)', hint: 'An order out for delivery longer than this shows as overdue.' },
  { key: 'maxPreorderMoves', label: 'Preorder moves before review', hint: 'A preorder moved forward more weeks than this waits for a manager.' },
]

/** What the API uses for rules an older rules version doesn't have yet. */
const RULE_DEFAULTS: Partial<Record<keyof Rules, number>> = { outForDeliveryAlertHours: 8, maxPreorderMoves: 3 }

function RulesCard() {
  const { me } = useSession()
  const q = useQuery({ queryKey: ['rules'], queryFn: api.rules })
  const [editing, setEditing] = useState(false)
  const allowed = can(me?.role, 'editRules')

  return (
    <section className="card">
      <div className="topbar section-head">
        <h2>Selling rules</h2>
        {q.data && <span className="muted small">Version {q.data.version}</span>}
        <span className="spacer" />
        <GatedButton allowed={allowed} className="btn" onClick={() => setEditing(true)}>
          Edit rules
        </GatedButton>
      </div>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <dl className="kv">
            {RULE_FIELDS.map((f) => (
              <div key={f.key} className="contents">
                <dt>{f.label}</dt>
                <dd>{String(q.data.rules[f.key] ?? RULE_DEFAULTS[f.key] ?? '—')}</dd>
              </div>
            ))}
            <div className="contents">
              <dt>Season ends</dt>
              <dd>{q.data.rules.seasonEndsOn ? date(q.data.rules.seasonEndsOn) : 'Not set'}</dd>
            </div>
          </dl>
          <h3 className="mt-5">Ripeness by age on the delivery date</h3>
          <p className="muted small">
            The latest QC reading can move a batch up to {q.data.rules.maxQcShift} day either way.
          </p>
          <div {...scrollRegion('Ripeness windows')}>
            <table>
              <thead>
                <tr>
                  <th>Variety</th>
                  {STAGES.map((s) => (
                    <th key={s}>{RIPENESS_LABEL[s]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(q.data.rules.stageProfiles).map(([variety, windows]) => (
                  <tr key={variety}>
                    <td>{variety === 'default' ? 'All varieties' : variety}</td>
                    {STAGES.map((s) => {
                      const w = windows.find((x) => x.stage === s)
                      return <td key={s}>{w ? ageRange(w) : '—'}</td>
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!allowed && <ManagerOnlyNote what="Changing rules" />}
        </>
      )}
      {editing && q.data && <RulesDialog rules={q.data.rules} onClose={() => setEditing(false)} />}
    </section>
  )
}

const ageRange = (w: StageWindow) => (w.minAge === w.maxAge ? `day ${w.minAge}` : `days ${w.minAge}–${w.maxAge}`)

function RulesDialog({ rules, onClose }: { rules: Rules; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [values, setValues] = useState(() =>
    Object.fromEntries(RULE_FIELDS.map((f) => [f.key, String(rules[f.key] ?? RULE_DEFAULTS[f.key] ?? '')])) as Record<string, string>,
  )
  const [seasonEndsOn, setSeasonEndsOn] = useState(rules.seasonEndsOn ?? '')
  const [windows, setWindows] = useState(() =>
    rules.stageProfiles.default.map((w) => ({ stage: w.stage, minAge: String(w.minAge), maxAge: String(w.maxAge) })),
  )
  const [formError, setFormError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (next: Rules) => api.saveRules(next),
    onSuccess: (saved) => {
      toast.success(`Rules saved as version ${saved.version}. Open orders are being re-checked.`)
      queryClient.invalidateQueries({ queryKey: ['rules'] })
      queryClient.invalidateQueries({ queryKey: ['coverage'] })
      onClose()
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    const all = [...Object.values(values), ...windows.flatMap((w) => [w.minAge, w.maxAge])]
    if (all.some((v) => !/^\d+$/.test(v))) return setFormError('Every value must be a whole number.')
    const next: Rules = {
      ...rules,
      ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Number(v)])),
      seasonEndsOn: seasonEndsOn || null,
      stageProfiles: {
        ...rules.stageProfiles,
        default: windows.map((w) => ({ stage: w.stage, minAge: Number(w.minAge), maxAge: Number(w.maxAge) })),
      },
    }
    save.mutate(next)
  }

  return (
    <Dialog
      title="Edit selling rules"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="rules-form" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save as new version'}
          </button>
        </>
      }
    >
      <form id="rules-form" onSubmit={onSubmit} noValidate>
        {RULE_FIELDS.map((f) => (
          <div className="field" key={f.key}>
            <label htmlFor={`rule-${f.key}`}>{f.label}</label>
            <input
              id={`rule-${f.key}`}
              inputMode="numeric"
              value={values[f.key]}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value.trim() })}
            />
            <p className="hint">{f.hint}</p>
          </div>
        ))}
        <div className="field">
          <label htmlFor="rule-seasonEndsOn">Season ends (optional)</label>
          <input id="rule-seasonEndsOn" type="date" value={seasonEndsOn} onChange={(e) => setSeasonEndsOn(e.target.value)} />
          <p className="hint">Preorders booked for a week after this day wait for a manager to keep or refund them.</p>
        </div>
        <fieldset>
          <legend>Ripeness by age, all varieties</legend>
          {windows.map((w, i) => (
            <div className="btn-row align-end" key={w.stage}>
              <div className="field">
                <label htmlFor={`win-${w.stage}-min`}>{RIPENESS_LABEL[w.stage]} from day</label>
                <input
                  id={`win-${w.stage}-min`}
                  inputMode="numeric"
                  size={3}
                  value={w.minAge}
                  onChange={(e) => setWindows(windows.map((x, j) => (j === i ? { ...x, minAge: e.target.value.trim() } : x)))}
                />
              </div>
              <div className="field">
                <label htmlFor={`win-${w.stage}-max`}>to day</label>
                <input
                  id={`win-${w.stage}-max`}
                  inputMode="numeric"
                  size={3}
                  value={w.maxAge}
                  onChange={(e) => setWindows(windows.map((x, j) => (j === i ? { ...x, maxAge: e.target.value.trim() } : x)))}
                />
              </div>
            </div>
          ))}
        </fieldset>
        <p className="hint">Saving re-checks every open order against the new rules. Orders that no longer fit are flagged at risk.</p>
        <FormError error={formError ?? save.error} />
      </form>
    </Dialog>
  )
}
