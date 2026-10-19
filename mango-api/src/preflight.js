// Go-live checks on the settings. `errors` stop a production start; `warnings`
// are things that work but leave a feature off or a risk open.
// env.js runs this on every production start; `npm run preflight` prints the
// whole list (and checks the database) without starting the server.

export const DEV_JWT = 'dev-only-change-me-0123456789abcdef0123456789'
export const DEV_LABEL_SECRET = 'dev-only-label-secret-0123456789abcdef01234567'

const origins = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean)

export function checkProduction(env, { vercel = Boolean(process.env.VERCEL), target = process.env.VERCEL_ENV || 'production' } = {}) {
  const errors = []
  const warnings = []
  const preview = target === 'preview'

  if (env.JWT_SECRET.length < 32 || env.JWT_SECRET === DEV_JWT || env.JWT_SECRET.startsWith('dev-only-change-me')) {
    errors.push('JWT_SECRET too weak: set a random string of 32+ characters (openssl rand -hex 32)')
  }
  // Box labels can be switched on from the Rules page at any time, so the secret is needed up front.
  if (!env.LABEL_TOKEN_SECRET || env.LABEL_TOKEN_SECRET.length < 32 || env.LABEL_TOKEN_SECRET.startsWith('dev-only')) {
    errors.push('LABEL_TOKEN_SECRET too weak: set a random string of 32+ characters (openssl rand -hex 32); it signs the QR codes on box labels')
  }
  if (!env.COOKIE_SECURE) errors.push('COOKIE_SECURE must be true in production')

  // Payments: there is no cash on delivery, so without Razorpay nobody can pay.
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) errors.push('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required: customers could not pay')
  else if (preview && env.RAZORPAY_KEY_ID.startsWith('rzp_live_')) errors.push('RAZORPAY_KEY_ID is a live key on a preview: previews must use test keys, or they could take real money')
  else if (!preview && env.RAZORPAY_KEY_ID.startsWith('rzp_test_')) warnings.push('RAZORPAY_KEY_ID is a test key: payments are not real money')
  if (env.RAZORPAY_WEBHOOK_SECRET === 'whsec_dev') errors.push('RAZORPAY_WEBHOOK_SECRET is the dev default: set the secret from the Razorpay webhook settings')

  if (env.SMS_PROVIDER !== 'jio') {
    // A preview may log codes instead (read them in the Vercel logs); production can't.
    if (preview) warnings.push('SMS_PROVIDER is not jio: login codes are only written to the logs')
    else errors.push('SMS_PROVIDER must be jio: customers could not receive login codes')
  }

  for (const key of ['ADMIN_ORIGIN', 'CUSTOMER_ORIGIN']) {
    const list = origins(env[key])
    if (!list.length) errors.push(`${key} is empty`)
    for (const o of list) {
      if (!/^https:\/\/[^/]+$/.test(o)) errors.push(`${key} must be https origins with no path (got ${o})`)
      else if (/^https:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(o)) errors.push(`${key} points at localhost (${o})`)
    }
  }

  if (env.WHATSAPP_PROVIDER !== 'meta') {
    warnings.push('WHATSAPP_PROVIDER is not meta: no order updates, no WhatsApp login fallback, no ordering in the chat')
  } else if (!env.WHATSAPP_VERIFY_TOKEN || !env.WHATSAPP_APP_SECRET) {
    warnings.push('WHATSAPP_VERIFY_TOKEN or WHATSAPP_APP_SECRET is unset: ordering in the WhatsApp chat is off')
  }
  if (vercel) {
    if (env.CRON_SECRET.length < 16) errors.push('CRON_SECRET is unset or short: Vercel Cron could not run the maintenance job (holds, payments, messages)')
    if (/-pooler\./.test(env.DATABASE_URL) && !env.DATABASE_URL_UNPOOLED) {
      errors.push('DATABASE_URL_UNPOOLED is unset: migrations need Neon\'s direct connection')
    }
    if (!env.BLOB_READ_WRITE_TOKEN) {
      // Photos in Postgres bloat the database (and its backups) fast: production must use Blob.
      if (preview) warnings.push('BLOB_READ_WRITE_TOKEN is unset: preview photos are kept in the database')
      else errors.push('BLOB_READ_WRITE_TOKEN is unset: delivery and claim photos would fill the database (connect Vercel Blob)')
    }
  }
  if (!env.GOOGLE_CLIENT_ID) warnings.push('GOOGLE_CLIENT_ID is unset: "Sign in with Google" is off')
  if (!env.SENTRY_DSN) warnings.push('SENTRY_DSN is unset: errors are only in the logs')
  if (env.STAFF_TWO_STEP === 'optional') warnings.push('STAFF_TWO_STEP is optional: managers and operators can sign in with only a password')
  if (!env.TRUST_PROXY) warnings.push('TRUST_PROXY is 0: behind a proxy, rate limits see every customer as one address (set 1 behind Caddy)')

  return { errors, warnings }
}
