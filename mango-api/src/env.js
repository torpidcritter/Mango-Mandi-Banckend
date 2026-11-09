// Validated configuration. In production the app refuses to start with
// placeholder secrets.
import { z } from 'zod'
import { checkProduction, DEV_JWT } from './preflight.js'

/** Running as a Vercel Function (Vercel sets VERCEL=1). */
export const onVercel = Boolean(process.env.VERCEL)

/** An on/off setting written true or false, off unless set. */
const flag = () =>
  z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true')

/** An on/off setting whose default depends on where it runs: undefined unless set (see the ??= below the schema). */
const optionalFlag = () =>
  z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true'))

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  // The address a long-running server listens on (index.js). Unset: every interface, as Docker
  // needs. SEC-01 (24 Oct audit): a local run sets 127.0.0.1, so /v1/dev is not reachable from the
  // Wi-Fi; phones reach the API only through the shop's dev-server proxy, which refuses /v1/dev.
  HOST: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().default('postgres://mango:mango@localhost:5432/mango'),
  // Neon: DATABASE_URL is the pooled (-pooler) URL; migrations need the direct one.
  DATABASE_URL_UNPOOLED: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(onVercel ? 5 : 10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  // A query slower than this is logged (duration and the start of its SQL, never its values); 0 turns it off.
  DB_SLOW_QUERY_MS: z.coerce.number().int().min(0).default(500),
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
  // Shown to a customer who gives 1 or 2 stars after the claim window has closed.
  SUPPORT_CONTACT: z.string().default('Message us on WhatsApp and we will sort it out.'),
  // "How were your mangoes?" a day after delivery. Turn on once Meta approves mandi_review_request.
  WHATSAPP_REVIEW_REQUESTS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // UX-4: "we got your claim" and "claim rejected, because …". Turn on once Meta approves
  // mandi_claim_received and mandi_claim_rejected (each with an "Open order" URL button).
  WHATSAPP_CLAIM_UPDATES: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // UX-7: an "Open order" URL button (https://<shop>/orders/{{1}}) on the order update templates.
  // Turn on only once Meta has approved the new versions with that button (mango-api/README.md).
  WHATSAPP_ORDER_LINKS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // The Warehouse area (boxes, labels, scanning: docs/warehouse/). Off: its routes answer 404 and the panel hides it.
  WAREHOUSE_V2: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // App feel (docs/app-feel.md). Each is off unless set, so each can be rolled back on its own.
  // WEB_PUSH: customers may turn on browser notifications on the Account page, and order updates
  // are pushed to them beside WhatsApp. Needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT.
  WEB_PUSH: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // vapid: send to the browser's push service (production). log: write a line instead (the default,
  // so development and tests never reach a real push service).
  WEB_PUSH_PROVIDER: z.enum(['log', 'vapid']).default('log'),
  // The application server keys (RFC 8292), base64url: the public key is the 65-byte P-256 point,
  // the private key the 32-byte scalar. `node scripts/vapid-keys.mjs` makes a pair.
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  // Who the push services can contact about our messages: mailto: or https: (RFC 8292).
  VAPID_SUBJECT: z.string().default(''),
  // Push service hosts a subscription's endpoint may point at (the API posts to it, so it is an
  // allowlist, not a guess). "*.x" matches any subdomain of x.
  WEB_PUSH_HOSTS: z
    .string()
    .default('fcm.googleapis.com,updates.push.services.mozilla.com,web.push.apple.com,*.push.apple.com,*.notify.windows.com'),
  // LIVE_TRACKING: "your rider is N stops away" on the shop's order page, and the riders' Route view
  // on the panel's Deliveries page. Minutes per stop are a selling rule (minutesPerStop).
  LIVE_TRACKING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // FAVOURITES: hearts on the shop's boxes and a Favourites list on the Account page.
  FAVOURITES: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // SHOP_INSTALL: the shop registers its service worker (static app shell only) and offers "Install app".
  SHOP_INSTALL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // MULTI_GIFT: one gift order sent to many recipients, paid once (docs/gifting.md).
  MULTI_GIFT: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // With MULTI_GIFT: the most recipients one gift order may have.
  MULTI_GIFT_MAX_RECIPIENTS: z.coerce.number().int().min(1).max(100).default(25),
  // SHOP_SORT_FILTER: sort and filter controls on the shop's home page.
  SHOP_SORT_FILTER: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Growth (docs/growth.md). Each is off unless set, so each can be rolled back on its own.
  // REFERRALS: each customer's referral code and share link on the Account page; a new customer
  // enters a friend's code once, and both get a one-time promo code once the friend's first order
  // is paid (withdrawn again, if still unused, when that order is cancelled or refunded).
  // Needs the Meta template mandi_referral_reward before it is turned on.
  REFERRALS: flag(),
  // The thank-you each side gets, off a later order of regular boxes: PERCENT (REFERRAL_REWARD_PERCENT,
  // optionally capped at REFERRAL_REWARD_MAX_RUPEES) or FLAT (REFERRAL_REWARD_RUPEES). Then the
  // smallest first order (regular boxes, before any discount) that earns it, in rupees.
  REFERRAL_REWARD_KIND: z.enum(['PERCENT', 'FLAT']).default('PERCENT'),
  REFERRAL_REWARD_PERCENT: z.coerce.number().int().min(1).max(90).default(10),
  REFERRAL_REWARD_MAX_RUPEES: z.coerce.number().int().min(1).max(100_000).optional(),
  REFERRAL_REWARD_RUPEES: z.coerce.number().int().min(1).max(5000).default(100),
  REFERRAL_MIN_ORDER_RUPEES: z.coerce.number().int().min(1).max(100_000).default(499),
  // Thank-yous one referrer may get in a calendar month (IST); friends past it still get theirs.
  REFERRAL_MAX_PER_MONTH: z.coerce.number().int().min(1).max(1000).default(10),
  // FUNNEL_ANALYTICS: the shop sends anonymous steps (visit, product view, add to cart, checkout
  // start) with a random per-browser id; "paid" is recorded by the API when a payment is captured.
  // Off: the events endpoint answers 204 and stores nothing.
  FUNNEL_ANALYTICS: flag(),
  // MANAGER_DAILY_SUMMARY: each evening every opted-in manager gets the day's numbers on WhatsApp
  // (template MANAGER_SUMMARY_TEMPLATE, which Meta must approve first).
  MANAGER_DAILY_SUMMARY: flag(),
  // When the summary goes, IST, HH:MM.
  MANAGER_SUMMARY_TIME: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, 24-hour, IST').default('20:00'),
  // The approved Meta template's full name (no prefix is added).
  MANAGER_SUMMARY_TEMPLATE: z.string().regex(/^[a-z0-9_]+$/).default('mandimangoes_daily_summary'),
  // Customer care (docs/care.md). Each is off unless set, so each can be rolled back on its own.
  // HELP_CENTRE: signed-in customers open help requests (about an order, or general) and follow
  // a message thread with the shop; staff answer them on the panel's Help desk.
  HELP_CENTRE: flag(),
  // New help requests one customer may open in 24 hours.
  HELP_DAILY_LIMIT: z.coerce.number().int().min(1).max(50).default(5),
  // SUBSCRIPTIONS: a box every week or fortnight until the season ends. No auto-debit: before
  // each delivery the customer is reminded and pays for that box as an ordinary order.
  SUBSCRIPTIONS: flag(),
  // The last day a subscription may run to (YYYY-MM-DD). Unset: subscriptions can't be started.
  SUBSCRIPTION_SEASON_END: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'SUBSCRIPTION_SEASON_END must be YYYY-MM-DD').optional(),
  // How many days before a delivery its cycle is set up and the "pay for this box" reminder goes out.
  SUBSCRIPTION_LEAD_DAYS: z.coerce.number().int().min(1).max(5).default(2),
  // WhatsApp for both: mandi_help_reply and mandi_subscription_due. Turn on once Meta approves them;
  // until then customers see replies and reminders in the shop (and as browser notifications with WEB_PUSH).
  WHATSAPP_CARE_UPDATES: flag(),
  // Partner Network (docs/partner-network.md): the shop's Partner With Us form and the panel's
  // Partner Network section. On unless set to false; managers can also turn it off on the panel.
  PARTNER_NETWORK: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // WhatsApp for it: the applicant's "we received your enquiry" (mandi_partner_enquiry_received) and
  // the business team's alerts (mandi_partner_team_alert). Turn on once Meta approves both.
  WHATSAPP_PARTNER_UPDATES: flag(),
  // Who gets the team alerts: comma-separated Indian mobile numbers. Unset: no team alerts (the panel shows the same).
  PARTNER_ALERT_PHONES: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((p) => p.trim()).filter(Boolean))
    .refine((list) => list.every((p) => /^(\+91)?[6-9]\d{9}$/.test(p.replace(/[\s-]/g, ''))), 'PARTNER_ALERT_PHONES must be Indian mobile numbers, comma-separated')
    .transform((list) => list.map((p) => `+91${p.replace(/[\s-]/g, '').replace(/^\+91/, '')}`)),
  // Farm Experience (docs/farm-experience.md): 250 kg or more bought online with a visit to the farm.
  // Off unless set to true; managers can also turn it on or off on the panel once it is allowed here.
  // Customers can book only once a manager also opens bookings on the Farm Settings page.
  FARM_EXPERIENCE: flag(),
  // WhatsApp for it: the customer's updates (mandi_farm_booking_update) and the team's alerts
  // (mandi_farm_team_alert). Turn on once Meta approves both; until then the booking page shows the same.
  WHATSAPP_FARM_UPDATES: flag(),
  // Who gets the team alerts: comma-separated Indian mobile numbers. Unset: no team alerts (the panel shows the same).
  FARM_ALERT_PHONES: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((p) => p.trim()).filter(Boolean))
    .refine((list) => list.every((p) => /^(\+91)?[6-9]\d{9}$/.test(p.replace(/[\s-]/g, ''))), 'FARM_ALERT_PHONES must be Indian mobile numbers, comma-separated')
    .transform((list) => list.map((p) => `+91${p.replace(/[\s-]/g, '').replace(/^\+91/, '')}`)),
  // SHOP_LANGUAGES: the shop in Hindi and Kannada as well as English, chosen by each customer
  // (saved to their account once signed in). Off: the shop is English only (docs/languages.md).
  SHOP_LANGUAGES: flag(),
  // Stocktake (cycle count) sessions and their review (docs/warehouse/STOCKTAKE.md). Needs WAREHOUSE_V2.
  WAREHOUSE_STOCKTAKE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Repack, split, merge and partial damage (docs/warehouse/REPACK.md). Needs WAREHOUSE_V2.
  WAREHOUSE_REPACK: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Offer the device camera as a scanner in the panel's scan screens (docs/warehouse/SCANNING.md). Needs WAREHOUSE_V2.
  WAREHOUSE_CAMERA_SCAN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // The most boxes one intake may label (brief 8.1).
  WAREHOUSE_MAX_LOT: z.coerce.number().int().min(1).max(20000).default(5000),
  // Minutes an open scan session may sit idle before it expires.
  WAREHOUSE_OP_IDLE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(30),
  // Fixes from the 24 Oct 2026 audit, security, integrations and platform part
  // (docs/audit-2026-10-24-status-B.md). Unset, each is on in production and off
  // elsewhere (strictDefaults below); false turns one off (the rollback, and
  // preflight warns).
  // SEC-02, SEC-09: framework errors caused by the request answer 4xx (not 500 and a
  // Sentry event), a wrong method 405 with Allow, 503 bodies carry retryAfterSeconds, and
  // the shop and panel may read Retry-After and X-Request-Id across origins.
  API_HARDENING: optionalFlag(),
  // INT-04, INT-09, INT-10, INT-11, INT-12, INT-13, INT-14, INT-18: provider calls and messages
  // (stale messages skipped, Meta error codes, login codes, Blob timeouts and sweeps, chat retries).
  PROVIDER_CHECKS: optionalFlag(),
  // INT-03, INT-06, INT-07, INT-08: alerts that today go quiet or never fire, and the
  // Vercel checks for every ops/alerts.yml rule (docs/alerts.md). Unset: on in production,
  // off elsewhere; false turns it off (preflight warns).
  OPS_ALERTS: optionalFlag(),
  // With OPS_ALERTS (docs/alerts.md): an answer slower than this many ms counts as slow; 0 counts none.
  // File downloads, photo uploads and the maintenance run are never counted.
  SLOW_REQUEST_MS: z.coerce.number().int().min(0).default(2000),
  // checkHealth warns when, in the last 10 minutes, there were more than this many server errors
  // (5xx), slow answers, or 503 BUSY answers for want of a database connection.
  ALERT_API_ERRORS: z.coerce.number().int().min(0).default(10),
  ALERT_SLOW_REQUESTS: z.coerce.number().int().min(0).default(20),
  ALERT_DB_BUSY: z.coerce.number().int().min(0).default(5),
  // SEC-06, PLT-06, PLT-07, PLT-08, PLT-09: dispatch dates, replacement and retry promises.
  DELIVERY_CHECKS: optionalFlag(),
  // SEC-07: adding staff, changing a role or password, two-step resets and removals ask
  // the manager for their own two-step code (or password) again. Unset: on in production,
  // off elsewhere. Money and pricing changes always ask (admin/step-up.js STEP_UP_ROUTES).
  STAFF_STEP_UP: optionalFlag(),
  // SEC-08: staff changes are audited in their own transaction, opening customer details
  // is audited, and refused attempts are logged. Unset: on in production, off elsewhere.
  STAFF_AUDIT_TRAIL: optionalFlag(),
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
  // Login-code requests per address per 15 minutes (ratelimit.js otpIpLimit). Unset: 200 in
  // production, 300 elsewhere. Kept well above one person's need because a mobile carrier's NAT
  // puts many customers behind one address; the per-number caps, Turnstile and the daily
  // budget are what stop SMS pumping.
  OTP_IP_LIMIT: z.coerce.number().int().positive().optional(),
  REFRESH_REUSE_GRACE_MS: z.coerce.number().int().min(0).default(10_000),
  // The longest a sign-in lasts, however often it is refreshed: then the person signs in again.
  STAFF_SESSION_MAX_DAYS: z.coerce.number().positive().max(90).default(7),
  CUSTOMER_SESSION_MAX_DAYS: z.coerce.number().positive().max(365).default(90),
  // Checkout quotes, order confirms and cancels per signed-in customer per minute (customer.js).
  CUSTOMER_ACTION_LIMIT: z.coerce.number().int().positive().default(20),
  RAZORPAY_WEBHOOK_SECRET: z.string().default('whsec_dev'),
  // While rotating the webhook secret: the old one, so Razorpay's retries of older events still verify. Remove it a day later.
  RAZORPAY_WEBHOOK_SECRET_PREVIOUS: z.string().default(''),
  RAZORPAY_KEY_ID: z.string().default(''),
  RAZORPAY_KEY_SECRET: z.string().default(''),
  METRICS_TOKEN: z.string().default(''),
  ADMIN_BOOTSTRAP_EMAIL: z.string().email().optional(),
  ADMIN_BOOTSTRAP_PASSWORD: z.string().min(12).optional(),
  // Previews get their own first manager, so the production password is never in a preview.
  PREVIEW_ADMIN_EMAIL: z.string().email().optional(),
  PREVIEW_ADMIN_PASSWORD: z.string().min(12).optional(),
  SMS_PROVIDER: z.enum(['log', 'jio']).default('log'),
  // With SMS_PROVIDER=log, write login codes to the log. Off unless asked for: outside
  // production the API already returns the code as devCode; on a preview it is the only way in.
  LOG_OTP_CODES: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Outside production the code also comes back in the response (devCode), for the shop's test
  // mode. scripts/start-local.mjs --phone turns it off (SEC-01): the shop is then on a public link,
  // and the code is printed in the local console instead (with LOG_OTP_CODES=true).
  OTP_CODE_IN_RESPONSE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // The pepper for stored login-code hashes. Unset: JWT_SECRET, as before. Setting it later keeps
  // codes already sent working (they are checked against both until they lapse in 5 minutes).
  OTP_PEPPER: z.string().default(''),
  // TD-09: encrypts staff two-step (TOTP) secrets at rest, 32 bytes base64 (openssl rand -base64 32).
  // Keep it apart from JWT_SECRET and the database. Unset: secrets are stored as before.
  // Once set, never remove or change it without first re-enrolling staff: sealed secrets need it.
  TOTP_ENCRYPTION_KEY: z.string().default(''),
  // SEC-05: customer details on finished orders (name, phone, address, gift details, delivery GPS)
  // are removed this many months after the delivery date. Amounts and tax fields stay, and the
  // order's bill keeps everything printed on it (BILL_RETENTION_MONTHS).
  PII_RETENTION_MONTHS: z.coerce.number().int().min(1).max(120).default(12),
  // Bills keep everything printed on them, the buyer's name and delivery address included, this
  // many months after the bill date; then the name and address come off. Tax law needs bills kept
  // for years (docs/trust.md, "How long bills are kept"): the client's CA must confirm the period.
  // Production refuses less than 72 (preflight.js).
  BILL_RETENTION_MONTHS: z.coerce.number().int().min(12).max(240).default(96),
  // Staff Google sign-in only for accounts of this Google Workspace domain (the token's hd claim).
  // Unset: any verified Google account whose email is a staff email.
  STAFF_GOOGLE_HD: z.string().default(''),
  // /v1/dev (pay any order without paying). Needs this, NODE_ENV other than production and no Razorpay keys.
  ENABLE_DEV_ROUTES: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // A 500 also carries the error's text (scrubbed, short), so a local run shows the cause on screen.
  // Never in production: there it stays in the logs and Sentry only.
  SHOW_ERROR_DETAILS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  JIO_SMS_URL: z.string().url().optional(),
  JIO_SMS_API_KEY: z.string().optional(),
  JIO_SMS_SENDER_ID: z.string().optional(),
  JIO_SMS_TEMPLATE_ID: z.string().optional(),
  JIO_SMS_ENTITY_ID: z.string().optional(),
  JIO_SMS_TEXT: z.string().default('{code} is your MandiMangoes login code. It expires in 5 minutes.'),
  // How a Jio reply says the SMS was accepted, copied from Jio's API documentation
  // (OPS-03): an HTTP 200 alone is not proof. A dot path into the JSON reply
  // (e.g. "status" or "data.state") and the values that mean accepted, comma
  // separated. Optional: the field holding Jio's message id, for the log.
  JIO_SMS_SUCCESS_PATH: z.string().default(''),
  JIO_SMS_SUCCESS_VALUES: z.string().default(''),
  JIO_SMS_ID_PATH: z.string().default(''),
  // The channel a login code goes by when the customer didn't choose; the other is the fallback.
  // whatsapp: WhatsApp first (works before Jio DLT is approved).
  OTP_DEFAULT_CHANNEL: z.enum(['sms', 'whatsapp']).default('sms'),
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
  // docs/whatsapp/CONFIGURATION.md. The WhatsApp Business Account id: needed only for the
  // template sync and the connection check on the panel's WhatsApp page (the number's own
  // id, WHATSAPP_PHONE_NUMBER_ID, is what messages are sent from).
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().regex(/^\d*$/, 'digits only (the WABA id from WhatsApp Manager)').default(''),
  // The public address Meta posts the webhook to, shown on the WhatsApp page for setup.
  WHATSAPP_WEBHOOK_URL: z.string().url().or(z.literal('')).default(''),
  // Largest customer photo or document staff may open from a chat (Meta allows up to 100 MB).
  WHATSAPP_MEDIA_MAX_BYTES: z.coerce.number().int().min(100_000).max(100_000_000).default(16_000_000),
  // Words of WhatsApp messages are kept this many days, then cleared (the record of each stays 180 days).
  WHATSAPP_MESSAGE_RETENTION_DAYS: z.coerce.number().int().min(7).max(365).default(90),
  SEED_DEMO_DATA: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Backups record each run in maintenance_runs: Needs attention and Sentry warn
  // when none is recorded for 26 hours. Set by deploy/compose.yml (its backup
  // service); on Vercel set it once the GitHub backup workflow has its
  // BACKUP_HEARTBEAT_DATABASE_URL secret (deploy/VERCEL.md, Backups).
  BACKUP_HEARTBEAT_EXPECTED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Fixes from the 24 Oct 2026 audit that change what staff, customers or the
  // background run may do (docs/audit-2026-10-24-status-A.md). Unset, each is
  // on in production and off elsewhere (strictDefaults below); false turns one
  // off (the rollback, and preflight warns).
  // PAY-05, PAY-06: "paid back another way" is refused while Razorpay can't be
  // checked, and no refund goes out automatically while a chargeback is open.
  REFUND_SAFETY_CHECKS: optionalFlag(),
  // PAY-08: once a day, every payment Razorpay captured in the last 3 days is
  // matched to an order or booking, or listed in Needs attention. Unset: on in
  // production (the backstop for a lost webhook), off elsewhere; false turns it off.
  PAYMENT_DAILY_RECON: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  // INV-01, INV-07, INV-10: a reschedule never overfills a delivery slot, only a
  // manager cancels a free replacement, and a chat order re-checks its pincode.
  ORDER_RULE_CHECKS: optionalFlag(),
  // INV-02, INV-08: a batch intake sent twice (same Idempotency-Key) makes one
  // batch, a big intake needs a manager, and stock still in transit after its
  // arrival date stops selling to new orders.
  STOCK_INTAKE_CHECKS: optionalFlag(),
  // With STOCK_INTAKE_CHECKS: the most boxes a non-manager may bring in with one batch.
  BATCH_INTAKE_MANAGER_BOXES: z.coerce.number().int().min(1).max(100_000).default(1000),
  // Staff operations (docs/ops.md). Each is off unless set to true.
  // STOCK_FORECAST: a read-only "boxes to buy" suggestion for the next 14 days on the Planning page (managers).
  STOCK_FORECAST: flag(),
  // PURCHASE_RECORDS: farms, what each batch cost, and margins per box and variety (costs: managers only).
  PURCHASE_RECORDS: flag(),
  // PANEL_FEATURE_SWITCHES: managers may turn the safe customer-facing switches on or off on the
  // panel's Settings page (src/feature-switches.js). An environment value of false always wins.
  PANEL_FEATURE_SWITCHES: flag(),
})

