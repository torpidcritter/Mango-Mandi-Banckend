// WhatsApp Business Platform (docs/whatsapp/TESTS.md): consent, the 24-hour
// window, the message outbox and its retries, ambiguous timeouts, staff
// handoff, typed questions answered from the customer's own records, account
// and template events, the panel's inbox and set-up routes, and the 15
// end-to-end scenarios. Meta is never called: every send goes to a stub.
import { adminToken, client, closeAll, customerToken, line, makeBatch, resetDb, signWebhook, startServer, T0, checkout } from './helpers.js'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, beforeEach, describe, test } from 'node:test'
import { drainBackground } from '../src/background.js'
import { handleInbound, inputOf, mediaOf } from '../src/chat.js'
import { now, setNow } from '../src/clock.js'
import { query, tx } from '../src/db.js'
import { env } from '../src/env.js'
import { newId } from '../src/ids.js'
import { auditLedger } from '../src/inventory.js'
import { checkHealth } from '../src/maintenance.js'
import { enqueue, orderLinkFor, paramsFor, sendDueNotifications, templateFor } from '../src/notify.js'
import { consentKeyword, refusal } from '../src/wa/consent.js'
import { jitter, MESSAGE_RETRY_MINUTES, recordMessageStatus, replyType, sendDueMessages, WINDOW_MS, windowOpen } from '../src/wa/conversations.js'
import { bodyParams, graphProblem, readiness, syncTemplates, useMetaFetchForTests } from '../src/wa/meta-admin.js'
import { AUTOMATIONS, AUTOMATION_KINDS, automationFor } from '../src/wa/registry.js'
import { pruneWhatsApp } from '../src/wa/retention.js'
import { replayWebhookEvents } from '../src/webhook-events.js'
import { sendOutcome, verifyMetaSignature } from '../src/whatsapp.js'

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

const later = (ms) => setNow(new Date(now().getTime() + ms).toISOString())
const MIN = 60_000

/** A customer chatting from one number. `send` stands in for Meta. */
function chatter(waId = '919812345678', name = 'Asha') {
  const sent = []
  let send = async (to, r) => {
    sent.push({ to, r })
    return `wamid.out.${++seq}`
  }
  const say = (input, messageId = `wamid.in.${++seq}`, extra = {}) =>
    handleInbound({ waId, name, messageId, input: typeof input === 'string' ? { text: input } : input, ...extra }, { send: (...a) => send(...a) })
  return { say, sent, tap: (id) => say({ id }), phone: `+${waId}`, failWith: (f) => (send = f) }
}
const ids = (r) => (r.buttons ?? r.rows ?? []).map((x) => x.id)
const orderOf = async (phone) => (await query(`SELECT * FROM orders WHERE phone = $1 ORDER BY placed_at DESC LIMIT 1`, [phone])).rows[0]
const conv = async (phone) => (await query('SELECT * FROM wa_conversations WHERE phone = $1', [phone])).rows[0]
const msgs = async (phone, dir) =>
  (await query(`SELECT m.* FROM wa_messages m JOIN wa_conversations v ON v.id = m.conversation_id WHERE v.phone = $1 AND ($2::text IS NULL OR m.direction = $2) ORDER BY m.created_at, m.id`, [phone, dir ?? null])).rows

/** A chat order of two boxes, booked and waiting for payment. */
async function chatOrder(ch) {
  await ch.say('hi')
  await ch.tap('ORDER')
  await ch.say('560034')
  await ch.tap('item:ALP-3|RIPE')
  await ch.tap('qty:2')
  await ch.tap('CHECKOUT')
  await ch.say('12, 4th Cross, Koramangala, Bengaluru')
  const replies = await ch.tap('PAY')
  return { link: replies.at(-1), order: await orderOf(ch.phone) }
}

/** Razorpay's payment_link.paid for a chat order. */
const paidHook = (o, payId = 'pay_wa_1') =>
  signWebhook({
    event: 'payment_link.paid',
    payload: {
      payment_link: { entity: { id: o.payment_link_id, reference_id: o.number, notes: { orderId: o.id }, status: 'paid' } },
      payment: { entity: { id: payId, amount: o.total, method: 'upi', order_id: 'order_from_link' } },
    },
  })
const postRazorpay = ({ raw, signature }) => api.raw('POST', '/webhooks/razorpay', { raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature } })

const metaSign = (raw) => `sha256=${createHmac('sha256', env.WHATSAPP_APP_SECRET).update(raw).digest('hex')}`
const postMeta = (body, sig) => {
  const raw = JSON.stringify(body)
  return api.raw('POST', '/webhooks/whatsapp', { raw, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig ?? metaSign(raw) } })
}
const inbound = (from, message) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', contacts: [{ wa_id: from, profile: { name: 'Asha' } }], messages: [{ from, timestamp: '1760500000', ...message }] } }] }],
})
const statuses = (...st) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: { statuses: st } }] }] })
const accountChange = (field, value) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA1', changes: [{ field, value }] }] })

/** A sender stub for order updates (templates). */
function templateSender(behaviour = () => `wamid.tpl.${++seq}`) {
  const calls = []
  const sender = async (m) => {
    calls.push(m)
    return behaviour(m, calls.length)
  }
  return { sender, calls }
}
const notes = async (orderId) => (await query('SELECT * FROM notifications WHERE order_id = $1 ORDER BY created_at, id', [orderId])).rows
const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
const metaBusy = () => Object.assign(new Error('WhatsApp 503: busy'), { status: 503, permanent: false, outcome: 'retry' })

// ---------------------------------------------------------------- unit: rules without the database

