// Accommodation (docs/farm-experience.md): the farmhouse rooms, how many each sleeps, extra
// beds, and rooms out of use for maintenance. Bookings get rooms on their own page; there is
// no guest limit here: a group larger than the rooms is planned with the customer.
import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge, Dialog, EmptyState, FormError, ManagerOnlyNote, QueryError, Spinner, scrollRegion, usePageTitle, useToast } from '../../ui'
import { farm, type Room } from './api'
import { FarmSubnav, useIsManager } from './shared'

export default function FarmRooms() {
  usePageTitle('Farmhouse rooms')
  const manager = useIsManager()
  const q = useQuery({ queryKey: ['farm-rooms'], queryFn: farm.roomList })
  const [edit, setEdit] = useState<Room | 'new' | null>(null)
  const inUse = (q.data ?? []).filter((r) => r.active && !r.maintenance)
  return (
    <>
      <div className="topbar">
        <h1>Farmhouse rooms</h1>
        <span className="spacer" />
        {manager && (
          <button type="button" className="btn btn-primary" onClick={() => setEdit('new')}>
            Add room
          </button>
        )}
      </div>
      <FarmSubnav />
      {!manager && <ManagerOnlyNote what="Adding and changing rooms" />}
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data.length ? (
        <EmptyState>No rooms yet. Add the farmhouse rooms before opening bookings.</EmptyState>
      ) : (
        <>
          <p className="muted">
            {inUse.length} rooms in use, sleeping {inUse.reduce((s, r) => s + r.sleeps, 0)} plus {inUse.reduce((s, r) => s + r.extraBeds, 0)} extra beds.
          </p>
          <div {...scrollRegion('Rooms', { cards: true })}>
            <table className="pn-table">
              <thead>
                <tr>
                  <th scope="col">Room</th>
                  <th scope="col">Sleeps</th>
                  <th scope="col">Beds</th>
                  <th scope="col">Extra beds</th>
                  <th scope="col">State</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {q.data.map((r) => (
                  <tr key={r.id}>
                    <td className="card-title">
                      {r.name}
                      {r.description && <div className="muted small">{r.description}</div>}
                    </td>
                    <td data-label="Sleeps">{r.sleeps}</td>
                    <td data-label="Beds">{r.beds}</td>
                    <td data-label="Extra beds">{r.extraBeds}</td>
                    <td data-label="State">
                      {!r.active ? <Badge>Removed</Badge> : r.maintenance ? <Badge tone="warn">Maintenance</Badge> : <Badge tone="good">In use</Badge>}
                      {r.note && <div className="muted small">{r.note}</div>}
                    </td>
                    <td className="card-wide">
                      {manager && (
                        <button type="button" className="btn btn-small" onClick={() => setEdit(r)}>
                          Edit<span className="sr-only"> {r.name}</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {edit && <RoomDialog r={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  )
}

function RoomDialog({ r, onClose }: { r: Room | null; onClose: () => void }) {
  const id = useId()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [f, setF] = useState({
    name: r?.name ?? '',
    description: r?.description ?? '',
    sleeps: String(r?.sleeps ?? 2),
    beds: String(r?.beds ?? 1),
    extraBeds: String(r?.extraBeds ?? 0),
    active: r?.active ?? true,
    maintenance: r?.maintenance ?? false,
    note: r?.note ?? '',
    sortOrder: String(r?.sortOrder ?? 0),
  })
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }))
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name.trim(),
        description: f.description.trim(),
        sleeps: Number(f.sleeps) || 0,
        beds: Number(f.beds) || 0,
        extraBeds: Number(f.extraBeds) || 0,
        active: f.active,
        maintenance: f.maintenance,
        note: f.note.trim() || null,
        sortOrder: Number(f.sortOrder) || 0,
      }
      return r ? farm.patchRoom(r.id, body) : farm.addRoom(body)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['farm-rooms'] })
      toast.success('Room saved')
      onClose()
    },
  })
  const num = (key: 'sleeps' | 'beds' | 'extraBeds' | 'sortOrder', label: string) => (
    <div className="field">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <input id={`${id}-${key}`} type="number" min={0} value={f[key]} onChange={(e) => set({ [key]: e.target.value })} />
    </div>
  )
  return (
    <Dialog
      title={r ? `Edit ${r.name}` : 'Add a room'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={save.isPending || !f.name.trim()} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save room'}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor={`${id}-name`}>Name</label>
        <input id={`${id}-name`} type="text" maxLength={80} value={f.name} onChange={(e) => set({ name: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-desc`}>Description</label>
        <input id={`${id}-desc`} type="text" maxLength={800} value={f.description} onChange={(e) => set({ description: e.target.value })} />
      </div>
      <div className="field-row">
        {num('sleeps', 'Sleeps')}
        {num('beds', 'Beds')}
        {num('extraBeds', 'Extra beds possible')}
        {num('sortOrder', 'Order')}
      </div>
      <label className="check">
        <input type="checkbox" checked={f.maintenance} onChange={(e) => set({ maintenance: e.target.checked })} /> Under maintenance (not given to bookings)
      </label>
      <label className="check">
        <input type="checkbox" checked={f.active} onChange={(e) => set({ active: e.target.checked })} /> In the farmhouse (untick to remove)
      </label>
      <div className="field">
        <label htmlFor={`${id}-note`}>Note</label>
        <input id={`${id}-note`} type="text" maxLength={500} value={f.note} onChange={(e) => set({ note: e.target.value })} />
      </div>
      <FormError error={save.error} />
    </Dialog>
  )
}
