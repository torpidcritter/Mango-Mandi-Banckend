// Go-live checks on the settings. `errors` stop a production start; `warnings`
// are things that work but leave a feature off or a risk open.
// env.js runs this on every production start; `npm run preflight` prints the
// whole list (and checks the database) without starting the server.

export const DEV_JWT = 'dev-only-change-me-0123456789abcdef0123456789'

/** A Neon endpoint without its -pooler suffix, so the pooled and direct URLs compare equal. */
export function dbHost(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^([^.]+)-pooler\./, '$1.')
  } catch {
    return ''
  }
}
const sameHost = (a, b) => Boolean(a && b) && dbHost(`postgres://${a.replace(/^[a-z]+:\/\//, '')}`) === dbHost(`postgres://${b.replace(/^[a-z]+:\/\//, '')}`)

const origins = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean)

export function checkProduction(env, { vercel = Boolean(process.env.VERCEL), target = process.env.VERCEL_ENV || 'production' } = {}) {
  const errors = []
  const warnings = []
  const preview = target === 'preview'

  if (env.JWT_SECRET.length < 32 || env.JWT_SECRET === DEV_JWT || env.JWT_SECRET.startsWith('dev-only-change-me')) {
    errors.push('JWT_SECRET too weak: set a random string of 32+ characters (openssl rand -hex 32)')
  }
  if (!env.COOKIE_SECURE) errors.push('COOKIE_SECURE must be true in production')

  // Payments: there is no cash on delivery, so without Razorpay nobody can pay.
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) errors.push('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required: customers could not pay')
  else if (preview && env.RAZORPAY_KEY_ID.startsWith('rzp_live_')) errors.push('RAZORPAY_KEY_ID is a live key on a preview: previews must use test keys, or they could take real money')
  else if (!preview && env.RAZORPAY_KEY_ID.startsWith('rzp_test_')) warnings.push('RAZORPAY_KEY_ID is a test key: payments are not real money')
  if (env.RAZORPAY_WEBHOOK_SECRET === 'whsec_dev') errors.push('RAZORPAY_WEBHOOK_SECRET is the dev default: set the secret from the Razorpay webhook settings')
  if (env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS === 'whsec_dev') errors.push('RAZORPAY_WEBHOOK_SECRET_PREVIOUS is the dev default: unset it')
  else if (env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS) warnings.push('RAZORPAY_WEBHOOK_SECRET_PREVIOUS is set: webhooks signed with the old secret are still accepted; unset it a day after the rotation')
  // PAY-B7: Payments on WhatsApp has no reconcile loop yet, so a lost status
  // event leaves a paid chat order unconfirmed until staff spot it.
  if (env.WHATSAPP_PAYMENT_CONFIG) {
    warnings.push('WHATSAPP_PAYMENT_CONFIG is set: chat orders are paid inside WhatsApp, which has no payment reconcile yet (a lost status event is only seen in Needs attention). Leave it unset to send Razorpay payment links instead')
  }

  if (env.SMS_PROVIDER !== 'jio') {
    // A preview may log codes instead (read them in the Vercel logs); production can't,
    // but can send them by WhatsApp only (before Jio DLT is approved, say).
    if (!preview && env.WHATSAPP_PROVIDER !== 'meta') errors.push('No way to send login codes: set SMS_PROVIDER=jio, or WHATSAPP_PROVIDER=meta with OTP_DEFAULT_CHANNEL=whatsapp')
    else if (!preview && env.OTP_DEFAULT_CHANNEL !== 'whatsapp') errors.push('SMS_PROVIDER is not jio, so set OTP_DEFAULT_CHANNEL=whatsapp: login codes can only go by WhatsApp')
    else if (!preview) warnings.push('Login codes go by WhatsApp only (SMS_PROVIDER is not jio): customers without WhatsApp must use Google sign-in')
    else if (env.LOG_OTP_CODES) warnings.push('SMS_PROVIDER is not jio: login codes are only written to the logs')
    else warnings.push('SMS_PROVIDER is not jio and LOG_OTP_CODES is off: phone sign-in cannot work on this preview (Google sign-in still does)')
  }
  if (env.SMS_PROVIDER === 'jio' && (!env.JIO_SMS_SUCCESS_PATH || !env.JIO_SMS_SUCCESS_VALUES)) {
    errors.push("JIO_SMS_SUCCESS_PATH and JIO_SMS_SUCCESS_VALUES are required: copy from Jio's API documentation how a reply says the SMS was accepted")
  }
  if (env.LOG_OTP_CODES && !preview) errors.push('LOG_OTP_CODES must be off in production: login codes would be written to the logs')
  if (env.ENABLE_DEV_ROUTES) errors.push('ENABLE_DEV_ROUTES is set: it is for local development only (it lets anyone mark an order paid)')

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
    // Production and previews must each know which database is production, so a
    // preview never touches it, even before the database is stamped.
    const prodHost = env.PRODUCTION_DB_HOST
    const urls = [env.DATABASE_URL, env.DATABASE_URL_UNPOOLED].filter(Boolean)
    if (!prodHost) errors.push('PRODUCTION_DB_HOST is unset: set it to the Neon main host, for Production and Preview, so a preview can never use the production database')
    else if (preview && urls.some((u) => sameHost(u, prodHost))) errors.push('DATABASE_URL points at the production database on a preview: use the Neon staging branch')
    else if (!preview && !urls.every((u) => sameHost(u, prodHost))) errors.push(`DATABASE_URL is not the production database (${prodHost}): production must use Neon main`)
    if (preview && (env.ADMIN_BOOTSTRAP_EMAIL || env.ADMIN_BOOTSTRAP_PASSWORD)) {
      errors.push('ADMIN_BOOTSTRAP_* is set on previews: tick only Production for it, and give previews PREVIEW_ADMIN_EMAIL and PREVIEW_ADMIN_PASSWORD')
    }
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
  if (Boolean(env.TURNSTILE_SECRET_KEY) !== Boolean(env.TURNSTILE_SITE_KEY)) errors.push('Set both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY, or neither: with one alone nobody could get a login code')
  if (!env.TURNSTILE_SECRET_KEY) {
    if (preview) warnings.push('TURNSTILE_SECRET_KEY is unset: bots can request login codes for any number (the daily budget still caps the cost)')
    else errors.push('TURNSTILE_SECRET_KEY and TURNSTILE_SITE_KEY are required: without them bots can request login codes for any number')
  }
  if (!env.GOOGLE_CLIENT_ID) warnings.push('GOOGLE_CLIENT_ID is unset: "Sign in with Google" is off')
  // OPS-09: Sentry is the only thing that pages anyone about errors, failing refunds and a stopped job.
  if (!env.SENTRY_DSN) {
    if (preview) warnings.push('SENTRY_DSN is unset: errors are only in the logs')
    else errors.push('SENTRY_DSN is required in production: without it nobody is alerted to errors, failed refunds or a stopped maintenance job')
  }
  if (env.STAFF_TWO_STEP === 'optional') warnings.push('STAFF_TWO_STEP is optional: staff can sign in with only a password')
  else if (env.STAFF_TWO_STEP === 'managers') warnings.push('STAFF_TWO_STEP is managers: packers, QC and riders sign in with only a password (the default is all)')
  if (!env.TRUST_PROXY) warnings.push('TRUST_PROXY is 0: behind a proxy, rate limits see every customer as one address (set 1 behind Caddy)')

  return { errors, warnings }
}

