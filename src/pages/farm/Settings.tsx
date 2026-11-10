// Farm Settings (docs/farm-experience.md): what customers read about the farm (name, place,
// contact, the stay, meals, transport, policies, FAQs) and the booking rules (season, notice,
// open bookings per customer, cancel and move days). Nothing is made up: empty fields show "our team will confirm"
// in the shop. Bookings can be opened only when the list of what is missing is empty.
// Saving asks the manager to confirm it is them (the policies are what customers agree to).
import { useEffect, useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { dateTime } from '../../format'
import { MONEY_CHANGE_WHY, useStepUp } from '../../StepUp'
import { FormError, ManagerOnlyNote, QueryError, Spinner, usePageTitle, useToast } from '../../ui'
import { farm, type FarmSettings } from './api'
import { FarmSubnav, toPaise, toRupees, useIsManager } from './shared'

type Text = { key: string; label: string; long?: boolean; hint?: string }
const SECTIONS: { title: string; fields: Text[] }[] = [
  {
    title: 'The farm',
    fields: [
      { key: 'farmName', label: 'Farm name' },
      { key: 'location', label: 'Address or area', long: true },
      { key: 'mapUrl', label: 'Map link (https://…)' },
      { key: 'contactPhone', label: 'Contact phone for visitors' },
      { key: 'contactEmail', label: 'Contact email' },
      { key: 'arrivalInstructions', label: 'Arrival instructions', long: true },
    ],
  },
  {
    title: 'The stay',
    fields: [
      { key: 'checkInTime', label: 'Check-in time (HH:MM)' },
      { key: 'checkOutTime', label: 'Check-out time (HH:MM)' },
      { key: 'sleepingArrangements', label: 'Sleeping arrangements', long: true },
      { key: 'bathroomFacilities', label: 'Bathroom facilities', long: true },
      { key: 'otherFacilities', label: 'Other facilities', long: true },
      { key: 'groupCoordination', label: 'How large groups are hosted', long: true, hint: 'Leave empty to show the standard sentence: no fixed limit, our team plans rooms and meals with you.' },
      { key: 'mealNotes', label: 'Meal notes', long: true },
    ],
  },
  {
    title: 'Policies',
    fields: [
      { key: 'transportPolicy', label: 'Transport policy', long: true, hint: 'Say plainly whether transport is included. The shop never promises transport unless "Transport included" is ticked.' },
      { key: 'weatherPolicy', label: 'If the weather is unsuitable', long: true },
      { key: 'harvestPolicy', label: 'Harvest policy (if a variety is short or not ready)', long: true },
      { key: 'noShowPolicy', label: 'No-show policy', long: true, hint: 'No refund is made automatically for a no-show. Write what you will do.' },
      { key: 'guestCharges', label: 'Extra services and their charges (optional)', long: true, hint: 'Leave empty if there are none. No charge is added to a booking automatically.' },
    ],
  },
]
const NUMBERS: { key: string; label: string; hint?: string }[] = [
  { key: 'leadDays', label: 'Days of notice before a visit', hint: 'The first bookable date is today plus this many days.' },
  { key: 'maxDaysAhead', label: 'Book up to this many days ahead' },
  {
    key: 'maxOpenBookings',
    label: 'Upcoming visits one customer may book at a time (1 to 20)',
    hint: 'Nothing is paid at booking (customers pay after picking), so this stops one customer holding a lot of fruit.',
  },
  { key: 'cancelDays', label: 'The customer may cancel at once this many days or more before', hint: 'Nothing is charged. Closer to the visit, the request comes to a manager.' },
  { key: 'rescheduleDays', label: 'The customer may move the date this many days or more before' },
  { key: 'stayNights', label: 'Usual nights of stay (0 for a day visit)' },
]

export default function FarmSettingsPage() {
  usePageTitle('Farm settings')
  const manager = useIsManager()
  const q = useQuery({ queryKey: ['farm-settings'], queryFn: farm.settings })
  return (
    <>
      <div className="topbar">
        <h1>Farm settings</h1>
      </div>
      <FarmSubnav />
      {!manager && <ManagerOnlyNote what="Changing farm settings" />}
      {q.isPending ? <Spinner /> : q.isError ? <QueryError error={q.error} onRetry={() => q.refetch()} /> : <Form data={q.data} manager={manager} />}
    </>
  )
}

function Form({ data, manager }: { data: { settings: FarmSettings; version: number; updatedAt: string | null; problems: string[] }; manager: boolean }) {
  const id = useId()
  const toast = useToast()
  const queryClient = useQueryClient()
  const stepUp = useStepUp(MONEY_CHANGE_WHY)
  const [s, setS] = useState<FarmSettings>(data.settings)
  useEffect(() => setS(data.settings), [data.settings])
  const set = (p: Partial<FarmSettings>) => setS((x) => ({ ...x, ...p }))
  const save = useMutation({
    mutationFn: (patch: Partial<FarmSettings>) => stepUp.run((code) => farm.saveSettings(patch, data.version, code)),
    onSuccess: (next) => {
      queryClient.setQueryData(['farm-settings'], next)
      toast.success(next.settings.bookingsOpen ? 'Saved. Bookings are open.' : 'Saved')
    },
  })
  const str = (k: string) => (typeof s[k] === 'string' ? (s[k] as string) : '')
  const num = (k: string) => (typeof s[k] === 'number' ? String(s[k]) : '')
  const extra = typeof s.extraPricePerKg === 'number' ? toRupees(s.extraPricePerKg) : ''
  const { bookingsOpen: _open, ...withoutOpen } = s

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate(withoutOpen)
      }}
    >
      <section className="card">
        <h2>Bookings</h2>
        <p>
          Customer bookings are <strong>{data.settings.bookingsOpen ? 'open' : 'closed'}</strong>. The shop shows the Farm Experience only while the switch FARM_EXPERIENCE is on.
        </p>
        {data.problems.length > 0 ? (
          <>
            <p>Before bookings can open:</p>
            <ul>
              {data.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className="muted">Everything customers need to read is filled in.</p>
        )}
        <div className="farm-actions">
          {data.settings.bookingsOpen ? (
            <button type="button" className="btn" disabled={!manager || save.isPending} onClick={() => save.mutate({ bookingsOpen: false })}>
              Close bookings
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={!manager || save.isPending || data.problems.length > 0} onClick={() => save.mutate({ bookingsOpen: true })}>
              Open bookings
            </button>
          )}
        </div>
        {data.updatedAt && <p className="muted small">Last saved {dateTime(data.updatedAt)}.</p>}
      </section>

      {SECTIONS.map((sec) => (
        <section key={sec.title} className="card">
          <h2>{sec.title}</h2>
          {sec.fields.map((f) => (
            <div key={f.key} className="field">
              <label htmlFor={`${id}-${f.key}`}>{f.label}</label>
              {f.long ? (
                <textarea id={`${id}-${f.key}`} rows={3} disabled={!manager} value={str(f.key)} onChange={(e) => set({ [f.key]: e.target.value })} />
              ) : (
                <input id={`${id}-${f.key}`} type="text" disabled={!manager} value={str(f.key)} onChange={(e) => set({ [f.key]: e.target.value })} />
              )}
              {f.hint && <p className="muted small">{f.hint}</p>}
            </div>
          ))}
          {sec.title === 'The stay' && (
            <fieldset className="field">
              <legend>Meals included in the stay</legend>
              <div className="farm-actions">
                {(['breakfast', 'lunch', 'dinner', 'refreshments'] as const).map((m) => (
                  <label key={m} className="check">
                    <input type="checkbox" disabled={!manager} checked={s.meals[m]} onChange={(e) => set({ meals: { ...s.meals, [m]: e.target.checked } })} /> {m[0].toUpperCase() + m.slice(1)}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {sec.title === 'Policies' && (
            <label className="check">
              <input type="checkbox" disabled={!manager} checked={s.transportIncluded} onChange={(e) => set({ transportIncluded: e.target.checked })} /> Transport is included
            </label>
          )}
        </section>
      ))}

      <section className="card">
        <h2>Season and booking rules</h2>
        <div className="field-row">
          <div className="field">
            <label htmlFor={`${id}-ss`}>First visit date of the season</label>
            <input id={`${id}-ss`} type="date" disabled={!manager} value={str('seasonStart')} onChange={(e) => set({ seasonStart: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-se`}>Last visit date of the season</label>
            <input id={`${id}-se`} type="date" disabled={!manager} value={str('seasonEnd')} onChange={(e) => set({ seasonEnd: e.target.value })} />
          </div>
        </div>
        {NUMBERS.map((n) => (
          <div key={n.key} className="field">
            <label htmlFor={`${id}-${n.key}`}>{n.label}</label>
            <input id={`${id}-${n.key}`} type="number" min={0} disabled={!manager} value={num(n.key)} onChange={(e) => set({ [n.key]: e.target.value === '' ? 0 : Number(e.target.value) })} />
            {n.hint && <p className="muted small">{n.hint}</p>}
          </div>
        ))}
        <div className="field">
          <label htmlFor={`${id}-extra`}>Price per kg for extra mangoes picked on the day (₹, empty = the booking's own price)</label>
          <input id={`${id}-extra`} type="number" min={0.01} step={0.01} disabled={!manager} value={extra} onChange={(e) => set({ extraPricePerKg: e.target.value === '' ? null : toPaise(e.target.value) })} />
        </div>
        <p className="muted small">The 250 kg minimum is a fixed rule of the business, not a setting.</p>
      </section>

      <section className="card">
        <h2>FAQs</h2>
        <p className="muted small">Questions without an answer are not shown to customers, and bookings can't open while any is unanswered. Remove the ones you don't need.</p>
        {s.faqs.map((f, i) => (
          <fieldset key={i} className="field farm-faq-edit">
            <legend>Question {i + 1}</legend>
            <div className="field">
              <label htmlFor={`${id}-q${i}`}>Question</label>
              <input id={`${id}-q${i}`} type="text" disabled={!manager} value={f.q} onChange={(e) => set({ faqs: s.faqs.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)) })} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-a${i}`}>Answer</label>
              <textarea id={`${id}-a${i}`} rows={2} disabled={!manager} value={f.a} onChange={(e) => set({ faqs: s.faqs.map((x, j) => (j === i ? { ...x, a: e.target.value } : x)) })} />
            </div>
            {manager && (
              <button type="button" className="btn btn-small" onClick={() => set({ faqs: s.faqs.filter((_, j) => j !== i) })}>
                Remove question
              </button>
            )}
          </fieldset>
        ))}
        {manager && (
          <button type="button" className="btn btn-small" onClick={() => set({ faqs: [...s.faqs, { q: '', a: '' }] })}>
            Add question
          </button>
        )}
      </section>

      {manager && (
        <div className="farm-save">
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save farm settings'}
          </button>
          <FormError error={save.error} />
        </div>
      )}
      {stepUp.dialog}
    </form>
  )
}
