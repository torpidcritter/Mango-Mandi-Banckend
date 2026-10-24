// Latency and status per request name from a k6 CSV output
// (`k6 run --out csv=run.csv ...`). Prints a Markdown table.
//
//   node ops/load/report.js run.csv [--scenario checkout]
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const file = process.argv[2]
const only = process.argv.includes('--scenario') ? process.argv[process.argv.indexOf('--scenario') + 1] : null
const rl = createInterface({ input: createReadStream(file) })
let cols = null
const by = new Map()
let first = Infinity
let last = 0

for await (const line of rl) {
  const f = line.split(',')
  if (!cols) {
    cols = Object.fromEntries(f.map((n, i) => [n, i]))
    continue
  }
  if (f[cols.metric_name] !== 'http_req_duration') continue
  const scenario = f[cols.scenario]
  if (only && scenario !== only) continue
  const name = f[cols.name] || f[cols.url]
  if (name === 'stub') continue
  const t = Number(f[cols.timestamp])
  first = Math.min(first, t)
  last = Math.max(last, t)
  const e = by.get(name) ?? { ms: [], status: {} }
  e.ms.push(Number(f[cols.metric_value]))
  const s = f[cols.status] || '0'
  e.status[s] = (e.status[s] ?? 0) + 1
  by.set(name, e)
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0)
const rows = []
let total = 0
let bad = 0
for (const [name, e] of [...by].sort((a, b) => b[1].ms.length - a[1].ms.length)) {
  e.ms.sort((a, b) => a - b)
  const n = e.ms.length
  const errors = Object.entries(e.status).filter(([s]) => Number(s) >= 500 || s === '0').reduce((t, [, c]) => t + c, 0)
  total += n
  bad += errors
  rows.push(
    `| ${name} | ${n} | ${pct(e.ms, 50).toFixed(0)} | ${pct(e.ms, 95).toFixed(0)} | ${pct(e.ms, 99).toFixed(0)} | ${e.ms[n - 1].toFixed(0)} | ${Object.entries(e.status).map(([s, c]) => `${s}:${c}`).join(' ')} | ${((errors / n) * 100).toFixed(2)}% |`,
  )
}
console.log(`${total} requests over ${last - first} s (${(total / Math.max(1, last - first)).toFixed(1)}/s); 5xx or no answer: ${bad} (${((bad / Math.max(1, total)) * 100).toFixed(3)}%)\n`)
console.log('| request | n | p50 ms | p95 ms | p99 ms | max ms | statuses | 5xx/none |')
console.log('|---|---:|---:|---:|---:|---:|---|---:|')
console.log(rows.join('\n'))
