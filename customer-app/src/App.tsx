import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react'
import { helpLink } from './format'
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { SIGNOUT_EVENT } from './api'
import { useStore } from './store'
import Shop from './pages/Shop'
import { BuySkeleton } from './pages/BuySkeleton'
import { catalogueQuery, productReviewsQuery } from './queries'
import { Spinner, pageTitle } from './ui'

// Home is in the first download; every other page's code loads when it is first opened.
const Cart = lazy(() => import('./pages/Cart'))
const Checkout = lazy(() => import('./pages/Checkout'))
const SignIn = lazy(() => import('./pages/SignIn'))
const Orders = lazy(() => import('./pages/Orders'))
const OrderPage = lazy(() => import('./pages/Order'))
const ClaimPage = lazy(() => import('./pages/Claim'))
const Account = lazy(() => import('./pages/Account'))
const Privacy = lazy(() => import('./pages/Privacy'))
const BookAhead = lazy(() => import('./pages/Preorder'))
const PreorderPage = lazy(() => import('./pages/Preorder').then((m) => ({ default: m.PreorderPage })))
const ReviewPage = lazy(() => import('./pages/Review'))
const ProductPage = lazy(() => import('./pages/Product'))
const Quality = lazy(() => import('./pages/Quality'))
const Help = lazy(() => import('./pages/Help'))
const Terms = lazy(() => import('./pages/Terms'))

/** A page whose code is still loading. */
function Page({ children, fallback = <Spinner label="Loading" /> }: { children: ReactNode; fallback?: ReactNode }) {
  return <Suspense fallback={fallback}>{children}</Suspense>
}

/**
 * The product page. Its stock and reviews start loading here, alongside the page's code, so the
 * requests do not wait for that download; the page then picks up the same answers.
 */
function ProductRoute() {
  const { sku = '' } = useParams()
  const { pincode, date } = useStore()
  const queryClient = useQueryClient()
  useEffect(() => {
    void queryClient.prefetchInfiniteQuery(productReviewsQuery(sku))
    if (pincode) void queryClient.prefetchQuery(catalogueQuery(pincode, date))
  }, [queryClient, sku, pincode, date])
  return (
    <Page fallback={<BuySkeleton />}>
      <ProductPage />
    </Page>
  )
}

