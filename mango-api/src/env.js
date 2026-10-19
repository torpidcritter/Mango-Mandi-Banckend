// Validated configuration. In production the app refuses to start with
// placeholder secrets.
import { z } from 'zod'
import { checkProduction, DEV_JWT, DEV_LABEL_SECRET } from './preflight.js'

/** Running as a Vercel Function (Vercel sets VERCEL=1). */
export const onVercel = Boolean(process.env.VERCEL)

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().default('postgres://mango:mango@localhost:5432/mango'),
  // Neon: DATABASE_URL is the pooled (-pooler) URL; migrations need the direct one.
  DATABASE_URL_UNPOOLED: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(onVercel ? 5 : 10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  JWT_SECRET: z.string().default(DEV_JWT),
  ADMIN_ORIGIN: z.string().default('http://localhost:5173'),
  CUSTOMER_ORIGIN: z.string().default('http://localhost:5174'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Vercel's edge sets X-Forwarded-For to the client's address: one hop to trust.
  TRUST_PROXY: z.coerce.number().int().min(0).default(onVercel ? 1 : 0),
  // lax when the sites and the API share a domain (shop.x.in, api.x.in); none for *.vercel.app previews.
  COOKIE_SAMESITE: z.enum(['lax', 'none', 'strict']).default('lax'),
  // Vercel Cron sends "Authorization: Bearer CRON_SECRET" to /internal/maintenance.
  CRON_SECRET: z.string().default(''),
  // Sign in with Google: the OAuth web client ID from Google Cloud console.
  GOOGLE_CLIENT_ID: z.string().default(''),
  SENTRY_DSN: z.string().default(''),
  // Vercel Blob for delivery and claim photos; unset keeps photos in the database.
  BLOB_READ_WRITE_TOKEN: z.string().default(''),
  // Two-step sign-in for staff: required for managers, everyone, or nobody (each person can still turn it on).
  STAFF_TWO_STEP: z.enum(['managers', 'all', 'optional']).optional(),
  // Login codes sent per day across the shop before sending pauses (SMS pumping guard).
  OTP_DAILY_LIMIT: z.coerce.number().int().positive().default(3000),
  // The part of that budget numbers with no account may use; the rest is kept for existing customers.
  OTP_NEW_NUMBER_SHARE: z.coerce.number().min(0.05).max(1).default(0.6),
  // Cloudflare Turnstile: the secret key. Set, the shop must pass a Turnstile check before a code is sent.
  TURNSTILE_SECRET_KEY: z.string().default(''),
  TURNSTILE_SITE_KEY: z.string().default(''),
  // The production database's host (Neon main). Production must use it; previews and staging must not.
  PRODUCTION_DB_HOST: z.string().default(''),
  // Requests per address per 15 minutes before 429 (shared by everyone behind one carrier NAT).
  API_RATE_LIMIT: z.coerce.number().int().positive().default(3000),
  REFRESH_REUSE_GRACE_MS: z.coerce.number().int().min(0).default(10_000),
  RAZORPAY_WEBHOOK_SECRET: z.string().default('whsec_dev'),
  RAZORPAY_KEY_ID: z.string().default(''),
  RAZORPAY_KEY_SECRET: z.string().default(''),
  METRICS_TOKEN: z.string().default(''),
  // Signs the QR tokens on box labels (labels.js). Changing it makes every printed label unreadable.
  LABEL_TOKEN_SECRET: z.string().default(DEV_LABEL_SECRET),
  ADMIN_BOOTSTRAP_EMAIL: z.string().email().optional(),
  ADMIN_BOOTSTRAP_PASSWORD: z.string().min(12).optional(),
  // Previews get their own first manager, so the production password is never in a preview.
  PREVIEW_ADMIN_EMAIL: z.string().email().optional(),
  PREVIEW_ADMIN_PASSWORD: z.string().min(12).optional(),
  SMS_PROVIDER: z.enum(['log', 'jio']).default('log'),
  JIO_SMS_URL: z.string().url().optional(),
  JIO_SMS_API_KEY: z.string().optional(),
  JIO_SMS_SENDER_ID: z.string().optional(),
  JIO_SMS_TEMPLATE_ID: z.string().optional(),
  JIO_SMS_ENTITY_ID: z.string().optional(),
  JIO_SMS_TEXT: z.string().default('{code} is your MandiMangoes login code. It expires in 5 minutes.'),
  WHATSAPP_PROVIDER: z.enum(['log', 'meta']).default('log'),
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v23.0'),
  WHATSAPP_TEMPLATE_PREFIX: z.string().regex(/^[a-z0-9_]*$/).default('mandi_'),
  WHATSAPP_LANGUAGE: z.string().default('en'),
  // Ordering in the chat: Meta's webhook verify token and app secret (signs webhook bodies)
  WHATSAPP_VERIFY_TOKEN: z.string().default(''),
  WHATSAPP_APP_SECRET: z.string().default(''),
  // Payments on WhatsApp: the Razorpay payment configuration name from WhatsApp Manager.
  // Unset: chat orders get a Razorpay payment link instead.
  WHATSAPP_PAYMENT_CONFIG: z.string().default(''),
  SEED_DEMO_DATA: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
})

// Empty values (KEY= in .env) mean "use the default".
const parsed = schema.safeParse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')))
if (!parsed.success) {
  console.error('Invalid configuration:', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data
export const isProd = env.NODE_ENV === 'production'
/** Which deployment this is: Vercel's production or preview, else NODE_ENV. */
export const deployEnv = process.env.VERCEL_ENV || env.NODE_ENV

// Fail closed: without NODE_ENV=production the API runs its development
// stand-ins (a fake payment gateway, login codes in the response, /v1/dev).
// On Vercel that is never wanted, previews included (vercel dev aside).
if (onVercel && !isProd && process.env.VERCEL_ENV !== 'development') {
  console.error('Refusing to start: on Vercel NODE_ENV must be production, previews too (see deploy/VERCEL.md)')
  process.exit(1)
}
env.STAFF_TWO_STEP ??= isProd ? 'managers' : 'optional'

if (env.WHATSAPP_PROVIDER === 'meta' && !(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID)) {
  console.error('WHATSAPP_PROVIDER=meta needs WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID')
  process.exit(1)
}

const JIO_KEYS = ['JIO_SMS_URL', 'JIO_SMS_API_KEY', 'JIO_SMS_SENDER_ID', 'JIO_SMS_TEMPLATE_ID', 'JIO_SMS_ENTITY_ID']
if (env.SMS_PROVIDER === 'jio') {
  const missing = JIO_KEYS.filter((k) => !env[k])
  if (missing.length || !env.JIO_SMS_TEXT.includes('{code}')) {
    console.error(`SMS_PROVIDER=jio needs ${missing.join(', ') || 'JIO_SMS_TEXT containing {code}'}`)
    process.exit(1)
  }
}

// `npm run preflight` sets PREFLIGHT=1 to print every problem instead of exiting on the first start.
if (isProd && !process.env.PREFLIGHT) {
  const { errors, warnings } = checkProduction(env, { vercel: onVercel })
  for (const w of warnings) console.warn(`Warning: ${w}`)
  if (errors.length) {
    console.error(`Refusing to start in production:\n- ${errors.join('\n- ')}\nRun npm run preflight for the full list.`)
    process.exit(1)
  }
}
