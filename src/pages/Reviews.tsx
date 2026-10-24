import { Fragment, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { RIPENESS_LABEL, date, dateTime } from '../format'
import { canModerate, canSee } from '../permissions'
import { useSession } from '../session'
import type { ReviewFilters, ReviewFlag, ReviewStatus } from '../types'
import { AuthedPhoto, Badge, Dialog, EmptyState, FormError, QueryError, ReasonDialog, Spinner, scrollRegion, useToast, usePageTitle } from '../ui'

const STATUSES: { value: ReviewStatus; label: string }[] = [
  { value: 'PENDING', label: 'Waiting' },
  { value: 'APPROVED', label: 'Published' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'HIDDEN', label: 'Hidden' },
]
const FLAG_LABEL: Record<ReviewFlag, string> = { LINK: 'Link', EMAIL: 'Email', PHONE: 'Phone number', PROFANITY: 'Swearing' }
const SUBS = [
  ['taste', 'Taste'],
  ['ripenessAccuracy', 'Ripe as promised'],
  ['packaging', 'Packaging'],
  ['delivery', 'Delivery'],
] as const

const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n)
function StarText({ n }: { n: number }) {
  return (
    <span className="review-stars" role="img" aria-label={`${n} out of 5 stars`}>
      <span aria-hidden="true">{stars(n)}</span>
    </span>
  )
}

/**
 * Customer reviews: the moderation queue (managers and operators) and what
 * reviews say about each variety and batch (also QC). Nothing is public until
 * it is approved here; photos need their own tick.
 */
export default function Reviews() {
  usePageTitle('Reviews')
  const { me } = useSession()
  const moderator = canModerate(me?.role)
  return (
    <>
      <div className="topbar">
        <h1>Reviews</h1>
      </div>
      {moderator && <Queue />}
      <Insights />
    </>
  )
}

function useRefresh() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['reviews'] })
    void queryClient.invalidateQueries({ queryKey: ['review'] })
    void queryClient.invalidateQueries({ queryKey: ['review-insights'] })
    void queryClient.invalidateQueries({ queryKey: ['attention'] })
  }
}

