// Farm Experience reports (docs/farm-experience.md), managers only: bookings by visit date,
// kg, revenue from bills paid, groups, cancellations, refunds, extra kg, varieties and how full the farm was;
// and the bookings as CSV. Every figure comes from the API.
import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { istDate, rupees } from '../../format'
import { DownloadButton, QueryError, Spinner, scrollRegion, usePageTitle } from '../../ui'
import { farm } from './api'
import { FarmSubnav } from './shared'

const pct = (n: number | null) => (n == null ? '—' : `${Math.round(n * 100)}%`)

export default function FarmReports() {
  usePageTitle('Farm Experience reports')
  const id = useId()
  const [from, setFrom] = useState(`${istDate().slice(0, 4)}-01-01`)
  const [to, setTo] = useState(`${istDate().slice(0, 4)}-12-31`)
  const [varietyId, setVarietyId] = useState('')
  const varieties = useQuery({ queryKey: ['farm-varieties'], queryFn: farm.varieties })
  const range = { from, to, ...(varietyId && { varietyId }) }
  const q = useQuery({ queryKey: ['farm-report', range], queryFn: () => farm.report(range), enabled: from <= to })
  const r = q.data
  const tiles: [string, string][] = r
    ? [
        ['Paid bookings', String(r.bookings)],
        ['Kg booked', String(r.kgBooked)],
        ['Kg harvested', String(r.kgHarvested)],
        ['Revenue (bills paid)', `${rupees(r.revenue)} (${r.paidBookings} paid)`],
        ['Of which extra kg', `${rupees(r.extras.revenue)} (${r.extras.kg} kg)`],
        ['Refunds', `${rupees(r.refunds.value)} (${r.refunds.count})`],
        ['Average kg', String(r.avgKg)],
        ['Guests hosted', String(r.guestsHosted)],
        ['Average group', String(r.avgGroup)],
        ['Completed', String(r.completed)],
        ['Cancelled', `${r.cancelled} (${pct(r.cancellationRate)})`],
        ['No-shows', String(r.noShows)],
        ['Booked → paid', `${r.conversion.paid} of ${r.conversion.started} (${pct(r.conversion.rate)})`],
        ['Visit slots used', pct(r.utilisation.visitRate)],
        ['Room nights used', `${r.utilisation.roomNights} of ${r.utilisation.roomNightsAvailable} (${pct(r.utilisation.roomRate)})`],
        ['Guest nights', String(r.utilisation.guestNights)],
      ]
    : []
  return (
    <>
      <div className="topbar">
        <h1>Farm Experience reports</h1>
        <span className="spacer" />
        <DownloadButton getUrl={() => farm.csvUrl(range)} filename={`farm-bookings-${from}-to-${to}.csv`}>
          Download bookings CSV
        </DownloadButton>
      </div>
      <FarmSubnav />
      <div className="field-row mb-4">
        <div className="field mb-0">
          <label htmlFor={`${id}-from`}>Visits from</label>
          <input id={`${id}-from`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field mb-0">
          <label htmlFor={`${id}-to`}>Visits to</label>
          <input id={`${id}-to`} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="field mb-0">
          <label htmlFor={`${id}-v`}>Variety</label>
          <select id={`${id}-v`} value={varietyId} onChange={(e) => setVarietyId(e.target.value)}>
            <option value="">All</option>
            {(varieties.data ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="muted small">Paid bookings with a visit in the range. The CSV lists every booking in the range and is recorded in the activity log.</p>
      {q.isPending && from <= to ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : r ? (
        <>
          <ul className="tiles" aria-label="Report figures">
            {tiles.map(([label, value]) => (
              <li key={label}>
                <div className="tile">
                  <div className="count">{value}</div>
                  <div className="label">{label}</div>
                </div>
              </li>
            ))}
          </ul>
          {r.varieties.length > 0 && (
            <section className="card">
              <h2>By variety</h2>
              <div {...scrollRegion('By variety')}>
                <table className="pn-table">
                  <thead>
                    <tr>
                      <th scope="col">Variety</th>
                      <th scope="col">Bookings</th>
                      <th scope="col">Kg</th>
                      <th scope="col">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.varieties.map((v) => (
                      <tr key={v.name}>
                        <td>{v.name}</td>
                        <td>{v.bookings}</td>
                        <td>{v.kg}</td>
                        <td>{rupees(v.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      ) : null}
    </>
  )
}
