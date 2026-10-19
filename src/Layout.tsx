import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { api } from './api'
import { ROLE_LABEL, canSee, homeFor, type Screen } from './permissions'
import { useSession } from './session'
import { ErrorBoundary } from './ui'

const LINKS: [string, string, Screen][] = [
  ['/today', 'Today', 'today'],
  ['/batches', 'Batches', 'batches'],
  ['/orders', 'Orders', 'orders'],
  ['/pack-list', 'Pack list', 'packList'],
  ['/deliveries', 'Deliveries', 'deliveries'],
  ['/claims', 'Claims', 'claims'],
  ['/pincodes', 'Pincodes', 'pincodes'],
  ['/planning', 'Planning', 'planning'],
  ['/preorders', 'Preorders', 'preorders'],
  ['/analytics', 'Analytics', 'analytics'],
  ['/products', 'Products', 'products'],
  ['/promos', 'Promos', 'promos'],
  ['/zones', 'Zones', 'zones'],
  ['/campaigns', 'Unlock', 'campaigns'],
  ['/staff', 'Staff', 'staff'],
]

export default function Layout() {
  const { me } = useSession()
  const location = useLocation()
  return (
    <div className="app">
      <nav className="app-nav" aria-label="Main">
        <NavLink to={homeFor(me?.role)} className="brand">
          Mango Ops
        </NavLink>
        <ul>
          {LINKS.filter(([, , screen]) => canSee(me?.role, screen)).map(([to, label]) => (
            <li key={to}>
              <NavLink to={to} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="who">
          {me && (
            <span>
              {me.email} · {ROLE_LABEL[me.role]}
            </span>
          )}
          <NavLink to="/two-step" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            Two-step sign-in{me?.twoStep && !me.twoStep.enabled ? ' (off)' : ''}
          </NavLink>
          <button type="button" className="btn btn-small" onClick={() => void api.logout()}>
            Sign out
          </button>
        </div>
      </nav>
      <main className="content">
        {/* Keyed by path so a crash on one screen clears when you navigate away. */}
        <ErrorBoundary key={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  )
}
