// Scanning box labels: packing an order box by box, checking the van before a
// run goes out, and (for riders) checking a box at the door. Every scan answers
// right away, in words, with what to do next.
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api, errorMessage } from '../api'
import { date, istDate } from '../format'
import Scanner from '../labels/Scanner'
import { canSee } from '../permissions'
import { useSession } from '../session'
import type { RunCheck, VanState } from '../types'
import { Badge, EmptyState, QueryError, Spinner, useToast } from '../ui'

type Mode = 'pack' | 'van' | 'door'
interface Result {
  ok: boolean
  text: string
  at: number
}

const MODE_LABEL: Record<Mode, string> = { pack: 'Pack', van: 'Load the van', door: 'At the door' }

function buzz(ok: boolean) {
  try {
    navigator.vibrate?.(ok ? 60 : [120, 80, 120])
  } catch {
    // Not every browser lets a page vibrate.
  }
}

export default function Scan() {
  const { me } = useSession()
  const [params, setParams] = useSearchParams()
  const role = me?.role
  const modes: Mode[] = role === 'RIDER' ? ['van', 'door'] : ['pack', 'van']
  const asked = params.get('mode') as Mode | null
  const mode: Mode = asked && modes.includes(asked) ? asked : modes[0]

  function set(next: Record<string, string | null>) {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v)
      else p.delete(k)
    }
    setParams(p, { replace: true })
  }

  if (!me?.features?.labels) {
    return (
      <>
        <h1>Scan</h1>
        <EmptyState>Box labels are turned off. A manager can turn them on under Planning, Selling rules.</EmptyState>
      </>
    )
  }

  return (
    <>
      <div className="topbar">
        <h1>Scan</h1>
        <div className="segmented" role="group" aria-label="What are you scanning for?">
          {modes.map((m) => (
            <button key={m} type="button" className="btn btn-small" aria-pressed={mode === m} onClick={() => set({ mode: m === modes[0] ? null : m })}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      </div>
      {mode === 'pack' && <PackMode orderId={params.get('order')} day={params.get('date') || istDate(1)} onPick={(order) => set({ order })} />}
      {mode === 'van' && (
        <VanMode
          day={params.get('date') || istDate(role === 'RIDER' ? 0 : 1)}
          slot={params.get('slot')}
          onChange={(next) => set(next)}
        />
      )}
      {mode === 'door' && <DoorMode orderId={params.get('order')} />}
    </>
  )
}

/** The last few scans, newest first, read out to screen readers as they happen. */
function Results({ results }: { results: Result[] }) {
  const [latest, ...older] = results
  return (
    <div className="scan-results">
      <div role="status" aria-live="assertive" className={latest ? `scan-result ${latest.ok ? 'scan-ok' : 'scan-bad'}` : 'sr-only'}>
        {latest?.text ?? ''}
      </div>
      {older.length > 0 && (
        <ul className="small muted" aria-label="Earlier scans">
          {older.slice(0, 6).map((r) => (
            <li key={r.at}>
              {r.ok ? '✓' : '✗'} {r.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function useResults() {
  const [results, setResults] = useState<Result[]>([])
  const push = (ok: boolean, text: string) => {
    buzz(ok)
    setResults((r) => [{ ok, text, at: Date.now() + Math.random() }, ...r].slice(0, 8))
  }
  const fail = (err: unknown) => push(false, err instanceof ApiError ? err.message : errorMessage(err).message)
  return { results, push, fail, clear: () => setResults([]) }
}

// ---------------------------------------------------------------- pack

function PackMode({ orderId, day, onPick }: { orderId: string | null; day: string; onPick: (id: string | null) => void }) {
  const { results, push, fail, clear } = useResults()
  const queryClient = useQueryClient()
  const list = useQuery({ queryKey: ['pack-list', day], queryFn: () => api.packList(day), enabled: !orderId })
  const labels = useQuery({ queryKey: ['order-labels', orderId], queryFn: () => api.orderLabels(orderId!), enabled: !!orderId })

  if (!orderId) {
    const open = (list.data ?? []).filter((o) => o.status === 'CONFIRMED' || o.status === 'PROCESSING')
    return (
      <section className="card">
        <h2>Which order are you packing?</h2>
        <p className="muted small">Orders for {date(day)} that still need packing. Print their labels on the Pack list first.</p>
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <QueryError error={list.error} onRetry={() => list.refetch()} />
        ) : open.length === 0 ? (
          <EmptyState>Nothing left to pack for {date(day)}.</EmptyState>
        ) : (
          <ul className="stops">
            {open.map((o) => (
              <li key={o.id} className="stop">
                <button type="button" className="btn" onClick={() => (clear(), onPick(o.id))}>
                  Pack {o.number}
                </button>{' '}
                <span className="muted small">
                  {o.items.reduce((n, i) => n + i.quantity, 0)} boxes{o.slot ? ` · ${o.slot.label}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  }

  const data = labels.data
  const packed = data?.labels.filter((l) => l.packedAt).length ?? 0
  const number = data?.labels[0]?.orderNumber

  async function onScan(text: string) {
    try {
      const r = await api.packScan(orderId!, text)
      push(
        true,
        r.outcome === 'REPEAT'
          ? `Box ${r.boxNo} was already scanned. ${r.packedBoxes} of ${r.totalBoxes} done.`
          : r.orderPacked
            ? `Box ${r.boxNo} scanned. ${r.orderNumber} is packed.`
            : `Box ${r.boxNo} scanned. ${r.packedBoxes} of ${r.totalBoxes} done.`,
      )
      queryClient.invalidateQueries({ queryKey: ['order-labels', orderId] })
      queryClient.invalidateQueries({ queryKey: ['pack-list'] })
    } catch (err) {
      fail(err)
    }
  }

  return (
    <section className="card">
      <div className="topbar" style={{ marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>Packing {number ?? '…'}</h2>
        {data && (
          <Badge tone={packed === data.labels.length && packed > 0 ? 'good' : 'info'}>
            {packed} of {data.labels.length} boxes
          </Badge>
        )}
        <span className="spacer" />
        <button type="button" className="btn btn-small" onClick={() => onPick(null)}>
          Another order
        </button>
      </div>
      {labels.isError ? (
        <QueryError error={labels.error} onRetry={() => labels.refetch()} />
      ) : data && !data.labels.length ? (
        <p className="text-warn">No labels printed for this order yet. Print them on the Pack list or the order page.</p>
      ) : data && !data.current ? (
        <p className="text-warn">This order changed after its labels were printed. Print its labels again before packing.</p>
      ) : null}
      <Scanner onScan={onScan} label="Scan each box, or type its code" />
      <Results results={results} />
      {data && data.labels.length > 0 && (
        <ul className="box-list" aria-label="Boxes">
          {data.labels.map((l) => (
            <li key={l.id}>
              <Badge tone={l.packedAt ? 'good' : 'neutral'}>{l.packedAt ? 'Packed' : 'To scan'}</Badge> Box {l.boxNo}: {l.productName},{' '}
              {l.ripeness.toLowerCase()} <span className="muted small">{l.code}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- van

const VAN_LABEL: Record<VanState, string> = {
  ready: 'All boxes on the van',
  missing: 'Boxes missing',
  not_packed: 'Not packed yet',
  no_labels: 'No labels printed',
  out: 'Out for delivery',
}
const VAN_TONE: Record<VanState, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  ready: 'good',
  missing: 'warn',
  not_packed: 'bad',
  no_labels: 'bad',
  out: 'neutral',
}

function VanMode({ day, slot, onChange }: { day: string; slot: string | null; onChange: (next: Record<string, string | null>) => void }) {
  const toast = useToast()
  const { results, push, fail } = useResults()
  const queryClient = useQueryClient()
  // "all" (or nothing) = every slot; "none" = orders without a slot.
  const slotId = !slot || slot === 'all' ? undefined : slot === 'none' ? null : slot
  const key = ['run-check', day, slot ?? 'all']
  const check = useQuery({ queryKey: key, queryFn: () => api.runCheck(day, slotId) })
  const everySlot = useQuery({ queryKey: ['run-check', day, 'all'], queryFn: () => api.runCheck(day), enabled: slotId !== undefined })
  const slots = useMemo(() => slotOptions((slotId === undefined ? check.data : everySlot.data) ?? null), [check.data, everySlot.data, slotId])

  const send = useMutation({
    mutationFn: () => api.sendLoaded(day, slotId),
    onSuccess: (r) => {
      toast.success(`${r.dispatched.length} ${r.dispatched.length === 1 ? 'order' : 'orders'} out for delivery`)
      if (r.skipped.length) toast.info(`Not sent: ${r.skipped.map((s) => `${s.number} (${s.reason.toLowerCase()})`).join(', ')}`)
      queryClient.invalidateQueries({ queryKey: ['run-check'] })
      queryClient.invalidateQueries({ queryKey: ['manifest', day] })
    },
    onError: (err) => toast.error(err),
  })

  async function onScan(text: string) {
    try {
      const r = await api.vanScan(day, slotId, text)
      push(
        true,
        r.outcome === 'REPEAT'
          ? `Box ${r.boxNo} of ${r.orderNumber} is already on the van.`
          : `${r.orderNumber} box ${r.boxNo} on the van. ${r.loadedBoxes} of ${r.totalBoxes} for this order.`,
      )
      queryClient.invalidateQueries({ queryKey: ['run-check', day] })
    } catch (err) {
      fail(err)
    }
  }

  return (
    <section className="card">
      <div className="topbar" style={{ marginBottom: '0.5rem' }}>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="van-date">Run date</label>
          <input id="van-date" type="date" value={day} onChange={(e) => onChange({ date: e.target.value || null })} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="van-slot">Slot</label>
          <select id="van-slot" value={slot ?? 'all'} onChange={(e) => onChange({ slot: e.target.value === 'all' ? null : e.target.value })}>
            <option value="all">Every slot</option>
            {slots.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-primary"
          disabled={send.isPending || !check.data?.ready}
          onClick={() => send.mutate()}
        >
          Send out loaded orders{check.data ? ` (${check.data.ready})` : ''}
        </button>
      </div>
      <Scanner onScan={onScan} label="Scan each box as it goes on the van" />
      <Results results={results} />
      {check.isPending ? (
        <Spinner />
      ) : check.isError ? (
        <QueryError error={check.error} onRetry={() => check.refetch()} />
      ) : check.data.orders.length === 0 ? (
        <EmptyState>No orders on this run.</EmptyState>
      ) : (
        <RunTable data={check.data} />
      )}
    </section>
  )
}

function slotOptions(data: RunCheck | null) {
  const seen = new Map<string, string>()
  for (const o of data?.orders ?? []) seen.set(o.slot?.id ?? 'none', o.slot?.label ?? 'No slot')
  return [...seen].map(([value, label]) => ({ value, label }))
}

function RunTable({ data }: { data: RunCheck }) {
  const { me } = useSession()
  const link = canSee(me?.role, 'orderDetail')
  return (
    <table>
      <caption className="sr-only">Orders on this run</caption>
      <thead>
        <tr>
          <th>Order</th>
          <th>Boxes</th>
          <th>State</th>
        </tr>
      </thead>
      <tbody>
        {data.orders.map((o) => (
          <tr key={o.id}>
            <td>{link ? <Link to={`/orders/${o.id}`}>{o.number}</Link> : o.number}</td>
            <td>
              {o.loaded} of {o.boxes}
              {o.missing.length > 0 && o.state === 'missing' && <div className="small text-warn">Missing box {o.missing.join(', ')}</div>}
            </td>
            <td>
              <Badge tone={VAN_TONE[o.state]}>{VAN_LABEL[o.state]}</Badge>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ---------------------------------------------------------------- door

function DoorMode({ orderId }: { orderId: string | null }) {
  const { results, push, fail } = useResults()
  if (!orderId) {
    return (
      <EmptyState>
        Open the order on <Link to="/deliveries">Deliveries</Link> and choose “Check box” to scan it at the door.
      </EmptyState>
    )
  }
  async function onScan(text: string) {
    try {
      const r = await api.doorScan(orderId!, text)
      push(true, `Right box: ${r.orderNumber} box ${r.boxNo}. ${r.checkedBoxes} of ${r.totalBoxes} checked. Now take the code or a photo.`)
    } catch (err) {
      fail(err)
    }
  }
  return (
    <section className="card">
      <h2>Check the box before handing it over</h2>
      <Scanner onScan={onScan} label="Scan the box at the door" />
      <Results results={results} />
      <p className="small muted">
        This only checks the box. Mark the order delivered on <Link to="/deliveries">Deliveries</Link> with the customer's code or a photo.
      </p>
    </section>
  )
}
