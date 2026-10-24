import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ApiError, api, errorMessage, signedInPhone, type Confirmed, type Quote } from '../api'
import { STAGE_LABEL, day, rupees, slotText } from '../format'
import { openRazorpay } from '../payment'
import { useStore, type CartLine } from '../store'
import { AddressPicker, DayChips, Field, SlotPicker } from '../forms'
import { DocTitle, ErrorNote, Spinner } from '../ui'
import { AddPhoneCard } from '../auth-ui'
import { UnpaidOrderBanner } from '../unpaid'

function loadAddress() {
  try {
    return JSON.parse(localStorage.getItem('mm.address') ?? '{}') as { name?: string; address?: string }
  } catch {
    return {}
  }
}

/**
 * Makes the account's cart match this device's cart, which the quote reads.
 * A box we no longer sell is refused with the same PRODUCT_UNAVAILABLE the
 * quote uses, naming it, rather than the API's "Unknown SKU".
 */
export async function syncCart(cart: CartLine[]) {
  const server = await api.serverCart()
  const want = new Set(cart.map((l) => `${l.sku}|${l.stage}`))
  for (const l of server.lines) if (!want.has(`${l.sku}|${l.stage}`)) await api.setCartLine(l.sku, l.stage, 0)
  for (const l of cart) {
    try {
      await api.setCartLine(l.sku, l.stage, l.qty)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_SKU') {
        throw new ApiError(409, 'PRODUCT_UNAVAILABLE', `${l.name} is no longer sold`, { sku: l.sku, stage: l.stage })
      }
      throw err
    }
  }
}

/** Where a form problem shows: under its field. */
type At = 'slot' | 'gift-name' | 'gift-phone' | 'address' | 'promo'
/** The fields in page order, so the first one with a problem gets focus. */
const FIELD_ORDER: At[] = ['slot', 'gift-name', 'gift-phone', 'address', 'promo']

/** Moves focus to a field: a text box by its id, the delivery times to the first one that can be picked. */
function focusField(at: At) {
  const el =
    at === 'slot'
      ? document.querySelector<HTMLInputElement>('input[name="slot"]:checked, input[name="slot"]:not(:disabled)')
      : at === 'address' && document.getElementById('address')?.closest('[hidden]')
        ? document.querySelector<HTMLInputElement>('input[name="saved-address"]:checked')
        : document.getElementById(at)
  el?.focus()
}

/** A refusal from the API that belongs to one field. */
function problemAt(err: unknown): At | null {
  if (!(err instanceof ApiError)) return null
  if (err.code === 'SLOT_FULL') return 'slot'
  if (err.code.startsWith('PROMO_')) return 'promo'
  return null
}

/** A short pause, for retrying a confirm whose first try is still starting the payment. */
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

export default function Checkout() {
  const { profile } = useStore()
  // Accounts made with Google add a checked mobile number before the first order.
  if (profile && !profile.phone) return <AddPhoneCard />
  return <CheckoutForm />
}

