import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api } from '../api'
import { ADJUST_REASON_LABEL, BATCH_STATUS_LABEL, CONDITION_LABEL, LEDGER_EVENT_LABEL, RIPENESS_LABEL, actorLabel, date, dateTime, humanize } from '../format'
import { can, canSee } from '../permissions'
import { useSession } from '../session'
import { BATCH_FLOW, type AdjustReason, type BatchDetail as Batch, type BatchLine, type BatchStatus, type Condition, type LedgerEntry, type Ripeness } from '../types'
import {
  BackLink,
  BatchBadge,
  ConfirmDialog,
  Dialog,
  DisabledReason,
  EmptyState,
  FormError,
  GatedButton,
  ManagerOnlyNote,
  QueryError,
  ReasonDialog,
  Spinner,
  Tabs,
  tabPanelProps,
  useToast,
  scrollRegion,
  usePageTitle,
} from '../ui'

/** Forward-only: every later step in the flow is reachable; the next one is primary. */
function forwardSteps(status: BatchStatus): BatchStatus[] {
  const i = BATCH_FLOW.indexOf(status)
  return i < 0 ? [] : BATCH_FLOW.slice(i + 1)
}

function isFinal(status: BatchStatus) {
  return status === 'EXHAUSTED' || status === 'CONDEMNED'
}

export default function BatchDetail() {
  const { id = '' } = useParams()
  const q = useQuery({ queryKey: ['batch', id], queryFn: () => api.batch(id) })
  usePageTitle(q.data ? `${q.data.variety} batch, plucked ${date(q.data.pluckedOn)}` : q.isError ? 'Batch not found' : 'Batch')

  if (q.isPending) return <Spinner />
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404) {
      return (
        <div className="card">
          <h1>Batch not found</h1>
          <Link to="/batches">Back to batches</Link>
        </div>
      )
    }
    return <QueryError error={q.error} onRetry={() => q.refetch()} />
  }
  return <BatchView batch={q.data} />
}

function BatchView({ batch }: { batch: Batch }) {
  const [adjusting, setAdjusting] = useState<BatchLine | null>(null)
  const [counting, setCounting] = useState(false)
  const [params] = useSearchParams()
  const [tab, setTab] = useState<'qc' | 'ledger'>('qc')

  return (
    <>
      <BackLink to="/batches">Batches</BackLink>
      <div className="topbar">
        <h1>
          {batch.variety} <span className="muted small">plucked {date(batch.pluckedOn)}</span>
        </h1>
        <BatchBadge status={batch.status} />
        <span className={batch.ageDays >= 5 ? 'text-warn' : 'muted'}>{batch.ageDays} days old</span>
        {batch.farm && <span className="muted">Farm: {batch.farm}</span>}
      </div>

      <StatusControls batch={batch} />

      <section className="card">
        <div className="topbar section-head">
          <h2>Stock</h2>
          <span className="spacer" />
          {!isFinal(batch.status) && (
            <button type="button" className="btn" onClick={() => setCounting(true)}>
              Count stock
            </button>
          )}
        </div>
        <div {...scrollRegion('Stock per SKU')}>
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th className="num">On hand</th>
                <th className="num">
                  <abbr title="Reserved by customers who have not paid yet">Unpaid</abbr>
                </th>
                <th className="num">
                  <abbr title="Paid, not yet packed">To pack</abbr>
                </th>
                <th className="num">Reserve buffer</th>
                <th className="num">Available</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {batch.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.productName ?? l.sku}
                    {l.productName && <div className="muted small">{l.sku}</div>}
                  </td>
                  <td className="num">{l.onHand}</td>
                  <td className="num">{l.held}</td>
                  <td className="num">{l.committed}</td>
                  <td className="num">{l.reserveBuffer}</td>
                  <td className="num">
                    <strong>{l.available}</strong>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => setAdjusting(l)}
                      disabled={batch.status === 'CONDEMNED'}
                    >
                      Adjust<span className="sr-only"> {l.sku}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {batch.status === 'CONDEMNED' && <DisabledReason>A condemned batch's stock can't be adjusted.</DisabledReason>}
      </section>

      <section className="card">
        <Tabs
          id="batch"
          label="QC and ledger"
          tabs={[
            ['qc', 'QC'],
            ['ledger', 'Ledger'],
          ]}
          value={tab}
          onChange={setTab}
        />
        <div {...tabPanelProps('batch', tab)}>
          {tab === 'qc' ? <QcPanel batch={batch} focus={params.get('focusQC') === '1'} /> : <LedgerPanel batchId={batch.id} />}
        </div>
      </section>

      {adjusting && <AdjustDialog batchId={batch.id} line={adjusting} onClose={() => setAdjusting(null)} />}
      {counting && <CountDialog batch={batch} onClose={() => setCounting(false)} />}
    </>
  )
}

