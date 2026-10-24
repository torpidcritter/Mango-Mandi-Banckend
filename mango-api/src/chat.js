// Ordering over WhatsApp. Meta forwards each customer message to
// POST /webhooks/whatsapp; this module keeps one conversation per phone
// (wa_sessions) and answers with text, reply buttons and lists. Orders go
// through the same engine as app checkout: holds, slots, payment and the
// customer-cancel refund. Booking ahead (a preorder for a later week) uses
// the same preorder engine as the app. WhatsApp verifies the phone number,
// so the chat needs no OTP.
import { getConfig } from './config.js'
import { now } from './clock.js'
import { tx, query } from './db.js'
import { orderableDates, slotsForDate } from './delivery.js'
import { env } from './env.js'
import { HttpError } from './errors.js'
import { newId } from './ids.js'
import { availability } from './inventory.js'
import { logger, maskPhone } from './logger.js'
import { dateWords, recordDeliveryStatus, rupees, timeWords, weekWords } from './notify.js'
import { checkUnpaidLimit, createOrder, customerCancel, eatByFor, processPayment, SYSTEM } from './orders.js'
import { applyCapture, createPaymentLink, recordWebhookFailure, refundOrder } from './payments.js'
import { bookPreorder, cancelPreorder, ensurePaymentLink, openWeeks, refundPreorder } from './preorders.js'
import { findProduct, sellable, shopProducts } from './products.js'
import { STAGES } from './stage.js'
import { chatMessenger } from './whatsapp.js'

const STAGE_WORDS = { RAW: 'Raw', SEMI_RIPE: 'Semi-ripe', RIPE: 'Ripe' }
const STATUS_WORDS = {
  PAYMENT_PENDING: 'Waiting for payment', CONFIRMED: 'Confirmed', PROCESSING: 'Preparing', PACKED: 'Packed',
  SHIPPED: 'Shipped', OUT_FOR_DELIVERY: 'Out for delivery', DELIVERED: 'Delivered', DELIVERY_FAILED: 'Delivery missed, retrying',
  CANCELLED: 'Cancelled', RTO: 'Returned',
}
const CANCELLABLE = ['PAYMENT_PENDING', 'CONFIRMED', 'PROCESSING']
const GREETINGS = new Set(['hi', 'hii', 'hello', 'hey', 'menu', 'start', 'namaste', '0'])
const SESSION_IDLE_MS = 2 * 3_600_000 // an older conversation starts over at the menu
const MAX_QTY = 20

const text = (t) => ({ type: 'text', text: t })
const buttons = (t, bs) => ({ type: 'buttons', text: t, buttons: bs.map(([id, title]) => ({ id, title })) })
const MENU = buttons('Welcome to MandiMangoes 🥭 What would you like to do? Send *help* any time to learn how it works.', [
  ['ORDER', 'Order mangoes'],
  ['BOOK', 'Book ahead'],
  ['ORDERS', 'My orders'],
])
const PRE_WORDS = { PAYMENT_PENDING: 'Waiting for payment', BOOKED: 'Booked', WAITLISTED: 'On the waitlist', CONVERTED: 'Booked', CANCELLED: 'Cancelled' }
const slotWords = (s) => `${s.label} (${timeWords(s.startsAt)} to ${timeWords(s.endsAt)})`
const boxesOf = (cart) => cart.reduce((n, l) => n + l.qty, 0)
const totalOf = (cart) => cart.reduce((n, l) => n + findProduct(l.sku).price * l.qty, 0)
const cartLines = (cart) =>
  cart.map((l) => `${l.qty} × ${findProduct(l.sku).name} (${STAGE_WORDS[l.stage]}) ${rupees(findProduct(l.sku).price * l.qty)}`).join('\n')

/** Indian WhatsApp ids (919876543210) as stored phones (+919876543210); null otherwise. */
export function phoneFromWaId(waId) {
  const m = /^91([6-9]\d{9})$/.exec(String(waId ?? ''))
  return m ? `+91${m[1]}` : null
}

/** Runs fn under a savepoint so a refused step leaves the rest of the turn intact. */
async function attempt(c, fn) {
  await c.query('SAVEPOINT chat_step')
  try {
    const value = await fn()
    await c.query('RELEASE SAVEPOINT chat_step')
    return { ok: true, value }
  } catch (error) {
    await c.query('ROLLBACK TO SAVEPOINT chat_step')
    if (error instanceof HttpError) return { ok: false, error }
    throw error
  }
}

async function catalogue(c, s) {
  const pool = await availability(c, s.data.date)
  const rows = shopProducts()
    .flatMap((p) => STAGES.map((stage) => ({ p, stage, qty: pool.get(`${p.sku}|${stage}`) ?? 0 })))
    .filter((r) => r.qty > 0)
    .slice(0, 10)
  if (!rows.length) {
    s.state = 'IDLE'
    return [text(`Sorry, we're sold out for ${dateWords(s.data.date)}. Please check again tomorrow.`), MENU]
  }
  s.state = 'PICK'
  return [{
    type: 'list',
    text: `Delivery on ${dateWords(s.data.date)} to ${s.data.pincode}. Ripeness is what the box will be on that day. Pick a box:`,
    button: 'See mangoes',
    section: 'In stock',
    rows: rows.map((r) => ({
      id: `item:${r.p.sku}|${r.stage}`,
      title: r.p.name,
      description: `${STAGE_WORDS[r.stage]} · ${rupees(r.p.price)} · ${r.qty} left · eat by ${dateWords(eatByFor(r.stage, s.data.date))}`,
    })),
  }]
}

