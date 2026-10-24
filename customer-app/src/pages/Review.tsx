import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, signedInProfile, type FollowUp, type MyReview, type Reviewable, type SubRatings } from '../api'
import { STAGE_LABEL, day, when } from '../format'
import { Field, PhotoPicker, usePhotoUploads } from '../forms'
import { StarInput, Stars } from '../stars'
import { ConfirmDialog, ErrorNote, Spinner } from '../ui'

const MAX_PHOTOS = 3
const MAX_COMMENT = 1000
const SUBS: { key: keyof SubRatings; label: string }[] = [
  { key: 'taste', label: 'Taste' },
  { key: 'ripenessAccuracy', label: 'Ripe as promised?' },
  { key: 'packaging', label: 'Packaging' },
  { key: 'delivery', label: 'Delivery' },
]

type SentResult = { review: MyReview; followUp: FollowUp }

/** "Ravi Kumar" → "Ravi K.", as the API shows it. */
function shownAs(name: string | null | undefined, anonymous: boolean) {
  if (anonymous) return 'Anonymous'
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return 'Verified buyer'
  const first = parts[0].charAt(0).toUpperCase() + parts[0].slice(1)
  return parts.length > 1 ? `${first} ${parts.at(-1)!.charAt(0).toUpperCase()}.` : first
}

/** /review/:itemId writes a new review; /reviews/:reviewId/edit changes one. */
export default function ReviewPage() {
  const { itemId, reviewId } = useParams()
  const q = useQuery({ queryKey: ['my-reviews'], queryFn: () => api.myReviews() })
  // Kept here, not in the form: once sent, the refreshed list no longer has
  // this item as reviewable, and the thank-you screen must stay.
  const [done, setDone] = useState<SentResult | null>(null)
  if (done) return <Sent result={done} />
  if (q.isPending) return <Spinner label="Loading" />
  if (q.isError) return <ErrorNote error={q.error} onRetry={() => q.refetch()} />
  const item = itemId ? q.data.reviewable.find((i) => i.orderItemId === itemId) : undefined
  const existing = reviewId ? q.data.reviews.find((r) => r.id === reviewId) : undefined
  if (existing && !existing.canEdit) {
    return (
      <section className="card narrow">
        <h1>This review can no longer be changed</h1>
        <p className="muted">Reviews can be changed for 48 hours after you send them. You can still delete it from your account page.</p>
        <Link to="/account" className="btn btn-primary">
          Go to my account
        </Link>
      </section>
    )
  }
  if (!item && !existing) {
    return (
      <section className="card narrow">
        <h1>Nothing to review here</h1>
        <p className="muted">This item is already reviewed, or it was delivered more than 30 days ago.</p>
        <Link to="/orders" className="btn btn-primary">
          See my orders
        </Link>
      </section>
    )
  }
  return <ReviewForm item={item} existing={existing} onSent={setDone} />
}

