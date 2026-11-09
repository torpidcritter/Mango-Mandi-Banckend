// Farm Experience (FARM_EXPERIENCE, docs/farm-experience.md): the page about the farm visit, and
// the six-step booking. Everything about the farm itself (its name, rooms, meals, policies, FAQs)
// is what the farm team wrote on the panel's Farm Settings page, in English; where they have not
// written something yet, the page says our team will confirm it, and never makes it up.
// The API prices the booking and checks every rule again (250 kg minimum, stock, dates).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api, signedInProfile, type FarmBookingInput, type FarmExperience, type FarmMeals, type FarmVariety } from '../api'
import { clock, day, rupees } from '../format'
import { DayChips, Field } from '../forms'
import { ProductImage } from '../mango'
import { ErrorNote, Spinner } from '../ui'
import { useT, type T } from '../i18n'

export const farmQuery = () => ({ queryKey: ['farm-experience'], queryFn: () => api.farmExperience() })

/** English as the farm team wrote it: marked so, when the shop is shown in another language. */
const english = (t: T) => (t.lang === 'en' ? undefined : 'en')

export function mealsText(t: T, meals: FarmMeals): string {
  const names = (['breakfast', 'lunch', 'dinner', 'refreshments'] as const).filter((m) => meals[m]).map((m) => t(`farm.meal.${m}`))
  return names.length ? names.join(', ') : t('farm.toConfirm')
}

