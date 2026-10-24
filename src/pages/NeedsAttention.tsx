import { Link } from 'react-router-dom'
import { useId, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { NOTIFICATION_LABEL, date, dateTime, humanize, rupees } from '../format'
import { useSession } from '../session'
import type { Attention, LedgerDrift, LineCounters, NotificationKind, PhotoDelivery } from '../types'
import { Dialog, FormError, PhoneLink, QueryError, ReasonDialog, Spinner, useToast } from '../ui'

const STEP_LABEL: Record<string, string> = {
  reconcile: 'Checking missed payments',
  refunds: 'Sending refunds',
  'duplicate-payments': 'Refunding second payments',
  preorders: 'Preorder jobs',
  notifications: 'Sending WhatsApp updates',
  sweep: 'Releasing unpaid holds',
  cleanup: 'Clean-up',
  retire: 'Retiring old batches',
  'rebalance-all': 'Re-checking all open orders',
  'rebalance-at-risk': 'Re-checking at-risk orders',
  audit: 'Stock audit',
  config: 'Loading rules',
  'review-requests': 'Queueing review requests',
  'review-stats': 'Review totals check',
  backup: 'Nightly backup',
  'refund-checks': 'Checking refunds with Razorpay',
  'stock-alerts': 'Sending back-in-stock alerts',
  reminders: 'Sending reorder reminders',
  retention: 'Removing old personal data',
  rebalance: 'Re-checking an order',
  health: 'Health check',
}

/** Shared with Today, which starts this query together with the summary. */
export const attentionQuery = { queryKey: ['attention'], queryFn: api.attention, refetchInterval: 60_000 } as const

/**
 * The problems nobody is watching for: the background loop stalling or failing,
 * WhatsApp messages given up on, refunds that haven't gone through, and webhooks
 * that failed or named an order we don't have. Hidden when all is well; a failed
 * load says so, with a retry.
 */
export default function NeedsAttention() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const q = useQuery(attentionQuery)
  const retry = useMutation({
    mutationFn: (id: string) => api.retryMessage(id),
    onSuccess: () => {
      toast.success('Message queued to send again')
      queryClient.invalidateQueries({ queryKey: ['attention'] })
    },
    onError: (err) => toast.error(err),
  })

  const { me } = useSession()
  const manager = me?.role === 'MANAGER'
  const [doubting, setDoubting] = useState<PhotoDelivery | null>(null)
  const [act, setAct] = useState<Act | null>(null)
  const done = (text: string) => {
    toast.success(text)
    setAct(null)
    queryClient.invalidateQueries({ queryKey: ['attention'] })
  }
  const recover = useMutation({
    mutationFn: async ({ a, reason, reference }: { a: Exclude<Act, { kind: 'repair' }>; reason: string; reference?: string }) => {
      if (a.kind === 'resolve') return api.resolveWebhookFailure(a.hook.id, reason)
      if (a.kind === 'refund-payment') return api.refundUnmatchedPayment(a.hook.id, reason)
      if (a.kind === 'keep') return api.keepPreorder(a.preorder.id, reason)
      const r = a.refund
      return r.paymentId ? api.refundPaidAnotherWay('payment', r.paymentId, reference ?? '', reason) : api.refundPaidAnotherWay(r.type, r.id, reference ?? '', reason)
    },
    onSuccess: (_r, { a }) =>
      done(
        a.kind === 'resolve'
          ? 'Webhook problem marked resolved'
          : a.kind === 'refund-payment'
            ? `Refund of ${a.hook.paymentId} queued`
            : a.kind === 'keep'
              ? `Preorder ${a.preorder.number} kept`
              : `Refund for ${a.refund.number} recorded as paid back`,
      ),
    onError: (err) => toast.error(err),
  })
  const check = useMutation({
    mutationFn: ({ d, ok, note }: { d: PhotoDelivery; ok: boolean; note?: string }) => api.reviewDelivery(d.id, ok, note),
    onSuccess: (_r, { d, ok }) => {
      toast.success(ok ? `Delivery of ${d.order.number} checked` : `${d.order.number} flagged: call the customer`)
      setDoubting(null)
      queryClient.invalidateQueries({ queryKey: ['attention'] })
    },
    onError: (err) => toast.error(err),
  })

  // FE-4: this is the only alerting surface, so a failed load must show, never look calm.
  const loadError = q.isError ? (
    <>
      <p>
        <strong>Could not load alerts.</strong> Problems that need you may be hidden until they load.
      </p>
      <QueryError error={q.error} onRetry={() => q.refetch()} />
    </>
  ) : null
  if (!q.data) {
    // A load that failed before is asked again (Retry, or every minute): keep the card meanwhile.
    if (!loadError && q.errorUpdateCount === 0) return null
    return (
      <section className="card attention" aria-labelledby="attention-title">
        <h2 id="attention-title">Needs attention</h2>
        {loadError ?? <p role="status">Loading alerts again…</p>}
      </section>
    )
  }
  const a = q.data
  const calls = a.failedDeliveries ?? []
  const low = a.lowRatings ?? []
  const photos = (a.photoDeliveries ?? []).filter((d) => d.method !== 'staff')
  const noProof = (a.photoDeliveries ?? []).filter((d) => d.method === 'staff')
  const drift = a.ledgerDrift ?? []
  const overdue = a.overdueOrders ?? []
  const retries = a.retryDecisions ?? []
  const preorders = a.preorderDecisions ?? []
  const returned = a.returnedStock ?? []

  const photoItem = (d: PhotoDelivery) => (
    <li key={`photo-${d.id}`}>
      <strong>{d.method === 'staff' ? 'Check a delivery marked without proof' : 'Check a photo delivery'}</strong> of{' '}
      <Link to={`/orders/${d.order.id}`}>{d.order.number}</Link> by {d.actor} at {dateTime(d.at)}
      {d.receivedBy ? <span className="muted">, left with {d.receivedBy}</span> : null}
      {d.method === 'staff' && d.note ? <span className="muted">: {d.note}</span> : null}
      {d.flags.length ? <span className="badge badge-warn"> {d.flags.join(', ')}</span> : null}{' '}
      <span className="attention-actions">
        <button type="button" className="btn btn-small" disabled={check.isPending} onClick={() => check.mutate({ d, ok: true })}>
          Looks right<span className="sr-only"> for {d.order.number}</span>
        </button>
        <button type="button" className="btn btn-small" onClick={() => setDoubting(d)}>
          Doubtful<span className="sr-only"> for {d.order.number}</span>
        </button>
      </span>
    </li>
  )

  // One group per kind of problem, most urgent first. Each shows a few items and a "Show all".
  const groups: AttentionGroup[] = [
    {
      key: 'loop',
      title: 'Background jobs',
      items: [
        ...(a.loop.stale
          ? [
              <li key="stale">
                <strong>The background loop has stopped.</strong>{' '}
                {a.loop.lastRunAt ? `It last ran at ${dateTime(a.loop.lastRunAt)}.` : 'It has not run yet.'} Payments, refunds, WhatsApp
                updates and hold releases wait until it runs again. On Vercel, check the every-minute scheduler that calls
                /internal/maintenance (runbooks, Scheduler stopped); on the Docker server, restart the API.
              </li>,
            ]
          : []),
        ...(a.backup?.stale
          ? [
              <li key="backup">
                <strong>No backup in the last 26 hours.</strong>{' '}
                {a.backup.lastOkAt ? `The last one finished at ${dateTime(a.backup.lastOkAt)}.` : 'No backup has been recorded yet.'} On
                Vercel, check the Backup workflow in GitHub Actions; on the Docker server, the backup service (docker compose logs
                backup).
              </li>,
            ]
          : []),
        ...a.loop.failingSteps.map((s) => (
          <li key={s.step}>
            <strong>{STEP_LABEL[s.step] ?? s.step} is failing</strong> since {dateTime(s.since)}
            {s.error ? <span className="muted">: {s.error}</span> : null}
          </li>
        )),
      ],
    },
    {
      key: 'overdue',
      title: 'Overdue deliveries',
      items: overdue.map((o) => (
        <li key={`overdue-${o.id}`}>
          <strong>Overdue:</strong> <Link to={`/orders/${o.id}`}>{o.number}</Link> was due {date(o.deliveryDate)}
          <span className="muted">: {o.reason}</span>. Find out where it is and tell the customer.
        </li>
      )),
    },
    {
      key: 'retry',
      title: 'Missed deliveries for a manager',
      items: retries.map((o) => (
        <li key={`retry-${o.id}`}>
          <strong>Retry can't go out as packed</strong> for <Link to={`/orders/${o.id}`}>{o.number}</Link>
          {o.reason ? <span className="muted">: {o.reason}</span> : null}. A manager sends a replacement, moves the date or
          cancels with a refund. The customer has not been sent a new date.
        </li>
      )),
    },
    {
      key: 'calls',
      title: 'Call the customer',
      items: calls.map((o) => (
        <li key={`call-${o.id}`}>
          <strong>Call the customer</strong> for <Link to={`/orders/${o.id}`}>{o.number}</Link>: {o.attempts} deliveries missed
          {o.name || o.phone ? (
            <span className="muted">
              {' '}
              ({o.name}
              {o.name && o.phone ? ', ' : null}
              {o.phone && <PhoneLink phone={o.phone} who={o.name ?? 'the customer'} />})
            </span>
          ) : null}
          . It won't be sent out again until a manager sends it from the order page.
        </li>
      )),
    },
    { key: 'refunds', title: 'Refunds not sent', items: a.stuckRefunds.map((r) => (
      <li key={`${r.type}-${r.id}-${r.number}`}>
        <strong>Refund not sent</strong> for {r.type === 'order' ? <Link to={`/orders/${r.id}`}>{r.number}</Link> : r.number}, asked
        for at {dateTime(r.requestedAt)}. It retries every minute; check Razorpay if this stays.
        {manager && (r.state ?? 'unsent') === 'unsent' ? (
          <>
            {' '}
            <button type="button" className="btn btn-small" onClick={() => setAct({ kind: 'settle', refund: r })}>
              Paid back another way<span className="sr-only"> for {r.number}</span>
            </button>
          </>
        ) : null}
      </li>
    )) },
    { key: 'drift', title: 'Stock counts to check', items: drift.map((l) => (
      <li key={`drift-${l.lineId}`}>
        <strong>Stock counts disagree with the ledger</strong> for {l.sku} in <Link to={`/batches/${l.batchId}`}>its batch</Link>
        <span className="muted">
          {' '}
          (on hand {l.onHand[0]} vs {l.onHand[1]}, held {l.held[0]} vs {l.held[1]}, to pack {l.committed[0]} vs {l.committed[1]})
        </span>
        . Check the batch before selling more from it.
        {manager ? (
          <>
            {' '}
            <button type="button" className="btn btn-small" onClick={() => setAct({ kind: 'repair', drift: l })}>
              Repair from the ledger<span className="sr-only"> for {l.sku}</span>
            </button>
          </>
        ) : null}
      </li>
    )) },
    { key: 'returned', title: 'Returned boxes to book', items: returned.map((r) => (
      <li key={`returned-${r.id}`}>
        <strong>
          {r.boxes} {r.boxes === 1 ? 'box' : 'boxes'} from <Link to={`/orders/${r.id}`}>{r.number}</Link>
        </strong>{' '}
        ({r.status === 'RTO' ? 'returned' : 'cancelled after it left'}): put them back on the shelf or write them off from the order page.
      </li>
    )) },
    { key: 'preorders', title: 'Preorders for a manager', items: preorders.map((p) => (
      <li key={`pre-${p.id}`}>
        <strong>Preorder {p.number}</strong> ({p.qty} × {p.sku}{p.customerName ? `, ${p.customerName}` : ''})
        <span className="muted">: {p.reason}</span>. A manager keeps it or <Link to="/preorders">cancels it with a refund</Link>.
        {manager ? (
          <>
            {' '}
            <button type="button" className="btn btn-small" onClick={() => setAct({ kind: 'keep', preorder: p })}>
              Keep booking<span className="sr-only"> {p.number}</span>
            </button>
          </>
        ) : null}
      </li>
    )) },
    { key: 'no-proof', title: 'Deliveries marked without proof', items: noProof.map(photoItem) },
    { key: 'photos', title: 'Photo deliveries to check', items: photos.map(photoItem) },
    { key: 'messages', title: 'WhatsApp messages not delivered', items: a.failedMessages.map((m) => (
      <li key={m.id}>
        <strong>WhatsApp message not delivered</strong> ({(NOTIFICATION_LABEL[m.kind as NotificationKind] ?? humanize(m.kind)).toLowerCase()}) for{' '}
        {m.order ? <Link to={`/orders/${m.order.id}`}>{m.order.number}</Link> : (m.preorderNumber ?? m.phone)} after {m.attempts} tries
        {m.error ? <span className="muted">: {m.error}</span> : null}{' '}
        <button type="button" className="btn btn-small" disabled={retry.isPending} onClick={() => retry.mutate(m.id)}>
          Send again<span className="sr-only"> for {m.order?.number ?? m.preorderNumber ?? 'this customer'}</span>
        </button>
      </li>
    )) },
    { key: 'reviews', title: 'Low ratings', items: low.length > 0 ? [
      <li key="low">
        <strong>
          {low.length} new {low.length === 1 ? 'review' : 'reviews'} with 1 or 2 stars
        </strong>{' '}
        ({low.map((r) => r.order.number).join(', ')}). <Link to="/reviews">Read them</Link> and check whether the customer
        needs help. A review never opens a claim by itself.
      </li>,
    ] : [] },
    { key: 'disputes', title: 'Payment disputes', items: (a.disputes ?? []).map((d) => (
      <li key={`dispute-${d.id}`}>
        <strong>Payment disputed</strong> ({humanize(d.status).toLowerCase()}) for{' '}
        {d.order ? <Link to={`/orders/${d.order.id}`}>{d.order.number}</Link> : (d.preorderNumber ?? d.paymentId ?? 'a payment')}
        {d.amount != null ? `, ${rupees(d.amount)}` : null}. Answer it in the Razorpay dashboard, under Disputes
        {d.respondBy ? `, by ${dateTime(d.respondBy)}` : null}.
        {d.reasonCode ? <span className="muted"> Reason: {d.reasonCode}</span> : null}
      </li>
    )) },
    { key: 'webhooks', title: 'Webhook problems', items: a.webhookFailures.map((w) => (
      <li key={w.id}>
        <strong>{w.source === 'razorpay' ? 'Razorpay' : 'WhatsApp'} webhook problem</strong> at {dateTime(w.createdAt)}
        <span className="muted">: {w.reason}</span>
        {manager ? (
          <span className="attention-actions">
            {' '}
            {w.refundable ? (
              <button type="button" className="btn btn-small" onClick={() => setAct({ kind: 'refund-payment', hook: w })}>
                Refund this payment<span className="sr-only"> {w.paymentId}</span>
              </button>
            ) : null}
            <button type="button" className="btn btn-small" onClick={() => setAct({ kind: 'resolve', hook: w })}>
              Mark resolved<span className="sr-only"> for the problem at {dateTime(w.createdAt)}</span>
            </button>
          </span>
        ) : null}
      </li>
    )) },
  ].filter((g) => g.items.length > 0)
  if (groups.length === 0 && !loadError) return null

  return (
    <section className="card attention" aria-labelledby="attention-title">
      <h2 id="attention-title">Needs attention</h2>
      {loadError}
      {groups.map((g) => (
        <AttentionGroupView key={g.key} group={g} />
      ))}
      {act?.kind === 'repair' && <RepairDialog drift={act.drift} onClose={() => setAct(null)} onDone={() => done(`Stock counts for ${act.drift.sku} repaired`)} />}
      {act && act.kind !== 'repair' && (
        <RecoveryDialog act={act} pending={recover.isPending} error={recover.error} onClose={() => setAct(null)} onSave={(reason, reference) => recover.mutate({ a: act, reason, reference })} />
      )}
      {doubting && <DoubtDialog d={doubting} pending={check.isPending} error={check.error} onClose={() => setDoubting(null)} onSave={(note) => check.mutate({ d: doubting, ok: false, note })} />}
    </section>
  )
}