function cartReply(s) {
  s.state = 'CART'
  return [buttons(`Your cart:\n${cartLines(s.data.cart)}\nTotal ${rupees(totalOf(s.data.cart))}`, [
    ['MORE', 'Add more'],
    ['CHECKOUT', 'Checkout'],
    ['CLEAR', 'Empty cart'],
  ])]
}

async function askSlot(c, s) {
  const boxes = boxesOf(s.data.cart)
  const slots = await slotsForDate(c, s.data.date)
  if (!slots.length) {
    s.data.slotId = null
    return askAddress(c, s)
  }
  const open = slots.filter((x) => x.remainingBoxes == null || x.remainingBoxes >= boxes)
  if (!open.length) {
    s.state = 'CART'
    return [buttons(`Every delivery slot on ${dateWords(s.data.date)} is full for ${boxes} boxes. Try fewer boxes, or start again tomorrow.`, [
      ['CLEAR', 'Empty cart'],
      ['MENU', 'Menu'],
    ])]
  }
  s.state = 'SLOT'
  return [{
    type: 'list',
    text: `When should we deliver on ${dateWords(s.data.date)}?`,
    button: 'Pick a slot',
    section: 'Delivery slots',
    rows: open.map((x) => ({
      id: `slot:${x.id}`,
      title: x.label,
      description: `${timeWords(x.startsAt)} to ${timeWords(x.endsAt)}${x.remainingBoxes == null ? '' : ` · ${x.remainingBoxes} boxes left`}`,
    })),
  }]
}

async function askAddress(c, s) {
  const { rows } = await c.query(
    `SELECT delivery_address FROM orders WHERE customer_id = $1 AND pincode = $2 AND delivery_address IS NOT NULL ORDER BY placed_at DESC LIMIT 1`,
    [s.customerId, s.data.pincode],
  )
  s.state = 'ADDRESS'
  if (rows.length) {
    s.data.savedAddress = rows[0].delivery_address
    return [buttons(`Deliver to:\n${rows[0].delivery_address}`, [
      ['ADDR_SAVED', 'Yes, this address'],
      ['ADDR_NEW', 'New address'],
    ])]
  }
  return [text('Please send the full delivery address: house or flat, street, area and a landmark.')]
}

async function summary(c, s) {
  s.state = 'CONFIRM'
  let when = dateWords(s.data.date)
  if (s.data.slotId) {
    const slot = (await slotsForDate(c, s.data.date)).find((x) => x.id === s.data.slotId)
    if (slot) when += `, ${slotWords(slot)}`
  }
  return [buttons(
    `Please check your order:\n${cartLines(s.data.cart)}\nTotal ${rupees(totalOf(s.data.cart))}\n\nDelivery: ${when}\nTo: ${s.data.address}`,
    [['PAY', `Pay ${rupees(totalOf(s.data.cart))}`], ['ORDER', 'Start over'], ['MENU', 'Cancel']],
  )]
}

async function myOrders(c, s) {
  const { rows } = await c.query(
    `SELECT o.*, sl.label AS slot_label FROM orders o LEFT JOIN delivery_slots sl ON sl.id = o.slot_id
      WHERE o.customer_id = $1 AND NOT (o.status = 'CANCELLED' AND o.payment_status IN ('INITIATED', 'CANCELLED', 'FAILED'))
      ORDER BY o.placed_at DESC LIMIT 5`,
    [s.customerId],
  )
  // Bookings that are not yet orders (a converted booking shows as its order above).
  const { rows: pres } = await c.query(
    `SELECT * FROM preorders WHERE customer_id = $1 AND status IN ('PAYMENT_PENDING', 'BOOKED', 'WAITLISTED')
      ORDER BY created_at DESC LIMIT 3`,
    [s.customerId],
  )
  if (!rows.length && !pres.length) return [buttons("You don't have any orders yet.", [['ORDER', 'Order mangoes'], ['BOOK', 'Book ahead']])]
  const lines = rows.map((o) => {
    const refund = o.refunded_at ? ', refunded' : o.refund_requested_at ? ', refund on its way' : ''
    return `*${o.number}*: ${STATUS_WORDS[o.status] ?? o.status}${refund}\nDelivery ${dateWords(o.delivery_date)}${o.slot_label ? `, ${o.slot_label}` : ''} · ${rupees(o.total)}`
  })
  const booked = pres.map((p) =>
    `*${p.number}*: ${PRE_WORDS[p.status]}\n${p.qty} × ${findProduct(p.sku)?.name ?? p.sku} (${STAGE_WORDS[p.stage]}) for ${weekWords(p.week_start)} · ${rupees(p.total)}`)
  const cancellable = [
    ...rows.filter((o) => CANCELLABLE.includes(o.status)).map((o) => [`cancel:${o.id}`, `Cancel ${o.number}`]),
    ...pres.map((p) => [`precancel:${p.id}`, `Cancel ${p.number}`]),
  ].slice(0, 2)
  const note = cancellable.length ? '\n\nYou can cancel until your box is packed. Paid orders and bookings are refunded in full.' : ''
  const parts = [lines.length ? `Your recent orders:\n\n${lines.join('\n\n')}` : '', booked.length ? `Booked ahead:\n\n${booked.join('\n\n')}` : '']
  return [buttons(`${parts.filter(Boolean).join('\n\n')}${note}`, [...cancellable, ['MENU', 'Menu']])]
}