function ReviewForm({ item, existing, onSent }: { item?: Reviewable; existing?: MyReview; onSent: (r: SentResult) => void }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [rating, setRating] = useState<number | null>(existing?.rating ?? null)
  const [subs, setSubs] = useState<SubRatings>({
    taste: existing?.taste ?? null,
    ripenessAccuracy: existing?.ripenessAccuracy ?? null,
    packaging: existing?.packaging ?? null,
    delivery: existing?.delivery ?? null,
  })
  const [comment, setComment] = useState(existing?.comment ?? '')
  const [anonymous, setAnonymous] = useState(existing?.anonymous ?? false)
  const {
    photos,
    setPhotos,
    uploading,
    error: photoError,
    add: addPhotos,
    remove: removePhoto,
  } = usePhotoUploads((photo) => api.uploadReviewPhoto(photo), MAX_PHOTOS, existing?.photos.map((p) => ({ id: p.id, preview: null })))
  const [formError, setFormError] = useState<string | null>(null)
  // One key per form: a retry after a dropped connection can't make a second review.
  const [idemKey] = useState(() => crypto.randomUUID())

  // Photos already on a review being edited are fetched with the sign-in.
  useEffect(() => {
    if (!existing) return
    let live = true
    for (const p of existing.photos) {
      api
        .myReviewPhotoUrl(p.url)
        .then((url) => live && setPhotos((all) => all.map((x) => (x.id === p.id ? { ...x, preview: url } : x))))
        .catch(() => undefined)
    }
    return () => {
      live = false
    }
  }, [existing, setPhotos])

  const productName = existing?.productName ?? item!.productName
  const stage = existing?.ripenessOrdered ?? item?.ripenessOrdered ?? null
  const orderId = existing?.orderId ?? item!.orderId

  const send = useMutation({
    mutationFn: () => {
      const body = { rating: rating!, ...subs, comment: comment.trim() || null, anonymous, photoIds: photos.map((p) => p.id) }
      return existing ? api.editReview(existing.id, body) : api.sendReview({ ...body, orderItemId: item!.orderItemId }, idemKey)
    },
    onSuccess: (r) => {
      onSent(r)
      void queryClient.invalidateQueries({ queryKey: ['my-reviews'] })
      void queryClient.invalidateQueries({ queryKey: ['order-reviews', orderId] })
      window.scrollTo(0, 0)
    },
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!rating) return setFormError('Choose from 1 to 5 stars.')
    if (uploading) return setFormError('Wait for the photo to finish uploading.')
    if (comment.length > MAX_COMMENT) return setFormError(`Keep the review to ${MAX_COMMENT} characters.`)
    send.mutate()
  }

  // "Choose stars" shows under the stars; anything else above the button.
  const starsError = formError?.startsWith('Choose') ? formError : null
  const left = MAX_COMMENT - comment.length
  return (
    <section className="card narrow" aria-labelledby="review-title">
      <h1 id="review-title">{existing ? 'Change your review' : 'Write a review'}</h1>
      <p className="muted">
        {productName}
        {stage && <> · ordered {STAGE_LABEL[stage].toLowerCase()}</>}
        {item && <> · delivered {when(item.deliveredAt)}</>}
      </p>
      <form onSubmit={submit} noValidate>
        <StarInput
          label="Your rating"
          value={rating}
          describedBy={starsError ? 'rating-error' : undefined}
          onChange={(n) => {
            setRating(n)
            // A "choose stars" message is answered once stars are chosen.
            if (formError?.startsWith('Choose')) setFormError(null)
          }}
        />
        {starsError && (
          <p id="rating-error" className="field-error" role="alert">
            {starsError}
          </p>
        )}
        <fieldset className="field sub-ratings">
          <legend>More detail (optional)</legend>
          {SUBS.map((s) => (
            <StarInput key={s.key} label={s.label} size="small" value={subs[s.key]} onChange={(n) => setSubs((v) => ({ ...v, [s.key]: n }))} />
          ))}
        </fieldset>
        <Field
          id="review-text"
          label="Tell other buyers about them (optional)"
          hint="Please leave out phone numbers, emails and links. Reviews are checked by our team before they appear."
          describedBy="review-count"
        >
          {(control) => (
            <>
              <textarea {...control} rows={4} maxLength={MAX_COMMENT} value={comment} onChange={(e) => setComment(e.target.value)} />
              <p id="review-count" className={left < 50 ? 'counter warn' : 'counter'} aria-live="polite">
                {left} characters left
              </p>
            </>
          )}
        </Field>
        <PhotoPicker
          id="review-photos"
          max={MAX_PHOTOS}
          accept="image/jpeg,image/png,image/webp"
          alt={(i) => `Your photo ${i + 1}`}
          photos={photos}
          uploading={uploading}
          error={photoError}
          onAdd={addPhotos}
          onRemove={removePhoto}
        />
        <label className="option">
          <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
          <span>Post without my name</span>
        </label>
        <p className="muted small">
          Shown as <strong>{shownAs(signedInProfile()?.name, anonymous)}</strong>, with a “Verified purchase” badge. We never show your phone, email or
          address.
        </p>
        {formError && !starsError && (
          <p className="field-error" role="alert">
            {formError}
          </p>
        )}
        <ErrorNote error={send.error} />
        <button type="submit" className="btn btn-primary btn-block" disabled={send.isPending || uploading}>
          {send.isPending ? 'Sending…' : existing ? 'Save changes' : 'Send review'}
        </button>
        <button type="button" className="btn btn-block btn-quiet" onClick={() => navigate(-1)}>
          Cancel
        </button>
      </form>
    </section>
  )
}

