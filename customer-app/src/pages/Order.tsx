import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api, errorMessage, signedInPhone, type Order, type OrderStatus, type Stage } from '../api'
import { CANCELLABLE, STAGE_LABEL, STATUS_LABEL, day, rupees, slotText, when } from '../format'
import { openRazorpay, rememberedPayment } from '../payment'
import { Dialog, ErrorNote, Spinner } from '../ui'
import { CARE, MangoArt } from '../mango'
import { UnlockLine } from '../unlock'
import { useStore } from '../store'

const TONE: Partial<Record<OrderStatus, string>> = {
  PAYMENT_PENDING: 'warn',
  DELIVERED: 'good',
  CANCELLED: 'muted',
  RTO: 'muted',
  DELIVERY_FAILED: 'warn',
}
export function StatusPill({ status }: { status: OrderStatus }) {
  return <span className={`pill pill-${TONE[status] ?? 'info'}`}>{STATUS_LABEL[status]}</span>
}

const STEPS: { label: string; status: OrderStatus; reached: OrderStatus[] }[] = [
  { label: 'Confirmed', status: 'CONFIRMED', reached: ['CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED'] },
  { label: 'Packed', status: 'PACKED', reached: ['PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED'] },
  { label: 'Out for delivery', status: 'OUT_FOR_DELIVERY', reached: ['OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED'] },
  { label: 'Delivered', status: 'DELIVERED', reached: ['DELIVERED'] },
]
/** Orders a customer can still move to another day: confirmed, before packing starts. Mirrors the API. */
const MOVABLE: OrderStatus[] = ['CONFIRMED']
const ISSUE_LABEL = { DAMAGED: 'Damaged or spoilt', WRONG_ITEM: 'Wrong item', NOT_DELIVERED: 'Not delivered' }

export default function OrderPage() {
  const { id = '' } = useParams()
  const q = useQuery({
    queryKey: ['order', id],
    queryFn: () => api.order(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status
      // Waiting on the payment: check often. On the way: notice the delivery.
      return status === 'PAYMENT_PENDING' ? 3000 : status === 'OUT_FOR_DELIVERY' ? 30_000 : false
    },
  })
  if (q.isPending) return <Spinner label="Loading your order" />
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404) {
      return (
        <section className="card">
          <h1>Order not found</h1>
          <Link to="/orders">See my orders</Link>
        </section>
      )
    }
    return <ErrorNote error={q.error} onRetry={() => q.refetch()} />
  }
  return <OrderView order={q.data} />
}

