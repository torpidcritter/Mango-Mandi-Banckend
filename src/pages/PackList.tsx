import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, isStale } from '../api'
import { STOCK_STATE_LABEL, date, istDate } from '../format'
import type { PackListOrder } from '../types'
import { canSee } from '../permissions'
import { useSession } from '../session'
import { Badge, EmptyState, OrderBadge, QueryError, Spinner, useToast, scrollRegion, usePageTitle } from '../ui'

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
  usePageTitle('Pack list')
  const [params, setParams] = useSearchParams()
  const day = params.get('date') || istDate(1)
  const view = params.get('view') === 'batch' ? 'batch' : 'order'
  const toPackOnly = params.get('show') === 'to-pack'

  const q = useQuery({ queryKey: ['pack-list', day], queryFn: () => api.packList(day) })

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
        <div className="field m-0">
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
        {view === 'order' && (
          <div className="segmented" role="group" aria-label="Show">
            <button type="button" className="btn btn-small" aria-pressed={!toPackOnly} onClick={() => set('show', null)}>
              All orders
            </button>
            <button type="button" className="btn btn-small" aria-pressed={toPackOnly} onClick={() => set('show', 'to-pack')}>
              To pack
            </button>
          </div>
        )}
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => window.print()}>
          Print
        </button>
      </div>

      {q.data && q.data.length > 0 && <PackCounter orders={q.data} />}

      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState>No orders to pack for {date(day)}.</EmptyState>
      ) : view === 'order' ? (
        <ByOrder orders={toPackOnly ? q.data.filter((o) => packState(o) !== 'packed') : q.data} day={day} />
      ) : (
        <ByBatch orders={q.data} />
      )}
    </>
  )
}

/**
 * Where an order is on the pack list. allocate: some boxes are not picked from a batch yet,
 * or picked but not packed (Allocate stock does both); ready: every box is packed, so the
 * order can be marked packed; packed: done.
 */
type PackState = 'allocate' | 'ready' | 'packed' | 'other'

function packState(o: PackListOrder): PackState {
  if (o.status === 'PACKED') return 'packed'
  if (o.status !== 'CONFIRMED' && o.status !== 'PROCESSING') return 'other'
  const allPacked = o.items.every(
    (it) => it.picks.reduce((n, p) => n + p.quantity, 0) >= it.quantity && it.picks.every((p) => p.packed),
  )
  // Same rule as the order page: the API refuses PACKED while any stock is not packed, or none is.
  const anyPacked = o.items.some((it) => it.picks.some((p) => p.packed))
  return allPacked && anyPacked ? 'ready' : 'allocate'
}

/** "12 of 30 packed · 18 to pack", read out when it changes. */
function PackCounter({ orders }: { orders: PackListOrder[] }) {
  const packed = orders.filter((o) => packState(o) === 'packed').length
  const left = orders.length - packed
  return (
    <p className="pack-counter" role="status">
      <strong>
        {packed} of {orders.length} packed
      </strong>
      <span className="muted"> · </span>
      {left === 0 ? <span className="text-good">All packed</span> : <span>{left} to pack</span>}
    </p>
  )
}

/**
 * Sorted for the packing table: by slot (in the API's slot order), then pincode, then
 * order number. Orders without a slot come last.
 */
function packOrder(orders: PackListOrder[]): PackListOrder[] {
  const slotRank = new Map<string, number>()
  for (const o of orders) if (o.slot && !slotRank.has(o.slot.id)) slotRank.set(o.slot.id, slotRank.size)
  const rank = (o: PackListOrder) => (o.slot ? (slotRank.get(o.slot.id) ?? 0) : Number.MAX_SAFE_INTEGER)
  return [...orders].sort(
    (a, b) => rank(a) - rank(b) || (a.pincode ?? '').localeCompare(b.pincode ?? '') || a.number.localeCompare(b.number),
  )
}

function ByOrder({ orders, day }: { orders: PackListOrder[]; day: string }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['pack-list', day] })
    queryClient.invalidateQueries({ queryKey: ['orders'] })
    queryClient.invalidateQueries({ queryKey: ['order'] })
    queryClient.invalidateQueries({ queryKey: ['summary'] })
    queryClient.invalidateQueries({ queryKey: ['manifest'] })
  }
  const onError = (err: unknown) => {
    toast.error(isStale(err) ? 'This order was just updated by someone else.' : err)
    refresh()
  }
  const allocate = useMutation({
    mutationFn: (o: PackListOrder) => api.allocate(o.id),
    onSuccess: (_r, o) => {
      toast.success(`Stock allocated for ${o.number}`)
      refresh()
    },
    onError,
  })
  // The same status moves as the order page: a confirmed order is started, then marked packed.
  const markPacked = useMutation({
    mutationFn: async (o: PackListOrder) => {
      if (o.status === 'CONFIRMED') await api.setOrderStatus(o.id, 'PROCESSING')
      await api.setOrderStatus(o.id, 'PACKED')
    },
    onSuccess: (_r, o) => {
      toast.success(`${o.number} packed`)
      refresh()
    },
    onError,
  })
  const busy = allocate.isPending || markPacked.isPending

  if (orders.length === 0) return <EmptyState>Everything is packed for {date(day)}.</EmptyState>

  return (
    <>
      {packOrder(orders).map((o) => {
        const state = packState(o)
        return (
          <article key={o.id} className="card pack-order" aria-label={o.number}>
            <div className="topbar section-head">
              <h2>
                <Link to={`/orders/${o.id}`}>{o.number}</Link>
              </h2>
              <span>{o.customerName ?? '—'}</span>
              {o.pincode && <span className="muted">{o.pincode}</span>}
              {o.slot && <Badge>{o.slot.label}</Badge>}
              {o.gift && <Badge>Gift</Badge>}
              <OrderBadge status={o.status} />
              <span className="spacer" />
              {state === 'allocate' && (
                <button type="button" className="btn no-print" disabled={busy} onClick={() => allocate.mutate(o)}>
                  Allocate stock<span className="sr-only"> for {o.number}</span>
                </button>
              )}
              {state === 'ready' && (
                <button type="button" className="btn btn-primary no-print" disabled={busy} onClick={() => markPacked.mutate(o)}>
                  Mark packed<span className="sr-only"> {o.number}</span>
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
                          <ul className="sub-list">
                            {it.picks.map((p, i) => (
                              <li key={i}>
                                {p.quantity} × {p.variety} plucked {date(p.pluckedOn)}{' '}
                                <PickBadge packed={p.packed} />
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

/** A pick's state: paid stock set aside for the order is "To pack" (never "Held", which means unpaid). */
function PickBadge({ packed }: { packed: boolean }) {
  return <Badge tone={packed ? 'good' : 'info'}>{packed ? STOCK_STATE_LABEL.packed : STOCK_STATE_LABEL.committed}</Badge>
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
                      <PickBadge packed={p.packed} />
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
