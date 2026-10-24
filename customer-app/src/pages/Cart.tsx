import { Link, useNavigate } from 'react-router-dom'
import { STAGE_LABEL, rupees } from '../format'
import { Stepper } from '../forms'
import { MangoArt } from '../mango'
import { useStore } from '../store'
import { UnpaidOrderBanner } from '../unpaid'

export default function Cart() {
  const { cart, setQty, profile } = useStore()
  const navigate = useNavigate()
  const total = cart.reduce((s, l) => s + l.price * l.qty, 0)

  if (!cart.length) {
    return (
      <>
        <UnpaidOrderBanner />
        <section className="card empty">
          <h1>Your cart is empty</h1>
          <p className="muted">Pick a day and the ripeness you want, and add a box or two.</p>
          <Link to="/" className="btn btn-primary">
            Shop mangoes
          </Link>
        </section>
      </>
    )
  }

  return (
    <>
      <UnpaidOrderBanner />
      <section className="card">
        <h1>Your cart</h1>
        <p className="muted small">You choose the delivery day and time at checkout.</p>
        <ul className="lines">
          {cart.map((l) => {
            const label = `${l.name}, ${STAGE_LABEL[l.stage]}`
            return (
              <li key={`${l.sku}-${l.stage}`} className="line line-art">
                <MangoArt stage={l.stage} size={36} />
                <div className="line-info">
                  <strong>{l.name}</strong>
                  <span className="muted small">
                    {STAGE_LABEL[l.stage]} · {rupees(l.price)} each
                  </span>
                </div>
                <Stepper
                  label={`${label} quantity`}
                  value={l.qty}
                  min={0}
                  max={20}
                  onChange={(n) => setQty(l, n)}
                  lessLabel={`One less ${label}`}
                  moreLabel={`One more ${label}`}
                />
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
    </>
  )
}