/** /farm-experience — what the visit is, what is included, how booking works, the policies and FAQs. */
export default function FarmPage() {
  const t = useT()
  const q = useQuery(farmQuery())
  if (q.isPending) return <Spinner label={t('farm.loading')} />
  if (q.isError) return <ErrorNote error={q.error} onRetry={() => q.refetch()} />
  const f = q.data
  const s = f.settings
  const en = english(t)
  const said = (text: string) => (text ? <p lang={en}>{text}</p> : <p className="muted">{t('farm.toConfirm')}</p>)
  return (
    <>
      <section className="farm-hero card">
        <h1>{t('farm.title')}</h1>
        {s.farmName && (
          <p className="farm-name" lang={en}>
            {s.farmName}
            {s.location && ` · ${s.location}`}
          </p>
        )}
        <p className="lead">{t('farm.lead', { min: f.minKg })}</p>
        {f.bookingsOpen ? (
          <Link to="/farm-experience/book" className="btn btn-primary">
            {t('farm.book')}
          </Link>
        ) : (
          <p className="note-card">{t('farm.closed')}</p>
        )}
        <p className="small">
          <Link to="/farm-bookings">{t('farm.myBookings')}</Link>
        </p>
        {en && <p className="small muted">{t('farm.englishOnly')}</p>}
      </section>

      <section className="card">
        <h2>{t('farm.journeyTitle')}</h2>
        <ol className="farm-journey">
          {([1, 2, 3, 4, 5] as const).map((n) => (
            <li key={n}>{t(`farm.journey${n}`)}</li>
          ))}
        </ol>
      </section>

      <section className="card">
        <h2>{t('farm.includedTitle')}</h2>
        <ul className="farm-list">
          <li>{t('farm.inc.mangoes', { min: f.minKg })}</li>
          <li>{t('farm.inc.stay')}</li>
          <li>{t('farm.inc.meals', { meals: mealsText(t, s.meals) })}</li>
          <li>{s.transportIncluded ? t('farm.inc.transportYes') : t('farm.inc.transportNo')}</li>
        </ul>
        {s.mealNotes && <p lang={en}>{s.mealNotes}</p>}
      </section>

      <section className="card">
        <h2>{t('farm.houseTitle')}</h2>
        <dl className="facts">
          <div>
            <dt>{t('farm.times')}</dt>
            <dd>{s.checkInTime && s.checkOutTime ? t('farm.timesText', { from: clock(s.checkInTime), to: clock(s.checkOutTime) }) : t('farm.toConfirm')}</dd>
          </div>
          <div>
            <dt>{t('farm.sleeping')}</dt>
            <dd>{said(s.sleepingArrangements)}</dd>
          </div>
          <div>
            <dt>{t('farm.bathrooms')}</dt>
            <dd>{said(s.bathroomFacilities)}</dd>
          </div>
          {s.otherFacilities && (
            <div>
              <dt>{t('farm.facilities')}</dt>
              <dd>{said(s.otherFacilities)}</dd>
            </div>
          )}
          <div>
            <dt>{t('farm.groups')}</dt>
            <dd>{s.groupCoordination ? said(s.groupCoordination) : <p>{t('farm.groupsText')}</p>}</dd>
          </div>
        </dl>
      </section>

      <section className="card">
        <h2>{t('farm.varietiesTitle')}</h2>
        {!f.varieties.length ? (
          <p className="muted">{t('farm.noVarieties')}</p>
        ) : (
          <ul className="farm-varieties">
            {f.varieties.map((v) => (
              <VarietyCard key={v.id} v={v} />
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>{t('farm.howTitle')}</h2>
        <ol className="farm-journey">
          <li>{t('farm.how1', { min: f.minKg })}</li>
          <li>{t('farm.how2')}</li>
          <li>{t('farm.how3')}</li>
          <li>{t('farm.how4')}</li>
          <li>{t('farm.how5')}</li>
          <li>{t('farm.how6')}</li>
        </ol>
      </section>

      <section className="card">
        <h2>{t('farm.infoTitle')}</h2>
        <Policies f={f} />
      </section>

      {s.faqs.length > 0 && (
        <section className="card">
          <h2>{t('farm.faqTitle')}</h2>
          <div className="farm-faqs" lang={en}>
            {s.faqs.map((x) => (
              <details key={x.q}>
                <summary>{x.q}</summary>
                <p>{x.a}</p>
              </details>
            ))}
          </div>
        </section>
      )}

      {f.bookingsOpen && (
        <Link to="/farm-experience/book" className="btn btn-primary btn-block">
          {t('farm.book')}
        </Link>
      )}
    </>
  )
}

function Policies({ f }: { f: FarmExperience }) {
  const t = useT()
  const s = f.settings
  const en = english(t)
  const row = (label: string, text: ReactNode) => (
    <div>
      <dt>{label}</dt>
      <dd>{text}</dd>
    </div>
  )
  const written = (text: string) => (text ? <span lang={en}>{text}</span> : t('farm.toConfirm'))
  return (
    <dl className="facts">
      {row(t('farm.minimum'), t('farm.minimumText', { min: f.minKg }))}
      {row(
        t('farm.payment'),
        <>
          {t('farm.paymentText')} {s.extraPricePerKg != null ? t('farm.extraPrice', { price: rupees(s.extraPricePerKg) }) : t('farm.extraSamePrice')}
        </>,
      )}
      {row(t('farm.cancelling'), t('farm.cancelRule', { days: s.cancelDays }))}
      {row(t('farm.moving'), t('farm.moveRule', { days: s.rescheduleDays }))}
      {row(t('farm.transport'), <>{s.transportIncluded ? t('farm.inc.transportYes') : t('farm.inc.transportNo')} {written(s.transportPolicy)}</>)}
      {row(t('farm.weather'), written(s.weatherPolicy))}
      {row(t('farm.harvest'), written(s.harvestPolicy))}
      {row(t('farm.noShow'), written(s.noShowPolicy))}
      {s.guestCharges && row(t('farm.guestCharges'), written(s.guestCharges))}
    </dl>
  )
}

function VarietyCard({ v }: { v: FarmVariety }) {
  const t = useT()
  const en = english(t)
  return (
    <li className="farm-variety">
      <ProductImage photoUrl={v.photoUrl} name={v.name} size={72} eager={false} />
      <div>
        <h3 lang={en}>{v.name}</h3>
        {v.description && <p lang={en}>{v.description}</p>}
        {v.ripenessNote && (
          <p className="small muted" lang={en}>
            {v.ripenessNote}
          </p>
        )}
        <p>
          <strong className="price">{t('farm.perKg', { price: rupees(v.pricePerKg) })}</strong>
        </p>
        {v.tiers.length > 0 && (
          <ul className="small farm-tiers">
            {v.tiers.map((x) => (
              <li key={x.minKg}>{t('farm.tier', { kg: x.minKg, price: rupees(x.pricePerKg) })}</li>
            ))}
          </ul>
        )}
        {v.harvestFrom && v.harvestTo && <p className="small muted">{t('farm.harvestWindow', { from: day(v.harvestFrom), to: day(v.harvestTo) })}</p>}
        <p className="small">{v.available ? t('farm.availableKg', { kg: v.bestDayKg ?? 0 }) : <span className="sold-out">{t('farm.notAvailable')}</span>}</p>
      </div>
    </li>
  )
}

// ---------------------------------------------------------------- booking

const STEPS = ['variety', 'kg', 'date', 'guests', 'details', 'summary'] as const
type Step = (typeof STEPS)[number]

interface Draft {
  varietyId: string | null
  kg: string
  visitDate: string | null
  arrivalDate: string
  departureDate: string
  adults: string
  children: string
  overnight: string
  veg: string
  nonVeg: string
  jain: string
  allergies: string
  requests: string
  accessibility: string
  notes: string
  contactName: string
  contactEmail: string
  billingName: string
  billingGstin: string
  accept: boolean
}

/** A whole number from a box, or null; no upper limit here: the API checks stock and group size. */
const whole = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : null)
const plusDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
/** The stay the customer has picked, or by default the visit day plus the farm's usual nights when anyone stays overnight. */
function stayOf(f: FarmExperience, d: Draft) {
  const from = d.arrivalDate || d.visitDate!
  const nights = (whole(d.overnight) ?? 0) > 0 ? f.settings.stayNights : 0
  return { from, to: d.departureDate || plusDays(d.visitDate!, nights) }
}

/** /farm-experience/book — variety, kilograms, date, group, details, summary; then Razorpay. */
export function FarmBook() {
  const t = useT()
  const q = useQuery(farmQuery())
  if (q.isPending) return <Spinner label={t('farm.loading')} />
  if (q.isError) return <ErrorNote error={q.error} onRetry={() => q.refetch()} />
  if (!q.data.bookingsOpen) {
    return (
      <section className="card empty">
        <h1>{t('farm.title')}</h1>
        <p>{t('farm.closed')}</p>
        <Link to="/farm-experience" className="btn">
          {t('farm.aboutVisit')}
        </Link>
      </section>
    )
  }
  return <BookingFlow f={q.data} />
}

function BookingFlow({ f }: { f: FarmExperience }) {
  const t = useT()
  const navigate = useNavigate()
  const en = english(t)
  const profile = signedInProfile()
  const [step, setStep] = useState<Step>('variety')
  const [error, setError] = useState<string | null>(null)
  const [d, setD] = useState<Draft>(() => ({
    varietyId: f.varieties.find((v) => v.available)?.id ?? null,
    kg: String(f.minKg),
    visitDate: null,
    arrivalDate: '',
    departureDate: '',
    adults: '2',
    children: '0',
    overnight: '0',
    veg: '',
    nonVeg: '',
    jain: '',
    allergies: '',
    requests: '',
    accessibility: '',
    notes: '',
    contactName: profile?.name ?? '',
    contactEmail: profile?.email ?? '',
    billingName: '',
    billingGstin: '',
    accept: false,
  }))
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setError(null)
    setD((x) => ({ ...x, [k]: v }))
  }
  const variety = f.varieties.find((v) => v.id === d.varietyId) ?? null
  const kg = whole(d.kg)
  const kgOk = kg != null && kg >= f.minKg
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [step])

  const quote = useQuery({
    queryKey: ['farm-quote', d.varietyId, kg],
    queryFn: () => api.farmQuote(d.varietyId!, kg!),
    enabled: Boolean(d.varietyId) && kgOk,
  })
  const dates = useQuery({
    queryKey: ['farm-dates', d.varietyId, kg],
    queryFn: () => api.farmDates(d.varietyId, kg),
    enabled: Boolean(d.varietyId) && kgOk && (step === 'date' || step === 'guests'),
  })
  const dateList = useMemo(() => (dates.data?.dates ?? []).map((x) => x.date), [dates.data])

  const idemKey = useRef<string | null>(null)
  const book = useMutation({
    mutationFn: async () => {
      idemKey.current ??= crypto.randomUUID()
      const n = (s: string) => whole(s) ?? undefined
      const input: FarmBookingInput = {
        varietyId: d.varietyId!,
        kg: kg!,
        visitDate: d.visitDate!,
        arrivalDate: stayOf(f, d).from,
        departureDate: stayOf(f, d).to,
        adults: whole(d.adults)!,
        children: whole(d.children) ?? 0,
        overnightGuests: whole(d.overnight) ?? 0,
        food: {
          ...(n(d.veg) != null && { veg: n(d.veg) }),
          ...(n(d.nonVeg) != null && { nonVeg: n(d.nonVeg) }),
          ...(n(d.jain) != null && { jain: n(d.jain) }),
          ...(d.allergies.trim() && { allergies: d.allergies.trim() }),
          ...(d.requests.trim() && { requests: d.requests.trim() }),
        },
        ...(d.accessibility.trim() && { accessibility: d.accessibility.trim() }),
        ...(d.notes.trim() && { notes: d.notes.trim() }),
        contactName: d.contactName.trim(),
        ...(d.contactEmail.trim() && { contactEmail: d.contactEmail.trim() }),
        ...(d.billingName.trim() && { billingName: d.billingName.trim() }),
        ...(d.billingGstin.trim() && { billingGstin: d.billingGstin.trim() }),
        acceptPolicies: true,
      }
      // Nothing is paid now: the bill comes after picking and weighing.
      const b = await api.bookFarm(input, idemKey.current)
      navigate(`/farm-bookings/${b.bookingId}`, { state: { placed: true } })
    },
  })

  /** What stops the customer moving on from this step, in their words; null when it is fine. */
  function problem(s: Step): string | null {
    if (s === 'variety') return variety ? null : t('farm.pickVariety')
    if (s === 'kg') return kgOk ? null : t('farm.kgMin', { min: f.minKg })
    if (s === 'date') return d.visitDate && dateList.includes(d.visitDate) ? null : t('farm.pickDate')
    if (s === 'guests') {
      const adults = whole(d.adults)
      const children = whole(d.children)
      const overnight = whole(d.overnight)
      if (adults == null || adults < 1) return t('farm.adultsMin')
      if (children == null || overnight == null) return t('farm.wholeNumbers')
      if (overnight > adults + children) return t('farm.overnightTooMany')
      for (const v of [d.veg, d.nonVeg, d.jain]) if (v.trim() && whole(v) == null) return t('farm.wholeNumbers')
      const { from, to } = stayOf(f, d)
      if (from > d.visitDate! || to < d.visitDate!) return t('farm.stayDates')
      return null
    }
    if (s === 'details') {
      if (!profile?.phone) return t('farm.needPhone')
      return d.contactName.trim() ? null : t('farm.nameNeeded')
    }
    return d.accept ? null : t('farm.acceptNeeded')
  }

  const at = STEPS.indexOf(step)
  function next() {
    const p = problem(step)
    if (p) return setError(p)
    if (step === 'summary') return book.mutate()
    setStep(STEPS[at + 1])
  }
  function back() {
    setError(null)
    setStep(STEPS[at - 1])
  }

  return (
    <>
      <p className="small">
        <Link to="/farm-experience">{t('farm.aboutVisit')}</Link>
      </p>
      <h1>{t('farm.bookTitle')}</h1>
      <p className="muted small" aria-live="polite">
        {t('farm.stepOf', { n: at + 1, total: STEPS.length, name: t(`farm.s.${step}`) })}
      </p>
      <form
        className="card farm-step"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          next()
        }}
      >
        <h2 ref={heading} tabIndex={-1}>
          {t(`farm.s.${step}`)}
        </h2>

        {step === 'variety' && (
          <fieldset className="field">
            <legend>{t('farm.pickVariety')}</legend>
            <ul className="ripe-options">
              {f.varieties.map((v) => (
                <li key={v.id} className={`ripe-option${v.id === d.varietyId ? ' is-picked' : ''}${v.available ? '' : ' is-sold'}`}>
                  <label>
                    <input type="radio" name="variety" value={v.id} checked={v.id === d.varietyId} disabled={!v.available} onChange={() => set('varietyId', v.id)} />
                    <span className="stage-text">
                      <strong lang={en}>{v.name}</strong>
                      <span className="muted small">
                        {t('farm.perKg', { price: rupees(v.pricePerKg) })} · {v.available ? t('farm.availableKg', { kg: v.bestDayKg ?? 0 }) : t('farm.notAvailable')}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}

        {step === 'kg' && (
          <>
            <Field id="farm-kg" label={t('farm.kgLabel')} hint={t('farm.kgHint', { min: f.minKg, max: variety?.bestDayKg ?? 0 })}>
              <input type="number" inputMode="numeric" min={f.minKg} step={1} value={d.kg} onChange={(e) => set('kg', e.target.value)} />
            </Field>
            {kgOk && quote.data && (
              <p className="farm-quote" aria-live="polite">
                {t('farm.quote', { kg: quote.data.kg, price: rupees(quote.data.pricePerKg), total: rupees(quote.data.total) })}
              </p>
            )}
            <ErrorNote error={kgOk ? quote.error : null} />
          </>
        )}

        {step === 'date' &&
          (dates.isPending ? (
            <Spinner label={t('farm.loadingDates')} />
          ) : dates.isError ? (
            <ErrorNote error={dates.error} onRetry={() => dates.refetch()} />
          ) : !dateList.length ? (
            <p>{t('farm.noDates', { kg: kg ?? f.minKg })}</p>
          ) : (
            <DayChips label={t('farm.pickDate')} days={dateList} value={d.visitDate} onChange={(x) => set('visitDate', x)} format={day} />
          ))}

        {step === 'guests' && (
          <>
            <p className="note-card">{t('farm.bigGroup')}</p>
            <div className="farm-grid">
              <Field id="farm-adults" label={t('farm.adults')}>
                <input type="number" inputMode="numeric" min={1} step={1} value={d.adults} onChange={(e) => set('adults', e.target.value)} />
              </Field>
              <Field id="farm-children" label={t('farm.children')}>
                <input type="number" inputMode="numeric" min={0} step={1} value={d.children} onChange={(e) => set('children', e.target.value)} />
              </Field>
              <Field id="farm-overnight" label={t('farm.overnight')}>
                <input type="number" inputMode="numeric" min={0} step={1} value={d.overnight} onChange={(e) => set('overnight', e.target.value)} />
              </Field>
              <Field id="farm-arrival" label={t('farm.arrival')}>
                <input type="date" max={d.visitDate ?? undefined} value={d.arrivalDate || d.visitDate || ''} onChange={(e) => set('arrivalDate', e.target.value)} />
              </Field>
              <Field id="farm-departure" label={t('farm.departure')}>
                <input type="date" min={d.visitDate ?? undefined} value={d.visitDate ? stayOf(f, d).to : ''} onChange={(e) => set('departureDate', e.target.value)} />
              </Field>
            </div>
            <fieldset className="field">
              <legend>{t('farm.food')}</legend>
              <div className="farm-grid">
                <Field id="farm-veg" label={t('farm.veg')}>
                  <input type="number" inputMode="numeric" min={0} step={1} value={d.veg} onChange={(e) => set('veg', e.target.value)} />
                </Field>
                <Field id="farm-nonveg" label={t('farm.nonVeg')}>
                  <input type="number" inputMode="numeric" min={0} step={1} value={d.nonVeg} onChange={(e) => set('nonVeg', e.target.value)} />
                </Field>
                <Field id="farm-jain" label={t('farm.jain')}>
                  <input type="number" inputMode="numeric" min={0} step={1} value={d.jain} onChange={(e) => set('jain', e.target.value)} />
                </Field>
              </div>
              <Field id="farm-allergies" label={t('farm.allergies')}>
                <input type="text" maxLength={1000} value={d.allergies} onChange={(e) => set('allergies', e.target.value)} />
              </Field>
              <Field id="farm-requests" label={t('farm.foodRequests')}>
                <input type="text" maxLength={1000} value={d.requests} onChange={(e) => set('requests', e.target.value)} />
              </Field>
            </fieldset>
            <Field id="farm-access" label={t('farm.accessibility')}>
              <textarea rows={2} maxLength={1000} value={d.accessibility} onChange={(e) => set('accessibility', e.target.value)} />
            </Field>
            <Field id="farm-notes" label={t('farm.notes')}>
              <textarea rows={3} maxLength={2000} value={d.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          </>
        )}

        {step === 'details' && (
          <>
            <Field id="farm-name" label={t('farm.name')}>
              <input type="text" autoComplete="name" maxLength={80} value={d.contactName} onChange={(e) => set('contactName', e.target.value)} />
            </Field>
            <dl className="facts">
              <div>
                <dt>{t('farm.phone')}</dt>
                <dd>{profile?.phone ?? <Link to="/account">{t('farm.needPhone')}</Link>}</dd>
              </div>
            </dl>
            <Field id="farm-email" label={t('farm.email')}>
              <input type="email" autoComplete="email" maxLength={200} value={d.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} />
            </Field>
            <Field id="farm-bill-name" label={t('farm.billingName')}>
              <input type="text" autoComplete="organization" maxLength={120} value={d.billingName} onChange={(e) => set('billingName', e.target.value)} />
            </Field>
            <Field id="farm-gstin" label={t('farm.gstin')}>
              <input type="text" maxLength={20} value={d.billingGstin} onChange={(e) => set('billingGstin', e.target.value.toUpperCase())} />
            </Field>
          </>
        )}

        {step === 'summary' && variety && kg && d.visitDate && (
          <Summary f={f} d={d} variety={variety} kg={kg} total={quote.data?.total ?? null} pricePerKg={quote.data?.pricePerKg ?? null} onAccept={(v) => set('accept', v)} />
        )}

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <ErrorNote error={book.error} />
        <div className="row farm-nav">
          {at > 0 && (
            <button type="button" className="btn" onClick={back} disabled={book.isPending}>
              {t('farm.back')}
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={book.isPending}>
            {step === 'summary'
              ? book.isPending
                ? t('farm.booking')
                : t('farm.bookNow')
              : t('farm.next')}
          </button>
        </div>
      </form>
    </>
  )
}

function Summary({
  f,
  d,
  variety,
  kg,
  total,
  pricePerKg,
  onAccept,
}: {
  f: FarmExperience
  d: Draft
  variety: FarmVariety
  kg: number
  total: number | null
  pricePerKg: number | null
  onAccept: (v: boolean) => void
}) {
  const t = useT()
  const en = english(t)
  const s = f.settings
  const { from, to } = stayOf(f, d)
  return (
    <>
      <dl className="facts">
        <div>
          <dt>{t('farm.variety')}</dt>
          <dd lang={en}>{variety.name}</dd>
        </div>
        <div>
          <dt>{t('farm.mangoes')}</dt>
          <dd>{pricePerKg != null ? t('farm.kgAt', { kg, price: rupees(pricePerKg) }) : t('farm.kgOnly', { kg })}</dd>
        </div>
        <div>
          <dt>{t('farm.visitDate')}</dt>
          <dd>{day(d.visitDate!)}</dd>
        </div>
        <div>
          <dt>{t('farm.stay')}</dt>
          <dd>{from === to ? day(from) : t('farm.stayText', { from: day(from), to: day(to) })}</dd>
        </div>
        <div>
          <dt>{t('farm.group')}</dt>
          <dd>{t('farm.groupText', { adults: whole(d.adults) ?? 0, children: whole(d.children) ?? 0, overnight: whole(d.overnight) ?? 0 })}</dd>
        </div>
        <div>
          <dt>{t('farm.meals')}</dt>
          <dd>{mealsText(t, s.meals)}</dd>
        </div>
        <div>
          <dt>{t('farm.transport')}</dt>
          <dd>{s.transportIncluded ? t('farm.inc.transportYes') : t('farm.inc.transportNo')}</dd>
        </div>
        <div>
          <dt>{t('farm.estimate')}</dt>
          <dd>
            <strong className="price">{total != null ? rupees(total) : '—'}</strong>
          </dd>
        </div>
      </dl>
      <p className="small muted">{t('farm.payNote')}</p>
      <details>
        <summary>{t('farm.infoTitle')}</summary>
        <Policies f={f} />
        {s.transportPolicy && (
          <p className="small" lang={en}>
            {s.transportPolicy}
          </p>
        )}
      </details>
      <label className="option">
        <input type="checkbox" checked={d.accept} onChange={(e) => onAccept(e.target.checked)} /> {t('farm.accept')}
      </label>
    </>
  )
}
