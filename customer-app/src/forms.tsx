// Shared form pieces for the shop: one labelled field, day chips, delivery times, saved
// addresses, photo uploads and the − count + stepper. Each page builds its forms from these.
import { cloneElement, isValidElement, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { errorMessage, type SavedAddress, type SlotOnDate } from './api'
import { slotText } from './format'
import { shrinkPhoto } from './photo'

/** What a Field hands to its control: the id its label points at, and the hint and error to read out. */
export interface ControlProps {
  id: string
  'aria-describedby'?: string
  'aria-invalid'?: true
}

/**
 * A visible label over one control, an optional hint under it, and the error (if any) under that.
 * The control gets the id, aria-describedby (the hint, the error and any `describedBy` ids) and
 * aria-invalid while there is an error. Pass the control as the only child, or a function of
 * those props when the control sits inside something (a +91 prefix, a counter).
 */
export function Field({
  id,
  label,
  hint,
  error,
  describedBy,
  className,
  hidden,
  children,
}: {
  id: string
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  describedBy?: string
  className?: string
  hidden?: boolean
  children: ReactElement | ((control: ControlProps) => ReactNode)
}) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const ids = [describedBy, hintId, errorId].filter(Boolean).join(' ')
  const control: ControlProps = { id, ...(ids && { 'aria-describedby': ids }), ...(error && { 'aria-invalid': true as const }) }
  return (
    <div className={className ? `field ${className}` : 'field'} hidden={hidden}>
      <label htmlFor={id}>{label}</label>
      {typeof children === 'function' ? children(control) : isValidElement(children) ? cloneElement(children, control) : children}
      {hint && (
        <p id={hintId} className="muted small">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * A row of chips that acts as one choice (a delivery day, a booking week): a real radio group.
 * Tab reaches it once (the picked chip, or the first), and the arrow keys, Home and End move the
 * choice, as with native radios. Scrolls sideways inside itself on a phone; wraps on wider screens.
 */
export function DayChips({
  label,
  days,
  value,
  onChange,
  format,
}: {
  label: string
  days: string[]
  value: string | null
  onChange: (day: string) => void
  format: (day: string) => string
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const at = days.indexOf(value ?? '')
  const stop = at >= 0 ? at : 0
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = refs.current.findIndex((el) => el === document.activeElement)
    const cur = from >= 0 ? from : stop
    const last = days.length - 1
    const to =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? (cur + 1) % days.length
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? (cur - 1 + days.length) % days.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null
    if (to === null) return
    e.preventDefault()
    refs.current[to]?.focus()
    onChange(days[to])
  }
  return (
    <div className="chips" role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {days.map((d, i) => (
        <button
          key={d}
          ref={(el) => (refs.current[i] = el)}
          type="button"
          role="radio"
          aria-checked={d === value}
          tabIndex={i === stop ? 0 : -1}
          className="chip"
          onClick={() => onChange(d)}
        >
          {format(d)}
        </button>
      ))}
    </div>
  )
}

/** The delivery times for a day as radio rows; a full time is shown but can't be picked. Nothing when the day has no times. */
export function SlotPicker({
  name,
  slots,
  value,
  onChange,
  error,
}: {
  name: string
  slots: SlotOnDate[]
  value: string | null
  onChange: (slotId: string) => void
  error?: string | null
}) {
  if (!slots.length) return null
  const errorId = error ? `${name}-error` : undefined
  return (
    <fieldset className="field" aria-describedby={errorId}>
      <legend>Delivery time</legend>
      <div className="options">
        {slots.map((s) => (
          <label key={s.id} className={`option${s.available ? '' : ' option-off'}`}>
            <input type="radio" name={name} value={s.id} checked={value === s.id} disabled={!s.available} onChange={() => onChange(s.id)} />
            <span>
              {slotText(s)}
              {!s.available && <span className="muted small"> · Full</span>}
            </span>
          </label>
        ))}
      </div>
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  )
}

/** Pick one of the addresses this account ordered to before, or "A new address" (null). */
export function AddressPicker({
  addresses,
  value,
  onChange,
}: {
  addresses: SavedAddress[]
  value: string | null
  onChange: (id: string | null) => void
}) {
  if (!addresses.length) return null
  return (
    <fieldset className="field">
      <legend>Deliver to</legend>
      <div className="options">
        {addresses.map((a) => (
          <label key={a.id} className="option">
            <input type="radio" name="saved-address" checked={value === a.id} onChange={() => onChange(a.id)} />
            <span className="option-text">
              {a.name && <strong>{a.name}</strong>}
              <span>{a.address}</span>
            </span>
          </label>
        ))}
        <label className="option">
          <input type="radio" name="saved-address" checked={value === null} onChange={() => onChange(null)} />
          <span>A new address</span>
        </label>
      </div>
    </fieldset>
  )
}

export interface Pic {
  id: string
  /** A local object URL; null while a photo already on the server is still loading. */
  preview: string | null
}

/**
 * The photos a form is adding: each picked file is shrunk, uploaded with `upload` and shown from a
 * local preview. Previews are released when they are removed and when the form goes away.
 */
export function usePhotoUploads(upload: (file: Blob) => Promise<{ id: string }>, max: number, initial: Pic[] = []) {
  const [photos, setPhotos] = useState<Pic[]>(initial)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const previews = useRef(photos)
  previews.current = photos
  useEffect(() => () => previews.current.forEach((p) => p.preview && URL.revokeObjectURL(p.preview)), [])

  async function add(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])].slice(0, max - photos.length)
    e.target.value = ''
    if (!files.length) return
    setError(null)
    setUploading(true)
    try {
      for (const file of files) {
        const small = await shrinkPhoto(file)
        const { id } = await upload(small)
        setPhotos((p) => [...p, { id, preview: URL.createObjectURL(small) }])
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setUploading(false)
    }
  }
  function remove(id: string) {
    setPhotos((p) => {
      const gone = p.find((x) => x.id === id)
      if (gone?.preview) URL.revokeObjectURL(gone.preview)
      return p.filter((x) => x.id !== id)
    })
  }
  return { photos, setPhotos, uploading, error, add, remove }
}

/** "Photos (optional, up to 3)": thumbnails with Remove, and an Add a photo button that opens the file picker. */
export function PhotoPicker({
  id,
  max,
  accept,
  alt,
  photos,
  uploading,
  error,
  onAdd,
  onRemove,
}: {
  id: string
  max: number
  accept: string
  /** The thumbnail's alt text, from its 0-based place. */
  alt: (index: number) => string
  photos: Pic[]
  uploading: boolean
  error: string | null
  onAdd: (e: ChangeEvent<HTMLInputElement>) => void
  onRemove: (photoId: string) => void
}) {
  const labelId = `${id}-label`
  const errorId = `${id}-error`
  return (
    <div className="field">
      <span className="label" id={labelId}>
        Photos (optional, up to {max})
      </span>
      {photos.length > 0 && (
        <ul className="claim-photos" aria-labelledby={labelId}>
          {photos.map((p, i) => (
            <li key={p.id}>
              {p.preview ? <img src={p.preview} alt={alt(i)} /> : <span className="photo-wait">Photo {i + 1}</span>}
              <button type="button" className="link-btn" onClick={() => onRemove(p.id)}>
                Remove<span className="sr-only"> photo {i + 1}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {photos.length < max && (
        <label className="btn btn-quiet photo-pick">
          {uploading ? 'Uploading…' : photos.length ? 'Add another photo' : 'Add a photo'}
          <input
            type="file"
            accept={accept}
            multiple
            className="sr-only"
            disabled={uploading}
            onChange={onAdd}
            aria-describedby={error ? errorId : labelId}
            aria-invalid={error ? true : undefined}
          />
        </label>
      )}
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * − count +, one row. `label` names the group: shown above it when `showLabel`, otherwise read out
 * only. The buttons stop at `min` and `max`; `shown` replaces the number on screen (0 when none can be added).
 */
export function Stepper({
  label,
  showLabel = false,
  value,
  shown,
  min,
  max,
  onChange,
  lessLabel,
  moreLabel,
}: {
  label: string
  showLabel?: boolean
  value: number
  shown?: number
  min: number
  max: number
  onChange: (n: number) => void
  lessLabel: string
  moreLabel: string
}) {
  const labelId = `${label.replace(/\W+/g, '-').toLowerCase()}-label`
  const group = (
    <div className="stepper" role="group" {...(showLabel ? { 'aria-labelledby': labelId } : { 'aria-label': label })}>
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label={lessLabel}>
        −
      </button>
      <span aria-live="polite">{shown ?? value}</span>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label={moreLabel}>
        +
      </button>
    </div>
  )
  if (!showLabel) return group
  return (
    <>
      <span className="label" id={labelId}>
        {label}
      </span>
      {group}
    </>
  )
}
