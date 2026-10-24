import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api, signedInPhone, type Order, type OrderStatus, type Stage } from '../api'
import { CANCELLABLE, STAGE_LABEL, STATUS_LABEL, day, helpLink, rupees, slotText, when } from '../format'
import { DayChips, SlotPicker } from '../forms'
import { MIN_PAY_SECONDS, openRazorpay } from '../payment'
import { ConfirmDialog, Dialog, DocTitle, ErrorNote, PageHeader, Spinner } from '../ui'
import { CARE, MangoArt } from '../mango'
import { useStore } from '../store'
import { OrderReviews } from './Review'

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
/** Packed and on its way: too late to cancel or move. */
const PACKED_ON: OrderStatus[] = ['PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY']
/** How long after a hold runs out the page keeps checking for a late payment. */
const LATE_PAYMENT_WATCH_MS = 30 * 60_000
const latePaymentPossible = (o: Order | undefined) =>
  o?.status === 'CANCELLED' &&
  o.cancelReason === 'HOLD_EXPIRED' &&
  o.paymentStatus !== 'SUCCEEDED' &&
  o.refundStatus === null &&
  Boolean(o.cancelledAt) &&
  Date.now() - new Date(o.cancelledAt!).getTime() < LATE_PAYMENT_WATCH_MS
const ISSUE_LABEL = { DAMAGED: 'Damaged or spoilt', WRONG_ITEM: 'Wrong item', NOT_DELIVERED: 'Not delivered' }

