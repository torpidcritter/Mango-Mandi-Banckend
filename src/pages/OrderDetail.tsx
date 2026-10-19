import { useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api, isConflict } from '../api'
import { ORDER_STATUS_LABEL, PAYMENT_LABEL, date, dateTime, istDate, rupees } from '../format'
import type { DeliveryAttempt, NotificationKind, OrderDetail as Order, OrderNotification, OrderStatus } from '../types'
import { PACKER_STATUSES, can, canSee } from '../permissions'
import { useSession } from '../session'
import { Badge, Dialog, FormError, GatedButton, OrderBadge, QueryError, Spinner, useToast, scrollRegion } from '../ui'

const CONFLICT_MESSAGE = 'This order was just updated by someone else.'

const MESSAGE_LABEL: Record<NotificationKind, string> = {
  ORDER_CONFIRMED: 'Order confirmed',
  REPLACEMENT_CONFIRMED: 'Replacement confirmed',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  DELIVERY_FAILED: 'Delivery missed',
  CANCELLED: 'Order cancelled',
  REFUNDED: 'Refund sent',
  DATE_MOVED: 'Delivery date moved',
}

function messageState(n: OrderNotification) {
  switch (n.status) {
    case 'SENT':
      return <Badge tone="good">Sent</Badge>
    case 'PENDING':
      return <Badge tone="info">{n.attempts > 0 ? `Retrying (try ${n.attempts + 1})` : 'Queued'}</Badge>
    case 'FAILED':
      return <Badge tone="bad">Failed</Badge>
    default:
      return <Badge tone="neutral">Not sent</Badge>
  }
}

type Move = { to: OrderStatus; label: string; primary?: boolean }

/** The status moves offered for each status. The UI never offers an invalid one. */
function movesFor(status: OrderStatus): Move[] {
  switch (status) {
    case 'CONFIRMED':
      return [{ to: 'PROCESSING', label: 'Start processing', primary: true }]
    case 'PROCESSING':
      return [{ to: 'PACKED', label: 'Mark packed', primary: true }]
    case 'PACKED':
      return [{ to: 'SHIPPED', label: 'Mark shipped', primary: true }]
    case 'SHIPPED':
      return [{ to: 'OUT_FOR_DELIVERY', label: 'Out for delivery', primary: true }]
    case 'OUT_FOR_DELIVERY':
      return [
        { to: 'DELIVERED', label: 'Mark delivered', primary: true },
        { to: 'DELIVERY_FAILED', label: 'Delivery failed' },
      ]
    case 'DELIVERY_FAILED':
      return [
        { to: 'OUT_FOR_DELIVERY', label: 'Retry delivery', primary: true },
        { to: 'RTO', label: 'Mark as returned' },
      ]
    default:
      return []
  }
}

const CANCELLABLE: OrderStatus[] = ['PAYMENT_PENDING', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY']
/** A paid order a manager can cancel with a full refund: anything not yet delivered (mirrors MANAGER_REFUNDABLE in the API). */
const REFUNDABLE: OrderStatus[] = [...CANCELLABLE, 'DELIVERY_FAILED', 'RTO']
const ALLOCATABLE: OrderStatus[] = ['CONFIRMED', 'PROCESSING']

export default function OrderDetail() {
  const { id = '' } = useParams()
  const q = useQuery({ queryKey: ['order', id], queryFn: () => api.order(id) })

  if (q.isPending) return <Spinner />
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404) {
      return (
        <div className="card">
          <h1>Order not found</h1>
          <Link to="/orders">Back to orders</Link>
        </div>
      )
    }
    return <QueryError error={q.error} onRetry={() => q.refetch()} />
  }
  return <OrderView order={q.data} />
}

function useOrderRefresh(orderId: string) {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: ['order', orderId] })
    queryClient.invalidateQueries({ queryKey: ['orders'] })
    queryClient.invalidateQueries({ queryKey: ['summary'] })
    queryClient.invalidateQueries({ queryKey: ['pack-list'] })
    queryClient.invalidateQueries({ queryKey: ['batch'] })
  }
}

