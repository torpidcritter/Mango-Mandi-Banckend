// Neighborhood Unlock campaigns: customers in one zone, ordering for one
// delivery date, unlock a reward together when enough of them order by the
// order-by time. A bonus only: delivery happens either way. Counts here are
// the same real count customers see, read from orders.
import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { date, dateTime, rupees, type Tone } from '../format'
import { can } from '../permissions'
import { useSession } from '../session'
import type { Campaign, CampaignStatus, NewCampaign, Zone } from '../types'
import { Badge, Dialog, EmptyState, FormError, GatedButton, QueryError, Spinner, useToast, scrollRegion } from '../ui'

const STATUS_LABEL: Record<CampaignStatus, string> = { DRAFT: 'Draft', OPEN: 'Open', UNLOCKED: 'Unlocked', MISSED: 'Missed', CANCELLED: 'Cancelled' }
const STATUS_TONE: Record<CampaignStatus, Tone> = { DRAFT: 'neutral', OPEN: 'info', UNLOCKED: 'good', MISSED: 'warn', CANCELLED: 'neutral' }
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export default function Campaigns() {
  const { me } = useSession()
  const toast = useToast()
  const queryClient = useQueryClient()
  const q = useQuery({ queryKey: ['campaigns'], queryFn: () => api.campaigns() })
  const zones = useQuery({ queryKey: ['zones'], queryFn: api.zones })
  const [adding, setAdding] = useState(false)
  const [viewing, setViewing] = useState<Campaign | null>(null)
  const [cancelling, setCancelling] = useState<Campaign | null>(null)
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['campaigns'] })

  const open = useMutation({
    mutationFn: (c: Campaign) => api.openCampaign(c.id),
    onSuccess: (c) => {
      toast.success(`${c.zoneLabel} for ${date(c.deliveryDate)} is open`)
      refresh()
    },
    onError: (err) => toast.error(err),
  })
  const flip = useMutation({
    mutationFn: (enabled: boolean) => api.saveUnlockSettings({ enabled }),
    onSuccess: (s) => {
      toast.success(s.enabled ? 'Customers can now see campaigns' : 'Campaigns are hidden from customers')
      refresh()
    },
    onError: (err) => toast.error(err),
  })

  const enabled = q.data?.enabled ?? false

  return (
    <>
      <div className="topbar">
        <h1>Neighborhood Unlock</h1>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
          New campaign
        </button>
      </div>

      {q.data && (
        <div className={`banner ${enabled ? '' : 'banner-warn'}`} role="status">
          <span>{enabled ? 'Customers can see open campaigns.' : 'The feature is off: customers see no campaigns. You can still set them up.'}</span>{' '}
          <GatedButton allowed={can(me?.role, 'unlockSwitch')} className="btn btn-small" disabled={flip.isPending} onClick={() => flip.mutate(!enabled)}>
            {enabled ? 'Hide from customers' : 'Show to customers'}
          </GatedButton>
        </div>
      )}

      <section className="card">
        <h2>Campaigns</h2>
        {q.isPending ? (
          <Spinner />
        ) : q.isError ? (
          <QueryError error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data.campaigns.length ? (
          <EmptyState>No campaigns yet. Make zones first, then a campaign for a delivery day.</EmptyState>
        ) : (
          <div {...scrollRegion('Campaigns')}>
            <table>
              <thead>
                <tr>
                  <th>Area</th>
                  <th>Delivery</th>
                  <th>Customers</th>
                  <th>Order by</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {q.data.campaigns.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.zoneLabel}</strong>
                      {c.minOrderValue > 0 && <div className="small muted">orders of {rupees(c.minOrderValue)} or more</div>}
                    </td>
                    <td>
                      {date(c.deliveryDate)}
                      {c.slotLabel && <div className="small muted">{c.slotLabel}</div>}
                    </td>
                    <td>
                      {c.current ?? '—'} of {c.threshold}
                    </td>
                    <td className="small">{dateTime(c.orderBy)}</td>
                    <td>
                      <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
                      {c.note && <div className="small muted">{c.note}</div>}
                    </td>
                    <td className="actions">
                      <button type="button" className="btn btn-small" onClick={() => setViewing(c)}>
                        Details<span className="sr-only"> {c.zoneLabel} {c.deliveryDate}</span>
                      </button>{' '}
                      {c.status === 'DRAFT' && (
                        <button type="button" className="btn btn-small" disabled={open.isPending} onClick={() => open.mutate(c)}>
                          Open<span className="sr-only"> {c.zoneLabel} {c.deliveryDate}</span>
                        </button>
                      )}{' '}
                      {(c.status === 'DRAFT' || c.status === 'OPEN') && (
                        <button type="button" className="btn btn-small" onClick={() => setCancelling(c)}>
                          Cancel<span className="sr-only"> {c.zoneLabel} {c.deliveryDate}</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted">
          A customer counts once, with a paid order that isn't cancelled, placed by the order-by time. The result is set a few minutes after that time, once
          late payments have settled.
        </p>
      </section>

      <Templates zones={zones.data ?? []} />

      {adding && <AddCampaign zones={zones.data ?? []} onClose={() => setAdding(false)} onDone={refresh} />}
      {viewing && <CampaignDetails campaign={viewing} onClose={() => setViewing(null)} />}
      {cancelling && <CancelCampaign campaign={cancelling} onClose={() => setCancelling(null)} onDone={refresh} />}
    </>
  )
}

/** "2026-10-15T18:00" typed as IST → an ISO instant. */
const istInstant = (local: string) => (local ? new Date(`${local}:00+05:30`).toISOString() : null)

function AddCampaign({ zones, onClose, onDone }: { zones: Zone[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const pins = useQuery({ queryKey: ['pincodes'], queryFn: api.pincodes })
  const slots = useQuery({ queryKey: ['slots'], queryFn: api.slots })
  const zoned = useMemo(() => new Set(zones.flatMap((z) => z.pincodes)), [zones])
  const areas = [
    ...zones.filter((z) => z.active).map((z) => ({ value: `zone:${z.id}`, label: z.label })),
    ...(pins.data ?? []).filter((p) => p.active && !zoned.has(p.pincode)).map((p) => ({ value: `pin:${p.pincode}`, label: `Pincode ${p.pincode} (no zone)` })),
  ]
  const [f, setF] = useState({ area: '', deliveryDate: '', slotId: '', threshold: '10', minOrder: '', orderBy: '' })
  const [formError, setFormError] = useState<string | null>(null)
  const add = useMutation({
    mutationFn: (c: NewCampaign) => api.addCampaign(c),
    onSuccess: (c) => {
      toast.success(`Draft made for ${c.zoneLabel}. Open it when you're ready.`)
      onDone()
      onClose()
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!f.area) return setFormError('Choose a zone or pincode.')
    if (!f.deliveryDate) return setFormError('Choose the delivery date.')
    const threshold = Number(f.threshold)
    if (!Number.isInteger(threshold) || threshold < 2) return setFormError('The target is a whole number of customers, at least 2.')
    const min = f.minOrder.trim() ? Math.round(Number(f.minOrder) * 100) : 0
    if (!(min >= 0)) return setFormError('The smallest order must be a number of rupees.')
    const [kind, idOrPin] = [f.area.slice(0, f.area.indexOf(':')), f.area.slice(f.area.indexOf(':') + 1)]
    add.mutate({
      ...(kind === 'zone' ? { zoneId: idOrPin } : { pincode: idOrPin }),
      deliveryDate: f.deliveryDate,
      slotId: f.slotId || null,
      threshold,
      minOrderValue: min,
      orderBy: istInstant(f.orderBy),
    })
  }

  return (
    <Dialog
      title="New campaign"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="campaign-form" className="btn btn-primary" disabled={add.isPending}>
            {add.isPending ? 'Saving…' : 'Save draft'}
          </button>
        </>
      }
    >
      <form id="campaign-form" onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor="cmp-area">Area</label>
          <select id="cmp-area" value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })}>
            <option value="">Choose…</option>
            {areas.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cmp-date">Delivery date</label>
          <input id="cmp-date" type="date" value={f.deliveryDate} onChange={(e) => setF({ ...f, deliveryDate: e.target.value })} />
        </div>
        {!!slots.data?.filter((s) => s.active).length && (
          <div className="field">
            <label htmlFor="cmp-slot">Slot (optional)</label>
            <select id="cmp-slot" value={f.slotId} onChange={(e) => setF({ ...f, slotId: e.target.value })}>
              <option value="">The whole day</option>
              {slots.data
                .filter((s) => s.active)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="cmp-threshold">Customers needed</label>
          <input id="cmp-threshold" inputMode="numeric" value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="cmp-min">Smallest order that counts, in rupees (optional)</label>
          <input id="cmp-min" inputMode="decimal" value={f.minOrder} onChange={(e) => setF({ ...f, minOrder: e.target.value })} />
          <p className="hint">Compared with what the customer paid, after any promo code.</p>
        </div>
        <div className="field">
          <label htmlFor="cmp-orderby">Order by, IST (optional)</label>
          <input id="cmp-orderby" type="datetime-local" value={f.orderBy} onChange={(e) => setF({ ...f, orderBy: e.target.value })} />
          <p className="hint">Leave empty for the usual order cutoff the day before delivery. It can be earlier, not later.</p>
        </div>
        <FormError error={formError ?? add.error} />
      </form>
    </Dialog>
  )
}

function CampaignDetails({ campaign, onClose }: { campaign: Campaign; onClose: () => void }) {
  const q = useQuery({ queryKey: ['campaign', campaign.id], queryFn: () => api.campaign(campaign.id) })
  const d = q.data
  return (
    <Dialog
      title={`${campaign.zoneLabel} · ${date(campaign.deliveryDate)}`}
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : d ? (
        <>
          <p>
            <strong>
              {d.current ?? '—'} of {d.threshold} customers
            </strong>{' '}
            · <Badge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Badge>
            {d.status !== 'DRAFT' && d.status !== 'OPEN' && d.status !== 'CANCELLED' && <span className="small muted"> · {d.snapshotCount} recorded at the result</span>}
          </p>
          <h3>Forecast (an estimate)</h3>
          <ul className="small">
            {d.forecast.projected != null && <li>On the pace since it opened: about {d.forecast.projected} by the order-by time.</li>}
            <li>
              The same day of the week before: {d.forecast.recentSameWeekday.map((r) => `${date(r.date)}: ${r.customers}`).join(' · ')} (average {d.forecast.recentAverage}).
            </li>
          </ul>
          <h3>Worth a look</h3>
          {d.clusters.length ? (
            <ul className="small" aria-label="Suspicious clusters">
              {d.clusters.map((c, i) => (
                <li key={i}>
                  {c.kind === 'SAME_ADDRESS' ? `${c.customers} customers at one address` : `${c.customers} accounts with one phone`}, {c.orders} orders within {c.withinMinutes}{' '}
                  minutes: {c.orderNumbers.join(', ')}
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">No clusters of orders from one address or phone.</p>
          )}
          <h3>History</h3>
          <ul className="small">
            {d.events.map((e, i) => (
              <li key={i}>
                {dateTime(e.at)}: {e.from ? `${STATUS_LABEL[e.from]} → ` : ''}
                {STATUS_LABEL[e.to]} by {e.actor}
                {e.counted != null ? ` (${e.counted} counted)` : ''}
                {e.note ? `. ${e.note}` : ''}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Dialog>
  )
}

function CancelCampaign({ campaign, onClose, onDone }: { campaign: Campaign; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [note, setNote] = useState('')
  const cancel = useMutation({
    mutationFn: () => api.cancelCampaign(campaign.id, note.trim() || undefined),
    onSuccess: () => {
      toast.success('Campaign cancelled')
      onDone()
      onClose()
    },
  })
  return (
    <Dialog
      title="Cancel this campaign?"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Keep it
          </button>
          <button type="button" className="btn btn-danger" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel campaign
          </button>
        </>
      }
    >
      <p>
        {campaign.zoneLabel} for {date(campaign.deliveryDate)}. Customers stop seeing it. Deliveries are not affected.
      </p>
      <div className="field">
        <label htmlFor="cancel-note">Reason (optional)</label>
        <input id="cancel-note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <FormError error={cancel.error} />
    </Dialog>
  )
}

function Templates({ zones }: { zones: Zone[] }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const q = useQuery({ queryKey: ['unlockTemplates'], queryFn: api.unlockTemplates })
  const [adding, setAdding] = useState(false)
  const label = (id: string) => zones.find((z) => z.id === id)?.label ?? id
  const toggle = useMutation({
    mutationFn: (t: { id: string; active: boolean }) => api.updateUnlockTemplate(t.id, { active: !t.active }),
    onSuccess: (t) => {
      toast.success(t.active ? 'Weekly repeat on' : 'Weekly repeat off')
      void queryClient.invalidateQueries({ queryKey: ['unlockTemplates'] })
    },
    onError: (err) => toast.error(err),
  })
  return (
    <section className="card">
      <div className="topbar">
        <h2>Weekly repeats</h2>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          New weekly repeat
        </button>
      </div>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data.length ? (
        <EmptyState>None yet. A weekly repeat makes the campaign for each matching day once it opens for booking.</EmptyState>
      ) : (
        <ul className="plain-list">
          {q.data.map((t) => (
            <li key={t.id}>
              Every {WEEKDAYS[t.weekday]} for {t.zoneIds.map(label).join(', ')}: {t.threshold} customers
              {t.minOrderValue ? `, orders of ${rupees(t.minOrderValue)} or more` : ''}
              {t.autoOpen ? ', opened automatically' : ', as drafts'}
              {!t.active && ' (off)'}{' '}
              <button type="button" className="btn btn-small" disabled={toggle.isPending} onClick={() => toggle.mutate(t)}>
                {t.active ? 'Turn off' : 'Turn on'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding && <AddTemplate zones={zones} onClose={() => setAdding(false)} onDone={() => void queryClient.invalidateQueries({ queryKey: ['unlockTemplates'] })} />}
    </section>
  )
}

function AddTemplate({ zones, onClose, onDone }: { zones: Zone[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [picked, setPicked] = useState<string[]>([])
  const [weekday, setWeekday] = useState('6')
  const [threshold, setThreshold] = useState('10')
  const [minOrder, setMinOrder] = useState('')
  const [autoOpen, setAutoOpen] = useState(true)
  const [formError, setFormError] = useState<string | null>(null)
  const add = useMutation({
    mutationFn: () =>
      api.addUnlockTemplate({ zoneIds: picked, weekday: Number(weekday), threshold: Number(threshold), minOrderValue: minOrder.trim() ? Math.round(Number(minOrder) * 100) : 0, autoOpen }),
    onSuccess: () => {
      toast.success('Weekly repeat saved')
      onDone()
      onClose()
    },
  })
  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!picked.length) return setFormError('Choose at least one zone.')
    if (!(Number.isInteger(Number(threshold)) && Number(threshold) >= 2)) return setFormError('The target is a whole number of customers, at least 2.')
    add.mutate()
  }
  return (
    <Dialog
      title="New weekly repeat"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="template-form" className="btn btn-primary" disabled={add.isPending}>
            Save
          </button>
        </>
      }
    >
      <form id="template-form" onSubmit={onSubmit} noValidate>
        <fieldset className="field">
          <legend>Zones</legend>
          {zones
            .filter((z) => z.active)
            .map((z) => (
              <label key={z.id} className="check-row">
                <input type="checkbox" checked={picked.includes(z.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, z.id] : picked.filter((x) => x !== z.id))} />{' '}
                {z.label}
              </label>
            ))}
        </fieldset>
        <div className="field">
          <label htmlFor="tpl-day">Delivery day</label>
          <select id="tpl-day" value={weekday} onChange={(e) => setWeekday(e.target.value)}>
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="tpl-threshold">Customers needed</label>
          <input id="tpl-threshold" inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="tpl-min">Smallest order that counts, in rupees (optional)</label>
          <input id="tpl-min" inputMode="decimal" value={minOrder} onChange={(e) => setMinOrder(e.target.value)} />
        </div>
        <div className="field radio-row">
          <label>
            <input type="checkbox" checked={autoOpen} onChange={(e) => setAutoOpen(e.target.checked)} /> Open each campaign automatically
          </label>
        </div>
        <FormError error={formError ?? add.error} />
      </form>
    </Dialog>
  )
}
