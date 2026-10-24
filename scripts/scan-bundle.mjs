#!/usr/bin/env node
// Bundle safety (OPS readiness, Phase 3): scans the built shop and panel for
// things that must never ship to a browser.
//
//   node scripts/scan-bundle.mjs dist customer-app/dist                  (CI)
//   node scripts/scan-bundle.mjs dist --forbid-localhost                 (a production build)
//
// It fails (exit 1) on:
// - secrets: Razorpay key ids (rzp_live_/rzp_test_: the shop gets the key id
//   from the API at checkout, so a literal one means a key was baked in),
//   private keys, postgres:// URLs, webhook and Blob tokens, real-looking JWTs,
//   the API's development JWT secret, the names of server-only secrets, and the
//   value of any server secret set in this build's environment (SECRET_ENV);
// - development-only code: /v1/dev routes and the dev payment stand-ins;
// - demo accounts (@mandimangoes.test, the seed's demo passwords);
// - mock providers (the panel's test mock API, a mock service worker);
// - source maps (they publish the source);
// - with --forbid-localhost, a localhost API address (VITE_API_URL unset).
// Each finding prints the file, the rule and a short, redacted excerpt.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Server-side secrets: their values must never appear in a bundle. */
export const SECRET_ENV = [
  'JWT_SECRET', 'CRON_SECRET', 'OTP_PEPPER', 'METRICS_TOKEN',
  'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_WEBHOOK_SECRET_PREVIOUS',
  'WHATSAPP_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'JIO_SMS_API_KEY',
  'BLOB_READ_WRITE_TOKEN', 'TURNSTILE_SECRET_KEY', 'SENTRY_AUTH_TOKEN',
  'DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'BACKUP_DATABASE_URL', 'BACKUP_HEARTBEAT_DATABASE_URL',
  'ADMIN_BOOTSTRAP_PASSWORD', 'PREVIEW_ADMIN_PASSWORD',
]

// Names a frontend has no reason to mention. Not BLOB_READ_WRITE_TOKEN or
// SENTRY_AUTH_TOKEN: the @vercel/blob and Sentry libraries name them in their
// own (server-side) code paths, which ship in the bundle unused.
const SERVER_ONLY_NAMES = SECRET_ENV.filter((n) => !['BLOB_READ_WRITE_TOKEN', 'SENTRY_AUTH_TOKEN'].includes(n))

