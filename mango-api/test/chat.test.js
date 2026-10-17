// Ordering over WhatsApp: the chat flow, payment links, cancel and refund, and the webhook.
import { adminToken, client, closeAll, makeBatch, resetDb, signWebhook, startServer } from './helpers.js'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, beforeEach, describe, test } from 'node:test'
import { handleInbound, phoneFromWaId } from '../src/chat.js'
import { addDays, todayIST } from '../src/clock.js'
import { query } from '../src/db.js'
import { devGateway, reconcilePendingPayments } from '../src/payments.js'
import { toMeta } from '../src/whatsapp.js'

let srv
let api
let seq = 0

before(async () => {
  srv = await startServer()
  api = client(srv.base)
})
after(async () => {
  await srv.close()
  await closeAll()
})
beforeEach(async () => {
  await resetDb()
  await makeBatch({ age: 5, rating: 'SEMI_RIPE', lines: { 'ALP-3': 10 } })
})

/** A customer chatting from one number; each call is one message. */
function chatter(waId = '919812345678', name = 'Asha') {
  const sent = []
  const say = async (input, messageId = `wamid.${++seq}`) => {
    const replies = await handleInbound({ waId, name, messageId, input: typeof input === 'string' ? { text: input } : input }, { send: async (to, r) => sent.push({ to, r }) })
    return replies
  }
  return { say, sent, tap: (id) => say({ id }) }
}
const ids = (r) => (r.buttons ?? r.rows ?? []).map((x) => x.id)
const orderOf = async (phone) => (await query(`SELECT * FROM orders WHERE phone = $1 ORDER BY placed_at DESC LIMIT 1`, [phone])).rows[0]

async function orderTwoBoxes(ch) {
  await ch.say('hi')
  await ch.tap('ORDER')
  const [list] = await ch.say('560034')
  assert.equal(list.type, 'list')
  assert.ok(ids(list).includes('item:ALP-3|RIPE'), JSON.stringify(list))
  const [qty] = await ch.tap('item:ALP-3|RIPE')
  assert.deepEqual(ids(qty), ['qty:1', 'qty:2', 'qty:3'])
  const [cart] = await ch.tap('qty:2')
  assert.match(cart.text, /2 × Alphonso/)
  return cart
}

