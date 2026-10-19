import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { date, istDate } from '../format'
import type { PackListOrder } from '../types'
import { canSee } from '../permissions'
import { useSession } from '../session'
import { Badge, EmptyState, OrderBadge, QueryError, Spinner, useToast, scrollRegion } from '../ui'
import { printWindow } from '../labels/print'

interface BatchGroup {
  batchId: string
  variety: string
  pluckedOn: string
  picks: { orderId: string; orderNumber: string; sku: string; productName: string; quantity: number; packed: boolean }[]
}

interface Unallocated {
  orderId: string
  orderNumber: string
  sku: string
  productName: string
  quantity: number
}

/** Groups picks by batch, oldest plucked first (FEFO). Items with no pick are listed apart. */
function groupByBatch(orders: PackListOrder[]): { groups: BatchGroup[]; unallocated: Unallocated[] } {
  const map = new Map<string, BatchGroup>()
  const unallocated: Unallocated[] = []
  for (const o of orders) {
    for (const it of o.items) {
      const picked = it.picks.reduce((n, p) => n + p.quantity, 0)
      if (picked < it.quantity) {
        unallocated.push({
          orderId: o.id,
          orderNumber: o.number,
          sku: it.sku,
          productName: it.productName,
          quantity: it.quantity - picked,
        })
      }
      for (const p of it.picks) {
        let g = map.get(p.batchId)
        if (!g) {
          g = { batchId: p.batchId, variety: p.variety, pluckedOn: p.pluckedOn, picks: [] }
          map.set(p.batchId, g)
        }
        g.picks.push({
          orderId: o.id,
          orderNumber: o.number,
          sku: it.sku,
          productName: it.productName,
          quantity: p.quantity,
          packed: p.packed,
        })
      }
    }
  }
  const groups = [...map.values()].sort((a, b) => a.pluckedOn.localeCompare(b.pluckedOn))
  for (const g of groups) g.picks.sort((a, b) => a.sku.localeCompare(b.sku) || a.orderNumber.localeCompare(b.orderNumber))
  return { groups, unallocated }
}

export default function PackList() {
  const [params, setParams] = useSearchParams()
  const day = params.get('date') || istDate(1)
  const view = params.get('view') === 'batch' ? 'batch' : 'order'

  const q = useQuery({ queryKey: ['pack-list', day], queryFn: () => api.packList(day) })
  const { me } = useSession()
  const labelsOn = !!me?.features?.labels

  function set(key: string, value: string | null) {
    const p = new URLSearchParams(params)
    if (value) p.set(key, value)
    else p.delete(key)
    setParams(p, { replace: true })
  }

  return (
    <>
      <div className="print-only">
        <h1>
          Pack list · {date(day)} · {view === 'batch' ? 'By batch' : 'By order'}
        </h1>
      </div>
      <div className="topbar no-print">
        <h1>Pack list</h1>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="pl-date" className="sr-only">
            Delivery date
          </label>
          <input id="pl-date" type="date" value={day} onChange={(e) => set('date', e.target.value || null)} />
        </div>
        <div className="segmented" role="group" aria-label="View">
          <button type="button" className="btn btn-small" aria-pressed={view === 'order'} onClick={() => set('view', null)}>
            By order
          </button>
          <button type="button" className="btn btn-small" aria-pressed={view === 'batch'} onClick={() => set('view', 'batch')}>
            By batch
          </button>
        </div>
        <span className="spacer" />
        {labelsOn && <PrintLabelsButton day={day} />}
        <button type="button" className="btn" onClick={() => window.print()}>
          Print
        </button>
      </div>

      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState>No orders to pack for {date(day)}.</EmptyState>
      ) : view === 'order' ? (
        <ByOrder orders={q.data} day={day} labelsOn={labelsOn} />
      ) : (
        <ByBatch orders={q.data} />
      )}
    </>
  )
}

