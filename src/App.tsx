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
const Farms = lazy(() => import('./pages/Farms'))
const Settings = lazy(() => import('./pages/Settings'))
const BulkDeals = lazy(() => import('./pages/BulkDeals'))
const BulkDealEditor = lazy(() => import('./pages/BulkDeals').then((m) => ({ default: m.BulkDealEditor })))
const Reviews = lazy(() => import('./pages/Reviews'))
const Customers = lazy(() => import('./pages/Customers'))
const HelpDesk = lazy(() => import('./pages/HelpDesk'))
const WhatsApp = lazy(() => import('./pages/WhatsApp'))
const Subscriptions = lazy(() => import('./pages/Subscriptions'))
const PnOverview = lazy(() => import('./pages/partner/Overview'))
const PnEnquiries = lazy(() => import('./pages/partner/Enquiries'))
const PnEnquiryDetail = lazy(() => import('./pages/partner/EnquiryDetail'))
const PnProposals = lazy(() => import('./pages/partner/Proposals'))
const PnCategories = lazy(() => import('./pages/partner/Categories'))
const FarmBookings = lazy(() => import('./pages/farm/Bookings'))
const FarmBookingDetail = lazy(() => import('./pages/farm/BookingDetail'))
const FarmCheckIn = lazy(() => import('./pages/farm/CheckIn'))
const FarmCalendar = lazy(() => import('./pages/farm/Calendar'))
const FarmHarvest = lazy(() => import('./pages/farm/Harvest'))
const FarmRooms = lazy(() => import('./pages/farm/Rooms'))
const FarmSettings = lazy(() => import('./pages/farm/Settings'))
const FarmReports = lazy(() => import('./pages/farm/Reports'))
const CustomerProfilePage = lazy(() => import('./pages/Customers').then((m) => ({ default: m.CustomerProfilePage })))
const WhOverview = lazy(() => import('./warehouse/pages/Overview'))
const WhReceive = lazy(() => import('./warehouse/pages/Receive'))
const WhLots = lazy(() => import('./warehouse/pages/Lots'))
const WhLotDetail = lazy(() => import('./warehouse/pages/LotDetail'))
const WhScan = lazy(() => import('./warehouse/pages/Scan'))
const WhBoxes = lazy(() => import('./warehouse/pages/Boxes'))
const WhBoxDetail = lazy(() => import('./warehouse/pages/BoxDetail'))
const WhLocations = lazy(() => import('./warehouse/pages/Locations'))
const WhExceptions = lazy(() => import('./warehouse/pages/Exceptions'))
const WhReports = lazy(() => import('./warehouse/pages/Reports'))
const WhPicking = lazy(() => import('./warehouse/pages/Picking'))
const WhPickList = lazy(() => import('./warehouse/pages/PickList'))
const WhProducts = lazy(() => import('./warehouse/pages/Products'))
const WhBoxTrace = lazy(() => import('./warehouse/pages/BoxTrace'))
const WhLotTrace = lazy(() => import('./warehouse/pages/LotTrace'))
const WhRecall = lazy(() => import('./warehouse/pages/RecallDetail'))
const WhStocktake = lazy(() => import('./warehouse/pages/Stocktake'))
const WhStocktakeDetail = lazy(() => import('./warehouse/pages/StocktakeDetail'))
const WhRepack = lazy(() => import('./warehouse/pages/Repack'))
const WhRepackDetail = lazy(() => import('./warehouse/pages/RepackDetail'))
const TwoStepPage = lazy(() => import('./pages/TwoStep'))
const TwoStepGate = lazy(() => import('./pages/TwoStep').then((m) => ({ default: m.TwoStepGate })))
import { canSee, homeFor, opsAllowed, type Screen } from './permissions'
import { useSession } from './session'
import { whLinkAllowed } from './warehouse/access'
import type { WhPermission } from './warehouse/types'

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

