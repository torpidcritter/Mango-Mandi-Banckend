#!/usr/bin/env node
// Razorpay sandbox (test mode) evidence kit. Test keys only: refuses rzp_live_ keys.
//
//   node scripts/razorpay-sandbox.mjs sanitize <raw.json> [more.json...]
//       Masks personal data in webhook bodies copied from the Razorpay
//       dashboard (Settings → Webhooks → the webhook → event log) and writes
//       them to test/fixtures/razorpay/, where `npm test` replays them.
//   node scripts/razorpay-sandbox.mjs check <razorpay order id> [...]
//       Read-only calls to Razorpay's test API for orders placed on staging:
//       the order's payments and each payment's refunds. Prints a sanitized
//       summary to paste into the evidence log. Needs RAZORPAY_KEY_ID and
//       RAZORPAY_KEY_SECRET (test) in the environment, never on the command line.
//   node scripts/razorpay-sandbox.mjs webhooks <api-log-file> [...]
//       Reads the API's JSON log lines (exported from Vercel → Logs, or
//       `docker compose logs api`) and prints one evidence row per webhook:
//       our request id next to Razorpay's event, payment, order and refund
//       ids, and what the API did with it. Offline; no keys needed.
//
// See deploy/RAZORPAY-SANDBOX.md for the full run.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(here, '..', 'test', 'fixtures', 'razorpay')

/** Keys whose values are personal or secret, wherever they appear. */
const PII = new Set(['email', 'contact', 'vpa', 'name', 'card_id', 'token_id', 'customer_id', 'bank_transfer', 'acquirer_data', 'upi', 'wallet', 'phone', 'address'])
const NOTES_KEEP = new Set(['orderId', 'preorderId', 'kind'])

export function sanitize(value, key = '') {
  if (Array.isArray(value)) return value.map((v) => sanitize(v, key))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === 'card' && v && typeof v === 'object') out[k] = { network: v.network ?? null, type: v.type ?? null, last4: 'XXXX' }
      else if (k === 'notes' && v && typeof v === 'object') out[k] = Object.fromEntries(Object.entries(v).filter(([nk]) => NOTES_KEEP.has(nk)))
      else if (PII.has(k)) out[k] = v === null ? null : typeof v === 'object' ? '[removed]' : 'redacted'
      else out[k] = sanitize(v, k)
    }
    return out
  }
  return value
}

function testKeysOnly() {
  const id = process.env.RAZORPAY_KEY_ID ?? ''
  const secret = process.env.RAZORPAY_KEY_SECRET ?? ''
  if (!id.startsWith('rzp_test_')) throw new Error('RAZORPAY_KEY_ID must be a test key (rzp_test_...). Live keys are never used here.')
  if (!secret) throw new Error('RAZORPAY_KEY_SECRET is not set')
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64')
}

async function get(auth, p) {
  const res = await fetch(`https://api.razorpay.com/v1${p}`, { headers: { Authorization: auth } })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`GET ${p} → ${res.status} ${body?.error?.code ?? ''}`)
  return body
}

/**
 * The 'razorpay webhook' (and 'webhook processing failed') lines in API log
 * text, one per webhook. Each line may carry a prefix (a timestamp, a
 * container name) before its JSON; lines that aren't ours are skipped.
 */
export function webhookEvidence(text) {
  const rows = []
  for (const line of String(text).split('\n')) {
    const start = line.indexOf('{')
    if (start < 0) continue
    let o
    try {
      o = JSON.parse(line.slice(start))
    } catch {
      continue
    }
    if (o?.msg !== 'razorpay webhook' && o?.msg !== 'webhook processing failed') continue
    rows.push({
      time: o.time ? new Date(o.time).toISOString() : null, reqId: o.reqId ?? null, event: o.razorpayEvent ?? null, eventId: o.razorpayEventId ?? null,
      paymentId: o.paymentId ?? null, orderId: o.razorpayOrderId ?? null, linkId: o.paymentLinkId ?? null, refundId: o.refundId ?? null,
      result: o.msg === 'razorpay webhook' ? (o.result ?? null) : 'ERROR (500, Razorpay retries)',
    })
  }
  return rows
}

const cell = (v) => (v === null || v === undefined || v === '' ? '-' : String(v))

async function main([cmd, ...args]) {
  if (cmd === 'webhooks') {
    console.log('| Time (UTC) | Our request id | Razorpay event | Event id | Payment id | Razorpay order id | Link id | Refund id | Our result |')
    console.log('|---|---|---|---|---|---|---|---|---|')
    for (const file of args) {
      for (const r of webhookEvidence(await readFile(file, 'utf8'))) {
        console.log(`| ${[r.time, r.reqId, r.event, r.eventId, r.paymentId, r.orderId, r.linkId, r.refundId, r.result].map(cell).join(' | ')} |`)
      }
    }
    return
  }
  if (cmd === 'sanitize') {
    await mkdir(OUT, { recursive: true })
    for (const file of args) {
      const raw = JSON.parse(await readFile(file, 'utf8'))
      if (String(raw?.account_id ?? '').includes('live') || JSON.stringify(raw).includes('rzp_live_')) throw new Error(`${file} looks like live data; refusing`)
      const clean = sanitize(raw)
      const name = `${String(clean.event ?? 'event').replaceAll('.', '-')}-${path.basename(file, '.json')}.json`
      await writeFile(path.join(OUT, name), JSON.stringify(clean, null, 2) + '\n')
      console.log(`wrote test/fixtures/razorpay/${name}`)
    }
    return
  }
  if (cmd === 'check') {
    const auth = testKeysOnly()
    for (const orderId of args) {
      const order = await get(auth, `/orders/${encodeURIComponent(orderId)}`)
      const pays = (await get(auth, `/orders/${encodeURIComponent(orderId)}/payments`)).items ?? []
      console.log(`order ${order.id}: status=${order.status} amount=${order.amount} ${order.currency} receipt=${order.receipt}`)
      const payIds = []
      const refundIds = []
      for (const p of pays) {
        const refunds = (await get(auth, `/payments/${encodeURIComponent(p.id)}/refunds`)).items ?? []
        console.log(`  payment ${p.id}: status=${p.status} amount=${p.amount} method=${p.method} captured=${p.captured}`)
        payIds.push(`${p.id} (${p.status})`)
        for (const r of refunds) {
          console.log(`    refund ${r.id}: status=${r.status} amount=${r.amount}`)
          refundIds.push(`${r.id} (${r.status})`)
        }
      }
      // Our order number is the Razorpay order's receipt.
      console.log(`evidence row: | R? | ${new Date().toISOString().slice(0, 10)} | ${order.receipt} | ${order.id} | ${cell(payIds.join(', '))} | ${cell(refundIds.join(', '))} | (request ids and event ids: run \`webhooks\` on the API log) | |`)
    }
    return
  }
  console.log('usage: razorpay-sandbox.mjs sanitize <file.json...> | check <order_id...> | webhooks <api-log-file...>')
  process.exitCode = 2
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