/** Box labels for every order on the day that still needs packing or is packed. */
function PrintLabelsButton({ day }: { day: string }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  async function run() {
    const win = printWindow()
    setBusy(true)
    try {
      const r = await api.printLabels({ date: day })
      if (!r.labels.length) {
        win.close()
        toast.info(r.skipped.length ? `No labels: ${r.skipped.map((s) => `${s.number} (${s.reason.toLowerCase()})`).join(', ')}` : 'No orders to label')
        return
      }
      win.fill(r.html)
      if (r.skipped.length) toast.info(`Not printed: ${r.skipped.map((s) => `${s.number} (${s.reason.toLowerCase()})`).join(', ')}`)
    } catch (err) {
      win.close()
      toast.error(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <button type="button" className="btn" disabled={busy} onClick={run}>
      {busy ? 'Preparing labels…' : 'Print box labels'}
    </button>
  )
}

function ByOrder({ orders, day, labelsOn }: { orders: PackListOrder[]; day: string; labelsOn: boolean }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const allocate = useMutation({
    mutationFn: (orderId: string) => api.allocate(orderId),
    onSuccess: () => {
      toast.success('Stock allocated')
      queryClient.invalidateQueries({ queryKey: ['pack-list', day] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
    onError: (err) => toast.error(err),
  })

  return (
    <>
      {orders.map((o) => {
        const needsPacking = o.items.some((it) => it.picks.some((p) => !p.packed))
        return (
          <article key={o.id} className="card pack-order">
            <div className="topbar" style={{ marginBottom: '0.5rem' }}>
              <h2 style={{ margin: 0 }}>
                <Link to={`/orders/${o.id}`}>{o.number}</Link>
              </h2>
              <span>{o.customerName ?? '—'}</span>
              {o.pincode && <span className="muted">{o.pincode}</span>}
              {o.slot && <Badge tone="info">{o.slot.label}</Badge>}
              {o.gift && <Badge tone="info">Gift</Badge>}
              <OrderBadge status={o.status} />
              <span className="spacer" />
              {labelsOn && needsPacking && (o.status === 'CONFIRMED' || o.status === 'PROCESSING') && (
                <Link className="btn btn-small no-print" to={`/scan?order=${o.id}&date=${day}`}>
                  Scan to pack<span className="sr-only"> {o.number}</span>
                </Link>
              )}
              {needsPacking && (o.status === 'CONFIRMED' || o.status === 'PROCESSING') && (
                <button
                  type="button"
                  className="btn btn-small no-print"
                  disabled={allocate.isPending}
                  onClick={() => allocate.mutate(o.id)}
                >
                  Allocate and pack<span className="sr-only"> {o.number}</span>
                </button>
              )}
            </div>
            {o.gift && (
              <p className="small">
                <strong>Gift for {o.gift.recipientName}.</strong> Leave the price slip out.
                {o.gift.message && <> Card note: “{o.gift.message}”</>}
              </p>
            )}
            <div {...scrollRegion(`Items for ${o.number}`)}>
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Qty</th>
                    <th>Pick from</th>
                  </tr>
                </thead>
                <tbody>
                  {o.items.map((it) => (
                    <tr key={it.sku}>
                      <td>
                        {it.productName}
                        <div className="muted small">{it.sku}</div>
                      </td>
                      <td className="num">{it.quantity}</td>
                      <td>
                        {it.picks.length === 0 ? (
                          <span className="text-warn">Not allocated yet</span>
                        ) : (
                          <ul style={{ margin: 0, paddingLeft: '1rem' }}>
                            {it.picks.map((p, i) => (
                              <li key={i}>
                                {p.quantity} × {p.variety} plucked {date(p.pluckedOn)}{' '}
                                <Badge tone={p.packed ? 'good' : 'info'}>{p.packed ? 'Packed' : 'Held'}</Badge>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        )
      })}
    </>
  )
}

function ByBatch({ orders }: { orders: PackListOrder[] }) {
  const { groups, unallocated } = useMemo(() => groupByBatch(orders), [orders])
  const { me } = useSession()
  const openBatches = canSee(me?.role, 'batches')
  return (
    <>
      {groups.map((g) => (
        <article key={g.batchId} className="card pack-order">
          <h2>
            {openBatches ? <Link to={`/batches/${g.batchId}`}>{g.variety}</Link> : g.variety}{' '}
            <span className="muted small">plucked {date(g.pluckedOn)}</span>
          </h2>
          <div {...scrollRegion(`Picks from ${g.variety} plucked ${date(g.pluckedOn)}`)}>
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Qty</th>
                  <th>Order</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {g.picks.map((p, i) => (
                  <tr key={i}>
                    <td>
                      {p.productName}
                      <div className="muted small">{p.sku}</div>
                    </td>
                    <td className="num">{p.quantity}</td>
                    <td>
                      <Link to={`/orders/${p.orderId}`}>{p.orderNumber}</Link>
                    </td>
                    <td>
                      <Badge tone={p.packed ? 'good' : 'info'}>{p.packed ? 'Packed' : 'Held'}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>Total units</th>
                  <th className="num">{g.picks.reduce((n, p) => n + p.quantity, 0)}</th>
                  <th colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        </article>
      ))}
      {unallocated.length > 0 && (
        <article className="card pack-order">
          <h2>Not allocated yet</h2>
          <div {...scrollRegion('Items not allocated yet')}>
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Qty</th>
                  <th>Order</th>
                </tr>
              </thead>
              <tbody>
                {unallocated.map((u, i) => (
                  <tr key={i}>
                    <td>
                      {u.productName}
                      <div className="muted small">{u.sku}</div>
                    </td>
                    <td className="num">{u.quantity}</td>
                    <td>
                      <Link to={`/orders/${u.orderId}`}>{u.orderNumber}</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      )}
    </>
  )
}
