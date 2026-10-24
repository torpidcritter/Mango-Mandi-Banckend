import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api, isConflict, isStale } from '../api'
import {
  ORDER_STATUS_LABEL,
  PAYMENT_LABEL,
  NOTIFICATION_LABEL,
  PAYMENT_METHOD_LABEL,
  STOCK_STATE_LABEL,
  actorLabel,
  date,
  dateTime,
  humanize,
  istDate,
  ripenessLabel,
  rupees,
} from '../format'
import type { DeliveryAttempt, OrderDetail as Order, OrderNotification, OrderStatus } from '../types'
import { PACKER_STATUSES, can, canSee } from '../permissions'
import { MissedDialog } from '../MissedDialog'
import { useSession } from '../session'
import {
  AuthedPhoto,
  BackLink,
  Badge,
  ConfirmDialog,
  Dialog,
  DisabledReason,
  FormError,
  GatedButton,
  ManagerOnlyNote,
  OrderBadge,
  PhoneLink,
  QueryError,
  ReasonDialog,
  Spinner,
  useToast,
  scrollRegion,
  usePageTitle,
} from '../ui'

const CONFLICT_MESSAGE = 'This order was just updated by someone else.'

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
/** 409s a manager can override with a reason: at-risk stock going out, or a retry after the last attempt. */
const OVERRIDABLE = ['AT_RISK', 'ATTEMPTS_USED_UP']

/** A status move that needs a manager's reason: DELIVERED without proof, or an override of a refusal. */
type Override = { to: OrderStatus; why: string | null }

export default function OrderDetail() {
  const { id = '' } = useParams()
  const q = useQuery({ queryKey: ['order', id], queryFn: () => api.order(id) })
  usePageTitle(q.data ? `Order ${q.data.number}` : q.isError ? 'Order not found' : 'Order')

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
    queryClient.invalidateQueries({ queryKey: ['manifest'] })
  }
}