function StatusControls({ batch }: { batch: Batch }) {
  const { me } = useSession()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [confirmCondemn, setConfirmCondemn] = useState(false)
  const [condemned, setCondemned] = useState<{ moved: string[]; atRisk: string[] } | null>(null)
  // Exhausting a batch with boxes still on hand writes them off: a manager's call, with a reason.
  const [exhausting, setExhausting] = useState(false)
  const exhaustReason = useRef('')
  // Skipping steps (Arriving straight to Selling) asks first, naming the steps it jumps over.
  const [skipping, setSkipping] = useState<BatchStatus | null>(null)
  const left = batch.lines.reduce((n, l) => n + l.onHand, 0)
  const manager = me?.role === 'MANAGER'
  // Condemning is shown (disabled) to operators, who escalate it; roles that never handle it don't see it.
  const showCondemn = manager || me?.role === 'OPERATOR'

  const move = useMutation({
    mutationFn: (status: BatchStatus) => api.setBatchStatus(batch.id, status, status === 'EXHAUSTED' && left > 0 ? exhaustReason.current : undefined),
    onSuccess: (res, status) => {
      queryClient.invalidateQueries({ queryKey: ['batch', batch.id] })
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      queryClient.invalidateQueries({ queryKey: ['summary'] })
      setExhausting(false)
      setSkipping(null)
      if (status === 'CONDEMNED') {
        setConfirmCondemn(false)
        setCondemned({ moved: res?.rebalancedOrders ?? [], atRisk: res?.atRiskOrders ?? [] })
      } else {
        toast.success(`Batch moved to ${BATCH_STATUS_LABEL[status]}`)
      }
    },
    onError: (err) => {
      if (!confirmCondemn && !exhausting && !skipping) toast.error(err)
    },
  })

  const steps = forwardSteps(batch.status)
  const [next, ...skips] = steps
  const writeOffGated = steps.includes('EXHAUSTED') && left > 0

  return (
    <section className="card">
      <h2>Status</h2>
      {isFinal(batch.status) ? (
        <p className="muted">
          This batch is {BATCH_STATUS_LABEL[batch.status].toLowerCase()}. Its status can no longer change.
        </p>
      ) : (
        <div className="btn-row">
          {next &&
            (next === 'EXHAUSTED' && left > 0 ? (
              <GatedButton allowed={manager} className="btn btn-primary" disabled={move.isPending} onClick={() => setExhausting(true)}>
                Move to {BATCH_STATUS_LABEL[next]}
              </GatedButton>
            ) : (
              <button type="button" className="btn btn-primary" disabled={move.isPending} onClick={() => move.mutate(next)}>
                Move to {BATCH_STATUS_LABEL[next]}
              </button>
            ))}
          {skips.map((s) =>
            s === 'EXHAUSTED' && left > 0 ? (
              <GatedButton key={s} allowed={manager} className="btn" disabled={move.isPending} onClick={() => setExhausting(true)}>
                Skip to {BATCH_STATUS_LABEL[s]}
              </GatedButton>
            ) : (
              <button
                key={s}
                type="button"
                className="btn"
                disabled={move.isPending}
                onClick={() => {
                  move.reset()
                  setSkipping(s)
                }}
              >
                Skip to {BATCH_STATUS_LABEL[s]}
              </button>
            ),
          )}
          <span className="grow" />
          {showCondemn && (
            <GatedButton allowed={can(me?.role, 'condemnBatch')} className="btn btn-danger" onClick={() => setConfirmCondemn(true)}>
              Condemn batch
            </GatedButton>
          )}
        </div>
      )}

      {skipping && (
        <ConfirmDialog
          title={`Skip to ${BATCH_STATUS_LABEL[skipping]}?`}
          confirmLabel={`Move to ${BATCH_STATUS_LABEL[skipping]}`}
          busy={move.isPending}
          error={move.error}
          onClose={() => setSkipping(null)}
          onConfirm={() => move.mutate(skipping)}
        >
          <p>
            This jumps over {steps.slice(0, steps.indexOf(skipping)).map((x) => BATCH_STATUS_LABEL[x]).join(', ')}. Batches only move forward, so it can't
            be undone.
          </p>
        </ConfirmDialog>
      )}

      {exhausting && (
        <ReasonDialog
          title="Write off the rest of this batch?"
          confirmLabel={`Write off ${left} boxes`}
          cancelLabel="Keep batch"
          hint="At least 3 characters. Saved in the batch ledger."
          busy={move.isPending}
          error={move.error}
          onClose={() => setExhausting(false)}
          onSubmit={(reason) => {
            exhaustReason.current = reason
            move.mutate('EXHAUSTED')
          }}
        >
          <p>
            {left} boxes are still on hand. Marking the batch exhausted writes them off for good; it cannot be undone.
          </p>
        </ReasonDialog>
      )}

      {confirmCondemn && (
        <ConfirmDialog
          title="Condemn this batch?"
          tone="danger"
          confirmLabel="Condemn and move orders"
          cancelLabel="Keep batch"
          busyLabel="Condemning…"
          busy={move.isPending}
          error={move.error}
          onClose={() => setConfirmCondemn(false)}
          onConfirm={() => move.mutate('CONDEMNED')}
        >
          <p>
            This cannot be undone. Its remaining stock is written off. Open orders holding this batch are moved to
            another batch of the same ripeness where stock allows; any that can't be moved are flagged{' '}
            <strong>at risk</strong> for you to sort out. No order is cancelled.
          </p>
        </ConfirmDialog>
      )}

      {condemned && (
        <Dialog
          title="Batch condemned"
          onClose={() => setCondemned(null)}
          footer={
            <button type="button" className="btn btn-primary" onClick={() => setCondemned(null)}>
              Done
            </button>
          }
        >
          {condemned.moved.length === 0 && condemned.atRisk.length === 0 && <p>No open orders were holding this batch.</p>}
          {condemned.moved.length > 0 && (
            <>
              <p>These orders were moved to other batches:</p>
              <ul>
                {condemned.moved.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </>
          )}
          {condemned.atRisk.length > 0 && (
            <>
              <p>
                <strong>These orders are at risk</strong> because no other stock could cover them. Find them on the
                Today page:
              </p>
              <ul>
                {condemned.atRisk.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </>
          )}
        </Dialog>
      )}
      {!manager && !isFinal(batch.status) && (showCondemn || writeOffGated) && (
        <ManagerOnlyNote
          what={
            showCondemn && writeOffGated
              ? 'Condemning a batch or writing off boxes still on hand'
              : showCondemn
                ? 'Condemning a batch'
                : 'Writing off boxes still on hand'
          }
        />
      )}
    </section>
  )
}

function QcPanel({ batch, focus }: { batch: Batch; focus: boolean }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [ripeness, setRipeness] = useState<Ripeness | ''>('')
  const [condition, setCondition] = useState<Condition | ''>('')
  const [notes, setNotes] = useState('')
  const [warning, setWarning] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (!focus || !formRef.current) return
    formRef.current.scrollIntoView({ block: 'center' })
    formRef.current.querySelector<HTMLInputElement>('input')?.focus()
  }, [focus])

  const log = useMutation({
    mutationFn: () =>
      api.logQc(batch.id, {
        ripenessRating: ripeness as Ripeness,
        condition: condition as Condition,
        notes: notes.trim() || undefined,
      }),
    onSuccess: (res) => {
      setWarning(res?.warning ?? null)
      setRipeness('')
      setCondition('')
      setNotes('')
      toast.success('QC logged')
      queryClient.invalidateQueries({ queryKey: ['batch', batch.id] })
      queryClient.invalidateQueries({ queryKey: ['batches'] })
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (ripeness && condition) log.mutate()
  }

  return (
    <>
      <form ref={formRef} onSubmit={onSubmit} aria-label="Log QC">
        <fieldset>
          <legend>Ripeness</legend>
          <div className="radio-row">
            {(Object.keys(RIPENESS_LABEL) as Ripeness[]).map((r) => (
              <label key={r}>
                <input type="radio" name="ripeness" value={r} checked={ripeness === r} onChange={() => setRipeness(r)} />
                {RIPENESS_LABEL[r]}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Condition</legend>
          <div className="radio-row">
            {(Object.keys(CONDITION_LABEL) as Condition[]).map((c) => (
              <label key={c}>
                <input type="radio" name="condition" value={c} checked={condition === c} onChange={() => setCondition(c)} />
                {CONDITION_LABEL[c]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="field">
          <label htmlFor="qc-notes">Notes (optional)</label>
          <textarea id="qc-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {warning && (
          <p className="notice notice-warn" role="status">
            {warning}. The new entry supersedes the earlier one.
          </p>
        )}
        <FormError error={log.error} />
        <button type="submit" className="btn btn-primary" disabled={!ripeness || !condition || log.isPending}>
          {log.isPending ? 'Saving…' : 'Log QC'}
        </button>
      </form>

      <h3 className="mt-5">History</h3>
      {batch.qc.length === 0 ? (
        <EmptyState>No QC logged yet. This batch is not sellable until QC is logged.</EmptyState>
      ) : (
        <div {...scrollRegion('QC history')}>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Ripeness</th>
                <th>Condition</th>
                <th>Notes</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {batch.qc.map((e) => (
                <tr key={e.id}>
                  <td>{dateTime(e.loggedAt)}</td>
                  <td>{RIPENESS_LABEL[e.ripenessRating] ?? e.ripenessRating}</td>
                  <td className={e.condition === 'REJECT' ? 'text-danger' : undefined}>
                    {CONDITION_LABEL[e.condition] ?? e.condition}
                  </td>
                  <td>{e.notes ?? '—'}</td>
                  <td>{e.loggedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

/** "SELLING → CONDEMNED: mould" (a status change's reason) → "Selling → Condemned: mould". */
function ledgerReason(e: LedgerEntry): string {
  if (!e.reason) return '—'
  return e.reason.replace(/^([A-Z_]+) → ([A-Z_]+)/, (_m, from: string, to: string) =>
    `${BATCH_STATUS_LABEL[from as BatchStatus] ?? humanize(from)} → ${BATCH_STATUS_LABEL[to as BatchStatus] ?? humanize(to)}`,
  )
}

function LedgerPanel({ batchId }: { batchId: string }) {
  // Loaded lazily: this component only mounts when the Ledger tab is open.
  const q = useQuery({ queryKey: ['ledger', batchId], queryFn: () => api.ledger(batchId) })
  // Some steps record the staff id, not the email: managers can see the staff list to name them.
  const { me } = useSession()
  const staff = useQuery({ queryKey: ['staff'], queryFn: api.staff, enabled: canSee(me?.role, 'staff') })
  const staffEmail = (staffId: string) => staff.data?.find((m) => m.id === staffId)?.email
  if (q.isPending) return <Spinner label="Loading ledger" />
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} />
  if (q.data.length === 0) return <EmptyState>No stock movements yet.</EmptyState>
  return (
    <div {...scrollRegion('Stock ledger')}>
      <table>
        <thead>
          <tr>
            <th>Event</th>
            <th>SKU</th>
            <th className="num">Change</th>
            <th>By</th>
            <th>Reason</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {q.data.map((e, i) => (
            <tr key={e.id ?? i}>
              <td>{LEDGER_EVENT_LABEL[e.eventType] ?? humanize(e.eventType)}</td>
              <td>{e.sku ?? '—'}</td>
              <td className={`num ${e.delta < 0 ? 'text-danger' : e.delta > 0 ? 'text-good' : ''}`}>
                {e.delta > 0 ? `+${e.delta}` : e.delta}
              </td>
              <td>{e.actorEmail ?? actorLabel(e.actorId, e.actorType, staffEmail)}</td>
              <td>
                {e.reasonCode && <span className="badge">{ADJUST_REASON_LABEL[e.reasonCode] ?? humanize(e.reasonCode)}</span>} {ledgerReason(e)}
              </td>
              <td>{dateTime(e.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AdjustDialog({ batchId, line, onClose }: { batchId: string; line: BatchLine; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [onHand, setOnHand] = useState(String(line.onHand))
  const [reserve, setReserve] = useState(String(line.reserveBuffer))
  const [reason, setReason] = useState('')
  // Until staff pick one: Received for a short arrival, Correction otherwise.
  const [picked, setCode] = useState<AdjustReason | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (input: { onHand?: number; reserveBuffer?: number; reason: string; reasonCode: AdjustReason }) =>
      api.adjustLine(batchId, line.id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['batch', batchId] })
      queryClient.invalidateQueries({ queryKey: ['ledger', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      toast.success('Stock adjusted')
      onClose()
    },
  })
  const promised = line.held + line.committed
  const ohNumber = Number(onHand)
  // Fewer boxes than customers already hold: a short arrival, which takes boxes back from orders.
  const short = Number.isInteger(ohNumber) && ohNumber >= 0 && ohNumber < promised
  const code: AdjustReason = picked ?? (short ? 'RECEIVED' : 'CORRECTION')
  const shortArrival = useMutation({
    mutationFn: (input: { onHand: number; reason: string; reasonCode: AdjustReason }) => api.shortArrival(batchId, line.id, input),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['batch', batchId] })
      queryClient.invalidateQueries({ queryKey: ['ledger', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
      const parts = [
        r.moved.length ? `moved ${r.moved.map((m) => `${m.number} to ${date(m.deliveryDate)}`).join(', ')}` : null,
        r.refilled.length ? `refilled ${r.refilled.join(', ')} from other batches` : null,
        r.atRisk.length ? `${r.atRisk.join(', ')} at risk` : null,
      ].filter(Boolean)
      toast.success(`Short arrival recorded${parts.length ? `: ${parts.join('; ')}` : ''}`)
      onClose()
    },
  })
  const pending = save.isPending || shortArrival.isPending

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    const oh = Number(onHand)
    const rb = Number(reserve)
    if (!Number.isInteger(oh) || oh < 0 || !Number.isInteger(rb) || rb < 0) {
      return setFormError('Enter whole numbers of zero or more.')
    }
    if (!reason.trim()) return setFormError('A reason is required.')
    if (short) return shortArrival.mutate({ onHand: oh, reason: reason.trim(), reasonCode: code })
    const input: { onHand?: number; reserveBuffer?: number; reason: string; reasonCode: AdjustReason } = { reason: reason.trim(), reasonCode: code }
    if (oh !== line.onHand) input.onHand = oh
    if (rb !== line.reserveBuffer) input.reserveBuffer = rb
    if (input.onHand === undefined && input.reserveBuffer === undefined) return setFormError('Nothing has changed.')
    save.mutate(input)
  }

  return (
    <Dialog
      title={`Adjust stock: ${line.productName ?? line.sku}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="adjust-form" className={short ? 'btn btn-danger' : 'btn btn-primary'} disabled={pending}>
            {pending ? 'Saving…' : short ? 'Record short arrival' : 'Save adjustment'}
          </button>
        </>
      }
    >
      <form id="adjust-form" onSubmit={onSubmit} noValidate>
        <p className="muted small">
          Customers already hold {line.held} unpaid and {line.committed} to pack. Going below what customers already hold records a short arrival.
        </p>
        <div className="field">
          <label htmlFor="adj-onhand">On hand</label>
          <input id="adj-onhand" type="number" min={0} step={1} value={onHand} onChange={(e) => setOnHand(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="adj-reserve">Reserve buffer</label>
          <input id="adj-reserve" type="number" min={0} step={1} value={reserve} onChange={(e) => setReserve(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="adj-code">Why</label>
          <select id="adj-code" value={code} onChange={(e) => setCode(e.target.value as AdjustReason)}>
            {ADJUST_CODES.map((c) => (
              <option key={c} value={c}>
                {ADJUST_REASON_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="adj-reason">Reason</label>
          <input id="adj-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. 4 boxes crushed in unloading" />
        </div>
        {short && (
          <p className="notice notice-warn" role="status">
            Only {ohNumber} of the {promised} promised boxes. The newest orders give boxes back; each is filled from another
            batch, or moved to the next date with stock (the customer gets a WhatsApp update), or flagged at risk.
          </p>
        )}
        <FormError error={formError ?? save.error ?? shortArrival.error} />
      </form>
    </Dialog>
  )
}

/** Reasons staff pick when changing a count by hand (Return restock is booked from the order). */
const ADJUST_CODES: AdjustReason[] = ['CORRECTION', 'COUNT', 'RECEIVED', 'DAMAGED', 'THEFT_LOSS', 'OTHER']

/**
 * A physical count (INV-D): per line, the boxes on the shelf, including those
 * packed for orders that haven't left yet (they are off "on hand" already).
 * Shows the difference from the books, then posts each difference as an
 * adjustment with reason Count, or as a short arrival when the count is below
 * what customers already hold.
 */
function CountDialog({ batch, onClose }: { batch: Batch; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [counted, setCounted] = useState<Record<string, string>>({})
  const [done, setDone] = useState<string[]>([])
  const rows = batch.lines.map((l) => {
    const packed = l.packedNotDispatched ?? 0
    const expected = l.onHand + packed
    const raw = counted[l.id] ?? ''
    const n = raw === '' ? null : Number(raw)
    const valid = n !== null && Number.isInteger(n) && n >= 0
    return { l, packed, expected, n: valid ? n : null, invalid: raw !== '' && !valid, variance: valid ? n - expected : null }
  })
  const changes = rows.filter((r) => r.variance !== null && r.variance !== 0 && !done.includes(r.l.id))
  const tooFew = rows.find((r) => r.n !== null && r.n < r.packed)

  const post = useMutation({
    mutationFn: async () => {
      for (const r of changes) {
        const onHand = (r.n as number) - r.packed
        const reason = `Physical count: ${r.n} counted${r.packed ? `, ${r.packed} of them packed for orders not yet dispatched` : ''} (books said ${r.expected})`
        if (onHand < r.l.held + r.l.committed) await api.shortArrival(batch.id, r.l.id, { onHand, reason, reasonCode: 'COUNT' })
        else await api.adjustLine(batch.id, r.l.id, { onHand, reason, reasonCode: 'COUNT' })
        setDone((d) => [...d, r.l.id])
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['batch', batch.id] })
      queryClient.invalidateQueries({ queryKey: ['ledger', batch.id] })
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
    onSuccess: () => {
      toast.success('Count recorded')
      onClose()
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (changes.length && !tooFew && !rows.some((r) => r.invalid)) post.mutate()
  }

  return (
    <Dialog
      title="Count stock"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="count-form" className="btn btn-primary" disabled={post.isPending || !changes.length || Boolean(tooFew)}>
            {post.isPending ? 'Saving…' : changes.length ? `Record ${changes.length} ${changes.length === 1 ? 'difference' : 'differences'}` : 'No differences'}
          </button>
        </>
      }
    >
      <form id="count-form" onSubmit={onSubmit} noValidate>
        <p className="muted small">
          Count every box of this batch on the shelf, including boxes already packed for orders that haven't left. Each difference is
          saved with the reason Count.
        </p>
        <div {...scrollRegion('Count per SKU')}>
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th className="num">Books</th>
                <th className="num">Counted</th>
                <th className="num">Difference</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.l.id}>
                  <td>
                    {r.l.productName ?? r.l.sku}
                    {r.packed > 0 && <div className="muted small">{r.packed} packed, not yet dispatched</div>}
                  </td>
                  <td className="num">{r.expected}</td>
                  <td className="num">
                    <label className="sr-only" htmlFor={`count-${r.l.id}`}>
                      Boxes counted for {r.l.sku}
                    </label>
                    <input
                      id={`count-${r.l.id}`}
                      inputMode="numeric"
                      size={5}
                      value={counted[r.l.id] ?? ''}
                      aria-invalid={r.invalid || undefined}
                      onChange={(e) => setCounted({ ...counted, [r.l.id]: e.target.value.trim() })}
                    />
                  </td>
                  <td className={`num ${r.variance && r.variance < 0 ? 'text-danger' : r.variance ? 'text-good' : ''}`}>
                    {r.variance === null ? '—' : r.variance > 0 ? `+${r.variance}` : r.variance}
                    {done.includes(r.l.id) && <span className="muted small"> saved</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {tooFew && (
          <p className="notice notice-warn" role="status">
            {tooFew.l.sku}: fewer boxes than are packed for orders ({tooFew.packed}). Check the packed orders first.
          </p>
        )}
        <FormError error={post.error} />
      </form>
    </Dialog>
  )
}
