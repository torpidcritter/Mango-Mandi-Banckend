// Harvest stock (docs/farm-experience.md): the varieties customers can book (name, price per kg,
// price tiers) and, per variety and day, how many kg are estimated and how many are bookable.
// Only bookable kg can be sold; estimates never are. Bookable kg can't go below what is already
// booked or held for that day. Prices are a money change: the manager confirms it is them.
import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { date, istDate, rupees } from '../../format'
import { MONEY_CHANGE_WHY, useStepUp } from '../../StepUp'
import { Badge, Dialog, EmptyState, FormError, ManagerOnlyNote, QueryError, Spinner, scrollRegion, usePageTitle, useToast } from '../../ui'
import { farm, type HarvestCell, type Variety } from './api'
import { FarmSubnav, toPaise, toRupees, useIsManager } from './shared'

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const READINESS = { NOT_READY: 'Not ready', NEARLY_READY: 'Nearly ready', READY: 'Ready', PAST_PEAK: 'Past peak' } as const
const QC = { PENDING: 'QC pending', PASSED: 'QC passed', FAILED: 'QC failed' } as const

export default function FarmHarvest() {
  usePageTitle('Harvest stock')
  const manager = useIsManager()
  const varieties = useQuery({ queryKey: ['farm-varieties'], queryFn: farm.varieties })
  const [from, setFrom] = useState(istDate())
  const cal = useQuery({ queryKey: ['farm-calendar', from, 'harvest'], queryFn: () => farm.calendar(from, addDays(from, 13)) })
  const [editVariety, setEditVariety] = useState<Variety | 'new' | null>(null)
  const [cell, setCell] = useState<{ variety: Variety; date: string; h: HarvestCell | null } | null>(null)
  return (
    <>
      <div className="topbar">
        <h1>Harvest stock</h1>
        <span className="spacer" />
        {manager && (
          <button type="button" className="btn btn-primary" onClick={() => setEditVariety('new')}>
            Add variety
          </button>
        )}
      </div>
      <FarmSubnav />
      {!manager && <ManagerOnlyNote what="Changing varieties, prices and harvest stock" />}

      <section className="card">
        <h2>Varieties</h2>
        {varieties.isPending ? (
          <Spinner />
        ) : varieties.isError ? (
          <QueryError error={varieties.error} onRetry={() => varieties.refetch()} />
        ) : !varieties.data.length ? (
          <EmptyState>No varieties yet. Add one with its price per kg before opening bookings.</EmptyState>
        ) : (
          <div {...scrollRegion('Varieties', { cards: true })}>
            <table className="pn-table">
              <thead>
                <tr>
                  <th scope="col">Variety</th>
                  <th scope="col">Price per kg</th>
                  <th scope="col">Tiers</th>
                  <th scope="col">Harvest window</th>
                  <th scope="col">Shown</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {varieties.data.map((v) => (
                  <tr key={v.id}>
                    <td className="card-title">{v.name}</td>
                    <td data-label="Price per kg">{rupees(v.pricePerKg)}</td>
                    <td data-label="Tiers">{v.tiers.length ? v.tiers.map((t) => `${t.minKg} kg+: ${rupees(t.pricePerKg)}`).join(', ') : '—'}</td>
                    <td data-label="Harvest window">{v.harvestFrom && v.harvestTo ? `${date(v.harvestFrom)} to ${date(v.harvestTo)}` : '—'}</td>
                    <td data-label="Shown">{v.active ? <Badge tone="good">Bookable</Badge> : <Badge>Hidden</Badge>}</td>
                    <td className="card-wide">
                      {manager && (
                        <button type="button" className="btn btn-small" onClick={() => setEditVariety(v)}>
                          Edit<span className="sr-only"> {v.name}</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Kg per day</h2>
        <p className="muted small">Each cell: bookable kg, then booked or held. Customers can book only what is left of bookable kg, in one variety per booking, 250 kg or more.</p>
        <div className="farm-actions mb-3">
          <button type="button" className="btn btn-small" onClick={() => setFrom(addDays(from, -14))}>
            Earlier
          </button>
          <span>
            {date(from)} to {date(addDays(from, 13))}
          </span>
          <button type="button" className="btn btn-small" onClick={() => setFrom(addDays(from, 14))}>
            Later
          </button>
        </div>
        {cal.isPending || varieties.isPending ? (
          <Spinner />
        ) : cal.isError ? (
          <QueryError error={cal.error} onRetry={() => cal.refetch()} />
        ) : (
          <div {...scrollRegion('Kg per day')}>
            <table className="pn-table farm-harvest-grid">
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  {(varieties.data ?? []).map((v) => (
                    <th key={v.id} scope="col">
                      {v.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cal.data.days.map((d) => (
                  <tr key={d.date}>
                    <th scope="row">
                      {date(d.date)}
                      {!d.open && <div className="muted small">Closed</div>}
                    </th>
                    {(varieties.data ?? []).map((v) => {
                      const h = d.harvest.find((x) => x.varietyId === v.id) ?? null
                      const label = h ? `${h.bookableKg} bookable · ${h.reservedKg} booked` : 'Not set'
                      return (
                        <td key={v.id}>
                          {manager ? (
                            <button type="button" className="link-btn" onClick={() => setCell({ variety: v, date: d.date, h })}>
                              {label}
                              <span className="sr-only">
                                {' '}
                                for {v.name} on {date(d.date)}
                              </span>
                            </button>
                          ) : (
                            label
                          )}
                          {h && (
                            <div className="muted small">
                              {READINESS[h.readiness as keyof typeof READINESS] ?? h.readiness} · {QC[h.qcStatus as keyof typeof QC] ?? h.qcStatus}
                            </div>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {editVariety && <VarietyDialog v={editVariety === 'new' ? null : editVariety} onClose={() => setEditVariety(null)} />}
      {cell && <HarvestDialog {...cell} onClose={() => setCell(null)} />}
    </>
  )
}

function VarietyDialog({ v, onClose }: { v: Variety | null; onClose: () => void }) {
  const id = useId()
  const toast = useToast()
  const queryClient = useQueryClient()
  const stepUp = useStepUp(MONEY_CHANGE_WHY)
  const [f, setF] = useState({
    name: v?.name ?? '',
    sku: v?.sku ?? '',
    description: v?.description ?? '',
    ripenessNote: v?.ripenessNote ?? '',
    harvestFrom: v?.harvestFrom ?? '',
    harvestTo: v?.harvestTo ?? '',
    price: v ? toRupees(v.pricePerKg) : '',
    tiers: (v?.tiers ?? []).map((t) => ({ minKg: String(t.minKg), price: toRupees(t.pricePerKg) })),
    active: v?.active ?? true,
    sortOrder: String(v?.sortOrder ?? 0),
  })
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }))
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name.trim(),
        sku: f.sku.trim() || null,
        description: f.description.trim(),
        ripenessNote: f.ripenessNote.trim(),
        harvestFrom: f.harvestFrom || null,
        harvestTo: f.harvestTo || null,
        pricePerKg: toPaise(f.price),
        tiers: f.tiers.filter((t) => t.minKg && t.price).map((t) => ({ minKg: Number(t.minKg), pricePerKg: toPaise(t.price) })),
        active: f.active,
        sortOrder: Number(f.sortOrder) || 0,
      }
      return stepUp.run((code) => (v ? farm.patchVariety(v.id, { ...body, version: v.version }, code) : farm.addVariety(body, code)))
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['farm-varieties'] })
      toast.success('Variety saved')
      onClose()
    },
  })
  const field = (key: 'name' | 'sku' | 'ripenessNote', label: string) => (
    <div className="field">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <input id={`${id}-${key}`} type="text" value={f[key]} onChange={(e) => set({ [key]: e.target.value })} />
    </div>
  )
  return (
    <Dialog
      title={v ? `Edit ${v.name}` : 'Add a variety'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={save.isPending || !f.name.trim() || !(Number(f.price) > 0)} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save variety'}
          </button>
        </>
      }
    >
      {field('name', 'Name (as customers see it)')}
      <div className="field">
        <label htmlFor={`${id}-price`}>Price per kg (₹)</label>
        <input id={`${id}-price`} type="number" min={0.01} step={0.01} value={f.price} onChange={(e) => set({ price: e.target.value })} />
        <p className="muted small">Changing a price asks you to confirm it's you. Bookings already made keep their price.</p>
      </div>
      <fieldset className="field">
        <legend>Price tiers (optional): a lower price per kg from a larger amount</legend>
        {f.tiers.map((t, i) => (
          <div key={i} className="field-row">
            <div className="field mb-0">
              <label htmlFor={`${id}-t${i}k`}>From kg</label>
              <input id={`${id}-t${i}k`} type="number" min={250} value={t.minKg} onChange={(e) => set({ tiers: f.tiers.map((x, j) => (j === i ? { ...x, minKg: e.target.value } : x)) })} />
            </div>
            <div className="field mb-0">
              <label htmlFor={`${id}-t${i}p`}>₹ per kg</label>
              <input id={`${id}-t${i}p`} type="number" min={0.01} step={0.01} value={t.price} onChange={(e) => set({ tiers: f.tiers.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)) })} />
            </div>
            <button type="button" className="btn btn-small" onClick={() => set({ tiers: f.tiers.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-small" onClick={() => set({ tiers: [...f.tiers, { minKg: '', price: '' }] })}>
          Add tier
        </button>
      </fieldset>
      <div className="field">
        <label htmlFor={`${id}-desc`}>Description</label>
        <textarea id={`${id}-desc`} rows={3} maxLength={1200} value={f.description} onChange={(e) => set({ description: e.target.value })} />
      </div>
      {field('ripenessNote', 'Ripeness note')}
      {field('sku', 'Shop product SKU for the photo (optional)')}
      <div className="field-row">
        <div className="field">
          <label htmlFor={`${id}-hf`}>Harvest from</label>
          <input id={`${id}-hf`} type="date" value={f.harvestFrom} onChange={(e) => set({ harvestFrom: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-ht`}>Harvest to</label>
          <input id={`${id}-ht`} type="date" value={f.harvestTo} onChange={(e) => set({ harvestTo: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-so`}>Order</label>
          <input id={`${id}-so`} type="number" min={0} value={f.sortOrder} onChange={(e) => set({ sortOrder: e.target.value })} />
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={f.active} onChange={(e) => set({ active: e.target.checked })} /> Customers can book it
      </label>
      <FormError error={save.error} />
      {stepUp.dialog}
    </Dialog>
  )
}

function HarvestDialog({ variety, date: day, h, onClose }: { variety: Variety; date: string; h: HarvestCell | null; onClose: () => void }) {
  const id = useId()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [f, setF] = useState({
    estimatedKg: String(h?.estimatedKg ?? 0),
    bookableKg: String(h?.bookableKg ?? 0),
    confirmedKg: h?.confirmedKg == null ? '' : String(h.confirmedKg),
    readiness: h?.readiness ?? 'NOT_READY',
    qcStatus: h?.qcStatus ?? 'PENDING',
    note: h?.note ?? '',
  })
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }))
  const save = useMutation({
    mutationFn: () =>
      farm.saveHarvest(variety.id, day, {
        estimatedKg: Math.floor(Number(f.estimatedKg) || 0),
        bookableKg: Math.floor(Number(f.bookableKg) || 0),
        confirmedKg: f.confirmedKg === '' ? null : Math.floor(Number(f.confirmedKg)),
        readiness: f.readiness,
        qcStatus: f.qcStatus,
        note: f.note.trim() || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['farm-calendar'] })
      toast.success('Harvest saved')
      onClose()
    },
  })
  const num = (key: 'estimatedKg' | 'bookableKg' | 'confirmedKg', label: string) => (
    <div className="field">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <input id={`${id}-${key}`} type="number" min={0} step={1} value={f[key]} onChange={(e) => set({ [key]: e.target.value })} />
    </div>
  )
  return (
    <Dialog
      title={`${variety.name} on ${date(day)}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      {h && h.reservedKg > 0 && <p>{h.reservedKg} kg is booked or held; bookable kg can't go below that.</p>}
      <div className="field-row">
        {num('estimatedKg', 'Estimated kg')}
        {num('bookableKg', 'Bookable kg (what customers can book)')}
        {num('confirmedKg', 'Confirmed kg (after picking)')}
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor={`${id}-r`}>Readiness</label>
          <select id={`${id}-r`} value={f.readiness} onChange={(e) => set({ readiness: e.target.value })}>
            {Object.entries(READINESS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-q`}>Quality check</label>
          <select id={`${id}-q`} value={f.qcStatus} onChange={(e) => set({ qcStatus: e.target.value })}>
            {Object.entries(QC).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor={`${id}-n`}>Note</label>
        <input id={`${id}-n`} type="text" maxLength={500} value={f.note} onChange={(e) => set({ note: e.target.value })} />
      </div>
      <FormError error={save.error} />
    </Dialog>
  )
}