/** [id, what it means, pattern]. Patterns are global so every match is reported. */
export const RULES = [
  ['razorpay-live-key', 'a Razorpay live key id', /rzp_live_[A-Za-z0-9]{6,}/g],
  ['razorpay-test-key', 'a Razorpay test key id (the key id comes from the API, never the bundle)', /rzp_test_[A-Za-z0-9]{6,}/g],
  // A key's body follows the header (a library that only checks the header text is fine).
  ['private-key', 'a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\\n|\\r|\s)*[A-Za-z0-9+/=]{40,}/g],
  ['postgres-url', 'a database connection string', /postgres(?:ql)?:\/\/[^\s"'`]+/g],
  ['dev-jwt-secret', "the API's development JWT secret", /dev-only-change-me[0-9a-f]*/g],
  ['webhook-secret', 'a webhook secret', /whsec_[A-Za-z0-9]{6,}/g],
  ['blob-token', 'a Vercel Blob read-write token', /vercel_blob_rw_[A-Za-z0-9_]{8,}/g],
  ['jwt', 'a signed token (JWT)', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['secret-name', 'the name of a server-only secret', new RegExp(`\\b(?:${SERVER_ONLY_NAMES.join('|')})\\b`, 'g')],
  ['dev-route', 'a development-only API route', /\/v1\/dev\b/g],
  ['dev-payment', 'the development payment stand-in', /\bpay_dev_|\bdevGateway\b|rzp_dev_checkout_secret/g],
  ['demo-account', 'a demo staff account', /@mandimangoes\.test\b/g],
  ['demo-password', 'a demo staff password from the seed', /\b(?:manager|operator|packer|qc|rider)123\b/g],
  ['mock-provider', 'a mock API or mock service worker', /\bmock-api\b|\bmockApi\b|\bMockApi\b|mockServiceWorker/g],
]

const LOCALHOST = ['localhost-api', 'a localhost address (VITE_API_URL was not set for this build)', /https?:\/\/(?:localhost|127\.0\.0\.1):\d+/g]
// (With a port: libraries use a bare "http://localhost" as a URL base.)

const TEXT = /\.(?:js|mjs|cjs|css|html?|json|txt|svg|webmanifest|xml)$/i

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) yield* files(p)
    else yield p
  }
}

/** Shows enough of a match to find it, never a whole secret. */
const redact = (s) => (s.length <= 16 ? s : `${s.slice(0, 12)}…(${s.length} chars)`)

/**
 * Scans one text. `secrets` are literal values (from the environment) that must not appear.
 * Returns [{ rule, what, match }].
 */
export function scanText(text, { forbidLocalhost = false, secrets = [] } = {}) {
  const out = []
  const rules = forbidLocalhost ? [...RULES, LOCALHOST] : RULES
  for (const [rule, what, re] of rules) {
    for (const m of text.matchAll(re)) out.push({ rule, what, match: redact(m[0]) })
  }
  for (const { name, value } of secrets) {
    if (text.includes(value)) out.push({ rule: 'secret-value', what: `the value of ${name}`, match: `${name}=…` })
  }
  return out
}

/** The values of server secrets set in this environment (8+ characters, so short test values don't match everything). */
export function secretValues(env = process.env) {
  return SECRET_ENV.filter((n) => (env[n] ?? '').length >= 8).map((name) => ({ name, value: env[name] }))
}

/** Scans every file under the given directories. Returns [{ file, rule, what, match }]. */
export function scanDirs(dirs, { forbidLocalhost = false, secrets = secretValues() } = {}) {
  const findings = []
  for (const dir of dirs) {
    for (const file of files(dir)) {
      if (file.endsWith('.map')) {
        findings.push({ file, rule: 'source-map', what: 'a source map (publishes the source code)', match: path.basename(file) })
        continue
      }
      if (!TEXT.test(file)) continue
      for (const f of scanText(readFileSync(file, 'utf8'), { forbidLocalhost, secrets })) findings.push({ file, ...f })
    }
  }
  return findings
}

export function main(argv = process.argv.slice(2)) {
  // --forbid-localhost-in-production: only Vercel production builds must name a
  // real API; preview builds may still point at localhost.
  const forbidLocalhost =
    argv.includes('--forbid-localhost') ||
    (argv.includes('--forbid-localhost-in-production') && process.env.VERCEL_ENV === 'production')
  const dirs = argv.filter((a) => !a.startsWith('--'))
  if (!dirs.length) {
    console.error('usage: node scripts/scan-bundle.mjs <dist dir>... [--forbid-localhost | --forbid-localhost-in-production]')
    return 2
  }
  for (const d of dirs) {
    try {
      if (!statSync(d).isDirectory()) throw new Error()
    } catch {
      console.error(`${d} is not a directory: build first (npm run build, npm run shop:build)`)
      return 2
    }
  }
  const findings = scanDirs(dirs, { forbidLocalhost })
  for (const f of findings) console.log(`FAIL  ${f.file}: ${f.what} [${f.rule}] ${f.match}`)
  if (findings.length) {
    console.log(`\n${findings.length} problem(s) in the built bundle. Nothing above may ship to a browser.`)
    return 1
  }
  console.log(`Bundle scan passed: ${dirs.join(', ')} (${RULES.length + (forbidLocalhost ? 1 : 0)} rules, ${secretValues().length} secret values checked)`)
  return 0
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  process.exitCode = main()
}