function Queue() {
  const [filters, setFilters] = useState<ReviewFilters>({ status: 'PENDING' })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [openId, setOpenId] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const toast = useToast()
  const refresh = useRefresh()
  const products = useQuery({ queryKey: ['products'], queryFn: api.products })
  const varieties = [...new Set((products.data ?? []).map((p) => p.variety).filter(Boolean))].sort()
  const q = useInfiniteQuery({
    queryKey: ['reviews', filters],
    queryFn: ({ pageParam }) => api.reviews({ ...filters, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  })
  useEffect(() => setSelected(new Set()), [filters])

  const bulk = useMutation({
    mutationFn: ({ action, reason }: { action: 'approve' | 'reject'; reason?: string }) => api.bulkReviews(action, [...selected], reason),
    onSuccess: (r, v) => {
      if (r.done.length) toast.success(`${r.done.length} ${r.done.length === 1 ? 'review' : 'reviews'} ${v.action === 'approve' ? 'published' : 'rejected'}`)
      if (r.failed.length) toast.error(`${r.failed.length} could not be changed (someone else may have moderated them)`)
      setSelected(new Set())
      setRejecting(false)
      refresh()
    },
    onError: (err) => toast.error(err),
  })

  const set = (patch: Partial<ReviewFilters>) => setFilters((f) => ({ ...f, ...patch }))
  const items = q.data?.pages.flatMap((p) => p.items) ?? []
  const counts = q.data?.pages[0]?.counts ?? {}
  const pending = filters.status === 'PENDING'
  const allChosen = items.length > 0 && items.every((r) => selected.has(r.id))
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else if (n.size < 50) n.add(id)
      return n
    })

  return (
    <section aria-labelledby="queue-title">
      <h2 id="queue-title" className="sr-only">
        Moderation queue
      </h2>
      <div className="segmented mb-3" role="group" aria-label="Review status">
        {STATUSES.map((s) => (
          <button key={s.value} type="button" className="btn btn-small" aria-pressed={filters.status === s.value} onClick={() => set({ status: s.value })}>
            {s.label}
            {counts[s.value]?.total ? <span className="muted"> ({counts[s.value]!.total})</span> : null}
          </button>
        ))}
      </div>
      <div className="field-inline review-filters">
        <div className="field">
          <label htmlFor="rf-stars">Stars</label>
          <select id="rf-stars" value={filters.stars ?? ''} onChange={(e) => set({ stars: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Any</option>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? 'star' : 'stars'}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rf-photos">Photos</label>
          <select
            id="rf-photos"
            value={filters.hasPhotos == null ? '' : String(filters.hasPhotos)}
            onChange={(e) => set({ hasPhotos: e.target.value === '' ? null : e.target.value === 'true' })}
          >
            <option value="">Any</option>
            <option value="true">With photos</option>
            <option value="false">Without photos</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="rf-variety">Variety</label>
          <select id="rf-variety" value={filters.variety ?? ''} onChange={(e) => set({ variety: e.target.value || null })}>
            <option value="">All</option>
            {varieties.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </div>
        <label className="check-inline">
          <input type="checkbox" checked={filters.flagged === true} onChange={(e) => set({ flagged: e.target.checked ? true : null })} />
          Needs attention only
        </label>
      </div>

      {pending && selected.size > 0 && (
        <div className="bulk-bar" role="region" aria-label="Bulk actions">
          <span>
            {selected.size} selected{selected.size >= 50 ? ' (50 at most)' : ''}. Bulk approval publishes the text only; photos need a
            look one by one.
          </span>
          <button type="button" className="btn btn-primary btn-small" disabled={bulk.isPending} onClick={() => bulk.mutate({ action: 'approve' })}>
            Approve {selected.size}
          </button>
          <button type="button" className="btn btn-small" disabled={bulk.isPending} onClick={() => setRejecting(true)}>
            Reject {selected.size}
          </button>
        </div>
      )}

      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState>No reviews here.</EmptyState>
      ) : (
        <div {...scrollRegion('Reviews')}>
          <table>
            <thead>
              <tr>
                {pending && (
                  <th scope="col">
                    <input
                      type="checkbox"
                      aria-label="Select all shown reviews"
                      checked={allChosen}
                      onChange={() => setSelected(allChosen ? new Set() : new Set(items.slice(0, 50).map((r) => r.id)))}
                    />
                  </th>
                )}
                <th scope="col">Stars</th>
                <th scope="col">Product</th>
                <th scope="col">Review</th>
                <th scope="col">Photos</th>
                <th scope="col">Sent</th>
                <th scope="col">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className={r.flagged ? 'row-flagged' : undefined}>
                  {pending && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select review from ${r.displayName} on ${r.orderNumber ?? r.productName}`}
                        checked={selected.has(r.id)}
                        onChange={() => toggle(r.id)}
                      />
                    </td>
                  )}
                  <td>
                    <StarText n={r.rating} />
                  </td>
                  <td>
                    {r.productName}
                    <div className="muted small">{r.ripenessOrdered ? RIPENESS_LABEL[r.ripenessOrdered] : ''}</div>
                  </td>
                  <td className="review-excerpt">
                    {r.flagged && (
                      <div>
                        {r.flagReasons.map((f) => (
                          <Badge key={f} tone="bad">
                            {FLAG_LABEL[f]}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {r.comment ? <span>{r.comment.length > 140 ? `${r.comment.slice(0, 140)}…` : r.comment}</span> : <span className="muted">Stars only</span>}
                    {r.reply && <div className="muted small">Replied</div>}
                  </td>
                  <td>{r.photos.length || '—'}</td>
                  <td className="small">{dateTime(r.createdAt)}</td>
                  <td>
                    <button type="button" className="btn btn-small" onClick={() => setOpenId(r.id)}>
                      Open<span className="sr-only"> review from {r.displayName}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.hasNextPage && (
        <button type="button" className="btn" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {q.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </button>
      )}

      {openId && <ReviewDrawer id={openId} onClose={() => setOpenId(null)} />}
      {rejecting && (
        <ReasonDialog
          title={`Reject ${selected.size} ${selected.size === 1 ? 'review' : 'reviews'}`}
          label="Reason (the customer sees it on their account page)"
          maxLength={500}
          confirmLabel="Reject"
          busy={bulk.isPending}
          error={bulk.error}
          onClose={() => setRejecting(false)}
          onSubmit={(reason) => bulk.mutate({ action: 'reject', reason })}
        />
      )}
    </section>
  )
}

/** The reason for rejecting or hiding, asked inside the drawer (no dialog on top of a dialog). */
function ReasonForm({
  action,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  action: string
  pending: boolean
  error: unknown
  onCancel: () => void
  onSubmit: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | null>(null)
  return (
    <form
      className="reason-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (reason.trim().length < 3) return setErr('Give a short reason.')
        onSubmit(reason.trim())
      }}
    >
      <div className="field">
        <label htmlFor="drawer-reason">Reason for “{action.toLowerCase()}” (the customer sees it on their account page)</label>
        <textarea id="drawer-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </div>
      {err && <p className="form-error">{err}</p>}
      <FormError error={error} />
      <div className="btn-row">
        <button type="submit" className="btn btn-danger btn-small" disabled={pending}>
          {pending ? 'Saving…' : action}
        </button>
        <button type="button" className="btn btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function ReviewDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast()
  const refresh = useRefresh()
  const { me } = useSession()
  const q = useQuery({ queryKey: ['review', id], queryFn: () => api.review(id) })
  const [approvePhotos, setApprovePhotos] = useState<Set<string>>(new Set())
  const [ask, setAsk] = useState<'reject' | 'hide' | null>(null)
  const [reply, setReply] = useState<string | null>(null)
  // Removing a public reply asks first, inline (this is already a dialog).
  const [confirmRemove, setConfirmRemove] = useState(false)

  const done = (msg: string) => {
    toast.success(msg)
    refresh()
  }
  const approve = useMutation({ mutationFn: () => api.approveReview(id, [...approvePhotos]), onSuccess: () => done('Review published'), onError: (e) => toast.error(e) })
  const moderate = useMutation({
    mutationFn: ({ what, reason }: { what: 'reject' | 'hide'; reason: string }) => (what === 'reject' ? api.rejectReview(id, reason) : api.hideReview(id, reason)),
    onSuccess: (_r, v) => {
      setAsk(null)
      done(v.what === 'reject' ? 'Review rejected' : 'Review hidden')
    },
  })
  const saveReply = useMutation({
    mutationFn: (body: string) => api.replyToReview(id, body),
    onSuccess: () => {
      setReply(null)
      done('Reply saved')
    },
    onError: (e) => toast.error(e),
  })
  const removeReply = useMutation({
    mutationFn: () => api.deleteReviewReply(id),
    onSuccess: () => {
      setConfirmRemove(false)
      done('Reply removed')
    },
    onError: (e) => toast.error(e),
  })

  const r = q.data
  return (
    <Dialog
      title={r ? `Review from ${r.displayName}` : 'Review'}
      onClose={onClose}
      variant="drawer"
      footer={
        r && (
          <>
            {r.status === 'PENDING' && (
              <>
                <button type="button" className="btn btn-primary" disabled={approve.isPending} onClick={() => approve.mutate()}>
                  {approve.isPending ? 'Publishing…' : approvePhotos.size ? `Publish with ${approvePhotos.size} ${approvePhotos.size === 1 ? 'photo' : 'photos'}` : 'Publish'}
                </button>
                <button type="button" className="btn" onClick={() => setAsk('reject')}>
                  Reject
                </button>
              </>
            )}
            {r.status === 'APPROVED' && (
              <button type="button" className="btn" onClick={() => setAsk('hide')}>
                Hide
              </button>
            )}
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </>
        )
      }
    >
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : (
        r && (
          <div className="review-detail">
            <p>
              <StarText n={r.rating} /> <Badge tone={r.status === 'APPROVED' ? 'good' : r.status === 'PENDING' ? 'info' : 'neutral'}>{STATUSES.find((s) => s.value === r.status)?.label ?? r.status}</Badge>
              {r.flagged &&
                r.flagReasons.map((f) => (
                  <Badge key={f} tone="bad">
                    {FLAG_LABEL[f]}
                  </Badge>
                ))}
            </p>
            {r.comment ? <p className="review-comment">{r.comment}</p> : <p className="muted">No text, stars only.</p>}
            <dl className="kv">
              {SUBS.filter(([k]) => r[k] != null).map(([k, label]) => (
                <Fragment key={k}>
                  <dt>{label}</dt>
                  <dd>
                    <StarText n={r[k]!} />
                  </dd>
                </Fragment>
              ))}
              <dt>Product</dt>
              <dd>
                {r.productName}
                {r.ripenessOrdered && `, ordered ${RIPENESS_LABEL[r.ripenessOrdered].toLowerCase()}`}
              </dd>
              <dt>Order</dt>
              <dd>{canSee(me?.role, 'orderDetail') ? <Link to={`/orders/${r.orderId}`}>{r.orderNumber}</Link> : r.orderNumber}</dd>
              <dt>Customer</dt>
              <dd>
                {r.scrubbed ? 'Account deleted' : (r.customerName ?? '—')}
                <span className="muted"> (shown as {r.displayName})</span>
              </dd>
              <dt>Delivered</dt>
              <dd>{dateTime(r.deliveredAt)}</dd>
              <dt>Sent</dt>
              <dd>{dateTime(r.createdAt)}</dd>
              {r.batches.length > 0 && (
                <>
                  <dt>From batch</dt>
                  <dd>
                    {r.batches.map((b, i) => (
                      <span key={b.batchId}>
                        {i > 0 && ', '}
                        <Link to={`/batches/${b.batchId}`}>
                          {b.variety} picked {date(b.pluckedOn)}
                        </Link>
                      </span>
                    ))}
                  </dd>
                </>
              )}
              {r.moderationReason && (
                <>
                  <dt>Reason</dt>
                  <dd>{r.moderationReason}</dd>
                </>
              )}
            </dl>

            {r.photos.length > 0 && (
              <fieldset className="review-photo-picks">
                <legend>Photos {r.status === 'PENDING' ? '(tick the ones to publish)' : ''}</legend>
                <ul>
                  {r.photos.map((p, i) => (
                    <li key={p.id}>
                      <ReviewPhoto reviewId={r.id} photoId={p.id} n={i + 1} />
                      {r.status === 'PENDING' ? (
                        <label className="check-inline">
                          <input
                            type="checkbox"
                            checked={approvePhotos.has(p.id)}
                            onChange={() =>
                              setApprovePhotos((s) => {
                                const n = new Set(s)
                                if (n.has(p.id)) n.delete(p.id)
                                else n.add(p.id)
                                return n
                              })
                            }
                          />
                          Publish photo {i + 1}
                        </label>
                      ) : (
                        <span className="small muted">{p.approved ? 'Published' : 'Not published'}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </fieldset>
            )}

            <section aria-labelledby="reply-title" className="review-reply">
              <h3 id="reply-title">Reply from MandiMangoes</h3>
              {reply == null ? (
                r.reply ? (
                  <>
                    <p className="review-comment">{r.reply.body}</p>
                    <p className="muted small">
                      {r.reply.by ?? 'Staff'}, {dateTime(r.reply.at)}
                    </p>
                    {confirmRemove ? (
                      <div className="notice notice-warn" role="group" aria-label="Remove reply?">
                        <p className="mt-0">Remove this reply? Customers stop seeing it under the review.</p>
                        <div className="btn-row">
                          <button type="button" className="btn btn-small btn-danger" disabled={removeReply.isPending} onClick={() => removeReply.mutate()}>
                            {removeReply.isPending ? 'Removing…' : 'Yes, remove reply'}
                          </button>
                          <button type="button" className="btn btn-small" onClick={() => setConfirmRemove(false)}>
                            Keep reply
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="btn-row">
                        <button type="button" className="btn btn-small" onClick={() => setReply(r.reply!.body)}>
                          Change reply
                        </button>
                        <button type="button" className="btn btn-small" onClick={() => setConfirmRemove(true)}>
                          Remove reply
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <button type="button" className="btn btn-small" onClick={() => setReply('')}>
                    Write a reply
                  </button>
                )
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (reply.trim()) saveReply.mutate(reply.trim())
                  }}
                >
                  <div className="field">
                    <label htmlFor="reply-body">Public reply (shown under the review once it is published)</label>
                    <textarea id="reply-body" rows={3} maxLength={1000} value={reply} onChange={(e) => setReply(e.target.value)} />
                    <p className="hint">{1000 - reply.length} characters left</p>
                  </div>
                  <div className="btn-row">
                    <button type="submit" className="btn btn-primary btn-small" disabled={saveReply.isPending || !reply.trim()}>
                      Save reply
                    </button>
                    <button type="button" className="btn btn-small" onClick={() => setReply(null)}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </section>

            {ask && (
              <ReasonForm
                action={ask === 'reject' ? 'Reject review' : 'Hide review'}
                pending={moderate.isPending}
                error={moderate.error}
                onCancel={() => setAsk(null)}
                onSubmit={(reason) => moderate.mutate({ what: ask, reason })}
              />
            )}

            <details>
              <summary>History</summary>
              <ol className="review-history">
                {r.events.map((e, i) => (
                  <li key={i}>
                    {dateTime(e.at)}: {e.from ? `${e.from.toLowerCase()} → ` : ''}
                    {e.to.toLowerCase()} by {e.actor.replace(/^customer:.*/, 'the customer').replace(/^staff:/, '')}
                    {e.reason ? <span className="muted"> ({e.reason})</span> : null}
                  </li>
                ))}
              </ol>
            </details>
          </div>
        )
      )}
    </Dialog>
  )
}

function ReviewPhoto({ reviewId, photoId, n }: { reviewId: string; photoId: string; n: number }) {
  return (
    <AuthedPhoto
      photoKey={`${reviewId}/${photoId}`}
      load={() => api.reviewPhotoUrl(reviewId, photoId)}
      alt={`Customer's photo ${n}`}
      what={`photo ${n}`}
      openInTab
    />
  )
}

const avg = (n: number | null) => (n == null ? '—' : n.toFixed(1))

function Insights() {
  const [days, setDays] = useState(90)
  const { me } = useSession()
  const q = useQuery({ queryKey: ['review-insights', days], queryFn: () => api.reviewInsights(days) })
  return (
    <section className="card mt-6" aria-labelledby="insights-title">
      <div className="topbar">
        <h2 id="insights-title">
          What reviews say
        </h2>
        <span className="spacer" />
        <div className="field m-0">
          <label htmlFor="ins-days" className="sr-only">
            Period
          </label>
          <select id="ins-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last year</option>
          </select>
        </div>
      </div>
      <p className="muted small">Every review except rejected and deleted ones, published or not. “Ripe as promised” is the customer’s 1 to 5 answer.</p>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <h3>By variety</h3>
          {q.data.byVariety.length === 0 ? (
            <EmptyState>No reviews in this period.</EmptyState>
          ) : (
            <div {...scrollRegion('Reviews by variety')}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Variety</th>
                    <th scope="col">Reviews</th>
                    <th scope="col">Average stars</th>
                    <th scope="col">Ripe as promised</th>
                    <th scope="col">1 or 2 stars</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.byVariety.map((v) => (
                    <tr key={v.variety}>
                      <td>{v.variety}</td>
                      <td>{v.reviews}</td>
                      <td>{avg(v.averageRating)}</td>
                      <td>
                        {avg(v.ripenessAccuracy)} <span className="muted small">({v.ripenessAnswers} answers)</span>
                      </td>
                      <td>{v.low}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3>Ripeness accuracy by batch</h3>
          {q.data.byBatch.length === 0 ? (
            <EmptyState>No batch has reviews yet.</EmptyState>
          ) : (
            <div {...scrollRegion('Ripeness accuracy by batch')}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Batch</th>
                    <th scope="col">Farm</th>
                    <th scope="col">Reviews</th>
                    <th scope="col">Ripe as promised</th>
                    <th scope="col">Not as promised (1–2)</th>
                    <th scope="col">Average stars</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.byBatch.map((b) => (
                    <tr key={b.batchId} className={b.ripenessAccuracy != null && b.ripenessAccuracy < 3 ? 'row-flagged' : undefined}>
                      <td>
                        {canSee(me?.role, 'batches') ? (
                          <Link to={`/batches/${b.batchId}`}>
                            {b.variety}, picked {date(b.pluckedOn)}
                          </Link>
                        ) : (
                          `${b.variety}, picked ${date(b.pluckedOn)}`
                        )}
                      </td>
                      <td>{b.farm ?? '—'}</td>
                      <td>{b.reviews}</td>
                      <td>
                        {avg(b.ripenessAccuracy)} <span className="muted small">({b.ripenessAnswers})</span>
                      </td>
                      <td>{b.notAsPromised}</td>
                      <td>{avg(b.averageRating)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3>1 and 2 star reviews by week</h3>
          {q.data.lowRatingTrend.length === 0 ? (
            <EmptyState>No reviews in this period.</EmptyState>
          ) : (
            <div {...scrollRegion('Low ratings by week')}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Week of</th>
                    <th scope="col">Reviews</th>
                    <th scope="col">1 or 2 stars</th>
                    <th scope="col">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.lowRatingTrend.map((w) => {
                    const share = w.reviews ? Math.round((w.low / w.reviews) * 100) : 0
                    return (
                      <tr key={w.week}>
                        <td>{date(w.week)}</td>
                        <td>{w.reviews}</td>
                        <td>{w.low}</td>
                        <td>
                          <span className="meter" aria-hidden="true">
                            <span style={{ width: `${share}%` }} />
                          </span>{' '}
                          {share}%
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}
