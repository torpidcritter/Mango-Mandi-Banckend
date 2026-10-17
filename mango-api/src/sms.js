// OTP delivery. Production sends login codes through the Jio SMS gateway, and
// falls back to WhatsApp (an authentication template) when SMS fails or the
// customer asks for WhatsApp, so a Jio outage doesn't lock everyone out;
// development and tests only log them (the API also returns them as devCode).
// Indian SMS needs DLT registration, so the sender ID, template ID and entity
// ID must match what is registered, and the text must match the template.
import { env } from './env.js'
import { HttpError } from './errors.js'
import { logger } from './logger.js'
import { metrics } from './metrics.js'
import { metaOtpSender, templateName } from './whatsapp.js'

const mask = (phone) => `${phone.slice(0, 5)}*****`

/** A sender for the Jio SMS gateway. `opts` mirrors the JIO_SMS_* settings. */
export function jioSender(opts, fetchImpl = fetch) {
  return async function sendJio(phone, code) {
    const res = await fetchImpl(opts.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        to: phone.replace(/^\+/, ''),
        sender: opts.senderId,
        message: opts.text.replaceAll('{code}', code),
        templateId: opts.templateId,
        entityId: opts.entityId,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    }).catch((err) => {
      logger.error({ err, phone: mask(phone) }, 'Jio SMS request failed')
      return null
    })
    if (!res?.ok) {
      if (res) logger.error({ status: res.status, body: (await res.text()).slice(0, 500), phone: mask(phone) }, 'Jio SMS rejected the OTP')
      throw new HttpError(502, 'OTP_NOT_SENT', 'We could not send the code. Please try again.')
    }
  }
}

async function logOnly(phone, code) {
  logger.info({ phone }, `OTP for ${phone} is ${code}`)
}

/**
 * Sends a code by the customer's preferred channel, then the other one if that
 * fails. Resolves to the channel that worked; throws OTP_NOT_SENT when none did.
 */
export function otpDelivery({ sms, whatsapp }) {
  return async function deliverOtp(phone, code, preferred = 'sms') {
    const order = (preferred === 'whatsapp' ? ['whatsapp', 'sms'] : ['sms', 'whatsapp']).filter((ch) => (ch === 'sms' ? sms : whatsapp))
    for (const [i, ch] of order.entries()) {
      try {
        await (ch === 'sms' ? sms : whatsapp)(phone, code)
        if (i > 0) metrics.otpFallbacks.inc({ channel: ch })
        return ch
      } catch (err) {
        logger.warn({ err, phone: mask(phone), channel: ch }, 'login code not sent on this channel')
      }
    }
    throw new HttpError(502, 'OTP_NOT_SENT', 'We could not send the code. Please try again.')
  }
}

const smsSender =
  env.SMS_PROVIDER === 'jio'
    ? jioSender({
        url: env.JIO_SMS_URL,
        apiKey: env.JIO_SMS_API_KEY,
        senderId: env.JIO_SMS_SENDER_ID,
        templateId: env.JIO_SMS_TEMPLATE_ID,
        entityId: env.JIO_SMS_ENTITY_ID,
        text: env.JIO_SMS_TEXT,
      })
    : logOnly

export const sendOtp = otpDelivery({
  sms: smsSender,
  whatsapp:
    env.WHATSAPP_PROVIDER === 'meta'
      ? metaOtpSender({
          token: env.WHATSAPP_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, apiVersion: env.WHATSAPP_API_VERSION,
          language: env.WHATSAPP_LANGUAGE, template: templateName('LOGIN_CODE'),
        })
      : null,
})