/** A Postgres duration setting that means "no limit": 0 in any unit, or nothing. */
const noLimit = (v) => !v || /^0+(\.0+)?\s*(us|ms|s|min|h|d)?$/i.test(String(v).trim())

/**
 * OPS-29: through Neon's pooler (transaction mode) the app can't set
 * statement_timeout per connection (db.js), so the limits must be set on the
 * database role (deploy/VERCEL.md, step 1). Without them a stuck query, or a
 * function stopped mid-transaction, holds its row locks (stock) indefinitely.
 * `query` runs over DATABASE_URL, logged in as the app's role.
 */
export async function checkRoleTimeouts(query, { pooled }) {
  const errors = []
  const warnings = []
  const ok = []
  for (const [name, suggested] of [['statement_timeout', '10s'], ['idle_in_transaction_session_timeout', '30s']]) {
    const value = (await query(`SHOW ${name}`)).rows[0]?.[name]
    if (!noLimit(value)) ok.push(`${name} is ${value}`)
    else if (pooled) errors.push(`${name} is not set for the app's database role, and through the pooler nothing else sets it: ALTER ROLE <app role> SET ${name} = '${suggested}' (deploy/VERCEL.md, step 1)`)
    else warnings.push(`${name} is not set for the app's database role (0 = no limit)`)
  }
  return { errors, warnings, ok }
}
