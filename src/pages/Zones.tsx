// Zones for Neighborhood Unlock: a name customers see ("Indiranagar") over a
// group of pincodes. A pincode is in at most one zone; one with no zone is its
// own area. Separate from the Pincodes page's "zone" label, which only groups
// stops on the rider run.
import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import type { Zone } from '../types'
import { Badge, Dialog, EmptyState, FormError, QueryError, Spinner, useToast, scrollRegion } from '../ui'

const parsePins = (s: string) => Array.from(new Set(s.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean)))

export default function Zones() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const q = useQuery({ queryKey: ['zones'], queryFn: api.zones })
  const pins = useQuery({ queryKey: ['pincodes'], queryFn: api.pincodes })
  const [editing, setEditing] = useState<Zone | 'new' | null>(null)
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['zones'] })

  const toggle = useMutation({
    mutationFn: (z: Zone) => api.updateZone(z.id, { active: !z.active }),
    onSuccess: (z) => {
      toast.success(`${z.label} is ${z.active ? 'on' : 'off'}`)
      refresh()
    },
    onError: (err) => toast.error(err),
  })

  const zoned = new Set((q.data ?? []).flatMap((z) => z.pincodes))
  const unzoned = (pins.data ?? []).filter((p) => p.active && !zoned.has(p.pincode)).map((p) => p.pincode)

  return (
    <>
      <div className="topbar">
        <h1>Zones</h1>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
          New zone
        </button>
      </div>
      <section className="card">
        {q.isPending ? (
          <Spinner />
        ) : q.isError ? (
          <QueryError error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data.length ? (
          <EmptyState>No zones yet. Group neighbouring pincodes so their customers can unlock a reward together.</EmptyState>
        ) : (
          <div {...scrollRegion('Zones')}>
            <table>
              <thead>
                <tr>
                  <th>Zone</th>
                  <th>Pincodes</th>
                  <th>Live campaigns</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {q.data.map((z) => (
                  <tr key={z.id}>
                    <td>
                      <strong>{z.label}</strong>
                    </td>
                    <td className="small">{z.pincodes.length ? z.pincodes.join(', ') : '—'}</td>
                    <td>{z.liveCampaigns}</td>
                    <td>{z.active ? <Badge tone="good">On</Badge> : <Badge>Off</Badge>}</td>
                    <td className="actions">
                      {z.active && (
                        <button type="button" className="btn btn-small" onClick={() => setEditing(z)}>
                          Edit<span className="sr-only"> {z.label}</span>
                        </button>
                      )}{' '}
                      <button type="button" className="btn btn-small" disabled={toggle.isPending} onClick={() => toggle.mutate(z)}>
                        {z.active ? 'Turn off' : 'Turn on'}
                        <span className="sr-only"> {z.label}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted">
          Pincodes with no zone count as their own area{unzoned.length ? `: ${unzoned.join(', ')}` : ''}. Turning a zone off releases its pincodes.
        </p>
      </section>
      {editing && <ZoneDialog zone={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={refresh} />}
    </>
  )
}

function ZoneDialog({ zone, onClose, onDone }: { zone: Zone | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [label, setLabel] = useState(zone?.label ?? '')
  const [pincodes, setPincodes] = useState((zone?.pincodes ?? []).join(', '))
  const [formError, setFormError] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: async () => {
      const list = parsePins(pincodes)
      if (!zone) return api.addZone({ label: label.trim(), pincodes: list })
      if (label.trim() !== zone.label) await api.updateZone(zone.id, { label: label.trim() })
      return api.setZonePincodes(zone.id, list)
    },
    onSuccess: (z) => {
      toast.success(`${z.label} saved`)
      onDone()
      onClose()
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (label.trim().length < 2) return setFormError('Give the zone a name customers will recognise.')
    const bad = parsePins(pincodes).filter((p) => !/^\d{6}$/.test(p))
    if (bad.length) return setFormError(`Not a 6-digit pincode: ${bad.join(', ')}`)
    save.mutate()
  }

  return (
    <Dialog
      title={zone ? `Edit ${zone.label}` : 'New zone'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="zone-form" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save zone'}
          </button>
        </>
      }
    >
      <form id="zone-form" onSubmit={onSubmit} noValidate>
        {zone && zone.liveCampaigns > 0 && (
          <p className="notice" role="status">
            This zone has {zone.liveCampaigns === 1 ? 'a live campaign' : `${zone.liveCampaigns} live campaigns`}. Changing its pincodes changes the count customers see at once.
          </p>
        )}
        <div className="field">
          <label htmlFor="zone-label">Zone name</label>
          <input id="zone-label" maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
          <p className="hint">Customers see this, like "Indiranagar".</p>
        </div>
        <div className="field">
          <label htmlFor="zone-pins">Pincodes</label>
          <textarea id="zone-pins" rows={3} value={pincodes} onChange={(e) => setPincodes(e.target.value)} />
          <p className="hint">Separate with commas or spaces. Each pincode can be in one zone only.</p>
        </div>
        <FormError error={formError ?? save.error} />
      </form>
    </Dialog>
  )
}
