import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api, errorMessage, signedInPhone, type Order, type OrderStatus } from '../api'
import { CANCELLABLE, STAGE_LABEL, STATUS_LABEL, day, rupees, slotText, when } from '../format'
import { openRazorpay, rememberedPayment } from '../payment'
import { Dialog, ErrorNote, Spinner } from '../ui'

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

const STEPS: { label: string; reached: OrderStatus[] }[] = [
  { label: 'Confirmed', reached: ['CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED'] },
  { label: 'Packed', reached: ['PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED'] },
  { label: 'Out for delivery', reached: ['OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED'] },
  { label: 'Delivered', reached: ['DELIVERED'] },
]
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
  const claims = useQuery({ queryKey: ['claims'], queryFn: api.claims, enabled: order.status === 'DELIVERED' })
  const claim = claims.data?.find((c) => c.orderId === order.id)
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['order', order.id] })
    void queryClient.invalidateQueries({ queryKey: ['orders'] })
  }
  const remembered = rememberedPayment(order.id)
  const holdOpen = order.holdExpiresAt ? new Date(order.holdExpiresAt).getTime() > Date.now() : false

  const payAgain = useMutation({
    mutationFn: () => openRazorpay({ key: remembered!.key!, rzp: order.razorpayOrderId!, total: order.total, number: order.number }, signedInPhone()),
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
            return (
              <li key={s.label} className={done ? 'done' : ''}>
                <span className="dot" aria-hidden="true" />
                <span>
                  {s.label}
                  <span className="sr-only">{done ? ', done' : ', not yet'}</span>
                </span>
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

      {CANCELLABLE.includes(order.status) && (
        <button type="button" className="btn btn-block btn-danger-quiet" onClick={() => setCancelling(true)}>
          Cancel order
        </button>
      )}

      <Link to="/orders" className="btn btn-block btn-quiet">
        All my orders
      </Link>

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
