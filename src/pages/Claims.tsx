import { useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { ISSUE_LABEL, RESOLUTION_LABEL, dateTime, rupees } from '../format'
import type { Claim, ClaimStatus } from '../types'
import { Badge, ClaimBadge, Dialog, EmptyState, FormError, QueryError, Spinner, useToast } from '../ui'

const FILTERS: { value: ClaimStatus | null; label: string }[] = [
  { value: null, label: 'All open' },
  { value: 'SUBMITTED', label: 'Submitted' },
  { value: 'UNDER_REVIEW', label: 'Under review' },
  { value: 'RESOLVED', label: 'Resolved' },
]

function useClaimsRefresh() {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: ['claims'] })
    queryClient.invalidateQueries({ queryKey: ['summary'] })
  }
}

export default function Claims() {
  const [params, setParams] = useSearchParams()
  const status = (params.get('status') as ClaimStatus | null) || null
  const q = useQuery({ queryKey: ['claims', status], queryFn: () => api.claims(status) })
  const [resolving, setResolving] = useState<Claim | null>(null)

  return (
    <>
      <div className="topbar">
        <h1>Claims</h1>
      </div>
      <div className="segmented" role="group" aria-label="Filter claims" style={{ marginBottom: '1rem' }}>
        {FILTERS.map((f) => (
          <button
            key={f.label}
            type="button"
            className="btn btn-small"
            aria-pressed={status === f.value}
            onClick={() => setParams(f.value ? { status: f.value } : {})}
          >
            {f.label}
          </button>
        ))}
      </div>

      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState>No claims here.</EmptyState>
      ) : (
        q.data.map((c) => <ClaimCard key={c.id} claim={c} onResolve={() => setResolving(c)} />)
      )}

      {resolving && <ResolveDialog claim={resolving} onClose={() => setResolving(null)} />}
    </>
  )
}

