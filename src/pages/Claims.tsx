import { useId, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { ISSUE_LABEL, RESOLUTION_LABEL, dateTime, rupees } from '../format'
import type { Claim, ClaimStatus } from '../types'
import { AuthedPhoto, Badge, ClaimBadge, Dialog, EmptyState, FormError, PhoneLink, QueryError, Spinner, useToast, usePageTitle } from '../ui'

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
  usePageTitle('Claims')
  const [params, setParams] = useSearchParams()
  const status = (params.get('status') as ClaimStatus | null) || null
  const q = useQuery({ queryKey: ['claims', status], queryFn: () => api.claims(status) })
  const [resolving, setResolving] = useState<Claim | null>(null)

  return (
    <>
      <div className="topbar">
        <h1>Claims</h1>
      </div>
      <div className="segmented mb-4" role="group" aria-label="Filter claims">
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
      <div className="topbar section-head">
        <h2>
          <Link to={`/orders/${claim.orderId}`}>{claim.orderNumber}</Link>
        </h2>
        <Badge>{ISSUE_LABEL[claim.issueType] ?? claim.issueType}</Badge>
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
        <dd>
          <PhoneLink phone={claim.customerPhone} who="the customer" />
        </dd>
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
        {claim.photoUrl && ownPhotoLink(claim.photoUrl) && (
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
        {claim.status === 'RESOLVED' && claim.rejectionReason && (
          <>
            <dt>Reason given</dt>
            <dd className="pre-wrap">{claim.rejectionReason}</dd>
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
      <p className="mb-0 pre-wrap">{claim.description}</p>
    </article>
  )
}

type Resolution = 'REPLACEMENT_APPROVED' | 'REJECTED'
/** A rejection says why (the API refuses fewer characters); the customer reads it. */
const MIN_REASON = 5

function ResolveDialog({ claim, onClose }: { claim: Claim; onClose: () => void }) {
  const toast = useToast()
  const refresh = useClaimsRefresh()
  const id = useId()
  const [resolution, setResolution] = useState<Resolution | null>(null)
  const [reason, setReason] = useState('')
  const reasonOk = resolution !== 'REJECTED' || reason.trim().length >= MIN_REASON

  const resolve = useMutation({
    mutationFn: (r: Resolution) => api.resolveClaim(claim.id, r, r === 'REJECTED' ? reason.trim() : undefined),
    onSuccess: (_x, r) => {
      toast.success(`Claim on ${claim.orderNumber} resolved: ${RESOLUTION_LABEL[r]}`)
      refresh()
      onClose()
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (resolution && reasonOk) resolve.mutate(resolution)
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
          <button type="submit" form="resolve-form" className="btn btn-primary" disabled={!resolution || !reasonOk || resolve.isPending}>
            {resolve.isPending ? 'Saving…' : resolution === 'REPLACEMENT_APPROVED' ? 'Approve replacement' : resolution === 'REJECTED' ? 'Reject claim' : 'Resolve claim'}
          </button>
        </>
      }
    >
      <form id="resolve-form" onSubmit={onSubmit}>
        <fieldset>
          <legend>Resolution</legend>
          <div className="option-list">
            <label className="option-row">
              <input
                type="radio"
                name="resolution"
                checked={resolution === 'REPLACEMENT_APPROVED'}
                onChange={() => setResolution('REPLACEMENT_APPROVED')}
              />
              Replacement: send the customer {claim.affectedItems.length ? claim.affectedItems.join(', ') : 'the affected items'} again
            </label>
            <label className="option-row">
              <input type="radio" name="resolution" checked={resolution === 'REJECTED'} onChange={() => setResolution('REJECTED')} />
              Reject
            </label>
          </div>
        </fieldset>
        {/* UX-4 / ADM-3: a rejection needs a reason, which the customer sees. */}
        {resolution === 'REJECTED' && (
          <div className="field">
            <label htmlFor={`${id}-reason`}>Reason for the customer</label>
            <textarea
              id={`${id}-reason`}
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-describedby={`${id}-reason-hint`}
            />
            <p id={`${id}-reason-hint`} className="hint">
              The customer sees this on their order page and on WhatsApp, so write it to them. At least {MIN_REASON} characters.
            </p>
          </div>
        )}
        <p className="muted small">This closes the claim. It cannot be reopened from here.</p>
        <FormError error={resolve.error} />
      </form>
    </Dialog>
  )
}

function ClaimPhoto({ claimId, photoId, n }: { claimId: string; photoId: string; n: number }) {
  return (
    <AuthedPhoto
      photoKey={`${claimId}/${photoId}`}
      load={() => api.claimPhotoUrl(claimId, photoId)}
      alt={`Customer's photo ${n}`}
      what={`photo ${n}`}
      openInTab
    />
  )
}

/** The API only passes on links into our own photo store; checked again here before staff are offered one. */
function ownPhotoLink(link: string) {
  try {
    const u = new URL(link)
    return u.protocol === 'https:' && u.hostname.endsWith('.blob.vercel-storage.com')
  } catch {
    return false
  }
}
