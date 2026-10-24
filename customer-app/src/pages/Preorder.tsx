// Booking ahead: a box for a delivery week before the fruit is in, at today's
// price, paid in full by a Razorpay payment link. We pick the day in that week
// once the fruit is in, and the booking becomes a normal order.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api, errorMessage, type Preorder, type PreorderStatus, type PreorderWeek, type SavedAddress, type Stage } from '../api'
import { PREORDER_LABEL, STAGE_HINT, STAGE_LABEL, rupees, week, when } from '../format'
import { useStore } from '../store'
import { AddressPicker, DayChips, Field, Stepper } from '../forms'
import { ConfirmDialog, DocTitle, ErrorNote, PageHeader, Spinner } from '../ui'
import { AddPhoneCard } from '../auth-ui'

const STAGES: Stage[] = ['RAW', 'SEMI_RIPE', 'RIPE']

function loadAddress() {
  try {
    return JSON.parse(localStorage.getItem('mm.address') ?? '{}') as { name?: string; address?: string }
  } catch {
    return {}
  }
}

/** What a signed-out visitor filled in, kept for this tab while they sign in, then put back. */
interface Draft {
  weekStart: string
  sku: string
  stage: Stage
  qty: number
  name: string
  address: string
  pincode: string
}
const DRAFT_KEY = 'mm.bookDraft'
function readDraft(): Draft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY)
    return raw ? (JSON.parse(raw) as Draft) : null
  } catch {
    return null
  }
}
function keepDraft(d: Draft) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d))
  } catch {
    // ignore: the form starts empty after sign-in
  }
}

