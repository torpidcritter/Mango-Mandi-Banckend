import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useInfiniteQuery, useQuery, type InfiniteData, type UseInfiniteQueryResult } from '@tanstack/react-query'
import { ApiError, api, type PublicReview, type RatingSummary, type ReviewPage, type Stage } from '../api'
import { STAGE_HINT, STAGE_LABEL, boxContents, day, rupees } from '../format'
import { MangoArt, ProductImage, photoAt } from '../mango'
import { Stepper } from '../forms'
import { useStore } from '../store'
import { NotifyMe, PincodeCheck, ProductRating, groupBySku } from './Shop'
import { RatingBars, Stars } from '../stars'
import { Dialog, DocTitle, ErrorNote, Skeleton } from '../ui'
import { storyFor } from '../varieties'
import { catalogueQuery, productReviewsQuery, productsQuery } from '../queries'
import { BuySkeleton } from './BuySkeleton'

const dateFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
/** Reviews shown before "See all", so the page stays short. */
const FIRST_REVIEWS = 3
const SUB_LABEL = { taste: 'Taste', ripenessAccuracy: 'Ripe as promised', packaging: 'Packaging', delivery: 'Delivery' } as const

/**
 * /mangoes/:sku — the box: pick the ripeness and how many, add to cart; then what buyers say about the variety.
 * The buy box (stock) and the reviews load side by side; neither waits for the other.
 */
export default function ProductPage() {
  const { sku = '' } = useParams()
  const { pincode, date } = useStore()
  const [stars, setStars] = useState<number | null>(null)
  const [withPhotos, setWithPhotos] = useState(false)
  // A filter keeps the reviews on screen until the matching ones arrive, instead of a blank page.
  const q = useInfiniteQuery({ ...productReviewsQuery(sku, stars, withPhotos), placeholderData: keepPreviousData })
  // The same query as the buy box's (shared): the variety's story can show as soon as either answer is in.
  const cat = useQuery({ ...catalogueQuery(pincode ?? '', date), enabled: Boolean(pincode) })
  const [open, setOpen] = useState<{ review: PublicReview; index: number } | null>(null)
  // The first three reviews show; "See all" opens the rest (a filter shows every match).
  const [showAll, setShowAll] = useState(false)

  if (q.isError && q.error instanceof ApiError && q.error.status === 404) {
    return (
      <section className="card">
        <DocTitle title="Mango not found" />
        <h1>Mango not found</h1>
        <Link to="/">Back to the shop</Link>
      </section>
    )
  }
  const first = q.data?.pages[0]
  const onSale = cat.data?.items.find((i) => i.sku === sku)
  const story = first?.product ?? onSale
  return (
    <>
      <BuyBox sku={sku} fallbackName={first?.product.name} summary={first?.summary ?? null} />
      {/* On a desktop the story sits beside the ratings and reviews; on a phone they stack. */}
      <div className="product-more">
        {story && <VarietyStoryCard variety={story.variety} name={story.name} />}
        <div className="product-reviews">
          {q.isPending ? (
            <Skeleton label="Loading reviews" cards={2} />
          ) : q.isError ? (
            <ErrorNote error={q.error} onRetry={() => q.refetch()} />
          ) : (
            <Reviews
              q={q}
              stars={stars}
              withPhotos={withPhotos}
              setStars={setStars}
              setWithPhotos={setWithPhotos}
              showAll={showAll}
              onShowAll={() => setShowAll(true)}
              onPhoto={(review, index) => setOpen({ review, index })}
            />
          )}
        </div>
      </div>
      {open && <Lightbox review={open.review} start={open.index} onClose={() => setOpen(null)} />}
    </>
  )
}

type ReviewsQuery = UseInfiniteQueryResult<InfiniteData<ReviewPage>>

