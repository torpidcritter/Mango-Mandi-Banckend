// WhatsApp through the Meta WhatsApp Cloud API. Business-initiated messages
// (order updates) must use templates approved in WhatsApp Manager; each kind of
// update maps to one template named <WHATSAPP_TEMPLATE_PREFIX><kind>, e.g.
// mandi_order_confirmed, whose body variables are filled in order ({{1}}, {{2}}…).
// Replies in the ordering chat are free-form (text, buttons, lists), which
// WhatsApp allows within 24 hours of the customer's last message.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from './env.js'
import { logger, maskPhone } from './logger.js'

/** A sender for the Cloud API. Resolves to the provider's message id. */
export function metaSender(opts, fetchImpl = fetch) {
  const url = `https://graph.facebook.com/${opts.apiVersion}/${encodeURIComponent(opts.phoneNumberId)}/messages`
  // urlParam: the variable of the template's URL button (index 0), for templates that have one.
  return async function sendMeta({ phone, template, params, urlParam = null }) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.token}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: template,
          language: { code: opts.language },
          components: [
            { type: 'body', parameters: params.map((text) => ({ type: 'text', text: String(text) })) },
            ...(urlParam ? [{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(urlParam) }] }] : []),
          ],
        },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err = new Error(`WhatsApp ${res.status}: ${body?.error?.message ?? 'request failed'}`)
      // 4xx other than rate limits and auth (which ops can fix) won't succeed on a retry.
      err.permanent = res.status >= 400 && res.status < 500 && ![401, 408, 429].includes(res.status)
      throw err
    }
    const id = body?.messages?.[0]?.id
    // A 200 without a message id is not an accepted message: retry it.
    if (!id) throw new Error('WhatsApp answered without a message id')
    return id
  }
}

/**
 * Sends a login code with a Meta authentication template (category
 * AUTHENTICATION, "copy code" button). Meta requires the code twice: once in
 * the body and once as the button's parameter.
 */
export function metaOtpSender(opts, fetchImpl = fetch) {
  const url = `https://graph.facebook.com/${opts.apiVersion}/${encodeURIComponent(opts.phoneNumberId)}/messages`
  return async function sendOtpByWhatsApp(phone, code) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.token}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: opts.template,
          language: { code: opts.language },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
          ],
        },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${body?.error?.message ?? 'request failed'}`)
    // As for every other message (metaSender above), and as OPS-03 for Jio: a 200
    // without a message id was not accepted, so the code goes by SMS instead.
    if (!body?.messages?.[0]?.id) throw new Error('WhatsApp answered without a message id')
  }
}

export const templateName = (kind) => `${env.WHATSAPP_TEMPLATE_PREFIX}${kind.toLowerCase()}`

export const whatsappSender =
  env.WHATSAPP_PROVIDER === 'meta'
    ? metaSender({ token: env.WHATSAPP_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, apiVersion: env.WHATSAPP_API_VERSION, language: env.WHATSAPP_LANGUAGE })
    : null

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * Turns a chat reply into a Cloud API message body. Replies are:
 * { type: 'text', text } · { type: 'buttons', text, buttons: [{ id, title }] } (up to 3) ·
 * { type: 'list', text, button, rows: [{ id, title, description }] } (up to 10) ·
 * { type: 'link', text, button, url } · { type: 'pay', text, order } (pay inside WhatsApp).
 * Titles are clipped to WhatsApp's limits.
 */
export function toMeta(to, r) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, '') }
  const body = { text: clip(r.text, 1024) }
  switch (r.type) {
    case 'buttons':
      return { ...base, type: 'interactive', interactive: { type: 'button', body, action: {
        buttons: r.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: clip(b.title, 20) } })),
      } } }
    case 'list':
      return { ...base, type: 'interactive', interactive: { type: 'list', body, action: {
        button: clip(r.button, 20),
        sections: [{ title: clip(r.section ?? 'Options', 24), rows: r.rows.slice(0, 10).map((x) => ({
          id: x.id, title: clip(x.title, 24), ...(x.description ? { description: clip(x.description, 72) } : {}),
        })) }],
      } } }
    case 'link':
      return { ...base, type: 'interactive', interactive: { type: 'cta_url', body, action: {
        name: 'cta_url', parameters: { display_text: clip(r.button, 20), url: r.url },
      } } }
    case 'pay': {
      // Payments on WhatsApp (India): the customer reviews and pays in the chat.
      // Razorpay is the gateway, set up in WhatsApp Manager as WHATSAPP_PAYMENT_CONFIG;
      // notes.orderId comes back on Razorpay's payment webhook.
      const o = r.order
      const money = (value) => ({ value, offset: 100 })
      return { ...base, type: 'interactive', interactive: { type: 'order_details', body, action: {
        name: 'review_and_pay',
        parameters: {
          reference_id: o.number, type: 'physical-goods', currency: 'INR', total_amount: money(o.total),
          payment_settings: [{ type: 'payment_gateway', payment_gateway: {
            type: 'razorpay', configuration_name: r.configuration, razorpay: { receipt: o.number, notes: { orderId: o.id } },
          } }],
          order: {
            status: 'pending', subtotal: money(o.total), tax: money(0),
            items: o.items.map((i) => ({ retailer_id: `${i.sku}-${i.stage}`, name: clip(i.name, 60), amount: money(i.unitPrice), quantity: i.qty })),
          },
        },
      } } }
    }
    default:
      return { ...base, type: 'text', text: { body: clip(r.text, 4096), preview_url: true } }
  }
}

/** Sends free-form chat replies through the Cloud API. */
export function metaMessenger(opts, fetchImpl = fetch) {
  const url = `https://graph.facebook.com/${opts.apiVersion}/${encodeURIComponent(opts.phoneNumberId)}/messages`
  return async function sendChat(phone, reply) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.token}` },
      body: JSON.stringify(toMeta(phone, reply)),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${body?.error?.message ?? 'request failed'}`)
    return body?.messages?.[0]?.id ?? null
  }
}

/** Outside Meta (development) chat replies are logged. */
export const chatMessenger =
  env.WHATSAPP_PROVIDER === 'meta'
    ? metaMessenger({ token: env.WHATSAPP_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, apiVersion: env.WHATSAPP_API_VERSION })
    : // eslint-disable-next-line require-await -- a messenger: async like the Meta one
      async (phone, reply) => {
        logger.info({ phone: maskPhone(phone), reply }, 'WhatsApp chat reply')
        return 'log'
      }

/** Meta signs webhook bodies with the app secret: X-Hub-Signature-256: sha256=<hex>. */
export function verifyMetaSignature(raw, header, secret = env.WHATSAPP_APP_SECRET) {
  if (!secret || typeof header !== 'string' || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false
  const expected = createHmac('sha256', secret).update(raw).digest()
  return timingSafeEqual(expected, Buffer.from(header.slice(7), 'hex'))
}