/** The dev API hands out fake payment links; those are paid with test buttons instead. */
const isDevLink = (url: string | null) => Boolean(url?.includes('plink_dev_'))

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
  const { pincode: shopPincode, profile } = useStore()
  const saved = useRef(loadAddress())
  const starts = useMemo(() => [...new Set(weeks.map((w) => w.weekStart))], [weeks])
  // Back from signing in: the visitor's choices, if their week is still open.
  const [d] = useState(() => {
    const draft = readDraft()
    return draft && starts.includes(draft.weekStart) ? draft : null
  })
  // Used once: read during render, removed after.
  useEffect(() => {
    try {
      sessionStorage.removeItem(DRAFT_KEY)
    } catch {
      // ignore
    }
  }, [])
  const [weekStart, setWeekStart] = useState(d?.weekStart ?? starts[0])
  const inWeek = weeks.filter((w) => w.weekStart === weekStart)
  const [sku, setSku] = useState(d && inWeek.some((w) => w.sku === d.sku) ? d.sku : (inWeek[0]?.sku ?? ''))
  const pick = inWeek.find((w) => w.sku === sku) ?? inWeek[0]
  const [stage, setStage] = useState<Stage>(d?.stage ?? 'SEMI_RIPE')
  const [qty, setQty] = useState(d?.qty ?? 1)
  const [name, setName] = useState(d?.name ?? saved.current.name ?? '')
  const [address, setAddress] = useState(d?.address ?? saved.current.address ?? '')
  const [pincode, setPincode] = useState(d?.pincode ?? shopPincode ?? '')
  const [formError, setFormError] = useState<{ at: 'pincode' | 'address'; message: string } | null>(null)

  // The addresses this account ordered to before, as at checkout. Picking one fills in its pincode too.
  const book = useQuery({ queryKey: ['addresses'], queryFn: api.addresses, staleTime: 60_000, enabled: Boolean(profile) })
  const addresses = book.data ?? []
  const [picked, setPicked] = useState<string | null>(null)
  const typedOwn = useRef(Boolean(d))
  const squash = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!typedOwn.current && picked === null && addresses.length) {
    // Start from the address used last time (or the most recent saved one).
    const here = addresses.filter((a) => !/^\d{6}$/.test(pincode) || a.pincode === pincode)
    const match = address.trim() ? here.find((a) => squash(a.address) === squash(address)) : here[0]
    typedOwn.current = true
    if (match) fillFrom(match)
  }
  function fillFrom(a: SavedAddress) {
    setPicked(a.id)
    setAddress(a.address)
    setPincode(a.pincode)
    if (a.name && !name) setName(a.name)
  }
  const chooseAddress = (id: string | null) => {
    typedOwn.current = true
    const a = addresses.find((x) => x.id === id)
    if (a) return fillFrom(a)
    setPicked(null)
    setAddress('')
  }
  // The picker names the pincode, since saved addresses can be in different places.
  const shownAddresses = addresses.map((a) => ({ ...a, address: `${a.address}, ${a.pincode}` }))
  const idemKey = useRef(crypto.randomUUID())

  const waitlist = pick.remaining === 0
  const max = waitlist ? 20 : Math.min(20, pick.remaining)
  const boxes = Math.min(qty, max)

  const bookIt = useMutation({
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
    if (address.trim().length < 10) {
      setFormError({ at: 'address', message: 'Enter the full delivery address, with house number and landmark.' })
      return requestAnimationFrame(() => document.getElementById('pre-address')?.focus())
    }
    if (!/^\d{6}$/.test(pincode)) {
      setFormError({ at: 'pincode', message: 'Enter your 6-digit pincode.' })
      return requestAnimationFrame(() => document.getElementById('pre-pincode')?.focus())
    }
    if (!profile) {
      // Signing in comes only now, when booking: keep what was filled in for the way back.
      keepDraft({ weekStart, sku: pick.sku, stage, qty: boxes, name: name.trim(), address: address.trim(), pincode })
      return navigate(`/sign-in?next=${encodeURIComponent('/preorder')}`)
    }
    bookIt.mutate()
  }

  return (
    <section className="card">
      <h1>Book ahead</h1>
      <p className="muted">Pay today's price now. We pick your delivery day in that week once the fruit is in, and message you.</p>
      <form onSubmit={submit} noValidate>
        <fieldset className="field">
          <legend>Delivery week</legend>
          <DayChips label="Delivery week" days={starts} value={weekStart} format={week} onChange={(w) => choose({ weekStart: w })} />
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
          <Stepper label="Boxes" showLabel value={boxes} min={1} max={max} onChange={setQty} lessLabel="One box less" moreLabel="One box more" />
        </div>

        <Field id="pre-name" label="Your name">
          <input autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <AddressPicker addresses={shownAddresses} value={picked} onChange={chooseAddress} />
        <Field
          id="pre-address"
          label="Delivery address"
          hint="House or flat number, street, area and a landmark."
          error={formError?.at === 'address' ? formError.message : null}
          hidden={picked !== null}
        >
          <textarea
            autoComplete="street-address"
            rows={3}
            maxLength={500}
            value={address}
            onChange={(e) => {
              typedOwn.current = true
              setAddress(e.target.value)
            }}
          />
        </Field>
        <Field id="pre-pincode" label="Pincode" error={formError?.at === 'pincode' ? formError.message : null} hidden={picked !== null}>
          <input inputMode="numeric" autoComplete="postal-code" maxLength={6} value={pincode} onChange={(e) => setPincode(e.target.value.replace(/\D/g, ''))} />
        </Field>

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
        {bookIt.error && (
          <p className="field-error" role="alert">
            {errorMessage(bookIt.error)}
          </p>
        )}
        {bookIt.error instanceof ApiError && bookIt.error.code === 'UNPAID_PREORDER_EXISTS' && typeof bookIt.error.detail.preorderId === 'string' && (
          <Link to={`/preorders/${bookIt.error.detail.preorderId}`} className="btn btn-block">
            Open your unpaid booking
          </Link>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={bookIt.isPending}>
          {!profile
            ? waitlist
              ? 'Sign in to join the waitlist'
              : 'Sign in to book'
            : bookIt.isPending
              ? 'Booking…'
              : waitlist
                ? 'Join the waitlist'
                : `Book and pay ${rupees(pick.price * boxes)}`}
        </button>
        {!profile && <p className="muted small center">You sign in with your mobile number, then come back here to book and pay.</p>}
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
          <DocTitle title="Booking not found" />
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
      <DocTitle title={`Booking ${pre.number}`} />
      <PageHeader title={`Booking ${pre.number}`}>
        <PreorderPill status={pre.status} />
      </PageHeader>

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
                : 'We have no payment for this booking. If money has left your account, a late payment is still matched to this booking, or refunded in full if you cancelled it.'}
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
        <ConfirmDialog
          title={`Cancel booking ${pre.number}?`}
          keepLabel="Keep booking"
          confirmLabel="Cancel booking"
          busyLabel="Cancelling…"
          busy={cancel.isPending}
          error={cancel.error}
          onConfirm={() => cancel.mutate()}
          onClose={() => setCancelling(false)}
        >
          <p>
            {paid
              ? `You'll get a full refund of ${rupees(pre.total)} to the way you paid.`
              : pre.status === 'WAITLISTED'
                ? 'Nothing is charged while you are on the waitlist.'
                : 'No payment has reached us for this booking. If you have just paid, cancelling refunds it in full.'}
          </p>
        </ConfirmDialog>
      )}
    </>
  )
}
