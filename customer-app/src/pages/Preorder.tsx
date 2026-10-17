// Booking ahead: a box for a delivery week before the fruit is in, at today's
// price, paid in full by a Razorpay payment link. We pick the day in that week
// once the fruit is in, and the booking becomes a normal order.
import { useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api, errorMessage, type Preorder, type PreorderStatus, type PreorderWeek, type Stage } from '../api'
import { PREORDER_LABEL, STAGE_HINT, STAGE_LABEL, rupees, week, when } from '../format'
import { useStore } from '../store'
import { Dialog, ErrorNote, Spinner } from '../ui'
import { AddPhoneCard } from '../auth-ui'

const STAGES: Stage[] = ['RAW', 'SEMI_RIPE', 'RIPE']

function loadAddress() {
  try {
    return JSON.parse(localStorage.getItem('mm.address') ?? '{}') as { name?: string; address?: string }
  } catch {
    return {}
  }
}

/** The dev API hands out fake payment links; those are paid with test buttons instead. */
const isDevLink = (url: string | null) => Boolean(url?.includes('plink_dev_'))

/** Shop home: shown while any week is open for booking. */
export function BookAheadCard() {
  const q = useQuery({ queryKey: ['preorder-weeks'], queryFn: api.preorderWeeks, staleTime: 60_000 })
  const weeks = [...new Set(q.data?.weeks.map((w) => w.weekStart) ?? [])]
  if (!weeks.length) return null
  return (
    <section className="card book-ahead" aria-labelledby="book-ahead">
      <h2 id="book-ahead">Book ahead</h2>
      <p>
        Lock in today's price for the week of {week(weeks[0])}
        {weeks.length > 1 && ' or later'}. We pick your delivery day that week once the fruit is in.
      </p>
      <Link to="/preorder" className="btn btn-primary">
        Book a box ahead
      </Link>
    </section>
  )
}

export default function BookAhead() {
  const { profile } = useStore()
  const q = useQuery({ queryKey: ['preorder-weeks'], queryFn: api.preorderWeeks })
  if (profile && !profile.phone) return <AddPhoneCard />
  if (q.isPending) return <Spinner label="Loading open weeks" />
  if (q.isError) return <ErrorNote error={q.error} onRetry={() => q.refetch()} />
  if (!q.data.weeks.length) {
    return (
      <section className="card empty">
        <h1>No weeks open for booking</h1>
        <p>Booking ahead opens when we know how much fruit is coming. Order for the next few days in the shop.</p>
        <Link to="/" className="btn btn-primary">
          Shop mangoes
        </Link>
      </section>
    )
  }
  return <BookForm weeks={q.data.weeks} cancelPolicy={q.data.cancelPolicy} onStale={() => void q.refetch()} />
}

