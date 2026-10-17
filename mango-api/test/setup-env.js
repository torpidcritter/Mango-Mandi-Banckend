// Imported first by every test file, before any src module reads process.env.
// Tests drop and recreate the schema, so they only ever use a *_test database.
process.env.NODE_ENV = 'test'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://mango:mango@localhost:5432/mango_test'
if (!/_test(\?|$)/.test(process.env.DATABASE_URL)) throw new Error('TEST_DATABASE_URL must point at a database whose name ends in _test')
process.env.COOKIE_SECURE = 'false'
process.env.LOG_LEVEL ??= 'silent'
process.env.SEED_DEMO_DATA = 'false'
process.env.REFRESH_REUSE_GRACE_MS = '2000'
process.env.RAZORPAY_KEY_ID = ''
process.env.RAZORPAY_KEY_SECRET = ''
process.env.WHATSAPP_APP_SECRET = 'wa_test_secret'
process.env.WHATSAPP_VERIFY_TOKEN = 'wa_verify_test'
process.env.CRON_SECRET = 'cron_test_secret_0123456789'
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com'