// Empty values (KEY= in .env) mean "use the default".
const parsed = schema.safeParse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')))
if (!parsed.success) {
  console.error('Invalid configuration:', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data
export const isProd = env.NODE_ENV === 'production'
/** /v1/dev pays orders for free: never in production, never with Razorpay keys set, and only when asked for. */
export const errorDetailsOn = () => !isProd && env.SHOW_ERROR_DETAILS
export const devRoutesOn = () => !isProd && env.ENABLE_DEV_ROUTES && !env.RAZORPAY_KEY_ID && !env.RAZORPAY_KEY_SECRET
/** Which deployment this is: Vercel's production or preview, else NODE_ENV. */
export const deployEnv = process.env.VERCEL_ENV || env.NODE_ENV

// Fail closed: without NODE_ENV=production the API runs its development
// stand-ins (a fake payment gateway, login codes in the response, /v1/dev).
// On Vercel that is never wanted, previews included (vercel dev aside).
if (onVercel && !isProd && process.env.VERCEL_ENV !== 'development') {
  console.error('Refusing to start: on Vercel NODE_ENV must be production, previews too (see deploy/VERCEL.md)')
  process.exit(1)
}
/**
 * Safeguards on by default in production and off elsewhere, so the local demo and the
 * tests keep working without them unless they turn one on: the staff ones, the ops
 * alerts, and the tested fixes from the 24 Oct 2026 audit.
 */
export const STRICT_SWITCHES = [
  'STAFF_STEP_UP', 'STAFF_AUDIT_TRAIL', 'OPS_ALERTS', 'API_HARDENING', 'PROVIDER_CHECKS', 'DELIVERY_CHECKS',
  'REFUND_SAFETY_CHECKS', 'ORDER_RULE_CHECKS', 'STOCK_INTAKE_CHECKS',
]

/**
 * Production defaults for STAFF_TWO_STEP and STRICT_SWITCHES. A value written in the
 * environment always wins (preflight warns when production turns one off).
 */
export function strictDefaults(e, prod) {
  e.STAFF_TWO_STEP ??= prod ? 'all' : 'optional'
  for (const key of STRICT_SWITCHES) e[key] ??= prod
  return e
}
strictDefaults(env, isProd)
// PAY-08: the daily match with Razorpay is on in production unless set to false.
env.PAYMENT_DAILY_RECON ??= isProd

if (env.WHATSAPP_PROVIDER === 'meta' && !(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID)) {
  console.error('WHATSAPP_PROVIDER=meta needs WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID')
  process.exit(1)
}

if (env.WEB_PUSH_PROVIDER === 'vapid' && !(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT)) {
  console.error('WEB_PUSH_PROVIDER=vapid needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT')
  process.exit(1)
}

const JIO_KEYS = ['JIO_SMS_URL', 'JIO_SMS_API_KEY', 'JIO_SMS_SENDER_ID', 'JIO_SMS_TEMPLATE_ID', 'JIO_SMS_ENTITY_ID']
if (env.SMS_PROVIDER === 'jio') {
  const missing = JIO_KEYS.filter((k) => !env[k])
  if (!env.JIO_SMS_SUCCESS_PATH) missing.push('JIO_SMS_SUCCESS_PATH')
  if (!env.JIO_SMS_SUCCESS_VALUES) missing.push('JIO_SMS_SUCCESS_VALUES')
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