function Reviews({
  q,
  stars,
  withPhotos,
  setStars,
  setWithPhotos,
  showAll,
  onShowAll,
  onPhoto,
}: {
  q: ReviewsQuery
  stars: number | null
  withPhotos: boolean
  setStars: (s: number | null) => void
  setWithPhotos: (on: boolean) => void
  showAll: boolean
  onShowAll: () => void
  onPhoto: (review: PublicReview, index: number) => void
}) {
  const first = q.data!.pages[0]
  const items = q.data!.pages.flatMap((p) => p.items)
  const filtered = stars != null || withPhotos
  const variety = first.product.variety || first.product.name
  const expanded = showAll || filtered
  const shown = expanded ? items : items.slice(0, FIRST_REVIEWS)
  const more = !expanded && (items.length > FIRST_REVIEWS || q.hasNextPage)
  return (
    <>
      <section className="card" aria-labelledby="ratings-title" id="reviews">
        <h2 id="ratings-title">Ratings and reviews</h2>
        <p className="muted small">From verified buyers of every {variety} box.</p>
        <RatingBars summary={first.summary} active={stars} onPick={setStars} />
        <div className="review-filters">
          <label className="option">
            <input type="checkbox" checked={withPhotos} onChange={(e) => setWithPhotos(e.target.checked)} />
            <span>Only reviews with photos ({first.summary.withPhotos})</span>
          </label>
          {filtered && (
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setStars(null)
                setWithPhotos(false)
              }}
            >
              Show all reviews
            </button>
          )}
        </div>
      </section>

      <section aria-labelledby="reviews-title" aria-busy={q.isPlaceholderData}>
        <h2 id="reviews-title" className="section-title">
          {filtered ? 'Matching reviews' : 'Reviews'}
        </h2>
        {items.length === 0 ? (
          <p className="card muted">{filtered ? 'No reviews match. Try showing all reviews.' : 'No reviews yet. Buyers can review after delivery.'}</p>
        ) : (
          <ul className="review-list">
            {shown.map((r) => (
              <li key={r.id} className="card review">
                <ReviewCard review={r} onPhoto={(index) => onPhoto(r, index)} />
              </li>
            ))}
          </ul>
        )}
        {more && (
          <button type="button" className="btn btn-block" onClick={onShowAll}>
            See all {first.summary.count} reviews
          </button>
        )}
        {expanded && q.hasNextPage && (
          <button type="button" className="btn btn-block" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {q.isFetchingNextPage ? 'Loading…' : 'Show more reviews'}
          </button>
        )}
      </section>
    </>
  )
}