async function addToCart(c, s, qty) {
  const { sku, stage } = s.data.pending ?? {}
  if (!sku) return catalogue(c, s)
  const pool = await availability(c, s.data.date)
  const inCart = s.data.cart.find((l) => l.sku === sku && l.stage === stage)
  const want = (inCart?.qty ?? 0) + qty
  const left = pool.get(`${sku}|${stage}`) ?? 0
  if (want > left) return [text(`Sorry, only ${left} of those ${left === 1 ? 'is' : 'are'} left. Send a smaller number.`)]
  if (want > MAX_QTY) return [text(`You can order up to ${MAX_QTY} boxes of one kind.`)]
  if (inCart) inCart.qty = want
  else s.data.cart.push({ sku, stage, qty })
  delete s.data.pending
  return cartReply(s)
}

/** Books the order (a 10-minute hold, as in app checkout); payment goes out after commit. */
async function placeOrder(c, s, cust) {
  if (s.data.orderId) {
    const { rows } = await c.query('SELECT status, payment_link_url, hold_expires_at FROM orders WHERE id = $1', [s.data.orderId])
    const o = rows[0]
    // An order whose hold ran out is cancelled by the next checkout or the sweep; book afresh.
    const expired = o?.status === 'PAYMENT_PENDING' && o.hold_expires_at < now()
    if (o?.status === 'PAYMENT_PENDING' && !expired) return { replies: [], after: { pay: s.data.orderId } }
    if (o && !expired && o.status !== 'CANCELLED') return { replies: [text('This order is already paid. Send *my orders* to see it.')] }
    delete s.data.orderId
  }
  if (!s.data.cart?.length || !s.data.address) return { replies: [MENU] }
  const dates = await orderableDates(c)
  if (!dates.includes(s.data.date)) {
    s.data.date = dates[0]
    s.data.cart = []
    if (!s.data.date) return { replies: [text('No delivery dates are open right now. Please try again later.')] }
    return { replies: [text('The delivery date has moved on since you started, so stock may have changed. Please pick again.'), ...(await catalogue(c, s))] }
  }
  if (s.data.cart.some((l) => !sellable(l.sku))) {
    s.data.cart = []
    return { replies: [text('Sorry, one of those boxes is no longer sold. Please pick again.'), ...(await catalogue(c, s))] }
  }
  const r = await attempt(c, async () => {
    await checkUnpaidLimit(c, s.customerId, s.data.cart.reduce((t, l) => t + l.qty, 0))
    return createOrder(
      c,
      {
        customerId: s.customerId, customerName: cust.name, phone: s.phone, pincode: s.data.pincode, address: s.data.address,
        deliveryDate: s.data.date, slotId: s.data.slotId ?? null, strictSlot: Boolean(s.data.slotId), status: 'PAYMENT_PENDING',
        paymentStatus: 'INITIATED', allOrNothing: true, channel: 'whatsapp',
        holdExpiresAt: new Date(now().getTime() + getConfig().holdMinutes * 60_000),
        lines: s.data.cart.map((l) => ({ sku: l.sku, stage: l.stage, qty: l.qty, unitPrice: findProduct(l.sku).price })),
      },
      { type: 'customer', id: s.customerId, label: 'whatsapp' },
    )
  })
  if (!r.ok) {
    const code = r.error.code
    if (code === 'UNPAID_ORDER_EXISTS') {
      return { replies: [text(`You already have an unpaid order, ${r.error.extra.number}. Pay for it with the link we sent, or send *my orders* to cancel it. Then you can order again.`)] }
    }
    if (code === 'SLOT_FULL' || code === 'SLOT_INVALID') return { replies: [text('That delivery slot just filled up.'), ...(await askSlot(c, s))] }
    if (code === 'STOCK_INSUFFICIENT') {
      s.data.cart = []
      return { replies: [text('Sorry, some of those boxes just sold out. Please pick again.'), ...(await catalogue(c, s))] }
    }
    if (code === 'DATE_FULL' || code === 'DATE_CLOSED') {
      const next = dates.find((x) => x > s.data.date)
      s.data.cart = []
      if (!next) return { replies: [text(`Sorry, ${dateWords(s.data.date)} is fully booked and no later date is open yet.`), MENU] }
      s.data.date = next
      return { replies: [text('Sorry, that day just filled up. Here is what we have for the next delivery day.'), ...(await catalogue(c, s))] }
    }
    return { replies: [text(`Sorry, we couldn't book that: ${r.error.message}`), MENU] }
  }
  s.data.orderId = r.value.id
  return { replies: [], after: { pay: r.value.id } }
}

