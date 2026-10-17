import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { dateTime } from '../format'
import { useToast } from '../ui'

const STEP_LABEL: Record<string, string> = {
  reconcile: 'Checking missed payments',
  refunds: 'Sending refunds',
  preorders: 'Preorder jobs',
  notifications: 'Sending WhatsApp updates',
  sweep: 'Releasing unpaid holds',
  cleanup: 'Clean-up',
  retire: 'Retiring old batches',
  'rebalance-all': 'Re-checking all open orders',
  'rebalance-at-risk': 'Re-checking at-risk orders',
  audit: 'Stock audit',
  config: 'Loading rules',
}

/**
 * The problems nobody is watching for: the background loop stalling or failing,
 * WhatsApp messages given up on, refunds that haven't gone through, and webhooks
 * that failed or named an order we don't have. Hidden when all is well.
 */
export default function NeedsAttention() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const q = useQuery({ queryKey: ['attention'], queryFn: api.attention, refetchInterval: 60_000 })
  const retry = useMutation({
    mutationFn: (id: string) => api.retryMessage(id),
    onSuccess: () => {
      toast.success('Message queued to send again')
      queryClient.invalidateQueries({ queryKey: ['attention'] })
    },
    onError: (err) => toast.error(err),
  })

  if (!q.data) return null
  const a = q.data
  const count = (a.loop.stale ? 1 : 0) + a.loop.failingSteps.length + a.failedMessages.length + a.stuckRefunds.length + a.webhookFailures.length
  if (count === 0) return null

  return (
    <section className="card attention" aria-labelledby="attention-title">
      <h2 id="attention-title">Needs attention</h2>
      <ul className="attention-list">
        {a.loop.stale && (
          <li>
            <strong>The background loop has stopped.</strong>{' '}
            {a.loop.lastRunAt ? `It last ran at ${dateTime(a.loop.lastRunAt)}.` : 'It has not run yet.'} Payments, refunds, WhatsApp
            updates and hold releases wait until it runs again. Restart the API.
          </li>
        )}
        {a.loop.failingSteps.map((s) => (
          <li key={s.step}>
            <strong>{STEP_LABEL[s.step] ?? s.step} is failing</strong> since {dateTime(s.since)}
            {s.error ? <span className="muted">: {s.error}</span> : null}
          </li>
        ))}
        {a.stuckRefunds.map((r) => (
          <li key={r.id}>
            <strong>Refund not sent</strong> for {r.type === 'order' ? <Link to={`/orders/${r.id}`}>{r.number}</Link> : r.number}, asked
            for at {dateTime(r.requestedAt)}. It retries every minute; check Razorpay if this stays.
          </li>
        ))}
        {a.failedMessages.map((m) => (
          <li key={m.id}>
            <strong>WhatsApp message not delivered</strong> ({m.kind.toLowerCase().replace(/_/g, ' ')}) for{' '}
            {m.order ? <Link to={`/orders/${m.order.id}`}>{m.order.number}</Link> : (m.preorderNumber ?? m.phone)} after {m.attempts} tries
            {m.error ? <span className="muted">: {m.error}</span> : null}{' '}
            <button type="button" className="btn btn-small" disabled={retry.isPending} onClick={() => retry.mutate(m.id)}>
              Send again<span className="sr-only"> for {m.order?.number ?? m.preorderNumber ?? 'this customer'}</span>
            </button>
          </li>
        ))}
        {a.webhookFailures.map((w) => (
          <li key={w.id}>
            <strong>{w.source === 'razorpay' ? 'Razorpay' : 'WhatsApp'} webhook problem</strong> at {dateTime(w.createdAt)}
            <span className="muted">: {w.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
