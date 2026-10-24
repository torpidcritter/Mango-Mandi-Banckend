import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { can } from '../permissions'
import { useSession } from '../session'
import type { Pincode } from '../types'
import { Badge, ConfirmDialog, Dialog, EmptyState, FormError, GatedButton, ManagerOnlyNote, QueryError, Spinner, useToast, scrollRegion, usePageTitle } from '../ui'

export default function Pincodes() {
  usePageTitle('Pincodes')
  const { me } = useSession()
  const toast = useToast()
  const queryClient = useQueryClient()
  const q = useQuery({ queryKey: ['pincodes'], queryFn: api.pincodes })
  const [adding, setAdding] = useState(false)
  const [deactivating, setDeactivating] = useState<Pincode | null>(null)
  const [deleting, setDeleting] = useState<Pincode | null>(null)

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['pincodes'] })

  const toggle = useMutation({
    mutationFn: (p: { pincode: string; active: boolean }) => api.updatePincode(p.pincode, { active: p.active }),
    onSuccess: (_r, p) => {
      toast.success(`${p.pincode} ${p.active ? 'activated' : 'deactivated'}`)
      setDeactivating(null)
      refresh()
    },
    onError: (err) => toast.error(err),
  })
  const remove = useMutation({
    mutationFn: (pincode: string) => api.deletePincode(pincode),
    onSuccess: (_r, pincode) => {
      toast.success(`${pincode} deleted`)
      setDeleting(null)
      refresh()
    },
  })

  const canDelete = can(me?.role, 'deletePincode')

  return (
    <>
      <div className="topbar">
        <h1>Pincodes</h1>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
          Add pincode
        </button>
      </div>

      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState>No delivery areas yet. Add a pincode to start taking orders there.</EmptyState>
      ) : (
        <div {...scrollRegion('Pincodes')}>
          <table>
            <thead>
              <tr>
                <th>Pincode</th>
                <th>City</th>
                <th>Zone</th>
                <th>Status</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((p) => (
                <tr key={p.pincode}>
                  <td>
                    <strong>{p.pincode}</strong>
                  </td>
                  <td>{p.city}</td>
                  <td>{p.zone ?? '—'}</td>
                  <td>
                    <Badge tone={p.active ? 'good' : 'neutral'}>{p.active ? 'Active' : 'Inactive'}</Badge>
                  </td>
                  <td>
                    <div className="btn-row">
                      {p.active ? (
                        <button type="button" className="btn btn-small" onClick={() => setDeactivating(p)}>
                          Deactivate<span className="sr-only"> {p.pincode}</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={toggle.isPending}
                          onClick={() => toggle.mutate({ pincode: p.pincode, active: true })}
                        >
                          Activate<span className="sr-only"> {p.pincode}</span>
                        </button>
                      )}
                      <GatedButton allowed={canDelete} className="btn btn-small btn-danger" onClick={() => setDeleting(p)}>
                        Delete<span className="sr-only"> {p.pincode}</span>
                      </GatedButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!canDelete && q.data && q.data.length > 0 && <ManagerOnlyNote what="Deleting a pincode" />}

      {adding && <AddDialog onClose={() => setAdding(false)} onDone={refresh} />}

      {deactivating && (
        <ConfirmDialog
          title={`Deactivate ${deactivating.pincode}?`}
          tone="danger"
          confirmLabel="Deactivate"
          cancelLabel="Keep active"
          busy={toggle.isPending}
          onClose={() => setDeactivating(null)}
          onConfirm={() => toggle.mutate({ pincode: deactivating.pincode, active: false })}
        >
          <p>
            Customers in {deactivating.city} ({deactivating.pincode}) will no longer be able to order. You can activate it
            again at any time.
          </p>
        </ConfirmDialog>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.pincode}?`}
          tone="danger"
          confirmLabel="Delete pincode"
          busy={remove.isPending}
          error={remove.error}
          onClose={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.pincode)}
        >
          <p>
            This removes {deleting.pincode} ({deleting.city}) entirely. If you only want to stop orders there,{' '}
            <strong>deactivate</strong> it instead.
          </p>
        </ConfirmDialog>
      )}
    </>
  )
}

function AddDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [pincode, setPincode] = useState('')
  const [city, setCity] = useState('')
  const [zone, setZone] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const add = useMutation({
    mutationFn: () => api.addPincode({ pincode, city: city.trim(), zone: zone.trim() || undefined }),
    onSuccess: () => {
      toast.success(`${pincode} saved`)
      onDone()
      onClose()
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!/^\d{6}$/.test(pincode)) return setFormError('Pincode must be exactly 6 digits.')
    if (!city.trim()) return setFormError('City is required.')
    add.mutate()
  }

  return (
    <Dialog
      title="Add pincode"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="pin-form" className="btn btn-primary" disabled={add.isPending}>
            {add.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="pin-form" onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor="pin-code">Pincode</label>
          <input
            id="pin-code"
            inputMode="numeric"
            maxLength={6}
            value={pincode}
            onChange={(e) => setPincode(e.target.value.replace(/\D/g, ''))}
          />
          <p className="hint">Adding an existing pincode updates it.</p>
        </div>
        <div className="field">
          <label htmlFor="pin-city">City</label>
          <input id="pin-city" value={city} onChange={(e) => setCity(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pin-zone">Zone (optional)</label>
          <input id="pin-zone" value={zone} onChange={(e) => setZone(e.target.value)} />
        </div>
        <FormError error={formError ?? add.error} />
      </form>
    </Dialog>
  )
}