async function cancelChosen(c, s, orderId) {
  const { rows } = await c.query('SELECT number, status, payment_status, total FROM orders WHERE id = $1 AND customer_id = $2', [orderId, s.customerId])
  const o = rows[0]
  if (!o) return { replies: [MENU] }
  const r = await attempt(c, () => customerCancel(c, orderId, s.customerId, { type: 'customer', id: s.customerId, label: 'whatsapp' }))
  if (!r.ok) return { replies: [text(r.error.code === 'NOT_CANCELLABLE' ? `${o.number} is already packed, so it can't be cancelled now.` : r.error.message), MENU] }
  if (s.data.orderId === orderId) delete s.data.orderId
  return {
    replies: [text(r.value
      ? `${o.number} is cancelled. Your full refund of ${rupees(o.total)} has been started and usually reaches your account in 5 to 7 working days.`
      : `${o.number} is cancelled.`), MENU],
    after: r.value ? { refund: orderId } : null,
  }
}

// ---------------------------------------------------------------- booking ahead

/** Weeks open for booking, one row per week and box, with what is left. */
async function bookWeeks(c, s) {
  const weeks = (await openWeeks(c)).filter((w) => sellable(w.sku)).slice(0, 10)
  s.data = { pincode: s.data.pincode, pre: {} }
  if (!weeks.length) {
    s.state = 'IDLE'
    return [buttons('No weeks are open for booking right now. You can still order for the next few days.', [['ORDER', 'Order mangoes'], ['MENU', 'Menu']])]
  }
  s.state = 'PRE_WEEK'
  return [{
    type: 'list',
    text: 'Book a box for a later week at today\'s price. You pay now, we pick the delivery day in that week when the fruit is ready, and you can cancel for a full refund until it is packed.',
    button: 'See weeks',
    section: 'Open weeks',
    rows: weeks.map((w) => {
      const p = findProduct(w.sku)
      return {
        id: `week:${w.weekStart}|${w.sku}`,
        title: p.name,
        description: `Week of ${dateWords(w.weekStart)} · ${rupees(p.price)} · ${w.remaining ? `${w.remaining} left` : 'full, join the waitlist'}`,
      }
    }),
  }]
}

async function bookAddress(c, s) {
  const pre = s.data.pre
  const { rows } = await c.query(
    `SELECT delivery_address FROM (
       SELECT delivery_address, placed_at AS at FROM orders WHERE customer_id = $1 AND pincode = $2 AND delivery_address IS NOT NULL
       UNION ALL
       SELECT delivery_address, created_at AS at FROM preorders WHERE customer_id = $1 AND pincode = $2 AND delivery_address <> ''
     ) a ORDER BY at DESC LIMIT 1`,
    [s.customerId, pre.pincode],
  )
  s.state = 'PRE_ADDRESS'
  if (rows.length) {
    pre.savedAddress = rows[0].delivery_address
    return [buttons(`Deliver to:\n${rows[0].delivery_address}`, [['ADDR_SAVED', 'Yes, this address'], ['ADDR_NEW', 'New address']])]
  }
  return [text('Please send the full delivery address: house or flat, street, area and a landmark.')]
}

async function bookSummary(c, s) {
  const pre = s.data.pre
  const p = findProduct(pre.sku)
  const week = (await openWeeks(c, pre.sku)).find((w) => w.weekStart === pre.weekStart)
  const total = p.price * pre.qty
  pre.waitlist = !week || week.remaining < pre.qty
  s.state = 'PRE_CONFIRM'
  const body = `Please check your booking:\n${pre.qty} × ${p.name} (${STAGE_WORDS[pre.stage]}) ${rupees(total)}\nDelivery: a day in ${weekWords(pre.weekStart)}\nTo: ${pre.address}`
  if (pre.waitlist) {
    return [buttons(`${body}\n\nThat week is full for ${pre.qty} boxes. Join the waitlist and we'll message you with a payment link if a spot opens. Nothing is charged until then.`, [
      ['PREPAY', 'Join the waitlist'], ['MENU', 'Cancel'],
    ])]
  }
  return [buttons(body, [['PREPAY', `Pay ${rupees(total)}`], ['BOOK', 'Start over'], ['MENU', 'Cancel']])]
}

