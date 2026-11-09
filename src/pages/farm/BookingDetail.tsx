// One Farm Experience booking (docs/farm-experience.md): everything the customer gave, the money,
// and every action the booking's status allows (the API sends nextMoves and checks each again).
// Managers move dates, cancel, refund and mark no-shows; refunds and cancelling a paid booking
// ask the manager to confirm it is them. Every action lands in the booking's history.
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { date, dateTime, rupees } from '../../format'
import { MONEY_CHANGE_WHY, useStepUp } from '../../StepUp'
import { Badge, BackLink, Dialog, FormError, ManagerOnlyNote, PhoneLink, QueryError, Spinner, scrollRegion, usePageTitle, useToast } from '../../ui'
import { farm, type Booking, type MealDay } from './api'
import { FARM_STATUS_LABEL, FarmBadge, HOSPITALITY_LABEL, MOVE_LABEL, useIsManager } from './shared'

export default function FarmBookingDetail() {
  const { id = '' } = useParams()
  const q = useQuery({ queryKey: ['farm-booking', id], queryFn: () => farm.booking(id) })
  usePageTitle(q.data ? `Farm booking ${q.data.number}` : 'Farm booking')
  return (
    <>
      <BackLink to="/farm/bookings">Farm Experience Bookings</BackLink>
      {q.isPending ? <Spinner label="Loading the booking" /> : q.isError ? <QueryError error={q.error} onRetry={() => q.refetch()} /> : <Detail b={q.data} />}
    </>
  )
}

type Open = null | 'propose' | 'approve' | 'rooms' | 'harvest' | 'extra' | 'shortfall' | 'move' | 'cancel' | 'noShow' | 'decline' | 'checkIn' | { settle: string }