function OrderView({ order }: { order: Order }) {
  const queryClient = useQueryClient()
  const [cancelling, setCancelling] = useState(false)
  const [moving, setMoving] = useState(false)
  const { setQty, setWhere } = useStore()
  const navigate = useNavigate()
  const buyAgain = () => {
    for (const i of order.items) if (i.stage) setQty({ sku: i.sku, stage: i.stage, name: i.name, price: i.unitPrice }, i.quantity)
    setWhere(order.pincode, null)
    navigate('/cart')
  }
  const stages = [...new Set(order.items.map((i) => i.stage).filter((x): x is Stage => Boolean(x)))]
  const claims = useQuery({ queryKey: ['claims'], queryFn: api.claims, enabled: order.status === 'DELIVERED' })
  const claim = claims.data?.find((c) => c.orderId === order.id)
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['order', order.id] })
    void queryClient.invalidateQueries({ queryKey: ['orders'] })
  }
  const remembered = rememberedPayment(order.id)
  const holdOpen = order.holdExpiresAt ? new Date(order.holdExpiresAt).getTime() > Date.now() : false

  const payAgain = useMutation({
    mutationFn: () => openRazorpay({ key: remembered!.key!, rzp: order.razorpayOrderId!, total: order.total, number: order.number, holdExpiresAt: order.holdExpiresAt }, signedInPhone()),
    onSettled: refresh,
  })
  const devPay = useMutation({ mutationFn: (outcome: 'captured' | 'failed') => api.devPay(order.id, outcome), onSettled: refresh })
  const cancel = useMutation({
    mutationFn: () => api.cancel(order.id),
    onSuccess: () => {
      setCancelling(false)
      refresh()
    },
  })
  const paid = order.paymentStatus === 'SUCCEEDED'

  return (
    <>
      <div className="title-row">
        <h1>Order {order.number}</h1>
        <StatusPill status={order.status} />
      </div>

      {order.status === 'PAYMENT_PENDING' && (
        <section className="card note-card" aria-live="polite">
          <p>
            <strong>Waiting for your payment to be confirmed.</strong> This page updates on its own.
            {order.holdExpiresAt && holdOpen && <> Your boxes are held until {when(order.holdExpiresAt)}.</>}
          </p>
          {remembered?.key && order.razorpayOrderId && holdOpen && (
            <button type="button" className="btn btn-primary" disabled={payAgain.isPending} onClick={() => payAgain.mutate()}>
              Pay {rupees(order.total)}
            </button>
          )}
          {import.meta.env.DEV && !remembered?.key && (
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
          <ErrorNote error={payAgain.error ?? devPay.error} />
        </section>
      )}

      {order.status !== 'CANCELLED' && order.status !== 'PAYMENT_PENDING' && order.status !== 'RTO' && <UnlockLine pincode={order.pincode} date={order.deliveryDate} />}
      {order.status === 'CANCELLED' && (
        <section className="card note-card">
          <p>
            <strong>This order was cancelled.</strong>{' '}
            {order.refundStatus === 'REFUNDED'
              ? `Your refund of ${rupees(order.total)} has been sent. Banks take up to 5 to 7 days to show it.`
              : order.refundStatus === 'PENDING'
                ? `Your full refund of ${rupees(order.total)} is on its way.`
                : 'Nothing was charged.'}
          </p>
        </section>
      )}

      {order.status === 'OUT_FOR_DELIVERY' && order.deliveryCode && (
        <section className="card note-card code-card" aria-labelledby="code-title">
          <p id="code-title">
            <strong>Your mangoes are on the way.</strong> Give the rider this code when they arrive:
          </p>
          <p className="delivery-code" aria-label={`Delivery code ${order.deliveryCode.split('').join(' ')}`}>
            {order.deliveryCode}
          </p>
          <p className="muted small">Only share it once you have the boxes in hand.</p>
        </section>
      )}

      {order.status === 'DELIVERED' && order.delivery && (
        <section className="card">
          <h2>Delivered</h2>
          <p>
            {when(order.delivery.at)}
            {order.delivery.method === 'code' && ', handed to you with your code.'}
            {order.delivery.method === 'photo' && `, left with ${order.delivery.receivedBy ?? 'someone at your address'}.`}
            {order.delivery.method !== 'code' && order.delivery.method !== 'photo' && '.'}
          </p>
          {order.delivery.hasPhoto && <DeliveryPhoto orderId={order.id} />}
        </section>
      )}

      {order.status === 'DELIVERY_FAILED' && (
        <section className="card note-card">
          <p>
            <strong>We missed you.</strong> We'll try again on {day(order.deliveryDate)}.
          </p>
        </section>
      )}

      {!['PAYMENT_PENDING', 'CANCELLED', 'RTO'].includes(order.status) && (
        <ol className="steps" aria-label="Progress">
          {STEPS.map((s) => {
            const done = s.reached.includes(order.status)
            // The latest time the order reached this step (a retried delivery goes out more than once).
            const at = done ? order.timeline.filter((e) => e.status === s.status).slice(-1)[0]?.at : undefined
            return (
              <li key={s.label} className={done ? 'done' : ''}>
                <span className="dot" aria-hidden="true" />
                <span>
                  {s.label}
                  <span className="sr-only">{done ? ', done' : ', not yet'}</span>
                </span>
                {at && (
                  // "19 Oct" over "10:27 am", so four steps fit side by side on a phone.
                  <span className="step-time">
                    {when(at)
                      .split(', ')
                      .map((part) => (
                        <span key={part}>{part}</span>
                      ))}
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      )}

      <section className="card">
        <dl className="facts">
          <div>
            <dt>{order.status === 'DELIVERED' ? 'Delivered' : 'Arrives'}</dt>
            <dd>
              {day(order.deliveryDate)}
              {order.slot && `, ${slotText(order.slot)}`}
            </dd>
          </div>
          <div>
            <dt>To</dt>
            <dd>
              {order.gift && (
                <>
                  {order.gift.recipientName} (a gift)
                  <br />
                </>
              )}
              {order.deliveryAddress ?? '—'}, {order.pincode}
            </dd>
          </div>
          {order.gift?.message && (
            <div>
              <dt>Note</dt>
              <dd>{order.gift.message}</dd>
            </div>
          )}
        </dl>
        <ul className="lines">
          {order.items.map((i) => (
            <li key={`${i.sku}-${i.stage}`} className="line">
              <div>
                <strong>
                  {i.quantity} × {i.name}
                </strong>
                {i.stage && (
                  <span className="muted small">
                    {STAGE_LABEL[i.stage]}
                    {i.eatBy && ` · eat by ${day(i.eatBy)}`}
                  </span>
                )}
              </div>
              <strong className="line-price">{rupees(i.linePrice)}</strong>
            </li>
          ))}
        </ul>
        {order.discount > 0 && (
          <div className="sum-row discount">
            <span>Promo {order.promoCode}</span>
            <span>−{rupees(order.discount)}</span>
          </div>
        )}
        <div className="total-row">
          <span>{paid ? 'Paid' : 'Total'}</span>
          <strong>{rupees(order.total)}</strong>
        </div>
      </section>

      {order.status === 'DELIVERED' && <RateOrder order={order} />}

      {!['PAYMENT_PENDING', 'CANCELLED', 'RTO'].includes(order.status) && stages.length > 0 && <CareTips stages={stages} />}

      {order.status === 'DELIVERED' &&
        (claim ? (
          <section className="card">
            <h2>Your report</h2>
            <p>
              {ISSUE_LABEL[claim.issueType]}:{' '}
              {claim.status === 'RESOLVED'
                ? claim.resolution === 'REPLACEMENT_APPROVED'
                  ? 'a free replacement is on its way'
                  : 'we looked into it and could not offer a replacement'
                : 'we are looking into it'}
              .
            </p>
            {claim.replacementOrder && <Link to={`/orders/${claim.replacementOrder.id}`}>See replacement order {claim.replacementOrder.number}</Link>}
          </section>
        ) : (
          <Link to={`/orders/${order.id}/claim`} className="btn btn-block">
            Report a problem with this order
          </Link>
        ))}

      {MOVABLE.includes(order.status) && (
        <button type="button" className="btn btn-block" onClick={() => setMoving(true)}>
          Change delivery day
        </button>
      )}

      {['DELIVERED', 'CANCELLED'].includes(order.status) && (
        <button type="button" className="btn btn-block btn-primary" onClick={buyAgain}>
          Buy these again
        </button>
      )}

      {CANCELLABLE.includes(order.status) && (
        <button type="button" className="btn btn-block btn-danger-quiet" onClick={() => setCancelling(true)}>
          Cancel order
        </button>
      )}

      <Link to="/orders" className="btn btn-block btn-quiet">
        All my orders
      </Link>

      {moving && <MoveDialog order={order} onClose={() => setMoving(false)} onMoved={refresh} />}

      {cancelling && (
        <Dialog
          title={`Cancel order ${order.number}?`}
          onClose={() => setCancelling(false)}
          footer={
            <>
              <button type="button" className="btn" data-autofocus onClick={() => setCancelling(false)}>
                Keep order
              </button>
              <button type="button" className="btn btn-danger" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
                {cancel.isPending ? 'Cancelling…' : 'Cancel order'}
              </button>
            </>
          }
        >
          <p>{paid ? `You'll get a full refund of ${rupees(order.total)} to the way you paid.` : 'Nothing has been charged for this order.'}</p>
          {cancel.error && <p className="field-error">{errorMessage(cancel.error)}</p>}
        </Dialog>
      )}
    </>
  )
}

function DeliveryPhoto({ orderId }: { orderId: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let made: string | null = null
    let live = true
    api
      .deliveryPhotoUrl(orderId)
      .then((u) => {
        made = u
        if (live) setUrl(u)
        else URL.revokeObjectURL(u)
      })
      .catch(() => live && setFailed(true))
    return () => {
      live = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [orderId])
  if (failed) return <p className="muted small">The photo could not be loaded.</p>
  if (!url) return <p className="muted small">Loading the rider's photo…</p>
  return <img className="delivery-photo" src={url} alt="The rider's photo of your delivery" />
}

/** How to look after what arrived, for each ripeness in the order. */
function CareTips({ stages }: { stages: Stage[] }) {
  return (
    <section className="card" aria-labelledby="care-title">
      <h2 id="care-title">Looking after your mangoes</h2>
      {stages.map((st) => (
        <div key={st} className="care">
          <MangoArt stage={st} size={40} />
          <div>
            <h3>{CARE[st].title}</h3>
            <ul>
              {CARE[st].tips.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        </div>
      ))}
    </section>
  )
}

const STAR_WORDS = ['', 'Poor', 'Not great', 'Okay', 'Good', 'Excellent']

/** Stars and a note after delivery. Can be changed later. */
function RateOrder({ order }: { order: Order }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(!order.rating)
  const [stars, setStars] = useState(order.rating?.stars ?? 0)
  const [comment, setComment] = useState(order.rating?.comment ?? '')
  const save = useMutation({
    mutationFn: () => api.rate(order.id, stars, comment.trim() || null),
    onSuccess: () => {
      setEditing(false)
      void queryClient.invalidateQueries({ queryKey: ['order', order.id] })
    },
  })
  if (!editing && order.rating) {
    return (
      <section className="card" aria-labelledby="rated-title">
        <h2 id="rated-title">Your rating</h2>
        <p className="stars-shown" aria-label={`${order.rating.stars} out of 5 stars`}>
          {'★'.repeat(order.rating.stars)}
          <span className="stars-off">{'★'.repeat(5 - order.rating.stars)}</span>
        </p>
        {order.rating.comment && <p>{order.rating.comment}</p>}
        <p className="muted small">Thank you. {order.rating.stars <= 2 && 'If something was wrong with the fruit, report it below and we will make it right.'}</p>
        <button type="button" className="link-btn" onClick={() => setEditing(true)}>
          Change my rating
        </button>
      </section>
    )
  }
  return (
    <section className="card" aria-labelledby="rate-title">
      <h2 id="rate-title">How were your mangoes?</h2>
      <div className="stars" role="radiogroup" aria-labelledby="rate-title">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={stars === n}
            aria-label={`${n} ${n === 1 ? 'star' : 'stars'}, ${STAR_WORDS[n]}`}
            className={n <= stars ? 'star on' : 'star'}
            onClick={() => setStars(n)}
          >
            ★
          </button>
        ))}
        {stars > 0 && <span className="muted small">{STAR_WORDS[stars]}</span>}
      </div>
      {stars > 0 && (
        <>
          <div className="field">
            <label htmlFor="rate-note">Anything to tell us? (optional)</label>
            <textarea id="rate-note" rows={2} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
          <ErrorNote error={save.error} />
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Sending…' : 'Send rating'}
          </button>
        </>
      )}
    </section>
  )
}

/** Pick another open day (and time) for an order that isn't being packed yet. */
function MoveDialog({ order, onClose, onMoved }: { order: Order; onClose: () => void; onMoved: () => void }) {
  const days = useQuery({ queryKey: ['delivery-check', order.pincode], queryFn: () => api.checkPincode(order.pincode) })
  const [date, setDate] = useState<string | null>(null)
  const [slotId, setSlotId] = useState<string | null>(null)
  const slots = useQuery({ queryKey: ['slots', order.pincode, date], queryFn: () => api.slots(order.pincode, date!), enabled: Boolean(date) })
  const move = useMutation({
    mutationFn: () => api.reschedule(order.id, date!, slotId),
    onSuccess: () => {
      onMoved()
      onClose()
    },
  })
  const choices = (days.data?.deliveryDates ?? []).filter((d) => d !== order.deliveryDate)
  const needSlot = Boolean(slots.data?.slots.length)
  const problem = move.error instanceof ApiError && move.error.code === 'STOCK_INSUFFICIENT'
    ? "We don't have enough of these mangoes at the right ripeness for that day. Try another day."
    : move.error instanceof ApiError && move.error.code === 'SLOT_FULL'
      ? 'That time just filled up. Choose another one.'
      : move.error

  return (
    <Dialog
      title="Change delivery day"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Keep {day(order.deliveryDate)}
          </button>
          <button type="button" className="btn btn-primary" disabled={!date || (needSlot && !slotId) || move.isPending} onClick={() => move.mutate()}>
            {move.isPending ? 'Moving…' : 'Move my order'}
          </button>
        </>
      }
    >
      {days.isPending ? (
        <Spinner label="Loading delivery days" />
      ) : days.isError ? (
        <ErrorNote error={days.error} onRetry={() => days.refetch()} />
      ) : choices.length === 0 ? (
        <p>There are no other delivery days open right now.</p>
      ) : (
        <>
          <p className="muted small">Your boxes are packed for the ripeness you chose on the new day.</p>
          <div className="chips" role="radiogroup" aria-label="New delivery day">
            {choices.map((d) => (
              <button key={d} type="button" role="radio" aria-checked={d === date} className="chip" onClick={() => { setDate(d); setSlotId(null) }}>
                {day(d)}
              </button>
            ))}
          </div>
          {date && slots.isPending && <Spinner label="Loading delivery times" />}
          {needSlot && (
            <fieldset className="field">
              <legend>Delivery time</legend>
              <div className="options">
                {slots.data!.slots.map((sl) => (
                  <label key={sl.id} className={`option${sl.available ? '' : ' option-off'}`}>
                    <input type="radio" name="move-slot" checked={slotId === sl.id} disabled={!sl.available} onChange={() => setSlotId(sl.id)} />
                    <span>
                      {slotText(sl)}
                      {!sl.available && <span className="muted small"> · Full</span>}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </>
      )}
      <ErrorNote error={problem} />
    </Dialog>
  )
}
