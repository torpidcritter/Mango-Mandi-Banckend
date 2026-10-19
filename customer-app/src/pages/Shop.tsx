import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api, errorMessage, type CatalogueItem } from '../api'
import { STAGE_HINT, STAGE_LABEL, day, rupees } from '../format'
import { useStore } from '../store'
import { ErrorNote, Spinner } from '../ui'
import { BookAheadCard } from './Preorder'
import { MangoArt } from '../mango'
import { UnlockCard } from '../unlock'
import type { Stage } from '../api'

export default function Shop() {
  const { pincode, date, setWhere, cart } = useStore()
  const [editing, setEditing] = useState(!pincode)
  const boxes = cart.reduce((n, l) => n + l.qty, 0)
  const pickDate = useCallback((d: string | null) => setWhere(pincode, d), [setWhere, pincode])
  const [params, setParams] = useSearchParams()

  // A shared Neighborhood Unlock link: /?pin=560038&date=2026-10-25 opens the
  // shop for that pincode and day (when it is still open for orders).
  const sharedPin = params.get('pin')
  const sharedDate = params.get('date')
  useEffect(() => {
    if (!sharedPin) return
    let live = true
    const drop = () => setParams((p) => { p.delete('pin'); p.delete('date'); return p }, { replace: true })
    if (!/^\d{6}$/.test(sharedPin)) return drop()
    api
      .checkPincode(sharedPin)
      .then((r) => {
        if (!live) return
        if (r.serviceable && r.deliveryDates.length) {
          setWhere(sharedPin, sharedDate && r.deliveryDates.includes(sharedDate) ? sharedDate : r.earliestDeliveryDate)
          setEditing(false)
        }
        drop()
      })
      .catch(drop)
    return () => {
      live = false
    }
  }, [sharedPin, sharedDate, setWhere, setParams])

  return (
    <>
      {params.get('deleted') === '1' && (
        <p className="note" role="status">
          Your account is deleted. Thank you for buying from MandiMangoes.
        </p>
      )}
      {editing || !pincode ? (
        <PincodeForm
          initial={pincode ?? ''}
          onDone={(pin, first) => {
            setWhere(pin, first)
            setEditing(false)
          }}
        />
      ) : (
        <div className="where">
          <span>
            Delivering to <strong>{pincode}</strong>
          </span>
          <button type="button" className="link-btn" onClick={() => setEditing(true)}>
            Change
          </button>
        </div>
      )}
      {pincode && !editing && <Catalogue pincode={pincode} date={date} onDate={pickDate} />}
      <BookAheadCard />
      <Promises />
      {boxes > 0 && (
        <div className="sticky-cart">
          <Link to="/cart" className="btn btn-primary btn-block">
            View cart · {boxes} {boxes === 1 ? 'box' : 'boxes'} · {rupees(cart.reduce((s, l) => s + l.price * l.qty, 0))}
          </Link>
        </div>
      )}
    </>
  )
}

function PincodeForm({ initial, onDone }: { initial: string; onDone: (pincode: string, firstDate: string | null) => void }) {
  const [pin, setPin] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const check = useMutation({
    mutationFn: () => api.checkPincode(pin),
    onSuccess: (r) => {
      if (!r.serviceable) setError(`We don't deliver to ${pin} yet.`)
      else if (!r.deliveryDates.length) setError('No delivery days are open right now. Please check back soon.')
      else onDone(pin, r.earliestDeliveryDate)
    },
  })
  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!/^\d{6}$/.test(pin)) return setError('Enter your 6-digit pincode.')
    check.mutate()
  }
  return (
    <section className="hero">
      <h1>Mangoes picked for the day you want to eat them</h1>
      <p className="lead">Choose raw, semi-ripe or ripe, and the day it arrives. We pack each box from the batch that will be just right on that day.</p>
      <form className="pin-form" onSubmit={submit} noValidate>
        <label htmlFor="pincode">Your delivery pincode</label>
        <div className="row">
          <input
            id="pincode"
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            aria-describedby={error ? 'pin-error' : undefined}
          />
          <button type="submit" className="btn btn-primary" disabled={check.isPending}>
            {check.isPending ? 'Checking…' : 'Show mangoes'}
          </button>
        </div>
        {(error || check.error) && (
          <p id="pin-error" className="field-error" role="alert">
            {error ?? (check.error as Error).message}
          </p>
        )}
      </form>
      <ol className="how" aria-label="How it works">
        <li>
          <strong>Pick the ripeness and the day</strong>
          <span className="muted small">Raw to ripen at home, semi-ripe for later this week, or ripe to eat on arrival.</span>
        </li>
        <li>
          <strong>We pack from the right batch</strong>
          <span className="muted small">We track every batch from the day it was picked, so your box is at the ripeness you chose on that day.</span>
        </li>
        <li>
          <strong>It arrives at your door</strong>
          <span className="muted small">Free delivery in your chosen time slot, with updates on WhatsApp.</span>
        </li>
      </ol>
      <RipenessGuide />
    </section>
  )
}