interface AttentionGroup {
  key: string
  title: string
  items: ReactNode[]
}

/** How many items a group shows before "Show all". */
const FIRST_FEW = 3

/** One kind of problem: a heading with its count, the first few items, and "Show all N". */
function AttentionGroupView({ group }: { group: AttentionGroup }) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const more = group.items.length - FIRST_FEW
  return (
    <div className="attention-group">
      <h3>
        {group.title} <span className="attention-count">{group.items.length}</span>
      </h3>
      <ul className="attention-list" id={listId}>
        {open ? group.items : group.items.slice(0, FIRST_FEW)}
      </ul>
      {more > 0 && (
        <button type="button" className="link-btn" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
          {open ? 'Show fewer' : `Show all ${group.items.length}`}
          <span className="sr-only"> {group.title.toLowerCase()}</span>
        </button>
      )}
    </div>
  )
}

function DoubtDialog({ d, pending, error, onClose, onSave }: { d: PhotoDelivery; pending: boolean; error: unknown; onClose: () => void; onSave: (note: string) => void }) {
  return (
    <ReasonDialog
      title={`What looks wrong with ${d.order.number}?`}
      tone="primary"
      label="Note for the order history"
      hint="Say what looks wrong. The order stays delivered. Someone calls the customer to check they got it."
      minLength={1}
      maxLength={300}
      confirmLabel="Flag for a call"
      busy={pending}
      error={error}
      onClose={onClose}
      onSubmit={onSave}
    />
  )
}

