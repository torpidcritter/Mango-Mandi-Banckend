// Farm Calendar (docs/farm-experience.md): which days take visits, each day's visit cap, the
// harvest per variety, the visits booked, guests staying and rooms in use. Managers open and
// close days; closing a day with bookings lists them, so they are moved, never left silently.
import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { date, istDate } from '../../format'
import { Badge, Dialog, FormError, ManagerOnlyNote, QueryError, Spinner, scrollRegion, usePageTitle, useToast } from '../../ui'
import { farm, type CalendarDay } from './api'
import { FarmBadge, FarmSubnav, useIsManager } from './shared'

const REASONS = { WEATHER: 'Weather', MAINTENANCE: 'Maintenance', SEASON: 'Out of season', HOLIDAY: 'Holiday', OTHER: 'Other' } as const
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

export default function FarmCalendar() {
  usePageTitle('Farm Calendar')
  const manager = useIsManager()
  const [from, setFrom] = useState(istDate())
  const q = useQuery({ queryKey: ['farm-calendar', from], queryFn: () => farm.calendar(from, addDays(from, 27)) })
  const [editing, setEditing] = useState<CalendarDay | null>(null)
  const [bulk, setBulk] = useState(false)
  return (
    <>
      <div className="topbar">
        <h1>Farm Calendar</h1>
        <span className="spacer" />
        {manager && (
          <button type="button" className="btn btn-primary" onClick={() => setBulk(true)}>
            Open or close many days
          </button>
        )}
      </div>
      <FarmSubnav />
      {!manager && <ManagerOnlyNote what="Opening and closing days" />}
      <div className="farm-actions mb-3">
        <button type="button" className="btn btn-small" onClick={() => setFrom(addDays(from, -28))}>
          Earlier
        </button>
        <span>
          {date(from)} to {date(addDays(from, 27))}
        </span>
        <button type="button" className="btn btn-small" onClick={() => setFrom(addDays(from, 28))}>
          Later
        </button>
        <button type="button" className="btn btn-small" onClick={() => setFrom(istDate())}>
          Today
        </button>
      </div>
      {q.isPending ? (
        <Spinner label="Loading the calendar" />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <p className="muted small">
            Farmhouse: {q.data.rooms} rooms in use, sleeping up to {q.data.beds} with extra beds. Harvest per variety is set on <Link to="/farm/harvest">Harvest stock</Link>.
          </p>
          <div {...scrollRegion('Farm calendar', { cards: true })}>
            <table className="pn-table">
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Open</th>
                  <th scope="col">Harvest left (bookable − booked)</th>
                  <th scope="col">Visits</th>
                  <th scope="col">Staying overnight</th>
                  <th scope="col">Rooms used</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {q.data.days.map((d) => (
                  <tr key={d.date}>
                    <td className="card-title">
                      {date(d.date)}
                      {d.note && <div className="muted small">{d.note}</div>}
                    </td>
                    <td data-label="Open">
                      {d.open ? <Badge tone="good">Open</Badge> : <Badge>{d.closedReason ? REASONS[d.closedReason as keyof typeof REASONS] : 'Closed'}</Badge>}
                      {d.open && d.maxBookings != null && <div className="muted small">Up to {d.maxBookings} visits</div>}
                    </td>
                    <td data-label="Harvest left">
                      {d.harvest.length ? d.harvest.map((h) => <div key={h.varietyId}>{h.name}: {h.availableKg} kg</div>) : <span className="muted">—</span>}
                    </td>
                    <td data-label="Visits">
                      {d.visits.map((v) => (
                        <div key={v.id}>
                          <Link to={`/farm/bookings/${encodeURIComponent(v.id)}`} className="mono">
                            {v.number}
                          </Link>{' '}
                          {v.guests} guests, {v.kg} kg <FarmBadge status={v.status} />
                          {v.overCapacity && <Badge tone="warn">Large group</Badge>}
                        </div>
                      ))}
                      {!d.visits.length && <span className="muted">—</span>}
                    </td>
                    <td data-label="Staying overnight">{d.overnightGuests || '—'}</td>
                    <td data-label="Rooms used">
                      {d.roomsInUse || '—'}
                      {d.overlaps.length > 0 && <Badge tone="bad">Room clash: {d.overlaps.join(', ')}</Badge>}
                    </td>
                    <td className="card-wide">
                      {manager && (
                        <button type="button" className="btn btn-small" onClick={() => setEditing(d)}>
                          Edit<span className="sr-only"> {date(d.date)}</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {editing && <DayDialog day={editing} onClose={() => setEditing(null)} />}
      {bulk && <BulkDialog from={from} onClose={() => setBulk(false)} />}
    </>
  )
}

interface DayForm {
  open: boolean
  closedReason: string
  maxBookings: string
  note: string
}

function DayFields({ id, f, set }: { id: string; f: DayForm; set: (p: Partial<DayForm>) => void }) {
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={f.open} onChange={(e) => set({ open: e.target.checked })} /> Open for visits
      </label>
      {f.open ? (
        <div className="field">
          <label htmlFor={`${id}-max`}>Most visits that day (empty for no cap)</label>
          <input id={`${id}-max`} type="number" min={0} value={f.maxBookings} onChange={(e) => set({ maxBookings: e.target.value })} />
        </div>
      ) : (
        <div className="field">
          <label htmlFor={`${id}-why`}>Why closed</label>
          <select id={`${id}-why`} value={f.closedReason} onChange={(e) => set({ closedReason: e.target.value })}>
            {Object.entries(REASONS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label htmlFor={`${id}-note`}>Note (staff only)</label>
        <input id={`${id}-note`} type="text" maxLength={500} value={f.note} onChange={(e) => set({ note: e.target.value })} />
      </div>
    </>
  )
}

const toBody = (f: DayForm) => ({
  open: f.open,
  closedReason: f.open ? null : f.closedReason,
  maxBookings: f.open && f.maxBookings !== '' ? Number(f.maxBookings) : null,
  note: f.note.trim() || null,
})

function useDone(onClose: () => void) {
  const queryClient = useQueryClient()
  const toast = useToast()
  return (moved: string[]) => {
    void queryClient.invalidateQueries({ queryKey: ['farm-calendar'] })
    if (moved.length) toast.info(`Saved. These bookings are on a closed day and need moving: ${moved.join(', ')}`)
    else toast.success('Saved')
    onClose()
  }
}

function DayDialog({ day, onClose }: { day: CalendarDay; onClose: () => void }) {
  const id = useId()
  const done = useDone(onClose)
  const [f, setF] = useState<DayForm>({ open: day.open, closedReason: day.closedReason ?? 'WEATHER', maxBookings: day.maxBookings == null ? '' : String(day.maxBookings), note: day.note ?? '' })
  const save = useMutation({ mutationFn: () => farm.saveDay(day.date, toBody(f)), onSuccess: (r) => done(r.bookingsToMove) })
  return (
    <Dialog
      title={`Edit ${date(day.date)}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save day'}
          </button>
        </>
      }
    >
      {!f.open && day.visits.length > 0 && <p className="form-error">{day.visits.length} booking(s) visit this day. Closing it lists them for moving.</p>}
      <DayFields id={id} f={f} set={(p) => setF((x) => ({ ...x, ...p }))} />
      <FormError error={save.error} />
    </Dialog>
  )
}

function BulkDialog({ from, onClose }: { from: string; onClose: () => void }) {
  const id = useId()
  const done = useDone(onClose)
  const [start, setStart] = useState(from)
  const [end, setEnd] = useState(addDays(from, 27))
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6])
  const [f, setF] = useState<DayForm>({ open: true, closedReason: 'SEASON', maxBookings: '', note: '' })
  const save = useMutation({
    mutationFn: () => farm.saveDays({ from: start, to: end, weekdays: days.length === 7 ? undefined : days, day: toBody(f) }),
    onSuccess: (r) => done(r.bookingsToMove),
  })
  return (
    <Dialog
      title="Open or close many days"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={save.isPending || !days.length} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save days'}
          </button>
        </>
      }
    >
      <div className="field-row">
        <div className="field">
          <label htmlFor={`${id}-from`}>From</label>
          <input id={`${id}-from`} type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-to`}>To</label>
          <input id={`${id}-to`} type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>
      <fieldset className="field">
        <legend>Weekdays</legend>
        <div className="farm-actions">
          {WEEKDAYS.map((w, i) => (
            <label key={w} className="check">
              <input type="checkbox" checked={days.includes(i)} onChange={(e) => setDays((d) => (e.target.checked ? [...d, i] : d.filter((x) => x !== i)))} /> {w}
            </label>
          ))}
        </div>
      </fieldset>
      <DayFields id={id} f={f} set={(p) => setF((x) => ({ ...x, ...p }))} />
      <FormError error={save.error} />
    </Dialog>
  )
}