function OrderView({ order }: { order: Order }) {
  const { me } = useSession()
  const changeOrder = can(me?.role, 'changeOrder')
  const openBatches = canSee(me?.role, 'batches')
  // Back to the list this role works from: Orders, or the pack list for a packer.
  const back = canSee(me?.role, 'orders') ? { to: '/orders', label: 'Orders' } : { to: '/pack-list', label: 'Pack list' }
  const toast = useToast()
  const refresh = useOrderRefresh(order.id)
  const [dialog, setDialog] = useState<'cancel' | 'reschedule' | 'missed' | 'returned' | null>(null)
  const [override, setOverride] = useState<Override | null>(null)
  const [returning, setReturning] = useState<'RESTOCK' | 'WRITE_OFF' | null>(null)

  const awaitingPack = order.stock.some((s) => s.state === 'committed')
  const paid = order.payment?.status === 'SUCCEEDED'
  const manager = me?.role === 'MANAGER'
  // Unpaid: any staff who can change orders cancels it. Paid: only a manager, with a full refund.
  const canCancel = changeOrder && (paid ? REFUNDABLE : CANCELLABLE).includes(order.status)

  function onActionError(err: unknown) {
    if (isStale(err)) toast.error(CONFLICT_MESSAGE)
    else toast.error(err)
    refresh()
  }

  const move = useMutation({
    mutationFn: (to: OrderStatus) => api.setOrderStatus(order.id, to),
    onError: (err, to) => {
      // A manager can send it anyway, saying why; everyone else sees the reason it was refused.
      if (manager && err instanceof ApiError && OVERRIDABLE.includes(err.code)) setOverride({ to, why: err.message })
      else onActionError(err)
    },
    onSuccess: (_r, to) => {
      toast.success(`Order ${order.number} is now ${ORDER_STATUS_LABEL[to]}`)
      refresh()
    },
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
  // Marking delivered from here skips the customer's code and photo, so only a manager can, with a reason.
  // Everyone else records the delivery on the Deliveries page.
  const moves = movesFor(order.status).filter(
    (m) => (me?.role !== 'PACKER' || PACKER_STATUSES.includes(m.to)) && (m.to !== 'DELIVERED' || manager),
  )

  return (
    <>
      <BackLink to={back.to}>{back.label}</BackLink>
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
      {(order.returnedBoxes ?? 0) > 0 && (
        <div className="notice notice-warn" role="status">
          <strong>
            {order.returnedBoxes} {order.returnedBoxes === 1 ? 'box' : 'boxes'} left the store with this order and{' '}
            {order.returnedBoxes === 1 ? 'is' : 'are'} not on the books.
          </strong>{' '}
          When they come back, put them on the shelf; if they are damaged or lost, write them off.
          {changeOrder && (
            <span className="btn-row mt-2">
              <button type="button" className="btn btn-small" onClick={() => setReturning('RESTOCK')}>
                Back on the shelf
              </button>
              <button type="button" className="btn btn-small" onClick={() => setReturning('WRITE_OFF')}>
                Write off
              </button>
            </span>
          )}
        </div>
      )}
      {returning && <ReturnedStockDialog order={order} action={returning} onClose={() => setReturning(null)} onDone={refresh} />}
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
            Allocate stock
          </button>
        )}
        {ALLOCATABLE.includes(order.status) && !awaitingPack && <DisabledReason>Nothing left to allocate.</DisabledReason>}
        {moves.map((m) => {
          const blocked = m.to === 'PACKED' && awaitingPack
          return (
            <button
              key={m.to}
              type="button"
              className={`btn${m.primary ? ' btn-primary' : ''}`}
              disabled={busy || blocked}
              onClick={() => {
                // Delivered needs a manager's reason, a missed delivery needs the rider's reason, and a return is confirmed first.
                if (m.to === 'DELIVERED') setOverride({ to: 'DELIVERED', why: null })
                else if (m.to === 'DELIVERY_FAILED') setDialog('missed')
                else if (m.to === 'RTO') setDialog('returned')
                else move.mutate(m.to)
              }}
            >
              {blocked ? 'Mark packed (allocate first)' : m.label}
            </button>
          )
        })}
        {order.status === 'OUT_FOR_DELIVERY' && !manager && (
          <span className="muted">Record the delivery on the Deliveries page, with the customer's code or a photo.</span>
        )}
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
        {canCancel && paid && !manager && <ManagerOnlyNote what="Cancelling a paid order" />}
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
                    <th>Ripeness</th>
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
                      <td>{ripenessLabel(it.stage)}</td>
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
                            {STOCK_STATE_LABEL[s.state] ?? s.state}
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
              <dd>
                <PhoneLink phone={order.phone} who="the customer" />
              </dd>
              {order.gift && (
                <>
                  <dt>Gift for</dt>
                  <dd>
                    {order.gift.recipientName} · <PhoneLink phone={order.gift.recipientPhone} who={order.gift.recipientName} />
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
                <dd>{order.payment.method ? (PAYMENT_METHOD_LABEL[order.payment.method] ?? order.payment.method) : '—'}</dd>
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
                      by {actorLabel(a.actor)}
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
                    <strong>{ORDER_STATUS_LABEL[e.status] ?? humanize(e.status)}</strong>{' '}
                    <span className="muted small">{dateTime(e.createdAt)}</span>
                    {e.actor && <div className="small muted">by {actorLabel(e.actor)}</div>}
                    {e.reason && <div className="small">{e.reason}</div>}
                  </li>
                ))}
              </ol>
            )}
          </section>
          {order.notifications && order.notifications.length > 0 && (
            <section className="card">
              <h2>WhatsApp updates</h2>
              <ul className="bare-list">
                {order.notifications.map((n, i) => (
                  <li key={i}>
                    {NOTIFICATION_LABEL[n.kind] ?? n.kind} {messageState(n)}{' '}
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
      {dialog === 'missed' && <MissedDialog order={order} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'returned' && (
        <ConfirmDialog
          title={`Mark ${order.number} as returned?`}
          confirmLabel="Mark as returned"
          cancelLabel="Go back"
          busy={move.isPending}
          onClose={() => setDialog(null)}
          onConfirm={() => move.mutate('RTO', { onSettled: () => setDialog(null) })}
        >
          <p>The order is back with us and won't go out again. This can't be undone from here.</p>
        </ConfirmDialog>
      )}
      {override && <OverrideDialog order={order} override={override} onClose={() => setOverride(null)} onDone={refresh} />}
    </>
  )
}

type WriteOffReason = 'DAMAGED' | 'THEFT_LOSS' | 'OTHER'

/** Boxes back from a cancelled or returned order (INV-F): on the shelf again, or written off with a reason. */
function ReturnedStockDialog({ order, action, onClose, onDone }: { order: Order; action: 'RESTOCK' | 'WRITE_OFF'; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [code, setCode] = useState<WriteOffReason>('DAMAGED')
  const book = useMutation({
    mutationFn: (reason: string) => api.bookReturnedStock(order.id, action === 'WRITE_OFF' ? { action, reasonCode: code, reason } : { action, reason }),
    onSuccess: (r) => {
      toast.success(action === 'RESTOCK' ? `${r.boxes} boxes back on the shelf` : `${r.boxes} boxes written off`)
      onDone()
      onClose()
    },
  })
  return (
    <ReasonDialog
      title={action === 'RESTOCK' ? `Put the boxes from ${order.number} back on the shelf?` : `Write off the boxes from ${order.number}?`}
      tone={action === 'RESTOCK' ? 'primary' : 'danger'}
      label="Note for the stock ledger"
      hint={action === 'RESTOCK' ? 'Only boxes that came back sound. They can be sold again.' : 'Saved in the stock ledger with the reason.'}
      minLength={1}
      maxLength={300}
      confirmLabel={action === 'RESTOCK' ? 'Back on the shelf' : 'Write off'}
      busy={book.isPending}
      error={book.error}
      onClose={onClose}
      onSubmit={(reason) => book.mutate(reason)}
    >
      {action === 'WRITE_OFF' && (
        <div className="field">
          <label htmlFor="writeoff-code">Why</label>
          <select id="writeoff-code" value={code} onChange={(e) => setCode(e.target.value as WriteOffReason)}>
            <option value="DAMAGED">Damaged</option>
            <option value="THEFT_LOSS">Theft or loss</option>
            <option value="OTHER">Other</option>
          </select>
        </div>
      )}
    </ReasonDialog>
  )
}

function CancelDialog({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const paid = order.payment?.status === 'SUCCEEDED'
  const cancel = useMutation({
    mutationFn: (reason: string) => api.cancelOrder(order.id, reason, paid),
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

  return (
    <ReasonDialog
      title={paid ? `Cancel and refund order ${order.number}?` : `Cancel order ${order.number}?`}
      confirmLabel={paid ? 'Cancel and refund' : 'Cancel order'}
      cancelLabel="Keep order"
      busyLabel="Cancelling…"
      hint="At least 3 characters. Saved on the order timeline."
      busy={cancel.isPending}
      error={cancel.isError && !isConflict(cancel.error) ? cancel.error : null}
      onClose={onClose}
      onSubmit={(reason) => cancel.mutate(reason)}
    >
      {paid && (
        <p>
          The customer paid <strong>{rupees(order.payment?.amount ?? order.total)}</strong>. It goes back to them in full, and they get a WhatsApp
          message when it is sent. Use this only when we can't deliver the order; problems with delivered fruit get a replacement instead.
        </p>
      )}
      <p>{holdsStock ? 'Stock held for this order will be released.' : 'No stock is held for this order.'}</p>
    </ReasonDialog>
  )
}

/** A manager's override with a reason: marking delivered without proof, or sending out an order the API refused. */
function OverrideDialog({ order, override, onClose, onDone }: { order: Order; override: Override; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const delivered = override.to === 'DELIVERED'
  const save = useMutation({
    mutationFn: (reason: string) => api.setOrderStatus(order.id, override.to, { reason }),
    onSuccess: () => {
      toast.success(`Order ${order.number} is now ${ORDER_STATUS_LABEL[override.to]}`)
      onDone()
      onClose()
    },
    onError: (err) => {
      if (isStale(err)) {
        toast.error(CONFLICT_MESSAGE)
        onDone()
        onClose()
      }
    },
  })

  return (
    <ReasonDialog
      title={delivered ? `Mark ${order.number} delivered without proof?` : `Send ${order.number} out anyway?`}
      confirmLabel={delivered ? 'Mark delivered' : 'Send it anyway'}
      cancelLabel="Go back"
      hint="At least 3 characters. Saved on the order timeline."
      busy={save.isPending}
      error={save.isError && !isStale(save.error) ? save.error : null}
      onClose={onClose}
      onSubmit={(reason) => save.mutate(reason)}
    >
      {delivered ? (
        <p>
          Riders prove a delivery with the customer's code or a photo on the Deliveries page. Marking it here skips that, so
          someone else checks it on Needs attention.
        </p>
      ) : (
        <p>{override.why}</p>
      )}
    </ReasonDialog>
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
  return (
    <div>
      <AuthedPhoto
        className="delivery-photo"
        photoKey={`${orderId}/${photoId}`}
        load={() => api.deliveryPhotoUrl(orderId, photoId)}
        alt="Delivery photo taken by the rider"
      />
    </div>
  )
}