type Hook = Attention['webhookFailures'][number]
type StuckRefund = Attention['stuckRefunds'][number]
type PreorderDecision = NonNullable<Attention['preorderDecisions']>[number]
/** A manager's way out of one item (each is recorded in the staff activity with its reason). */
type Act =
  | { kind: 'repair'; drift: LedgerDrift }
  | { kind: 'resolve'; hook: Hook }
  | { kind: 'refund-payment'; hook: Hook }
  | { kind: 'keep'; preorder: PreorderDecision }
  | { kind: 'settle'; refund: StuckRefund }

function RecoveryDialog({
  act,
  pending,
  error,
  onClose,
  onSave,
}: {
  act: Exclude<Act, { kind: 'repair' }>
  pending: boolean
  error: unknown
  onClose: () => void
  onSave: (reason: string, reference?: string) => void
}) {
  const refId = useId()
  const [reference, setReference] = useState('')
  const common = { busy: pending, error, onClose, maxLength: 500 }
  if (act.kind === 'resolve') {
    return (
      <ReasonDialog
        {...common}
        tone="primary"
        title="Mark this webhook problem resolved"
        label="What you checked or fixed"
        confirmLabel="Mark resolved"
        hint="It leaves Needs attention; the note is kept with it."
        onSubmit={(r) => onSave(r)}
      >
        <p className="muted">{act.hook.reason}</p>
      </ReasonDialog>
    )
  }
  if (act.kind === 'refund-payment') {
    return (
      <ReasonDialog
        {...common}
        title={`Refund payment ${act.hook.paymentId}?`}
        label="Why it bought nothing"
        confirmLabel="Refund in full"
        hint="Check in the Razorpay dashboard first that this payment bought nothing here. The full amount goes back, like a second payment."
        onSubmit={(r) => onSave(r)}
      >
        <p className="muted">{act.hook.reason}</p>
      </ReasonDialog>
    )
  }
  if (act.kind === 'keep') {
    return (
      <ReasonDialog
        {...common}
        tone="primary"
        title={`Keep preorder ${act.preorder.number}?`}
        label="Why keep it"
        confirmLabel="Keep booking"
        hint="The booking stays as it is and leaves Needs attention. It comes back if it is moved again."
        onSubmit={(r) => onSave(r)}
      >
        <p className="muted">{act.preorder.reason}</p>
      </ReasonDialog>
    )
  }
  return (
    <ReasonDialog
      {...common}
      title={`Paid back another way: ${act.refund.number}`}
      label="Why Razorpay can't refund it"
      confirmLabel="Record as paid back"
      hint="Only once you have paid the customer back yourself. Retries stop; it still counts as a refund in reports."
      onSubmit={(r) => onSave(r, reference.trim())}
    >
      <div className="field">
        <label htmlFor={refId}>Reference of your payment</label>
        <input id={refId} value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} aria-describedby={`${refId}-hint`} />
        <p id={`${refId}-hint`} className="hint">
          The bank transfer's UTR or the UPI reference. At least 3 characters.
        </p>
      </div>
    </ReasonDialog>
  )
}

