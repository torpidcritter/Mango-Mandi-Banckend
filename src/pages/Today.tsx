import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
import { ORDER_STATUS_LABEL, date, istTime } from '../format'
import type { OrderStatus } from '../types'
import NeedsAttention from './NeedsAttention'
import { ClickableRow, EmptyState, QueryError, Spinner, scrollRegion } from '../ui'

const TILE_STATUSES: OrderStatus[] = [
  'CONFIRMED',
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERY_FAILED',
]

/** Maximum sellable batch age in days; the API excludes older stock. */
const MAX_SELLABLE_AGE = 7

export default function Today() {
  const navigate = useNavigate()
  const q = useQuery({ queryKey: ['summary'], queryFn: api.summary, refetchInterval: 60_000 })

  if (q.isPending) return <Spinner />
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} />
  const s = q.data
  const atRisk = s.atRiskOrders ?? []
  const healthy = s.batchesNearLimit.length === 0 && s.lowStock.length === 0

  return (
    <>
      <div className="topbar">
        <h1>Today</h1>
        <span className="spacer" />
        <span className="muted small">Last updated {istTime(new Date(q.dataUpdatedAt))}</span>
      </div>

      <NeedsAttention />

      <div className="tiles">
        {TILE_STATUSES.map((status) => (
          <Link key={status} className="tile" to={`/orders?status=${status}`}>
            <div className="count">{s.orders[status] ?? 0}</div>
            <div className="label">{ORDER_STATUS_LABEL[status]}</div>
          </Link>
        ))}
        <Link className="tile" to="/claims">
          <div className="count">{s.openClaims}</div>
          <div className="label">Open claims</div>
        </Link>
        <div className="tile" title="These orders are waiting for the customer to pay">
          <div className="count">{s.orders.PAYMENT_PENDING ?? 0}</div>
          <div className="label">Payment pending</div>
        </div>
      </div>

      {atRisk.length > 0 && (
        <section className="card">
          <h2>Orders at risk</h2>
          <p className="muted">The stock for these orders went bad or ran out. Each needs a new date or new stock.</p>
          <div {...scrollRegion('Orders at risk')}>
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Delivery</th>
                  <th>Problem</th>
                </tr>
              </thead>
              <tbody>
                {atRisk.map((o) => (
                  <ClickableRow key={o.id} label={`Open order ${o.number}`} onActivate={() => navigate(`/orders/${o.id}`)}>
                    <td>{o.number}</td>
                    <td>{date(o.deliveryDate)}</td>
                    <td>{o.reason ?? '—'}</td>
                  </ClickableRow>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {healthy ? (
        <div className="card">
          <EmptyState>All batches and stock look healthy.</EmptyState>
        </div>
      ) : (
        <div className="grid-2">
          <section>
            <h2>Batches nearing sell limit</h2>
            {s.batchesNearLimit.length === 0 ? (
              <EmptyState>No batches are 5 or more days old.</EmptyState>
            ) : (
              <div {...scrollRegion('Batches nearing sell limit')}>
                <table>
                  <thead>
                    <tr>
                      <th>Variety</th>
                      <th className="num">Age</th>
                      <th className="num">Available</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.batchesNearLimit.map((b) => (
                      <ClickableRow
                        key={b.id}
                        label={`Open ${b.variety} batch, ${b.ageDays} days old`}
                        onActivate={() => navigate(`/batches/${b.id}`)}
                      >
                        <td>{b.variety}</td>
                        <td className={`num ${b.ageDays >= MAX_SELLABLE_AGE ? 'text-danger' : 'text-warn'}`}>
                          {b.ageDays >= MAX_SELLABLE_AGE && <span aria-hidden="true">⚠ </span>}
                          {b.ageDays} days
                          {b.ageDays >= MAX_SELLABLE_AGE && <span className="sr-only"> (past sell limit)</span>}
                        </td>
                        <td className="num">{b.available}</td>
                      </ClickableRow>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section>
            <h2>Low stock</h2>
            {s.lowStock.length === 0 ? (
              <EmptyState>No SKUs are running low.</EmptyState>
            ) : (
              <div {...scrollRegion('Low stock')}>
                <table>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="num">Available</th>
                      <th>
                        <span className="sr-only">Action</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.lowStock.map((p) => (
                      <tr key={p.sku}>
                        <td>
                          {p.productName} <span className="muted small">{p.sku}</span>
                        </td>
                        <td className="num">{p.available}</td>
                        <td>
                          <Link to="/batches?receive=1">Receive batch</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  )
}