function ReviewCard({ review: r, onPhoto }: { review: PublicReview; onPhoto: (index: number) => void }) {
  const subs = (Object.keys(SUB_LABEL) as (keyof typeof SUB_LABEL)[]).filter((k) => r[k] != null)
  return (
    <article aria-label={`Review by ${r.displayName}, ${r.rating} out of 5 stars`}>
      <header className="review-head">
        <Stars value={r.rating} small />
        <span className="badge-verified">Verified purchase</span>
      </header>
      <p className="muted small">
        <strong className="reviewer">{r.displayName}</strong> · {dateFmt.format(new Date(r.createdAt))} · {r.productName}
        {r.ripenessOrdered && <>, ordered {STAGE_LABEL[r.ripenessOrdered].toLowerCase()}</>}
      </p>
      {subs.length > 0 && (
        <dl className="sub-scores">
          {subs.map((k) => (
            <div key={k}>
              <dt>{SUB_LABEL[k]}</dt>
              <dd>
                <Stars value={r[k]!} small />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {/* Plain text: React escapes it, and nothing here renders HTML. */}
      {r.comment && <p className="review-text">{r.comment}</p>}
      {r.photos.length > 0 && (
        <ul className="review-photos" aria-label="Photos from this buyer">
          {r.photos.map((p, i) => (
            <li key={p.id}>
              <button type="button" onClick={() => onPhoto(i)} aria-label={`Open photo ${i + 1} of ${r.photos.length} from ${r.displayName}`}>
                {/* An 88 px thumbnail: the API sends it 160 or 320 px wide (for sharper screens), not the full photo. */}
                <img src={photoAt(p.url, 160)} srcSet={`${photoAt(p.url, 160)} 1x, ${photoAt(p.url, 320)} 2x`} alt="" loading="lazy" decoding="async" width={88} height={88} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {r.reply && (
        <div className="brand-reply">
          <p className="small">
            <strong>Reply from MandiMangoes</strong>
          </p>
          <p className="review-text">{r.reply.body}</p>
        </div>
      )}
    </article>
  )
}

/** Where the variety comes from and what it is best for (only for varieties we have a story for). */
function VarietyStoryCard({ variety, name }: { variety: string; name: string }) {
  const story = storyFor(variety, name)
  if (!story) return null
  return (
    <section className="card story" aria-labelledby="story-title">
      <h2 id="story-title">About {story.name}</h2>
      <dl className="story-facts">
        <div>
          <dt>Where it grows</dt>
          <dd>{story.from}</dd>
        </div>
        <div>
          <dt>Taste</dt>
          <dd>{story.taste}</dd>
        </div>
        <div>
          <dt>Best for</dt>
          <dd>{story.bestFor}</dd>
        </div>
        <div>
          <dt>Season</dt>
          <dd>{story.season}</dd>
        </div>
      </dl>
      <Link to="/quality" className="link-btn">
        How we pick and check every box
      </Link>
    </section>
  )
}

/** The Amazon-style buy box: ripeness, how many, Add to cart. Stock is for the day the shop is showing. */
function BuyBox({ sku, fallbackName, summary }: { sku: string; fallbackName?: string; summary: RatingSummary | null }) {
  const { pincode, date, setWhere, cart, setQty } = useStore()
  const q = useQuery({ ...catalogueQuery(pincode ?? '', date), enabled: Boolean(pincode) })
  // A home shelf opens the box at its ripeness with ?stage=.
  const [params] = useSearchParams()
  const asked = params.get('stage')
  const [picked, setPicked] = useState<Stage | null>(asked === 'RAW' || asked === 'SEMI_RIPE' || asked === 'RIPE' ? asked : null)
  const [count, setCount] = useState(1)
  const [added, setAdded] = useState<string | null>(null)
  // After "Show stock for" another day: the day the shop showed before, to go back to.
  const [switched, setSwitched] = useState<{ date: string | null; shown: string } | null>(null)
  const switchedNote = useRef<HTMLParagraphElement>(null)
  // UX-5: before a pincode, the box and its price still show (stock waits for the pincode).
  const listing = useQuery({ ...productsQuery(), enabled: !pincode })
  // The ripeness that was sold out, so it is the one picked on the new day.
  const wanted = useRef<Stage | null>(null)
  const first = useRef(true)
  useEffect(() => {
    // Keep the shelf's ripeness on first load; reset when the box or day changes.
    if (first.current) {
      first.current = false
      return
    }
    setPicked(wanted.current)
    wanted.current = null
    setCount(1)
    setAdded(null)
  }, [sku, date])
  // The link that switched the day is gone once that ripeness is in stock: move focus to the news.
  const switchedReady = Boolean(switched) && q.isSuccess
  useEffect(() => {
    if (switchedReady) switchedNote.current?.focus()
  }, [switchedReady])

  if (!pincode) {
    const known = listing.data?.items.find((x) => x.sku === sku)
    const name = known?.name ?? fallbackName
    const contents = known ? boxContents(known) : null
    return (
      <section className="card buy" aria-labelledby="product-title">
        {name && <DocTitle title={name} />}
        <div className="buy-media">
          {known?.photoUrl ? <ProductImage photoUrl={known.photoUrl} name={known.name} className="product-hero" fit="hero" priority /> : <span className="buy-art"><MangoArt stage="RIPE" size={240} /></span>}
        </div>
        <div className="buy-body">
          <header className="product-head">
            <div className="product-name">
              <h1 id="product-title">{name ?? <span className="sk-text">Mango box</span>}</h1>
              {known && <ProductRating sku={known.sku} variety={known.variety} href="#reviews" summary={summary} />}
              {known && (
                <p className="buy-price">
                  <strong>{rupees(known.price)}</strong> <span className="muted small">per box · free delivery</span>
                </p>
              )}
            </div>
          </header>
          {known?.description && <p>{known.description}</p>}
          {contents && (
            <p className="box-contents">
              <strong>In the box:</strong> {contents}
            </p>
          )}
          <p>Enter your pincode to see the ripeness we have for your day and add a box.</p>
          <PincodeCheck initial="" label="Your delivery pincode" submitLabel="Check delivery" onDone={(pin, first) => setWhere(pin, first)} />
        </div>
      </section>
    )
  }
  if (q.isPending) return <BuySkeleton />
  if (q.isError) return <ErrorNote error={q.error} onRetry={() => q.refetch()} />
  const all = groupBySku(q.data.items)
  const p = all.find((x) => x.sku === sku)
  if (!q.data.serviceable || !p) {
    const name = fallbackName ?? sku
    return (
      <section className="card" aria-labelledby="product-title">
        <DocTitle title={name} />
        <h1 id="product-title">{name}</h1>
        <p>{q.data.serviceable ? `This box isn't on sale for ${pincode} right now.` : `We don't deliver to ${pincode} yet.`}</p>
        <Link to="/">See all mangoes</Link>
      </section>
    )
  }
  const sizes = all.filter((x) => x.variety && x.variety === p.variety)
  const open = p.stages.filter((s) => s.qty > 0)
  // Ripe is the usual pick, so it is chosen first when it is in stock. UX-6: when the ripeness
  // wanted (Ripe, or the one the link asked for) is sold out, nothing is chosen for the customer:
  // a note says so and they pick another ripeness themselves.
  const wantedStage: Stage = asked === 'RAW' || asked === 'SEMI_RIPE' || asked === 'RIPE' ? asked : 'RIPE'
  const stage = picked && open.some((s) => s.stage === picked) ? picked : open.some((s) => s.stage === wantedStage) && !picked ? wantedStage : null
  const unavailable = !stage && open.length > 0 ? (picked ?? wantedStage) : null
  const contents = boxContents(p.stages[0] ?? {})
  const item = p.stages.find((s) => s.stage === stage) ?? null
  const inCart = item ? cart.find((l) => l.sku === sku && l.stage === item.stage)?.qty ?? 0 : 0
  const room = item ? Math.max(0, Math.min(20, item.qty) - inCart) : 0
  const n = Math.max(1, Math.min(count, room))
  const label = item ? `${p.name}, ${STAGE_LABEL[item.stage]}` : ''
  const shownDay = q.data.deliveryDate!

  function add() {
    if (!item || room === 0) return
    setQty({ sku: item.sku, stage: item.stage, name: item.name, price: item.price }, inCart + n)
    setAdded(`Added ${n} ${n === 1 ? 'box' : 'boxes'} of ${label}.`)
    setCount(1)
  }

  return (
    <section className="card buy" aria-labelledby="product-title">
      <DocTitle title={p.name} />
      {/* The photo: on top on a phone, the left column on a desktop (a large drawn mango there when there is no photo). */}
      <div className="buy-media">
        {p.photoUrl ? <ProductImage photoUrl={p.photoUrl} name={p.name} className="product-hero" fit="hero" priority /> : <span className="buy-art"><MangoArt stage={item?.stage ?? 'RIPE'} size={240} /></span>}
      </div>
      <div className="buy-body">
        <header className="product-head">
          {!p.photoUrl && <span className="head-art"><MangoArt stage={item?.stage ?? 'RIPE'} size={72} /></span>}
          <div className="product-name">
            <h1 id="product-title">{p.name}</h1>
            <ProductRating sku={p.sku} variety={p.variety} href="#reviews" summary={summary} />
            <p className="buy-price">
              <strong>{rupees(p.price)}</strong> <span className="muted small">per box · free delivery</span>
            </p>
          </div>
        </header>
        {p.description && <p>{p.description}</p>}
        {contents && (
          <p className="box-contents">
            <strong>In the box:</strong> {contents}
          </p>
        )}

        {sizes.length > 1 && (
          <div className="field">
            <span className="label" id="size-label">
              Box size
            </span>
            <div className="chips" role="group" aria-labelledby="size-label">
              {sizes.map((x) => (
                <Link key={x.sku} to={`/mangoes/${x.sku}`} replace className="chip" aria-current={x.sku === sku ? 'true' : undefined}>
                  {x.boxSize || x.name} · {rupees(x.price)}
                </Link>
              ))}
            </div>
          </div>
        )}

        {unavailable && (
          <p className="note" id="ripe-note">
            {STAGE_LABEL[unavailable]} is sold out for {day(shownDay)}. Choose another ripeness below
            {p.stages.find((s) => s.stage === unavailable)?.nextAvailableDate ? `, or see ${STAGE_LABEL[unavailable].toLowerCase()} stock for another day` : ''}.
          </p>
        )}
        <fieldset className="field" aria-describedby={unavailable ? 'ripe-note' : undefined}>
          <legend>Choose ripeness</legend>
          <ul className="ripe-options">
            {p.stages.map((s) => {
              const id = `st-${s.stage}`
              const sold = s.qty === 0
              return (
                <li key={s.stage} className={`ripe-option${s.stage === stage ? ' is-picked' : ''}${sold ? ' is-sold' : ''}`}>
                  <label>
                    <input
                      type="radio"
                      name="stage"
                      value={s.stage}
                      checked={s.stage === stage}
                      disabled={sold}
                      onChange={() => {
                        setPicked(s.stage)
                        setAdded(null)
                      }}
                      aria-labelledby={`${id}-name`}
                      aria-describedby={`${id}-info`}
                    />
                    <span className={`stage-dot stage-${s.stage.toLowerCase()}`} aria-hidden="true" />
                    <span className="stage-text">
                      <strong id={`${id}-name`}>{STAGE_LABEL[s.stage]}</strong>
                      <span id={`${id}-info`} className="muted small">
                        {STAGE_HINT[s.stage]} {sold ? 'Sold out for this day.' : `Eat by ${day(s.eatBy)}.`}
                        {!sold && s.qty <= 5 && <span className="low"> Only {s.qty} left.</span>}
                      </span>
                    </span>
                  </label>
                  {sold && (
                    <span className="small ripe-extra">
                      {s.nextAvailableDate ? (
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => {
                            wanted.current = s.stage
                            setSwitched({ date, shown: shownDay })
                            setWhere(pincode, s.nextAvailableDate!)
                          }}
                        >
                          Show stock for {day(s.nextAvailableDate)}
                        </button>
                      ) : (
                        <NotifyMe item={s} label={`${p.name}, ${STAGE_LABEL[s.stage]}`} />
                      )}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </fieldset>

        {item ? (
          <>
            <div className="field">
              <Stepper
                label="How many boxes"
                showLabel
                value={n}
                shown={room === 0 ? 0 : n}
                min={1}
                max={room}
                onChange={setCount}
                lessLabel="One box fewer"
                moreLabel="One box more"
              />
              {inCart > 0 && (
                <p className="muted small">
                  {inCart} already in your cart{room === 0 ? ', the most we can send for this day.' : '.'}
                </p>
              )}
            </div>
            {/* Sticks to the bottom of a phone screen (above the tabs) until the buy box scrolls past. */}
            <div className="buy-bar">
              <button type="button" className="btn btn-primary btn-block" onClick={add} disabled={room === 0}>
                Add to cart · {rupees(item.price * (room === 0 ? 0 : n))}
              </button>
            </div>
          </>
        ) : open.length > 0 ? (
          <>
            {/* UX-6: nothing picked yet. The button stays where it will be, and says why it waits. */}
            <div className="buy-bar">
              <button type="button" className="btn btn-primary btn-block" disabled aria-describedby="pick-first">
                Add to cart
              </button>
            </div>
            <p className="muted small" id="pick-first">
              Choose a ripeness above to add a box.
            </p>
          </>
        ) : (
          <p className="sold-out">Every ripeness is sold out for {day(shownDay)}.</p>
        )}
        {switched && (
          <p className="note" role="status" tabIndex={-1} ref={switchedNote}>
            Now showing stock for {day(shownDay)}.{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setWhere(pincode, switched.date)
                setSwitched(null)
              }}
            >
              Back to {day(switched.shown)}
            </button>
          </p>
        )}
        {added && (
          <p className="note" role="status">
            {added} <Link to="/cart">View cart</Link>
          </p>
        )}
        <p className="muted small">Showing stock for {day(shownDay)}. You choose the delivery day at checkout.</p>
      </div>
    </section>
  )
}

/** Full-size photos, one at a time; arrow keys or buttons move, Escape closes. */
function Lightbox({ review, start, onClose }: { review: PublicReview; start: number; onClose: () => void }) {
  const [i, setI] = useState(start)
  const n = review.photos.length
  const move = (d: number) => setI((x) => (x + d + n) % n)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setI((x) => (x + 1) % n)
      if (e.key === 'ArrowLeft') setI((x) => (x - 1 + n) % n)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [n])
  return (
    <Dialog
      title={`Photo ${i + 1} of ${n} from ${review.displayName}`}
      onClose={onClose}
      footer={
        <>
          {n > 1 && (
            <>
              <button type="button" className="btn" onClick={() => move(-1)}>
                Previous
              </button>
              <button type="button" className="btn" onClick={() => move(1)}>
                Next
              </button>
            </>
          )}
          <button type="button" className="btn btn-primary" data-autofocus onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="lightbox">
        <img src={api.publicPhotoUrl(review.photos[i].url)} alt={`Photo ${i + 1} of the ${review.productName} from ${review.displayName}`} />
      </div>
    </Dialog>
  )
}
