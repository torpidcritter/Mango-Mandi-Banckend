import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api } from '../api'
import { BATCH_STATUS_LABEL, CONDITION_LABEL, RIPENESS_LABEL, date, dateTime } from '../format'
import { MANAGER_ONLY_HINT, can } from '../permissions'
import { useSession } from '../session'
import { BATCH_FLOW, type BatchDetail as Batch, type BatchLine, type BatchStatus, type Condition, type Ripeness } from '../types'
import { BatchBadge, Dialog, EmptyState, FormError, GatedButton, QueryError, Spinner, useToast, scrollRegion } from '../ui'

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
  const [params] = useSearchParams()
  const [tab, setTab] = useState<'qc' | 'ledger'>('qc')

  return (
    <>
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
        <h2>Stock</h2>
        <div {...scrollRegion('Stock per SKU')}>
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th className="num">On hand</th>
                <th className="num">
                  <abbr title="Reserved by customers who have not paid yet">Held</abbr>
                </th>
                <th className="num">
                  <abbr title="Paid, not yet packed">Committed</abbr>
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
      </section>

      <section className="card">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'qc'} onClick={() => setTab('qc')}>
            QC
          </button>
          <button type="button" role="tab" aria-selected={tab === 'ledger'} onClick={() => setTab('ledger')}>
            Ledger
          </button>
        </div>
        {tab === 'qc' ? <QcPanel batch={batch} focus={params.get('focusQC') === '1'} /> : <LedgerPanel batchId={batch.id} />}
      </section>

      {adjusting && <AdjustDialog batchId={batch.id} line={adjusting} onClose={() => setAdjusting(null)} />}
    </>
  )
}

function StatusControls({ batch }: { batch: Batch }) {
  const { me } = useSession()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [confirmCondemn, setConfirmCondemn] = useState(false)
  const [condemned, setCondemned] = useState<{ moved: string[]; atRisk: string[] } | null>(null)

  const move = useMutation({
    mutationFn: (status: BatchStatus) => api.setBatchStatus(batch.id, status),
    onSuccess: (res, status) => {
      queryClient.invalidateQueries({ queryKey: ['batch', batch.id] })
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      queryClient.invalidateQueries({ queryKey: ['summary'] })
      if (status === 'CONDEMNED') {
        setConfirmCondemn(false)
        setCondemned({ moved: res?.rebalancedOrders ?? [], atRisk: res?.atRiskOrders ?? [] })
      } else {
        toast.success(`Batch moved to ${BATCH_STATUS_LABEL[status]}`)
      }
    },
    onError: (err) => {
      if (!confirmCondemn) toast.error(err)
    },
  })

  const steps = forwardSteps(batch.status)
  const [next, ...skips] = steps

  return (
    <section className="card">
      <h2>Status</h2>
      {isFinal(batch.status) ? (
        <p className="muted">
          This batch is {BATCH_STATUS_LABEL[batch.status].toLowerCase()}. Its status can no longer change.
        </p>
      ) : (
        <div className="btn-row">
          {next && (
            <button type="button" className="btn btn-primary" disabled={move.isPending} onClick={() => move.mutate(next)}>
              Move to {BATCH_STATUS_LABEL[next]}
            </button>
          )}
          {skips.map((s) => (
            <button key={s} type="button" className="btn" disabled={move.isPending} onClick={() => move.mutate(s)}>
              Skip to {BATCH_STATUS_LABEL[s]}
            </button>
          ))}
          <span className="spacer" style={{ flex: 1 }} />
          <GatedButton
            allowed={can(me?.role, 'condemnBatch')}
            className="btn btn-danger"
            onClick={() => setConfirmCondemn(true)}
          >
            Condemn batch
          </GatedButton>
        </div>
      )}

      {confirmCondemn && (
        <Dialog
          title="Condemn this batch?"
          tone="danger"
          onClose={() => setConfirmCondemn(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirmCondemn(false)} data-autofocus>
                Keep batch
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={move.isPending}
                onClick={() => move.mutate('CONDEMNED')}
              >
                {move.isPending ? 'Condemning…' : 'Condemn and move orders'}
              </button>
            </>
          }
        >
          <p>
            This cannot be undone. Its remaining stock is written off. Open orders holding this batch are moved to
            another batch of the same ripeness where stock allows; any that can't be moved are flagged{' '}
            <strong>at risk</strong> for you to sort out. No order is cancelled.
          </p>
          <FormError error={move.error} />
        </Dialog>
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
      {!can(me?.role, 'condemnBatch') && !isFinal(batch.status) && (
        <p className="hint">Condemning a batch: {MANAGER_ONLY_HINT.toLowerCase()}.</p>
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

      <h3 style={{ marginTop: '1.25rem' }}>History</h3>
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

function LedgerPanel({ batchId }: { batchId: string }) {
  // Loaded lazily: this component only mounts when the Ledger tab is open.
  const q = useQuery({ queryKey: ['ledger', batchId], queryFn: () => api.ledger(batchId) })
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
            <th className="num">Δ Qty</th>
            <th>Actor</th>
            <th>Reason</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {q.data.map((e, i) => (
            <tr key={e.id ?? i}>
              <td>{e.eventType}</td>
              <td>{e.sku ?? '—'}</td>
              <td className={`num ${e.delta < 0 ? 'text-danger' : e.delta > 0 ? 'text-good' : ''}`}>
                {e.delta > 0 ? `+${e.delta}` : e.delta}
              </td>
              <td>{e.actorId}</td>
              <td>{e.reason ?? '—'}</td>
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
  const [formError, setFormError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (input: { onHand?: number; reserveBuffer?: number; reason: string }) =>
      api.adjustLine(batchId, line.id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['batch', batchId] })
      queryClient.invalidateQueries({ queryKey: ['ledger', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      toast.success('Stock adjusted')
      onClose()
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    const oh = Number(onHand)
    const rb = Number(reserve)
    if (!Number.isInteger(oh) || oh < 0 || !Number.isInteger(rb) || rb < 0) {
      return setFormError('Enter whole numbers of zero or more.')
    }
    if (!reason.trim()) return setFormError('A reason is required.')
    const input: { onHand?: number; reserveBuffer?: number; reason: string } = { reason: reason.trim() }
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
          <button type="submit" form="adjust-form" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save adjustment'}
          </button>
        </>
      }
    >
      <form id="adjust-form" onSubmit={onSubmit} noValidate>
        <p className="muted small">
          Held {line.held} + committed {line.committed}. On hand can't go below what customers already hold.
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
          <label htmlFor="adj-reason">Reason</label>
          <input id="adj-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. 4 boxes crushed in unloading" />
        </div>
        <FormError error={formError ?? save.error} />
      </form>
    </Dialog>
  )
}