/** A warehouse screen: only while the warehouse is on, and only for a role holding its permission. */
function WhOnly({ perm, children }: { perm: WhPermission | 'scan'; children: ReactNode }) {
  const { me } = useSession()
  return whLinkAllowed(me, perm) ? <>{children}</> : <NotFound notAllowed />
}

/** A staff-operations screen (docs/ops.md): only while the API has its switch on. */
function SwitchedOn({ feature, children }: { feature: 'purchaseRecords' | 'panelSwitches'; children: ReactNode }) {
  const { me } = useSession()
  return opsAllowed(me, feature) ? <>{children}</> : <NotFound notAllowed />
}

/** Partner Network (docs/partner-network.md): hidden only when /auth/me says its switch is off. */
function PartnerOn({ children }: { children: ReactNode }) {
  const { me } = useSession()
  return me?.features?.partnerNetwork === false ? <NotFound /> : <>{children}</>
}

/** Farm Experience (docs/farm-experience.md): only while /auth/me says its switch is on. */
function FarmOn({ children }: { children: ReactNode }) {
  const { me } = useSession()
  return me?.features?.farmExperience ? <>{children}</> : <NotFound />
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
              <Route path="/customers" element={<Only screen="customers"><Customers /></Only>} />
              <Route path="/customers/:id" element={<Only screen="customers"><CustomerProfilePage /></Only>} />
              <Route path="/whatsapp" element={<Only screen="whatsapp"><WhatsApp /></Only>} />
              <Route path="/whatsapp/:id" element={<Only screen="whatsapp"><WhatsApp /></Only>} />
              <Route path="/help-desk" element={<Only screen="helpDesk"><HelpDesk /></Only>} />
              <Route path="/help-desk/:id" element={<Only screen="helpDesk"><HelpDesk /></Only>} />
              <Route path="/partner-network" element={<Only screen="partnerNetwork"><PartnerOn><PnOverview /></PartnerOn></Only>} />
              <Route path="/partner-network/enquiries" element={<Only screen="partnerNetwork"><PartnerOn><PnEnquiries /></PartnerOn></Only>} />
              <Route path="/partner-network/enquiries/:id" element={<Only screen="partnerNetwork"><PartnerOn><PnEnquiryDetail /></PartnerOn></Only>} />
              <Route path="/partner-network/proposals" element={<Only screen="partnerNetwork"><PartnerOn><PnProposals /></PartnerOn></Only>} />
              <Route path="/partner-network/proposals/:id" element={<Only screen="partnerNetwork"><PartnerOn><PnProposals /></PartnerOn></Only>} />
              <Route path="/partner-network/categories" element={<Only screen="partnerNetwork"><PartnerOn><PnCategories /></PartnerOn></Only>} />
              <Route path="/farm" element={<Navigate to="/farm/bookings" replace />} />
              <Route path="/farm/bookings" element={<Only screen="farmExperience"><FarmOn><FarmBookings /></FarmOn></Only>} />
              <Route path="/farm/bookings/:id" element={<Only screen="farmExperience"><FarmOn><FarmBookingDetail /></FarmOn></Only>} />
              <Route path="/farm/check-in" element={<Only screen="farmExperience"><FarmOn><FarmCheckIn /></FarmOn></Only>} />
              <Route path="/farm/calendar" element={<Only screen="farmExperience"><FarmOn><FarmCalendar /></FarmOn></Only>} />
              <Route path="/farm/harvest" element={<Only screen="farmExperience"><FarmOn><FarmHarvest /></FarmOn></Only>} />
              <Route path="/farm/rooms" element={<Only screen="farmExperience"><FarmOn><FarmRooms /></FarmOn></Only>} />
              <Route path="/farm/settings" element={<Only screen="farmExperience"><FarmOn><FarmSettings /></FarmOn></Only>} />
              <Route path="/farm/reports" element={<Only screen="farmReports"><FarmOn><FarmReports /></FarmOn></Only>} />
              <Route path="/subscriptions" element={<Only screen="subscriptions"><Subscriptions /></Only>} />
              <Route path="/pincodes" element={<Only screen="pincodes"><Pincodes /></Only>} />
              <Route path="/planning" element={<Only screen="planning"><Planning /></Only>} />
              <Route path="/preorders" element={<Only screen="preorders"><Preorders /></Only>} />
              <Route path="/staff" element={<Only screen="staff"><Staff /></Only>} />
              <Route path="/products" element={<Only screen="products"><Products /></Only>} />
              <Route path="/bulk-deals" element={<Only screen="bulkDeals"><BulkDeals /></Only>} />
              <Route path="/bulk-deals/:id" element={<Only screen="bulkDeals"><BulkDealEditor /></Only>} />
              <Route path="/promos" element={<Only screen="promos"><Promos /></Only>} />
              <Route path="/farms" element={<Only screen="farms"><SwitchedOn feature="purchaseRecords"><Farms /></SwitchedOn></Only>} />
              <Route path="/settings" element={<Only screen="settings"><SwitchedOn feature="panelSwitches"><Settings /></SwitchedOn></Only>} />
              <Route path="/warehouse" element={<WhOnly perm="warehouse.view"><WhOverview /></WhOnly>} />
              <Route path="/warehouse/receive" element={<WhOnly perm="warehouse.receive"><WhReceive /></WhOnly>} />
              <Route path="/warehouse/lots" element={<WhOnly perm="warehouse.view"><WhLots /></WhOnly>} />
              <Route path="/warehouse/lots/:id" element={<WhOnly perm="warehouse.view"><WhLotDetail /></WhOnly>} />
              <Route path="/warehouse/scan" element={<WhOnly perm="scan"><WhScan /></WhOnly>} />
              <Route path="/warehouse/boxes" element={<WhOnly perm="warehouse.view"><WhBoxes /></WhOnly>} />
              <Route path="/warehouse/boxes/:id" element={<WhOnly perm="warehouse.view"><WhBoxDetail /></WhOnly>} />
              <Route path="/warehouse/locations" element={<WhOnly perm="warehouse.view"><WhLocations /></WhOnly>} />
              <Route path="/warehouse/exceptions" element={<WhOnly perm="warehouse.view"><WhExceptions /></WhOnly>} />
              <Route path="/warehouse/reports" element={<WhOnly perm="warehouse.view"><WhReports /></WhOnly>} />
              <Route path="/warehouse/picking" element={<WhOnly perm="warehouse.pick"><WhPicking /></WhOnly>} />
              <Route path="/warehouse/picking/:orderId" element={<WhOnly perm="warehouse.pick"><WhPickList /></WhOnly>} />
              <Route path="/warehouse/products" element={<WhOnly perm="locations.manage"><WhProducts /></WhOnly>} />
              <Route path="/warehouse/boxes/:id/trace" element={<WhOnly perm="warehouse.view"><WhBoxTrace /></WhOnly>} />
              <Route path="/warehouse/lots/:id/trace" element={<WhOnly perm="warehouse.view"><WhLotTrace /></WhOnly>} />
              <Route path="/warehouse/recalls/:id" element={<WhOnly perm="warehouse.view"><WhRecall /></WhOnly>} />
              <Route path="/warehouse/stocktake" element={<WhOnly perm="warehouse.stocktake"><WhStocktake /></WhOnly>} />
              <Route path="/warehouse/stocktake/:id" element={<WhOnly perm="warehouse.stocktake"><WhStocktakeDetail /></WhOnly>} />
              <Route path="/warehouse/repack" element={<WhOnly perm="warehouse.repack"><WhRepack /></WhOnly>} />
              <Route path="/warehouse/repack/:id" element={<WhOnly perm="warehouse.repack"><WhRepackDetail /></WhOnly>} />
              <Route path="/two-step" element={<TwoStepPage />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </Suspense>
      )}
    </SessionContext.Provider>
  )
}
