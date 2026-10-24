// SEC-10: customer phone numbers never go to the logs in full. Every logger
// call that names a phone must pass it through maskPhone (logger.js), and
// phones nested in logged objects are redacted (REDACT_PATHS).
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import pino from 'pino'
import { maskPhone, REDACT_PATHS } from '../src/logger.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

async function sources(dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await sources(p)))
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

/** The object literal given to each logger.<level>({ ... }) call (one level of braces). */
function loggedObjects(code) {
  const out = []
  for (const m of code.matchAll(/logger\.(?:fatal|error|warn|info|debug|trace)\(\s*\{/g)) {
    let depth = 1
    let i = m.index + m[0].length
    while (i < code.length && depth > 0) {
      if (code[i] === '{') depth++
      else if (code[i] === '}') depth--
      i++
    }
    out.push({ at: code.slice(0, m.index).split('\n').length, body: code.slice(m.index + m[0].length, i - 1) })
  }
  return out
}

/** Keys naming a phone whose value is not masked: `phone`, `phone: x.phone`, `giftPhone: p`. */
export function rawPhones(body) {
  const bad = []
  for (const m of body.matchAll(/\b(\w*phone\w*)\b\s*(:\s*([^,}]+))?(?=\s*[,}]|\s*$)/gi)) {
    const value = m[3]?.trim()
    if (!value || !/^(maskPhone|mask)\(/.test(value)) bad.push(m[0].trim())
  }
  return bad
}

test('the phone check spots raw phones and lets masked ones through', () => {
  assert.deepEqual(rawPhones(' err, phone '), ['phone'])
  assert.deepEqual(rawPhones(' phone: n.phone, kind: n.kind '), ['phone: n.phone'])
  assert.deepEqual(rawPhones(' giftPhone: o.gift_recipient_phone '), ['giftPhone: o.gift_recipient_phone'])
  assert.deepEqual(rawPhones(' err, phone: maskPhone(phone) '), [])
  assert.deepEqual(rawPhones(' phone: mask(phone), channel: ch '), [])
})

test('no logger call passes a raw phone number', async () => {
  const files = [...(await sources(path.join(root, 'src'))), ...(await sources(path.join(root, 'ops')))]
  const problems = []
  for (const file of files) {
    const code = await readFile(file, 'utf8')
    for (const { at, body } of loggedObjects(code)) {
      for (const raw of rawPhones(body)) problems.push(`${path.relative(root, file)}:${at} logs ${raw}; use maskPhone()`)
    }
  }
  assert.deepEqual(problems, [])
})

test('phones and addresses nested in logged objects are redacted', () => {
  const lines = []
  const log = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, new Writable({ write: (c, _e, cb) => (lines.push(JSON.parse(c)), cb()) }))
  log.info({ order: { phone: '+919876543210', delivery_address: '12 MG Road', gift_recipient_phone: '+919811122233' }, phone: maskPhone('+919876543210') }, 'x')
  assert.equal(lines[0].order.phone, '[redacted]')
  assert.equal(lines[0].order.delivery_address, '[redacted]')
  assert.equal(lines[0].order.gift_recipient_phone, '[redacted]')
  assert.equal(lines[0].phone, '+9198*****')
})