const STAGES: Stage[] = ['RAW', 'SEMI_RIPE', 'RIPE']

function RipenessGuide() {
  return (
    <section className="guide" aria-labelledby="guide-title">
      <h2 id="guide-title" className="section-title">
        Which ripeness?
      </h2>
      <ul className="guide-list">
        {STAGES.map((st) => (
          <li key={st}>
            <MangoArt stage={st} size={48} />
            <strong>{STAGE_LABEL[st]}</strong>
            <span className="muted small">{STAGE_HINT[st]}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** What every customer can count on. */
function Promises() {
  return (
    <ul className="promises" aria-label="Our promises">
      <li>
        <strong>Free delivery</strong>
        <span>Paid online, nothing to pay at the door.</span>
      </li>
      <li>
        <strong>Changed your mind?</strong>
        <span>Cancel before packing for a full refund, or move the day.</span>
      </li>
      <li>
        <strong>Damaged or wrong?</strong>
        <span>Tell us with a photo and we send a free replacement.</span>
      </li>
    </ul>
  )
}

function Catalogue({ pincode, date, onDate }: { pincode: string; date: string | null; onDate: (d: string | null) => void }) {
  const q = useQuery({ queryKey: ['catalogue', pincode, date], queryFn: () => api.catalogue(pincode, date) })
  // A saved day that has passed or closed: fall back to the earliest open one.
  const stale = q.error instanceof ApiError && q.error.code === 'INVALID_DATE'
  useEffect(() => {
    if (stale) onDate(null)
  }, [stale, onDate])
  if (q.isPending) return <Spinner label="Loading mangoes" />
  if (q.isError) return <ErrorNote error={q.error} onRetry={() => q.refetch()} />
  if (!q.data.serviceable) return <ErrorNote error={`We don't deliver to ${pincode} yet.`} />
  const products = groupBySku(q.data.items)
  const chosen = q.data.deliveryDate!

  return (
    <>
      <section aria-labelledby="when">
        <h2 id="when" className="section-title">
          When should it arrive?
        </h2>
        <div className="chips" role="radiogroup" aria-labelledby="when">
          {q.data.deliveryDates!.map((d) => (
            <button key={d} type="button" role="radio" aria-checked={d === chosen} className="chip" onClick={() => onDate(d)}>
              {day(d)}
            </button>
          ))}
        </div>
        <p className="muted small">Orders for the next day close at {q.data.cutoffTime!.replace(' IST', '')} (India time).</p>
      </section>

      <UnlockCard pincode={pincode} date={chosen} />

      <section aria-labelledby="pick">
        <h2 id="pick" className="section-title">
          Pick your mangoes for {day(chosen)}
        </h2>
        <div className="products">
          {products.map((p) => (
            <article key={p.sku} className="card product" aria-labelledby={`p-${p.sku}`}>
              <header className="product-head">
                <MangoArt stage="RIPE" size={52} />
                <div className="product-name">
                  <h3 id={`p-${p.sku}`}>{p.name}</h3>
                  {p.description && <p className="muted small">{p.description}</p>}
                </div>
                <strong className="price">{rupees(p.price)}</strong>
              </header>
              <ul className="stages">
                {p.stages.map((item) => (
                  <StageRow key={item.stage} item={item} onDate={onDate} />
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>
    </>
  )
}

function StageRow({ item, onDate }: { item: CatalogueItem; onDate: (d: string | null) => void }) {
  const { cart, setQty } = useStore()
  const inCart = cart.find((l) => l.sku === item.sku && l.stage === item.stage)?.qty ?? 0
  const max = Math.min(20, item.qty)
  const set = (n: number) => setQty({ sku: item.sku, stage: item.stage, name: item.name, price: item.price }, Math.max(0, Math.min(max, n)))
  const label = `${item.name}, ${STAGE_LABEL[item.stage]}`
  return (
    <li className="stage">
      <span className={`stage-dot stage-${item.stage.toLowerCase()}`} aria-hidden="true" />
      <div className="stage-text">
        <strong>{STAGE_LABEL[item.stage]}</strong>
        <span className="muted small">{STAGE_HINT[item.stage]}</span>
        <span className="small">
          {item.qty === 0 ? (
            <span className="sold-out">
              Sold out for this day
              {item.nextAvailableDate ? (
                <>
                  {' · '}
                  <button type="button" className="link-btn" onClick={() => onDate(item.nextAvailableDate!)}>
                    Available {day(item.nextAvailableDate)}
                  </button>
                </>
              ) : (
                <>
                  {' · '}
                  <NotifyMe item={item} label={label} />
                </>
              )}
            </span>
          ) : (
            <>
              Eat by {day(item.eatBy)}
              {item.qty <= 5 && <span className="low"> · Only {item.qty} left</span>}
            </>
          )}
        </span>
      </div>
      {item.qty > 0 &&
        (inCart === 0 ? (
          <button type="button" className="btn btn-small" onClick={() => set(1)} aria-label={`Add ${label}`}>
            Add
          </button>
        ) : (
          <div className="stepper" role="group" aria-label={`${label} quantity`}>
            <button type="button" onClick={() => set(inCart - 1)} aria-label={`One less ${label}`}>
              −
            </button>
            <span aria-live="polite">{inCart}</span>
            <button type="button" onClick={() => set(inCart + 1)} disabled={inCart >= max} aria-label={`One more ${label}`}>
              +
            </button>
          </div>
        ))}
    </li>
  )
}

/** Sold out on every open day: a WhatsApp message when it is back. */
function NotifyMe({ item, label }: { item: CatalogueItem; label: string }) {
  const { profile, pincode } = useStore()
  const location = useLocation()
  const queryClient = useQueryClient()
  const alerts = useQuery({ queryKey: ['stock-alerts'], queryFn: api.stockAlerts, enabled: !!profile })
  const add = useMutation({
    mutationFn: () => api.addStockAlert({ sku: item.sku, stage: item.stage, pincode: pincode! }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['stock-alerts'] }),
  })
  if (!profile) {
    return (
      <Link to={`/sign-in?next=${encodeURIComponent(location.pathname)}`} className="link-btn">
        Sign in to hear when it's back
      </Link>
    )
  }
  const waiting = alerts.data?.some((a) => a.sku === item.sku && a.stage === item.stage && !a.notifiedAt)
  if (waiting) return <span className="ok-text">We'll message you on WhatsApp when it's back</span>
  return (
    <>
      <button type="button" className="link-btn" disabled={add.isPending || alerts.isPending} onClick={() => add.mutate()} aria-label={`Tell me when ${label} is back`}>
        Tell me when it's back
      </button>
      {add.isError && (
        <span className="field-error" role="alert">
          {' '}
          {errorMessage(add.error)}
        </span>
      )}
    </>
  )
}

function groupBySku(items: CatalogueItem[]) {
  const map = new Map<string, { sku: string; name: string; variety: string; boxSize: string; price: number; description: string; stages: CatalogueItem[] }>()
  for (const i of items) {
    const p = map.get(i.sku) ?? { sku: i.sku, name: i.name, variety: i.variety, boxSize: i.boxSize, price: i.price, description: i.description ?? '', stages: [] }
    p.stages.push(i)
    map.set(i.sku, p)
  }
  return [...map.values()]
}
