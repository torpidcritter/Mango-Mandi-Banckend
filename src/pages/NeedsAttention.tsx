import { Link } from 'react-router-dom'
import { useId, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../api'
import { NOTIFICATION_LABEL, date, dateTime, humanize, rupees } from '../format'
import { useSession } from '../session'
import { MONEY_CHANGE_WHY, useStepUp } from '../StepUp'
import type { Attention, LedgerDrift, LineCounters, NotificationKind, PhotoDelivery } from '../types'
import { Dialog, FormError, PhoneLink, QueryError, ReasonDialog, Spinner, useToast } from '../ui'

const STEP_LABEL: Record<string, string> = {
  reconcile: 'Checking missed payments',
  'webhook-replay': 'Replaying stored webhooks',
  'whatsapp-messages': 'Sending WhatsApp chat replies',
  'whatsapp-templates': 'Reading WhatsApp templates from Meta',
  'partner-followups': 'Queuing Partner Network follow-up alerts',
  farm: 'Queuing farm visit reminders',
  refunds: 'Sending refunds',
  'duplicate-payments': 'Refunding second payments',
  preorders: 'Preorder jobs',
  notifications: 'Sending WhatsApp updates',
  push: 'Sending browser notifications',
  sweep: 'Releasing unpaid holds',
  'warehouse-sessions': 'Closing idle warehouse scan sessions',
  cleanup: 'Clean-up',
  retire: 'Retiring old batches',
  'rebalance-all': 'Re-checking all open orders',
  'rebalance-at-risk': 'Re-checking at-risk orders',
  audit: 'Stock audit',
  config: 'Loading rules',
  'review-requests': 'Queueing review requests',
  subscriptions: 'Setting up subscription boxes',
  'review-stats': 'Review totals check',
  backup: 'Nightly backup',
  'refund-checks': 'Checking refunds with Razorpay',
  bills: 'Issuing bills for paid orders',
  'payment-recon': "Daily check of Razorpay's payments",
  'stock-alerts': 'Sending back-in-stock alerts',
  reminders: 'Sending reorder reminders',
  retention: 'Removing old personal data',
  'funnel-retention': 'Shop funnel daily totals and clean-up',
  referrals: 'Issuing referral thank-you codes',
  'manager-summary': "Queueing the managers' evening summary",
  rebalance: 'Re-checking an order',
  health: 'Health check',
}

/** "under a second", "8.2 s", "12 s": how long a step's last try took. */
const seconds = (ms: number) => (ms < 1000 ? 'under a second' : `${ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)} s`)

/** Why a message was dropped unsent, in staff words (INT-06). */
function skippedWhy(error: string): string {
  if (error === 'older than a day') return 'it waited over a day, so the background run was not sending. Send it again if it still matters'
  if (error === 'no WhatsApp provider configured') return 'no WhatsApp provider is set up on the server'
  return error
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
  const stepUp = useStepUp(MONEY_CHANGE_WHY)
  const recover = useMutation({
    mutationFn: async ({ a, reason, reference }: { a: Exclude<Act, { kind: 'repair' }>; reason: string; reference?: string }) => {
      if (a.kind === 'resolve') return api.resolveWebhookFailure(a.hook.id, reason)
      if (a.kind === 'refund-payment') return stepUp.run((code) => api.refundUnmatchedPayment(a.hook.id, reason, code))
      if (a.kind === 'keep') return api.keepPreorder(a.preorder.id, reason)
      if (a.kind === 'recount') return api.recountPreorderCapacity(a.week.weekStart, a.week.sku, { reserved: a.week.reserved, booked: a.week.booked }, reason)
      const r = a.refund
      return stepUp.run((code) =>
        r.paymentId ? api.refundPaidAnotherWay('payment', r.paymentId, reference ?? '', reason, code) : api.refundPaidAnotherWay(r.type, r.id, reference ?? '', reason, code),
      )
    },
    onSuccess: (_r, { a }) =>
      done(
        a.kind === 'resolve'
          ? 'Webhook problem marked resolved'
          : a.kind === 'refund-payment'
            ? `Refund of ${a.hook.paymentId} queued`
            : a.kind === 'keep'
              ? `Preorder ${a.preorder.number} kept`
              : a.kind === 'recount'
                ? `Preorder capacity for ${a.week.sku} recounted`
                : `Refund for ${a.refund.number} recorded as paid back`,
      ),
    onError: (err) => {
      toast.error(err)
      // A recount refused because the bookings moved: show the new numbers.
      if (err instanceof ApiError && err.code === 'PREVIEW_CHANGED') queryClient.invalidateQueries({ queryKey: ['attention'] })
    },
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
  const boxMismatches = a.boxMismatches ?? []
  const overdue = a.overdueOrders ?? []
  const retries = a.retryDecisions ?? []
  const preorders = a.preorderDecisions ?? []
  const returned = a.returnedStock ?? []
  const preorderDrift = a.preorderCapacityDrift ?? []
  const lateTrucks = a.lateArrivals ?? []

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
            {s.failCount
              ? ` (failed ${s.failCount === 1 ? 'once' : `${s.failCount} times in a row`}${s.lastDurationMs != null ? `, the last try took ${seconds(s.lastDurationMs)}` : ''})`
              : null}
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
          {o.kind === 'day' ? (
            <>
              <strong>Retry has no delivery day</strong> for <Link to={`/orders/${o.id}`}>{o.number}</Link>
              {o.reason ? <span className="muted">: {o.reason}</span> : null}. Move it to a day with room (Move retry date on the
              order), or a manager cancels it with a refund. The customer has not been sent a new date.
            </>
          ) : (
            <>
              <strong>Retry can't go out as packed</strong> for <Link to={`/orders/${o.id}`}>{o.number}</Link>
              {o.reason ? <span className="muted">: {o.reason}</span> : null}. A manager sends a replacement, moves the date or
              cancels with a refund. The customer has not been sent a new date.
            </>
          )}
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
        {r.state === 'held' && disputeOpen(r) ? (
          <>
            <strong>Refund held</strong> for {r.type === 'order' ? <Link to={`/orders/${r.id}`}>{r.number}</Link> : r.number}, asked for
            at {dateTime(r.requestedAt)}: the customer opened chargeback {r.dispute?.id ?? 'a chargeback'} on the payment (see Payment
            disputes). Answer it in the Razorpay dashboard. If we win, the refund goes out on its own; if we lose, the bank has given
            the money back and you record it here.
          </>
        ) : r.state === 'held' ? (
          <>
            <strong>Refund held</strong> for {r.type === 'order' ? <Link to={`/orders/${r.id}`}>{r.number}</Link> : r.number}, asked for
            at {dateTime(r.requestedAt)}: chargeback {r.dispute?.id} was {humanize(r.dispute?.status ?? 'lost').toLowerCase()}, so the
            bank has already given the customer the money back. Record it as paid back another way, with the dispute id as the
            reference, so it is not refunded twice.
          </>
        ) : r.state === 'needs_manager' ? (
          <>
            <strong>Refund failed: needs a manager</strong> for {r.type === 'order' ? <Link to={`/orders/${r.id}`}>{r.number}</Link> : r.number},
            asked for at {dateTime(r.requestedAt)}. Razorpay refused it {r.attempts ?? 'several'} times, so it is not sent again on its own.
            Check the payment in the Razorpay dashboard, pay the customer back another way, and record it here.
          </>
        ) : (
          <>
            <strong>Refund not sent</strong> for {r.type === 'order' ? <Link to={`/orders/${r.id}`}>{r.number}</Link> : r.number}, asked
            for at {dateTime(r.requestedAt)}. It is tried again, waiting longer after each failure (up to an hour); check Razorpay if this stays.
          </>
        )}
        {manager && (r.state ?? 'unsent') !== 'unconfirmed' && !disputeOpen(r) ? (
          <>
            {' '}
            <button type="button" className="btn btn-small" onClick={() => setAct({ kind: 'settle', refund: r })}>
              Paid back another way<span className="sr-only"> for {r.number}</span>
            </button>
          </>
        ) : null}
      </li>
    )) },
    { key: 'drift', title: 'Stock counts to check', items: [
      ...lateTrucks.map((b) => (
        <li key={`late-${b.id}`}>
          <strong>Batch still in transit</strong>: <Link to={`/batches/${b.id}`}>{b.variety}{b.farm ? ` from ${b.farm}` : ''}</Link> was due{' '}
          {date(b.etaDate)}
          {b.promised ? <span className="muted"> ({b.promised} boxes already promised to orders)</span> : null}. Mark it arrived when it comes, or
          record a short arrival.{b.sellingPaused ? ' Until then it does not sell to new orders.' : ''}
        </li>
      )),
      ...preorderDrift.map((w) => (
        <li key={`pre-drift-${w.sku}-${w.weekStart}`}>
          <strong>Preorder capacity disagrees with the bookings</strong> for {w.sku} in the week of {date(w.weekStart)}
          <span className="muted">
            {' '}
            (taken {w.reserved}, booked {w.booked})
          </span>
          . Check that week on the <Link to="/preorders">Preorders</Link> page; if the bookings are right, recount the week from them.
          {manager ? (
            <>
              {' '}
              <button type="button" className="btn btn-small" onClick={() => setAct({ kind: 'recount', week: w })}>
                Recount from the bookings<span className="sr-only"> for {w.sku}, week of {date(w.weekStart)}</span>
              </button>
            </>
          ) : null}
        </li>
      )),
      ...drift.map((l) => (
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
    )),
      ...boxMismatches.map((w) => (
        <li key={`boxes-${w.warehouseId}`}>
          <strong>Labelled boxes disagree with the stock counts</strong> in {w.name}
          <span className="muted">
            {' '}
            ({[
              w.stockMismatches && `${w.stockMismatches} stock ${w.stockMismatches === 1 ? 'line' : 'lines'}`,
              w.orderUnitMismatches && `${w.orderUnitMismatches} ${w.orderUnitMismatches === 1 ? 'order' : 'orders'}`,
              w.impossibleStates && `${w.impossibleStates} ${w.impossibleStates === 1 ? 'box' : 'boxes'} in a wrong state`,
              w.lotCountMismatches && `${w.lotCountMismatches} ${w.lotCountMismatches === 1 ? 'lot' : 'lots'}`,
            ].filter(Boolean).join(', ')})
          </span>
          . Open <Link to="/warehouse/reports">Warehouse reports</Link> and fix the counts before selling more.
        </li>
      )),
    ] },
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
        <strong>{m.status === 'SKIPPED' ? 'WhatsApp message never sent' : 'WhatsApp message not delivered'}</strong> ({(NOTIFICATION_LABEL[m.kind as NotificationKind] ?? humanize(m.kind)).toLowerCase()}) for{' '}
        {m.order ? <Link to={`/orders/${m.order.id}`}>{m.order.number}</Link> : (m.preorderNumber ?? m.phone)}
        {m.status === 'SKIPPED' ? null : ` after ${m.attempts} tries`}
        {m.error ? <span className="muted">: {m.status === 'SKIPPED' ? skippedWhy(m.error) : m.error}</span> : null}{' '}
        <button type="button" className="btn btn-small" disabled={retry.isPending} onClick={() => retry.mutate(m.id)}>
          Send again<span className="sr-only"> for {m.order?.number ?? m.preorderNumber ?? 'this customer'}</span>
        </button>
      </li>
    )) },
    { key: 'push', title: 'Browser notifications not delivered', items: (a.failedPushes ?? []).map((m) => (
      <li key={m.id}>
        <strong>{m.status === 'PENDING' ? 'Browser notification overdue' : 'Browser notification not delivered'}</strong> ({(NOTIFICATION_LABEL[m.kind as NotificationKind] ?? humanize(m.kind)).toLowerCase()})
        {m.order ? <> for <Link to={`/orders/${m.order.id}`}>{m.order.number}</Link></> : null}
        {m.status === 'PENDING' ? '. The background run is not sending them' : ` after ${m.attempts} tries`}
        {m.error ? <span className="muted">: {m.error}</span> : null}
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
      {stepUp.dialog}
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
/** A held refund whose chargeback the bank has not decided yet: nothing to settle until it does (the API refuses it too). */
const disputeOpen = (r: StuckRefund) => r.state === 'held' && !['won', 'lost', 'closed'].includes(r.dispute?.status ?? 'open')
type PreorderDecision = NonNullable<Attention['preorderDecisions']>[number]
type PreorderDrift = NonNullable<Attention['preorderCapacityDrift']>[number]
/** A manager's way out of one item (each is recorded in the staff activity with its reason). */
type Act =
  | { kind: 'repair'; drift: LedgerDrift }
  | { kind: 'resolve'; hook: Hook }
  | { kind: 'refund-payment'; hook: Hook }
  | { kind: 'keep'; preorder: PreorderDecision }
  | { kind: 'settle'; refund: StuckRefund }
  | { kind: 'recount'; week: PreorderDrift }

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
  // A refund held by a lost chargeback is settled with the dispute id as the reference.
  const chargedBack = act.kind === 'settle' && act.refund.state === 'held' ? act.refund.dispute : null
  const [reference, setReference] = useState(chargedBack?.id ?? '')
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
  if (act.kind === 'recount') {
    const w = act.week
    return (
      <ReasonDialog
        {...common}
        tone="primary"
        title={`Recount preorder capacity for ${w.sku}?`}
        label="What you checked"
        confirmLabel="Recount"
        hint="Taken capacity is set to what the live bookings hold. Spots it frees go to the waitlist."
        onSubmit={(r) => onSave(r)}
      >
        <p className="muted">
          Week of {date(w.weekStart)}: taken {w.reserved}, the bookings hold {w.booked}. After the recount, taken is {w.booked}.
        </p>
      </ReasonDialog>
    )
  }
  if (chargedBack) {
    return (
      <ReasonDialog
        {...common}
        title={`Paid back by the bank: ${act.refund.number}`}
        label="What you checked"
        confirmLabel="Record as paid back"
        hint="Check in the Razorpay dashboard that the bank decided the chargeback against us. Retries stop; it still counts as a refund in reports."
        onSubmit={(r) => onSave(r, reference.trim())}
      >
        <div className="field">
          <label htmlFor={refId}>Dispute id</label>
          <input id={refId} value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} aria-describedby={`${refId}-hint`} />
          <p id={`${refId}-hint`} className="hint">
            The chargeback that gave the customer the money back ({humanize(chargedBack.status).toLowerCase()}).
          </p>
        </div>
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