function CheckoutForm() {
  const { pincode, date, cart, clearCart, setQty, setWhere } = useStore()
  const navigate = useNavigate()
  const location = useLocation()
  const [params] = useSearchParams()
  const saved = useRef(loadAddress())
  const [name, setName] = useState(saved.current.name ?? '')
  const [address, setAddress] = useState(saved.current.address ?? '')
  const [slotId, setSlotId] = useState<string | null>(null)
  const [promoCode, setPromoCode] = useState('')
  const [isGift, setIsGift] = useState(false)
  const [gift, setGift] = useState({ recipientName: '', recipientPhone: '', message: '' })
  const [problems, setProblems] = useState<Partial<Record<At, string>>>({})
  const [quote, setQuote] = useState<Quote | null>(null)
  const idemKey = useRef<string | null>(null)
  // After the gateway failed to start a payment, the quote is spent: the next Pay quotes again with a new key.
  const quoteSpent = useRef(false)

  // Addresses this account has ordered to before, for this pincode.
  const book = useQuery({ queryKey: ['addresses'], queryFn: api.addresses, staleTime: 60_000 })
  const savedHere = (book.data ?? []).filter((a) => a.pincode === pincode)
  const [picked, setPicked] = useState<string | null>(null)
  const typedOwn = useRef(false)
  // Start from the address used last time (or the most recent saved one), until the customer types their own.
  const squash = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!typedOwn.current && picked === null && savedHere.length) {
    const match = address.trim() ? savedHere.find((a) => squash(a.address) === squash(address)) : savedHere[0]
    if (match) {
      setPicked(match.id)
      setAddress(match.address)
      if (match.name && !name) setName(match.name)
    }
  }
  const choose = (id: string | null) => {
    typedOwn.current = true
    setPicked(id)
    const a = savedHere.find((x) => x.id === id)
    setAddress(a ? a.address : '')
    if (a?.name) setName(a.name)
  }

  // The delivery day is chosen here, at checkout.
  const days = useQuery({ queryKey: ['delivery-days', pincode], queryFn: () => api.checkPincode(pincode!), enabled: Boolean(pincode) })
  const slots = useQuery({
    queryKey: ['slots', pincode, date],
    queryFn: () => api.slots(pincode!, date ?? ''),
    enabled: Boolean(pincode),
  })
  // A saved day that has passed or closed: fall back to the earliest open one, as the shop page does.
  const staleDate = Boolean(date) && slots.error instanceof ApiError && slots.error.code === 'INVALID_DATE'
  useEffect(() => {
    if (staleDate) setWhere(pincode, null)
  }, [staleDate, pincode, setWhere])

  const fetchQuote = async () => {
    await syncCart(cart)
    return api.quote({ pincode: pincode!, deliveryDate: slots.data?.deliveryDate ?? date!, slotId, promoCode: promoCode.trim() || null })
  }
  const dropUnsold = (err: unknown) => {
    // Take a box we no longer sell out of the cart, so the next review goes through.
    if (err instanceof ApiError && err.code === 'PRODUCT_UNAVAILABLE' && typeof err.detail.sku === 'string') {
      for (const l of cart) if (l.sku === err.detail.sku) setQty(l, 0)
    }
  }
  const review = useMutation({
    mutationFn: fetchQuote,
    onSuccess: (q) => {
      idemKey.current = crypto.randomUUID()
      quoteSpent.current = false
      setQuote(q)
      // The review is its own step in the history, so the browser's Back returns to this form.
      navigate({ search: '?step=review' }, { state: { fromForm: true } })
    },
    onError: (err) => {
      dropUnsold(err)
      const at = problemAt(err)
      // A time that just filled up shows as Full.
      if (at === 'slot') void slots.refetch()
      if (at) {
        setProblems({ [at]: quoteProblem(err, cart) })
        // Wait for the error to render, so the field reads it out with focus.
        requestAnimationFrame(() => focusField(at))
      }
    },
  })
  // The review shows only at ?step=review; without a quote (a reload) the form shows instead.
  const reviewing = Boolean(quote) && params.get('step') === 'review'
  const backToForm = () => {
    if ((location.state as { fromForm?: boolean } | null)?.fromForm) navigate(-1)
    else navigate({ search: '' }, { replace: true })
  }
  // Each step starts at the top, with focus on its heading.
  const heading = useRef<HTMLHeadingElement>(null)
  const firstStep = useRef(true)
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false
      return
    }
    window.scrollTo(0, 0)
    heading.current?.focus()
    // Back on the form, the details may change: the next Review order quotes again.
    if (!reviewing) setQuote(null)
  }, [reviewing])
  // ?step=review with nothing to review (a reload, or Forward after changing details): stay on the form.
  const orphanStep = params.get('step') === 'review' && !quote
  useEffect(() => {
    if (orphanStep) navigate({ search: '' }, { replace: true })
  }, [orphanStep, navigate])
  const pay = useMutation({
    mutationFn: async () => {
      let q = quote!
      if (quoteSpent.current) {
        // A fresh attempt: new quote, new key. If the price moved, show it before taking money.
        q = await fetchQuote()
        idemKey.current = crypto.randomUUID()
        quoteSpent.current = false
        setQuote(q)
        if (q.total !== quote!.total) throw new Error(`The total is now ${rupees(q.total)}. Check it and tap Pay again.`)
      }
      const input = {
        quoteId: q.quoteId,
        address: address.trim(),
        name: name.trim() || undefined,
        gift: isGift ? { recipientName: gift.recipientName.trim(), recipientPhone: gift.recipientPhone.trim(), message: gift.message.trim() || null } : null,
      }
      let c: Confirmed
      for (let attempt = 1; ; attempt++) {
        try {
          c = await api.confirm(input, idemKey.current!)
          break
        } catch (err) {
          if (err instanceof ApiError && err.code === 'PAYMENT_STARTING' && attempt < 5) {
            await pause(2000)
            continue
          }
          // The next Pay quotes again: after a gateway error, or (PAY-B10) a box taken off sale since the review.
          if (err instanceof ApiError && (err.code === 'PAYMENT_GATEWAY_ERROR' || err.code === 'PRODUCT_UNAVAILABLE')) quoteSpent.current = true
          throw err
        }
      }
      clearCart()
      // From here the order exists: whatever happens to the payment sheet, go to the order page, which can reopen it.
      let sheetError: string | null = null
      if (c.razorpayKeyId && c.razorpayOrderId) {
        try {
          await openRazorpay({ orderId: c.orderId, key: c.razorpayKeyId, rzp: c.razorpayOrderId, total: c.total, number: c.number, holdExpiresAt: c.holdExpiresAt }, signedInPhone())
        } catch (err) {
          sheetError = errorMessage(err)
        }
      }
      return { c, sheetError }
    },
    onSuccess: ({ c, sheetError }) => navigate(`/orders/${c.orderId}`, { replace: true, state: { placed: true, ...(sheetError && { payError: sheetError }) } }),
    onError: dropUnsold,
  })

  // PAY-B10: a box taken off sale between the review and Pay is named here, even when it was the only one.
  const unsold = pay.error instanceof ApiError && pay.error.code === 'PRODUCT_UNAVAILABLE' ? pay.error : null
  if (!pincode) return <Navigate to="/" replace />
  if (!cart.length && !pay.isPending && !pay.isSuccess && !unsold) return <Navigate to="/cart" replace />

  function submit(e: FormEvent) {
    e.preventDefault()
    const found: Partial<Record<At, string>> = {}
    if (slots.data?.slots.length && !slotId) found.slot = 'Choose a delivery time.'
    if (isGift && !gift.recipientName.trim()) found['gift-name'] = "Enter the name of the person you're sending it to."
    if (isGift && !/^(\+?91|0)?[6-9]\d{9}$/.test(gift.recipientPhone.replace(/[\s-]/g, ''))) {
      found['gift-phone'] = 'Enter their 10-digit mobile number, so the rider can reach them.'
    }
    if (address.trim().length < 10) found.address = 'Enter the full delivery address, with house number and landmark.'
    setProblems(found)
    const first = FIELD_ORDER.find((at) => found[at])
    if (first) {
      requestAnimationFrame(() => focusField(first))
      return
    }
    try {
      localStorage.setItem('mm.address', JSON.stringify({ name: name.trim(), address: address.trim() }))
    } catch {
      // ignore
    }
    review.mutate()
  }

  if (quote && reviewing) {
    // The cart shows the price seen when the box was added; the quote is today's.
    const wasPrice = (l: Quote['lines'][number]) => {
      const seen = cart.find((c) => c.sku === l.sku && c.stage === l.stage)?.price
      return seen != null && seen !== l.unitPrice ? seen : null
    }
    const changed = quote.lines.filter((l) => wasPrice(l) != null)
    return (
      <section className="card checkout-review">
        <DocTitle title="Review and pay" />
        <h1 ref={heading} tabIndex={-1}>
          Review and pay
        </h1>
        {/* UX-8: say so before Pay, not only when Pay is refused. */}
        <UnpaidOrderBanner />
        <dl className="facts">
          <div>
            <dt>Arrives</dt>
            <dd>
              {day(quote.deliveryDate)}
              {quote.slot && `, ${slotText(quote.slot)}`}
            </dd>
          </div>
          <div>
            <dt>To</dt>
            <dd>
              {(isGift ? gift.recipientName : name) && (
                <>
                  {isGift ? `${gift.recipientName.trim()} (a gift)` : name}
                  <br />
                </>
              )}
              {address}, {quote.pincode}
            </dd>
          </div>
          {isGift && gift.message.trim() && (
            <div>
              <dt>Note</dt>
              <dd>{gift.message.trim()}</dd>
            </div>
          )}
        </dl>
        {changed.length > 0 && (
          <p className="note small" role="status">
            {changed.length === 1 ? 'A price has' : 'Some prices have'} changed since you added {changed.length === 1 ? 'it' : 'them'} to your cart. The total below is what you pay.
          </p>
        )}
        <ul className="lines">
          {quote.lines.map((l) => (
            <li key={`${l.sku}-${l.stage}`} className="line">
              <div>
                <strong>
                  {l.qty} × {l.name}
                </strong>
                <span className="muted small">
                  {STAGE_LABEL[l.stage]} · eat by {day(l.eatBy)}
                </span>
                {wasPrice(l) != null && (
                  <span className="small price-changed">
                    Now {rupees(l.unitPrice)} each (was {rupees(wasPrice(l)!)})
                  </span>
                )}
              </div>
              <strong className="line-price">{rupees(l.linePrice)}</strong>
            </li>
          ))}
        </ul>
        {quote.promo && (
          <>
            <div className="sum-row">
              <span>Boxes</span>
              <span>{rupees(quote.subtotal)}</span>
            </div>
            <div className="sum-row discount">
              <span>
                Promo {quote.promo.code}
                {quote.promo.description && <span className="muted small"> · {quote.promo.description}</span>}
              </span>
              <span>−{rupees(quote.discount)}</span>
            </div>
          </>
        )}
        {/* UX-3: the whole cost before Pay. Delivery is always free. */}
        <div className="sum-row">
          <span>Delivery</span>
          <span>Free</span>
        </div>
        <div className="total-row">
          <span>Total</span>
          <strong>{rupees(quote.total)}</strong>
        </div>
        <p className="muted small">
          Your boxes are held for {quote.holdMinutes ? `${quote.holdMinutes} minutes` : 'a few minutes'} while you pay. You can cancel for a full
          refund any time before your order is packed.
        </p>
        <ErrorNote
          error={
            unsold
              ? `${unsold.message}, so we took it out of your cart. Nothing was charged.${cart.length ? ' Tap Pay to see the new total.' : ''}`
              : pay.error
                ? quoteProblem(pay.error)
                : null
          }
        />
        {pay.error instanceof ApiError && pay.error.code === 'UNPAID_ORDER_EXISTS' && typeof pay.error.detail.orderId === 'string' && (
          <Link to={`/orders/${pay.error.detail.orderId}`} className="btn btn-block">
            Open your unpaid order
          </Link>
        )}
        {unsold && !cart.length ? (
          <Link to="/" className="btn btn-primary btn-block">
            Choose other mangoes
          </Link>
        ) : (
          <button type="button" className="btn btn-primary btn-block" disabled={pay.isPending} onClick={() => pay.mutate()} aria-describedby="pay-trust">
            {pay.isPending ? 'Opening payment…' : `Pay ${rupees(quote.total)}`}
          </button>
        )}
        {/* UX-3: who takes the money and how, at the moment of paying. */}
        <p className="small center pay-trust" id="pay-trust">
          Secure payment by Razorpay. UPI, cards, netbanking. No cash on delivery.{' '}
          <span className="muted">
            See our <Link to="/terms">terms of sale</Link> and <Link to="/help">help</Link>.
          </span>
        </p>
        <button type="button" className="btn btn-block btn-quiet" disabled={pay.isPending} onClick={backToForm}>
          Change details
        </button>
      </section>
    )
  }

  // A saved address hides the address box: a problem with it then shows above the button.
  const addressShown = isGift || picked === null
  const errorAt = (at: At) => (at !== 'address' || addressShown ? problems[at] ?? null : null)
  // A field's problem from the API is shown at the field, not again above the button.
  const reviewError = review.error && !(problemAt(review.error) && problems[problemAt(review.error)!]) ? quoteProblem(review.error, cart) : null
  return (
    <div className="checkout-layout">
      <section className="card">
        <DocTitle title="Delivery details" />
        <h1 ref={heading} tabIndex={-1}>
          Delivery details
        </h1>
        <UnpaidOrderBanner />
        <form onSubmit={submit} noValidate>
          {slots.isPending ? (
            <Spinner label="Loading delivery times" />
          ) : slots.isError ? (
            <ErrorNote error={slots.error} onRetry={() => slots.refetch()} />
          ) : (
            <>
              <fieldset className="field">
                <legend>When should it arrive?</legend>
                <DayChips
                  label="When should it arrive?"
                  days={days.data?.deliveryDates ?? [slots.data.deliveryDate]}
                  value={slots.data.deliveryDate}
                  format={day}
                  onChange={(d) => {
                    if (d === slots.data.deliveryDate) return
                    setSlotId(null)
                    setWhere(pincode, d)
                  }}
                />
                {days.data?.cutoffTime && <p className="muted small">Orders for the next day close at {days.data.cutoffTime.replace(' IST', '')} (India time).</p>}
              </fieldset>
              <SlotPicker
                name="slot"
                slots={slots.data.slots}
                value={slotId}
                onChange={(id) => {
                  setSlotId(id)
                  if (problems.slot) setProblems({ ...problems, slot: undefined })
                }}
                error={errorAt('slot')}
              />
            </>
          )}
          <label className="option gift-toggle">
            <input
              type="checkbox"
              checked={isGift}
              onChange={(e) => {
                setIsGift(e.target.checked)
                // A gift goes to their address, not one of ours.
                if (e.target.checked && picked !== null) {
                  typedOwn.current = true
                  setPicked(null)
                  setAddress('')
                }
              }}
            />
            <span>This is a gift for someone else</span>
          </label>
          {isGift && (
            <fieldset className="field gift-fields">
              <legend>Who is it for?</legend>
              <Field id="gift-name" label="Their name" error={errorAt('gift-name')}>
                <input maxLength={80} value={gift.recipientName} onChange={(e) => setGift({ ...gift, recipientName: e.target.value })} />
              </Field>
              <Field
                id="gift-phone"
                label="Their mobile number"
                hint="The rider calls them. Your order updates and the delivery code still come to you, so pass the code on."
                error={errorAt('gift-phone')}
              >
                {(control) => (
                  <div className="prefixed">
                    <span aria-hidden="true">+91</span>
                    <input
                      {...control}
                      type="tel"
                      inputMode="numeric"
                      maxLength={14}
                      value={gift.recipientPhone}
                      onChange={(e) => setGift({ ...gift, recipientPhone: e.target.value })}
                    />
                  </div>
                )}
              </Field>
              <Field id="gift-note" label="A note in the box (optional)">
                <textarea rows={2} maxLength={200} value={gift.message} onChange={(e) => setGift({ ...gift, message: e.target.value })} />
              </Field>
            </fieldset>
          )}
          <Field id="name" label="Your name">
            <input autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {!isGift && <AddressPicker addresses={savedHere} value={picked} onChange={choose} />}
          <Field
            id="address"
            label="Delivery address"
            hint={`${isGift ? 'Their address: house' : 'House'} or flat number, street, area and a landmark. Pincode ${pincode}.`}
            error={errorAt('address')}
            hidden={!addressShown}
          >
            <textarea
              autoComplete="street-address"
              rows={3}
              maxLength={500}
              value={address}
              onChange={(e) => {
                typedOwn.current = true
                setAddress(e.target.value)
              }}
            />
          </Field>
          <Field id="promo" label="Promo code (optional)" error={errorAt('promo')}>
            <input
              autoComplete="off"
              autoCapitalize="characters"
              maxLength={20}
              value={promoCode}
              onChange={(e) => {
                setPromoCode(e.target.value.toUpperCase())
                if (problems.promo) setProblems({ ...problems, promo: undefined })
              }}
            />
          </Field>
          {problems.address && !addressShown && (
            <p className="field-error" role="alert">
              {problems.address}
            </p>
          )}
          <ErrorNote error={reviewError} />
          <button type="submit" className="btn btn-primary btn-block" disabled={review.isPending || slots.isPending}>
            {review.isPending ? 'Checking stock…' : 'Review order'}
          </button>
        </form>
      </section>
      <CartSummary cart={cart} />
    </div>
  )
}

