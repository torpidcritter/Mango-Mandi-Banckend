import './setup-env.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { jioSender } from '../src/sms.js'

const opts = {
  url: 'https://sms.example.test/send', apiKey: 'k1', senderId: 'MANDIM', templateId: 'T1', entityId: 'E1',
  text: '{code} is your MandiMangoes login code. It expires in 5 minutes.',
}

test('the Jio sender posts the DLT-registered message', async () => {
  const calls = []
  const send = jioSender(opts, async (url, init) => {
    calls.push({ url, init })
    return new Response('{"status":"ok"}', { status: 200 })
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
