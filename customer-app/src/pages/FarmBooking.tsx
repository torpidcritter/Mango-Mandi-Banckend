// My farm visits (FARM_EXPERIENCE): the list, and one booking as its itinerary: the check-in
// QR, the stay and meals the farm team planned, the bill after picking (paid here online, or at
// the farm), and cancel or change of date by the rules the API sends (canCancel, canMove, canPay).
// Nothing is paid at booking. The API decides every outcome.
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, signedInPhone, type FarmBooking, type FarmStatus } from '../api'
import { clock, day, rupees, when } from '../format'
import { DayChips, Field } from '../forms'
import { openRazorpay } from '../payment'
import { ConfirmDialog, DocTitle, ErrorNote, PageHeader, Spinner } from '../ui'
import { useT, type T } from '../i18n'
import type { Key } from '../i18n-core.ts'
import { mealsText } from './Farm'

const TONE: Record<FarmStatus, string> = {
  HOSPITALITY_REVIEW: 'info',
  CONFIRMED: 'good',
  PREPARING: 'good',
  READY_FOR_VISIT: 'good',
  CHECKED_IN: 'info',
  HARVESTING: 'info',
  WEIGHING: 'info',
  PAYMENT_DUE: 'warn',
  PACKING: 'info',
  COMPLETED: 'good',
  CANCELLED: 'muted',
  NO_SHOW: 'muted',
}
const statusKey = (s: FarmStatus) => `farm.status.${s}` as Key
const english = (t: T) => (t.lang === 'en' ? undefined : 'en')

function StatusPill({ status }: { status: FarmStatus }) {
  const t = useT()
  return <span className={`pill pill-${TONE[status]}`}>{t(statusKey(status))}</span>
}

