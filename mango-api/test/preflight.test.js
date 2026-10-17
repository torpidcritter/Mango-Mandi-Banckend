import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkProduction, DEV_JWT } from '../src/preflight.js'

const good = {
  JWT_SECRET: 'a'.repeat(64),
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
    assert.equal(errors.length, 2)
    assert.ok(errors.some((e) => e.startsWith('CRON_SECRET')))
    assert.ok(errors.some((e) => e.startsWith('DATABASE_URL_UNPOOLED')))
    assert.ok(warnings.some((w) => w.startsWith('BLOB_READ_WRITE_TOKEN')))
  })
})
