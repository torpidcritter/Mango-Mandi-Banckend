// Promo codes: managers make them, see how often they are used, and turn them off.
import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { rupees } from '../format'
import type { NewPromo, Promo } from '../types'
import { Dialog, EmptyState, FormError, QueryError, Spinner, useToast, scrollRegion } from '../ui'

export function promoText(p: Pick<Promo, 'kind' | 'value' | 'maxDiscount'>): string {
  if (p.kind === 'FLAT') return `${rupees(p.value)} off`
  return `${p.value}% off${p.maxDiscount ? `, up to ${rupees(p.maxDiscount)}` : ''}`
}

function rules(p: Promo): string {
  const r: string[] = []
  if (p.minSubtotal) r.push(`orders of ${rupees(p.minSubtotal)} or more`)
  if (p.firstOrderOnly) r.push('first order only')
  r.push(p.perCustomer === 1 ? 'once per customer' : `${p.perCustomer} times per customer`)
  if (p.startsOn) r.push(`from ${p.startsOn}`)
  if (p.endsOn) r.push(`until ${p.endsOn}`)
  return r.join(' · ')
}

export default function Promos() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const q = useQuery({ queryKey: ['promos'], queryFn: api.promos })
  const [adding, setAdding] = useState(false)
  const toggle = useMutation({
    mutationFn: (p: Promo) => api.updatePromo(p.code, { active: !p.active }),
    onSuccess: (p) => {
      toast.success(`${p.code} is ${p.active ? 'on' : 'off'}`)
      void queryClient.invalidateQueries({ queryKey: ['promos'] })
    },
    onError: (err) => toast.error(err),
  })

  return (
    <>
      <div className="topbar">
        <h1>Promo codes</h1>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
          New promo code
        </button>
      </div>
      <section className="card">
        {q.isPending ? (
          <Spinner />
        ) : q.isError ? (
          <QueryError error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data.length ? (
          <EmptyState>No promo codes yet. Make one for a launch offer, a festival, or to say sorry.</EmptyState>
        ) : (
          <div {...scrollRegion('Promo codes')}>
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Discount</th>
                  <th>Rules</th>
                  <th>Used</th>
                  <th>Given</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {q.data.map((p) => (
                  <tr key={p.code}>
                    <td>
                      <strong>{p.code}</strong>
                      {p.description && <div className="small muted">{p.description}</div>}
                    </td>
                    <td>{promoText(p)}</td>
                    <td className="small">{rules(p)}</td>
                    <td>
                      {p.uses}
                      {p.maxUses ? ` of ${p.maxUses}` : ''}
                    </td>
                    <td>{rupees(p.discountGiven ?? 0)}</td>
                    <td>{p.active ? 'On' : 'Off'}</td>
                    <td>
                      <button type="button" className="btn btn-small" disabled={toggle.isPending} onClick={() => toggle.mutate(p)}>
                        {p.active ? 'Turn off' : 'Turn on'}
                        <span className="sr-only"> {p.code}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted">"Used" counts orders that are not cancelled. "Given" is the discount on paid orders.</p>
      </section>
      {adding && <AddPromo onClose={() => setAdding(false)} onDone={() => void queryClient.invalidateQueries({ queryKey: ['promos'] })} />}
    </>
  )
}

const toPaise = (s: string) => (s.trim() ? Math.round(Number(s) * 100) : null)

function AddPromo({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [f, setF] = useState({
    code: '', kind: 'PERCENT' as 'PERCENT' | 'FLAT', value: '', maxDiscount: '', minSubtotal: '', startsOn: '', endsOn: '', maxUses: '',
    perCustomer: '1', firstOrderOnly: false, description: '',
  })
  const [formError, setFormError] = useState<string | null>(null)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const add = useMutation({
    mutationFn: (p: NewPromo) => api.addPromo(p),
    onSuccess: (p) => {
      toast.success(`${p.code} made: ${promoText(p)}`)
      onDone()
      onClose()
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    const code = f.code.trim().toUpperCase()
    if (!/^[A-Z0-9]{3,20}$/.test(code)) return setFormError('Use 3 to 20 letters and digits for the code.')
    const value = Number(f.value)
    if (!(value > 0)) return setFormError('Enter the discount.')
    if (f.kind === 'PERCENT' && (value > 90 || !Number.isInteger(value))) return setFormError('A percentage is a whole number up to 90.')
    for (const k of ['maxDiscount', 'minSubtotal', 'maxUses', 'perCustomer'] as const) {
      if (f[k].trim() && !(Number(f[k]) >= 0)) return setFormError('Amounts and limits must be numbers.')
    }
    add.mutate({
      code,
      kind: f.kind,
      value: f.kind === 'FLAT' ? Math.round(value * 100) : value,
      maxDiscount: f.kind === 'PERCENT' ? toPaise(f.maxDiscount) : null,
      minSubtotal: toPaise(f.minSubtotal) ?? 0,
      startsOn: f.startsOn || null,
      endsOn: f.endsOn || null,
      maxUses: f.maxUses.trim() ? Number(f.maxUses) : null,
      perCustomer: Number(f.perCustomer) || 1,
      firstOrderOnly: f.firstOrderOnly,
      description: f.description.trim() || null,
    })
  }

  return (
    <Dialog
      title="New promo code"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="promo-form" className="btn btn-primary" disabled={add.isPending}>
            {add.isPending ? 'Saving…' : 'Make code'}
          </button>
        </>
      }
    >
      <form id="promo-form" onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor="promo-code">Code</label>
          <input id="promo-code" autoComplete="off" maxLength={20} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
          <p className="hint">What customers type, like MANGO10. Letters and digits.</p>
        </div>
        <fieldset className="field">
          <legend>Discount</legend>
          <div className="radio-row">
            <label>
              <input type="radio" name="kind" checked={f.kind === 'PERCENT'} onChange={() => setF({ ...f, kind: 'PERCENT' })} /> A percentage
            </label>
            <label>
              <input type="radio" name="kind" checked={f.kind === 'FLAT'} onChange={() => setF({ ...f, kind: 'FLAT' })} /> An amount in rupees
            </label>
          </div>
        </fieldset>
        <div className="field">
          <label htmlFor="promo-value">{f.kind === 'PERCENT' ? 'Percent off' : 'Rupees off'}</label>
          <input id="promo-value" inputMode="decimal" value={f.value} onChange={set('value')} />
        </div>
        {f.kind === 'PERCENT' && (
          <div className="field">
            <label htmlFor="promo-max">Most it can take off, in rupees (optional)</label>
            <input id="promo-max" inputMode="decimal" value={f.maxDiscount} onChange={set('maxDiscount')} />
          </div>
        )}
        <div className="field">
          <label htmlFor="promo-min">Smallest order, in rupees (optional)</label>
          <input id="promo-min" inputMode="decimal" value={f.minSubtotal} onChange={set('minSubtotal')} />
        </div>
        <div className="field">
          <label htmlFor="promo-start">Starts (optional)</label>
          <input id="promo-start" type="date" value={f.startsOn} onChange={set('startsOn')} />
        </div>
        <div className="field">
          <label htmlFor="promo-end">Ends (optional)</label>
          <input id="promo-end" type="date" value={f.endsOn} onChange={set('endsOn')} />
        </div>
        <div className="field">
          <label htmlFor="promo-uses">Total uses allowed (optional)</label>
          <input id="promo-uses" inputMode="numeric" value={f.maxUses} onChange={set('maxUses')} />
        </div>
        <div className="field">
          <label htmlFor="promo-per">Uses per customer</label>
          <input id="promo-per" inputMode="numeric" value={f.perCustomer} onChange={set('perCustomer')} />
        </div>
        <div className="field radio-row">
          <label>
            <input type="checkbox" checked={f.firstOrderOnly} onChange={(e) => setF({ ...f, firstOrderOnly: e.target.checked })} /> Only on a customer's
            first order
          </label>
        </div>
        <div className="field">
          <label htmlFor="promo-note">Note for customers (optional)</label>
          <input id="promo-note" maxLength={120} value={f.description} onChange={set('description')} />
          <p className="hint">Shown next to the discount at checkout, like "Diwali offer".</p>
        </div>
        <FormError error={formError ?? add.error} />
      </form>
    </Dialog>
  )
}