function BookForm({ weeks, cancelPolicy, onStale }: { weeks: PreorderWeek[]; cancelPolicy: string; onStale: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { pincode: shopPincode } = useStore()
  const saved = useRef(loadAddress())
  const starts = useMemo(() => [...new Set(weeks.map((w) => w.weekStart))], [weeks])
  const [weekStart, setWeekStart] = useState(starts[0])
  const inWeek = weeks.filter((w) => w.weekStart === weekStart)
  const [sku, setSku] = useState(inWeek[0]?.sku ?? '')
  const pick = inWeek.find((w) => w.sku === sku) ?? inWeek[0]
  const [stage, setStage] = useState<Stage>('SEMI_RIPE')
  const [qty, setQty] = useState(1)
  const [name, setName] = useState(saved.current.name ?? '')
  const [address, setAddress] = useState(saved.current.address ?? '')
  const [pincode, setPincode] = useState(shopPincode ?? '')
  const [formError, setFormError] = useState<string | null>(null)
  const idemKey = useRef(crypto.randomUUID())

  const waitlist = pick.remaining === 0
  const max = waitlist ? 20 : Math.min(20, pick.remaining)
  const boxes = Math.min(qty, max)

  const book = useMutation({
    mutationFn: () =>
      api.bookPreorder(
        { sku: pick.sku, stage, qty: boxes, weekStart, pincode, address: address.trim(), name: name.trim() || undefined, waitlist },
        idemKey.current,
      ),
    onSuccess: (p) => {
      try {
        localStorage.setItem('mm.address', JSON.stringify({ name: name.trim(), address: address.trim() }))
      } catch {
        // ignore
      }
      void queryClient.invalidateQueries({ queryKey: ['preorders'] })
      void queryClient.invalidateQueries({ queryKey: ['preorder-weeks'] })
      queryClient.setQueryData(['preorder', p.id], p)
      // Razorpay brings the customer back to the booking page after paying.
      if (p.paymentUrl && !isDevLink(p.paymentUrl)) window.location.assign(p.paymentUrl)
      else navigate(`/preorders/${p.id}`)
    },
    onError: (err) => {
      // The week filled (or changed) while the form was open: show the new numbers.
      if (err instanceof ApiError && ['PREORDER_FULL', 'INVALID_WEEK'].includes(err.code)) {
        idemKey.current = crypto.randomUUID()
        onStale()
      }
    },
  })

  function choose(next: { weekStart?: string; sku?: string }) {
    if (next.weekStart) {
      setWeekStart(next.weekStart)
      const list = weeks.filter((w) => w.weekStart === next.weekStart)
      if (!list.some((w) => w.sku === sku)) setSku(list[0].sku)
    }
    if (next.sku) setSku(next.sku)
    idemKey.current = crypto.randomUUID()
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!/^\d{6}$/.test(pincode)) return setFormError('Enter your 6-digit pincode.')
    if (address.trim().length < 10) return setFormError('Enter the full delivery address, with house number and landmark.')
    book.mutate()
  }

  return (
    <section className="card">
      <h1>Book ahead</h1>
      <p className="muted">Pay today's price now. We pick your delivery day in that week once the fruit is in, and message you.</p>
      <form onSubmit={submit} noValidate>
        <fieldset className="field">
          <legend>Delivery week</legend>
          <div className="chips" role="radiogroup" aria-label="Delivery week">
            {starts.map((w) => (
              <button key={w} type="button" role="radio" aria-checked={w === weekStart} className="chip" onClick={() => choose({ weekStart: w })}>
                {week(w)}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="field">
          <legend>Mango</legend>
          <div className="options">
            {inWeek.map((w) => (
              <label key={w.sku} className="option">
                <input type="radio" name="sku" value={w.sku} checked={w.sku === pick.sku} onChange={() => choose({ sku: w.sku })} />
                <span className="option-text">
                  <span>
                    <strong>{w.name}</strong> · {rupees(w.price)}
                  </span>
                  <span className="muted small">
                    {w.boxSize}
                    {' · '}
                    {w.remaining === 0 ? <span className="sold-out">Fully booked, join the waitlist</span> : w.remaining <= 10 ? <span className="low">{w.remaining} left</span> : 'Open'}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="field">
          <legend>Ripeness on arrival</legend>
          <div className="options">
            {STAGES.map((s) => (
              <label key={s} className="option">
                <input type="radio" name="stage" value={s} checked={s === stage} onChange={() => setStage(s)} />
                <span className="option-text">
                  <strong>{STAGE_LABEL[s]}</strong>
                  <span className="muted small">{STAGE_HINT[s]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="field">
          <span className="label" id="qty-label">
            Boxes
          </span>
          <div className="stepper" role="group" aria-labelledby="qty-label">
            <button type="button" onClick={() => setQty(Math.max(1, boxes - 1))} disabled={boxes <= 1} aria-label="One box less">
              −
            </button>
            <span aria-live="polite">{boxes}</span>
            <button type="button" onClick={() => setQty(Math.min(max, boxes + 1))} disabled={boxes >= max} aria-label="One box more">
              +
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="pre-name">Your name</label>
          <input id="pre-name" autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pre-address">Delivery address</label>
          <textarea id="pre-address" autoComplete="street-address" rows={3} maxLength={500} value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pre-pincode">Pincode</label>
          <input
            id="pre-pincode"
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={6}
            value={pincode}
            onChange={(e) => setPincode(e.target.value.replace(/\D/g, ''))}
          />
        </div>

        <div className="total-row">
          <span>
            {boxes} × {pick.name}
          </span>
          <strong>{rupees(pick.price * boxes)}</strong>
        </div>
        {waitlist ? (
          <p className="muted small">This week is fully booked. Join the waitlist and we'll send you a payment link if a box frees up. Nothing is charged now.</p>
        ) : (
          <p className="muted small">{cancelPolicy}</p>
        )}
        {(formError || book.error) && (
          <p className="field-error" role="alert">
            {formError ?? errorMessage(book.error)}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={book.isPending}>
          {book.isPending ? 'Booking…' : waitlist ? 'Join the waitlist' : `Book and pay ${rupees(pick.price * boxes)}`}
        </button>
      </form>
    </section>
  )
}

const TONE: Partial<Record<PreorderStatus, string>> = { PAYMENT_PENDING: 'warn', BOOKED: 'good', WAITLISTED: 'warn', CANCELLED: 'muted' }
export function PreorderPill({ status }: { status: PreorderStatus }) {
  return <span className={`pill pill-${TONE[status] ?? 'info'}`}>{PREORDER_LABEL[status]}</span>
}

export function PreorderPage() {
  const { id = '' } = useParams()
  const q = useQuery({
    queryKey: ['preorder', id],
    queryFn: () => api.preorder(id),
    // Waiting on the payment webhook: check often.
    refetchInterval: (query) => (query.state.data?.status === 'PAYMENT_PENDING' ? 3000 : false),
  })
  if (q.isPending) return <Spinner label="Loading your booking" />
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404) {
      return (
        <section className="card">
          <h1>Booking not found</h1>
          <Link to="/orders">See my orders</Link>
        </section>
      )
    }
    return <ErrorNote error={q.error} onRetry={() => q.refetch()} />
  }
  return <PreorderView pre={q.data} />
}

function PreorderView({ pre }: { pre: Preorder }) {
  const queryClient = useQueryClient()
  const [cancelling, setCancelling] = useState(false)
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['preorder', pre.id] })
    void queryClient.invalidateQueries({ queryKey: ['preorders'] })
    void queryClient.invalidateQueries({ queryKey: ['orders'] })
  }
  const devPay = useMutation({ mutationFn: (outcome: 'captured' | 'failed') => api.devPayPreorder(pre.id, outcome), onSettled: refresh })
  const cancel = useMutation({
    mutationFn: () => api.cancelPreorder(pre.id),
    onSuccess: () => {
      setCancelling(false)
      refresh()
    },
  })
  const paid = pre.paymentStatus === 'SUCCEEDED' || pre.paymentStatus === 'REFUNDED'
  const holdOpen = pre.holdExpiresAt ? new Date(pre.holdExpiresAt).getTime() > Date.now() : false

  return (
    <>
      <div className="title-row">
        <h1>Booking {pre.number}</h1>
        <PreorderPill status={pre.status} />
      </div>

      {pre.status === 'PAYMENT_PENDING' && (
        <section className="card note-card" aria-live="polite">
          <p>
            <strong>Pay to confirm your booking.</strong>
            {pre.holdExpiresAt && holdOpen && <> Your boxes are held until {when(pre.holdExpiresAt)}.</>} This page updates on its own once you've paid.
          </p>
          {pre.paymentUrl && !isDevLink(pre.paymentUrl) && (
            <a className="btn btn-primary" href={pre.paymentUrl}>
              Pay {rupees(pre.total)}
            </a>
          )}
          {import.meta.env.DEV && isDevLink(pre.paymentUrl) && (
            <div className="dev-pay">
              <p className="small muted">Test mode: Razorpay isn't set up, so choose how the payment ends.</p>
              <div className="row">
                <button type="button" className="btn btn-primary" disabled={devPay.isPending} onClick={() => devPay.mutate('captured')}>
                  Payment succeeds
                </button>
                <button type="button" className="btn" disabled={devPay.isPending} onClick={() => devPay.mutate('failed')}>
                  Payment fails
                </button>
              </div>
            </div>
          )}
          <ErrorNote error={devPay.error} />
        </section>
      )}

      {pre.status === 'BOOKED' && (
        <section className="card note-card">
          <p>
            <strong>You're booked for the week of {week(pre.weekStart)}.</strong> Once the fruit is in we'll pick your delivery day and message you.
          </p>
        </section>
      )}

      {pre.status === 'WAITLISTED' && (
        <section className="card note-card">
          <p>
            <strong>You're on the waitlist.</strong> If a box frees up for the week of {week(pre.weekStart)}, we'll message you a payment link. Nothing has
            been charged.
          </p>
        </section>
      )}

      {pre.status === 'CONVERTED' && pre.orderId && (
        <section className="card note-card">
          <p>
            <strong>Your delivery day is set.</strong> Your booking is now a regular order.
          </p>
          <Link to={`/orders/${pre.orderId}`} className="btn btn-primary">
            See the order
          </Link>
        </section>
      )}

      {pre.status === 'CANCELLED' && (
        <section className="card note-card">
          <p>
            <strong>This booking was cancelled.</strong>{' '}
            {pre.refund?.refundedAt
              ? `Your refund of ${rupees(pre.total)} has been sent. Banks take up to 5 to 7 days to show it.`
              : pre.refund
                ? `Your full refund of ${rupees(pre.total)} is on its way.`
                : 'Nothing was charged.'}
          </p>
        </section>
      )}

      <section className="card">
        <dl className="facts">
          <div>
            <dt>Week</dt>
            <dd>{week(pre.weekStart)}</dd>
          </div>
          <div>
            <dt>To</dt>
            <dd>
              {pre.address ?? '—'}, {pre.pincode}
            </dd>
          </div>
        </dl>
        <ul className="lines">
          <li className="line">
            <div>
              <strong>
                {pre.qty} × {pre.productName}
              </strong>
              <span className="muted small">{STAGE_LABEL[pre.stage]} on arrival</span>
            </div>
            <strong className="line-price">{rupees(pre.total)}</strong>
          </li>
        </ul>
        <div className="total-row">
          <span>{paid ? 'Paid' : 'Total'}</span>
          <strong>{rupees(pre.total)}</strong>
        </div>
      </section>

      {['PAYMENT_PENDING', 'BOOKED', 'WAITLISTED'].includes(pre.status) && (
        <button type="button" className="btn btn-block btn-danger-quiet" onClick={() => setCancelling(true)}>
          Cancel booking
        </button>
      )}

      <Link to="/orders" className="btn btn-block btn-quiet">
        All my orders
      </Link>

      {cancelling && (
        <Dialog
          title={`Cancel booking ${pre.number}?`}
          onClose={() => setCancelling(false)}
          footer={
            <>
              <button type="button" className="btn" data-autofocus onClick={() => setCancelling(false)}>
                Keep booking
              </button>
              <button type="button" className="btn btn-danger" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
                {cancel.isPending ? 'Cancelling…' : 'Cancel booking'}
              </button>
            </>
          }
        >
          <p>{paid ? `You'll get a full refund of ${rupees(pre.total)} to the way you paid.` : 'Nothing has been charged for this booking.'}</p>
          {cancel.error && <p className="field-error">{errorMessage(cancel.error)}</p>}
        </Dialog>
      )}
    </>
  )
}
