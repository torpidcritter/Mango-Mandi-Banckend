import { useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { BATCH_STATUS_LABEL, RIPENESS_LABEL, date, istDate } from '../format'
import { ALL_BATCH_STATUSES, type BatchStatus } from '../types'
import {
  Badge,
  BatchBadge,
  Dialog,
  EmptyState,
  FormError,
  LinkRow,
  QueryError,
  RowLink,
  Spinner,
  StatusFilter,
  useToast,
  scrollRegion,
  usePageTitle,
} from '../ui'

export default function Batches() {
  const [params, setParams] = useSearchParams()
  const status = (params.get('status') as BatchStatus | null) || null
  const receiving = params.get('receive') === '1'
  usePageTitle('Batches')

  const q = useQuery({ queryKey: ['batches', status], queryFn: () => api.batches(status) })

  function setStatus(next: BatchStatus | null) {
    const p = new URLSearchParams(params)
    if (next) p.set('status', next)
    else p.delete('status')
    setParams(p)
  }
  function setReceiving(open: boolean) {
    const p = new URLSearchParams(params)
    if (open) p.set('receive', '1')
    else p.delete('receive')
    setParams(p, { replace: true })
  }

  return (
    <>
      <div className="topbar">
        <h1>Batches</h1>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={() => setReceiving(true)}>
          Receive batch
        </button>
      </div>

      <StatusFilter className="no-print mb-4" value={status} options={ALL_BATCH_STATUSES} labels={BATCH_STATUS_LABEL} onChange={setStatus} />

      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState>No batches{status ? ` with status ${BATCH_STATUS_LABEL[status]}` : ''}.</EmptyState>
      ) : (
        <div {...scrollRegion('Batches', { cards: true })}>
          <table>
            <thead>
              <tr>
                <th>Variety</th>
                <th>Plucked</th>
                <th className="num">Age</th>
                <th>Status</th>
                <th>QC</th>
                <th className="num">On hand</th>
                <th className="num">
                  <abbr title="Paid, not yet packed">To pack</abbr>
                </th>
                <th className="num">Available</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((b) => (
                <LinkRow key={b.id}>
                  <td className="card-title">
                    <RowLink to={`/batches/${b.id}`} more={`batch plucked ${date(b.pluckedOn)}`}>
                      {b.variety}
                    </RowLink>
                    {b.farm && <div className="muted small">{b.farm}</div>}
                  </td>
                  <td data-label="Plucked">{date(b.pluckedOn)}</td>
                  <td className={`num${b.ageDays >= 5 ? ' text-warn' : ''}`} data-label="Age">
                    {b.ageDays}d
                  </td>
                  <td className="card-status">
                    <BatchBadge status={b.status} />
                  </td>
                  <td className="card-wide" data-label="QC">
                    {b.latestRating ? (
                      <Badge tone={b.latestCondition === 'REJECT' ? 'bad' : 'neutral'}>
                        {RIPENESS_LABEL[b.latestRating]}
                        {b.latestCondition === 'REJECT' ? ' · Reject' : ''}
                      </Badge>
                    ) : (
                      <Badge tone="warn">No QC: not sellable yet</Badge>
                    )}
                  </td>
                  <td className="num" data-label="On hand">
                    {b.onHand}
                  </td>
                  <td className="num" data-label="To pack">
                    {b.committed}
                  </td>
                  <td className="num" data-label="Available">
                    {b.available}
                  </td>
                </LinkRow>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {receiving && <ReceiveDialog onClose={() => setReceiving(false)} />}
    </>
  )
}

function ReceiveDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const products = useQuery({ queryKey: ['products'], queryFn: api.products, staleTime: Infinity })
  // Removed products can't take new stock.
  const onSale = useMemo(() => (products.data ?? []).filter((p) => p.active !== false), [products.data])

  const varieties = useMemo(
    () => Array.from(new Set(onSale.map((p) => p.variety).filter(Boolean))).sort(),
    [onSale],
  )
  const [variety, setVariety] = useState('')
  const [pluckedOn, setPluckedOn] = useState(istDate())
  const [farm, setFarm] = useState('')
  const [qty, setQty] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<unknown>(null)

  const activeVariety = variety || varieties[0] || ''
  const skus = onSale.filter((p) => p.variety === activeVariety)
  const today = istDate()

  const create = useMutation({
    mutationFn: api.createBatch,
    onSuccess: (batch) => {
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      queryClient.invalidateQueries({ queryKey: ['summary'] })
      toast.success('Batch received. Log QC before it can sell.')
      navigate(`/batches/${batch.id}?focusQC=1`)
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (pluckedOn > today) return setFormError('Plucked date cannot be in the future.')
    const lines = skus
      .map((p) => ({ sku: p.sku, onHand: Number(qty[p.sku] || 0) }))
      .filter((l) => l.onHand > 0)
    if (lines.some((l) => !Number.isInteger(l.onHand))) return setFormError('Quantities must be whole numbers.')
    if (lines.length === 0) return setFormError('Enter a quantity for at least one product.')
    create.mutate({ variety: activeVariety, pluckedOn, farm: farm.trim() || undefined, lines })
  }

  return (
    <Dialog
      title="Receive batch"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="receive-form" className="btn btn-primary" disabled={create.isPending || !activeVariety}>
            {create.isPending ? 'Saving…' : 'Receive batch'}
          </button>
        </>
      }
    >
      {products.isPending ? (
        <Spinner label="Loading products" />
      ) : products.isError ? (
        <QueryError error={products.error} onRetry={() => products.refetch()} />
      ) : (
        <form id="receive-form" onSubmit={onSubmit} noValidate>
          <div className="field">
            <label htmlFor="rb-variety">Variety</label>
            <select id="rb-variety" value={activeVariety} onChange={(e) => setVariety(e.target.value)}>
              {varieties.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="rb-plucked">Plucked date</label>
            <input id="rb-plucked" type="date" max={today} value={pluckedOn} onChange={(e) => setPluckedOn(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="rb-farm">Farm (optional)</label>
            <input id="rb-farm" value={farm} onChange={(e) => setFarm(e.target.value)} />
          </div>
          <fieldset>
            <legend>Quantity per product</legend>
            {skus.length === 0 && <p className="muted">No products for this variety.</p>}
            {skus.map((p) => (
              <div className="field" key={p.sku}>
                <label htmlFor={`rb-qty-${p.sku}`}>
                  {p.name} <span className="muted small">{p.sku}</span>
                </label>
                <input
                  id={`rb-qty-${p.sku}`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  value={qty[p.sku] ?? ''}
                  onChange={(e) => setQty((q) => ({ ...q, [p.sku]: e.target.value }))}
                />
              </div>
            ))}
          </fieldset>
          <FormError error={formError ?? create.error} />
        </form>
      )}
    </Dialog>
  )
}