/** /farm-bookings — the customer's farm visits. */
export default function FarmBookings() {
  const t = useT()
  const q = useQuery({ queryKey: ['farm-bookings'], queryFn: () => api.farmBookings() })
  return (
    <>
      <h1>{t('farm.listTitle')}</h1>
      {q.isPending ? (
        <Spinner label={t('farm.loading')} />
      ) : q.isError ? (
        <ErrorNote error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data.length ? (
        <section className="card empty">
          <p>{t('farm.none')}</p>
          <Link to="/farm-experience" className="btn btn-primary">
            {t('farm.aboutVisit')}
          </Link>
        </section>
      ) : (
        <ul className="order-list">
          {q.data.map((b) => (
            <li key={b.id} className="card">
              <Link to={`/farm-bookings/${b.id}`} className="card-link">
                <strong>{b.number}</strong>
              </Link>{' '}
              <StatusPill status={b.status} />
              <p className="small muted">
                {t('farm.listLine', { kg: b.kg, variety: b.variety, day: day(b.visitDate), total: rupees(b.billAmount ?? b.total) })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/** /farm-bookings/:id — one booking. While the bill is due it asks again on its own (a payment may land, or staff record one). */
export function FarmBookingPage() {
  const { id } = useParams()
  const t = useT()
  const q = useQuery({
    queryKey: ['farm-booking', id],
    queryFn: () => api.farmBooking(id!),
    refetchInterval: (query) => {
      const b = query.state.data
      return b && b.status === 'PAYMENT_DUE' ? 5_000 : false
    },
  })
  if (q.isPending) return <Spinner label={t('farm.loading')} />
  if (q.isError) return <ErrorNote error={q.error} onRetry={() => q.refetch()} />
  return <BookingView b={q.data} />
}

function BookingView({ b }: { b: FarmBooking }) {
  const t = useT()
  const en = english(t)
  const queryClient = useQueryClient()
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['farm-booking', b.id] })
    void queryClient.invalidateQueries({ queryKey: ['farm-bookings'] })
  }
  const arrived = useLocation().state as { placed?: boolean } | null
  const devPay = useMutation({ mutationFn: (outcome: 'captured' | 'failed') => api.devPayFarm(b.id, outcome), onSettled: refresh })
  const answer = useMutation({ mutationFn: (accept: boolean) => api.answerFarmArrangement(b.id, accept), onSettled: refresh })

  // "Booked" once, right after the booking form; "Paid" when the bill turns paid while the page is open.
  const [thanks, setThanks] = useState<Key | null>(() => (arrived?.placed && b.status === 'HOSPITALITY_REVIEW' ? 'farm.thanks' : null))
  const was = useRef(b.status)
  const thanksNote = useRef<HTMLElement>(null)
  useEffect(() => {
    if (was.current === 'PAYMENT_DUE' && b.status === 'PACKING') setThanks('farm.paidThanks')
    was.current = b.status
  }, [b.status])
  useEffect(() => {
    if (thanks) thanksNote.current?.focus()
  }, [thanks])
  const f = b.farm
  const g = b.guests

  return (
    <>
      <DocTitle title={t('farm.bookingTitle', { number: b.number })} />
      <p className="small">
        <Link to="/farm-bookings">{t('farm.listTitle')}</Link>
      </p>
      <PageHeader title={t('farm.bookingTitle', { number: b.number })}>
        <StatusPill status={b.status} />
      </PageHeader>

      {thanks && (
        <section className="card note-card thanks-card" ref={thanksNote} tabIndex={-1}>
          <p>
            <strong>{t(thanks)}</strong> {thanks === 'farm.thanks' && t('farm.thanksBody')}
          </p>
        </section>
      )}

      {b.bill && <Bill b={b} onDone={refresh} devPay={(o) => devPay.mutate(o)} devBusy={devPay.isPending} devError={devPay.error} />}

      {b.status === 'HOSPITALITY_REVIEW' && !thanks && b.hospitality.status !== 'ALTERNATIVE_PROPOSED' && <p className="card note-card">{t('farm.reviewing')}</p>}
      {b.status === 'CANCELLED' && <p className="card note-card">{t('farm.cancelledUnpaid')}</p>}
      {b.status === 'NO_SHOW' && <p className="card note-card">{t('farm.noShowNote')}</p>}

      {b.hospitality.status === 'ALTERNATIVE_PROPOSED' && b.hospitality.alternative && (
        <section className="card note-card">
          <h2>{t('farm.altTitle')}</h2>
          <p lang={en}>{b.hospitality.alternative}</p>
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={answer.isPending} onClick={() => answer.mutate(true)}>
              {t('farm.altAccept')}
            </button>
            <button type="button" className="btn" disabled={answer.isPending} onClick={() => answer.mutate(false)}>
              {t('farm.altDecline')}
            </button>
          </div>
          <p className="small muted">{t('farm.altDeclineNote')}</p>
          <ErrorNote error={answer.error} />
        </section>
      )}
      {b.hospitality.status === 'CUSTOMER_DECLINED' && b.status !== 'CANCELLED' && <p className="card note-card">{t('farm.declinedNote')}</p>}

      {b.request && <p className="card note-card">{t(b.request.kind === 'CANCEL' ? 'farm.cancelRequested' : 'farm.moveRequested')}</p>}

      {b.checkinCode && <CheckIn b={b} />}

      <section className="card">
        <h2>{t('farm.itinerary')}</h2>
        <dl className="facts">
          <div>
            <dt>{t('farm.visitDate')}</dt>
            <dd>{day(b.visitDate)}</dd>
          </div>
          <div>
            <dt>{t('farm.stay')}</dt>
            <dd>{g.arrivalDate === g.departureDate ? day(g.arrivalDate) : t('farm.stayText', { from: day(g.arrivalDate), to: day(g.departureDate) })}</dd>
          </div>
          {f.checkInTime && f.checkOutTime && (
            <div>
              <dt>{t('farm.times')}</dt>
              <dd>{t('farm.timesText', { from: clock(f.checkInTime), to: clock(f.checkOutTime) })}</dd>
            </div>
          )}
          <div>
            <dt>{t('farm.group')}</dt>
            <dd>{t('farm.groupText', { adults: g.adults, children: g.children, overnight: g.overnight })}</dd>
          </div>
          <div>
            <dt>{t('farm.variety')}</dt>
            <dd lang={en}>{b.variety.name}</dd>
          </div>
          <div>
            <dt>{t('farm.mangoes')}</dt>
            <dd>{t('farm.kgAt', { kg: b.kg, price: rupees(b.pricePerKg) })}</dd>
          </div>
          {!b.bill && (
            <div>
              <dt>{t('farm.estimate')}</dt>
              <dd>
                <strong className="price">{rupees(b.total)}</strong> · {t('farm.payAfter')}
              </dd>
            </div>
          )}
          <div>
            <dt>{t('farm.meals')}</dt>
            <dd>
              {mealsText(t, f.meals)}
              {f.mealNotes && <span lang={en}> · {f.mealNotes}</span>}
            </dd>
          </div>
          <div>
            <dt>{t('farm.transport')}</dt>
            <dd>
              {f.transportIncluded ? t('farm.inc.transportYes') : t('farm.inc.transportNo')}
              {f.transportPolicy && <span lang={en}> {f.transportPolicy}</span>}
            </dd>
          </div>
        </dl>
      </section>

      {(b.hospitality.rooms.length > 0 || b.hospitality.plan || b.hospitality.mealPlan.length > 0) && (
        <section className="card">
          <h2>{t('farm.yourStay')}</h2>
          {b.hospitality.plan && <p lang={en}>{b.hospitality.plan}</p>}
          {b.hospitality.rooms.length > 0 && (
            <ul className="farm-list">
              {b.hospitality.rooms.map((r) => (
                <li key={`${r.roomId}-${r.fromDate}`}>
                  <span lang={en}>{r.name}</span> · {t('farm.roomLine', { guests: r.guests, from: day(r.fromDate), to: day(r.toDate) })}
                </li>
              ))}
            </ul>
          )}
          {b.hospitality.mealPlan.length > 0 && (
            <table className="farm-meals">
              <caption className="small muted">{t('farm.mealPlan')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('farm.day')}</th>
                  <th scope="col">{t('farm.meal.breakfast')}</th>
                  <th scope="col">{t('farm.meal.lunch')}</th>
                  <th scope="col">{t('farm.meal.dinner')}</th>
                  <th scope="col">{t('farm.meal.refreshments')}</th>
                </tr>
              </thead>
              <tbody>
                {b.hospitality.mealPlan.map((m) => (
                  <tr key={m.date}>
                    <th scope="row">{day(m.date)}</th>
                    <td>{m.breakfast}</td>
                    <td>{m.lunch}</td>
                    <td>{m.dinner}</td>
                    <td>{m.refreshments}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {(f.name || f.location || f.contactPhone || f.arrivalInstructions) && (
        <section className="card">
          <h2>{t('farm.gettingThere')}</h2>
          <dl className="facts" lang={en}>
            {f.name && (
              <div>
                <dt lang={t.lang}>{t('farm.farm')}</dt>
                <dd>{f.name}</dd>
              </div>
            )}
            {f.location && (
              <div>
                <dt lang={t.lang}>{t('farm.where')}</dt>
                <dd>
                  {f.location}
                  {f.mapUrl && (
                    <>
                      {' · '}
                      <a href={f.mapUrl} target="_blank" rel="noreferrer noopener" lang={t.lang}>
                        {t('farm.map')}
                      </a>
                    </>
                  )}
                </dd>
              </div>
            )}
            {f.contactPhone && (
              <div>
                <dt lang={t.lang}>{t('farm.contact')}</dt>
                <dd>
                  <a href={`tel:${f.contactPhone}`}>{f.contactPhone}</a>
                </dd>
              </div>
            )}
            {f.arrivalInstructions && (
              <div>
                <dt lang={t.lang}>{t('farm.arrivalHow')}</dt>
                <dd>{f.arrivalInstructions}</dd>
              </div>
            )}
          </dl>
        </section>
      )}

      <Changes b={b} onDone={refresh} />
    </>
  )
}

function CheckIn({ b }: { b: FarmBooking }) {
  const t = useT()
  const qr = useQuery({ queryKey: ['farm-qr', b.id, b.checkinCode], queryFn: () => api.farmQrUrl(b.id), staleTime: Infinity })
  return (
    <section className="card farm-checkin">
      <h2>{t('farm.qrTitle')}</h2>
      {qr.data ? <img src={qr.data} alt={t('farm.qrAlt')} width={200} height={200} /> : qr.isError ? <ErrorNote error={qr.error} /> : <Spinner label={t('farm.loading')} />}
      <p className="farm-code">{b.checkinCode}</p>
      <p className="small muted">{t('farm.qrHint')}</p>
    </section>
  )
}

/** The bill after weighing: what was accepted, what it costs, and Pay (or that it is paid). */
function Bill({
  b,
  onDone,
  devPay,
  devBusy,
  devError,
}: {
  b: FarmBooking
  onDone: () => void
  devPay: (o: 'captured' | 'failed') => void
  devBusy: boolean
  devError: unknown
}) {
  const t = useT()
  const bill = b.bill!
  const pay = useMutation({
    mutationFn: async () => {
      const r = await api.payFarm(b.id)
      if (r.razorpayKeyId) {
        await openRazorpay({ orderId: b.id, key: r.razorpayKeyId, rzp: r.razorpayOrderId, total: r.amount, number: b.number }, signedInPhone(), api.verifyFarmPayment)
      }
    },
    onSettled: onDone,
  })
  const due = b.payment?.status === 'DUE' ? b.payment : null
  const paid = b.payment?.status === 'PAID' ? b.payment : null
  return (
    <section className={`card${b.canPay ? ' note-card' : ''}`} aria-live="polite">
      <h2>{t('farm.billTitle')}</h2>
      {b.canPay && <p>{t('farm.billDue')}</p>}
      <dl className="facts">
        <div>
          <dt>{t('farm.weighed')}</dt>
          <dd>{t('farm.kgOnly', { kg: bill.acceptedKg })}</dd>
        </div>
        <div>
          <dt>{t('farm.mangoes')}</dt>
          <dd>{t('farm.kgAt', { kg: bill.bookedPartKg, price: rupees(bill.pricePerKg) })}</dd>
        </div>
        {bill.extraKg > 0 && bill.extraPricePerKg != null && (
          <div>
            <dt>{t('farm.billExtra')}</dt>
            <dd>{t('farm.kgAt', { kg: bill.extraKg, price: rupees(bill.extraPricePerKg) })}</dd>
          </div>
        )}
        <div>
          <dt>{t('farm.billTotal')}</dt>
          <dd>
            <strong className="price">{rupees(bill.amount)}</strong>
            {paid && ` · ${t('farm.paidOn', { when: when(paid.paidAt) })}`}
            {b.money.refunded > 0 && ` · ${t('farm.refundedAmount', { amount: rupees(b.money.refunded) })}`}
          </dd>
        </div>
      </dl>
      {due?.failed && <p className="small">{t('farm.payFailed')}</p>}
      {b.canPay && (
        <>
          {b.razorpayKeyId && (
            <button type="button" className="btn btn-primary" disabled={pay.isPending} onClick={() => pay.mutate()}>
              {t('farm.payBill', { amount: rupees(bill.amount) })}
            </button>
          )}
          <p className="small muted">{t('farm.payAtFarm')}</p>
          {import.meta.env.DEV && !b.razorpayKeyId && (
            <div className="dev-pay">
              <p className="small muted">{t('order.devPay')}</p>
              <div className="row">
                <button type="button" className="btn btn-primary" disabled={devBusy} onClick={() => devPay('captured')}>
                  {t('order.devSucceeds')}
                </button>
                <button type="button" className="btn" disabled={devBusy} onClick={() => devPay('failed')}>
                  {t('order.devFails')}
                </button>
              </div>
            </div>
          )}
          <ErrorNote error={pay.error ?? devError} />
        </>
      )}
    </section>
  )
}

function Changes({ b, onDone }: { b: FarmBooking; onDone: () => void }) {
  const t = useT()
  const [cancelling, setCancelling] = useState(false)
  const [reason, setReason] = useState('')
  const [moving, setMoving] = useState(false)
  const [date, setDate] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [done, setDone] = useState<Key | null>(null)
  const cancel = useMutation({
    mutationFn: () => api.cancelFarmBooking(b.id, reason.trim() || undefined),
    onSuccess: (r) => {
      setCancelling(false)
      setDone(r.requested ? 'farm.cancelRequested' : null)
      onDone()
    },
  })
  const dates = useQuery({ queryKey: ['farm-dates', b.variety.id, b.kg], queryFn: () => api.farmDates(b.variety.id, b.kg), enabled: moving })
  const move = useMutation({
    mutationFn: () => api.moveFarmBooking(b.id, date!, note.trim() || undefined),
    onSuccess: (r) => {
      setMoving(false)
      setDone(r.requested ? 'farm.moveRequested' : 'farm.moved')
      onDone()
    },
  })
  if (!b.canCancel && !b.canMove && !done) return null
  const days = (dates.data?.dates ?? []).map((x) => x.date).filter((x) => x !== b.visitDate)
  return (
    <section className="card">
      <h2>{t('farm.changesTitle')}</h2>
      {done && (
        <p className="note-card" role="status">
          {t(done)}
        </p>
      )}
      <p className="small muted">
        {t('farm.cancelRule', { days: b.policy.cancelDays })} {t('farm.moveRule', { days: b.policy.rescheduleDays })}
      </p>
      {b.canMove && !b.request && (
        <>
          {!moving ? (
            <button type="button" className="btn" onClick={() => setMoving(true)}>
              {t('farm.moveTitle')}
            </button>
          ) : (
            <div className="farm-move">
              {dates.isPending ? (
                <Spinner label={t('farm.loadingDates')} />
              ) : dates.isError ? (
                <ErrorNote error={dates.error} onRetry={() => dates.refetch()} />
              ) : !days.length ? (
                <p>{t('farm.noDates', { kg: b.kg })}</p>
              ) : (
                <DayChips label={t('farm.pickDate')} days={days} value={date} onChange={setDate} format={day} />
              )}
              {b.canMove === 'REQUEST' && (
                <Field id="farm-move-note" label={t('farm.reason')}>
                  <textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
              )}
              <div className="row">
                <button type="button" className="btn btn-primary" disabled={!date || move.isPending} onClick={() => move.mutate()}>
                  {b.canMove === 'MOVE' ? t('farm.moveBtn') : t('farm.moveRequestBtn')}
                </button>
                <button type="button" className="btn" onClick={() => setMoving(false)}>
                  {t('farm.back')}
                </button>
              </div>
              <ErrorNote error={move.error} />
            </div>
          )}
        </>
      )}
      {b.canCancel && !(b.canCancel === 'REQUEST' && b.request) && (
        <button type="button" className="btn btn-danger-quiet" onClick={() => setCancelling(true)}>
          {b.canCancel === 'REQUEST' ? t('farm.cancelRequestBtn') : t('farm.cancel')}
        </button>
      )}
      {cancelling && (
        <ConfirmDialog
          title={t('farm.cancelTitle')}
          keepLabel={t('farm.keep')}
          confirmLabel={b.canCancel === 'REQUEST' ? t('farm.cancelRequestBtn') : t('farm.cancel')}
          busyLabel={t('farm.cancelBusy')}
          busy={cancel.isPending}
          error={cancel.error}
          onConfirm={() => cancel.mutate()}
          onClose={() => setCancelling(false)}
        >
          <p>{b.canCancel === 'CANCEL' ? t('farm.cancelUnpaid') : t('farm.cancelReview')}</p>
          <Field id="farm-cancel-reason" label={t('farm.reason')}>
            <textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </ConfirmDialog>
      )}
    </section>
  )
}
