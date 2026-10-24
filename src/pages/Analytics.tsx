import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
import { date, rupees } from '../format'
import type { AnalyticsWeek } from '../types'
import { EmptyState, QueryError, Spinner, scrollRegion, usePageTitle } from '../ui'

const pct = (r: number | null) => (r == null ? '—' : `${Math.round(r * 1000) / 10}%`)
/** Whole rupees, for tiles where paise only add noise. */
const wholeRupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`
const weekLabel = (w: string) => date(w).replace(/,? \d{4}$/, '')

/** Season numbers for the owners: what sold, what was wasted, what went wrong, week by week. */
export default function Analytics() {
  usePageTitle('Analytics')
  const [params, setParams] = useSearchParams()
  const from = params.get('from') || null
  const to = params.get('to') || null
  const q = useQuery({ queryKey: ['analytics', from, to], queryFn: () => api.analytics({ from, to }) })

  function set(key: string, value: string) {
    const p = new URLSearchParams(params)
    if (value) p.set(key, value)
    else p.delete(key)
    setParams(p, { replace: true })
  }

  return (
    <>
      <div className="topbar">
        <h1>Analytics</h1>
        <div className="field m-0">
          <label htmlFor="an-from" className="sr-only">
            From
          </label>
          <input id="an-from" type="date" value={from ?? q.data?.from ?? ''} onChange={(e) => set('from', e.target.value)} />
        </div>
        <div className="field m-0">
          <label htmlFor="an-to" className="sr-only">
            To
          </label>
          <input id="an-to" type="date" value={to ?? q.data?.to ?? ''} onChange={(e) => set('to', e.target.value)} />
        </div>
      </div>

      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <div className="tiles">
            <Tile value={wholeRupees(q.data.totals.revenue)} label="Sales" />
            <Tile value={String(q.data.totals.boxes)} label="Boxes sold" />
            <Tile value={pct(q.data.totals.wastageRate)} label="Boxes wasted" hint={`${q.data.totals.wasted} of ${q.data.totals.received} received`} />
            <Tile value={pct(q.data.totals.atRiskRate)} label="Orders at risk" hint={`${q.data.totals.atRisk} of ${q.data.totals.orders}`} />
            <Tile value={String(q.data.totals.claims)} label="Claims" hint={`${q.data.totals.claimsReplaced} replaced`} />
            <Tile
              value={q.data.totals.averageRating != null ? `${q.data.totals.averageRating.toFixed(1)} ★` : '—'}
              label="Customer rating"
              hint={`${q.data.totals.ratings ?? 0} ${q.data.totals.ratings === 1 ? 'rating' : 'ratings'}`}
            />
          </div>

          {(q.data.lowRatings ?? []).length > 0 && (
            <section className="card">
              <h2>Unhappy customers</h2>
              <p className="muted small">Orders rated 1 or 2 stars, newest first. Worth a call.</p>
              <ul className="plain-list">
                {q.data.lowRatings!.map((r) => (
                  <li key={r.orderId}>
                    <Link to={`/orders/${r.orderId}`}>{r.number}</Link> <span aria-label={`${r.stars} out of 5 stars`}>{'★'.repeat(r.stars)}</span>{' '}
                    <span className="muted small">delivered {date(r.deliveryDate)}</span>
                    {r.comment && <div className="small">{r.comment}</div>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {q.data.totals.orders === 0 && q.data.totals.received === 0 ? (
            <EmptyState>Nothing sold or received between {date(q.data.from)} and {date(q.data.to)}.</EmptyState>
          ) : (
            <>
              <section className="card">
                <h2>Boxes sold per week</h2>
                <p className="muted small">By delivery date. Replacements are left out.</p>
                <WeekBars weeks={q.data.weeks} value={(w) => w.boxes} unit="boxes" detail={(w) => `${w.orders} orders, ${rupees(w.revenue)}`} />
              </section>
              <section className="card">
                <h2>Boxes wasted per week</h2>
                <p className="muted small">Condemned batches and leftover boxes retired at the age limit.</p>
                <WeekBars weeks={q.data.weeks} value={(w) => w.wasted} unit="boxes" detail={(w) => `${pct(w.wastageRate)} of ${w.received} received`} />
              </section>
            </>
          )}

          <section className="card">
            <h2>Week by week</h2>
            <div {...scrollRegion('Week by week')}>
              <table>
                <thead>
                  <tr>
                    <th>Week of</th>
                    <th className="num">Orders</th>
                    <th className="num">Boxes</th>
                    <th className="num">Sales</th>
                    <th className="num">Delivered</th>
                    <th className="num">Missed</th>
                    <th className="num">At risk</th>
                    <th className="num">Received</th>
                    <th className="num">Wasted</th>
                    <th className="num">Cancelled</th>
                    <th className="num">Refunded</th>
                    <th className="num">Claims</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.weeks.map((w) => (
                    <tr key={w.weekStart}>
                      <td>{weekLabel(w.weekStart)}</td>
                      <td className="num">{w.orders}</td>
                      <td className="num">{w.boxes}</td>
                      <td className="num">{rupees(w.revenue)}</td>
                      <td className="num">{w.delivered}</td>
                      <td className="num">{w.deliveryFailed}</td>
                      <td className="num">{w.atRisk}</td>
                      <td className="num">{w.received}</td>
                      <td className="num">{w.wasted}</td>
                      <td className="num">{w.customerCancels}</td>
                      <td className="num">{rupees(w.refunded)}</td>
                      <td className="num">{w.claims}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <h2>By product</h2>
            {q.data.bySku.length === 0 ? (
              <EmptyState>No products sold or received in this range.</EmptyState>
            ) : (
              <div {...scrollRegion('By product')}>
                <table>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="num">Boxes sold</th>
                      <th className="num">Sales</th>
                      <th className="num">Received</th>
                      <th className="num">Wasted</th>
                      <th className="num">Wasted %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.bySku.map((s) => (
                      <tr key={s.sku}>
                        <td>
                          {s.productName} <span className="muted small">{s.sku}</span>
                        </td>
                        <td className="num">{s.boxes}</td>
                        <td className="num">{rupees(s.revenue)}</td>
                        <td className="num">{s.received}</td>
                        <td className="num">{s.wasted}</td>
                        <td className="num">{pct(s.wastageRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  )
}

function Tile({ value, label, hint }: { value: string; label: string; hint?: string }) {
  return (
    <div className="tile">
      <div className="count">{value}</div>
      <div className="label">{label}</div>
      {hint && <div className="muted small">{hint}</div>}
    </div>
  )
}

const H = 180
const PAD = { top: 12, right: 8, bottom: 24, left: 36 }

/** A single-series weekly bar chart with a hover/focus tooltip. The table below carries every number. */
function WeekBars({
  weeks,
  value,
  unit,
  detail,
}: {
  weeks: AnalyticsWeek[]
  value: (w: AnalyticsWeek) => number
  unit: string
  detail: (w: AnalyticsWeek) => string
}) {
  const [active, setActive] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(640)
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const max = Math.max(1, ...weeks.map(value))
  const step = niceStep(max)
  const top = Math.ceil(max / step) * step
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const band = plotW / weeks.length
  const barW = Math.max(4, Math.min(28, band * 0.6))
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step)
  const labelEvery = Math.ceil(weeks.length / Math.max(2, Math.floor(plotW / 64)))
  const a = active == null ? null : weeks[active]

  return (
    <div className="chart" ref={box} onMouseLeave={() => setActive(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="group" aria-label={`Weekly ${unit}, ${weeks.length} weeks, highest ${max}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="axis-label" x={PAD.left - 6} y={y(t) + 4} textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {weeks.map((w, i) => {
          const v = value(w)
          const cx = PAD.left + band * i + band / 2
          const h = Math.max(0, y(0) - y(v))
          const r = Math.min(4, barW / 2, h)
          return (
            <g key={w.weekStart}>
              {v > 0 && (
                <path
                  className="bar"
                  d={`M${cx - barW / 2},${y(0)} V${y(v) + r} Q${cx - barW / 2},${y(v)} ${cx - barW / 2 + r},${y(v)} H${cx + barW / 2 - r} Q${cx + barW / 2},${y(v)} ${cx + barW / 2},${y(v) + r} V${y(0)} Z`}
                  opacity={active == null || active === i ? 1 : 0.45}
                />
              )}
              {i % labelEvery === 0 && (
                <text className="axis-label" x={cx} y={H - 6} textAnchor="middle">
                  {weekLabel(w.weekStart)}
                </text>
              )}
              <rect
                className="bar-hit"
                x={PAD.left + band * i}
                y={PAD.top}
                width={band}
                height={plotH}
                tabIndex={0}
                role="img"
                aria-label={`Week of ${weekLabel(w.weekStart)}: ${v} ${unit}, ${detail(w)}`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              />
            </g>
          )
        })}
      </svg>
      {a && active != null && (
        <div
          className="tip"
          aria-hidden="true"
          style={{ left: `${Math.min(80, Math.max(20, ((PAD.left + band * active + band / 2) / W) * 100))}%`, top: `${(y(value(a)) / H) * 100}%` }}
        >
          <strong>
            {value(a)} {unit}
          </strong>{' '}
          <span className="muted">week of {weekLabel(a.weekStart)}</span>
          <div className="muted">{detail(a)}</div>
        </div>
      )}
    </div>
  )
}

/** A round axis step giving 3 to 5 gridlines. */
function niceStep(max: number) {
  const raw = max / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const n = raw / mag
  return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag)
}