function ClaimCard({ claim, onResolve }: { claim: Claim; onResolve: () => void }) {
  const toast = useToast()
  const refresh = useClaimsRefresh()
  const review = useMutation({
    mutationFn: () => api.reviewClaim(claim.id),
    onSuccess: () => {
      toast.success(`Review started for ${claim.orderNumber}`)
      refresh()
    },
    onError: (err) => toast.error(err),
  })

  return (
    <article className="card">
      <div className="topbar" style={{ marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>
          <Link to={`/orders/${claim.orderId}`}>{claim.orderNumber}</Link>
        </h2>
        <Badge tone="warn">{ISSUE_LABEL[claim.issueType] ?? claim.issueType}</Badge>
        <ClaimBadge status={claim.status} />
        {claim.createdAt && <span className="muted small">{dateTime(claim.createdAt)}</span>}
        <span className="spacer" />
        {claim.status === 'SUBMITTED' && (
          <button type="button" className="btn btn-primary" disabled={review.isPending} onClick={() => review.mutate()}>
            Start review<span className="sr-only"> for {claim.orderNumber}</span>
          </button>
        )}
        {claim.status === 'UNDER_REVIEW' && (
          <button type="button" className="btn btn-primary" onClick={onResolve}>
            Resolve<span className="sr-only"> {claim.orderNumber}</span>
          </button>
        )}
      </div>
      {!!claim.managerNeeded?.length && (
        <p className="notice notice-warn" role="note">
          A manager has to approve a replacement: {claim.managerNeeded.join(', and ')}.
        </p>
      )}
      <dl className="kv">
        <dt>Phone</dt>
        <dd>{claim.customerPhone ?? '—'}</dd>
        {claim.history && (
          <>
            <dt>Last 90 days</dt>
            <dd>
              {claim.history.claims90d} other claim{claim.history.claims90d === 1 ? '' : 's'}, {claim.history.replacements90d} replaced
            </dd>
          </>
        )}
        {claim.delivery !== undefined && (
          <>
            <dt>Delivered</dt>
            <dd>
              {claim.delivery
                ? `${{ code: "with the customer's code", photo: 'with a photo', staff: 'marked by staff, no proof' }[claim.delivery.method]}, ${dateTime(claim.delivery.at)}`
                : 'No delivery record'}
            </dd>
          </>
        )}
        <dt>Order total</dt>
        <dd>{rupees(claim.orderTotal)}</dd>
        <dt>Affected items</dt>
        <dd>{claim.affectedItems.length ? claim.affectedItems.join(', ') : '—'}</dd>
        {!!claim.photos?.length && (
          <>
            <dt>Photos</dt>
            <dd className="claim-photos">
              {claim.photos.map((p, i) => (
                <ClaimPhoto key={p.id} claimId={claim.id} photoId={p.id} n={i + 1} />
              ))}
            </dd>
          </>
        )}
        {claim.photoUrl && (
          <>
            <dt>Photo</dt>
            <dd>
              <a href={claim.photoUrl} target="_blank" rel="noopener noreferrer">
                Open photo<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </dd>
          </>
        )}
        {claim.status === 'RESOLVED' && claim.resolution && (
          <>
            <dt>Resolution</dt>
            <dd>{RESOLUTION_LABEL[claim.resolution] ?? claim.resolution}</dd>
          </>
        )}
        {claim.replacementOrder && (
          <>
            <dt>Replacement</dt>
            <dd>
              <Link to={`/orders/${claim.replacementOrder.id}`}>{claim.replacementOrder.number}</Link>
            </dd>
          </>
        )}
      </dl>
      <p style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{claim.description}</p>
    </article>
  )
}

type Resolution = 'REPLACEMENT_APPROVED' | 'REJECTED'

function ResolveDialog({ claim, onClose }: { claim: Claim; onClose: () => void }) {
  const toast = useToast()
  const refresh = useClaimsRefresh()
  const [resolution, setResolution] = useState<Resolution>('REPLACEMENT_APPROVED')

  const resolve = useMutation({
    mutationFn: () => api.resolveClaim(claim.id, resolution),
    onSuccess: () => {
      toast.success(`Claim on ${claim.orderNumber} resolved: ${RESOLUTION_LABEL[resolution]}`)
      refresh()
      onClose()
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    resolve.mutate()
  }

  return (
    <Dialog
      title={`Resolve claim on ${claim.orderNumber}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="resolve-form" className="btn btn-primary" disabled={resolve.isPending}>
            {resolve.isPending ? 'Saving…' : resolution === 'REPLACEMENT_APPROVED' ? 'Approve replacement' : 'Reject claim'}
          </button>
        </>
      }
    >
      <form id="resolve-form" onSubmit={onSubmit}>
        <fieldset>
          <legend>Resolution</legend>
          <div className="radio-row" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
            <label>
              <input
                type="radio"
                name="resolution"
                checked={resolution === 'REPLACEMENT_APPROVED'}
                onChange={() => setResolution('REPLACEMENT_APPROVED')}
              />
              Replacement: send the customer {claim.affectedItems.length ? claim.affectedItems.join(', ') : 'the affected items'} again
            </label>
            <label>
              <input type="radio" name="resolution" checked={resolution === 'REJECTED'} onChange={() => setResolution('REJECTED')} />
              Reject
            </label>
          </div>
        </fieldset>
        <p className="muted small">This closes the claim. It cannot be reopened from here.</p>
        <FormError error={resolve.error} />
      </form>
    </Dialog>
  )
}

function ClaimPhoto({ claimId, photoId, n }: { claimId: string; photoId: string; n: number }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let made: string | null = null
    let live = true
    api
      .claimPhotoUrl(claimId, photoId)
      .then((u) => {
        made = u
        if (live) setUrl(u)
        else URL.revokeObjectURL(u)
      })
      .catch(() => live && setFailed(true))
    return () => {
      live = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [claimId, photoId])
  if (failed) return <span className="small muted">Photo {n} could not be loaded.</span>
  if (!url) return <span className="small muted">Loading photo {n}…</span>
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      <img src={url} alt={`Customer's photo ${n}`} />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}