function Detail({ b }: { b: Booking }) {
  const manager = useIsManager()
  const toast = useToast()
  const queryClient = useQueryClient()
  const stepUp = useStepUp(MONEY_CHANGE_WHY)
  const [open, setOpen] = useState<Open>(null)
  const act = useMutation({
    mutationFn: (call: (confirmCode?: string) => Promise<Booking>) => stepUp.run(call),
    onSuccess: (next) => {
      queryClient.setQueryData(['farm-booking', b.id], next)
      void queryClient.invalidateQueries({ queryKey: ['farm-bookings'] })
      void queryClient.invalidateQueries({ queryKey: ['farm-overview'] })
      setOpen(null)
      toast.success('Saved')
    },
  })
  const run = (call: (confirmCode?: string) => Promise<Booking>) => act.mutate(call)
  const next = new Set(b.nextMoves)
  const g = b.guests
  const food = g.food ?? {}
  const openExtras = b.extras.filter((x) => x.status === 'REQUESTED' || x.status === 'PAYMENT_PENDING')
  const dialog = (kind: Exclude<Open, null | { settle: string }>) => open === kind

  return (
    <>
      <div className="topbar">
        <h1>
          Farm booking <span className="mono">{b.number}</span>
        </h1>
        <FarmBadge status={b.status} />
      </div>

      {b.attentionReason && b.status === 'NEEDS_ATTENTION' && (
        <div className="notice notice-warn" role="note">
          <strong>Needs attention.</strong> {b.attentionReason}
        </div>
      )}
      {b.request && (
        <div className="notice notice-warn" role="note">
          <strong>{b.request.kind === 'CANCEL' ? 'The customer asks to cancel.' : `The customer asks to move the visit to ${b.request.date ? date(b.request.date) : 'another date'}.`}</strong>{' '}
          {b.request.note && <q>{b.request.note}</q>} <span className="muted small">({dateTime(b.request.at)})</span>
          <div className="farm-actions mt-2">
            {b.request.kind === 'MOVE' && b.request.date && (
              <button type="button" className="btn btn-primary btn-small" disabled={!manager} onClick={() => setOpen('move')}>
                Move to {date(b.request.date)}
              </button>
            )}
            {b.request.kind === 'CANCEL' && (
              <button type="button" className="btn btn-small" disabled={!manager} onClick={() => setOpen('cancel')}>
                Cancel the booking
              </button>
            )}
            <button type="button" className="btn btn-small" disabled={!manager} onClick={() => setOpen('decline')}>
              Decline the request
            </button>
          </div>
          {!manager && <ManagerOnlyNote what="Answering a customer's request" />}
        </div>
      )}
      {b.hospitality.overCapacity && b.hospitality.status === 'PENDING' && (
        <div className="notice notice-warn" role="note">
          <strong>Larger than the farmhouse.</strong> {g.overnight} people stay overnight. Assign rooms or write how you will host them before approving, or propose an alternative.
        </div>
      )}
      {b.discrepancy && (b.discrepancy.shortKg > 0 || b.discrepancy.overKg > 0) && (
        <div className="notice notice-warn" role="note">
          {b.discrepancy.shortKg > 0
            ? `${b.discrepancy.shortKg} kg less was accepted than was paid for (${b.paidKg} kg paid). A manager can refund the shortfall.`
            : `${b.discrepancy.overKg} kg more was accepted than was paid for. Ask the customer to approve extra mangoes.`}
        </div>
      )}

      <section className="card">
        <h2>Actions</h2>
        <div className="farm-actions">
          {next.has('APPROVE') && (
            <button type="button" className="btn btn-primary" onClick={() => setOpen('approve')}>
              Approve stay
            </button>
          )}
          {next.has('PROPOSE') && (
            <button type="button" className="btn" onClick={() => setOpen('propose')}>
              Propose an alternative
            </button>
          )}
          {next.has('ROOMS') && (
            <button type="button" className="btn" onClick={() => setOpen('rooms')}>
              Assign rooms
            </button>
          )}
          {b.nextMoves
            .filter((m) => MOVE_LABEL[m])
            .map((m) => (
              <button key={m} type="button" className={m === 'COMPLETED' ? 'btn btn-primary' : 'btn'} disabled={act.isPending} onClick={() => run(() => farm.status(b.id, m))}>
                {MOVE_LABEL[m]}
              </button>
            ))}
          {next.has('CHECK_IN') && (
            <button type="button" className="btn btn-primary" onClick={() => setOpen('checkIn')}>
              Check in
            </button>
          )}
          {next.has('HARVEST') && (
            <button type="button" className="btn" onClick={() => setOpen('harvest')}>
              Record harvest and packing
            </button>
          )}
          {next.has('EXTRA') && (
            <button type="button" className="btn" onClick={() => setOpen('extra')}>
              Ask for extra kg
            </button>
          )}
          {next.has('SHORTFALL') && (
            <button type="button" className="btn" disabled={!manager} onClick={() => setOpen('shortfall')}>
              Refund a shortfall
            </button>
          )}
          {next.has('MOVE') && (
            <button type="button" className="btn" disabled={!manager} onClick={() => setOpen('move')}>
              Move visit date
            </button>
          )}
          {next.has('NO_SHOW') && (
            <button type="button" className="btn" disabled={!manager} onClick={() => setOpen('noShow')}>
              Mark no-show
            </button>
          )}
          {next.has('CANCEL') && (
            <button type="button" className="btn btn-danger" disabled={!manager} onClick={() => setOpen('cancel')}>
              Cancel booking
            </button>
          )}
        </div>
        {!manager && ['SHORTFALL', 'MOVE', 'NO_SHOW', 'CANCEL'].some((m) => next.has(m)) && <ManagerOnlyNote what="Moving dates, cancelling, refunds and no-shows" />}
        {!b.nextMoves.length && <p className="muted">No actions are open for a booking in this state.</p>}
        <FormError error={open === null ? act.error : null} />
      </section>

      <div className="grid-2">
        <section className="card">
          <h2>Customer</h2>
          <dl className="farm-facts">
            <Row label="Name">{b.contact.name}</Row>
            <Row label="Phone">
              <PhoneLink phone={b.contact.phone} who={b.contact.name} />
            </Row>
            <Row label="Email">{b.contact.email ?? '—'}</Row>
            {b.billing && (
              <Row label="Bill to">
                {b.billing.name ?? '—'}
                {b.billing.gstin && <span className="mono"> · {b.billing.gstin}</span>}
              </Row>
            )}
            {b.customer && (
              <Row label="Account">
                <Link to={`/customers/${encodeURIComponent(b.customer.id)}`}>Customer profile</Link>
              </Row>
            )}
          </dl>
        </section>
        <section className="card">
          <h2>Mangoes and payment</h2>
          <dl className="farm-facts">
            <Row label="Variety">{b.variety.name}</Row>
            <Row label="Booked">
              {b.kg} kg at {rupees(b.pricePerKg)}/kg = {rupees(b.total)}
            </Row>
            <Row label="Paid">
              {rupees(b.money.paid)}
              {b.paidAt && <span className="muted small"> · {dateTime(b.paidAt)}</span>}
            </Row>
            {b.money.refunded > 0 && <Row label="Refunded">{rupees(b.money.refunded)}</Row>}
            <Row label="Stock">{b.kgReserved ? `${b.kg} kg held for this booking` : 'No kg held'}</Row>
            {b.harvestDay && (
              <Row label="That day">
                {b.harvestDay.bookableKg} kg bookable, {b.harvestDay.reservedKg} kg booked · {b.harvestDay.readiness.toLowerCase().replace(/_/g, ' ')}
              </Row>
            )}
            {b.holdExpiresAt && <Row label="Hold until">{dateTime(b.holdExpiresAt)}</Row>}
          </dl>
        </section>
      </div>

      <div className="grid-2">
        <section className="card">
          <h2>Visit and group</h2>
          <dl className="farm-facts">
            <Row label="Visit">{date(b.visitDate)}</Row>
            <Row label="Stay">
              {date(g.arrivalDate)} to {date(g.departureDate)}
            </Row>
            <Row label="Group">
              {g.adults} adults, {g.children} children ({g.total} people) · {g.overnight} overnight
            </Row>
            <Row label="Food">
              {[food.veg != null && `${food.veg} veg`, food.nonVeg != null && `${food.nonVeg} non-veg`, food.jain != null && `${food.jain} Jain`].filter(Boolean).join(', ') || '—'}
              {food.allergies && <div>Allergies: {food.allergies}</div>}
              {food.requests && <div>Requests: {food.requests}</div>}
            </Row>
            {g.accessibility && <Row label="Accessibility">{g.accessibility}</Row>}
            {g.notes && <Row label="Customer notes">{g.notes}</Row>}
            {g.list.length > 0 && <Row label="Guest names">{g.list.map((x) => x.name + (x.child ? ' (child)' : '')).join(', ')}</Row>}
            <Row label="Check-in code">
              <span className="mono">{b.checkinCode}</span>
            </Row>
            {b.checkedInAt && <Row label="Checked in">{dateTime(b.checkedInAt)}</Row>}
          </dl>
        </section>
        <section className="card">
          <h2>Stay and meals</h2>
          <p>
            <Badge tone={b.hospitality.status === 'APPROVED' || b.hospitality.status === 'CUSTOMER_ACCEPTED' ? 'good' : b.hospitality.status === 'PENDING' ? 'warn' : 'neutral'}>
              {HOSPITALITY_LABEL[b.hospitality.status]}
            </Badge>
          </p>
          {b.hospitality.plan && <p>{b.hospitality.plan}</p>}
          {b.hospitality.alternative && (
            <p>
              <strong>Proposed to the customer:</strong> {b.hospitality.alternative}
            </p>
          )}
          {b.hospitality.rooms.length > 0 ? (
            <ul>
              {b.hospitality.rooms.map((r) => (
                <li key={`${r.roomId}-${r.fromDate}`}>
                  {r.name}: {r.guests} guests{r.extraBeds ? ` + ${r.extraBeds} extra beds` : ''}, {date(r.fromDate)} to {date(r.toDate)}
                  {r.note && <span className="muted small"> · {r.note}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No rooms assigned.</p>
          )}
          <MealPlan b={b} onSave={(mealPlan) => run(() => farm.patch(b.id, { mealPlan, version: b.version }))} busy={act.isPending} />
        </section>
      </div>

      <section className="card">
        <h2>Harvest and packing</h2>
        <dl className="farm-facts">
          <Row label="Harvest">{b.harvest.status.toLowerCase().replace(/_/g, ' ')}</Row>
          <Row label="Harvested">{b.harvest.harvestedKg != null ? `${b.harvest.harvestedKg} kg` : '—'}</Row>
          <Row label="Accepted">{b.harvest.acceptedKg != null ? `${b.harvest.acceptedKg} kg (paid for ${b.paidKg} kg)` : '—'}</Row>
          <Row label="Packing">{b.harvest.packingStatus.toLowerCase().replace(/_/g, ' ')}</Row>
          {b.harvest.inspectionNote && <Row label="Inspection">{b.harvest.inspectionNote}</Row>}
        </dl>
        {b.extras.length > 0 && (
          <>
            <h3>Extra kg</h3>
            <ul>
              {b.extras.map((x) => (
                <li key={x.id}>
                  {x.kg} kg at {rupees(x.pricePerKg)}/kg = {rupees(x.amount)} · {x.status.toLowerCase().replace(/_/g, ' ')}
                  {(x.status === 'REQUESTED' || x.status === 'PAYMENT_PENDING') && (
                    <button type="button" className="link-btn" onClick={() => run(() => farm.withdrawExtra(b.id, x.id))}>
                      {' '}
                      Withdraw
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {openExtras.length > 0 && <p className="muted small">The customer approves and pays for extra kg on their booking page. A booking can't be completed while a request is open.</p>}
      </section>

      <section className="card">
        <h2>Payments and refunds</h2>
        <div {...scrollRegion('Payments')}>
          <table className="pn-table">
            <thead>
              <tr>
                <th scope="col">For</th>
                <th scope="col">Amount</th>
                <th scope="col">Status</th>
                <th scope="col">Razorpay</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {b.payments.map((p) => (
                <tr key={p.id}>
                  <td>{p.kind === 'EXTRA' ? 'Extra kg' : 'Booking'}</td>
                  <td>{rupees(p.amount)}</td>
                  <td>
                    {p.status.toLowerCase()}
                    {p.failed && ' (a try failed)'}
                  </td>
                  <td className="mono small">{p.paymentId ?? p.razorpayOrderId ?? '—'}</td>
                  <td>{dateTime(p.paidAt ?? p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {b.money.refunds.length > 0 && (
          <ul className="mt-2">
            {b.money.refunds.map((r) => (
              <li key={r.id}>
                Refund {rupees(r.amount)} ({r.kind.toLowerCase().replace(/_/g, ' ')}) · {r.status === 'NEEDS_A_MANAGER' ? <strong>Razorpay kept refusing: settle it by hand</strong> : r.status.toLowerCase()}
                {r.reason && <span className="muted small"> · {r.reason}</span>}
                {r.status === 'NEEDS_A_MANAGER' && (
                  <button type="button" className="btn btn-small" disabled={!manager} onClick={() => setOpen({ settle: r.id })}>
                    Record a manual refund
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Notes b={b} />

      <section className="card">
        <h2>History</h2>
        <ol className="timeline">
          {[...b.events].reverse().map((e) => (
            <li key={e.id}>
              <strong>{e.action.toLowerCase().replace(/_/g, ' ')}</strong>
              {e.from !== e.to && e.from && <span className="muted small"> · {statusName(e.from)} → {statusName(e.to)}</span>}
              {e.detail && <div>{e.detail}</div>}
              <div className="muted small">
                {dateTime(e.at)} · {e.actor}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {dialog('approve') && (
        <TextDialog
          title="Approve the stay"
          label={b.hospitality.overCapacity ? 'How you will host the group (needed unless rooms are assigned)' : 'Notes on the stay (optional)'}
          initial={b.hospitality.plan ?? ''}
          confirm="Approve and confirm"
          busy={act.isPending}
          error={act.error}
          onClose={() => setOpen(null)}
          onSubmit={(text) => run(() => farm.hospitality(b.id, 'APPROVE', text || undefined))}
        >
          <p>The booking becomes Confirmed and the customer is told. Meals start from the farm's included meals; adjust the meal plan after.</p>
        </TextDialog>
      )}
      {dialog('propose') && (
        <TextDialog
          title="Propose an alternative arrangement"
          label="What you propose (the customer sees this)"
          required
          confirm="Send to the customer"
          busy={act.isPending}
          error={act.error}
          onClose={() => setOpen(null)}
          onSubmit={(text) => run(() => farm.hospitality(b.id, 'PROPOSE', text))}
        >
          <p>The customer accepts or declines on their booking page. If they decline, they can cancel for a full refund.</p>
        </TextDialog>
      )}
      {dialog('rooms') && <RoomsDialog b={b} busy={act.isPending} error={act.error} onClose={() => setOpen(null)} onSave={(a) => run(() => farm.rooms(b.id, a))} />}
      {dialog('checkIn') && (
        <Dialog
          title="Check in"
          onClose={() => setOpen(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setOpen(null)}>
                Cancel
              </button>
              {manager && (
                <button type="button" className="btn" disabled={act.isPending} onClick={() => run(() => farm.checkIn(b.checkinCode, true))}>
                  Check in outside the stay dates
                </button>
              )}
              <button type="button" className="btn btn-primary" disabled={act.isPending} onClick={() => run(() => farm.checkIn(b.checkinCode))}>
                Check in now
              </button>
            </>
          }
        >
          <p>
            Check that the guest shows code <span className="mono">{b.checkinCode}</span> (or its QR). Check-in works from {date(g.arrivalDate)} to {date(g.departureDate)}.
          </p>
          <FormError error={act.error} />
        </Dialog>
      )}
      {dialog('harvest') && <HarvestDialog b={b} busy={act.isPending} error={act.error} onClose={() => setOpen(null)} onSave={(body) => run(() => farm.harvest(b.id, body))} />}
      {dialog('extra') && (
        <NumberDialog
          title="Ask the customer to approve extra kg"
          label="Extra kg"
          noteLabel="Note to the customer (optional)"
          confirm="Send request"
          busy={act.isPending}
          error={act.error}
          onClose={() => setOpen(null)}
          onSubmit={(kg, note) => run(() => farm.extra(b.id, kg, note || undefined))}
        >
          <p>Priced at the farm's extra price per kg (or this booking's price). The customer approves and pays online; nothing is charged until then.</p>
        </NumberDialog>
      )}
      {dialog('shortfall') && (
        <NumberDialog
          title="Refund a shortfall"
          label="Kg short"
          noteLabel="Reason (kept in the history)"
          noteRequired
          confirm="Refund"
          busy={act.isPending}
          error={act.error}
          onClose={() => setOpen(null)}
          onSubmit={(kg, reason) => run((c) => farm.shortfall(b.id, kg, reason, c))}
        >
          <p>
            Refunds {rupees(b.pricePerKg)} per kg to the customer's payment, up to what was paid and not accepted ({b.discrepancy?.shortKg ?? 0} kg now). You will be asked to confirm it's you.
          </p>
        </NumberDialog>
      )}
      {dialog('move') && <MoveDialog b={b} busy={act.isPending} error={act.error} onClose={() => setOpen(null)} onSave={(d, reason, outside) => run(() => farm.move(b.id, d, reason, outside))} />}
      {dialog('cancel') && <CancelDialog b={b} busy={act.isPending} error={act.error} onClose={() => setOpen(null)} onSave={(body) => run((c) => farm.cancel(b.id, body, c))} />}
      {dialog('noShow') && (
        <TextDialog
          title="Mark as no-show"
          label="Note (optional)"
          confirm="Mark no-show"
          busy={act.isPending}
          error={act.error}
          onClose={() => setOpen(null)}
          onSubmit={(text) => run(() => farm.noShow(b.id, text || undefined))}
        >
          <p>Only after the visit date has passed. No refund is made automatically: if one is due by your no-show policy, cancel with a refund instead.</p>
        </TextDialog>
      )}
      {dialog('decline') && (
        <TextDialog
          title="Decline the customer's request"
          label="Reason (the customer may be told)"
          required
          minLength={5}
          confirm="Decline"
          busy={act.isPending}
          error={act.error}
          onClose={() => setOpen(null)}
          onSubmit={(text) => run(() => farm.declineRequest(b.id, text))}
        />
      )}
      {open && typeof open === 'object' && (
        <TextDialog
          title="Record a manual refund"
          label="Bank or UPI reference of the refund you made"
          required
          minLength={3}
          confirm="Record refund"
          busy={act.isPending}
          error={act.error}
          onClose={() => setOpen(null)}
          onSubmit={(ref) => run((c) => farm.settleRefund(open.settle, ref, c))}
        >
          <p>Use this only after you have paid the money back yourself. You will be asked to confirm it's you.</p>
        </TextDialog>
      )}
      {stepUp.dialog}
    </>
  )
}

const statusName = (s: string) => (FARM_STATUS_LABEL as Record<string, string>)[s]?.toLowerCase() ?? s.toLowerCase().replace(/_/g, ' ')
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function TextDialog({
  title,
  label,
  initial = '',
  required = false,
  minLength = 1,
  confirm,
  busy,
  error,
  onClose,
  onSubmit,
  children,
}: {
  title: string
  label: string
  initial?: string
  required?: boolean
  minLength?: number
  confirm: string
  busy: boolean
  error: unknown
  onClose: () => void
  onSubmit: (text: string) => void
  children?: ReactNode
}) {
  const id = useId()
  const [text, setText] = useState(initial)
  const ok = !required || text.trim().length >= minLength
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={id} className="btn btn-primary" disabled={busy || !ok}>
            {busy ? 'Saving…' : confirm}
          </button>
        </>
      }
    >
      <form
        id={id}
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          if (ok) onSubmit(text.trim())
        }}
      >
        {children}
        <div className="field">
          <label htmlFor={`${id}-text`}>{label}</label>
          <textarea id={`${id}-text`} rows={4} maxLength={3000} value={text} onChange={(e) => setText(e.target.value)} data-autofocus />
          {required && minLength > 1 && <p className="muted small">At least {minLength} characters.</p>}
        </div>
        <FormError error={error} />
      </form>
    </Dialog>
  )
}

function NumberDialog({
  title,
  label,
  noteLabel,
  noteRequired = false,
  confirm,
  busy,
  error,
  onClose,
  onSubmit,
  children,
}: {
  title: string
  label: string
  noteLabel: string
  noteRequired?: boolean
  confirm: string
  busy: boolean
  error: unknown
  onClose: () => void
  onSubmit: (kg: number, note: string, confirmCode?: string) => void
  children?: ReactNode
}) {
  const id = useId()
  const [kg, setKg] = useState('')
  const [note, setNote] = useState('')
  const n = Number(kg)
  const ok = kg !== '' && n > 0 && Math.round(n * 100) === n * 100 && (!noteRequired || note.trim().length >= 5)
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={id} className="btn btn-primary" disabled={busy || !ok}>
            {busy ? 'Saving…' : confirm}
          </button>
        </>
      }
    >
      <form
        id={id}
        onSubmit={(e) => {
          e.preventDefault()
          if (ok) onSubmit(n, note.trim())
        }}
      >
        {children}
        <div className="field">
          <label htmlFor={`${id}-kg`}>{label}</label>
          <input id={`${id}-kg`} type="number" min={0.01} step={0.01} inputMode="decimal" value={kg} onChange={(e) => setKg(e.target.value)} data-autofocus />
        </div>
        <div className="field">
          <label htmlFor={`${id}-note`}>{noteLabel}</label>
          <textarea id={`${id}-note`} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
          {noteRequired && <p className="muted small">At least 5 characters.</p>}
        </div>
        <FormError error={error} />
      </form>
    </Dialog>
  )
}

function RoomsDialog({
  b,
  busy,
  error,
  onClose,
  onSave,
}: {
  b: Booking
  busy: boolean
  error: unknown
  onClose: () => void
  onSave: (a: { roomId: string; fromDate: string; toDate: string; guests: number; extraBeds?: number }[]) => void
}) {
  const id = useId()
  const rooms = useQuery({ queryKey: ['farm-rooms'], queryFn: farm.roomList })
  // A room is given for nights: "to" is the morning after the last night (a day visit gets one night).
  const nightEnd = b.guests.departureDate > b.guests.arrivalDate ? b.guests.departureDate : nextDay(b.guests.arrivalDate)
  const [rows, setRows] = useState<Record<string, { on: boolean; guests: string; extraBeds: string; from: string; to: string }>>({})
  useEffect(() => {
    if (!rooms.data) return
    const start: typeof rows = {}
    for (const r of rooms.data) {
      const have = b.hospitality.rooms.find((x) => x.roomId === r.id)
      start[r.id] = {
        on: Boolean(have),
        guests: String(have?.guests ?? r.sleeps),
        extraBeds: String(have?.extraBeds ?? 0),
        from: have?.fromDate ?? b.guests.arrivalDate,
        to: have?.toDate ?? nightEnd,
      }
    }
    setRows(start)
  }, [rooms.data, b, nightEnd])
  const chosen = Object.entries(rows).filter(([, r]) => r.on)
  const beds = chosen.reduce((s, [, r]) => s + (Number(r.guests) || 0), 0)
  return (
    <Dialog
      title="Assign rooms"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() =>
              onSave(chosen.map(([roomId, r]) => ({ roomId, fromDate: r.from, toDate: r.to, guests: Number(r.guests) || 0, extraBeds: Number(r.extraBeds) || 0 })))
            }
          >
            {busy ? 'Saving…' : 'Save rooms'}
          </button>
        </>
      }
    >
      <p>
        {b.guests.overnight} people stay overnight. Rooms chosen sleep {beds}. A room already used by another booking on the same nights is refused. The last night is the day before "to".
      </p>
      {rooms.isPending ? (
        <Spinner />
      ) : rooms.isError ? (
        <QueryError error={rooms.error} />
      ) : !rooms.data.length ? (
        <p>
          No rooms yet. Add them on <Link to="/farm/rooms">Rooms</Link>.
        </p>
      ) : (
        <ul className="plain-list">
          {rooms.data
            .filter((r) => r.active)
            .map((r) => {
              const v = rows[r.id]
              if (!v) return null
              const set = (patch: Partial<typeof v>) => setRows((x) => ({ ...x, [r.id]: { ...v, ...patch } }))
              return (
                <li key={r.id} className="farm-room-row">
                  <label className="check">
                    <input type="checkbox" checked={v.on} disabled={r.maintenance} onChange={(e) => set({ on: e.target.checked })} /> {r.name} (sleeps {r.sleeps}
                    {r.extraBeds ? ` + ${r.extraBeds} extra` : ''}){r.maintenance && ' · under maintenance'}
                  </label>
                  {v.on && (
                    <div className="field-row">
                      <div className="field mb-0">
                        <label htmlFor={`${id}-${r.id}-g`}>Guests</label>
                        <input id={`${id}-${r.id}-g`} type="number" min={0} value={v.guests} onChange={(e) => set({ guests: e.target.value })} />
                      </div>
                      <div className="field mb-0">
                        <label htmlFor={`${id}-${r.id}-x`}>Extra beds</label>
                        <input id={`${id}-${r.id}-x`} type="number" min={0} value={v.extraBeds} onChange={(e) => set({ extraBeds: e.target.value })} />
                      </div>
                      <div className="field mb-0">
                        <label htmlFor={`${id}-${r.id}-f`}>From</label>
                        <input id={`${id}-${r.id}-f`} type="date" value={v.from} onChange={(e) => set({ from: e.target.value })} />
                      </div>
                      <div className="field mb-0">
                        <label htmlFor={`${id}-${r.id}-t`}>To</label>
                        <input id={`${id}-${r.id}-t`} type="date" value={v.to} onChange={(e) => set({ to: e.target.value })} />
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
        </ul>
      )}
      <FormError error={error} />
    </Dialog>
  )
}

function HarvestDialog({
  b,
  busy,
  error,
  onClose,
  onSave,
}: {
  b: Booking
  busy: boolean
  error: unknown
  onClose: () => void
  onSave: (body: { harvestedKg?: number; acceptedKg?: number; inspectionNote?: string; harvestStatus?: string; packingStatus?: string }) => void
}) {
  const id = useId()
  const [harvested, setHarvested] = useState(b.harvest.harvestedKg != null ? String(b.harvest.harvestedKg) : '')
  const [accepted, setAccepted] = useState(b.harvest.acceptedKg != null ? String(b.harvest.acceptedKg) : '')
  const [note, setNote] = useState(b.harvest.inspectionNote ?? '')
  const [hs, setHs] = useState(b.harvest.status)
  const [ps, setPs] = useState(b.harvest.packingStatus)
  return (
    <Dialog
      title="Harvest, weighing and packing"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() =>
              onSave({
                ...(harvested !== '' && { harvestedKg: Number(harvested) }),
                ...(accepted !== '' && { acceptedKg: Number(accepted) }),
                ...(note.trim() && { inspectionNote: note.trim() }),
                harvestStatus: hs,
                packingStatus: ps,
              })
            }
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <p>Paid for: {b.paidKg} kg. Record the weights after weighing with the customer.</p>
      <div className="field-row">
        <div className="field">
          <label htmlFor={`${id}-h`}>Harvested kg</label>
          <input id={`${id}-h`} type="number" min={0} step={0.01} value={harvested} onChange={(e) => setHarvested(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-a`}>Accepted kg (after inspection)</label>
          <input id={`${id}-a`} type="number" min={0} step={0.01} value={accepted} onChange={(e) => setAccepted(e.target.value)} />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor={`${id}-hs`}>Harvest</label>
          <select id={`${id}-hs`} value={hs} onChange={(e) => setHs(e.target.value)}>
            <option value="NOT_STARTED">Not started</option>
            <option value="IN_PROGRESS">In progress</option>
            <option value="DONE">Done</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-ps`}>Packing</label>
          <select id={`${id}-ps`} value={ps} onChange={(e) => setPs(e.target.value)}>
            <option value="NOT_STARTED">Not started</option>
            <option value="IN_PROGRESS">In progress</option>
            <option value="PACKED">Packed</option>
            <option value="COLLECTED">Collected by the customer</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor={`${id}-n`}>Inspection note</label>
        <textarea id={`${id}-n`} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <FormError error={error} />
    </Dialog>
  )
}

function MoveDialog({
  b,
  busy,
  error,
  onClose,
  onSave,
}: {
  b: Booking
  busy: boolean
  error: unknown
  onClose: () => void
  onSave: (date: string, reason: string, outsideWindow: boolean) => void
}) {
  const id = useId()
  const [day, setDay] = useState(b.request?.kind === 'MOVE' && b.request.date ? b.request.date : '')
  const [reason, setReason] = useState(b.request?.kind === 'MOVE' ? 'The customer asked to move the visit.' : '')
  const [outside, setOutside] = useState(false)
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(day) && reason.trim().length >= 5
  return (
    <Dialog
      title="Move the visit"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !ok} onClick={() => onSave(day, reason.trim(), outside)}>
            {busy ? 'Moving…' : 'Move visit'}
          </button>
        </>
      }
    >
      <p>
        The new date must be open with {b.kg} kg of {b.variety.name} bookable; those kg are held there before the old day's are released. The stay goes back to "to arrange" and rooms are cleared.
      </p>
      <div className="field">
        <label htmlFor={`${id}-d`}>New visit date</label>
        <input id={`${id}-d`} type="date" value={day} onChange={(e) => setDay(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-r`}>Reason (kept in the history)</label>
        <textarea id={`${id}-r`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <label className="check">
        <input type="checkbox" checked={outside} onChange={(e) => setOutside(e.target.checked)} /> Allow a date outside the customer booking window
      </label>
      <FormError error={error} />
    </Dialog>
  )
}

function CancelDialog({
  b,
  busy,
  error,
  onClose,
  onSave,
}: {
  b: Booking
  busy: boolean
  error: unknown
  onClose: () => void
  onSave: (body: { reason: string; refund: boolean; kind: 'CANCELLED' | 'NOT_HOSTED' }) => void
}) {
  const id = useId()
  const paid = b.money.paid - b.money.refunded
  const [reason, setReason] = useState(b.request?.kind === 'CANCEL' ? 'The customer asked to cancel.' : '')
  const [refund, setRefund] = useState(paid > 0)
  const [kind, setKind] = useState<'CANCELLED' | 'NOT_HOSTED'>('CANCELLED')
  const ok = reason.trim().length >= 5
  return (
    <Dialog
      title="Cancel the booking"
      tone="danger"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} data-autofocus>
            Keep the booking
          </button>
          <button type="button" className="btn btn-danger" disabled={busy || !ok} onClick={() => onSave({ reason: reason.trim(), refund: refund && paid > 0, kind })}>
            {busy ? 'Cancelling…' : refund && paid > 0 ? `Cancel and refund ${rupees(paid)}` : 'Cancel booking'}
          </button>
        </>
      }
    >
      <p>The held kg go back on sale and the customer is told.</p>
      {paid > 0 && (
        <>
          <label className="check">
            <input type="checkbox" checked={refund} onChange={(e) => setRefund(e.target.checked)} /> Refund {rupees(paid)} in full to the customer's payment (you will be asked to confirm it's you)
          </label>
          <div className="field">
            <label htmlFor={`${id}-k`}>Why</label>
            <select id={`${id}-k`} value={kind} onChange={(e) => setKind(e.target.value as 'CANCELLED' | 'NOT_HOSTED')}>
              <option value="CANCELLED">Cancelled (customer or team)</option>
              <option value="NOT_HOSTED">We can't host them as agreed</option>
            </select>
          </div>
        </>
      )}
      <div className="field">
        <label htmlFor={`${id}-r`}>Reason (kept in the history)</label>
        <textarea id={`${id}-r`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        <p className="muted small">At least 5 characters.</p>
      </div>
      <FormError error={error} />
    </Dialog>
  )
}

function MealPlan({ b, onSave, busy }: { b: Booking; onSave: (plan: MealDay[]) => void; busy: boolean }) {
  const [edit, setEdit] = useState<MealDay[] | null>(null)
  const plan = edit ?? b.hospitality.mealPlan
  if (!plan.length && !edit) return <p className="muted small">The meal plan is made when the stay is approved.</p>
  const meals = ['breakfast', 'lunch', 'dinner', 'refreshments'] as const
  return (
    <>
      <div {...scrollRegion('Meal plan')}>
        <table className="pn-table">
          <caption className="muted small">Meal plan (people per meal)</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              {meals.map((m) => (
                <th key={m} scope="col">
                  {m[0].toUpperCase() + m.slice(1)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {plan.map((d, i) => (
              <tr key={d.date}>
                <th scope="row">{date(d.date)}</th>
                {meals.map((m) => (
                  <td key={m}>
                    {edit ? (
                      <input
                        type="number"
                        min={0}
                        aria-label={`${m} on ${date(d.date)}`}
                        value={d[m]}
                        onChange={(e) => setEdit(plan.map((x, j) => (j === i ? { ...x, [m]: Math.max(0, Math.floor(Number(e.target.value) || 0)) } : x)))}
                        className="input-narrow"
                      />
                    ) : (
                      d[m]
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="farm-actions mt-2">
        {edit ? (
          <>
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={busy}
              onClick={() => {
                onSave(edit)
                setEdit(null)
              }}
            >
              Save meal plan
            </button>
            <button type="button" className="btn btn-small" onClick={() => setEdit(null)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-small" onClick={() => setEdit(b.hospitality.mealPlan)}>
            Edit meal plan
          </button>
        )}
      </div>
    </>
  )
}

function Notes({ b }: { b: Booking }) {
  const id = useId()
  const queryClient = useQueryClient()
  const [body, setBody] = useState('')
  const add = useMutation({
    mutationFn: () => farm.note(b.id, body.trim()),
    onSuccess: (next) => {
      queryClient.setQueryData(['farm-booking', b.id], next)
      setBody('')
    },
  })
  return (
    <section className="card">
      <h2>Internal notes</h2>
      <p className="muted small">Staff only. Customers never see these.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (body.trim()) add.mutate()
        }}
      >
        <div className="field">
          <label htmlFor={`${id}-note`}>Add a note</label>
          <textarea id={`${id}-note`} rows={2} maxLength={3000} value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
        <button type="submit" className="btn btn-small" disabled={add.isPending || !body.trim()}>
          {add.isPending ? 'Saving…' : 'Add note'}
        </button>
        <FormError error={add.error} />
      </form>
      <ul className="plain-list mt-2">
        {b.notes.map((n) => (
          <li key={n.id}>
            {n.body}
            <div className="muted small">
              {dateTime(n.at)} · {n.author}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
