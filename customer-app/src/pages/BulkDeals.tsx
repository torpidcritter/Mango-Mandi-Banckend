import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ApiError, api, type BulkDeal, type Stage } from '../api'
import { availableOn, maxFor, nextTier, tierAt, tierRange } from '../bulk'
import { STAGE_HINT, STAGE_LABEL, boxContents, day, rupees, when } from '../format'
import { DayChips, Stepper } from '../forms'
import { ProductImage, photoAt } from '../mango'
import { useStore } from '../store'
import { DocTitle, ErrorNote, Skeleton } from '../ui'
import { useT } from '../i18n'
import { useFeatures } from '../features'

export const bulkDealsQuery = (pincode: string | null) => ({ queryKey: ['bulk-deals', pincode], queryFn: () => api.bulkDeals(pincode) })

/** /bulk — the Bulk Deals tab: boxes for offices, events and families, priced by how many you order. */
export default function BulkDealsPage() {
  const { pincode } = useStore()
  const q = useQuery(bulkDealsQuery(pincode))
  const t = useT()
  // Farm Experience (FARM_EXPERIENCE): a farm visit with 250 kg or more, booked from here.
  const farm = useFeatures().farmExperience === true
  return (
    <>
      <header className="bulk-intro">
        <h1>{t('nav.bulk')}</h1>
        <p className="muted">{t('bulk.intro')}</p>
      </header>
      {farm && (
        <section className="card farm-card">
          <h2>{t('farm.cardTitle')}</h2>
          <p>{t('farm.cardBody', { min: 250 })}</p>
          <Link to="/farm-experience" className="btn btn-primary">
            {t('farm.cardCta')}
          </Link>
        </section>
      )}
      {q.isPending ? (
        <Skeleton label={t('bulk.loading')} cards={3} tall />
      ) : q.isError ? (
        <ErrorNote error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data.items.length ? (
        <section className="card empty">
          <h2>{t('bulk.none')}</h2>
          <p className="muted">{t('bulk.noneBody')}</p>
          <Link to="/" className="btn btn-primary">
            {t('bulk.shopRegular')}
          </Link>
        </section>
      ) : (
        <ul className="tiles bulk-tiles">
          {q.data.items.map((d, i) => (
            <BulkTile key={d.id} deal={d} eager={i < 2} />
          ))}
        </ul>
      )}
    </>
  )
}

function BulkTile({ deal: d, eager }: { deal: BulkDeal; eager: boolean }) {
  const { bulk } = useStore()
  const inCart = bulk.filter((l) => l.listingId === d.id).reduce((n, l) => n + l.qty, 0)
  const noStock = d.availability ? !d.availability.some((x) => x.enough) : false
  const t = useT()
  return (
    <li className={noStock ? 'card tile tile-sold-out' : 'card tile'}>
      <div className="tile-img">
        <ProductImage photoUrl={d.photos[0]?.url ?? null} name={d.title} size={88} eager={eager} />
        {inCart > 0 && <span className="tile-badge">{t('shop.inCart', { count: inCart })}</span>}
      </div>
      <div className="tile-body">
        <h2 className="tile-name">
          <Link to={`/bulk/${d.id}`} className="card-link">
            {d.title}
          </Link>
        </h2>
        <span className="muted small">
          {d.product.name}
          {d.product.boxSize ? ` · ${t('bulk.boxSize', { size: d.product.boxSize })}` : ''}
        </span>
        <p className="tile-foot">
          <span>{t.rich('bulk.fromPrice', { price: <strong className="price">{rupees(d.fromPrice)}</strong> })}</span>
          <span className="small muted">{t('bulk.minimum', { count: d.minQty })}</span>
          {noStock && <span className="small sold-out">{t('bulk.noStock')}</span>}
        </p>
      </div>
    </li>
  )
}

/** /bulk/:id — one bulk deal: photos, what it is, the price tiers, ripeness, day and quantity, then Add to cart. */
export function BulkDealPage() {
  const { id = '' } = useParams()
  const { pincode, date, setWhere, bulk, setBulk, cart, setQty } = useStore()
  const q = useQuery({ queryKey: ['bulk-deal', id, pincode], queryFn: () => api.bulkDeal(id, pincode) })
  const [photo, setPhoto] = useState(0)
  const [stage, setStage] = useState<Stage | null>(null)
  const [qty, setQtyState] = useState<number | null>(null)
  const [added, setAdded] = useState<string | null>(null)
  const t = useT()

  const d = q.data
  // The day: the shop's chosen day when this deal can deliver on it, else its first day with enough stock.
  const days = d?.availability ?? []
  const day0 = days.find((x) => x.date === date)?.date ?? days.find((x) => x.enough)?.date ?? days[0]?.date ?? null
  const onDay = days.find((x) => x.date === day0) ?? null
  const pickedStage = stage && d?.stages.includes(stage) ? stage : (d?.stages.find((s) => onDay?.stages.find((x) => x.stage === s)?.enough) ?? d?.stages[0] ?? null)
  const available = d ? availableOn(d, day0, pickedStage) : null
  const max = d ? maxFor(d, available) : 0
  const n = d ? Math.min(Math.max(qty ?? d.minQty, d.minQty), Math.max(max, d.minQty)) : 0

  useEffect(() => {
    if (d) document.title = `${d.title} · MandiMangoes`
  }, [d])

  if (q.isPending) return <Skeleton label={t('bulk.loadingDeal')} cards={2} tall />
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404) {
      return (
        <section className="card empty">
          <DocTitle title={t('bulk.unavailableTitle')} />
          <h1>{t('bulk.unavailable')}</h1>
          <p className="muted">{t('bulk.unavailableBody')}</p>
          <Link to="/bulk" className="btn btn-primary">
            {t('bulk.see')}
          </Link>
        </section>
      )
    }
    return <ErrorNote error={q.error} onRetry={() => q.refetch()} />
  }
  const deal = q.data
  const tier = tierAt(deal.tiers, n)
  const next = nextTier(deal, n)
  const contents = boxContents(deal.product)
  const regular = pickedStage ? cart.find((l) => l.sku === deal.product.sku && l.stage === pickedStage) : null
  const inCart = pickedStage ? bulk.find((l) => l.listingId === deal.id && l.stage === pickedStage)?.qty ?? 0 : 0
  const otherDeal = pickedStage ? bulk.find((l) => l.listingId !== deal.id && l.sku === deal.product.sku && l.stage === pickedStage) : null
  const canAdd = Boolean(pickedStage && tier && max >= deal.minQty && (available == null || available >= n))
  const cur = deal.photos[Math.min(photo, deal.photos.length - 1)]

  function add() {
    if (!pickedStage || !tier || !canAdd) return
    setBulk({ listingId: deal.id, title: deal.title, sku: deal.product.sku, name: deal.product.name, stage: pickedStage, unitPrice: tier.unitPrice }, n)
    setAdded(t('bulk.added', { count: n, title: deal.title, stage: STAGE_LABEL[pickedStage] }))
  }

  return (
    <section className="card buy bulk-deal" aria-labelledby="deal-title">
      <DocTitle title={deal.title} />
      <div className="buy-media">
        {cur ? (
          <>
            <img
              src={photoAt(cur.url, 960)}
              srcSet={[480, 640, 960, 1200].map((w) => `${photoAt(cur.url, w)} ${w}w`).join(', ')}
              sizes="(min-width: 1024px) 520px, 100vw"
              width={1200}
              height={900}
              alt={t('bulk.photoAlt', { n: photo + 1, total: deal.photos.length, title: deal.title })}
              className="product-hero"
            />
            {deal.photos.length > 1 && (
              <div className="bulk-thumbs" role="group" aria-label={t('bulk.photos')}>
                {deal.photos.map((p, i) => (
                  <button key={p.id} type="button" className="bulk-thumb" aria-pressed={i === photo} aria-label={t('bulk.showPhoto', { n: i + 1 })} onClick={() => setPhoto(i)}>
                    <img src={photoAt(p.url, 160)} width={64} height={64} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <span className="buy-art">
            <ProductImage name={deal.title} size={240} />
          </span>
        )}
      </div>
      <div className="buy-body">
        <header className="product-head">
          <div className="product-name">
            <p className="eyebrow">{t('title.bulkDeal')}</p>
            <h1 id="deal-title">{deal.title}</h1>
            <p className="muted small">
              {deal.product.name} · {deal.product.variety}
              {deal.product.boxSize ? ` · ${t('bulk.boxSize', { size: deal.product.boxSize })}` : ''}
            </p>
          </div>
        </header>
        {deal.description && <p>{deal.description}</p>}
        <dl className="bulk-facts">
          {deal.origin && (
            <>
              <dt>{t('bulk.from')}</dt>
              <dd>{deal.origin}</dd>
            </>
          )}
          {contents && (
            <>
              <dt>{t('bulk.inEachBox')}</dt>
              <dd>{contents}</dd>
            </>
          )}
          <dt>{t('bulk.order')}</dt>
          <dd>{t(deal.qtyStep > 1 ? 'bulk.orderRuleSteps' : 'bulk.orderRule', { min: deal.minQty, step: deal.qtyStep, max: deal.maxQty })}</dd>
          {deal.endsAt && (
            <>
              <dt>{t('bulk.ends')}</dt>
              <dd>{when(deal.endsAt)}</dd>
            </>
          )}
        </dl>

        <table className="bulk-tiers">
          <caption>{t('bulk.pricePerBox')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('checkout.boxes')}</th>
              <th scope="col">{t('bulk.perBox')}</th>
            </tr>
          </thead>
          <tbody>
            {deal.tiers.map((r) => (
              <tr key={r.minQty} className={tier?.minQty === r.minQty ? 'is-current' : undefined} aria-current={tier?.minQty === r.minQty ? 'true' : undefined}>
                <td>{tierRange(r)}</td>
                <td>
                  <strong>{rupees(r.unitPrice)}</strong>
                  {r.savingPerBox != null && <span className="small saving"> {t('bulk.saving', { amount: rupees(r.savingPerBox) })}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">{t('bulk.single', { price: rupees(deal.retailPrice) })}</p>

        <fieldset className="field">
          <legend>{t('product.chooseRipeness')}</legend>
          <ul className="ripe-options">
            {deal.stages.map((s) => {
              const st = onDay?.stages.find((x) => x.stage === s)
              const short = st ? !st.enough : false
              return (
                <li key={s} className={`ripe-option${s === pickedStage ? ' is-picked' : ''}${short ? ' is-sold' : ''}`}>
                  <label>
                    <input
                      type="radio"
                      name="stage"
                      value={s}
                      checked={s === pickedStage}
                      onChange={() => {
                        setStage(s)
                        setAdded(null)
                      }}
                    />
                    <span className={`stage-dot stage-${s.toLowerCase()}`} aria-hidden="true" />
                    <span className="stage-text">
                      <strong>{STAGE_LABEL[s]}</strong>
                      <span className="muted small">
                        {STAGE_HINT[s]}
                        {st &&
                          ` ${
                            short
                              ? st.available
                                ? t('bulk.onlyBelowMin', { count: st.available, day: day(onDay!.date) })
                                : t('bulk.noneLeft', { day: day(onDay!.date) })
                              : t('bulk.boxesFor', { count: st.available, day: day(onDay!.date), eatBy: day(st.eatBy) })
                          }`}
                      </span>
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        </fieldset>

        {!pincode ? (
          <p className="note">
            {t.rich('bulk.setPincode', { link: <Link to="/?where=1">{t('fav.setPincodeLink')}</Link> })}
          </p>
        ) : deal.serviceable === false ? (
          <p className="note note-warn">{t('shop.notServed', { pincode })}</p>
        ) : !days.length ? (
          <p className="note note-warn">{t('shop.noDays')}</p>
        ) : (
          <div className="field">
            <span className="label">{t('bulk.deliveryDay')}</span>
            <DayChips
              label={t('bulk.deliveryDay')}
              days={days.map((x) => x.date)}
              value={day0}
              onChange={(x) => {
                setWhere(pincode, x)
                setAdded(null)
              }}
              format={(x) => (days.find((y) => y.date === x)?.enough ? day(x) : t('bulk.lowStockDay', { day: day(x) }))}
            />
            <p className="muted small">{t('bulk.confirmAtCheckout')}</p>
          </div>
        )}

        {max >= deal.minQty ? (
          <div className="field">
            <Stepper
              label={t('product.howMany')}
              showLabel
              value={n}
              min={deal.minQty}
              max={max}
              step={deal.qtyStep}
              onChange={(x) => {
                setQtyState(x)
                setAdded(null)
              }}
              lessLabel={t('bulk.stepFewer', { count: deal.qtyStep })}
              moreLabel={t('bulk.stepMore', { count: deal.qtyStep })}
            />
            {next && (
              <p className="muted small">
                {t('bulk.next', { min: next.minQty, price: rupees(next.unitPrice) })}
              </p>
            )}
            {inCart > 0 && <p className="muted small">{t('bulk.inCartNow', { count: inCart })}</p>}
          </div>
        ) : (
          <p className="sold-out">
            {available != null
              ? t('bulk.notEnough', { stage: pickedStage ? STAGE_LABEL[pickedStage].toLowerCase() : '', min: deal.minQty, day: day(day0!) })
              : t('bulk.cantOrder')}
          </p>
        )}

        {regular && (
          <p className="note note-warn">
            {t('bulk.alsoRegular', { count: regular.qty, name: regular.name, stage: STAGE_LABEL[regular.stage] })}{' '}
            <button type="button" className="link-btn" onClick={() => setQty(regular, 0)}>
              {t('bulk.removeRegular')}
            </button>
          </p>
        )}
        {otherDeal && (
          <p className="note note-warn">
            {t('bulk.otherDeal', { title: otherDeal.title })}
          </p>
        )}

        <div className="buy-bar">
          <button type="button" className="btn btn-primary btn-block" onClick={add} disabled={!canAdd}>
            {tier ? t('bulk.addN', { count: n, total: rupees(tier.unitPrice * n) }) : t('product.addToCart')}
          </button>
        </div>
        {tier && (
          <p className="muted small" aria-live="polite">
            {n} × {rupees(tier.unitPrice)} = <strong>{rupees(tier.unitPrice * n)}</strong>. {t('bulk.freeConfirm')}
          </p>
        )}
        {added && (
          <p className="note" role="status">
            {added} <Link to="/cart">{t('shop.viewCart')}</Link>
          </p>
        )}
      </div>
    </section>
  )
}
