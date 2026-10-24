// SEC-R1: what reaches Sentry. This file's process points SENTRY_DSN at a
// local stand-in for Sentry's ingest endpoint, makes a sign-in request fail
// with a database error, and reads the event the SDK actually sent.
import assert from 'node:assert/strict'
import http from 'node:http'
import { gunzipSync } from 'node:zlib'
import { after, before, test } from 'node:test'

const events = []
const sink = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    let buf = Buffer.concat(chunks)
    if (req.headers['content-encoding'] === 'gzip') buf = gunzipSync(buf)
    const lines = buf.toString('utf8').split('\n').filter(Boolean)
    for (let i = 1; i < lines.length; i += 2) if (JSON.parse(lines[i]).type === 'event') events.push(JSON.parse(lines[i + 1]))
    res.writeHead(200).end('{}')
  })
})
await new Promise((r) => sink.listen(0, '127.0.0.1', r))
process.env.SENTRY_DSN = `http://publickey@127.0.0.1:${sink.address().port}/1`
process.env.no_proxy = `${process.env.no_proxy ?? ''},127.0.0.1`

const { client, closeAll, resetDb, startServer } = await import('./helpers.js')
const { query } = await import('../src/db.js')
const { flushErrors, scrubEvent, scrubText } = await import('../src/sentry.js')

let srv
let api
before(async () => {
  await resetDb()
  srv = await startServer()
  api = client(srv.base)
})
after(async () => {
  await srv.close()
  await closeAll()
  sink.close()
})

async function nextEvent() {
  await flushErrors()
  for (let i = 0; i < 50 && !events.length; i++) await new Promise((r) => setTimeout(r, 20))
  return events.shift()
}

test('a failed sign-in sends Sentry no phone, login code, password, refresh cookie or IP address', async () => {
  await query('DROP TABLE otps CASCADE')
  const headers = { Cookie: 'mm_customer_rt=REFRESH-SECRET-abc; mango_admin_rt=STAFF-RT-xyz', 'X-Forwarded-For': '203.0.113.9', Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln' }
  const r = await api.post('/v1/auth/otp/verify?phone=9876543210', { phone: '9876543210', code: '481516' }, { headers })
  assert.equal(r.status, 500)
  const e = await nextEvent()
  assert.ok(e, 'Sentry got the error')
  assert.match(e.exception.values[0].value, /otps/, 'the useful part stays')
  assert.equal(e.request.method, 'POST')
  assert.match(e.request.url, /\/v1\/auth\/otp\/verify$/)
  const text = JSON.stringify(e)
  for (const secret of ['9876543210', '481516', 'REFRESH-SECRET', 'STAFF-RT', '203.0.113.9', 'eyJhbGciOiJIUzI1NiJ9']) {
    assert.ok(!text.includes(secret), `Sentry event carries ${secret}`)
  }
  assert.equal(e.request.data, undefined)
  assert.equal(e.request.cookies, undefined)
  assert.equal(e.user, undefined)
})

test('staff sign-in: the password never goes either', async () => {
  await query('DROP TABLE admin_users CASCADE')
  const r = await api.post('/admin/v1/auth/login', { email: 'manager@mandimangoes.test', password: 'Correct-Horse-9' })
  assert.equal(r.status, 500)
  const e = await nextEvent()
  assert.ok(e)
  const text = JSON.stringify(e)
  assert.ok(!text.includes('Correct-Horse-9'))
  assert.ok(!text.includes('manager@mandimangoes.test'))
})

test('scrubEvent: extra context, breadcrumbs and messages lose phones, addresses, codes and keys', () => {
  const e = scrubEvent({
    message: 'SMS to +919876543210 failed with rzp_live_AbC123',
    exception: { values: [{ value: 'Jio said 9876543210 is invalid' }] },
    extra: { orderId: 'ord_1', phone: '+919876543210', nested: { deliveryAddress: '12 MG Road', note: 'call 9811122233' }, code: '1234', razorpaySignature: 'abc' },
    breadcrumbs: [{ message: 'GET https://x.test/send?to=919876543210', data: { url: 'https://x.test/send?to=919876543210', token: 't' } }],
    user: { ip_address: '1.2.3.4' },
    request: { url: 'https://api/x?phone=9876543210', query_string: 'phone=9876543210', headers: { 'X-Forwarded-For': '1.2.3.4', 'User-Agent': 'ua' } },
  })
  const text = JSON.stringify(e)
  for (const s of ['9876543210', '9811122233', 'MG Road', 'rzp_live_AbC123', '1.2.3.4', '"1234"']) assert.ok(!text.includes(s), s)
  assert.equal(e.extra.orderId, 'ord_1')
  assert.deepEqual(e.request.headers, { 'User-Agent': 'ua' })
  assert.equal(scrubText('order MM-1042 for ₹1899'), 'order MM-1042 for ₹1899', 'ordinary text is left alone')
})
