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
import { useShellWorker } from './pwa'
import { trackStep, useFunnel } from './growth'
import { useT } from './i18n'
import { useFeatures } from './features'
import { t as tr, type Key } from './i18n-core.ts'

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
const BulkDeals = lazy(() => import('./pages/BulkDeals'))
const HelpRequests = lazy(() => import('./pages/HelpRequests'))
const HelpRequestPage = lazy(() => import('./pages/HelpRequests').then((m) => ({ default: m.HelpRequestPage })))
const NewSubscription = lazy(() => import('./pages/Subscriptions').then((m) => ({ default: m.NewSubscription })))
const SubscriptionPage = lazy(() => import('./pages/Subscriptions').then((m) => ({ default: m.SubscriptionPage })))
const BulkDeal = lazy(() => import('./pages/BulkDeals').then((m) => ({ default: m.BulkDealPage })))
const InvitePage = lazy(() => import('./pages/Referral').then((m) => ({ default: m.InvitePage })))
const GiftMany = lazy(() => import('./pages/GiftMany'))
const GiftOrderPage = lazy(() => import('./pages/GiftOrder'))
const Partner = lazy(() => import('./pages/Partner'))
const PartnerApply = lazy(() => import('./pages/PartnerApply'))
const Farm = lazy(() => import('./pages/Farm'))
const FarmBook = lazy(() => import('./pages/Farm').then((m) => ({ default: m.FarmBook })))
const FarmBookings = lazy(() => import('./pages/FarmBooking'))
const FarmBookingPage = lazy(() => import('./pages/FarmBooking').then((m) => ({ default: m.FarmBookingPage })))

