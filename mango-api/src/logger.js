import pino from 'pino'
import { env, isProd } from './env.js'

// Sensitive values are redacted at every depth.
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.password_hash',
  // Login and delivery codes in request bodies, not error codes (OPS-06):
  // err.code carries SQLSTATEs and network errors that diagnosis needs.
  'body.code',
  '*.body.code',
  'input.code',
  '*.input.code',
  '*.devCode',
  '*.accessToken',
  '*.refreshToken',
  'password',
  'password_hash',
  'code',
  'devCode',
  'accessToken',
  'refreshToken',
  // SEC-10: customer phone numbers and addresses inside logged objects (an order, a
  // notification, a request body). A top-level `phone` is allowed only masked
  // (maskPhone below); test/log-safety.test.js fails on a logger call that passes it raw.
  '*.phone',
  '*.gift_recipient_phone',
  '*.giftRecipientPhone',
  '*.recipientPhone',
  '*.delivery_address',
  '*.deliveryAddress',
  'body.address',
  '*.body.address',
]

/** A phone number fit for a log line: the country code and first digits, the rest hidden. */
export const maskPhone = (phone) => (phone ? `${String(phone).slice(0, 5)}*****` : phone)

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  ...(isProd || env.NODE_ENV === 'test' ? {} : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
})
