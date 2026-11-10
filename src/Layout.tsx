import { Suspense, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { api } from './api'
import { ROLE_LABEL, canSee, homeFor, type Screen } from './permissions'
import { useSession } from './session'
import { ErrorBoundary, Spinner } from './ui'
import type { Me } from './types'
import { WH_LINKS, whLinkAllowed } from './warehouse/access'

type NavItem = [to: string, label: string, screen: Screen]

/**
 * The navigation in groups. Each role still sees exactly the screens canSee allows;
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
      ['/farms', 'Farms', 'farms'],
    ],
  },
  {
    id: 'customers',
    label: 'Customers',
    links: [
      ['/customers', 'Find a customer', 'customers'],
      ['/whatsapp', 'WhatsApp', 'whatsapp'],
      ['/help-desk', 'Help desk', 'helpDesk'],
      ['/subscriptions', 'Subscriptions', 'subscriptions'],
      ['/claims', 'Claims', 'claims'],
      ['/reviews', 'Reviews', 'reviews'],
      ['/pincodes', 'Pincodes', 'pincodes'],
    ],
  },
  {
    id: 'partners',
    label: 'Partner Network',
    links: [
      ['/partner-network', 'Partner overview', 'partnerNetwork'],
      ['/partner-network/enquiries', 'Enquiries', 'partnerNetwork'],
      ['/partner-network/proposals', 'Product proposals', 'partnerNetwork'],
      ['/partner-network/categories', 'Partner categories', 'partnerNetwork'],
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    links: [
      ['/analytics', 'Analytics', 'analytics'],
      ['/products', 'Products', 'products'],
      ['/bulk-deals', 'Bulk Deals', 'bulkDeals'],
      ['/promos', 'Promos', 'promos'],
      ['/staff', 'Staff', 'staff'],
      ['/settings', 'Settings', 'settings'],
    ],
  },
]

/**
 * Farm Experience (docs/farm-experience.md): while its switch is on, Bulk Orders holds the regular
 * Bulk Deals and the farm visit pages; while it is off, the menu is as it was (Bulk Deals under Admin).
 */
const BULK_ORDERS: NavItem[] = [
  ['/bulk-deals', 'Bulk Deals', 'bulkDeals'],
  ['/farm/bookings', 'Farm Experience Bookings', 'farmExperience'],
  ['/farm/check-in', 'Farm check-in', 'farmExperience'],
  ['/farm/calendar', 'Farm calendar', 'farmExperience'],
  ['/farm/harvest', 'Harvest stock', 'farmExperience'],
  ['/farm/rooms', 'Farmhouse rooms', 'farmExperience'],
  ['/farm/settings', 'Farm settings', 'farmExperience'],
  ['/farm/reports', 'Farm reports', 'farmReports'],
]
function withBulkOrders(me: Me | null | undefined) {
  if (!me?.features?.farmExperience) return GROUPS
  const groups = GROUPS.map((g) => (g.id === 'admin' ? { ...g, links: g.links.filter(([to]) => to !== '/bulk-deals') } : g))
  groups.splice(groups.length - 1, 0, { id: 'bulk', label: 'Bulk Orders', links: BULK_ORDERS })
  return groups
}

/** Screens that exist only while the API has their switch on (/auth/me features). */
function switchedOn(me: Me | null | undefined, screen: Screen): boolean {
  if (screen === 'customers') return !!me?.features?.customerProfiles
  if (screen === 'farms') return !!me?.features?.purchaseRecords
  if (screen === 'settings') return !!me?.features?.panelSwitches
  if (screen === 'helpDesk') return !!me?.features?.helpDesk
  if (screen === 'subscriptions') return !!me?.features?.subscriptions
  // On unless the API says it is off: the contract has no /auth/me field for it yet.
  if (screen === 'partnerNetwork') return me?.features?.partnerNetwork !== false
  if (screen === 'farmExperience' || screen === 'farmReports') return !!me?.features?.farmExperience
  return true
}

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

  const shown: { id: string; label: string; links: [to: string, label: string][] }[] = withBulkOrders(me).map((g) => ({
    ...g,
    // Customer profiles only exist while the API has them switched on (/auth/me features).
    // Farms and Settings only while their switches are on (docs/ops.md), and so do the Help desk and
    // Subscriptions (docs/care.md).
    links: g.links.filter(([, , screen]) => canSee(me?.role, screen) && switchedOn(me, screen)).map(([to, label]): [string, string] => [to, label]),
  }))
  // The box-tracked warehouse: its group only exists while /auth/me says it is on.
  if (me?.warehouse?.enabled) {
    const links = WH_LINKS.filter(([, , perm]) => whLinkAllowed(me, perm)).map(([to, label]): [string, string] => [to, label])
    shown.splice(3, 0, { id: 'warehouse', label: 'Warehouse', links })
  }
  const groups = shown.filter((g) => g.links.length > 0)
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
                          {/* An overview whose pages sit under its path is only current on its own page. */}
                          <NavLink to={to} className={navLinkClass} end={g.links.some(([other]) => other.startsWith(`${to}/`))}>
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
