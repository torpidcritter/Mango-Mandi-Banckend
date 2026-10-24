// Shared UI primitives: badges, buttons, row links, photos, dialogs, toasts, spinner,
// empty/error states. Pages build from these rather than their own copies.

import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ErrorInfo as ReactErrorInfo,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Link } from 'react-router-dom'
import { errorMessage } from './api'
import {
  BATCH_STATUS_LABEL,
  CLAIM_STATUS_LABEL,
  ORDER_STATUS_LABEL,
  batchTone,
  orderTone,
  telHref,
  type Tone,
} from './format'
import { MANAGER_ONLY_HINT } from './permissions'
import type { BatchStatus, ClaimStatus, OrderStatus } from './types'

// ---------- Badges ----------

/**
 * Colour means status only: good, warn, bad, info. Categories (slot, gift, issue type,
 * ripeness) use the default neutral chip.
 */
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export function OrderBadge({ status }: { status: OrderStatus }) {
  return <Badge tone={orderTone(status)}>{ORDER_STATUS_LABEL[status] ?? status}</Badge>
}

export function BatchBadge({ status }: { status: BatchStatus }) {
  return <Badge tone={batchTone(status)}>{BATCH_STATUS_LABEL[status] ?? status}</Badge>
}

export function ClaimBadge({ status }: { status: ClaimStatus }) {
  const tone: Tone = status === 'RESOLVED' ? 'neutral' : status === 'UNDER_REVIEW' ? 'info' : 'warn'
  return <Badge tone={tone}>{CLAIM_STATUS_LABEL[status] ?? status}</Badge>
}

// ---------- Spinner / empty / error ----------

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="spinner-wrap">
      <span className="spinner" role="status" aria-label={label} />
    </div>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>
}

export function QueryError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { message, detail } = errorMessage(error)
  return (
    <div className="card error-card" role="alert">
      <p>
        <strong>{message}</strong>
      </p>
      {detail && <p className="muted small">{detail}</p>}
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  )
}

/** Inline error text inside a dialog or form. */
export function FormError({ error }: { error: unknown }) {
  if (!error) return null
  const { message, detail } = typeof error === 'string' ? { message: error, detail: undefined } : errorMessage(error)
  return (
    <p className="form-error" role="alert">
      {message}
      {detail && <span className="muted small"> ({detail})</span>}
    </p>
  )
}

// ---------- Buttons ----------

/**
 * A manager-only button, shown disabled to operators (roles that never get the action do not
 * see it at all). Put a ManagerOnlyNote near it so the reason is visible, not only in a tooltip.
 */
export function GatedButton({
  allowed,
  className = 'btn',
  onClick,
  children,
  disabled,
}: {
  allowed: boolean
  className?: string
  onClick: () => void
  children: ReactNode
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      disabled={!allowed || disabled}
      title={allowed ? undefined : MANAGER_ONLY_HINT}
      aria-describedby={undefined}
    >
      {children}
      {!allowed && <span className="sr-only"> ({MANAGER_ONLY_HINT})</span>}
    </button>
  )
}

/** The visible reason beside a disabled control, for example "Nothing left to allocate". */
export function DisabledReason({ children }: { children: ReactNode }) {
  return <p className="disabled-reason">{children}</p>
}

/** The visible reason beside one or more GatedButtons: "Cancelling a paid order: requires manager role." */
export function ManagerOnlyNote({ what }: { what: string }) {
  return (
    <DisabledReason>
      {what}: {MANAGER_ONLY_HINT.toLowerCase()}.
    </DisabledReason>
  )
}

// ---------- Tables ----------

/**
 * Props for a horizontally scrollable table wrapper. Focusable and labelled so
 * keyboard users can scroll wide tables on a phone.
 */
export function scrollRegion(label: string, opts: { cards?: boolean } = {}) {
  return { className: `table-wrap${opts.cards ? ' table-cards' : ''}`, tabIndex: 0, role: 'region', 'aria-label': label } as const
}

// ---------- Filters ----------

/**
 * A status filter: a row of chips on a wide screen, a <select> on a phone (below 640px) so
 * the list starts near the top. `value` null means All.
 */
