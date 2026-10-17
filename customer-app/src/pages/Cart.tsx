import { Link, useNavigate } from 'react-router-dom'
import { STAGE_LABEL, rupees } from '../format'
import { useStore } from '../store'

export default function Cart() {
  const { cart, setQty, profile } = useStore()
  const navigate = useNavigate()
  const total = cart.reduce((s, l) => s + l.price * l.qty, 0)

  if (!cart.length) {
    return (
      <section className="card empty">
        <h1>Your cart is empty</h1>
        <p className="muted">Pick a day and the ripeness you want, and add a box or two.</p>
        <Link to="/" className="btn btn-primary">
          Shop mangoes
        </Link>
      </section>
    )
  }

  return (
    <section className="card">
      <h1>Your cart</h1>
      <ul className="lines">
        {cart.map((l) => {
          const label = `${l.name}, ${STAGE_LABEL[l.stage]}`
          return (
            <li key={`${l.sku}-${l.stage}`} className="line">
              <div>
                <strong>{l.name}</strong>
                <span className="muted small">
                  {STAGE_LABEL[l.stage]} · {rupees(l.price)} each
                </span>
              </div>
              <div className="stepper" role="group" aria-label={`${label} quantity`}>
                <button type="button" onClick={() => setQty(l, l.qty - 1)} aria-label={`One less ${label}`}>
                  −
                </button>
                <span aria-live="polite">{l.qty}</span>
                <button type="button" onClick={() => setQty(l, Math.min(20, l.qty + 1))} disabled={l.qty >= 20} aria-label={`One more ${label}`}>
                  +
                </button>
              </div>
              <strong className="line-price">{rupees(l.price * l.qty)}</strong>
            </li>
          )
        })}
      </ul>
      <div className="total-row">
        <span>Total</span>
        <strong>{rupees(total)}</strong>
      </div>
      <p className="muted small">Delivery is free. Stock is checked again for your delivery day at checkout.</p>
      <button type="button" className="btn btn-primary btn-block" onClick={() => navigate(profile ? '/checkout' : '/sign-in?next=/checkout')}>
        {profile ? 'Continue to delivery' : 'Sign in to check out'}
      </button>
      <Link to="/" className="btn btn-block btn-quiet">
        Keep shopping
      </Link>
    </section>
  )
}