const COUNTER_LABEL: [keyof LineCounters, string][] = [
  ['onHand', 'On hand'],
  ['reserveBuffer', 'Reserve buffer'],
  ['held', 'Held'],
  ['committed', 'To pack'],
]

/** Shows what a repair would change (fetched fresh), then applies exactly that, with a reason. */
function RepairDialog({ drift, onClose, onDone }: { drift: LedgerDrift; onClose: () => void; onDone: () => void }) {
  const plan = useQuery({ queryKey: ['ledger-repair', drift.batchId, drift.lineId], queryFn: () => api.ledgerRepairPlan(drift.batchId, drift.lineId), gcTime: 0 })
  const p = plan.data
  const apply = useMutation({
    mutationFn: ({ reason, expected }: { reason: string; expected: LineCounters }) => api.repairLedger(drift.batchId, drift.lineId, reason, expected),
    onSuccess: () => onDone(),
    // The stock moved since the preview (or the repair was refused): show the new numbers.
    onError: () => plan.refetch(),
  })
  const title = `Repair stock counts for ${drift.sku}`
  if (!p || !p.drifting || !p.canRepair || !p.before || !p.after) {
    return (
      <Dialog
        title={title}
        onClose={onClose}
        footer={
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        }
      >
        {plan.isPending ? <Spinner label="Working out the repair" /> : null}
        {plan.isError ? <FormError error={plan.error} /> : null}
        {p && !p.drifting ? <p>The counts already agree with the ledger. Nothing to repair.</p> : null}
        {p?.problem ? <p role="alert">{p.problem}</p> : null}
      </Dialog>
    )
  }
  const { before, after } = p
  return (
    <ReasonDialog
      title={title}
      tone="primary"
      label="Why the counts drifted"
      confirmLabel="Repair counts"
      busy={apply.isPending}
      error={apply.error}
      maxLength={500}
      hint="The counts are set to what the ledger and the orders say. The ledger is not changed; the repair is added to it as a note."
      onClose={onClose}
      onSubmit={(reason) => apply.mutate({ reason, expected: after })}
    >
      <table className="table">
        <caption className="sr-only">Counts now and after the repair</caption>
        <thead>
          <tr>
            <th scope="col">Count</th>
            <th scope="col">Now</th>
            <th scope="col">After repair</th>
          </tr>
        </thead>
        <tbody>
          {COUNTER_LABEL.map(([k, label]) => (
            <tr key={k}>
              <th scope="row">{label}</th>
              <td>{before[k]}</td>
              <td>{after[k] !== before[k] ? <strong>{after[k]}</strong> : after[k]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ReasonDialog>
  )
}