/** Books the preorder; the payment link goes out after commit. */
async function placePreorder(c, s, cust) {
  const pre = s.data.pre
  if (s.data.preorderId) {
    const { rows } = await c.query('SELECT status FROM preorders WHERE id = $1', [s.data.preorderId])
    if (rows[0]?.status === 'PAYMENT_PENDING') return { replies: [], after: { prepay: s.data.preorderId } }
    if (rows[0] && rows[0].status !== 'CANCELLED') return { replies: [text('This booking is already made. Send *my orders* to see it.'), MENU] }
    delete s.data.preorderId
  }
  if (!pre?.sku || !pre.address) return { replies: [MENU] }
  const r = await attempt(c, () =>
    bookPreorder(
      c,
      {
        customerId: s.customerId, name: cust.name, phone: s.phone, sku: pre.sku, stage: pre.stage, qty: pre.qty, weekStart: pre.weekStart,
        pincode: pre.pincode, address: pre.address, slotId: null, waitlist: Boolean(pre.waitlist), channel: 'whatsapp',
      },
      { type: 'customer', id: s.customerId, label: 'whatsapp' },
    ),
  )
  if (!r.ok) {
    if (r.error.code === 'PREORDER_FULL') return { replies: [text('Sorry, that week just filled up.'), ...(await bookSummary(c, s))] }
    if (r.error.code === 'INVALID_WEEK') return { replies: [text('Sorry, that week is no longer open for booking.'), ...(await bookWeeks(c, s))] }
    if (r.error.code === 'UNPAID_PREORDER_EXISTS') {
      return { replies: [text(`You already have an unpaid booking, ${r.error.extra.number}. Pay for it with the link we sent, or send *my orders* to cancel it. Then you can book again.`), MENU] }
    }
    return { replies: [text(`Sorry, we couldn't book that: ${r.error.message}`), MENU] }
  }
  const booked = r.value
  s.data = { pincode: pre.pincode, preorderId: booked.id }
  if (booked.status === 'WAITLISTED') {
    s.state = 'IDLE'
    return { replies: [text(`You're on the waitlist for ${weekWords(booked.week_start)} (${booked.number}). We'll message you with a payment link as soon as a spot opens.`), MENU] }
  }
  s.state = 'PRE_AWAITING'
  return { replies: [], after: { prepay: booked.id } }
}

async function cancelBooking(c, s, id) {
  const { rows } = await c.query('SELECT number, total FROM preorders WHERE id = $1 AND customer_id = $2', [id, s.customerId])
  if (!rows.length) return { replies: [MENU] }
  const r = await attempt(c, () => cancelPreorder(c, id, s.customerId, { type: 'customer', id: s.customerId, label: 'whatsapp' }))
  if (!r.ok) return { replies: [text(r.error.code === 'NOT_CANCELLABLE' ? `${rows[0].number} is already packed, so it can't be cancelled now.` : r.error.message), MENU] }
  if (s.data.preorderId === id) delete s.data.preorderId
  return {
    replies: [text(r.value.refund
      ? `${rows[0].number} is cancelled. Your full refund of ${rupees(rows[0].total)} has been started and usually reaches your account in 5 to 7 working days.`
      : `${rows[0].number} is cancelled.`), MENU],
    after: r.value.refund ? { refund: r.value.id, refundKind: r.value.refund } : null,
  }
}

/** The booking steps; null when the message is not part of booking ahead. */
async function bookStep(c, s, cust, id, said) {
  const pre = s.data.pre
  switch (s.state) {
    case 'PRE_WEEK': {
      if (!id?.startsWith('week:')) return bookWeeks(c, s)
      const [weekStart, sku] = id.slice(5).split('|')
      if (!sellable(sku)) return bookWeeks(c, s)
      s.data.pre = { weekStart, sku }
      s.state = 'PRE_STAGE'
      return [buttons(`How ripe should ${findProduct(sku).name} be when it reaches you?`, STAGES.map((st) => [`prestage:${st}`, STAGE_WORDS[st]]))]
    }
    case 'PRE_STAGE': {
      const stage = id?.startsWith('prestage:') ? id.slice(9) : null
      if (!STAGES.includes(stage)) return [buttons('Tap how ripe you want it.', STAGES.map((st) => [`prestage:${st}`, STAGE_WORDS[st]]))]
      pre.stage = stage
      s.state = 'PRE_QTY'
      return [buttons(`How many boxes? Tap or send a number up to ${MAX_QTY}.`, [1, 2, 3].map((n) => [`qty:${n}`, String(n)]))]
    }
    case 'PRE_QTY': {
      const n = Number(id?.startsWith('qty:') ? id.slice(4) : said)
      if (!Number.isInteger(n) || n < 1) return [text('Send the number of boxes, like 2.')]
      if (n > MAX_QTY) return [text(`You can book up to ${MAX_QTY} boxes at a time.`)]
      pre.qty = n
      s.state = 'PRE_PINCODE'
      const ask = 'Which pincode should we deliver to? Send the 6 digits.'
      return [s.data.pincode ? buttons(ask, [[`pin:${s.data.pincode}`, `Use ${s.data.pincode}`]]) : text(ask)]
    }
    case 'PRE_PINCODE': {
      const pin = id?.startsWith('pin:') ? id.slice(4) : said.replace(/\s/g, '')
      if (!/^\d{6}$/.test(pin)) return [text('Please send a 6-digit pincode, like 560034.')]
      const { rows } = await c.query('SELECT 1 FROM pincodes WHERE pincode = $1 AND active', [pin])
      if (!rows.length) return [text(`Sorry, we don't deliver to ${pin} yet. Try another pincode, or send *menu*.`)]
      pre.pincode = pin
      s.data.pincode = pin
      return bookAddress(c, s)
    }
    case 'PRE_ADDRESS': {
      if (id === 'ADDR_SAVED' && pre.savedAddress) pre.address = pre.savedAddress
      else if (id === 'ADDR_NEW') return [text('Please send the full delivery address: house or flat, street, area and a landmark.')]
      else if (said.length >= 10 && said.length <= 500) pre.address = said
      else return [text('That address looks too short. Please send the full address with the house number, street and area.')]
      delete pre.savedAddress
      return bookSummary(c, s)
    }
    case 'PRE_CONFIRM':
      return bookSummary(c, s)
    case 'PRE_AWAITING':
      return [buttons('Your booking is waiting for payment.', [['PREPAY', 'Send payment again'], ['ORDERS', 'My orders'], ['MENU', 'Menu']])]
    default:
      return null
  }
}

