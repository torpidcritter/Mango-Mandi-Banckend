import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
import { ORDER_STATUS_LABEL, date, istTime } from '../format'
import type { OrderStatus } from '../types'
import NeedsAttention, { attentionQuery } from './NeedsAttention'
import { EmptyState, LinkRow, QueryError, RowLink, scrollRegion, usePageTitle } from '../ui'

const TILE_STATUSES: OrderStatus[] = [
  'CONFIRMED',
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERY_FAILED',
  'PAYMENT_PENDING',
]

/** Tiles someone must act on when they are above zero, with the status tone they take. */
const URGENT: Partial<Record<OrderStatus | 'claims', 'bad' | 'warn'>> = {
  DELIVERY_FAILED: 'bad',
  claims: 'warn',
}

interface Tile {
  to: string
  label: string
  count: number
  urgent?: 'bad' | 'warn'
}

/** Used only when the summary does not say; the API sends the live rule. */
const DEFAULT_MAX_SELLABLE_AGE = 7

export default function Today() {
  usePageTitle('Today')
  const q = useQuery({ queryKey: ['summary'], queryFn: api.summary, refetchInterval: 60_000 })
  // Started here, beside the summary, rather than when NeedsAttention mounts after it.
  const attention = useQuery(attentionQuery)

  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} />
  // While loading, the heading and tiles hold their final size and nothing sits
  // below them; the rest appears once the summary and Needs attention are both
  // in, so nothing on screen moves.
  if (q.isPending) return <TodayLoading />
  const s = q.data
  // Batches this old are past the sell limit: the API no longer sells them.
  const maxAge = s.maxSellableAge ?? DEFAULT_MAX_SELLABLE_AGE
  // Only the first answer is waited for: a query that failed is pending again while it is
  // asked again, and hiding Needs attention then would remount it and ask again, forever.
  const waiting = attention.isPending && attention.errorUpdateCount === 0
  const atRisk = s.atRiskOrders ?? []
  const overdue = s.overdueOrders ?? []
  const healthy = s.batchesNearLimit.length === 0 && s.lowStock.length === 0
  // Every tile opens the page it counts, filtered.
  const tiles: Tile[] = [
    ...TILE_STATUSES.map((status) => ({
      to: `/orders?status=${status}`,
      label: ORDER_STATUS_LABEL[status],
      count: s.orders[status] ?? 0,
      urgent: URGENT[status],
    })),
    { to: '/claims', label: 'Open claims', count: s.openClaims, urgent: URGENT.claims },
  ]

  return (
    <>
      <TodayTop updated={istTime(new Date(q.dataUpdatedAt))} />

      <div className="tiles tiles-today">
        {tiles.map((t) => {
          const urgent = t.urgent && t.count > 0
          return (
            <Link key={t.to} className={`tile${urgent ? ` tile-${t.urgent}` : ''}`} to={t.to}>
              <div className="count">{t.count}</div>
              <div className="label">{t.label}</div>
              {/* The flag line is always there, empty when calm, so a tile keeps its height. */}
              <div className="tile-flag" aria-hidden={urgent ? undefined : true}>
                {urgent ? 'Needs action' : null}
              </div>
            </Link>
          )
        })}
      </div>

      {waiting ? <span className="sr-only" role="status" aria-label="Loading" /> : <NeedsAttention />}

      {!waiting && overdue.length > 0 && (
        <section className="card">
          <h2>Overdue orders</h2>
          <p className="muted">Paid and not delivered by their date, or out for delivery too long. Find out where each one is.</p>
          <div {...scrollRegion('Overdue orders')}>
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Due</th>
                  <th>Status</th>
                  <th>Problem</th>
                </tr>
              </thead>
              <tbody>
                {overdue.map((o) => (
                  <LinkRow key={o.id}>
                    <td>
                      <RowLink to={`/orders/${o.id}`}>{o.number}</RowLink>
                    </td>
                    <td>{date(o.deliveryDate)}</td>
                    <td>{ORDER_STATUS_LABEL[o.status] ?? o.status}</td>
                    <td className="text-danger">{o.reason}</td>
                  </LinkRow>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {!waiting && atRisk.length > 0 && (
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
                  <LinkRow key={o.id}>
                    <td>
                      <RowLink to={`/orders/${o.id}`}>{o.number}</RowLink>
                    </td>
                    <td>{date(o.deliveryDate)}</td>
                    <td>{o.reason ?? '—'}</td>
                  </LinkRow>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {waiting ? null : healthy ? (
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
                      <LinkRow key={b.id}>
                        <td>
                          <RowLink to={`/batches/${b.id}`} more="batch">
                            {b.variety}
                          </RowLink>
                        </td>
                        <td className={`num ${b.ageDays >= maxAge ? 'text-danger' : 'text-warn'}`}>
                          {b.ageDays >= maxAge && <span aria-hidden="true">⚠ </span>}
                          {b.ageDays} days
                          {b.ageDays >= maxAge && <span className="sr-only"> (past sell limit)</span>}
                        </td>
                        <td className="num">{b.available}</td>
                      </LinkRow>
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

/** The heading row; "Last updated" keeps its line while loading. */
function TodayTop({ updated }: { updated?: string }) {
  return (
    <div className="topbar">
      <h1>Today</h1>
      <span className="spacer" />
      <span className="muted small">{updated ? `Last updated ${updated}` : '\u00a0'}</span>
    </div>
  )
}

/** Today before the summary arrives: the heading and eight empty tiles of the final size. */
function TodayLoading() {
  return (
    <>
      <TodayTop />
      <span className="sr-only" role="status" aria-label="Loading" />
      <div className="tiles-placeholder tiles-today" aria-hidden="true">
        {/* One for each order status and one for open claims. */}
        {Array.from({ length: TILE_STATUSES.length + 1 }, (_, i) => (
          <div key={i} className="tile tile-placeholder">
            <div className="count">&nbsp;</div>
            <div className="label">&nbsp;</div>
            <div className="tile-flag" />
          </div>
        ))}
      </div>
    </>
  )
}
