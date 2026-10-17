import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ApiError, api, type CatalogueItem } from '../api'
import { STAGE_HINT, STAGE_LABEL, day, rupees } from '../format'
import { useStore } from '../store'
import { ErrorNote, Spinner } from '../ui'
import { BookAheadCard } from './Preorder'

export default function Shop() {
  const { pincode, date, setWhere, cart } = useStore()
  const [editing, setEditing] = useState(!pincode)
  const boxes = cart.reduce((n, l) => n + l.qty, 0)
  const pickDate = useCallback((d: string | null) => setWhere(pincode, d), [setWhere, pincode])
  const [params] = useSearchParams()

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
    </section>
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

      <section aria-labelledby="pick">
        <h2 id="pick" className="section-title">
          Pick your mangoes for {day(chosen)}
        </h2>
        <div className="products">
          {products.map((p) => (
            <article key={p.sku} className="card product" aria-labelledby={`p-${p.sku}`}>
              <header className="product-head">
                <h3 id={`p-${p.sku}`}>{p.name}</h3>
                <strong className="price">{rupees(p.price)}</strong>
              </header>
              <ul className="stages">
                {p.stages.map((item) => (
                  <StageRow key={item.stage} item={item} />
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>
    </>
  )
}

function StageRow({ item }: { item: CatalogueItem }) {
  const { cart, setQty } = useStore()
  const inCart = cart.find((l) => l.sku === item.sku && l.stage === item.stage)?.qty ?? 0
  const max = Math.min(20, item.qty)
  const set = (n: number) => setQty({ sku: item.sku, stage: item.stage, name: item.name, price: item.price }, Math.max(0, Math.min(max, n)))
  const label = `${item.name}, ${STAGE_LABEL[item.stage]}`
  return (
    <li className="stage">
      <div className="stage-text">
        <strong>{STAGE_LABEL[item.stage]}</strong>
        <span className="muted small">{STAGE_HINT[item.stage]}</span>
        <span className="small">
          {item.qty === 0 ? (
            <span className="sold-out">Sold out for this day</span>
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

function groupBySku(items: CatalogueItem[]) {
  const map = new Map<string, { sku: string; name: string; variety: string; boxSize: string; price: number; stages: CatalogueItem[] }>()
  for (const i of items) {
    const p = map.get(i.sku) ?? { sku: i.sku, name: i.name, variety: i.variety, boxSize: i.boxSize, price: i.price, stages: [] }
    p.stages.push(i)
    map.set(i.sku, p)
  }
  return [...map.values()]
}