describe('ordering in the WhatsApp chat', () => {
  test('a customer picks boxes, gives an address and gets a payment link; payment confirms the order', async () => {
    const ch = chatter()
    const [menu] = await ch.say('Hi')
    assert.deepEqual(ids(menu), ['ORDER', 'BOOK', 'ORDERS'])
    await orderTwoBoxes(ch)
    const [addr] = await ch.tap('CHECKOUT')
    assert.match(addr.text, /full delivery address/)
    assert.match((await ch.say('short'))[0].text, /too short/)
    const [sum] = await ch.say('12, 4th Cross, Koramangala, Bengaluru')
    assert.deepEqual(ids(sum), ['PAY', 'ORDER', 'MENU'])
    assert.match(sum.text, /Total Rs [\d,]+/)

    const replies = await ch.tap('PAY')
    const link = replies.at(-1)
    assert.equal(link.type, 'link')
    assert.match(link.url, /^https:\/\/rzp\.io\/i\/plink_dev_/)
    const o = await orderOf('+919812345678')
    assert.equal(o.channel, 'whatsapp')
    assert.equal(o.status, 'PAYMENT_PENDING')
    assert.equal(o.customer_name, 'Asha')
    assert.equal(o.delivery_address, '12, 4th Cross, Koramangala, Bengaluru')
    assert.equal(o.payment_link_url, link.url)
    assert.equal(ch.sent.length > 5, true)

    // Tapping Pay again resends the same link instead of booking twice.
    const again = await ch.tap('PAY')
    assert.equal(again.at(-1).url, link.url)
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM orders WHERE phone = '+919812345678'`)).rows[0].n, 1)

    // Razorpay's payment_link.paid webhook confirms it and queues the WhatsApp update.
    const { raw, signature } = signWebhook({
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: o.payment_link_id, reference_id: o.number, notes: { orderId: o.id }, status: 'paid' } },
        payment: { entity: { id: 'pay_link_1', amount: o.total, method: 'upi', order_id: 'order_from_link' } },
      },
    })
    const hook = await api.raw('POST', '/webhooks/razorpay', { raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature } })
    assert.equal(hook.status, 200, JSON.stringify(hook.body))
    const paid = await orderOf('+919812345678')
    assert.equal(paid.status, 'CONFIRMED')
    assert.equal(paid.payment_method, 'upi')
    const n = await query(`SELECT kind FROM notifications WHERE order_id = $1`, [o.id])
    assert.deepEqual(n.rows.map((r) => r.kind), ['ORDER_CONFIRMED'])

    // The staff panel shows where the order came from.
    const admin = await adminToken(api)
    const detail = await api.get(`/admin/v1/orders/${o.id}`, { token: admin })
    assert.equal(detail.body.channel, 'whatsapp')
  })

  test('a duplicate delivery of a message is ignored', async () => {
    const ch = chatter()
    assert.equal((await ch.say('hi', 'wamid.same')).length, 1)
    assert.deepEqual(await ch.say('hi', 'wamid.same'), [])
  })

  test('slots are offered, a saved address is reused, and reconcile catches a missed link payment', async () => {
    const admin = await adminToken(api)
    const slot = await api.post('/admin/v1/slots', { label: 'Morning', startsAt: '07:00', endsAt: '11:00', maxBoxes: 5 }, { token: admin })
    const ch = chatter()
    await orderTwoBoxes(ch)
    const [slots] = await ch.tap('CHECKOUT')
    assert.equal(slots.type, 'list')
    assert.deepEqual(ids(slots), [`slot:${slot.body.id}`])
    assert.match(slots.rows[0].description, /7 AM to 11 AM · 5 boxes left/)
    await ch.tap(`slot:${slot.body.id}`)
    const [sum] = await ch.say('12, 4th Cross, Koramangala, Bengaluru')
    assert.match(sum.text, /Morning \(7 AM to 11 AM\)/)
    await ch.tap('PAY')
    const first = await orderOf('+919812345678')
    assert.equal(first.slot_id, slot.body.id)

    devGateway.set(first.payment_link_id, { id: 'pay_dev_late', status: 'captured', amount: first.total, method: 'upi' })
    await query(`UPDATE orders SET placed_at = placed_at - interval '10 minutes' WHERE id = $1`, [first.id])
    assert.equal(await reconcilePendingPayments({ minAgeSeconds: 0 }), 1)
    assert.equal((await orderOf('+919812345678')).status, 'CONFIRMED')

    await orderTwoBoxes(ch)
    await ch.tap('CHECKOUT')
    const [addr] = await ch.tap(`slot:${slot.body.id}`)
    assert.deepEqual(ids(addr), ['ADDR_SAVED', 'ADDR_NEW'])
    assert.match(addr.text, /Koramangala/)
    const [sum2] = await ch.tap('ADDR_SAVED')
    assert.equal(sum2.buttons[0].id, 'PAY')
  })

  test('a paid chat order can be cancelled from My orders and is refunded in full', async () => {
    const ch = chatter()
    await orderTwoBoxes(ch)
    await ch.tap('CHECKOUT')
    await ch.say('12, 4th Cross, Koramangala, Bengaluru')
    await ch.tap('PAY')
    const o = await orderOf('+919812345678')
    await api.post('/v1/dev/pay', { orderId: o.id, outcome: 'captured' })

    const [list] = await ch.say('my orders')
    assert.match(list.text, new RegExp(`${o.number}\\*: Confirmed`))
    assert.deepEqual(ids(list), [`cancel:${o.id}`, 'MENU'])
    const [ask] = await ch.tap(`cancel:${o.id}`)
    assert.match(ask.text, /full refund/)
    const [done] = await ch.tap(`cancelyes:${o.id}`)
    assert.match(done.text, /cancelled\. Your full refund of Rs/)
    const after = await orderOf('+919812345678')
    assert.equal(after.status, 'CANCELLED')
    assert.equal(after.payment_status, 'REFUNDED')
  })

  test('unserviceable pincodes, other countries and the help text', async () => {
    const ch = chatter()
    await ch.tap('ORDER')
    assert.match((await ch.say('110001'))[0].text, /don't deliver to 110001/)
    assert.match((await ch.say('12'))[0].text, /6-digit pincode/)
    assert.match((await ch.say('help'))[0].text, /cancel until your order is packed/)
    const abroad = await handleInbound({ waId: '14155550100', messageId: 'wamid.us', input: { text: 'hi' } }, { send: async () => {} })
    assert.match(abroad[0].text, /Indian mobile numbers/)
    assert.equal(phoneFromWaId('919812345678'), '+919812345678')
  })
})

/** The first Monday after the regular booking horizon. */
function openWeek() {
  let d = addDays(todayIST(), 6)
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1)
  return d
}

describe('booking ahead in the WhatsApp chat', () => {
  const preOf = async (phone) => (await query(`SELECT * FROM preorders WHERE phone = $1 ORDER BY created_at DESC LIMIT 1`, [phone])).rows[0]
  async function openFor(capacity) {
    const week = openWeek()
    const token = await adminToken(api)
    const r = await api.put(`/admin/v1/preorder-capacity/${week}/ALP-3`, { capacity }, { token })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return week
  }
  async function bookTwo(ch, week) {
    const [list] = await ch.tap('BOOK')
    assert.equal(list.type, 'list')
    assert.ok(ids(list).includes(`week:${week}|ALP-3`), JSON.stringify(list))
    const [ripe] = await ch.tap(`week:${week}|ALP-3`)
    assert.deepEqual(ids(ripe), ['prestage:RAW', 'prestage:SEMI_RIPE', 'prestage:RIPE'])
    await ch.tap('prestage:RIPE')
    await ch.tap('qty:2')
    await ch.say('560034')
    return ch.say('12, 4th Cross, Koramangala, Bengaluru')
  }

  test('a customer books a week ahead, pays by link, sees it in My orders and cancels for a refund', async () => {
    const week = await openFor(10)
    const ch = chatter()
    const [sum] = await bookTwo(ch, week)
    assert.match(sum.text, /2 × Alphonso 3kg Box \(Ripe\)/)
    assert.deepEqual(ids(sum), ['PREPAY', 'BOOK', 'MENU'])
    const link = (await ch.tap('PREPAY')).at(-1)
    assert.equal(link.type, 'link')
    assert.match(link.text, /Booking PRE-\d+ is held/)
    const p = await preOf('+919812345678')
    assert.equal(p.channel, 'whatsapp')
    assert.equal(p.status, 'PAYMENT_PENDING')
    assert.equal(p.qty, 2)
    assert.equal(p.payment_link_url, link.url)
    // Tapping Pay again resends the same link instead of booking twice.
    assert.equal((await ch.tap('PREPAY')).at(-1).url, link.url)
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM preorders')).rows[0].n, 1)

    const paid = await api.post('/v1/dev/pay-preorder', { preorderId: p.id, outcome: 'captured' })
    assert.ok(paid.status < 300, JSON.stringify(paid.body))
    const [mine] = await ch.say('my orders')
    assert.match(mine.text, new RegExp(`${p.number}\\*: Booked`))
    assert.deepEqual(ids(mine), [`precancel:${p.id}`, 'MENU'])
    assert.match((await ch.tap(`precancel:${p.id}`))[0].text, /full refund/)
    const [done] = await ch.tap(`precancelyes:${p.id}`)
    assert.match(done.text, /cancelled\. Your full refund of Rs/)
    const after = await preOf('+919812345678')
    assert.equal(after.status, 'CANCELLED')
    assert.equal(after.payment_status, 'REFUNDED')
  })

  test('a full week offers the waitlist, and no weeks open says so', async () => {
    const ch = chatter('919812345679', 'Ravi')
    assert.match((await ch.tap('BOOK'))[0].text, /No weeks are open/)
    const week = await openFor(1)
    const [sum] = await bookTwo(ch, week)
    assert.match(sum.text, /Join the waitlist/)
    const [wait] = await ch.tap('PREPAY')
    assert.match(wait.text, /on the waitlist/)
    const p = await preOf('+919812345679')
    assert.equal(p.status, 'WAITLISTED')
    assert.equal(p.payment_link_url, null)
  })
})

describe('the WhatsApp webhook', () => {
  const sign = (raw) => `sha256=${createHmac('sha256', 'wa_test_secret').update(raw).digest('hex')}`

  test('verifies the endpoint and only accepts signed bodies', async () => {
    const ok = await api.get('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wa_verify_test&hub.challenge=42')
    assert.equal(ok.status, 200)
    assert.equal(ok.body, 42)
    assert.equal((await api.get('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1')).status, 403)

    const raw = JSON.stringify({
      entry: [{ changes: [{ value: {
        contacts: [{ wa_id: '919812345678', profile: { name: 'Asha' } }],
        messages: [{ from: '919812345678', id: 'wamid.hook1', type: 'text', text: { body: 'hi' } }],
      } }] }],
    })
    const forged = await api.raw('POST', '/webhooks/whatsapp', { raw, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}` } })
    assert.equal(forged.status, 401)
    const good = await api.raw('POST', '/webhooks/whatsapp', { raw, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(raw) } })
    assert.equal(good.status, 200)
    assert.equal(good.body.handled, 1)
    const s = await query(`SELECT state FROM wa_sessions WHERE phone = '+919812345678'`)
    assert.equal(s.rows[0].state, 'IDLE')
  })

  test('chat replies become Cloud API messages within WhatsApp limits', () => {
    const b = toMeta('+919812345678', { type: 'buttons', text: 'Pick', buttons: [{ id: 'a', title: 'A very long button title here' }] })
    assert.equal(b.to, '919812345678')
    assert.equal(b.interactive.action.buttons[0].reply.title.length, 20)
    const l = toMeta('+91', { type: 'list', text: 'x', button: 'See mangoes', rows: Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, title: `Row ${i}` })) })
    assert.equal(l.interactive.action.sections[0].rows.length, 10)
    const link = toMeta('+91', { type: 'link', text: 'Pay', button: 'Pay Rs 2,598', url: 'https://rzp.io/i/x' })
    assert.deepEqual(link.interactive.action, { name: 'cta_url', parameters: { display_text: 'Pay Rs 2,598', url: 'https://rzp.io/i/x' } })
  })
})
