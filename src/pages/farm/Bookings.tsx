// Bulk Orders → Farm Experience Bookings (docs/farm-experience.md): the counts, then every
// booking with filters and search. Filters live in the address, so a filtered list can be shared.
import { useId } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { date, rupees } from '../../format'
import { Badge, EmptyState, QueryError, Spinner, scrollRegion, usePageTitle } from '../../ui'
import { farm, type BookingQuery } from './api'
import { FARM_STATUSES, FARM_STATUS_LABEL, FarmBadge, FarmSubnav, HOSPITALITY_LABEL } from './shared'

const FILTER_KEYS = ['q', 'status', 'varietyId', 'visitFrom', 'visitTo', 'createdFrom', 'createdTo', 'payment', 'minKg', 'maxKg', 'minGuests', 'maxGuests', 'needsAction'] as const

export default function FarmBookings() {
  usePageTitle('Farm Experience Bookings')
  const uid = useId()
  const [params, setParams] = useSearchParams()
  const query: BookingQuery = Object.fromEntries([...params.entries()].filter(([k]) => [...FILTER_KEYS, 'sort', 'dir', 'page', 'pageSize'].includes(k)))
  const overview = useQuery({ queryKey: ['farm-overview'], queryFn: farm.overview })
  const varieties = useQuery({ queryKey: ['farm-varieties'], queryFn: farm.varieties })
  const list = useQuery({ queryKey: ['farm-bookings', query], queryFn: () => farm.bookings(query), placeholderData: keepPreviousData })
  const update = (patch: Record<string, string | null>, resetPage = true) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    if (resetPage) next.delete('page')
    setParams(next, { replace: true })
  }
  const page = Number(params.get('page') ?? 1)
  const pageSize = Number(params.get('pageSize') ?? 25)
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1
  const anyFilter = FILTER_KEYS.some((k) => params.get(k))
  const field = (key: (typeof FILTER_KEYS)[number], label: string, type = 'text') => (
    <div className="field mb-0">
      <label htmlFor={`${uid}-${key}`}>{label}</label>
      <input id={`${uid}-${key}`} type={type} value={params.get(key) ?? ''} onChange={(e) => update({ [key]: e.target.value })} />
    </div>
  )

  return (
    <>
      <div className="topbar">
        <h1>Farm Experience Bookings</h1>
      </div>
      <p className="muted small">
        Part of Bulk Orders. Regular bulk orders are on <Link to="/bulk-deals">Bulk Deals</Link>.
      </p>
      <FarmSubnav />

      {overview.data && (
        <ul className="tiles" aria-label="Booking counts">
          {(
            [
              ['Need action', overview.data.needsAction, { needsAction: 'true' }],
              ['Stay to arrange', overview.data.byStatus.HOSPITALITY_REVIEW, { status: 'HOSPITALITY_REVIEW' }],
              ['Confirmed', overview.data.byStatus.CONFIRMED, { status: 'CONFIRMED' }],
              [
                'On the farm today',
                overview.data.byStatus.CHECKED_IN + overview.data.byStatus.HARVESTING + overview.data.byStatus.WEIGHING + overview.data.byStatus.PAYMENT_DUE + overview.data.byStatus.PACKING,
                { status: 'CHECKED_IN,HARVESTING,WEIGHING,PAYMENT_DUE,PACKING' },
              ],
              ['Bill to pay', overview.data.byStatus.PAYMENT_DUE, { status: 'PAYMENT_DUE' }],
              ['Refunds not finished', overview.data.refundsPending, null],
            ] as [string, number, Record<string, string> | null][]
          ).map(([label, n, f]) => (
            <li key={label}>
              {f ? (
                <button type="button" className="tile tile-btn" onClick={() => update({ ...Object.fromEntries(FILTER_KEYS.map((k) => [k, null])), ...f })}>
                  <div className="count">{n}</div>
                  <div className="label">{label}</div>
                </button>
              ) : (
                <div className="tile">
                  <div className="count">{n}</div>
                  <div className="label">{label}</div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="field-row mb-4 pn-filters">
        {field('q', 'Search (number, name, phone, email)')}
        <div className="field mb-0">
          <label htmlFor={`${uid}-status`}>Status</label>
          <select id={`${uid}-status`} value={params.get('status') ?? ''} onChange={(e) => update({ status: e.target.value })}>
            <option value="">All</option>
            {FARM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {FARM_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="field mb-0">
          <label htmlFor={`${uid}-variety`}>Variety</label>
          <select id={`${uid}-variety`} value={params.get('varietyId') ?? ''} onChange={(e) => update({ varietyId: e.target.value })}>
            <option value="">All</option>
            {(varieties.data ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field mb-0">
          <label htmlFor={`${uid}-payment`}>Payment</label>
          <select id={`${uid}-payment`} value={params.get('payment') ?? ''} onChange={(e) => update({ payment: e.target.value })}>
            <option value="">All</option>
            <option value="PAID">Bill paid</option>
            <option value="DUE">Bill to pay</option>
            <option value="REFUNDED">Refunded (any)</option>
          </select>
        </div>
        {field('visitFrom', 'Visit from', 'date')}
        {field('visitTo', 'Visit to', 'date')}
        {field('createdFrom', 'Booked from', 'date')}
        {field('createdTo', 'Booked to', 'date')}
        {field('minKg', 'Min kg', 'number')}
        {field('maxKg', 'Max kg', 'number')}
        {field('minGuests', 'Min guests', 'number')}
        {field('maxGuests', 'Max guests', 'number')}
        <div className="field mb-0">
          <label htmlFor={`${uid}-sort`}>Sort</label>
          <select
            id={`${uid}-sort`}
            value={`${params.get('sort') ?? 'created'}:${params.get('dir') ?? 'desc'}`}
            onChange={(e) => {
              const [sort, dir] = e.target.value.split(':')
              update({ sort, dir }, false)
            }}
          >
            <option value="created:desc">Newest booking first</option>
            <option value="visit:asc">Visit date, soonest first</option>
            <option value="visit:desc">Visit date, latest first</option>
            <option value="kg:desc">Most kg first</option>
            <option value="guests:desc">Largest group first</option>
            <option value="total:desc">Highest value first</option>
          </select>
        </div>
      </div>
      {anyFilter && (
        <p className="mb-3">
          <button type="button" className="link-btn" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            Clear filters
          </button>
        </p>
      )}

      {list.isPending ? (
        <Spinner label="Loading bookings" />
      ) : list.isError ? (
        <QueryError error={list.error} onRetry={() => list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState>{anyFilter ? 'No bookings match these filters.' : 'No Farm Experience bookings yet.'}</EmptyState>
      ) : (
        <>
          <div {...scrollRegion('Farm Experience bookings', { cards: true })} aria-busy={list.isFetching || undefined}>
            <table className="pn-table">
              <thead>
                <tr>
                  <th scope="col">Booking</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Variety and kg</th>
                  <th scope="col">Visit</th>
                  <th scope="col">Group</th>
                  <th scope="col">Payment</th>
                  <th scope="col">Stay</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((b) => (
                  <tr key={b.id}>
                    <td className="card-title">
                      <Link to={`/farm/bookings/${encodeURIComponent(b.id)}`}>
                        <span className="mono">{b.number}</span>
                      </Link>
                      <div className="muted small">Booked {date(b.createdAt)}</div>
                    </td>
                    <td data-label="Customer" className="pn-wrap">
                      {b.customerName}
                      <div className="muted small">{b.phone}</div>
                    </td>
                    <td data-label="Variety and kg">
                      {b.variety}, {b.kg} kg
                      <div className="muted small">{rupees(b.total)}</div>
                    </td>
                    <td data-label="Visit">
                      {date(b.visitDate)}
                      {(b.arrivalDate !== b.visitDate || b.departureDate !== b.visitDate) && (
                        <div className="muted small">
                          Stay {date(b.arrivalDate)} to {date(b.departureDate)}
                        </div>
                      )}
                    </td>
                    <td data-label="Group">
                      {b.adults} adults, {b.children} children
                      <div className="muted small">{b.overnight} overnight</div>
                      {b.overCapacity && <Badge tone="warn">Over farmhouse capacity</Badge>}
                    </td>
                    <td data-label="Payment">
                      {b.paidAt ? `Paid ${rupees(b.billAmount ?? 0)}` : b.billAmount != null ? `Bill ${rupees(b.billAmount)} to pay` : 'After picking'}
                      {b.refundStatus && <div className="muted small">{b.refundStatus === 'REFUNDED' ? 'Refunded' : 'Refund pending'}</div>}
                    </td>
                    <td data-label="Stay">{HOSPITALITY_LABEL[b.hospitalityStatus]}</td>
                    <td className="card-status">
                      <FarmBadge status={b.status} />
                      {b.request && <div className="small">{b.request === 'CANCEL' ? 'Asks to cancel' : 'Asks to move'}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager pn-pager">
            <span className="muted small">
              Page {page} of {totalPages} · {list.data.total} bookings
            </span>
            <div className="field mb-0 pn-page-size">
              <label htmlFor={`${uid}-size`} className="sr-only">
                Rows per page
              </label>
              <select id={`${uid}-size`} value={pageSize} onChange={(e) => update({ pageSize: e.target.value })}>
                {[25, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n} per page
                  </option>
                ))}
              </select>
            </div>
            <button type="button" className="btn btn-small" disabled={page <= 1} onClick={() => update({ page: String(page - 1) }, false)}>
              Previous
            </button>
            <button type="button" className="btn btn-small" disabled={page >= totalPages} onClick={() => update({ page: String(page + 1) }, false)}>
              Next
            </button>
          </div>
        </>
      )}
    </>
  )
}