export function StatusFilter<T extends string>({
  value,
  options,
  labels,
  onChange,
  className = '',
}: {
  value: T | null
  options: readonly T[]
  labels: Record<T, string>
  onChange: (next: T | null) => void
  className?: string
}) {
  const id = useId()
  return (
    <div className={`status-filter ${className}`}>
      <div className="segmented status-chips" role="group" aria-label="Filter by status">
        <button type="button" className="btn btn-small" aria-pressed={value === null} onClick={() => onChange(null)}>
          All
        </button>
        {options.map((s) => (
          <button key={s} type="button" className="btn btn-small" aria-pressed={value === s} onClick={() => onChange(s)}>
            {labels[s]}
          </button>
        ))}
      </div>
      <div className="field status-select">
        <label htmlFor={id}>Status</label>
        <select id={id} value={value ?? ''} onChange={(e) => onChange((e.target.value as T) || null)}>
          <option value="">All</option>
          {options.map((s) => (
            <option key={s} value={s}>
              {labels[s]}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

// ---------- Tabs ----------

/**
 * The tab pattern: role=tablist/tab/tabpanel, one Tab stop, arrow keys (and Home/End) move
 * between tabs and show them. Put tabPanelProps(id, value) on the panel under it.
 */
export function Tabs<T extends string>({
  id,
  label,
  tabs,
  value,
  onChange,
}: {
  id: string
  label: string
  tabs: readonly (readonly [T, string])[]
  value: T
  onChange: (next: T) => void
}) {
  const list = useRef<HTMLDivElement>(null)
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = tabs.findIndex(([key]) => key === value)
    const last = tabs.length - 1
    const next =
      e.key === 'ArrowRight' ? (i === last ? 0 : i + 1)
      : e.key === 'ArrowLeft' ? (i === 0 ? last : i - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null
    if (next === null) return
    e.preventDefault()
    onChange(tabs[next][0])
    list.current?.querySelector<HTMLElement>(`#${CSS.escape(`${id}-tab-${tabs[next][0]}`)}`)?.focus()
  }
  return (
    <div className="tabs" role="tablist" aria-label={label} ref={list} onKeyDown={onKeyDown}>
      {tabs.map(([key, text]) => (
        <button
          key={key}
          type="button"
          role="tab"
          id={`${id}-tab-${key}`}
          aria-selected={value === key}
          aria-controls={`${id}-panel`}
          tabIndex={value === key ? 0 : -1}
          onClick={() => onChange(key)}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

export function tabPanelProps(id: string, value: string) {
  return { role: 'tabpanel', id: `${id}-panel`, 'aria-labelledby': `${id}-tab-${value}`, tabIndex: 0 } as const
}

// ---------- Page titles ----------

/** Sets the tab title to "<title> · Mango Ops" while the page is open. */
export function usePageTitle(title: string | null | undefined) {
  useEffect(() => {
    if (!title) return
    document.title = `${title} · Mango Ops`
  }, [title])
}

// ---------- Row links ----------

/**
 * A table row that opens a page. The row stays a plain row (so a screen reader reads its
 * cells); put a RowLink in its first cell, which stretches over the row for mouse and touch.
 */
export function LinkRow({ children }: { children: ReactNode }) {
  return <tr className="row-linked">{children}</tr>
}

/** The link in a LinkRow's first cell. `more` is read after the text, for screen readers only. */
export function RowLink({ to, children, more }: { to: string; children: ReactNode; more?: string }) {
  return (
    <Link to={to} className="row-link">
      {children}
      {more && <span className="sr-only"> {more}</span>}
    </Link>
  )
}

// ---------- Back and phone links ----------

/** "← Orders" above a detail page's title: back to the list it came from. */
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="back-link">
      <span aria-hidden="true">←</span>
      {children}
    </Link>
  )
}

/**
 * A phone number as a tap-to-call link (tel:+91…), the same as on Deliveries. `who` is read
 * after the number for screen readers ("Call the customer"). Shows "—" when there is none.
 */
export function PhoneLink({ phone, who }: { phone: string | null | undefined; who?: string }) {
  if (!phone) return <>—</>
  return (
    <a className="phone-link" href={telHref(phone)}>
      {phone}
      {who && <span className="sr-only"> (call {who})</span>}
    </a>
  )
}

// ---------- Signed-in photos ----------

/**
 * A photo behind the API's sign-in (delivery proof, claim and review photos). `load` fetches
 * it as an object URL, re-run when `photoKey` changes; the URL is freed on unmount. `what`
 * names it in the loading and failure text ("photo 2"). `openInTab` wraps it in a link that
 * opens the full photo.
 */
export function AuthedPhoto({
  load,
  photoKey,
  alt,
  what = 'photo',
  className,
  openInTab,
}: {
  load: () => Promise<string>
  photoKey: string
  alt: string
  what?: string
  className?: string
  openInTab?: boolean
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    let made: string | null = null
    let live = true
    setUrl(null)
    setFailed(false)
    loadRef
      .current()
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
  }, [photoKey])
  if (failed) return <span className="small muted">{what.charAt(0).toUpperCase() + what.slice(1)} could not be loaded.</span>
  if (!url) return <span className="small muted">Loading {what}…</span>
  const img = <img className={className} src={url} alt={alt} />
  if (!openInTab) return img
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {img}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

// ---------- Dialog ----------

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Dialog({
  title,
  onClose,
  children,
  footer,
  tone,
  variant,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  tone?: 'danger'
  /** "drawer": slides in from the right, full height (detail panels). */
  variant?: 'drawer'
}) {
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const el = ref.current
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()

    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
        return
      }
      if (e.key !== 'Tab' || !el) return
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) return
      const firstItem = items[0]
      const lastItem = items[items.length - 1]
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault()
        lastItem.focus()
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault()
        firstItem.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [])

  return (
    <div
      className={variant === 'drawer' ? 'backdrop backdrop-drawer' : 'backdrop'}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        className={`dialog${tone === 'danger' ? ' dialog-danger' : ''}${variant === 'drawer' ? ' dialog-drawer' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId}>{title}</h2>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>
  )
}

/**
 * A yes/no check before a step that is hard to take back. Says what happens;
 * the safe choice (Cancel) gets the focus.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  busyLabel = 'Saving…',
  onConfirm,
  onClose,
  busy,
  error,
  tone,
}: {
  title: string
  children: ReactNode
  confirmLabel: string
  cancelLabel?: string
  busyLabel?: string
  onConfirm: () => void
  onClose: () => void
  busy?: boolean
  error?: unknown
  tone?: 'danger'
}) {
  return (
    <Dialog
      title={title}
      tone={tone}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} data-autofocus>
            {cancelLabel}
          </button>
          <button type="button" className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={onConfirm}>
            {busy ? busyLabel : confirmLabel}
          </button>
        </>
      }
    >
      {children}
      <FormError error={error} />
    </Dialog>
  )
}

/**
 * A step that needs a written reason (cancelling, overriding, writing off, rejecting). The
 * confirm button stays disabled until the reason is long enough, and the hint under the box
 * says so in text. `children` explains what happens.
 */
export function ReasonDialog({
  title,
  children,
  label = 'Reason',
  hint,
  minLength = 3,
  maxLength,
  confirmLabel,
  cancelLabel = 'Cancel',
  busyLabel = 'Saving…',
  busy,
  error,
  tone = 'danger',
  onSubmit,
  onClose,
}: {
  title: string
  children?: ReactNode
  label?: string
  /** Shown under the box. Defaults to "At least 3 characters." */
  hint?: string
  minLength?: number
  maxLength?: number
  confirmLabel: string
  cancelLabel?: string
  busyLabel?: string
  busy?: boolean
  error?: unknown
  tone?: 'danger' | 'primary'
  onSubmit: (reason: string) => void
  onClose: () => void
}) {
  const id = useId()
  const [reason, setReason] = useState('')
  const valid = reason.trim().length >= minLength
  function submit(e: FormEvent) {
    e.preventDefault()
    if (valid) onSubmit(reason.trim())
  }
  return (
    <Dialog
      title={title}
      tone={tone === 'danger' ? 'danger' : undefined}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {cancelLabel}
          </button>
          <button type="submit" form={`${id}-form`} className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`} disabled={!valid || busy}>
            {busy ? busyLabel : confirmLabel}
          </button>
        </>
      }
    >
      <form id={`${id}-form`} onSubmit={submit}>
        {children}
        <div className="field">
          <label htmlFor={`${id}-reason`}>{label}</label>
          <textarea
            id={`${id}-reason`}
            rows={3}
            maxLength={maxLength}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-describedby={`${id}-hint`}
            data-autofocus
          />
          <p id={`${id}-hint`} className="hint">
            {hint ?? `At least ${minLength} ${minLength === 1 ? 'character' : 'characters'}.`}
          </p>
        </div>
        <FormError error={error} />
      </form>
    </Dialog>
  )
}

// ---------- Toasts ----------

type ToastKind = 'success' | 'error' | 'info'
interface ToastItem {
  id: number
  kind: ToastKind
  text: string
}

const ToastContext = createContext<(kind: ToastKind, text: string) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const push = useCallback((kind: ToastKind, text: string) => {
    const toastId = nextId.current++
    setToasts((t) => [...t, { id: toastId, kind, text }])
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== toastId)), 4000)
  }, [])

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const push = useContext(ToastContext)
  return {
    success: (text: string) => push('success', text),
    error: (err: unknown) => push('error', typeof err === 'string' ? err : errorMessage(err).message),
    info: (text: string) => push('info', text),
  }
}

// ---------- Error boundary ----------

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ReactErrorInfo) {
    // Surface for developers; no customer data is in component stacks.
    console.warn('Screen crashed', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="card error-card" role="alert">
          <h2>This screen hit a problem</h2>
          <p className="muted">The rest of the app still works. Reload to try again.</p>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// ---------- Banners ----------

export function OfflineBanner() {
  const [offline, setOffline] = useState(typeof navigator !== 'undefined' && !navigator.onLine)
  useEffect(() => {
    const on = () => setOffline(false)
    const off = () => setOffline(true)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  if (!offline) return null
  return (
    <div className="banner banner-warn" role="status">
      You are offline. Actions will fail until the connection returns.
    </div>
  )
}

export function ApiBaseBanner({ apiUrl }: { apiUrl: string }) {
  if (apiUrl) return null
  return (
    <div className="banner banner-bad" role="alert">
      VITE_API_URL is not set, so the app cannot reach the API. Add it to .env and restart.
    </div>
  )
}
