import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from './api'
import { useStore } from './store'

/**
 * Points a signed-in customer at an unpaid order that still holds boxes, so a reload
 * mid-payment or a new cart doesn't lead to paying twice (FE-5). The API also refuses a
 * second unpaid order (UNPAID_ORDER_EXISTS); this says so before they try.
 */
export function UnpaidOrderBanner() {
  const { profile } = useStore()
  const q = useQuery({ queryKey: ['orders'], queryFn: api.orders, enabled: Boolean(profile), staleTime: 10_000 })
  const now = Date.now()
  const open = q.data?.find((o) => o.status === 'PAYMENT_PENDING' && o.holdExpiresAt && new Date(o.holdExpiresAt).getTime() > now)
  if (!open) return null
  return (
    <p className="note unpaid-banner" role="status">
      <span>
        <strong>Order {open.number} is waiting for payment.</strong> Pay for it or cancel it before placing another order.
      </span>{' '}
      <Link to={`/orders/${open.id}`}>Open order {open.number}</Link>
    </p>
  )
}