/** One customer message → the new conversation state and the replies. */
async function step(c, s, cust, input) {
  const id = input.id ?? null
  const said = (input.text ?? '').trim()
  const lower = said.toLowerCase()
  const d = s.data

  if (id === 'MENU' || GREETINGS.has(lower)) {
    s.state = 'IDLE'
    s.data = { pincode: d.pincode }
    return { replies: [MENU] }
  }
  if (id === 'HELP' || lower === 'help') {
    return { replies: [buttons(
      `We deliver fresh mangoes. Order before ${timeWords(`${getConfig().cutoffHourIST}:00`)} for next-day delivery. Pick the ripeness you want on the delivery day. You can also book a box for a later week at today's price with *Book ahead*. You can cancel until your order is packed, and paid orders are refunded in full. If a box arrives damaged, raise a claim in the MandiMangoes app within ${getConfig().claimWindowHours} hours and we'll replace it.`,
      [['ORDER', 'Order mangoes'], ['ORDERS', 'My orders']],
    )] }
  }
  if (id === 'ORDERS' || ['my orders', 'orders', 'track', 'status'].includes(lower)) return { replies: await myOrders(c, s) }
  if (id?.startsWith('cancel:')) {
    const { rows } = await c.query('SELECT number FROM orders WHERE id = $1 AND customer_id = $2', [id.slice(7), s.customerId])
    if (!rows.length) return { replies: [MENU] }
    return { replies: [buttons(`Cancel ${rows[0].number}? If you've paid, you get a full refund.`, [[`cancelyes:${id.slice(7)}`, 'Yes, cancel it'], ['ORDERS', 'Keep it']])] }
  }
  if (id?.startsWith('cancelyes:')) return cancelChosen(c, s, id.slice(10))
  if (id?.startsWith('precancel:')) {
    const { rows } = await c.query('SELECT number, payment_status FROM preorders WHERE id = $1 AND customer_id = $2', [id.slice(10), s.customerId])
    if (!rows.length) return { replies: [MENU] }
    const refund = rows[0].payment_status === 'SUCCEEDED' ? ' You get a full refund.' : ''
    return { replies: [buttons(`Cancel booking ${rows[0].number}?${refund}`, [[`precancelyes:${id.slice(10)}`, 'Yes, cancel it'], ['ORDERS', 'Keep it']])] }
  }
  if (id?.startsWith('precancelyes:')) return cancelBooking(c, s, id.slice(13))
  if (id === 'BOOK' || ['book', 'book ahead', 'preorder', 'pre-order'].includes(lower)) return { replies: await bookWeeks(c, s) }
  if (id === 'PREPAY') return placePreorder(c, s, cust)
  if (s.state?.startsWith('PRE_')) {
    const replies = await bookStep(c, s, cust, id, said)
    if (replies) return { replies }
  }
  if (id === 'ORDER' || lower === 'order') {
    s.state = 'PINCODE'
    s.data = { pincode: d.pincode, cart: [] }
    const ask = 'Which pincode should we deliver to? Send the 6 digits.'
    return { replies: [d.pincode ? buttons(ask, [[`pin:${d.pincode}`, `Use ${d.pincode}`]]) : text(ask)] }
  }
  if (id === 'PAY') return placeOrder(c, s, cust)
  if (id === 'MORE' && d.cart?.length) return { replies: await catalogue(c, s) }
  if (id === 'CHECKOUT' && d.cart?.length) return { replies: await askSlot(c, s) }
  if (id === 'CLEAR') {
    s.state = 'IDLE'
    s.data = { pincode: d.pincode }
    return { replies: [text('Your cart is empty now.'), MENU] }
  }

  switch (s.state) {
    case 'PINCODE': {
      const pin = id?.startsWith('pin:') ? id.slice(4) : said.replace(/\s/g, '')
      if (!/^\d{6}$/.test(pin)) return { replies: [text('Please send a 6-digit pincode, like 560034.')] }
      const { rows } = await c.query('SELECT 1 FROM pincodes WHERE pincode = $1 AND active', [pin])
      if (!rows.length) return { replies: [text(`Sorry, we don't deliver to ${pin} yet. Try another pincode, or send *menu*.`)] }
      const dates = await orderableDates(c)
      if (!dates.length) {
        s.state = 'IDLE'
        return { replies: [text('No delivery dates are open right now. Please try again later.')] }
      }
      s.data = { pincode: pin, date: dates[0], cart: [] }
      return { replies: await catalogue(c, s) }
    }
    case 'PICK': {
      if (!id?.startsWith('item:')) return { replies: [text('Tap *See mangoes* and pick a box.'), ...(await catalogue(c, s))] }
      const [sku, stage] = id.slice(5).split('|')
      const p = sellable(sku)
      if (!p || !STAGES.includes(stage)) return { replies: await catalogue(c, s) }
      d.pending = { sku, stage }
      s.state = 'QTY'
      const left = (await availability(c, d.date)).get(`${sku}|${stage}`) ?? 0
      const opts = [1, 2, 3].filter((n) => n <= left)
      return { replies: [buttons(
        `How many boxes of ${p.name} (${STAGE_WORDS[stage]}, ${rupees(p.price)} each)? Tap or send a number${left > 3 ? ` up to ${Math.min(left, MAX_QTY)}` : ''}.`,
        opts.map((n) => [`qty:${n}`, String(n)]),
      )] }
    }
    case 'QTY': {
      const n = Number(id?.startsWith('qty:') ? id.slice(4) : said)
      if (!Number.isInteger(n) || n < 1) return { replies: [text('Send the number of boxes, like 2.')] }
      return { replies: await addToCart(c, s, n) }
    }
    case 'CART':
      return { replies: cartReply(s) }
    case 'SLOT': {
      if (!id?.startsWith('slot:')) return { replies: await askSlot(c, s) }
      d.slotId = id.slice(5)
      return { replies: await askAddress(c, s) }
    }
    case 'ADDRESS': {
      if (id === 'ADDR_SAVED' && d.savedAddress) d.address = d.savedAddress
      else if (id === 'ADDR_NEW') return { replies: [text('Please send the full delivery address: house or flat, street, area and a landmark.')] }
      else if (said.length >= 10 && said.length <= 500) d.address = said
      else return { replies: [text('That address looks too short. Please send the full address with the house number, street and area.')] }
      delete d.savedAddress
      return { replies: await summary(c, s) }
    }
    case 'CONFIRM':
      return { replies: await summary(c, s) }
    case 'AWAITING_PAYMENT':
      return { replies: [buttons('Your order is waiting for payment.', [['PAY', 'Send payment again'], ['ORDERS', 'My orders'], ['MENU', 'Menu']])] }
    default:
      return { replies: [MENU] }
  }
}

