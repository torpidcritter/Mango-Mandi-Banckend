import './setup-env.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { jioSender } from '../src/sms.js'

const opts = {
  url: 'https://sms.example.test/send', apiKey: 'k1', senderId: 'MANDIM', templateId: 'T1', entityId: 'E1',
  text: '{code} is your MandiMangoes login code. It expires in 5 minutes.',
  // A made-up contract for the test; production copies the real one from Jio's documentation.
  successPath: 'result.state', successValues: ['ACCEPTED', 'QUEUED'], idPath: 'result.id',
}

test('the Jio sender posts the DLT-registered message', async () => {
  const calls = []
  const send = jioSender(opts, async (url, init) => {
    calls.push({ url, init })
    return new Response('{"result":{"state":"ACCEPTED","id":"m1"}}', { status: 200 })
  })
  await send('+919876543210', '123456')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, opts.url)
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k1')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    to: '919876543210', sender: 'MANDIM', message: '123456 is your MandiMangoes login code. It expires in 5 minutes.', templateId: 'T1', entityId: 'E1',
  })
})

test('a gateway rejection or network error surfaces as OTP_NOT_SENT', async () => {
  const rejected = jioSender(opts, async () => new Response('bad template', { status: 400 }))
  await assert.rejects(rejected('+919876543210', '123456'), (e) => e.status === 502 && e.code === 'OTP_NOT_SENT')
  const down = jioSender(opts, async () => { throw new Error('ECONNREFUSED') })
  await assert.rejects(down('+919876543210', '123456'), (e) => e.code === 'OTP_NOT_SENT')
})

test('HTTP 200 without the documented accepted status counts as not sent (OPS-03)', async () => {
  for (const body of ['{"result":{"state":"REJECTED"}}', '{"status":"ok"}', 'OK', '', '<html>maintenance</html>']) {
    const send = jioSender(opts, async () => new Response(body, { status: 200 }))
    await assert.rejects(send('+919876543210', '123456'), (e) => e.code === 'OTP_NOT_SENT', `body ${JSON.stringify(body)}`)
  }
  const queued = jioSender(opts, async () => new Response('{"result":{"state":"QUEUED"}}', { status: 200 }))
  await queued('+919876543210', '123456')
})

test('when Jio does not accept the SMS, the code goes by WhatsApp instead', async () => {
  const { otpDelivery } = await import('../src/sms.js')
  const sms = jioSender(opts, async () => new Response('{"result":{"state":"FAILED"}}', { status: 200 }))
  const wa = []
  const deliver = otpDelivery({ sms, whatsapp: async (phone, code) => wa.push({ phone, code }) })
  assert.equal(await deliver('+919876543210', '654321', 'sms'), 'whatsapp')
  assert.deepEqual(wa, [{ phone: '+919876543210', code: '654321' }])
  // With nothing able to send, the request fails instead of pretending.
  const none = otpDelivery({ sms, whatsapp: null })
  await assert.rejects(none('+919876543210', '654321', 'sms'), (e) => e.code === 'OTP_NOT_SENT')
})
