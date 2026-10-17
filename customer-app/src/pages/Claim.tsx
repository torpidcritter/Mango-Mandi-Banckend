import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, errorMessage, type IssueType } from '../api'
import { shrinkPhoto } from '../photo'
import { ErrorNote, Spinner } from '../ui'

const MAX_PHOTOS = 3

interface Pic {
  id: string
  preview: string
}

const ISSUES: { value: IssueType; label: string }[] = [
  { value: 'DAMAGED', label: 'Damaged or spoilt mangoes' },
  { value: 'WRONG_ITEM', label: 'Wrong box or ripeness' },
  { value: 'NOT_DELIVERED', label: "It didn't arrive" },
]

export default function ClaimPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const order = useQuery({ queryKey: ['order', id], queryFn: () => api.order(id) })
  const [issue, setIssue] = useState<IssueType | null>(null)
  const [skus, setSkus] = useState<string[]>([])
  const [description, setDescription] = useState('')
  const [photos, setPhotos] = useState<Pic[]>([])
  const [uploading, setUploading] = useState(false)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const previews = useRef(photos)
  previews.current = photos
  useEffect(() => () => previews.current.forEach((p) => URL.revokeObjectURL(p.preview)), [])
  const send = useMutation({
    mutationFn: () =>
      api.raiseClaim({ orderId: id, issueType: issue!, description: description.trim(), itemSkus: skus, photoIds: photos.map((p) => p.id) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['claims'] })
      navigate(`/orders/${id}`, { replace: true })
    },
  })

  if (order.isPending) return <Spinner />
  if (order.isError) return <ErrorNote error={order.error} onRetry={() => order.refetch()} />

  function submit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!issue) return setFormError('Choose what went wrong.')
    if (description.trim().length < 5) return setFormError('Tell us a little about what happened.')
    if (uploading) return setFormError('Wait for the photo to finish uploading.')
    send.mutate()
  }

  async function addPhotos(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])].slice(0, MAX_PHOTOS - photos.length)
    e.target.value = ''
    if (!files.length) return
    setPhotoError(null)
    setUploading(true)
    try {
      for (const file of files) {
        const small = await shrinkPhoto(file)
        const { id: photoId } = await api.uploadClaimPhoto(small)
        setPhotos((p) => [...p, { id: photoId, preview: URL.createObjectURL(small) }])
      }
    } catch (err) {
      setPhotoError(errorMessage(err))
    } finally {
      setUploading(false)
    }
  }
  function removePhoto(photoId: string) {
    setPhotos((p) => {
      const gone = p.find((x) => x.id === photoId)
      if (gone) URL.revokeObjectURL(gone.preview)
      return p.filter((x) => x.id !== photoId)
    })
  }

  const skuOptions = [...new Map(order.data.items.map((i) => [i.sku, i.name])).entries()]
  return (
    <section className="card">
      <h1>Report a problem</h1>
      <p className="muted">
        Order {order.data.number}. Tell us within a day of delivery and we'll replace what went wrong with a fresh box.
      </p>
      <form onSubmit={submit} noValidate>
        <fieldset className="field">
          <legend>What went wrong?</legend>
          <div className="options">
            {ISSUES.map((i) => (
              <label key={i.value} className="option">
                <input type="radio" name="issue" value={i.value} checked={issue === i.value} onChange={() => setIssue(i.value)} />
                <span>{i.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {skuOptions.length > 1 && (
          <fieldset className="field">
            <legend>Which boxes? (optional)</legend>
            <div className="options">
              {skuOptions.map(([sku, name]) => (
                <label key={sku} className="option">
                  <input
                    type="checkbox"
                    checked={skus.includes(sku)}
                    onChange={(e) => setSkus((s) => (e.target.checked ? [...s, sku] : s.filter((x) => x !== sku)))}
                  />
                  <span>{name}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div className="field">
          <label htmlFor="desc">What happened?</label>
          <textarea id="desc" rows={4} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="field">
          <span className="label" id="photos-label">
            Photos (optional, up to {MAX_PHOTOS})
          </span>
          {photos.length > 0 && (
            <ul className="claim-photos" aria-labelledby="photos-label">
              {photos.map((p, i) => (
                <li key={p.id}>
                  <img src={p.preview} alt={`Photo ${i + 1}`} />
                  <button type="button" className="link-btn" onClick={() => removePhoto(p.id)}>
                    Remove<span className="sr-only"> photo {i + 1}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {photos.length < MAX_PHOTOS && (
            <label className="btn btn-quiet photo-pick">
              {uploading ? 'Uploading…' : photos.length ? 'Add another photo' : 'Add a photo'}
              <input
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                disabled={uploading}
                onChange={addPhotos}
                aria-describedby={photoError ? 'photo-error' : 'photos-label'}
              />
            </label>
          )}
          {photoError && (
            <p id="photo-error" className="field-error" role="alert">
              {photoError}
            </p>
          )}
        </div>
        {formError && (
          <p className="field-error" role="alert">
            {formError}
          </p>
        )}
        <ErrorNote error={send.error} />
        <button type="submit" className="btn btn-primary btn-block" disabled={send.isPending || uploading}>
          {send.isPending ? 'Sending…' : 'Send report'}
        </button>
        <Link to={`/orders/${id}`} className="btn btn-block btn-quiet">
          Back to the order
        </Link>
      </form>
    </section>
  )
}