/** Sends the payment for a booked chat order: in WhatsApp when set up, else a Razorpay link. */
async function paymentReplies(orderId) {
  const { rows } = await query('SELECT * FROM orders WHERE id = $1', [orderId])
  const o = rows[0]
  const hold = `Pay within ${getConfig().holdMinutes} minutes to keep these boxes.`
  if (env.WHATSAPP_PAYMENT_CONFIG) {
    const { rows: items } = await query('SELECT sku, stage, quantity, unit_price FROM order_items WHERE order_id = $1 ORDER BY sku, stage', [orderId])
    return [{
      type: 'pay',
      text: `Order ${o.number} is booked. ${hold}`,
      configuration: env.WHATSAPP_PAYMENT_CONFIG,
      order: { id: o.id, number: o.number, total: o.total, items: items.map((i) => ({ sku: i.sku, stage: i.stage, name: findProduct(i.sku)?.name ?? i.sku, unitPrice: i.unit_price, qty: i.quantity })) },
    }]
  }
  let url = o.payment_link_url
  if (!url) {
    const link = await createPaymentLink({ amount: o.total, number: o.number, orderId: o.id, name: o.customer_name, phone: o.phone })
    await query('UPDATE orders SET payment_link_id = $2, payment_link_url = $3 WHERE id = $1', [o.id, link.id, link.url])
    url = link.url
  }
  return [{ type: 'link', text: `Order ${o.number} is booked: ${rupees(o.total)}. ${hold}\n${url}`, button: `Pay ${rupees(o.total)}`, url }]
}

/**
 * Handles one inbound WhatsApp message. Returns the replies to send (already
 * sent when `send` is given). Duplicate deliveries of a message return [].
 */