/** Each route's browser title; pages with a name or number (a box, an order) refine it once it loads. */
function routeTitle(path: string) {
  if (path === '/') return 'Pick your mangoes'
  if (path === '/cart') return 'Your cart'
  if (path === '/sign-in') return 'Sign in'
  if (path === '/privacy') return 'Privacy notice'
  if (path === '/quality') return 'How we pick and check'
  if (path === '/help') return 'Help'
  if (path === '/terms') return 'Terms of sale'
  if (path === '/account') return 'Your account'
  if (path === '/checkout') return 'Delivery details'
  if (path === '/orders') return 'My orders'
  if (/^\/orders\/[^/]+\/claim$/.test(path)) return 'Report a problem'
  if (/^\/orders\/[^/]+$/.test(path)) return 'Your order'
  if (/^\/mangoes\//.test(path)) return 'Mangoes'
  if (/^\/review\//.test(path)) return 'Write a review'
  if (/^\/reviews\/[^/]+\/edit$/.test(path)) return 'Change your review'
  if (path === '/preorder') return 'Book ahead'
  if (/^\/preorders\//.test(path)) return 'Your booking'
  return 'Page not found'
}

/** Pages laid out across the wider desktop container (tiles, product and checkout columns); the rest stay one readable column. */
const WIDE = /^\/($|mangoes\/|checkout$)/

function RequireSignIn({ children }: { children: JSX.Element }) {
  const { profile } = useStore()
  const location = useLocation()
  if (!profile) return <Navigate to={`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  return children
}

export default function App() {
  const { cart, profile } = useStore()
  const queryClient = useQueryClient()
  const location = useLocation()
  const boxes = cart.reduce((n, l) => n + l.qty, 0)
  const bump = useBump(boxes)
  const help = helpLink()
  // Forms with a button at the bottom (checkout, claims, reviews) hide the tabs so they never cover it.
  const focused = /^\/(checkout|review\/|reviews\/)|\/claim$/.test(location.pathname)

  useEffect(() => {
    const onOut = () => queryClient.removeQueries({ predicate: (q) => ['orders', 'order', 'claims', 'preorders', 'preorder', 'my-reviews', 'order-reviews', 'addresses', 'settings', 'stock-alerts', 'rating'].includes(String(q.queryKey[0])) })
    window.addEventListener(SIGNOUT_EVENT, onOut)
    return () => window.removeEventListener(SIGNOUT_EVENT, onOut)
  }, [queryClient])
  // Newer browsers return a promise from scrollTo, so the effect must not return it.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [location.pathname])
  // A layout effect runs before every page's own effects, so a page's more specific title wins.
  useLayoutEffect(() => {
    document.title = pageTitle(routeTitle(location.pathname))
  }, [location.pathname])
  const skip = (e: MouseEvent) => {
    // Move focus without adding #main to the address (the router owns the URL).
    e.preventDefault()
    const main = document.getElementById('main')
    main?.focus()
    main?.scrollIntoView()
  }
  const cartLink = (
    <NavLink to="/cart" className="tab" aria-label={`Cart, ${boxes} ${boxes === 1 ? 'box' : 'boxes'}`}>
      <span className="tab-icon-wrap">
        <TabIcon d="M3 4h2l2.4 11h11.2L21 7H6.2M9 20a1 1 0 1 0 0-.01M18 20a1 1 0 1 0 0-.01" />
        {boxes > 0 && (
          <span key={bump} className={bump ? 'count bump' : 'count'} aria-hidden="true">
            {boxes}
          </span>
        )}
      </span>
      <span aria-hidden="true">Cart</span>
    </NavLink>
  )
  const mainLinks = (
    <>
      <NavLink to="/" end className="tab">
        <TabIcon d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />
        <span>Home</span>
      </NavLink>
      <NavLink to="/preorder" className="tab">
        <TabIcon d="M4 6h16v14H4zM4 10h16M8 3v5M16 3v5" />
        <span>Book ahead</span>
      </NavLink>
      <NavLink to="/orders" className="tab">
        <TabIcon d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6" />
        <span>Orders</span>
      </NavLink>
      {cartLink}
    </>
  )

  return (
    <>
      <a href="#main" className="skip-link" onClick={skip}>
        Skip to content
      </a>
      <header className={profile ? 'top signed-in' : 'top'}>
        <div className="top-inner">
          <div className="top-row">
            <Link to="/" className="brand" aria-label="MandiMangoes, home">
              <img src="/brand/mark-96.webp" width="40" height="40" alt="" className="brand-mark" />
            </Link>
            <WhereButton />
            <NavLink to={profile ? '/account' : '/sign-in'} className="profile-btn" aria-label={profile ? 'Account' : 'Sign in'}>
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </NavLink>
          </div>
          <SearchBar />
          {/* Desktop only: the same links as the bottom tabs, in the header, with the cart count. */}
          <nav aria-label="Main" className="top-nav">
            {mainLinks}
          </nav>
        </div>
      </header>
      <main id="main" tabIndex={-1} className={WIDE.test(location.pathname) ? 'page page-wide' : 'page'}>
        <Routes>
          <Route path="/" element={<Shop />} />
          <Route path="/cart" element={<Page><Cart /></Page>} />
          <Route path="/sign-in" element={<Page><SignIn /></Page>} />
          <Route path="/privacy" element={<Page><Privacy /></Page>} />
          <Route path="/quality" element={<Page><Quality /></Page>} />
          <Route path="/help" element={<Page><Help /></Page>} />
          <Route path="/terms" element={<Page><Terms /></Page>} />
          <Route path="/account" element={<RequireSignIn><Page><Account /></Page></RequireSignIn>} />
          <Route path="/checkout" element={<RequireSignIn><Page><Checkout /></Page></RequireSignIn>} />
          <Route path="/orders" element={<RequireSignIn><Page><Orders /></Page></RequireSignIn>} />
          <Route path="/orders/:id" element={<RequireSignIn><Page><OrderPage /></Page></RequireSignIn>} />
          <Route path="/orders/:id/claim" element={<RequireSignIn><Page><ClaimPage /></Page></RequireSignIn>} />
          <Route path="/mangoes/:sku" element={<ProductRoute />} />
          <Route path="/review/:itemId" element={<RequireSignIn><Page><ReviewPage /></Page></RequireSignIn>} />
          <Route path="/reviews/:reviewId/edit" element={<RequireSignIn><Page><ReviewPage /></Page></RequireSignIn>} />
          <Route path="/preorder" element={<Page><BookAhead /></Page>} />
          <Route path="/preorders/:id" element={<RequireSignIn><Page><PreorderPage /></Page></RequireSignIn>} />
          <Route
            path="*"
            element={
              <section className="card">
                <h1>Page not found</h1>
                <Link to="/" className="btn btn-primary">
                  Back to the shop
                </Link>
              </section>
            }
          />
        </Routes>
      </main>
      <footer className={focused ? 'foot foot-flat' : 'foot'}>
        <p>Mangoes picked for the day you want to eat them, delivered to your door.</p>
        {/* UX-1: a way to reach us on every page. Production builds always have the WhatsApp number (support.ts). */}
        <p>
          <Link to="/help">Help</Link>
          {help && (
            <>
              {' · '}
              <a href={help} target="_blank" rel="noopener noreferrer">
                Help on WhatsApp<span className="sr-only"> (opens WhatsApp)</span>
              </a>
            </>
          )}
          {' · '}
          <Link to="/terms">Terms of sale</Link> · <Link to="/quality">How we pick and check</Link> · <Link to="/privacy">Privacy notice</Link>
        </p>
      </footer>
      {!focused && (
      <nav aria-label="Main" className="tabbar">
        {mainLinks}
      </nav>
      )}
    </>
  )
}

/** Changes each time the count goes up, so the badge replays its bounce. */
function useBump(count: number) {
  const [bump, setBump] = useState(0)
  const last = useRef(count)
  useEffect(() => {
    if (count > last.current) setBump((b) => b + 1)
    last.current = count
  }, [count])
  return bump
}

function TabIcon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The delivery pincode at the top; opens the pincode form on the home page. */
function WhereButton() {
  const { pincode } = useStore()
  return (
    <Link to="/?where=1" className="where-btn" aria-label={pincode ? `Delivering to ${pincode}, change` : 'Choose where to deliver'}>
      <span className="where-label">{pincode ? 'Delivering to' : 'Deliver to'}</span>
      <span className="where-value">
        {pincode ?? 'Set your pincode'}
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </span>
    </Link>
  )
}

/** How long the search box waits after the last key before it filters the home page. */
const SEARCH_DELAY_MS = 250

/** Searches the mangoes on the home page (?q=). Typing on another page takes you home. */
function SearchBar() {
  const location = useLocation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const onHome = location.pathname === '/'
  const current = onHome ? (params.get('q') ?? '') : ''
  const [draft, setDraft] = useState(current)
  // A search waiting for typing to pause; on the home page the box shows what is typed meanwhile.
  const pending = useRef<number | null>(null)
  const cancel = () => {
    if (pending.current != null) window.clearTimeout(pending.current)
    pending.current = null
  }
  useEffect(() => cancel, [])
  // The address changed by other means (Back, a link home): the box follows it, unless typing is under way.
  useEffect(() => {
    if (onHome && pending.current == null) setDraft(current)
  }, [onHome, current])
  function go(q: string) {
    cancel()
    const next = new URLSearchParams(onHome ? params : undefined)
    if (q.trim()) next.set('q', q)
    else next.delete('q')
    next.delete('where')
    navigate({ pathname: '/', search: next.toString() ? `?${next}` : '' }, { replace: onHome })
  }
  function submit(e: FormEvent) {
    e.preventDefault()
    go(draft)
  }
  return (
    <form role="search" className="search" onSubmit={submit}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M20 20l-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        aria-label="Search mangoes"
        placeholder="Search mangoes, e.g. Alphonso"
        value={draft}
        onChange={(e) => {
          const q = e.target.value
          setDraft(q)
          if (!onHome) return
          cancel()
          pending.current = window.setTimeout(() => go(q), SEARCH_DELAY_MS)
        }}
      />
    </form>
  )
}
