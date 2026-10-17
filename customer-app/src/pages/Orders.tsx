import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
import { PREORDER_LABEL, STATUS_LABEL, day, rupees, week } from '../format'
import { ErrorNote, Spinner } from '../ui'
import { StatusPill } from './Order'
import { PreorderPill } from './Preorder'

export default function Orders() {
  const q = useQuery({ queryKey: ['orders'], queryFn: api.orders })
  const pre = useQuery({ queryKey: ['preorders'], queryFn: api.preorders })
  if (q.isPending || pre.isPending) return <Spinner label="Loading your orders" />
  if (q.isError) return <ErrorNote error={q.error} onRetry={() => q.refetch()} />
  // A booking whose day is set shows up as its order; the rest are listed apart.
  const bookings = (pre.data ?? []).filter((p) => p.status !== 'CONVERTED')
  if (!q.data.length && !bookings.length) {
    return (
      <section className="card empty">
        <h1>No orders yet</h1>
        <Link to="/" className="btn btn-primary">
          Shop mangoes
        </Link>
      </section>
    )
  }
  return (
    <>
      <h1>My orders</h1>
      {pre.isError && <ErrorNote error={pre.error} onRetry={() => pre.refetch()} />}
      {bookings.length > 0 && (
        <section aria-labelledby="booked-ahead">
          <h2 id="booked-ahead" className="section-title">
            Booked ahead
          </h2>
          <ul className="order-list">
            {bookings.map((p) => (
              <li key={p.id}>
                <Link
                  to={`/preorders/${p.id}`}
                  className="card order-card"
                  aria-label={`Booking ${p.number}, ${PREORDER_LABEL[p.status]}, week of ${week(p.weekStart)}`}
                >
                  <div>
                    <strong>Booking {p.number}</strong>
                    <span className="muted small">
                      {p.qty} {p.qty === 1 ? 'box' : 'boxes'} · {rupees(p.total)} · week of {week(p.weekStart)}
                    </span>
                  </div>
                  <PreorderPill status={p.status} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {q.data.length > 0 && (
        <section aria-labelledby="orders-list">
          {bookings.length > 0 && (
            <h2 id="orders-list" className="section-title">
              Orders
            </h2>
          )}
          <ul className="order-list" aria-labelledby={bookings.length > 0 ? 'orders-list' : undefined}>
            {q.data.map((o) => (
              <li key={o.id}>
                <Link to={`/orders/${o.id}`} className="card order-card" aria-label={`Order ${o.number}, ${STATUS_LABEL[o.status]}, ${day(o.deliveryDate)}`}>
                  <div>
                    <strong>Order {o.number}</strong>
                    <span className="muted small">
                      {o.itemCount} {o.itemCount === 1 ? 'box' : 'boxes'} · {rupees(o.total)} · {o.status === 'DELIVERED' ? 'delivered' : 'arrives'} {day(o.deliveryDate)}
                    </span>
                  </div>
                  <StatusPill status={o.status} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