export async function handleInbound({ waId, name = null, messageId, input }, { send = chatMessenger } = {}) {
  const phone = phoneFromWaId(waId)
  if (!phone) {
    const replies = [text('Sorry, we can only take orders from Indian mobile numbers for now.')]
    if (waId) await deliver(send, `+${waId}`, replies)
    return replies
  }
  const turn = await tx(async (c) => {
    const ins = await c.query('INSERT INTO wa_inbound (message_id, phone, received_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [messageId, phone, now()])
    if (!ins.rowCount) return null
    const cust = (await c.query(
      `INSERT INTO customers (id, phone, name, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (phone) DO UPDATE SET name = COALESCE(customers.name, EXCLUDED.name) RETURNING id, name`,
      [newId('cus'), phone, name?.trim().slice(0, 80) || null, now()],
    )).rows[0]
    await c.query(
      `INSERT INTO wa_sessions (phone, customer_id, updated_at) VALUES ($1, $2, $3) ON CONFLICT (phone) DO NOTHING`,
      [phone, cust.id, now()],
    )
    const row = (await c.query('SELECT * FROM wa_sessions WHERE phone = $1 FOR UPDATE', [phone])).rows[0]
    const s = { phone, customerId: cust.id, state: row.state, data: row.data ?? {} }
    const stale = now().getTime() - row.updated_at.getTime() > SESSION_IDLE_MS
    if (stale && s.state !== 'AWAITING_PAYMENT') s.state = 'IDLE'
    const out = await step(c, s, cust, input)
    if (out.after?.pay) s.state = 'AWAITING_PAYMENT'
    if (out.after?.prepay) s.state = 'PRE_AWAITING'
    await c.query('UPDATE wa_sessions SET state = $2, data = $3, updated_at = $4 WHERE phone = $1', [phone, s.state, s.data, now()])
    return { ...out, phone, customerId: cust.id }
  })
  if (!turn) return []
  const replies = [...turn.replies]
  if (turn.after?.pay) {
    try {
      replies.push(...(await paymentReplies(turn.after.pay)))
      await query(`UPDATE wa_sessions SET data = data - 'cart' - 'address' - 'slotId' WHERE phone = $1`, [phone])
    } catch (err) {
      logger.error({ err, orderId: turn.after.pay }, 'could not start the chat payment')
      await tx((c) => processPayment(c, { orderId: turn.after.pay, outcome: 'abandoned' }, SYSTEM))
      await query(`UPDATE wa_sessions SET state = 'CONFIRM', data = data - 'orderId' WHERE phone = $1`, [phone])
      replies.push(buttons("Sorry, we couldn't start the payment. Please try again.", [['PAY', 'Try again'], ['MENU', 'Menu']]))
    }
  }
  if (turn.after?.prepay) {
    try {
      const p = await ensurePaymentLink(turn.after.prepay)
      if (p?.payment_link_url) {
        const hold = `Pay within ${getConfig().holdMinutes} minutes to keep your spot.`
        replies.push({ type: 'link', text: `Booking ${p.number} is held: ${rupees(p.total)}. ${hold}\n${p.payment_link_url}`, button: `Pay ${rupees(p.total)}`, url: p.payment_link_url })
      } else {
        replies.push(text('This booking is no longer waiting for payment. Send *my orders* to see it.'))
      }
    } catch (err) {
      logger.error({ err, preorderId: turn.after.prepay }, 'could not start the booking payment')
      await tx((c) => cancelPreorder(c, turn.after.prepay, turn.customerId, SYSTEM))
      await query(`UPDATE wa_sessions SET state = 'IDLE', data = data - 'preorderId' WHERE phone = $1`, [phone])
      replies.push(buttons("Sorry, we couldn't start the payment. Please book again.", [['BOOK', 'Book again'], ['MENU', 'Menu']]))
    }
  }
  if (turn.after?.refund) {
    const send = turn.after.refundKind === 'preorder' ? refundPreorder : refundOrder
    await send(turn.after.refund).catch((err) => logger.error({ err, id: turn.after.refund }, 'refund failed; maintenance will retry'))
  }
  await deliver(send, phone, replies)
  return replies
}

async function deliver(send, phone, replies) {
  for (const r of replies) {
    try {
      await send(phone, r)
    } catch (err) {
      logger.error({ err, phone: maskPhone(phone) }, 'WhatsApp chat reply failed')
    }
  }
}

/** What an inbound Cloud API message means to the chat: a tapped option or typed text. */
export function inputOf(msg) {
  if (msg.type === 'text') return { text: msg.text?.body ?? '' }
  if (msg.type === 'interactive') return { id: msg.interactive?.button_reply?.id ?? msg.interactive?.list_reply?.id ?? null }
  if (msg.type === 'button') return { id: msg.button?.payload ?? null, text: msg.button?.text ?? '' }
  return { text: '' }
}

/**
 * Handles a verified Cloud API webhook body: customer messages go to the chat,
 * and Payments-on-WhatsApp status updates confirm orders as Razorpay's webhook does.
 */
export async function handleWhatsAppWebhook(body, opts = {}) {
  let handled = 0
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {}
      const names = new Map((v.contacts ?? []).map((ct) => [ct.wa_id, ct.profile?.name ?? null]))
      for (const msg of v.messages ?? []) {
        await handleInbound({ waId: msg.from, name: names.get(msg.from) ?? null, messageId: msg.id, input: inputOf(msg) }, opts)
        handled++
      }
      for (const st of v.statuses ?? []) {
        if (st.type !== 'payment') {
          handled += await recordDeliveryStatus(st)
          continue
        }
        if (st.type === 'payment' && st.status === 'captured' && st.payment?.reference_id) {
          const { rows } = await query('SELECT id FROM orders WHERE number = $1', [st.payment.reference_id])
          if (rows.length) {
            // Same checks as a Razorpay capture: a payment id, the right currency, the full amount.
            // (Meta's amount is { value, offset: 100 }, so value is in paise like our totals.)
            const pay = { id: st.payment.transaction?.id ?? null, amount: st.payment.amount?.value ?? null, currency: st.payment.currency ?? null, method: st.payment.transaction?.method?.type ?? 'whatsapp' }
            await tx((c) => applyCapture(c, 'orders', rows[0].id, pay))
            handled++
          } else {
            // PAY-B7: money taken for an order we can't find: staff must see it.
            await recordWebhookFailure(
              'whatsapp',
              `WhatsApp payment ${st.payment.transaction?.id ?? '(no id)'} captured for reference ${String(st.payment.reference_id).slice(0, 60)}, which matches no order`,
              st.id ?? st.payment.transaction?.id ?? null,
            )
          }
        }
      }
    }
  }
  return handled
}