describe('WhatsApp rules', () => {
  test('consent keywords are the whole message, never a word inside a sentence', () => {
    assert.deepEqual(consentKeyword('STOP'), { scope: 'all', action: 'OPT_OUT' })
    assert.deepEqual(consentKeyword('  Unsubscribe '), { scope: 'all', action: 'OPT_OUT' })
    assert.deepEqual(consentKeyword('stop offers'), { scope: 'marketing', action: 'OPT_OUT' })
    assert.deepEqual(consentKeyword('START'), { scope: 'updates', action: 'OPT_IN' })
    assert.deepEqual(consentKeyword('start offers'), { scope: 'marketing', action: 'OPT_IN' })
    assert.equal(consentKeyword("please don't stop my order"), null)
    assert.equal(consentKeyword('stop the delivery'), null)
    assert.equal(consentKeyword(''), null)
    assert.equal(consentKeyword(undefined), null)
  })

  test('consent: STOP blocks every business-started message; promotions need their own opt-in', () => {
    const none = { updates: 'ALLOWED', marketing: 'NONE' }
    assert.equal(refusal('ORDER_CONFIRMED', none), null)
    assert.match(refusal('ORDER_CONFIRMED', { updates: 'STOPPED', marketing: 'NONE' }), /STOP/)
    // A phone number or an account is not marketing consent.
    assert.match(refusal('REORDER_REMINDER', none), /no opt-in/)
    assert.equal(refusal('REORDER_REMINDER', none, { optIn: true }), null)
    assert.equal(refusal('REORDER_REMINDER', { updates: 'ALLOWED', marketing: 'OPTED_IN' }), null)
    // An opt-out wins over the shop setting.
    assert.match(refusal('REORDER_REMINDER', { updates: 'ALLOWED', marketing: 'OPTED_OUT' }, { optIn: true }), /opted out/)
  })

  test('each kind fills exactly the variables its registry entry names; order-link buttons match', () => {
    const n = {
      customer_name: 'Asha', number: 'ORD-1', delivery_date: '2026-10-16', starts_at: '07:00', ends_at: '11:00', delivery_code: '1234', gift_recipient_name: 'Ravi',
      items: [{ sku: 'ALP-3', stage: 'RAW' }], alert_sku: 'ALP-3', alert_stage: 'RIPE', alert_date: '2026-10-16', last_product: 'ALP-3', total: 100, payment_amount: 100,
      pre_qty: 1, pre_sku: 'ALP-3', week_start: '2026-10-19', payment_link_url: 'https://rzp.io/i/x', reward_kind: 'PERCENT', reward_amount: 10, reward_code: 'C', reward_ends_on: '2026-11-30',
      reward_min: 100, summary_params: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], help_number: 'HLP-1', help_ticket_id: 'hlp_1', sub_qty: 1, sub_sku: 'ALP-3', cycle_date: '2026-10-17', sub_id: 'sub_1',
      claim_reason: 'x', order_id: 'ord_1',
    }
    const saved = env.WHATSAPP_ORDER_LINKS
    try {
      for (const a of AUTOMATIONS) {
        // Partner and farm messages carry words fixed when queued (partner/alerts.js, farm/notify.js), one per variable.
        assert.equal(paramsFor({ ...n, kind: a.kind, partner_params: a.example, farm_params: a.example }).length, a.params.length, a.kind)
        env.WHATSAPP_ORDER_LINKS = false
        assert.equal(Boolean(orderLinkFor({ ...n, kind: a.kind })), a.button === 'order-link', `${a.kind} without the flag`)
        env.WHATSAPP_ORDER_LINKS = true
        assert.equal(Boolean(orderLinkFor({ ...n, kind: a.kind })), Boolean(a.button), `${a.kind} with the flag`)
      }
    } finally {
      env.WHATSAPP_ORDER_LINKS = saved
    }
  })

  test('STOP OFFERS also stops messages Meta bills as marketing', () => {
    const out = { updates: 'ALLOWED', marketing: 'OPTED_OUT' }
    assert.match(refusal('REVIEW_REQUEST', out), /opted out/)
    assert.match(refusal('REFERRAL_REWARD', out), /opted out/)
    assert.equal(refusal('REVIEW_REQUEST', { updates: 'ALLOWED', marketing: 'NONE' }), null)
    assert.equal(refusal('ORDER_CONFIRMED', out), null)
  })

  test('every notification kind has one registry entry with a template, category, consent class and variables', () => {
    const kinds = ['ORDER_CONFIRMED', 'REPLACEMENT_CONFIRMED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED', 'CANCELLED', 'REFUNDED', 'PREORDER_BOOKED', 'PREORDER_SPOT_OPEN',
      'PREORDER_MOVED', 'DATE_MOVED', 'GIFT_OUT_FOR_DELIVERY', 'RIPENESS_GUIDE', 'BACK_IN_STOCK', 'REORDER_REMINDER', 'REVIEW_REQUEST', 'CLAIM_RECEIVED', 'CLAIM_REJECTED',
      'REFERRAL_REWARD', 'MANAGER_DAILY_SUMMARY', 'HELP_REPLY', 'SUBSCRIPTION_DUE', 'PARTNER_ENQUIRY_RECEIVED', 'PARTNER_TEAM_ALERT',
      'FARM_BOOKING_UPDATE', 'FARM_TEAM_ALERT']
    assert.deepEqual([...AUTOMATION_KINDS].sort(), [...kinds].sort())
    assert.equal(new Set(AUTOMATION_KINDS).size, AUTOMATIONS.length)
    for (const a of AUTOMATIONS) {
      assert.ok(['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(a.category), a.kind)
      assert.ok(['updates', 'requested', 'marketing'].includes(a.consent), a.kind)
      assert.ok(Array.isArray(a.params) && a.params.length > 0, a.kind)
      assert.match(templateFor(a.kind), /^[a-z0-9_]+$/)
    }
    // Only the promotional reminder needs marketing consent.
    assert.deepEqual(AUTOMATIONS.filter((a) => a.consent === 'marketing').map((a) => a.kind), ['REORDER_REMINDER'])
    assert.equal(automationFor('NOPE'), null)
  })

  test('send outcomes: a refusal is permanent, "not now" is retried, no answer is unknown (never resent)', () => {
    assert.equal(sendOutcome(Object.assign(new Error('x'), { status: 400, permanent: true })), 'permanent')
    assert.equal(sendOutcome(Object.assign(new Error('x'), { status: 429, permanent: false })), 'retry')
    assert.equal(sendOutcome(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), 'retry')
    assert.equal(sendOutcome(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), 'retry')
    assert.equal(sendOutcome(timeout()), 'unknown')
    assert.equal(sendOutcome(Object.assign(new Error('aborted'), { name: 'AbortError' })), 'unknown')
    assert.equal(sendOutcome(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), 'unknown')
    assert.equal(sendOutcome(new TypeError('fetch failed')), 'unknown')
    // Raised by our own code, not on the wire: nothing reached Meta, so a retry is safe.
    assert.equal(sendOutcome(new Error('something odd')), 'retry')
  })

  test('the signature is an HMAC of the exact body with the app secret', () => {
    const raw = Buffer.from('{"a":1}')
    assert.equal(verifyMetaSignature(raw, metaSign(raw)), true)
    assert.equal(verifyMetaSignature(Buffer.from('{"a":2}'), metaSign(raw)), false)
    assert.equal(verifyMetaSignature(raw, 'sha256=xyz'), false)
    assert.equal(verifyMetaSignature(raw, undefined), false)
    assert.equal(verifyMetaSignature(raw, metaSign(raw), ''), false)
  })

  test('the 24-hour window, reply types, retry jitter', () => {
    const at = new Date('2026-10-15T10:00:00Z')
    assert.equal(windowOpen({ last_inbound_at: new Date(at.getTime() - WINDOW_MS + 1000) }, at), true)
    assert.equal(windowOpen({ last_inbound_at: new Date(at.getTime() - WINDOW_MS) }, at), false)
    assert.equal(windowOpen({ last_inbound_at: null }, at), false)
    assert.equal(replyType({ type: 'buttons' }), 'interactive')
    assert.equal(replyType({ type: 'pay' }), 'order_details')
    assert.equal(replyType({ type: 'text' }), 'text')
    assert.equal(jitter(60_000, 0.25, () => 0), 60_000)
    assert.equal(jitter(60_000, 0.25, () => 1), 75_000)
    assert.deepEqual(MESSAGE_RETRY_MINUTES, [1, 2, 5])
  })

  test('inbound parsing: taps, buttons, welcome, media without URLs, locations', () => {
    assert.deepEqual(inputOf({ type: 'interactive', interactive: { button_reply: { id: 'PAY', title: 'Pay' } } }), { id: 'PAY', title: 'Pay' })
    assert.deepEqual(inputOf({ type: 'button', button: { payload: 'ORDERS', text: 'My orders' } }), { id: 'ORDERS', text: 'My orders' })
    assert.deepEqual(inputOf({ type: 'request_welcome' }), { text: 'hi' })
    const img = mediaOf({ type: 'image', image: { id: 'm1', mime_type: 'image/jpeg', sha256: 'abc', caption: 'broken box', url: 'https://evil.example/x' } })
    assert.deepEqual(img, { id: 'm1', mime: 'image/jpeg', sha256: 'abc', filename: null, caption: 'broken box', voice: false })
    assert.equal(mediaOf({ type: 'image', image: { id: '../../etc' } }), null)
    assert.deepEqual(mediaOf({ type: 'location', location: { latitude: '12.9', longitude: 77.6, name: 'Home' } }), { latitude: 12.9, longitude: 77.6, name: 'Home', address: null })
  })

  test('Graph API problems in operator terms; template variables counted once each', () => {
    assert.equal(graphProblem(401, { error: { code: 190 } }), 'invalid_token')
    assert.equal(graphProblem(403, { error: { code: 200 } }), 'insufficient_permissions')
    assert.equal(graphProblem(400, { error: { code: 100 } }), 'invalid_configuration')
    assert.equal(graphProblem(429, { error: { code: 80007 } }), 'rate_limited')
    assert.equal(graphProblem(503, {}), 'unavailable')
    assert.equal(graphProblem(0, null, new Error('down')), 'unavailable')
    assert.equal(bodyParams([{ type: 'BODY', text: 'Hi {{1}}, order {{2}} on {{3}}. {{1}} again' }]), 3)
    assert.equal(bodyParams([]), 0)
  })

  test('readiness lists what is missing and never shows a secret', () => {
    const r = readiness()
    assert.equal(r.complete, false)
    assert.ok(r.missing.includes('WHATSAPP_PROVIDER'))
    const text = JSON.stringify(r)
    assert.ok(!text.includes(env.WHATSAPP_APP_SECRET))
    assert.ok(!text.includes(env.WHATSAPP_VERIFY_TOKEN))
  })
})

// ---------------------------------------------------------------- end-to-end scenarios (docs/whatsapp/TESTS.md)

describe('WhatsApp end to end', () => {
  test('E1, E3, E12: a chat order is booked through the normal checkout, paid by link, and its confirmation is queued once', async () => {
    const ch = chatter()
    const { link, order } = await chatOrder(ch)
    assert.equal(link.type, 'link')
    assert.equal(order.status, 'PAYMENT_PENDING')
    assert.equal(order.channel, 'whatsapp')
    // E1 at booking: no message before payment (the link is a chat reply, not an update).
    assert.deepEqual((await notes(order.id)).map((n) => n.kind), [])
    // E3: Razorpay's verified webhook confirms the order and queues the confirmation.
    assert.equal((await postRazorpay(paidHook(order))).status, 200)
    assert.equal((await orderOf(ch.phone)).status, 'CONFIRMED')
    const n = await notes(order.id)
    assert.deepEqual(n.map((x) => [x.kind, x.status]), [['ORDER_CONFIRMED', 'PENDING']])
    // Sent through the template sender with the order's variables; recorded in the conversation.
    const t = templateSender()
    assert.equal(await sendDueNotifications({ sender: t.sender }), 1)
    assert.equal(t.calls[0].template, templateFor('ORDER_CONFIRMED'))
    assert.equal(t.calls[0].phone, ch.phone)
    assert.ok(t.calls[0].params.includes(order.number))
    const out = (await msgs(ch.phone, 'OUT')).filter((m) => m.type === 'template')
    assert.equal(out.length, 1)
    assert.equal(out[0].template, templateFor('ORDER_CONFIRMED'))
    assert.equal(out[0].provider_id, t.calls.length ? (await notes(order.id))[0].provider_id : null)
  })

  test('E2: the same payment event twice (and a redelivered webhook) gives one confirmation', async () => {
    const ch = chatter()
    const { order } = await chatOrder(ch)
    const hook = paidHook(order)
    assert.equal((await postRazorpay(hook)).status, 200)
    assert.equal((await postRazorpay(hook)).status, 200)
    const again = paidHook(order, 'pay_wa_1') // same payment, re-signed body
    assert.equal((await postRazorpay(again)).status, 200)
    assert.deepEqual((await notes(order.id)).map((n) => n.kind), ['ORDER_CONFIRMED'])
    const t = templateSender()
    await sendDueNotifications({ sender: t.sender })
    await sendDueNotifications({ sender: t.sender })
    assert.equal(t.calls.length, 1)
  })

  test('E4: a webhook without a valid signature is refused and nothing is stored or processed', async () => {
    const body = inbound('919812345678', { id: 'wamid.forged', type: 'text', text: { body: 'hi' } })
    assert.equal((await postMeta(body, `sha256=${'0'.repeat(64)}`)).status, 401)
    assert.equal((await postMeta(body, 'nope')).status, 401)
    const raw = JSON.stringify(body)
    assert.equal((await api.raw('POST', '/webhooks/whatsapp', { raw, headers: { 'Content-Type': 'application/json' } })).status, 401)
    // A body changed after signing.
    const sig = metaSign(raw)
    assert.equal((await api.raw('POST', '/webhooks/whatsapp', { raw: raw.replace('hi', 'yo'), headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig } })).status, 401)
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM webhook_events WHERE provider = 'whatsapp'`)).rows[0].n, 0)
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM wa_messages')).rows[0].n, 0)
    // The verify token check is separate and is not a substitute for the signature.
    assert.equal((await api.get(`/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${env.WHATSAPP_VERIFY_TOKEN}&hub.challenge=7`)).status, 200)
  })

  test('E5: an inbound message delivered twice is recorded and answered once', async () => {
    const body = inbound('919812345678', { id: 'wamid.dup1', type: 'text', text: { body: 'hi' } })
    const a = await postMeta(body)
    const b = await postMeta(body)
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    await drainBackground()
    const all = await msgs('+919812345678')
    assert.equal(all.filter((m) => m.direction === 'IN').length, 1)
    assert.equal(all.filter((m) => m.direction === 'OUT').length, 1)
    assert.equal(all.find((m) => m.direction === 'OUT').status, 'SENT')
    // Each stored event carries its own row; the message rows carry the event id they came from.
    const ev = (await query(`SELECT id FROM webhook_events WHERE provider = 'whatsapp' AND processed_at IS NOT NULL`)).rows
    assert.equal(ev.length, 1, 'a byte-identical redelivery is one stored event')
    assert.equal(all.find((m) => m.direction === 'IN').correlation_id, ev[0].id)
  })

  test("E6, E7: an order number typed in the chat is answered from that customer's own order, never another's", async () => {
    const asha = chatter('919812345678', 'Asha')
    const { order } = await chatOrder(asha)
    await postRazorpay(paidHook(order))
    const [mine] = await asha.say(`where is ${order.number}?`)
    assert.match(mine.text, new RegExp(`\\*${order.number}\\*: Confirmed`))
    assert.match(mine.text, /paid/)
    const [money] = await asha.say('was my payment received')
    assert.match(money.text, new RegExp(`${order.number}\\*: paid`))

    const ravi = chatter('919800000001', 'Ravi')
    await ravi.say('hi')
    const [theirs] = await ravi.say(`status of ${order.number}`)
    assert.match(theirs.text, /can't find/)
    assert.doesNotMatch(theirs.text, /Koramangala|Asha|Rs /)
    const [list] = await ravi.say('my orders')
    assert.doesNotMatch(JSON.stringify(list), new RegExp(order.number))
  })

  test('E8: STOP OFFERS blocks promotional messages; STOP blocks every update; START brings updates back', async () => {
    const ch = chatter()
    const { order } = await chatOrder(ch)
    await postRazorpay(paidHook(order))
    await query(`UPDATE customers SET reminders_opt_in = TRUE WHERE phone = $1`, [ch.phone])
    const [r] = await ch.say('STOP OFFERS')
    assert.match(r.text, /no more offers/)
    assert.equal((await query('SELECT reminders_opt_in FROM customers WHERE phone = $1', [ch.phone])).rows[0].reminders_opt_in, false)
    await tx((c) => enqueue(c, order.id, newId('rr'), 'REORDER_REMINDER'))
    const t = templateSender()
    await sendDueNotifications({ sender: t.sender })
    assert.deepEqual(t.calls.map((x) => x.template), [templateFor('ORDER_CONFIRMED')], 'only the order update went')
    const rem = (await notes(order.id)).find((n) => n.kind === 'REORDER_REMINDER')
    assert.equal(rem.status, 'SKIPPED')
    assert.match(rem.last_error, /opted out/)

    // STOP: even order updates stop (checked at send time, after it was queued).
    await tx((c) => enqueue(c, order.id, newId('mov'), 'DATE_MOVED'))
    await ch.say('stop')
    await sendDueNotifications({ sender: t.sender })
    assert.equal(t.calls.length, 1)
    assert.match((await notes(order.id)).find((n) => n.kind === 'DATE_MOVED').last_error, /STOP/)
    // The bot still answers the customer's own messages after STOP.
    const [menu] = await ch.say('hi')
    assert.deepEqual(ids(menu), ['ORDER', 'BOOK', 'ORDERS'])

    await ch.say('START')
    await tx((c) => enqueue(c, order.id, newId('mov'), 'DATE_MOVED'))
    await sendDueNotifications({ sender: t.sender })
    assert.equal(t.calls.at(-1).template, templateFor('DATE_MOVED'))
    // Marketing stays off after START: it has its own opt-in.
    const c = (await query('SELECT * FROM wa_consent WHERE phone = $1', [ch.phone])).rows[0]
    assert.deepEqual([c.updates, c.marketing], ['ALLOWED', 'OPTED_OUT'])
    const events = (await query('SELECT scope, action, source, evidence FROM wa_consent_events WHERE phone = $1 ORDER BY created_at, id', [ch.phone])).rows
    // STOP records both scopes at the same moment, so compare as a set.
    assert.deepEqual(events.map((e) => `${e.scope}:${e.action}:${e.source}`).sort(), ['marketing:OPT_OUT:whatsapp_keyword', 'marketing:OPT_OUT:whatsapp_keyword', 'updates:OPT_IN:whatsapp_keyword', 'updates:OPT_OUT:whatsapp_keyword'])
    assert.ok(events.every((e) => /^wamid\./.test(e.evidence)))
  })

  test('E8: no reminder without an opt-in; the shop setting is recorded as consent with its request id', async () => {
    const cust = await customerToken(api, '9812345678')
    const ch = chatter()
    const { order } = await chatOrder(ch)
    await postRazorpay(paidHook(order))
    await tx((c) => enqueue(c, order.id, newId('rr'), 'REORDER_REMINDER'))
    const t = templateSender()
    await sendDueNotifications({ sender: t.sender })
    assert.match((await notes(order.id)).find((n) => n.kind === 'REORDER_REMINDER').last_error, /no opt-in/)

    const on = await api.patch('/v1/me', { remindersOptIn: true }, { token: cust.accessToken })
    assert.equal(on.status, 200)
    const ev = (await query('SELECT * FROM wa_consent_events WHERE phone = $1', [ch.phone])).rows
    assert.equal(ev.length, 1)
    assert.deepEqual([ev[0].scope, ev[0].action, ev[0].source], ['marketing', 'OPT_IN', 'shop_account'])
    assert.equal(ev[0].evidence, `request ${on.headers.get('x-request-id')}`)
    // The same value again records nothing new.
    await api.patch('/v1/me', { remindersOptIn: true }, { token: cust.accessToken })
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM wa_consent_events WHERE phone = $1', [ch.phone])).rows[0].n, 1)
    await tx((c) => enqueue(c, order.id, newId('rr'), 'REORDER_REMINDER'))
    await sendDueNotifications({ sender: t.sender })
    assert.equal(t.calls.at(-1).template, templateFor('REORDER_REMINDER'))
    await api.patch('/v1/me', { remindersOptIn: false }, { token: cust.accessToken })
    assert.equal((await query('SELECT marketing FROM wa_consent WHERE phone = $1', [ch.phone])).rows[0].marketing, 'OPTED_OUT')
  })

  test('E9: outside the 24-hour window free-form messages are refused before Meta is called', async () => {
    const ch = chatter()
    await ch.say('hi')
    const admin = await adminToken(api)
    const c = await conv(ch.phone)
    later(WINDOW_MS + MIN)
    const reply = await api.post(`/admin/v1/whatsapp/conversations/${c.id}/reply`, { text: 'Hello again' }, { token: admin })
    assert.equal(reply.status, 409)
    assert.equal(reply.body.error.code, 'WINDOW_CLOSED')
    // A reply queued inside the window but not sent until after it is not sent either.
    setNow(T0)
    const late = newId('wam')
    await tx(async (cl) => cl.query(`INSERT INTO wa_messages (id, conversation_id, direction, type, body, payload, author, status, next_attempt_at, created_at) VALUES ($1, $2, 'OUT', 'text', 'x', '{"type":"text","text":"x"}', 'bot', 'QUEUED', $3, $3)`, [late, c.id, now()]))
    later(WINDOW_MS + MIN)
    let calls = 0
    await sendDueMessages(async () => (calls++, 'wamid.never'))
    assert.equal(calls, 0)
    const failed = (await msgs(ch.phone, 'OUT')).find((x) => x.id === late)
    assert.equal(failed.status, 'FAILED')
    assert.match(failed.error, /WINDOW_CLOSED/)
    // Order updates are templates and still go after the window closes.
    assert.equal(windowOpen(await conv(ch.phone)), false)
  })

  test('E10: a reply Meta could not take now is retried, then sent once', async () => {
    const ch = chatter()
    ch.failWith(async () => {
      throw metaBusy()
    })
    await ch.say('hi')
    const [m] = await msgs(ch.phone, 'OUT')
    assert.equal(m.status, 'QUEUED')
    assert.equal(m.attempts, 1)
    const wait = new Date(m.next_attempt_at).getTime() - now().getTime()
    assert.ok(Math.abs(wait - MESSAGE_RETRY_MINUTES[0] * MIN) < 1000, String(wait))
    // Not due yet: nothing is sent.
    let calls = 0
    const ok = async () => (calls++, 'wamid.retry.ok')
    assert.equal(await sendDueMessages(ok), 0)
    later(MIN + 1000)
    assert.equal(await sendDueMessages(ok), 1)
    assert.equal(await sendDueMessages(ok), 0)
    assert.equal(calls, 1)
    const [sent] = await msgs(ch.phone, 'OUT')
    assert.deepEqual([sent.status, sent.provider_id, sent.attempts, sent.payload], ['SENT', 'wamid.retry.ok', 2, null])

    // Order updates: a 503 is retried on the existing back-off; a 400 refusal is not.
    const { order } = await chatOrder(chatter('919800000002'))
    await postRazorpay(paidHook(order, 'pay_e10'))
    const t = templateSender((_, n) => {
      if (n === 1) throw metaBusy()
      return 'wamid.tpl.ok'
    })
    await sendDueNotifications({ sender: t.sender })
    assert.equal((await notes(order.id))[0].status, 'PENDING')
    later(2 * MIN)
    await sendDueNotifications({ sender: t.sender })
    assert.deepEqual([(await notes(order.id))[0].status, t.calls.length], ['SENT', 2])
  })

  test('E11: no answer from Meta in time is never resent automatically; staff can send it again', async () => {
    const ch = chatter()
    ch.failWith(async () => {
      throw timeout()
    })
    await ch.say('hi')
    const [m] = await msgs(ch.phone, 'OUT')
    assert.equal(m.status, 'UNKNOWN')
    assert.match(m.error, /not resent automatically/)
    let calls = 0
    later(30 * MIN)
    await sendDueMessages(async () => (calls++, 'x'))
    assert.equal(calls, 0)

    // The same for an order update: one call, then FAILED as unknown, never a second call.
    const { order } = await chatOrder(chatter('919800000003'))
    await postRazorpay(paidHook(order, 'pay_e11'))
    const t = templateSender(() => {
      throw timeout()
    })
    await sendDueNotifications({ sender: t.sender })
    later(4 * 60 * MIN)
    await sendDueNotifications({ sender: t.sender })
    assert.equal(t.calls.length, 1)
    const [n] = await notes(order.id)
    assert.deepEqual([n.status, n.delivery_status], ['FAILED', 'unknown'])

    // A person decides: the failures list shows it; Send again queues it once.
    const admin = await adminToken(api)
    const f = await api.get('/admin/v1/whatsapp/failures', { token: admin })
    assert.equal(f.status, 200)
    assert.ok(f.body.updates.some((u) => u.id === n.id && u.unknown))
    assert.ok(f.body.messages.some((x) => x.id === m.id && x.status === 'UNKNOWN'))
    assert.ok(!JSON.stringify(f.body).includes('9812345678'), 'phones are masked')
    setNow(new Date(Date.parse(T0) + MIN).toISOString())
    const again = await api.post(`/admin/v1/whatsapp/messages/${m.id}/retry`, {}, { token: admin })
    assert.equal(again.status, 202)
    await drainBackground()
    assert.equal((await msgs(ch.phone, 'OUT'))[0].status, 'SENT')
    assert.equal((await api.post(`/admin/v1/notifications/${n.id}/retry`, {}, { token: admin })).status, 204)
    const back = (await notes(order.id))[0]
    assert.deepEqual([back.status, back.delivery_status], ['PENDING', null])
  })

  test('E13: a customer asking for a person is handed to staff; the bot stays quiet until staff hand back', async () => {
    const ch = chatter()
    await ch.say('hi')
    const [h] = await ch.say('I want to talk to a person')
    assert.match(h.text, /a person from our team will reply/)
    let c = await conv(ch.phone)
    assert.deepEqual([c.mode, c.status], ['STAFF', 'WAITING'])
    assert.ok(c.waiting_since)
    // While staff hold it, nothing the customer says gets a bot answer (order words included).
    assert.deepEqual(await ch.say('ORDER'), [])
    assert.deepEqual(await ch.say('hi'), [])
    c = await conv(ch.phone)
    assert.ok(c.unread >= 2)

    const admin = await adminToken(api)
    const list = await api.get('/admin/v1/whatsapp/conversations?view=waiting', { token: admin })
    assert.equal(list.status, 200)
    assert.equal(list.body.conversations.length, 1)
    assert.equal(list.body.conversations[0].phone, '•••• 5678')
    assert.equal(list.body.counts.waiting, 1)
    const reply = await api.post(`/admin/v1/whatsapp/conversations/${c.id}/reply`, { text: 'Hi Asha, Meena here. How can I help?' }, { token: admin })
    assert.equal(reply.status, 201, JSON.stringify(reply.body))
    assert.equal(reply.body.conversation.status, 'OPEN')
    assert.equal(reply.body.conversation.mode, 'STAFF')
    await drainBackground()
    const staffMsg = (await msgs(ch.phone, 'OUT')).at(-1)
    assert.match(staffMsg.author, /^staff:/)
    assert.equal(staffMsg.status, 'SENT')
    const audit = (await query(`SELECT action, target FROM staff_audit WHERE action = 'REPLY WhatsApp'`)).rows
    assert.deepEqual(audit, [{ action: 'REPLY WhatsApp', target: c.id }])

    // Staff hand back: the bot answers again from the menu.
    assert.equal((await api.post(`/admin/v1/whatsapp/conversations/${c.id}/hand-back`, {}, { token: admin })).status, 200)
    const [menu] = await ch.say('hi')
    assert.deepEqual(ids(menu), ['ORDER', 'BOOK', 'ORDERS'])

    // A photo goes to a person straight away (a damaged box, say).
    await ch.say({ text: '' }, 'wamid.photo', { type: 'image', media: { id: 'media1', mime: 'image/jpeg', caption: 'box broken' } })
    assert.equal((await conv(ch.phone)).status, 'WAITING')
  })

  test('E13: staff take over, assign, close, record an opt-out; packers cannot see chats', async () => {
    const ch = chatter()
    await ch.say('hi')
    const c = await conv(ch.phone)
    const admin = await adminToken(api)
    const t = await api.post(`/admin/v1/whatsapp/conversations/${c.id}/take-over`, {}, { token: admin })
    assert.equal(t.status, 200)
    assert.equal(t.body.conversation.mode, 'STAFF')
    assert.deepEqual(await ch.say('ORDER'), [])
    const bad = await api.post(`/admin/v1/whatsapp/conversations/${c.id}/assign`, { adminId: 'adm_nobody' }, { token: admin })
    assert.equal(bad.status, 400)
    const opt = await api.post(`/admin/v1/whatsapp/conversations/${c.id}/opt-out`, { scope: 'marketing' }, { token: admin })
    assert.equal(opt.status, 200)
    assert.equal(opt.body.consent.marketing, 'OPTED_OUT')
    // Staff can't opt a customer in.
    assert.equal((await api.post(`/admin/v1/whatsapp/conversations/${c.id}/opt-out`, { scope: 'updates' }, { token: admin })).status, 400)
    const closed = await api.post(`/admin/v1/whatsapp/conversations/${c.id}/close`, {}, { token: admin })
    assert.deepEqual([closed.body.conversation.mode, closed.body.conversation.status], ['BOT', 'CLOSED'])
    // A new message reopens it, and the bot answers.
    const [menu] = await ch.say('hi')
    assert.ok(menu)
    assert.equal((await conv(ch.phone)).status, 'OPEN')
    // Opening a conversation is a recorded read.
    const detail = await api.get(`/admin/v1/whatsapp/conversations/${c.id}`, { token: admin })
    assert.equal(detail.status, 200)
    assert.ok(detail.body.messages.length >= 2)

    const packer = await adminToken(api, 'packer@mandimangoes.test', 'packer123')
    assert.equal((await api.get('/admin/v1/whatsapp/conversations', { token: packer })).status, 403)
    const operator = await adminToken(api, 'ops@mandimangoes.test', 'operator123')
    assert.equal((await api.get('/admin/v1/whatsapp/conversations', { token: operator })).status, 200)
    assert.equal((await api.get('/admin/v1/whatsapp/overview', { token: operator })).status, 403)
  })

  test('E14: a chat order whose hold ran out becomes no order: its stock goes to the next buyer, and Pay does not reuse the old link', async () => {
    const ch = chatter()
    const { order, link } = await chatOrder(ch)
    // Someone else takes the rest of the stock.
    const other = await customerToken(api)
    assert.equal((await checkout(api, other.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 8 }])).status, 201)
    // Past the hold and its grace period: a third buyer gets the chat order's 2 boxes.
    later((Number((await query('SELECT EXTRACT(EPOCH FROM hold_expires_at - placed_at)::int AS s FROM orders WHERE id = $1', [order.id])).rows[0].s) + 180) * 1000)
    const third = await customerToken(api)
    assert.equal((await checkout(api, third.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 2 }])).status, 201)
    assert.equal((await query('SELECT status FROM orders WHERE id = $1', [order.id])).rows[0].status, 'CANCELLED')
    // Tapping Pay again books afresh, finds no stock, and sends no link.
    const replies = await ch.tap('PAY')
    assert.ok(replies.every((r) => r.url !== link.url && r.type !== 'link'), JSON.stringify(replies))
    assert.match(replies.map((r) => r.text).join(' '), /sold out|pick again|would you like to do/i)
    const all = (await query(`SELECT status FROM orders WHERE phone = $1`, [ch.phone])).rows
    assert.deepEqual(all.map((r) => r.status), ['CANCELLED'])
    assert.deepEqual(await auditLedger({ query }), [])
    const batch = (await query(`SELECT batch_id FROM batch_lines WHERE sku = 'ALP-3' LIMIT 1`)).rows[0].batch_id
    const l = await line(batch, 'ALP-3')
    assert.ok(l.held + l.committed <= l.on_hand)
  })

  test("E15: Meta being down doesn't stop the shop, payments or the webhook", async () => {
    const ch = chatter()
    ch.failWith(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    })
    // The chat still books the order (replies wait in the outbox).
    const { order } = await chatOrder(ch)
    assert.equal(order.status, 'PAYMENT_PENDING')
    assert.ok((await msgs(ch.phone, 'OUT')).every((m) => m.status === 'QUEUED'))
    // The shop checks out and Razorpay confirms payments.
    const shopper = await customerToken(api)
    const shop = await checkout(api, shopper.accessToken, [{ sku: 'ALP-3', stage: 'RIPE', qty: 1 }])
    assert.equal(shop.status, 201)
    assert.equal((await postRazorpay(paidHook(order, 'pay_e15'))).status, 200)
    assert.equal((await orderOf(ch.phone)).status, 'CONFIRMED')
    // Order updates wait and retry; nothing is lost.
    const t = templateSender(() => {
      throw metaBusy()
    })
    await sendDueNotifications({ sender: t.sender })
    assert.equal((await notes(order.id))[0].status, 'PENDING')
    // The webhook still answers Meta fast (inbound handled, replies queued).
    const r = await postMeta(inbound('919800000009', { id: 'wamid.e15', type: 'text', text: { body: 'hi' } }))
    assert.equal(r.status, 200)
    // The health check says so: chat replies and order updates are overdue.
    later(20 * MIN)
    const problems = await checkHealth()
    assert.ok(problems.includes('whatsapp-chat-overdue'), problems.join())
    assert.ok(problems.includes('messages'), problems.join())
  })
})

// ---------------------------------------------------------------- statuses, events, set-up

describe('WhatsApp statuses, account events and set-up', () => {
  test('delivery statuses arrive late, twice or out of order and never move a message backwards', async () => {
    const ch = chatter()
    await ch.say('hi')
    const [m] = await msgs(ch.phone, 'OUT')
    const pid = m.provider_id
    assert.ok(pid)
    const r1 = await postMeta(statuses({ id: pid, status: 'read', timestamp: '1760500100' }))
    assert.equal(r1.status, 200)
    await postMeta(statuses({ id: pid, status: 'delivered', timestamp: '1760500050' }))
    assert.equal((await msgs(ch.phone, 'OUT'))[0].status, 'READ')
    // A failed after read is not believed; failed before read is.
    assert.equal(await recordMessageStatus({ id: pid, status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] }), 0)
    await ch.say('hi again')
    const second = (await msgs(ch.phone, 'OUT')).at(-1)
    assert.equal(await recordMessageStatus({ id: second.provider_id, status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] }), 1)
    assert.match((await msgs(ch.phone, 'OUT')).at(-1).error, /131026/)
    assert.equal(await recordMessageStatus({ id: 'unknown', status: 'nonsense' }), 0)
  })

  test('a paused template stops its messages at once; its quality and the number quality are recorded', async () => {
    const ch = chatter()
    const { order } = await chatOrder(ch)
    const r = await postMeta(accountChange('message_template_status_update', {
      event: 'PAUSED', message_template_id: 123, message_template_name: templateFor('ORDER_CONFIRMED'), message_template_language: env.WHATSAPP_LANGUAGE, reason: 'LOW QUALITY', extra: 'dropped',
    }))
    assert.equal(r.status, 200)
    assert.equal(r.body.handled, 1)
    await postRazorpay(paidHook(order))
    const t = templateSender()
    await sendDueNotifications({ sender: t.sender })
    assert.equal(t.calls.length, 0)
    assert.match((await notes(order.id))[0].last_error, /PAUSED at Meta/)
    await postMeta(accountChange('phone_number_quality_update', { display_phone_number: '15550001111', event: 'DOWNGRADE', current_limit: 'TIER_1K' }))
    await postMeta(accountChange('some_new_field', { anything: true }))
    const ev = (await query('SELECT field, event, detail FROM wa_account_events ORDER BY created_at, id')).rows
    assert.deepEqual(ev.map((e) => [e.field, e.event]), [['message_template_status_update', 'PAUSED'], ['phone_number_quality_update', 'DOWNGRADE']])
    assert.equal(ev[0].detail.extra, undefined, 'unknown keys are dropped')
    // A template with the wrong number of variables is stopped before Meta is called.
    await query(`UPDATE wa_templates SET status = 'APPROVED', body_params = 9`)
    await query(`UPDATE notifications SET status = 'PENDING', next_attempt_at = $1 WHERE order_id = $2`, [now(), order.id])
    await sendDueNotifications({ sender: t.sender })
    assert.equal(t.calls.length, 0)
    assert.match((await notes(order.id))[0].last_error, /takes 9 variables/)
  })

  test('a manager switches an automated message off; it is skipped and audited', async () => {
    const ch = chatter()
    const { order } = await chatOrder(ch)
    const admin = await adminToken(api)
    const off = await api.put('/admin/v1/whatsapp/automations/ORDER_CONFIRMED', { enabled: false }, { token: admin })
    assert.equal(off.status, 200, JSON.stringify(off.body))
    assert.equal(off.body.automations.find((a) => a.kind === 'ORDER_CONFIRMED').state, 'OFF')
    assert.equal((await api.put('/admin/v1/whatsapp/automations/NOT_A_KIND', { enabled: false }, { token: admin })).status, 404)
    await postRazorpay(paidHook(order))
    const t = templateSender()
    await sendDueNotifications({ sender: t.sender })
    assert.equal(t.calls.length, 0)
    assert.match((await notes(order.id))[0].last_error, /turned off/)
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM staff_audit WHERE action = 'SWITCH WhatsApp automation'`)).rows[0].n, 1)
  })

  test('template sync reads every page from Meta, counts variables, and reports what each message waits on', async () => {
    const saved = { token: env.WHATSAPP_TOKEN, waba: env.WHATSAPP_BUSINESS_ACCOUNT_ID }
    env.WHATSAPP_TOKEN = 'test-token-not-real'
    env.WHATSAPP_BUSINESS_ACCOUNT_ID = '1234567890'
    const urls = []
    const prev = useMetaFetchForTests(async (url, init) => {
      urls.push(String(url))
      assert.equal(init.headers.Authorization, 'Bearer test-token-not-real')
      if (String(url).includes('after=page2')) {
        return Response.json({ data: [{ name: templateFor('DELIVERED'), language: env.WHATSAPP_LANGUAGE, status: 'PENDING', category: 'UTILITY', components: [{ type: 'BODY', text: '{{1}}' }] }] })
      }
      return Response.json({
        data: [{ name: templateFor('ORDER_CONFIRMED'), language: env.WHATSAPP_LANGUAGE, status: 'APPROVED', category: 'UTILITY', id: '99', components: [{ type: 'BODY', text: 'Hi {{1}} {{2}}' }] }, { name: 'BAD NAME', language: 'en' }],
        paging: { next: 'https://graph.facebook.com/v21.0/1234567890/message_templates?after=page2' },
      })
    })
    try {
      const report = await syncTemplates()
      assert.equal(urls.length, 2)
      assert.equal(report.synced, true)
      const by = new Map(report.automations.map((a) => [a.kind, a]))
      const expectOk = automationFor('ORDER_CONFIRMED').params.length === 2 ? 'READY' : 'VARIABLES_MISMATCH'
      assert.equal(by.get('ORDER_CONFIRMED').state, expectOk)
      assert.equal(by.get('DELIVERED').state, 'AWAITING_APPROVAL')
      assert.equal(by.get('REFUNDED').state, 'AWAITING_TEMPLATE')
      assert.equal((await query('SELECT COUNT(*)::int AS n FROM wa_templates')).rows[0].n, 2)
      // A next page off Meta's host is not followed.
      urls.length = 0
      useMetaFetchForTests(async (url) => (urls.push(String(url)), Response.json({ data: [], paging: { next: 'https://evil.example/steal' } })))
      await syncTemplates()
      assert.deepEqual(urls.length, 1)
      // A bad token is reported in operator terms.
      useMetaFetchForTests(async () => Response.json({ error: { code: 190, message: 'Invalid OAuth access token' } }, { status: 401 }))
      await assert.rejects(syncTemplates(), /invalid_token/)
    } finally {
      useMetaFetchForTests(prev)
      env.WHATSAPP_TOKEN = saved.token
      env.WHATSAPP_BUSINESS_ACCOUNT_ID = saved.waba
    }
  })

  test('set-up page: managers see readiness and run the connection check; operators get the inbox only', async () => {
    const admin = await adminToken(api)
    const o = await api.get('/admin/v1/whatsapp/overview', { token: admin })
    assert.equal(o.status, 200)
    assert.equal(o.body.readiness.complete, false)
    assert.equal(o.body.templates.automations.length, AUTOMATIONS.length)
    assert.ok(!JSON.stringify(o.body).includes(env.WHATSAPP_APP_SECRET))
    const check = await api.post('/admin/v1/whatsapp/check', {}, { token: admin })
    assert.equal(check.status, 200)
    assert.deepEqual([check.body.ok, check.body.phone.problem], [false, 'missing_credentials'])
    assert.equal((await api.get('/admin/v1/whatsapp/overview', { token: admin })).body.lastCheck.ok, false)
    assert.equal((await api.post('/admin/v1/whatsapp/templates/sync', {}, { token: admin })).status, 409)
  })

  test('media is fetched from Meta for staff, never linked; types and hosts are checked', async () => {
    const ch = chatter()
    await ch.say({ text: 'see this' }, 'wamid.img1', { type: 'image', media: { id: 'media77', mime: 'image/jpeg' } })
    const [m] = await msgs(ch.phone, 'IN')
    const admin = await adminToken(api)
    // Without the provider set up: a clear message, no call.
    assert.equal((await api.get(`/admin/v1/whatsapp/media/${m.id}`, { token: admin })).status, 409)
    const saved = { p: env.WHATSAPP_PROVIDER, t: env.WHATSAPP_TOKEN }
    env.WHATSAPP_PROVIDER = 'meta'
    env.WHATSAPP_TOKEN = 'test-token-not-real'
    let host = 'https://lookaside.fbsbx.whatsapp.net/file'
    let mime = 'image/jpeg'
    const prev = useMetaFetchForTests(async (url) => {
      if (String(url).includes('media77')) return Response.json({ url: host, mime_type: mime, file_size: 4 })
      return new Response(Buffer.from([1, 2, 3, 4]), { status: 200 })
    })
    try {
      const ok = await api.raw('GET', `/admin/v1/whatsapp/media/${m.id}`, { token: admin })
      assert.equal(ok.status, 200)
      assert.equal(ok.headers.get('content-type'), 'image/jpeg')
      assert.equal(ok.headers.get('cache-control'), 'private, no-store')
      assert.equal(ok.headers.get('x-content-type-options'), 'nosniff')
      host = 'https://evil.example/file'
      assert.equal((await api.get(`/admin/v1/whatsapp/media/${m.id}`, { token: admin })).status, 502)
      host = 'https://lookaside.fbsbx.whatsapp.net/file'
      mime = 'text/html'
      assert.equal((await api.get(`/admin/v1/whatsapp/media/${m.id}`, { token: admin })).status, 415)
    } finally {
      useMetaFetchForTests(prev)
      env.WHATSAPP_PROVIDER = saved.p
      env.WHATSAPP_TOKEN = saved.t
    }
  })

  test('a lost webhook event is replayed by maintenance and still processed once', async () => {
    const body = inbound('919812345678', { id: 'wamid.lost1', type: 'text', text: { body: 'hi' } })
    const raw = JSON.stringify(body)
    // Stored but never processed (the instance died after storing it).
    await query(`INSERT INTO webhook_events (id, provider, dedupe_key, body, received_at, last_attempt_at) VALUES ('whe_lost', 'whatsapp', 'sha256:x', $1, $2, $2)`, [Buffer.from(raw), now()])
    later(6 * MIN)
    await replayWebhookEvents()
    await replayWebhookEvents(new Date(now().getTime() + 6 * MIN))
    assert.equal((await msgs('+919812345678', 'IN')).length, 1)
    assert.ok((await query(`SELECT processed_at FROM webhook_events WHERE id = 'whe_lost'`)).rows[0].processed_at)
  })

  test('retention clears message words, then records; account deletion removes chats but keeps a STOP', async () => {
    const ch = chatter()
    await ch.say('hi')
    await ch.say('STOP')
    later((env.WHATSAPP_MESSAGE_RETENTION_DAYS + 1) * 86_400_000)
    await pruneWhatsApp(now())
    const kept = await msgs(ch.phone)
    assert.ok(kept.length > 0)
    assert.ok(kept.every((m) => m.body == null && m.payload == null))
    const cust = await customerToken(api, '9812345678')
    const del = await api.del('/v1/me', { token: cust.accessToken })
    assert.equal(del.status, 204, JSON.stringify(del.body))
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM wa_conversations WHERE phone = $1', [ch.phone])).rows[0].n, 0)
    const c = (await query('SELECT * FROM wa_consent WHERE phone = $1', [ch.phone])).rows[0]
    assert.equal(c.updates, 'STOPPED')
    assert.equal(c.customer_id, null)
  })

  test('non-Indian numbers are recorded and answered once; reactions are recorded, not answered', async () => {
    const r = await handleInbound({ waId: '447700900123', messageId: 'wamid.uk1', input: { text: 'hi' } }, { send: async () => 'wamid.x1' })
    assert.match(r[0].text, /Indian mobile numbers/)
    assert.deepEqual(await handleInbound({ waId: '447700900123', messageId: 'wamid.uk1', input: { text: 'hi' } }, { send: async () => 'wamid.x2' }), [])
    const res = await postMeta(inbound('919812345678', { id: 'wamid.react1', type: 'reaction', reaction: { message_id: 'x', emoji: '👍' } }))
    assert.equal(res.body.handled, 1)
    const [m] = await msgs('+919812345678')
    assert.deepEqual([m.type, m.body, m.direction], ['reaction', '👍', 'IN'])
    assert.equal((await msgs('+919812345678', 'OUT')).length, 0)
  })

  test('health: a customer waiting 4 hours for a person is flagged', async () => {
    const ch = chatter()
    await ch.say('agent')
    later(3 * 60 * MIN)
    assert.ok(!(await checkHealth()).includes('whatsapp-waiting'))
    later(2 * 60 * MIN)
    assert.ok((await checkHealth()).includes('whatsapp-waiting'))
  })
})
