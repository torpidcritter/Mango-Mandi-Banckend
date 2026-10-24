import { Suspense, lazy, useEffect, useState, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { API_URL, SIGNOUT_EVENT, api } from './api'
import { SessionContext } from './session'
import type { Me } from './types'
import { ApiBaseBanner, OfflineBanner, Spinner } from './ui'
import Layout from './Layout'
// Sign-in and Today come with the first load; every other screen is its own
// chunk, fetched the first time someone opens it (Layout shows a spinner meanwhile).
import Login from './pages/Login'
import Today from './pages/Today'
import NotFound from './pages/NotFound'
const Batches = lazy(() => import('./pages/Batches'))
const BatchDetail = lazy(() => import('./pages/BatchDetail'))
const Orders = lazy(() => import('./pages/Orders'))
const OrderDetail = lazy(() => import('./pages/OrderDetail'))
const PackList = lazy(() => import('./pages/PackList'))
const Analytics = lazy(() => import('./pages/Analytics'))
const Deliveries = lazy(() => import('./pages/Deliveries'))
const Claims = lazy(() => import('./pages/Claims'))
const Pincodes = lazy(() => import('./pages/Pincodes'))
const Planning = lazy(() => import('./pages/Planning'))
const Preorders = lazy(() => import('./pages/Preorders'))
const Staff = lazy(() => import('./pages/Staff'))
const Products = lazy(() => import('./pages/Products'))
const Promos = lazy(() => import('./pages/Promos'))
const Reviews = lazy(() => import('./pages/Reviews'))
const TwoStepPage = lazy(() => import('./pages/TwoStep'))
const TwoStepGate = lazy(() => import('./pages/TwoStep').then((m) => ({ default: m.TwoStepGate })))
import { canSee, homeFor, type Screen } from './permissions'
import { useSession } from './session'

function RequireAuth({ me, children }: { me: Me | null; children: ReactNode }) {
  const location = useLocation()
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  if (me.twoStep?.required && !me.twoStep.enabled) return <TwoStepGate />
  return <>{children}</>
}

/** Shows a screen only to roles allowed to open it; the API refuses the rest anyway. */
function Only({ screen, children }: { screen: Screen; children: ReactNode }) {
  const { me } = useSession()
  return canSee(me?.role, screen) ? <>{children}</> : <NotFound notAllowed />
}

function Home() {
  const { me } = useSession()
  return <Navigate to={homeFor(me?.role)} replace />
}

/** Catches the sign-out event from api.ts (logout or a failed refresh) and navigates. */
function SignOutListener({ onSignOut }: { onSignOut: () => void }) {
  const navigate = useNavigate()
  useEffect(() => {
    function handle(e: Event) {
      const reason = (e as CustomEvent<{ reason?: string }>).detail?.reason
      onSignOut()
      navigate(reason === 'expired' ? '/login?reason=expired' : '/login', { replace: true })
    }
    window.addEventListener(SIGNOUT_EVENT, handle)
    return () => window.removeEventListener(SIGNOUT_EVENT, handle)
  }, [navigate, onSignOut])
  return null
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [booting, setBooting] = useState(true)
  const queryClient = useQueryClient()

  // One silent refresh on load restores a session from the httpOnly cookie.
  useEffect(() => {
    let cancelled = false
    api.bootstrap().then((restored) => {
      if (cancelled) return
      setMe(restored)
      setBooting(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const [onSignOut] = useState(() => () => {
    setMe(null)
    queryClient.clear()
  })

  return (
    <SessionContext.Provider value={{ me, setMe }}>
      <ApiBaseBanner apiUrl={API_URL} />
      <OfflineBanner />
      <SignOutListener onSignOut={onSignOut} />
      {booting ? (
        <Spinner label="Restoring session" />
      ) : (
        // Layout has its own boundary around the screen, so the menu stays while a
        // screen loads; this one covers the two-step gate, which renders outside it.
        <Suspense fallback={<Spinner />}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              element={
                <RequireAuth me={me}>
                  <Layout />
                </RequireAuth>
              }
            >
              <Route path="/" element={<Home />} />
              <Route path="/today" element={<Only screen="today"><Today /></Only>} />
              <Route path="/batches" element={<Only screen="batches"><Batches /></Only>} />
              <Route path="/batches/:id" element={<Only screen="batches"><BatchDetail /></Only>} />
              <Route path="/orders" element={<Only screen="orders"><Orders /></Only>} />
              <Route path="/orders/:id" element={<Only screen="orderDetail"><OrderDetail /></Only>} />
              <Route path="/pack-list" element={<Only screen="packList"><PackList /></Only>} />
              <Route path="/deliveries" element={<Only screen="deliveries"><Deliveries /></Only>} />
              <Route path="/analytics" element={<Only screen="analytics"><Analytics /></Only>} />
              <Route path="/claims" element={<Only screen="claims"><Claims /></Only>} />
              <Route path="/reviews" element={<Only screen="reviews"><Reviews /></Only>} />
              <Route path="/pincodes" element={<Only screen="pincodes"><Pincodes /></Only>} />
              <Route path="/planning" element={<Only screen="planning"><Planning /></Only>} />
              <Route path="/preorders" element={<Only screen="preorders"><Preorders /></Only>} />
              <Route path="/staff" element={<Only screen="staff"><Staff /></Only>} />
              <Route path="/products" element={<Only screen="products"><Products /></Only>} />
              <Route path="/promos" element={<Only screen="promos"><Promos /></Only>} />
              <Route path="/two-step" element={<TwoStepPage />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </Suspense>
      )}
    </SessionContext.Provider>
  )
}
