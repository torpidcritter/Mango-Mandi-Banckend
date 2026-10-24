// OTP delivery. Production sends login codes through the Jio SMS gateway, and
// falls back to WhatsApp (an authentication template) when SMS fails or the
// customer asks for WhatsApp, so a Jio outage doesn't lock everyone out;
// development and tests only log them (the API also returns them as devCode).
// Indian SMS needs DLT registration, so the sender ID, template ID and entity
// ID must match what is registered, and the text must match the template.
import { deployEnv, env, isProd } from './env.js'
import { HttpError } from './errors.js'
import { logger, maskPhone as mask } from './logger.js'
import { metrics } from './metrics.js'
import { hit } from './ratelimit.js'
import { reportProblem } from './sentry.js'
import { metaOtpSender, templateName } from './whatsapp.js'


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
      // The gateway may echo the message back: never log the code.
      if (res) logger.error({ status: res.status, body: await safeBody(res, code), phone: mask(phone) }, 'Jio SMS rejected the OTP')
      throw notSent()
    }
    // HTTP 200 is not enough (OPS-03): the reply must say the SMS was accepted,
    // in the field and with a value from Jio's documentation (JIO_SMS_SUCCESS_*).
    const raw = await res.text().catch(() => '')
    let body = null
    try {
      body = JSON.parse(raw)
    } catch {
      // not JSON: can't be the documented answer
    }
    const accepted = body !== null && opts.successValues.includes(String(at(body, opts.successPath)))
    if (!accepted) {
      logger.error({ status: res.status, body: clean(raw, code), phone: mask(phone) }, 'Jio SMS answered 200 without the accepted status; treating the code as not sent')
      metrics.otpNotAccepted.inc()
      throw notSent()
    }
    logger.info({ phone: mask(phone), jioId: opts.idPath ? String(at(body, opts.idPath) ?? '') : undefined }, 'Jio accepted the login SMS')
  }
}

const notSent = () => new HttpError(502, 'OTP_NOT_SENT', 'We could not send the code. Please try again.')
const clean = (text, code) => String(text).slice(0, 500).replaceAll(code, '******')
const safeBody = async (res, code) => clean(await res.text().catch(() => ''), code)
/** The value at a dot path ("data.state") in a parsed JSON reply. */
const at = (obj, path) => path.split('.').reduce((v, k) => (v === null || v === undefined ? undefined : v[k]), obj)

/** The "log" provider. The code is written only with LOG_OTP_CODES=true (a preview, say); never the full number. */
// eslint-disable-next-line require-await -- a sender: async like the real providers
export async function logOnly(phone, code) {
  // SEC-01: a local run with the shop on a public link (start-local --phone) keeps codes out of
  // responses; they show in that computer's console instead, which runs at warn level.
  const level = !isProd && !env.OTP_CODE_IN_RESPONSE ? 'warn' : 'info'
  if (env.LOG_OTP_CODES) logger[level]({ phone: mask(phone) }, `Login code for ${mask(phone)} is ${code}`)
  else logger.info({ phone: mask(phone) }, 'Login code not sent (SMS_PROVIDER=log); set LOG_OTP_CODES=true to log it')
}

/**
 * Sends a code by the customer's preferred channel, then the other one if that
 * fails. Resolves to the channel that worked; throws OTP_NOT_SENT when none did.
 */
export function otpDelivery({ sms, whatsapp }) {
  return async function deliverOtp(phone, code, preferred = env.OTP_DEFAULT_CHANNEL) {
    const order = (preferred === 'whatsapp' ? ['whatsapp', 'sms'] : ['sms', 'whatsapp']).filter((ch) => (ch === 'sms' ? sms : whatsapp))
    for (const [i, ch] of order.entries()) {
      try {
        await (ch === 'sms' ? sms : whatsapp)(phone, code)
        if (i > 0) {
          metrics.otpFallbacks.inc({ channel: ch })
          await noteOtpTrouble('fallback', { failingChannel: order[0], workingChannel: ch })
        }
        return ch
      } catch (err) {
        logger.warn({ err, phone: mask(phone), channel: ch }, 'login code not sent on this channel')
      }
    }
    await noteOtpTrouble('failed', { channels: order })
    throw new HttpError(502, 'OTP_NOT_SENT', 'We could not send the code. Please try again.')
  }
}

/**
 * INT-02: login-code trouble reaches Sentry (and so a person), not only the logs
 * and a Prometheus counter nobody scrapes on Vercel. Counted in Postgres so it
 * holds across serverless instances; one warning when a window reaches its
 * threshold, then quiet until the next window.
 */
export const OTP_ALERTS = {
  failed: { windowMs: 10 * 60_000, threshold: 3, message: 'Login codes are not being sent: phone sign-in is failing. Check Jio SMS and the WhatsApp token (RUNBOOKS: login codes not arriving)' },
  fallback: { windowMs: 60 * 60_000, threshold: 5, message: 'Login codes are going out on the backup channel: the first channel is failing (RUNBOOKS: login codes not arriving)' },
}

async function noteOtpTrouble(kind, extra) {
  const a = OTP_ALERTS[kind]
  try {
    const { hits } = await hit(`otp-trouble:${kind}`, a.windowMs)
    if (hits === a.threshold) reportProblem(a.message, { ...extra, count: hits, windowMinutes: a.windowMs / 60_000 })
  } catch (err) {
    logger.error({ err }, 'could not count a login-code problem')
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
        successPath: env.JIO_SMS_SUCCESS_PATH,
        successValues: env.JIO_SMS_SUCCESS_VALUES.split(',').map((v) => v.trim()).filter(Boolean),
        idPath: env.JIO_SMS_ID_PATH,
      })
    : // In production a code only written to the log was not sent: leave SMS out, so WhatsApp is tried.
      deployEnv === 'production' && !env.LOG_OTP_CODES
      ? null
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
