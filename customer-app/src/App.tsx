import { useEffect } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { SIGNOUT_EVENT, api } from './api'
import { useStore } from './store'
import Shop from './pages/Shop'
import Cart from './pages/Cart'
import Checkout from './pages/Checkout'
import SignIn from './pages/SignIn'
import Orders from './pages/Orders'
import OrderPage from './pages/Order'
import ClaimPage from './pages/Claim'
import Account from './pages/Account'
import Privacy from './pages/Privacy'
import Box from './pages/Box'
import BookAhead, { PreorderPage } from './pages/Preorder'

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

  useEffect(() => {
    const onOut = () => queryClient.removeQueries({ predicate: (q) => ['orders', 'order', 'claims', 'preorders', 'preorder'].includes(String(q.queryKey[0])) })
    window.addEventListener(SIGNOUT_EVENT, onOut)
    return () => window.removeEventListener(SIGNOUT_EVENT, onOut)
  }, [queryClient])
  // Newer browsers return a promise from scrollTo, so the effect must not return it.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [location.pathname])

  return (
    <>
      <header className={profile ? 'top signed-in' : 'top'}>
        <div className="top-inner">
          <Link to="/" className="brand" aria-label="MandiMangoes, home">
            <svg viewBox="0 0 64 64" width="28" height="28" aria-hidden="true">
              <path d="M34 14c14 2 22 14 20 28-2 12-14 18-26 16S8 46 10 34c2-12 12-21 24-20z" fill="currentColor" />
              <path d="M33 14c1-5 5-8 10-8-1 5-5 8-10 8z" fill="var(--leaf)" />
            </svg>
            <span>MandiMangoes</span>
          </Link>
          <nav aria-label="Main" className="top-nav">
            {profile && (
              <>
                <NavLink to="/orders" className="top-link">
                  Orders
                </NavLink>
                <NavLink to="/account" className="top-link">
                  Account
                </NavLink>
              </>
            )}
            <NavLink to="/cart" className="top-link cart-link" aria-label={`Cart, ${boxes} ${boxes === 1 ? 'box' : 'boxes'}`}>
              Cart{boxes > 0 && <span className="count" aria-hidden="true">{boxes}</span>}
            </NavLink>
            {profile ? (
              <button type="button" className="top-link link-btn" onClick={() => void api.signOut()}>
                Sign out
              </button>
            ) : (
              <NavLink to="/sign-in" className="top-link">
                Sign in
              </NavLink>
            )}
          </nav>
        </div>
      </header>
      <main className="page">
        <Routes>
          <Route path="/" element={<Shop />} />
          <Route path="/cart" element={<Cart />} />
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/b/:token" element={<Box />} />
          <Route path="/account" element={<RequireSignIn><Account /></RequireSignIn>} />
          <Route path="/checkout" element={<RequireSignIn><Checkout /></RequireSignIn>} />
          <Route path="/orders" element={<RequireSignIn><Orders /></RequireSignIn>} />
          <Route path="/orders/:id" element={<RequireSignIn><OrderPage /></RequireSignIn>} />
          <Route path="/orders/:id/claim" element={<RequireSignIn><ClaimPage /></RequireSignIn>} />
          <Route path="/preorder" element={<RequireSignIn><BookAhead /></RequireSignIn>} />
          <Route path="/preorders/:id" element={<RequireSignIn><PreorderPage /></RequireSignIn>} />
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
      <footer className="foot">
        <p>Mangoes picked for the day you want to eat them, delivered to your door.</p>
        <p>
          <Link to="/privacy">Privacy notice</Link>
        </p>
      </footer>
    </>
  )
}