function OrderView({ order }: { order: Order }) {
  const { me } = useSession()
  const changeOrder = can(me?.role, 'changeOrder')
  const openBatches = canSee(me?.role, 'batches')
  const toast = useToast()
  const refresh = useOrderRefresh(order.id)
  const [dialog, setDialog] = useState<'cancel' | 'reschedule' | null>(null)

  const awaitingPack = order.stock.some((s) => s.state === 'committed')
  const paid = order.payment?.status === 'SUCCEEDED'
  const manager = me?.role === 'MANAGER'
  // Unpaid: any staff who can change orders cancels it. Paid: only a manager, with a full refund.
  const canCancel = changeOrder && (paid ? REFUNDABLE : CANCELLABLE).includes(order.status)

  function onActionError(err: unknown) {
    if (isConflict(err)) toast.error(CONFLICT_MESSAGE)
    else toast.error(err)
    refresh()
  }

  const move = useMutation({
    mutationFn: (to: OrderStatus) => api.setOrderStatus(order.id, to),
    onSuccess: (_r, to) => {
      toast.success(`Order ${order.number} is now ${ORDER_STATUS_LABEL[to]}`)
      refresh()
    },
    onError: onActionError,
  })
  const allocate = useMutation({
    mutationFn: () => api.allocate(order.id),
    onSuccess: () => {
      toast.success('Stock allocated. Pick list is ready.')
      refresh()
    },
    onError: onActionError,
  })

  const busy = move.isPending || allocate.isPending
  const moves = movesFor(order.status).filter((m) => me?.role !== 'PACKER' || PACKER_STATUSES.includes(m.to))

  return (
    <>
      <div className="topbar">
        <h1>Order {order.number}</h1>
        <OrderBadge status={order.status} />
        <span className="muted">Placed {dateTime(order.placedAt)}</span>
      </div>

      {order.atRisk && (
        <div className="notice notice-warn" role="status">
          <strong>At risk:</strong> {order.atRiskReason ?? 'this order no longer has valid stock.'} Move it to a date with
          stock, or wait for new stock to arrive.
        </div>
      )}
      {order.replacementFor && (
        <div className="notice notice-info" role="status">
          Free replacement for order <Link to={`/orders/${order.replacementFor.id}`}>{order.replacementFor.number}</Link>.
        </div>
      )}

      {order.status === 'PAYMENT_PENDING' && (
        <div className="notice notice-warn" role="status">
          Waiting for payment… Only a verified payment confirms an order, so there is nothing to do here yet.
        </div>
      )}

      <div className="card btn-row" aria-label="Order actions">
        {ALLOCATABLE.includes(order.status) && (
          <button
            type="button"
            className="btn"
            disabled={busy || !awaitingPack}
            title={awaitingPack ? undefined : 'Nothing left to allocate'}
            onClick={() => allocate.mutate()}
          >
            Allocate and pack
          </button>
        )}
        {moves.map((m) => {
          const blocked = m.to === 'PACKED' && awaitingPack
          return (
            <button
              key={m.to}
              type="button"
              className={`btn${m.primary ? ' btn-primary' : ''}`}
              disabled={busy || blocked}
              onClick={() => move.mutate(m.to)}
            >
              {blocked ? 'Mark packed (allocate first)' : m.label}
            </button>
          )
        })}
        {changeOrder && ALLOCATABLE.includes(order.status) && (
          <button type="button" className="btn" disabled={busy} onClick={() => setDialog('reschedule')}>
            Move delivery date
          </button>
        )}
        {canCancel &&
          (paid ? (
            <GatedButton allowed={manager} className="btn btn-danger" disabled={busy} onClick={() => setDialog('cancel')}>
              Cancel and refund
            </GatedButton>
          ) : (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setDialog('cancel')}>
              Cancel order
            </button>
          ))}
        {moves.length === 0 && !canCancel && (
          <span className="muted">No actions available.</span>
        )}
      </div>

      <div className="grid-2">
        <div>
          <section className="card">
            <h2>Items</h2>
            <div {...scrollRegion('Order items')}>
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Stage</th>
                    <th className="num">Qty</th>
                    <th className="num">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {order.items.map((it, i) => (
                    <tr key={it.id ?? i}>
                      <td>
                        {it.productName}
                        <div className="muted small">{it.sku}</div>
                      </td>
                      <td>{it.stage ?? '—'}</td>
                      <td className="num">{it.quantity}</td>
                      <td className="num">{rupees(it.linePrice)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  {!!order.discount && (
                    <tr>
                      <td colSpan={3}>Promo {order.promoCode ?? ''}</td>
                      <td className="num">−{rupees(order.discount)}</td>
                    </tr>
                  )}
                  <tr>
                    <th colSpan={3}>Total</th>
                    <th className="num">{rupees(order.total)}</th>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          <section className="card">
            <h2>Stock allocation</h2>
            {order.stock.length === 0 ? (
              <p className="muted">No stock is held for this order.</p>
            ) : (
              <div {...scrollRegion('Stock allocation')}>
                <table>
                  <thead>
                    <tr>
                      <th>Batch</th>
                      <th>SKU</th>
                      <th className="num">Qty</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.stock.map((s, i) => (
                      <tr key={s.id ?? i}>
                        <td>
                          {openBatches ? (
                            <Link to={`/batches/${s.batchId}`}>
                              {s.variety} · {date(s.pluckedOn)}
                            </Link>
                          ) : (
                            `${s.variety} · ${date(s.pluckedOn)}`
                          )}
                        </td>
                        <td>{s.sku ?? '—'}</td>
                        <td className="num">{s.quantity}</td>
                        <td>
                          <Badge tone={s.state === 'packed' ? 'good' : s.state === 'released' ? 'neutral' : 'info'}>
                            {s.state}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <div>
          <section className="card">
            <h2>Customer and delivery</h2>
            <dl className="kv">
              <dt>Name</dt>
              <dd>{order.customerName ?? '—'}</dd>
              <dt>Phone</dt>
              <dd>{order.phone ?? '—'}</dd>
              {order.gift && (
                <>
                  <dt>Gift for</dt>
                  <dd>
                    {order.gift.recipientName} · {order.gift.recipientPhone}
                  </dd>
                  {order.gift.message && (
                    <>
                      <dt>Gift note</dt>
                      <dd>{order.gift.message}</dd>
                    </>
                  )}
                </>
              )}
              <dt>Address</dt>
              <dd>{order.deliveryAddress ?? '—'}</dd>
              <dt>Pincode</dt>
              <dd>{order.pincode ?? '—'}</dd>
              <dt>Placed via</dt>
              <dd>{order.channel === 'whatsapp' ? 'WhatsApp chat' : 'App'}</dd>
              <dt>Delivery date</dt>
              <dd>{date(order.deliveryDate)}</dd>
              {order.slot && (
                <>
                  <dt>Delivery slot</dt>
                  <dd>
                    {order.slot.label}{' '}
                    <span className="muted small">
                      {order.slot.startsAt}–{order.slot.endsAt}
                    </span>
                  </dd>
                </>
              )}
            </dl>
          </section>
          <section className="card">
            <h2>Payment</h2>
            {order.payment ? (
              <dl className="kv">
                <dt>Status</dt>
                <dd>{order.payment.status ? (PAYMENT_LABEL[order.payment.status] ?? order.payment.status) : '—'}</dd>
                <dt>Method</dt>
                <dd>{order.payment.method ?? '—'}</dd>
                <dt>Amount</dt>
                <dd>{rupees(order.payment.amount)}</dd>
                {order.payment.refund && (
                  <>
                    <dt>Refund</dt>
                    <dd>
                      {order.payment.refund.refundedAt
                        ? `Refunded ${dateTime(order.payment.refund.refundedAt)}`
                        : 'Pending: being sent back to the customer'}
                    </dd>
                  </>
                )}
              </dl>
            ) : (
              <p className="muted">No payment recorded.</p>
            )}
          </section>
          {order.rating && (
            <section className="card">
              <h2>Customer rating</h2>
              <p>
                <strong aria-label={`${order.rating.stars} out of 5 stars`}>
                  {'★'.repeat(order.rating.stars)}
                  <span className="muted">{'☆'.repeat(5 - order.rating.stars)}</span>
                </strong>{' '}
                <span className="muted small">{dateTime(order.rating.at)}</span>
              </p>
              {order.rating.comment ? <p>{order.rating.comment}</p> : <p className="muted small">No comment.</p>}
            </section>
          )}
          {order.deliveryAttempts && order.deliveryAttempts.length > 0 && (
            <section className="card">
              <h2>Proof of delivery</h2>
              <ol className="timeline">
                {order.deliveryAttempts.map((a) => (
                  <li key={a.id}>
                    <strong>{a.outcome === 'DELIVERED' ? 'Delivered' : (a.reasonLabel ?? 'Not delivered')}</strong>{' '}
                    <span className="muted small">{dateTime(a.at)}</span>
                    <div className="small">{proofText(a)}</div>
                    {a.note && <div className="small">{a.note}</div>}
                    <div className="small muted">
                      by {a.actor}
                      {a.lat !== null && a.lng !== null && (
                        <>
                          {' · '}
                          <a href={`https://www.google.com/maps/search/?api=1&query=${a.lat},${a.lng}`} target="_blank" rel="noreferrer">
                            where
                          </a>
                        </>
                      )}
                    </div>
                    {a.photoId && <ProofPhoto orderId={order.id} photoId={a.photoId} />}
                  </li>
                ))}
              </ol>
            </section>
          )}
          <section className="card">
            <h2>Timeline</h2>
            {order.events.length === 0 ? (
              <p className="muted">No events yet.</p>
            ) : (
              <ol className="timeline">
                {order.events.map((e, i) => (
                  <li key={i}>
                    <strong>{ORDER_STATUS_LABEL[e.status] ?? e.status}</strong>{' '}
                    <span className="muted small">{dateTime(e.createdAt)}</span>
                    {e.actor && <div className="small muted">by {e.actor}</div>}
                    {e.reason && <div className="small">{e.reason}</div>}
                  </li>
                ))}
              </ol>
            )}
          </section>
          {order.notifications && order.notifications.length > 0 && (
            <section className="card">
              <h2>WhatsApp updates</h2>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {order.notifications.map((n, i) => (
                  <li key={i} style={{ marginBottom: '0.5rem' }}>
                    {MESSAGE_LABEL[n.kind] ?? n.kind} {messageState(n)}{' '}
                    <span className="muted small">{dateTime(n.sentAt ?? n.createdAt)}</span>
                    {n.error && n.status !== 'SENT' && <div className="small muted">{n.error}</div>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>

      {dialog === 'cancel' && <CancelDialog order={order} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'reschedule' && <RescheduleDialog order={order} onClose={() => setDialog(null)} onDone={refresh} />}
    </>
  )
}

function CancelDialog({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const paid = order.payment?.status === 'SUCCEEDED'
  const cancel = useMutation({
    mutationFn: () => api.cancelOrder(order.id, reason.trim(), paid),
    onSuccess: () => {
      toast.success(paid ? `Order ${order.number} cancelled; ${rupees(order.payment?.amount ?? order.total)} is being refunded` : `Order ${order.number} cancelled`)
      onDone()
      onClose()
    },
    onError: (err) => {
      if (isConflict(err)) {
        toast.error(CONFLICT_MESSAGE)
        onDone()
        onClose()
      }
    },
  })
  const holdsStock = order.stock.some((s) => s.state !== 'released')
  const valid = reason.trim().length >= 3

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (valid) cancel.mutate()
  }

  return (
    <Dialog
      title={paid ? `Cancel and refund order ${order.number}?` : `Cancel order ${order.number}?`}
      tone="danger"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Keep order
          </button>
          <button type="submit" form="cancel-form" className="btn btn-danger" disabled={!valid || cancel.isPending}>
            {cancel.isPending ? 'Cancelling…' : paid ? 'Cancel and refund' : 'Cancel order'}
          </button>
        </>
      }
    >
      <form id="cancel-form" onSubmit={onSubmit}>
        {paid && (
          <p>
            The customer paid <strong>{rupees(order.payment?.amount ?? order.total)}</strong>. It goes back to them in full, and they get a WhatsApp
            message when it is sent. Use this only when we can't deliver the order; problems with delivered fruit get a replacement instead.
          </p>
        )}
        <p>{holdsStock ? 'Stock held for this order will be released.' : 'No stock is held for this order.'}</p>
        <div className="field">
          <label htmlFor="cancel-reason">Reason</label>
          <textarea id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus />
          <p className="hint">At least 3 characters. Saved on the order timeline.</p>
        </div>
        <FormError error={cancel.isError && !isConflict(cancel.error) ? cancel.error : null} />
      </form>
    </Dialog>
  )
}

function RescheduleDialog({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [when, setWhen] = useState(order.deliveryDate > istDate(1) ? order.deliveryDate : istDate(1))
  const [slotId, setSlotId] = useState(order.slot?.id ?? '')
  const slots = useQuery({ queryKey: ['slots'], queryFn: api.slots })
  const activeSlots = (slots.data ?? []).filter((s) => s.active)

  const move = useMutation({
    mutationFn: () => api.rescheduleOrder(order.id, when, slotId || null),
    onSuccess: () => {
      toast.success(`Order ${order.number} now delivers on ${date(when)}`)
      onDone()
      onClose()
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    move.mutate()
  }

  return (
    <Dialog
      title={`Move order ${order.number}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Keep {date(order.deliveryDate)}
          </button>
          <button type="submit" form="reschedule-form" className="btn btn-primary" disabled={move.isPending || !when}>
            {move.isPending ? 'Moving…' : 'Move order'}
          </button>
        </>
      }
    >
      <form id="reschedule-form" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="reschedule-date">New delivery date</label>
          <input id="reschedule-date" type="date" min={istDate(1)} value={when} onChange={(e) => setWhen(e.target.value)} data-autofocus />
          <p className="hint">
            The order keeps its ripeness. Stock is re-picked for the new date; if there isn't enough, nothing changes.
          </p>
        </div>
        {activeSlots.length > 0 && (
          <div className="field">
            <label htmlFor="reschedule-slot">Delivery slot</label>
            <select id="reschedule-slot" value={slotId} onChange={(e) => setSlotId(e.target.value)}>
              <option value="">Any slot with room</option>
              {activeSlots.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} ({s.startsAt}–{s.endsAt})
                </option>
              ))}
            </select>
            <p className="hint">A full slot is refused. "Any slot with room" keeps the current slot if it fits.</p>
          </div>
        )}
        <FormError error={move.error} />
      </form>
    </Dialog>
  )
}

function proofText(a: DeliveryAttempt): string {
  if (a.method === 'code') return "The customer's code matched"
  if (a.method === 'photo') return a.outcome === 'DELIVERED' ? `Left with ${a.receivedBy ?? 'someone'}, with a photo` : 'With a photo'
  if (a.method === 'staff') return 'Marked from the panel, without proof'
  return ''
}

function ProofPhoto({ orderId, photoId }: { orderId: string; photoId: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let made: string | null = null
    let live = true
    api
      .deliveryPhotoUrl(orderId, photoId)
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
  }, [orderId, photoId])
  if (failed) return <div className="small muted">The photo could not be loaded.</div>
  if (!url) return <div className="small muted">Loading photo…</div>
  return <img className="delivery-photo" src={url} alt="Delivery photo taken by the rider" />
}
