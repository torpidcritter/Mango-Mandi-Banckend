import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { errorMessage } from './api'

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="spinner" role="status">
      <span className="spinner-dot" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  )
}

/** Grey placeholder cards shaped like what is loading, so nothing jumps when it arrives. */
export function Skeleton({ label, cards = 3, tall = false }: { label: string; cards?: number; tall?: boolean }) {
  return (
    <div className="skeletons" role="status" aria-busy="true">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className={tall ? 'card skeleton skeleton-tall' : 'card skeleton'} aria-hidden="true">
          <span className="sk sk-round" />
          <span className="sk-lines">
            <span className="sk sk-line" />
            <span className="sk sk-line sk-short" />
            <span className="sk sk-line sk-shorter" />
          </span>
        </div>
      ))}
    </div>
  )
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null
  return (
    <div className="note note-error" role="alert">
      <span>{typeof error === 'string' ? error : errorMessage(error)}</span>
      {onRetry && (
        <button type="button" className="link-btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

// Tab stops only: a roving radio group's unpicked options (tabindex -1) are reached with the arrow keys.
const FOCUSABLE = ['a[href]', 'button:not([disabled])', 'input:not([disabled])', 'textarea:not([disabled])', 'select:not([disabled])', '[tabindex]']
  .map((s) => `${s}:not([tabindex="-1"])`)
  .join(', ')

/**
 * A modal dialog, drawn over the page in a portal. Focus moves in (to `data-autofocus` if a
 * child has it), Tab stays inside, the page behind is inert and does not scroll, Escape and
 * the backdrop close it, and focus returns to what opened it.
 */
export function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  // Callers pass a fresh arrow each render; keeping it in a ref stops focus jumping on re-render.
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const el = box.current
    ;(el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE))?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return close.current()
      if (e.key !== 'Tab' || !el) return
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (!items.length) return e.preventDefault()
      const first = items[0]
      const last = items[items.length - 1]
      const at = document.activeElement
      if (e.shiftKey && (at === first || !el.contains(at))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (at === last || !el.contains(at))) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      root?.removeAttribute('inert')
      document.body.style.overflow = overflow
      // The opener may be gone (an order just cancelled): then the page moves focus itself.
      if (before?.isConnected) before.focus()
    }
  }, [])
  return createPortal(
    <div className="backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={box}>
        <h2 id="dialog-title">{title}</h2>
        {children}
        <div className="dialog-actions">{footer}</div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * "Are you sure?" on the Dialog: the safe choice is focused first, the confirm button says what
 * it does (and what it is doing while `busy`), and a failure shows under the message.
 */
export function ConfirmDialog({
  title,
  children,
  keepLabel,
  confirmLabel,
  busyLabel,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  title: string
  children: ReactNode
  keepLabel: string
  confirmLabel: string
  busyLabel: string
  busy: boolean
  error?: unknown
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" data-autofocus onClick={onClose}>
            {keepLabel}
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={onConfirm}>
            {busy ? busyLabel : confirmLabel}
          </button>
        </>
      }
    >
      {children}
      <ErrorNote error={error} />
    </Dialog>
  )
}

/** A page's h1 with what sits beside it (a status pill), wrapping under it on a narrow phone. */
export function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="title-row">
      <h1>{title}</h1>
      {children}
    </div>
  )
}

/** "Your cart · MandiMangoes": the browser title for a page. */
export function pageTitle(title: string) {
  return `${title} · MandiMangoes`
}

/**
 * Sets the browser title once a page knows its name (a box, an order number). App sets a title
 * for each route first, so a page only needs this where its title depends on what it loaded.
 */
export function DocTitle({ title }: { title: string }) {
  useEffect(() => {
    document.title = pageTitle(title)
  }, [title])
  return null
}
