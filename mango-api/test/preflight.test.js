import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkProduction, DEV_JWT } from '../src/preflight.js'

const good = {
  JWT_SECRET: 'a'.repeat(64),
  LABEL_TOKEN_SECRET: 'l'.repeat(64),
  COOKIE_SECURE: true,
  RAZORPAY_KEY_ID: 'rzp_live_abc',
  RAZORPAY_KEY_SECRET: 's3cret',
  RAZORPAY_WEBHOOK_SECRET: 'whsec_live',
  SMS_PROVIDER: 'jio',
  ADMIN_ORIGIN: 'https://admin.mandimangoes.in',
  CUSTOMER_ORIGIN: 'https://mandimangoes.in,https://www.mandimangoes.in',
  WHATSAPP_PROVIDER: 'meta',
  WHATSAPP_VERIFY_TOKEN: 'v',
  WHATSAPP_APP_SECRET: 'a',
  TRUST_PROXY: 1,
  GOOGLE_CLIENT_ID: 'web.apps.googleusercontent.com',
  SENTRY_DSN: 'https://k@o1.ingest.sentry.io/1',
  CRON_SECRET: 'c'.repeat(32),
  DATABASE_URL: 'postgres://u:p@ep-x-pooler.ap-southeast-1.aws.neon.tech/mango',
  DATABASE_URL_UNPOOLED: 'postgres://u:p@ep-x.ap-southeast-1.aws.neon.tech/mango',
  BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x',
  PRODUCTION_DB_HOST: 'ep-x.ap-southeast-1.aws.neon.tech',
  TURNSTILE_SITE_KEY: '0x4AAA',
  TURNSTILE_SECRET_KEY: '0x4BBB',
}
// A preview on the Neon staging branch.
const staging = {
  ...good,
  RAZORPAY_KEY_ID: 'rzp_test_x',
  DATABASE_URL: 'postgres://u:p@ep-y-pooler.ap-southeast-1.aws.neon.tech/mango',
  DATABASE_URL_UNPOOLED: 'postgres://u:p@ep-y.ap-southeast-1.aws.neon.tech/mango',
}

describe('production preflight', () => {
  it('passes a complete live setup', () => {
    assert.deepEqual(checkProduction(good, { vercel: false }), { errors: [], warnings: [] })
    assert.deepEqual(checkProduction(good, { vercel: true }), { errors: [], warnings: [] })
  })

  it('refuses the launch blockers', () => {
    const { errors } = checkProduction({
      ...good,
      JWT_SECRET: DEV_JWT,
      COOKIE_SECURE: false,
      RAZORPAY_KEY_SECRET: '',
      RAZORPAY_WEBHOOK_SECRET: 'whsec_dev',
      SMS_PROVIDER: 'log',
      ADMIN_ORIGIN: 'http://admin.mandimangoes.in',
      CUSTOMER_ORIGIN: 'https://localhost:5174',
    })
    assert.equal(errors.length, 7)
    assert.ok(errors.some((e) => e.startsWith('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET')))
    assert.ok(errors.some((e) => e.includes('ADMIN_ORIGIN must be https')))
    assert.ok(errors.some((e) => e.includes('CUSTOMER_ORIGIN points at localhost')))
  })

  it('warns about test keys and features left off', () => {
    const { errors, warnings } = checkProduction({ ...good, RAZORPAY_KEY_ID: 'rzp_test_x', WHATSAPP_APP_SECRET: '', TRUST_PROXY: 0 })
    assert.deepEqual(errors, [])
    assert.equal(warnings.length, 3)
    assert.match(warnings[0], /test key/)
  })

  it('on Vercel, needs the cron secret and Neon\'s direct connection', () => {
    const { errors, warnings } = checkProduction({ ...good, CRON_SECRET: '', DATABASE_URL_UNPOOLED: undefined, BLOB_READ_WRITE_TOKEN: '' }, { vercel: true })
    assert.equal(errors.length, 3)
    assert.ok(errors.some((e) => e.startsWith('CRON_SECRET')))
    assert.ok(errors.some((e) => e.startsWith('DATABASE_URL_UNPOOLED')))
    // Production must not fall back to keeping photos in Postgres.
    assert.ok(errors.some((e) => e.startsWith('BLOB_READ_WRITE_TOKEN')))
    assert.deepEqual(warnings, [])
  })

  it('previews must use test payment keys; Blob is optional there', () => {
    const live = checkProduction({ ...staging, RAZORPAY_KEY_ID: 'rzp_live_abc', BLOB_READ_WRITE_TOKEN: '' }, { vercel: true, target: 'preview' })
    assert.equal(live.errors.length, 1)
    assert.match(live.errors[0], /live key on a preview/)
    assert.ok(live.warnings.some((w) => w.startsWith('BLOB_READ_WRITE_TOKEN')))
    assert.deepEqual(checkProduction(staging, { vercel: true, target: 'preview' }), { errors: [], warnings: [] })
    const logged = checkProduction({ ...staging, SMS_PROVIDER: 'log' }, { vercel: true, target: 'preview' })
    assert.deepEqual(logged.errors, [])
    assert.match(logged.warnings[0], /only written to the logs/)
  })

  it('production must use the production database, and previews must not', () => {
    const onProd = checkProduction({ ...staging, DATABASE_URL: good.DATABASE_URL, DATABASE_URL_UNPOOLED: good.DATABASE_URL_UNPOOLED }, { vercel: true, target: 'preview' })
    assert.ok(onProd.errors.some((e) => e.includes('production database on a preview')))
    // Only the migration URL pointing at production is enough to refuse.
    const half = checkProduction({ ...staging, DATABASE_URL_UNPOOLED: good.DATABASE_URL_UNPOOLED }, { vercel: true, target: 'preview' })
    assert.ok(half.errors.some((e) => e.includes('production database on a preview')))
    const wrong = checkProduction({ ...good, DATABASE_URL: staging.DATABASE_URL, DATABASE_URL_UNPOOLED: staging.DATABASE_URL_UNPOOLED }, { vercel: true })
    assert.ok(wrong.errors.some((e) => e.startsWith('DATABASE_URL is not the production database')))
    const unset = checkProduction({ ...good, PRODUCTION_DB_HOST: '' }, { vercel: true })
    assert.ok(unset.errors.some((e) => e.startsWith('PRODUCTION_DB_HOST is unset')))
    // Given as a whole URL, it still compares by host.
    assert.deepEqual(checkProduction({ ...good, PRODUCTION_DB_HOST: good.DATABASE_URL }, { vercel: true }).errors, [])
  })

  it('previews never carry the production bootstrap login', () => {
    const r = checkProduction({ ...staging, ADMIN_BOOTSTRAP_EMAIL: 'boss@mandimangoes.in', ADMIN_BOOTSTRAP_PASSWORD: 'x'.repeat(16) }, { vercel: true, target: 'preview' })
    assert.ok(r.errors.some((e) => e.startsWith('ADMIN_BOOTSTRAP_* is set on previews')))
  })

  it('Turnstile needs both keys; without it there is a warning', () => {
    assert.ok(checkProduction({ ...good, TURNSTILE_SITE_KEY: '' }).errors.some((e) => e.includes('TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY')))
    const off = checkProduction({ ...good, TURNSTILE_SITE_KEY: '', TURNSTILE_SECRET_KEY: '' })
    assert.deepEqual(off.errors, [])
    assert.ok(off.warnings.some((w) => w.startsWith('TURNSTILE_SECRET_KEY is unset')))
  })
})