export default function OrderPage() {
  const { id = '' } = useParams()
  const queryClient = useQueryClient()
  const q = useQuery({
    queryKey: ['order', id],
    queryFn: async () => {
      // Still waiting on the payment: the status check also asks Razorpay a
      // minute after checkout (throttled by the API), so a late webhook can't keep it waiting.
      if (queryClient.getQueryData<Order>(['order', id])?.status === 'PAYMENT_PENDING') await api.paymentStatus(id).catch(() => null)
      return api.order(id)
    },
    refetchInterval: (query) => {
      const o = query.state.data
      // Waiting on the payment: check often. On the way: notice the delivery.
      if (o?.status === 'PAYMENT_PENDING') return 3000
      if (o?.status === 'OUT_FOR_DELIVERY') return 30_000
      // The hold ran out, but a payment made just before can still land: keep watching for a while.
      if (latePaymentPossible(o)) return 10_000
      return false
    },
  })
  if (q.isPending) return <Spinner label="Loading your order" />
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404) {
      return (
        <section className="card">
          <DocTitle title="Order not found" />
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
  // Checkout comes from the order itself, so it reopens on any device or tab.
  const payKey = order.razorpayKeyId ?? null
  const holdLeftMs = order.holdExpiresAt ? new Date(order.holdExpiresAt).getTime() - Date.now() : 0
  const holdOpen = holdLeftMs > 0
  const canPay = holdLeftMs > MIN_PAY_SECONDS * 1000
  // Straight after checkout: the order was just placed, and maybe the payment sheet failed to open.
  const arrived = useLocation().state as { payError?: string; placed?: boolean } | null
  const sheetError = arrived?.payError ?? null

  const payAgain = useMutation({
    mutationFn: () => openRazorpay({ orderId: order.id, key: payKey!, rzp: order.razorpayOrderId!, total: order.total, number: order.number, holdExpiresAt: order.holdExpiresAt }, signedInPhone()),
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
  // The money went back (FE-6): the total row says so rather than "Total".
  const refunded = order.refundStatus === 'REFUNDED' || order.paymentStatus === 'REFUNDED'
  const help = helpLink(`Help with order ${order.number}`)
  // A thank-you once the payment goes through: seen here, or already done when checkout hands over.
  const [thanks, setThanks] = useState(() => Boolean(arrived?.placed) && paid && order.status !== 'CANCELLED')
  // After a cancel or a payment the button that was pressed is gone: move focus to the outcome.
  const cancelledNote = useRef<HTMLElement>(null)
  const thanksNote = useRef<HTMLElement>(null)
  const wasStatus = useRef(order.status)
  useEffect(() => {
    if (order.status === 'CANCELLED' && wasStatus.current !== 'CANCELLED') cancelledNote.current?.focus()
    // Paid: straight from waiting, or a late payment that revived an order whose hold ran out.
    const waited = wasStatus.current === 'PAYMENT_PENDING' || wasStatus.current === 'CANCELLED'
    if (waited && order.status !== 'PAYMENT_PENDING' && order.status !== 'CANCELLED') setThanks(true)
    wasStatus.current = order.status
  }, [order.status])
  useEffect(() => {
    if (thanks) thanksNote.current?.focus()
  }, [thanks])
  const canMove = MOVABLE.includes(order.status)
  const canCancel = CANCELLABLE.includes(order.status)
  const refund = paid ? ' for a full refund' : ''
  const policy =
    order.status === 'CONFIRMED'
      ? `You can change the day until we start preparing it, and cancel${refund} until it's packed.`
      : order.status === 'PROCESSING'
        ? `We're preparing your boxes. You can still cancel${refund} until they're packed.`
        : `You can cancel${refund} until it's packed.`

  return (
    <>
      <DocTitle title={`Order ${order.number}`} />
      <PageHeader title={`Order ${order.number}`}>
        <StatusPill status={order.status} />
      </PageHeader>

      {thanks && order.status !== 'CANCELLED' && (
        <section className="card note-card thanks-card" ref={thanksNote} tabIndex={-1} aria-labelledby="thanks-title">
          <p id="thanks-title">
            <strong>Thank you, your order is placed.</strong> We'll deliver it on {day(order.deliveryDate)}
            {order.slot && `, ${slotText(order.slot)}`}.
          </p>
        </section>
      )}

      {order.status === 'PAYMENT_PENDING' && (
        <section className="card note-card" aria-live="polite">
          <p>
            <strong>Waiting for your payment to be confirmed.</strong> This page updates on its own.
            {order.holdExpiresAt && holdOpen && <> Your boxes are held until {when(order.holdExpiresAt)}.</>}
          </p>
          {payKey && order.razorpayOrderId && canPay && (
            <button type="button" className="btn btn-primary" disabled={payAgain.isPending} onClick={() => payAgain.mutate()}>
              Pay {rupees(order.total)}
            </button>
          )}
          {payKey && holdOpen && !canPay && (
            <p className="small">
              The hold on your boxes is about to end. If you've already paid, stay here: this page updates when the payment reaches us. Please
              don't pay again.
            </p>
          )}
          {import.meta.env.DEV && !payKey && (
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
          <ErrorNote error={payAgain.error ?? devPay.error ?? (payAgain.isIdle ? sheetError : null)} />
        </section>
      )}

      {order.status === 'CANCELLED' && (
        <section className="card note-card" ref={cancelledNote} tabIndex={-1}>
          <p>
            <strong>This order was cancelled.</strong>{' '}
            {order.refundStatus === 'REFUNDED'
              ? `Your refund of ${rupees(order.total)} has been sent. Banks take up to 5 to 7 days to show it.`
              : order.refundStatus === 'PENDING'
                ? `Your full refund of ${rupees(order.total)} is on its way.`
                : order.cancelReason === 'HOLD_EXPIRED'
                  ? "We didn't receive your payment in time."
                  : 'We have no payment for this order. If money has left your account, it is refunded in full.'}
          </p>
          {order.cancelReason === 'HOLD_EXPIRED' && order.refundStatus === null && (
            <p className="small">
              If money has left your account, please don't pay again. A payment that arrives late is still matched to this order and confirmed,
              moved to the next day with stock if these boxes have sold out.{' '}
              {latePaymentPossible(order) ? 'This page keeps checking.' : (
                <>
                  Check My orders again later, or <Link to="/help">contact us</Link>.
                </>
              )}
            </p>
          )}
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
            {/* UX-4: staff give a reason for every rejection; the customer sees it in their words. */}
            {claim.status === 'RESOLVED' && claim.resolution === 'REJECTED' && claim.rejectionReason && (
              <p className="claim-reason">
                <strong>Why:</strong> {claim.rejectionReason}
              </p>
            )}
            {claim.status === 'RESOLVED' && claim.resolution === 'REJECTED' && (
              <p className="small muted">
                If you think we got it wrong, <Link to="/help">talk to us</Link>.
              </p>
            )}
            {claim.replacementOrder && <Link to={`/orders/${claim.replacementOrder.id}`}>See replacement order {claim.replacementOrder.number}</Link>}
          </section>
        ) : (
          <ClaimPrompt order={order} loading={claims.isPending} />
        ))}

      {order.findingStock && (
        <section className="card note-card" role="status">
          <p>
            <strong>We're finding fresh stock for your order.</strong> Your payment is safe. The delivery day may change, and we'll message you on
            WhatsApp as soon as it's settled. You can still cancel for a full refund until it's packed.
          </p>
        </section>
      )}

      {order.status === 'DELIVERY_FAILED' && (
        <section className="card note-card">
          {/* No retry booked after the last attempt: never name the missed day as the next one. */}
          {order.retryScheduled === false ? (
            <p>
              <strong>We missed you{order.deliveryFailures > 1 ? ' again' : ''}.</strong> We'll call you to arrange a new delivery.
            </p>
          ) : (
            <p>
              <strong>We missed you.</strong> We'll try again on {day(order.deliveryDate)}.
            </p>
          )}
        </section>
      )}

      {(canMove || canCancel) && (
        <section className="card order-actions" aria-label="Change or cancel">
          <p className="small">{policy}</p>
          <div className="order-actions-row">
            {canMove && (
              <button type="button" className="btn" onClick={() => setMoving(true)}>
                Change delivery day
              </button>
            )}
            <button type="button" className="btn btn-danger-quiet" onClick={() => setCancelling(true)}>
              Cancel order
            </button>
          </div>
        </section>
      )}
      {PACKED_ON.includes(order.status) && (
        <p className="muted small order-policy">
          It's packed, so it can no longer be cancelled or moved. If a box arrives damaged, report it within {order.claimWindowHours} hours of delivery
          for a free replacement.
        </p>
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
                    {i.readyOn && i.readyOn !== order.deliveryDate && ` · ready to eat around ${day(i.readyOn)}`}
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
          <span>{refunded ? 'Refunded' : paid ? 'Paid' : 'Total'}</span>
          <strong>{rupees(order.total)}</strong>
        </div>
      </section>

      {order.status === 'DELIVERED' && <OrderReviews orderId={order.id} />}

      {!['PAYMENT_PENDING', 'CANCELLED', 'RTO'].includes(order.status) && stages.length > 0 && <CareTips stages={stages} />}

      {['DELIVERED', 'CANCELLED'].includes(order.status) && (
        <button type="button" className="btn btn-block btn-primary" onClick={buyAgain}>
          Buy these again
        </button>
      )}

      <Link to="/orders" className="btn btn-block btn-quiet">
        All my orders
      </Link>

      {/* UX-1: always a way to reach us; production builds always have the WhatsApp number. */}
      <p className="small muted center">
        Need help with this order?{' '}
        {help ? (
          <a href={help} target="_blank" rel="noopener noreferrer">
            Message us on WhatsApp<span className="sr-only"> (opens WhatsApp)</span>
          </a>
        ) : (
          <Link to="/help">See how to reach us</Link>
        )}
      </p>

      {moving && <MoveDialog order={order} onClose={() => setMoving(false)} onMoved={refresh} />}

      {cancelling && (
        <ConfirmDialog
          title={`Cancel order ${order.number}?`}
          keepLabel="Keep order"
          confirmLabel="Cancel order"
          busyLabel="Cancelling…"
          busy={cancel.isPending}
          error={cancel.error}
          onConfirm={() => cancel.mutate()}
          onClose={() => setCancelling(false)}
        >
          <p>{paid ? `You'll get a full refund of ${rupees(order.total)} to the way you paid.` : 'No payment has reached us for this order. If you have just paid, cancelling refunds it in full.'}</p>
        </ConfirmDialog>
      )}
    </>
  )
}

/** On a delivered order: until when a problem can be reported for a free replacement, and the way to do it. */
function ClaimPrompt({ order, loading }: { order: Order; loading: boolean }) {
  // The window comes from the API, from the latest delivery and the live rule.
  const deadline = order.claimUntil ? new Date(order.claimUntil) : null
  const open = deadline != null && deadline.getTime() > Date.now()
  // Until the reports load we don't know whether one was sent: keep the space, show nothing.
  if (loading) return null
  const report = (
    <Link to={`/orders/${order.id}/claim`} className="btn btn-block">
      Report a problem with this order
    </Link>
  )
  // Past our count of the window the link stays: the API has the last word on a late report.
  if (!open) return report
  return (
    <section className="card claim-prompt" aria-label="Report a problem">
      <p>
        <strong>Something wrong?</strong> Report it by {when(deadline!.toISOString())} for a free replacement.
      </p>
      {report}
    </section>
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
          <DayChips
            label="New delivery day"
            days={choices}
            value={date}
            format={day}
            onChange={(d) => {
              setDate(d)
              setSlotId(null)
            }}
          />
          {date && slots.isPending && <Spinner label="Loading delivery times" />}
          {needSlot && <SlotPicker name="move-slot" slots={slots.data!.slots} value={slotId} onChange={setSlotId} />}
        </>
      )}
      <ErrorNote error={problem} />
    </Dialog>
  )
}