/**
 * The boxes in the cart beside the form, sticky on a desktop (hidden on a phone, where the form is
 * the whole screen and the review step lists them). Prices are the cart's; the review step shows today's.
 */
function CartSummary({ cart }: { cart: CartLine[] }) {
  const boxes = cart.reduce((n, l) => n + l.qty, 0)
  return (
    <aside className="card order-summary" aria-labelledby="summary-title">
      <h2 id="summary-title">Your order</h2>
      <ul className="lines">
        {cart.map((l) => (
          <li key={`${l.sku}-${l.stage}`} className="line">
            <div>
              <strong>
                {l.qty} × {l.name}
              </strong>
              <span className="muted small">{STAGE_LABEL[l.stage]}</span>
            </div>
            <span className="line-price">{rupees(l.price * l.qty)}</span>
          </li>
        ))}
      </ul>
      <div className="sum-row">
        <span>Delivery</span>
        <span>Free</span>
      </div>
      <div className="total-row">
        <span>
          {boxes} {boxes === 1 ? 'box' : 'boxes'}
        </span>
        <strong>{rupees(cart.reduce((s, l) => s + l.price * l.qty, 0))}</strong>
      </div>
      <p className="muted small">Stock and price are checked for your day when you review the order.</p>
      <Link to="/cart" className="link-btn">
        Change the boxes
      </Link>
    </aside>
  )
}

/** Turns the API's checkout refusals into something a customer can act on. */
function quoteProblem(err: unknown, cart: CartLine[] = []) {
  if (!(err instanceof ApiError)) return errorMessage(err)
  if (err.code === 'STOCK_INSUFFICIENT') {
    const name = cart.find((l) => l.sku === err.detail.sku)?.name ?? 'One of your mangoes'
    return `${name} has run short for this day. Lower the number of boxes or pick another day.`
  }
  if (err.code === 'SLOT_FULL') return 'That delivery time just filled up. Choose another one.'
  if (err.code.startsWith('PROMO_')) return `${err.message}. Change or clear the promo code to go on.`
  if (err.code === 'PAYMENT_GATEWAY_ERROR') return "We couldn't start the payment, and nothing was charged. Tap Pay to try again."
  if (err.code === 'PAYMENT_STARTING') return 'Your payment is still being set up. Tap Pay again in a moment.'
  if (err.code === 'PRODUCT_UNAVAILABLE') return `${err.message}, so we took it out of your cart. Review the order again.`
  if (err.code === 'QUOTE_EXPIRED') return 'This took a little long and the price hold ended. Tap Change details and review again.'
  return err.message
}
