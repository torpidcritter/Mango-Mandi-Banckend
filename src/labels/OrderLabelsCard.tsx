// The order page's box labels: print them, see each box's progress (packed,
// on the van, checked at the door) and reprint one damaged label with a reason.
import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { date } from '../format'
import type { BoxLabel, OrderStatus } from '../types'
import { Badge, Dialog, FormError, QueryError, Spinner, useToast } from '../ui'
import { printWindow } from './print'

const PRINTABLE: OrderStatus[] = ['CONFIRMED', 'PROCESSING', 'PACKED']

function progress(l: BoxLabel) {
  if (l.doorScannedAt) return <Badge tone="good">Checked at the door</Badge>
  if (l.dispatchedOn) return <Badge tone="good">On the van {date(l.dispatchedOn)}</Badge>
  if (l.packedAt) return <Badge tone="good">Packed</Badge>
  return <Badge tone="neutral">Not scanned</Badge>
}

export default function OrderLabelsCard({ orderId, status, canPrint }: { orderId: string; status: OrderStatus; canPrint: boolean }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const q = useQuery({ queryKey: ['order-labels', orderId], queryFn: () => api.orderLabels(orderId) })
  const [busy, setBusy] = useState(false)
  const [reprinting, setReprinting] = useState<BoxLabel | null>(null)

  async function printAll() {
    const win = printWindow()
    setBusy(true)
    try {
      const r = await api.printLabels({ orderIds: [orderId] })
      if (r.skipped.length) {
        win.close()
        toast.error(`Labels not printed: ${r.skipped[0].reason}`)
      } else win.fill(r.html)
      queryClient.invalidateQueries({ queryKey: ['order-labels', orderId] })
    } catch (err) {
      win.close()
      toast.error(err)
    } finally {
      setBusy(false)
    }
  }

  const printable = canPrint && PRINTABLE.includes(status)
  return (
    <section className="card">
      <div className="topbar" style={{ marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>Box labels</h2>
        <span className="spacer" />
        {printable && (
          <button type="button" className="btn btn-small" disabled={busy} onClick={printAll}>
            {busy ? 'Preparing…' : q.data?.labels.length ? 'Print labels again' : 'Print labels'}
          </button>
        )}
      </div>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.labels.length === 0 ? (
        <p className="muted">No labels printed yet.</p>
      ) : (
        <>
          {!q.data.current && PRINTABLE.includes(status) && (
            <p className="text-warn small">The order changed after printing (stock, date or slot). Print its labels again.</p>
          )}
          <ul className="box-list">
            {q.data.labels.map((l) => (
              <li key={l.id}>
                <strong>Box {l.boxNo}</strong> {l.productName}, {l.ripeness.toLowerCase()} · batch {l.batchId} {progress(l)}
                <span className="muted small"> {l.code}{l.reprints ? ` · reprinted ${l.reprints}×` : ''}</span>{' '}
                {canPrint && q.data.current && (
                  <button type="button" className="btn btn-small" onClick={() => setReprinting(l)}>
                    Reprint<span className="sr-only"> box {l.boxNo}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {reprinting && (
        <ReprintDialog
          label={reprinting}
          onClose={() => setReprinting(null)}
          onDone={() => queryClient.invalidateQueries({ queryKey: ['order-labels', orderId] })}
        />
      )}
    </section>
  )
}

function ReprintDialog({ label, onClose, onDone }: { label: BoxLabel; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (reason.trim().length < 3) return setError(new Error('Say why the label is reprinted.'))
    const win = printWindow()
    setBusy(true)
    try {
      const r = await api.reprintLabel(label.id, reason.trim())
      win.fill(r.html)
      toast.success(`Box ${label.boxNo} reprinted. The old label no longer scans.`)
      onDone()
      onClose()
    } catch (err) {
      win.close()
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={`Reprint box ${label.boxNo} of ${label.orderNumber}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="reprint-form" className="btn btn-primary" disabled={busy}>
            {busy ? 'Reprinting…' : 'Reprint'}
          </button>
        </>
      }
    >
      <form id="reprint-form" onSubmit={onSubmit} noValidate>
        <p className="small">The new label gets a new QR code. Throw the old label away: it will no longer scan.</p>
        <div className="field">
          <label htmlFor="reprint-reason">Why reprint?</label>
          <input id="reprint-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Label got wet" />
        </div>
        <FormError error={error} />
      </form>
    </Dialog>
  )
}