/** A page whose code is still loading. */
function Page({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  const t = useT()
  return <Suspense fallback={fallback ?? <Spinner label={t('common.loading')} />}>{children}</Suspense>
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
  // Funnel (docs/growth.md): a box was looked at. Sent once a day per browser at most.
  useEffect(() => {
    trackStep('product_view')
  }, [sku])
  return (
    <Page fallback={<BuySkeleton />}>
      <ProductPage />
    </Page>
  )
}

/** Each route's browser title; pages with a name or number (a box, an order) refine it once it loads. */
function routeTitle(path: string) {
  return tr(routeTitleKey(path))
}
function routeTitleKey(path: string): Key {
  if (path === '/') return 'title.home'
  if (path === '/cart') return 'title.cart'
  if (path === '/sign-in') return 'signIn.title'
  if (path === '/privacy') return 'title.privacy'
  if (path === '/quality') return 'title.quality'
  if (path === '/help') return 'nav.help'
  if (path === '/help/requests') return 'title.helpRequests'
  if (/^\/help\/requests\/[^/]+$/.test(path)) return 'title.helpRequest'
  if (path === '/account/subscriptions/new') return 'title.newSubscription'
  if (/^\/account\/subscriptions\/[^/]+$/.test(path)) return 'title.subscription'
  if (path === '/terms') return 'title.terms'
  if (path === '/account') return 'title.account'
  if (path === '/checkout') return 'title.checkout'
  if (path === '/orders') return 'title.orders'
  if (/^\/orders\/[^/]+\/claim$/.test(path)) return 'title.claim'
  if (/^\/orders\/[^/]+$/.test(path)) return 'title.order'
  if (/^\/mangoes\//.test(path)) return 'title.product'
  if (/^\/review\//.test(path)) return 'title.review'
  if (/^\/reviews\/[^/]+\/edit$/.test(path)) return 'title.editReview'
  if (path === '/preorder') return 'nav.bookAhead'
  if (path === '/bulk') return 'nav.bulk'
  if (/^\/bulk\//.test(path)) return 'title.bulkDeal'
  if (/^\/preorders\//.test(path)) return 'title.preorder'
  if (/^\/invite\//.test(path)) return 'title.invite'
  if (path === '/gifts/new') return 'title.giftMany'
  if (/^\/gifts\/[^/]+$/.test(path)) return 'title.giftOrder'
  if (path === '/partner') return 'title.partner'
  if (path === '/partner/apply') return 'title.partnerApply'
  if (path === '/farm-experience') return 'title.farm'
  if (path === '/farm-experience/book') return 'title.farmBook'
  if (path === '/farm-bookings') return 'title.farmBookings'
  if (/^\/farm-bookings\/[^/]+$/.test(path)) return 'title.farmBooking'
  return 'title.notFound'
}

/** Pages laid out across the wider desktop container (tiles, product and checkout columns); the rest stay one readable column. */
const WIDE = /^\/($|mangoes\/|bulk($|\/)|checkout$|partner$)/

function RequireSignIn({ children }: { children: JSX.Element }) {
  const { profile } = useStore()
  const location = useLocation()
  if (!profile) return <Navigate to={`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  return children
}

export default function App() {
  const { cart, bulk, profile } = useStore()
  const t = useT()
  const queryClient = useQueryClient()
  const location = useLocation()
  const boxes = cart.reduce((n, l) => n + l.qty, 0) + bulk.reduce((n, l) => n + l.qty, 0)
  const bump = useBump(boxes)
  const help = helpLink()
  // Partner With Us (PARTNER_NETWORK): a footer link (and a card on the Account page), never a tab or a top-menu
  // item: shopping keeps the header, and a sixth item there squeezed the search box at 1280px.
  const partner = useFeatures().partnerNetwork === true
  // Forms with a button at the bottom (checkout, claims, reviews, the partner enquiry) hide the tabs so they never cover it.
  const focused = /^\/(checkout|review\/|reviews\/|partner\/apply|farm-experience\/book)|\/claim$/.test(location.pathname)
  // The app shell worker follows the API's switches (SHOP_INSTALL, WEB_PUSH).
  useShellWorker()
  // The anonymous funnel steps follow the API's switch (FUNNEL_ANALYTICS); the visit is counted here.
  useFunnel()

  useEffect(() => {
    const onOut = () => queryClient.removeQueries({ predicate: (q) => ['orders', 'order', 'claims', 'preorders', 'preorder', 'my-reviews', 'order-reviews', 'addresses', 'settings', 'stock-alerts', 'rating', 'favourites', 'push-info', 'gift-order', 'gift-orders', 'help-requests', 'help-request', 'subscriptions', 'subscription', 'subscription-slots'].includes(String(q.queryKey[0])) })
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
  }, [location.pathname, t])
  const skip = (e: MouseEvent) => {
    // Move focus without adding #main to the address (the router owns the URL).
    e.preventDefault()
    const main = document.getElementById('main')
    main?.focus()
    main?.scrollIntoView()
  }
  const cartLink = (
    <NavLink to="/cart" className="tab" aria-label={t('nav.cartCount', { count: boxes })}>
      <span className="tab-icon-wrap">
        <TabIcon d="M3 4h2l2.4 11h11.2L21 7H6.2M9 20a1 1 0 1 0 0-.01M18 20a1 1 0 1 0 0-.01" />
        {boxes > 0 && (
          <span key={bump} className={bump ? 'count bump' : 'count'} aria-hidden="true">
            {boxes}
          </span>
        )}
      </span>
      <span aria-hidden="true">{t('nav.cart')}</span>
    </NavLink>
  )
  const mainLinks = (
    <>
      <NavLink to="/" end className="tab">
        <TabIcon d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />
        <span>{t('nav.home')}</span>
      </NavLink>
      <NavLink to="/preorder" className="tab">
        <TabIcon d="M4 6h16v14H4zM4 10h16M8 3v5M16 3v5" />
        <span>{t('nav.bookAhead')}</span>
      </NavLink>
      <NavLink to="/bulk" className="tab">
        <TabIcon d="M3 8l9-5 9 5-9 5zM3 8v8l9 5 9-5V8M12 13v8" />
        <span>{t('nav.bulk')}</span>
      </NavLink>
      <NavLink to="/orders" className="tab">
        <TabIcon d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6" />
        <span>{t('nav.orders')}</span>
      </NavLink>
      {cartLink}
    </>
  )

  return (
    <>
      <a href="#main" className="skip-link" onClick={skip}>
        {t('nav.skip')}
      </a>
      <header className={profile ? 'top signed-in' : 'top'}>
        <div className="top-inner">
          <div className="top-row">
            <Link to="/" className="brand" aria-label={t('nav.brandHome')}>
              <img src="/brand/mark-96.webp" width="40" height="40" alt="" className="brand-mark" />
            </Link>
            <WhereButton />
            <NavLink to={profile ? '/account' : '/sign-in'} className="profile-btn" aria-label={profile ? t('nav.account') : t('signIn.title')}>
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </NavLink>
          </div>
          <SearchBar />
          {/* Desktop only: the same links as the bottom tabs, in the header, with the cart count. */}
          <nav aria-label={t('nav.main')} className="top-nav">
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
          <Route path="/help/requests" element={<RequireSignIn><Page><HelpRequests /></Page></RequireSignIn>} />
          <Route path="/help/requests/:id" element={<RequireSignIn><Page><HelpRequestPage /></Page></RequireSignIn>} />
          <Route path="/account/subscriptions/new" element={<RequireSignIn><Page><NewSubscription /></Page></RequireSignIn>} />
          <Route path="/account/subscriptions/:id" element={<RequireSignIn><Page><SubscriptionPage /></Page></RequireSignIn>} />
          <Route path="/checkout" element={<RequireSignIn><Page><Checkout /></Page></RequireSignIn>} />
          <Route path="/orders" element={<RequireSignIn><Page><Orders /></Page></RequireSignIn>} />
          <Route path="/orders/:id" element={<RequireSignIn><Page><OrderPage /></Page></RequireSignIn>} />
          <Route path="/orders/:id/claim" element={<RequireSignIn><Page><ClaimPage /></Page></RequireSignIn>} />
          <Route path="/mangoes/:sku" element={<ProductRoute />} />
          <Route path="/review/:itemId" element={<RequireSignIn><Page><ReviewPage /></Page></RequireSignIn>} />
          <Route path="/reviews/:reviewId/edit" element={<RequireSignIn><Page><ReviewPage /></Page></RequireSignIn>} />
          <Route path="/preorder" element={<Page><BookAhead /></Page>} />
          <Route path="/bulk" element={<Page><BulkDeals /></Page>} />
          <Route path="/bulk/:id" element={<Page><BulkDeal /></Page>} />
          <Route path="/preorders/:id" element={<RequireSignIn><Page><PreorderPage /></Page></RequireSignIn>} />
          <Route path="/invite/:code" element={<Page><InvitePage /></Page>} />
          <Route path="/gifts/new" element={<RequireSignIn><Page><GiftMany /></Page></RequireSignIn>} />
          <Route path="/gifts/:id" element={<RequireSignIn><Page><GiftOrderPage /></Page></RequireSignIn>} />
          <Route path="/partner" element={<Page><Partner /></Page>} />
          <Route path="/partner/apply" element={<Page><PartnerApply /></Page>} />
          <Route path="/farm-experience" element={<Page><Farm /></Page>} />
          <Route path="/farm-experience/book" element={<RequireSignIn><Page><FarmBook /></Page></RequireSignIn>} />
          <Route path="/farm-bookings" element={<RequireSignIn><Page><FarmBookings /></Page></RequireSignIn>} />
          <Route path="/farm-bookings/:id" element={<RequireSignIn><Page><FarmBookingPage /></Page></RequireSignIn>} />
          <Route
            path="*"
            element={
              <section className="card">
                <h1>{t('title.notFound')}</h1>
                <Link to="/" className="btn btn-primary">
                  {t('common.backToShop')}
                </Link>
              </section>
            }
          />
        </Routes>
      </main>
      <footer className={focused ? 'foot foot-flat' : 'foot'}>
        <p>{t('footer.tagline')}</p>
        {/* UX-1: a way to reach us on every page. Production builds always have the WhatsApp number (support.ts). */}
        <p>
          <Link to="/help">{t('nav.help')}</Link>
          {help && (
            <>
              {' · '}
              <a href={help} target="_blank" rel="noopener noreferrer">
                {t('common.helpOnWhatsApp')}<span className="sr-only"> {t('common.opensWhatsApp')}</span>
              </a>
            </>
          )}
          {' · '}
          <Link to="/terms">{t('title.terms')}</Link> · <Link to="/quality">{t('title.quality')}</Link> · <Link to="/privacy">{t('title.privacy')}</Link>
          {partner && (
            <>
              {' · '}
              <Link to="/partner">{t('nav.partner')}</Link>
            </>
          )}
        </p>
      </footer>
      {!focused && (
      <nav aria-label={t('nav.main')} className="tabbar">
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
  const t = useT()
  return (
    <Link to="/?where=1" className="where-btn" aria-label={pincode ? t('where.changeLabel', { pincode }) : t('where.chooseLabel')}>
      <span className="where-label">{pincode ? t('where.deliveringTo') : t('where.deliverTo')}</span>
      <span className="where-value">
        {pincode ?? t('where.setPincode')}
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
  const t = useT()
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
        aria-label={t('search.label')}
        placeholder={t('search.placeholder')}
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
