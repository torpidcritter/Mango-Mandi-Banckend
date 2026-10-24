// The "Couldn't deliver" report, shared by the Deliveries run and the order page,
// so a missed delivery always carries a reason (and the same API payload).

import { useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from './api'
import { currentPosition, shrinkPhoto } from './photo'
import type { FailReason } from './types'
import { Dialog, FormError, useToast } from './ui'

export const FAIL_OPTIONS: [FailReason, string][] = [
  ['NOT_HOME', 'Customer not home'],
  ['UNREACHABLE', 'Customer did not answer the phone'],
  ['WRONG_ADDRESS', 'Address not found'],
  ['REFUSED', 'Customer refused the order'],
  ['OTHER', 'Something else'],
]

export function PhotoField({ onChange, label }: { onChange: (f: File | null) => void; label: string }) {
  return (
    <div className="field">
      <label htmlFor="dl-photo">{label}</label>
      <input id="dl-photo" type="file" accept="image/*" capture="environment" onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
    </div>
  )
}

export async function uploadPhoto(orderId: string, file: File | null) {
  if (!file) return undefined
  return (await api.uploadDeliveryPhoto(orderId, await shrinkPhoto(file))).id
}

/** The order being reported: the manifest's attempt number goes back when there is one. */
export type MissedOrder = { id: string; number: string; attempt?: number }

export function MissedDialog({ order, onClose, onDone }: { order: MissedOrder; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [reason, setReason] = useState<FailReason | null>(null)
  const [note, setNote] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: async () => {
      const where = { ...((await currentPosition()) ?? {}), ...(order.attempt ? { attempt: order.attempt } : {}) }
      const photoId = await uploadPhoto(order.id, file)
      return api.recordDelivery(order.id, { outcome: 'FAILED', reason: reason!, note: note.trim() || undefined, photoId, ...where })
    },
    onSuccess: () => {
      toast.success(`${order.number} will be tried again on the next delivery day`)
      onDone()
      onClose()
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!reason) return setProblem('Pick what happened.')
    if (reason === 'OTHER' && note.trim().length < 3) return setProblem('Say what happened.')
    setProblem(null)
    save.mutate()
  }

  return (
    <Dialog
      title={`Couldn't deliver ${order.number}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Back
          </button>
          <button type="submit" form="missed-form" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="missed-form" onSubmit={onSubmit} noValidate>
        <p className="mt-0">The order comes back and goes out again on the next delivery day.</p>
        <fieldset>
          <legend>What happened?</legend>
          <div className="option-list">
            {FAIL_OPTIONS.map(([value, label]) => (
              <label key={value} className="option-row">
                <input type="radio" name="reason" checked={reason === value} onChange={() => setReason(value)} />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="field">
          <label htmlFor="dl-note">Note (optional)</label>
          <input id="dl-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
        </div>
        <PhotoField label="Photo (optional)" onChange={setFile} />
        {problem && (
          <p role="alert" className="text-danger">
            {problem}
          </p>
        )}
        <FormError error={save.error} />
      </form>
    </Dialog>
  )
}
