import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from '../api'
import { ORDER_STATUS_LABEL, date, dateTime, rupees } from '../format'
import { ALL_ORDER_STATUSES, type OrderStatus } from '../types'
import { ClickableRow, EmptyState, OrderBadge, QueryError, Spinner, scrollRegion } from '../ui'

export default function Orders() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const status = (params.get('status') as OrderStatus | null) || null
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const q = params.get('q') ?? ''
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1)

  const [search, setSearch] = useState(q)
  useEffect(() => setSearch(q), [q])

  function update(changes: Record<string, string | null>, resetPage = true) {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(changes)) {
      if (v) p.set(k, v)
      else p.delete(k)
    }
    if (resetPage) p.delete('page')
    setParams(p)
  }

  // Debounce typing into the URL; Enter applies immediately.
  useEffect(() => {
    if (search === q) return
    const t = window.setTimeout(() => update({ q: search.trim() || null }), 400)
    return () => window.clearTimeout(t)
  }, [search])

  const list = useQuery({
    queryKey: ['orders', { status, from, to, q, page }],
    queryFn: () => api.orders({ status, from, to, q, page }),
    placeholderData: keepPreviousData,
  })

  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1

  return (
    <>
      <div className="topbar">
        <h1>Orders</h1>
      </div>

      <div className="segmented" role="group" aria-label="Filter by status" style={{ marginBottom: '0.75rem' }}>
        <button type="button" className="btn btn-small" aria-pressed={status === null} onClick={() => update({ status: null })}>
          All
        </button>
        {ALL_ORDER_STATUSES.map((s) => (
          <button key={s} type="button" className="btn btn-small" aria-pressed={status === s} onClick={() => update({ status: s })}>
            {ORDER_STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      <div className="field-inline" style={{ marginBottom: '1rem' }}>
        <div className="field">
          <label htmlFor="o-from">Placed from</label>
          <input id="o-from" type="date" value={from} onChange={(e) => update({ from: e.target.value || null })} />
        </div>
        <div className="field">
          <label htmlFor="o-to">Placed to</label>
          <input id="o-to" type="date" value={to} onChange={(e) => update({ to: e.target.value || null })} />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 200 }}>
          <label htmlFor="o-q">Search order number or phone</label>
          <input
            id="o-q"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') update({ q: search.trim() || null })
            }}
          />
        </div>
      </div>

      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <QueryError error={list.error} onRetry={() => list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState>No orders match these filters.</EmptyState>
      ) : (
        <>
          <div {...scrollRegion('Orders')}>
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th className="num">Items</th>
                  <th className="num">Total</th>
                  <th>Status</th>
                  <th>Delivery</th>
                  <th>Placed</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((o) => (
                  <ClickableRow key={o.id} label={`Open order ${o.number}`} onActivate={() => navigate(`/orders/${o.id}`)}>
                    <td>
                      <strong>{o.number}</strong>
                      {o.channel === 'whatsapp' && <div className="muted small">via WhatsApp</div>}
                    </td>
                    <td>
                      {o.customerName ?? '—'}
                      {o.phone && <div className="muted small">{o.phone}</div>}
                    </td>
                    <td className="num">{o.itemCount}</td>
                    <td className="num">{rupees(o.total)}</td>
                    <td>
                      <OrderBadge status={o.status} />
                    </td>
                    <td>{date(o.deliveryDate)}</td>
                    <td>{dateTime(o.placedAt)}</td>
                  </ClickableRow>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <span className="muted small">
              {list.data.total} orders · page {list.data.page} of {totalPages}
            </span>
            <button
              type="button"
              className="btn btn-small"
              disabled={page <= 1}
              onClick={() => update({ page: String(page - 1) }, false)}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={page >= totalPages}
              onClick={() => update({ page: String(page + 1) }, false)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </>
  )
}
