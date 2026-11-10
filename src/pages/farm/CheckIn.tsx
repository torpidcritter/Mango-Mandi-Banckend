// Farm check-in (docs/farm-experience.md): scan the customer's QR with a phone scanner app (it
// types "MMF:<code>"), or type the 12-character code or the MMF- number. The booking shows;
// check-in works on the stay's days (a manager can check in outside them).
import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { date } from '../../format'
import { FormError, usePageTitle, useToast } from '../../ui'
import { farm, type Booking } from './api'
import { FarmBadge, FarmSubnav, useIsManager } from './shared'

export default function FarmCheckIn() {
  usePageTitle('Farm check-in')
  const id = useId()
  const manager = useIsManager()
  const toast = useToast()
  const [code, setCode] = useState('')
  const [found, setFound] = useState<Booking | null>(null)
  const find = useMutation({ mutationFn: () => farm.findByCode(code.trim()), onSuccess: setFound })
  const checkIn = useMutation({
    mutationFn: (override: boolean) => farm.checkIn(found?.checkinCode ?? code.trim(), override),
    onSuccess: (b) => {
      setFound(b)
      toast.success(`${b.number} checked in`)
    },
  })
  const canCheckIn = found && ['CONFIRMED', 'PREPARING', 'READY_FOR_VISIT'].includes(found.status)
  return (
    <>
      <div className="topbar">
        <h1>Farm check-in</h1>
      </div>
      <FarmSubnav />
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault()
          setFound(null)
          if (code.trim()) find.mutate()
        }}
      >
        <div className="field">
          <label htmlFor={`${id}-code`}>Check-in code, QR text or booking number</label>
          <input id={`${id}-code`} type="text" autoComplete="off" autoCapitalize="characters" value={code} onChange={(e) => setCode(e.target.value)} data-autofocus />
        </div>
        <button type="submit" className="btn btn-primary" disabled={find.isPending || !code.trim()}>
          {find.isPending ? 'Looking…' : 'Find booking'}
        </button>
        <FormError error={find.error} />
      </form>
      {found && (
        <section className="card">
          <h2>
            <Link to={`/farm/bookings/${encodeURIComponent(found.id)}`} className="mono">
              {found.number}
            </Link>{' '}
            <FarmBadge status={found.status} />
          </h2>
          <p>
            {found.contact.name} · {found.guests.adults} adults, {found.guests.children} children · {found.kg} kg {found.variety.name}
          </p>
          <p>
            Visit {date(found.visitDate)}, stay {date(found.guests.arrivalDate)} to {date(found.guests.departureDate)}
          </p>
          {found.hospitality.rooms.length > 0 && <p>Rooms: {found.hospitality.rooms.map((r) => r.name).join(', ')}</p>}
          {canCheckIn ? (
            <div className="farm-actions">
              <button type="button" className="btn btn-primary" disabled={checkIn.isPending} onClick={() => checkIn.mutate(false)}>
                Check in
              </button>
              {manager && (
                <button type="button" className="btn" disabled={checkIn.isPending} onClick={() => checkIn.mutate(true)}>
                  Check in outside the stay dates
                </button>
              )}
            </div>
          ) : (
            <p className="muted">This booking can't be checked in now ({found.statusLabel.toLowerCase()}).</p>
          )}
          <FormError error={checkIn.error} />
        </section>
      )}
    </>
  )
}
