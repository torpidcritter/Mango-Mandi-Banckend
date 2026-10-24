import { Suspense, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { api } from './api'
import { ROLE_LABEL, canSee, homeFor, type Screen } from './permissions'
import { useSession } from './session'
import { ErrorBoundary, Spinner } from './ui'

type NavItem = [to: string, label: string, screen: Screen]

/**
 * The navigation in five groups. Each role still sees exactly the screens canSee allows;
 * a group with no allowed screen is left out, and a group with one is a plain link.
 */
const GROUPS: { id: string; label: string; links: NavItem[] }[] = [
  { id: 'today', label: 'Today', links: [['/today', 'Today', 'today']] },
  {
    id: 'fulfilment',
    label: 'Fulfilment',
    links: [
      ['/orders', 'Orders', 'orders'],
      ['/pack-list', 'Pack list', 'packList'],
      ['/deliveries', 'Deliveries', 'deliveries'],
    ],
  },
  {
    id: 'stock',
    label: 'Stock',
    links: [
      ['/batches', 'Batches', 'batches'],
      ['/planning', 'Planning', 'planning'],
      ['/preorders', 'Preorders', 'preorders'],
    ],
  },
  {
    id: 'customers',
    label: 'Customers',
    links: [
      ['/claims', 'Claims', 'claims'],
      ['/reviews', 'Reviews', 'reviews'],
      ['/pincodes', 'Pincodes', 'pincodes'],
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    links: [
      ['/analytics', 'Analytics', 'analytics'],
      ['/products', 'Products', 'products'],
      ['/promos', 'Promos', 'promos'],
      ['/staff', 'Staff', 'staff'],
    ],
  },
]

/** Which disclosure is open: the phone Menu, the account menu, or one desktop group. */
type Open = null | 'menu' | 'account' | `group-${string}`

const navLinkClass = ({ isActive }: { isActive: boolean }) => `nav-link${isActive ? ' active' : ''}`

/**
 * The top bar. Below 900px: the name, a Menu button and the account button in one 56px row;
 * the menu opens under it. From 900px: the groups on one row, each a small dropdown.
 * Every menu is a disclosure: aria-expanded on its button, focus moves to its first link,
 * Escape closes it and returns focus, and it closes when focus or a click leaves it.
 */
export default function Layout() {
  const { me } = useSession()
  const location = useLocation()
  const [open, setOpen] = useState<Open>(null)
  const mainRef = useRef<HTMLElement>(null)
  // Set when a disclosure opens from its button, so the effect below moves focus into it.
  const focusInto = useRef(false)

  const groups = GROUPS.map((g) => ({ ...g, links: g.links.filter(([, , screen]) => canSee(me?.role, screen)) })).filter(
    (g) => g.links.length > 0,
  )
  const twoStepOff = !!me?.twoStep && !me.twoStep.enabled

  // A new page closes whatever was open.
  useEffect(() => setOpen(null), [location.pathname])

  useEffect(() => {
    if (!open) return
    const wrapper = document.querySelector(`[data-disclosure="${open}"]`)
    if (focusInto.current) {
      focusInto.current = false
      const panel = document.getElementById(panelId(open))
      panel?.querySelector<HTMLElement>('a, button')?.focus()
    }
    function leave(e: Event) {
      if (wrapper && e.target instanceof Node && !wrapper.contains(e.target)) setOpen(null)
    }
    document.addEventListener('pointerdown', leave)
    document.addEventListener('focusin', leave)
    return () => {
      document.removeEventListener('pointerdown', leave)
      document.removeEventListener('focusin', leave)
    }
  }, [open])

  function toggle(id: Exclude<Open, null>) {
    focusInto.current = open !== id
    setOpen(open === id ? null : id)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !open) return
    e.preventDefault()
    const button = document.querySelector<HTMLElement>(`[aria-controls="${panelId(open)}"]`)
    setOpen(null)
    button?.focus()
  }

  // A link chosen from an open menu: the menu closes on the new page, so focus goes to the page.
  function onNavClick(e: MouseEvent) {
    if (open && e.target instanceof Element && e.target.closest('a')) {
      window.requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }))
    }
  }

  function skipToContent(e: MouseEvent<HTMLAnchorElement>) {
    e.preventDefault()
    mainRef.current?.focus()
    mainRef.current?.scrollIntoView()
  }

  return (
    <div className="app">
      <header className="app-header" onKeyDown={onKeyDown} onClick={onNavClick}>
        <a href="#main" className="skip-link" onClick={skipToContent}>
          Skip to content
        </a>
        <div className="app-bar" data-disclosure="menu">
          <NavLink to={homeFor(me?.role)} className="brand">
            <img src="/brand/mark-96.webp" width="32" height="32" alt="" className="brand-mark" />
            <span className="brand-text">Mango Ops</span>
          </NavLink>
          <button
            type="button"
            className="menu-btn"
            aria-expanded={open === 'menu'}
            aria-controls={panelId('menu')}
            onClick={() => toggle('menu')}
          >
            <span className="menu-icon" aria-hidden="true" />
            Menu
          </button>
          <nav id={panelId('menu')} aria-label="Main" className={`app-nav${open === 'menu' ? ' open' : ''}`}>
            <ul className="nav-groups">
              {groups.map((g) => {
                if (g.links.length === 1) {
                  const [to, label] = g.links[0]
                  return (
                    <li key={g.id} className="nav-group nav-group-single">
                      <NavLink to={to} className={navLinkClass}>
                        {label}
                      </NavLink>
                    </li>
                  )
                }
                const id: Open = `group-${g.id}`
                const here = g.links.some(([to]) => location.pathname === to || location.pathname.startsWith(`${to}/`))
                return (
                  <li
                    key={g.id}
                    className={`nav-group${open === id ? ' open' : ''}${here ? ' here' : ''}`}
                    data-disclosure={id}
                  >
                    <button
                      type="button"
                      className="nav-group-btn"
                      aria-expanded={open === id}
                      aria-controls={panelId(id)}
                      onClick={() => toggle(id)}
                    >
                      {g.label}
                      <span className="chevron" aria-hidden="true" />
                    </button>
                    <span className="nav-group-label" id={`${panelId(id)}-label`}>
                      {g.label}
                    </span>
                    <ul id={panelId(id)} className="nav-group-list" aria-labelledby={`${panelId(id)}-label`}>
                      {g.links.map(([to, label]) => (
                        <li key={to}>
                          <NavLink to={to} className={navLinkClass}>
                            {label}
                          </NavLink>
                        </li>
                      ))}
                    </ul>
                  </li>
                )
              })}
            </ul>
          </nav>
          <div className={`account${open === 'account' ? ' open' : ''}`} data-disclosure="account">
            <button
              type="button"
              className="account-btn"
              aria-expanded={open === 'account'}
              aria-controls={panelId('account')}
              onClick={() => toggle('account')}
            >
              <span className="account-email">{me?.email} · </span>
              {me ? ROLE_LABEL[me.role] : 'Account'}
              {twoStepOff && (
                <>
                  <span className="dot-warn" aria-hidden="true" />
                  <span className="sr-only"> (two-step sign-in is off)</span>
                </>
              )}
              <span className="chevron" aria-hidden="true" />
            </button>
            <div id={panelId('account')} className="account-menu">
              {me && <p className="account-who">{me.email}</p>}
              <NavLink to="/two-step" className={navLinkClass}>
                Two-step sign-in{twoStepOff ? ' (off)' : ''}
              </NavLink>
              <button type="button" className="btn btn-small" onClick={() => void api.logout()}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>
      <main className="content" id="main" tabIndex={-1} ref={mainRef}>
        {/* Keyed by path so a crash on one screen clears when you navigate away. */}
        <ErrorBoundary key={location.pathname}>
          <Suspense fallback={<Spinner />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  )
}

function panelId(open: Exclude<Open, null>) {
  return open === 'menu' ? 'main-nav' : `${open}-menu`
}
