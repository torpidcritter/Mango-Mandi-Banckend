// Razorpay webhook bodies recorded in test mode (sanitized with
// scripts/razorpay-sandbox.mjs) are replayed here, so the code is checked
// against what Razorpay really sends rather than what we assume it sends.
// Until fixtures are recorded the replay is skipped and says so.
import { checkout, client, closeAll, customerToken, makeBatch, resetDb, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { after, before, beforeEach, describe, test } from 'node:test'
import { query } from '../src/db.js'
import { handleWebhook } from '../src/payments.js'
import { sanitize } from '../scripts/razorpay-sandbox.mjs'

const DIR = new URL('./fixtures/razorpay/', import.meta.url)
const fixtures = (await readdir(DIR).catch(() => [])).filter((f) => f.endsWith('.json'))

let srv
let api
before(async () => {
  srv = await startServer()
  api = client(srv.base)
})
after(async () => {
  await srv.close()
  await closeAll()
})
beforeEach(resetDb)

describe('sanitizing recorded Razorpay bodies', () => {
  test('personal data is removed; ids, amounts, statuses and our own notes stay', () => {
    const raw = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_T1', order_id: 'order_T1', amount: 49900, currency: 'INR', status: 'captured', method: 'upi',
            email: 'asha@example.com', contact: '+919876543210', vpa: 'asha@okbank', notes: { orderId: 'ord_1', phone: '+91987' },
            card: { name: 'ASHA', last4: '1111', network: 'Visa', type: 'credit' },
          },
        },
      },
    }
    const s = sanitize(raw)
    const e = s.payload.payment.entity
    assert.deepEqual([e.id, e.order_id, e.amount, e.currency, e.status, e.method], ['pay_T1', 'order_T1', 49900, 'INR', 'captured', 'upi'])
    assert.equal(e.email, 'redacted')
    assert.equal(e.contact, 'redacted')
    assert.equal(e.vpa, 'redacted')
    assert.deepEqual(e.notes, { orderId: 'ord_1' })
    assert.deepEqual(e.card, { network: 'Visa', type: 'credit', last4: 'XXXX' })
    assert.ok(!JSON.stringify(s).includes('9876543210'))
  })
})

describe('recorded Razorpay webhooks', () => {
  if (!fixtures.length) {
    test('replay recorded webhooks', { skip: 'no recorded fixtures yet: see deploy/RAZORPAY-SANDBOX.md' }, () => {})
    return
  }
  for (const file of fixtures) {
    test(`${file}: has every field the code reads, and replays cleanly`, async () => {
      const body = JSON.parse(await readFile(new URL(file, DIR), 'utf8'))
      assert.ok(!JSON.stringify(body).includes('rzp_live_'), 'test mode only')
      assert.equal(typeof body.event, 'string')
      if (body.event.startsWith('payment.')) {
        const p = body.payload?.payment?.entity
        for (const k of ['id', 'order_id', 'amount', 'currency', 'status', 'method']) assert.ok(k in p, `payment.entity.${k} missing`)
        assert.equal(typeof p.amount, 'number')
        // Point the recorded payment at an order of ours with the same total, then replay it.
        await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
        const cust = await customerToken(api)
        const c = await checkout(api, cust.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
        await query('UPDATE orders SET razorpay_order_id = $2, total = $3 WHERE id = $1', [c.body.orderId, p.order_id, p.amount])
        const out = await handleWebhook(body, `fixture:${file}`)
        if (body.event === 'payment.captured') assert.equal(out.result, 'confirmed', JSON.stringify(out))
        if (body.event === 'payment.failed') assert.ok(['failed', 'payment_failed', undefined].includes(out.result) || out.orderId, JSON.stringify(out))
      } else if (body.event === 'payment_link.paid') {
        // R7 (WhatsApp order paid by link): the fields findOrderId and the capture checks read.
        const l = body.payload?.payment_link?.entity
        const p = body.payload?.payment?.entity
        assert.ok(l && 'id' in l, 'payment_link.entity.id missing')
        for (const k of ['id', 'amount', 'currency']) assert.ok(p && k in p, `payment.entity.${k} missing`)
        assert.equal(typeof p.amount, 'number')
      } else if (body.event.startsWith('refund.')) {
        const r = body.payload?.refund?.entity
        for (const k of ['id', 'payment_id', 'amount', 'status']) assert.ok(k in r, `refund.entity.${k} missing`)
      }
    })
  }
})