function Sent({ result }: { result: SentResult }) {
  const { review, followUp } = result
  return (
    <section className="card narrow" aria-labelledby="sent-title">
      <h1 id="sent-title" tabIndex={-1} ref={(el) => el?.focus()}>
        Thank you for your review
      </h1>
      <Stars value={review.rating} />
      <p className="note" role="status">
        It is under review. Our team checks every review, usually within a day, and then it appears on the product page.
      </p>
      {followUp?.type === 'CLAIM' && (
        <div className="note note-warn">
          <p>Sorry the mangoes let you down. If something was wrong with the fruit, report it and we will send a fresh box.</p>
          <p className="small">You can report it until {when(followUp.claimUntil)}.</p>
          <Link to={`/orders/${followUp.orderId}/claim`} className="btn btn-primary">
            Report a problem
          </Link>
        </div>
      )}
      {followUp?.type === 'SUPPORT' && (
        <div className="note note-warn">
          <p>Sorry the mangoes let you down. {followUp.contact}</p>
        </div>
      )}
      <Link to={`/orders/${review.orderId}`} className="btn btn-block">
        Back to the order
      </Link>
    </section>
  )
}

/** The order page's reviews block: write one per delivered item, or see where each review is. */
export function OrderReviews({ orderId }: { orderId: string }) {
  const q = useQuery({ queryKey: ['order-reviews', orderId], queryFn: () => api.myReviews(orderId) })
  if (q.isPending || q.isError) return null
  const { reviews, reviewable } = q.data
  if (!reviews.length && !reviewable.length) return null
  return (
    <section className="card" aria-labelledby="order-reviews">
      <h2 id="order-reviews">{reviewable.length ? 'How were your mangoes?' : 'Your reviews'}</h2>
      <ul className="review-items">
        {reviewable.map((i) => (
          <li key={i.orderItemId}>
            <div>
              <strong>{i.productName}</strong>
              {i.ripenessOrdered && <span className="muted small"> · {STAGE_LABEL[i.ripenessOrdered]}</span>}
              <p className="muted small">You can review this until {day(i.reviewableUntil.slice(0, 10))}.</p>
            </div>
            <Link to={`/review/${i.orderItemId}`} className="btn btn-primary">
              Write a review<span className="sr-only"> of {i.productName}</span>
            </Link>
          </li>
        ))}
        {reviews.map((r) => (
          <li key={r.id}>
            <div>
              <strong>{r.productName}</strong> <Stars value={r.rating} small />
              <p className="muted small">{REVIEW_STATE[r.status]}</p>
            </div>
            {r.canEdit && (
              <Link to={`/reviews/${r.id}/edit`} className="btn btn-quiet">
                Change<span className="sr-only"> review of {r.productName}</span>
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

export const REVIEW_STATE: Record<MyReview['status'], string> = {
  PENDING: 'Under review',
  APPROVED: 'Published',
  REJECTED: 'Not published',
  HIDDEN: 'Taken down',
}

/** Account page: every review I wrote, with edit (48 hours) and delete. */
export function MyReviews() {
  const queryClient = useQueryClient()
  const q = useQuery({ queryKey: ['my-reviews'], queryFn: () => api.myReviews() })
  const [deleting, setDeleting] = useState<MyReview | null>(null)
  const del = useMutation({
    mutationFn: (id: string) => api.deleteReview(id),
    onSuccess: () => {
      setDeleting(null)
      void queryClient.invalidateQueries({ queryKey: ['my-reviews'] })
      void queryClient.invalidateQueries({ queryKey: ['order-reviews'] })
    },
  })
  if (q.isPending || q.isError || !q.data.reviews.length) return null
  return (
    <section className="card narrow" aria-labelledby="my-reviews">
      <h2 id="my-reviews">My reviews</h2>
      <ul className="review-items">
        {q.data.reviews.map((r) => (
          <li key={r.id}>
            <div>
              <strong>{r.productName}</strong> <Stars value={r.rating} small />
              <p className="muted small">
                {REVIEW_STATE[r.status]}
                {r.moderationReason && <>: {r.moderationReason}</>}
                {r.canEdit && <> · can be changed until {when(r.editableUntil)}</>}
              </p>
              {r.comment && <p className="review-text">{r.comment}</p>}
            </div>
            <div className="row-actions">
              {r.canEdit && (
                <Link to={`/reviews/${r.id}/edit`} className="link-btn">
                  Change<span className="sr-only"> review of {r.productName}</span>
                </Link>
              )}
              <button type="button" className="link-btn danger" onClick={() => setDeleting(r)}>
                Delete<span className="sr-only"> review of {r.productName}</span>
              </button>
            </div>
          </li>
        ))}
      </ul>
      {deleting && (
        <ConfirmDialog
          title="Delete this review?"
          keepLabel="Keep it"
          confirmLabel="Delete review"
          busyLabel="Deleting…"
          busy={del.isPending}
          error={del.error}
          onConfirm={() => del.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        >
          <p>Your review of {deleting.productName} and its photos will be removed. You can't write a new one for the same item.</p>
        </ConfirmDialog>
      )}
    </section>
  )
}
