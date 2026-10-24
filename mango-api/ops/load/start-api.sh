#!/bin/sh
# Starts the API for a LOCAL load test with production settings
# (NODE_ENV=production, no dev routes, pool of 5 as on Vercel), with Razorpay
# and Jio replaced by ops/load/stub-providers.js. Never point this at a real
# database or with real keys: the keys below are fakes the stub accepts.
#
#   node ops/load/stub-providers.js &            # first, on :3145
#   DATABASE_URL=postgres://... PORT=3141 sh ops/load/start-api.sh
#
# The database must already be migrated and seeded (staff logins, demo
# stock): production never seeds demo data, so seed it once in development
# first (see LOAD-TEST.md).
set -eu
cd "$(dirname "$0")/../.."
STUB=${STUB_URL:-http://127.0.0.1:3145}
export NODE_ENV=production
export PORT=${PORT:-3141}
export DB_POOL_MAX=${DB_POOL_MAX:-5}
export DB_CONNECT_TIMEOUT_MS=${DB_CONNECT_TIMEOUT_MS:-5000}
export DB_STATEMENT_TIMEOUT_MS=${DB_STATEMENT_TIMEOUT_MS:-10000}
export LOG_LEVEL=${LOG_LEVEL:-info}
export JWT_SECRET=${JWT_SECRET:-load-test-only-4b1d0c9e7a2f43e18f5a6c3d2b1e0f9a}
export COOKIE_SECURE=true
export ADMIN_ORIGIN=https://panel.load.test
export CUSTOMER_ORIGIN=https://shop.load.test
# One proxy hop: the k6 scripts give every virtual customer its own
# X-Forwarded-For address, as Vercel's edge would.
export TRUST_PROXY=1
export RAZORPAY_KEY_ID=rzp_test_loadstub
export RAZORPAY_KEY_SECRET=loadstub
export RAZORPAY_WEBHOOK_SECRET=${RAZORPAY_WEBHOOK_SECRET:-whsec_load_test_only}
export LOAD_STUB_URL="$STUB"
export SMS_PROVIDER=jio
export JIO_SMS_URL="$STUB/jio/send"
export JIO_SMS_API_KEY=stub JIO_SMS_SENDER_ID=MANDIM JIO_SMS_TEMPLATE_ID=stub JIO_SMS_ENTITY_ID=stub
# What the stub answers; on staging these come from Jio's documentation.
export JIO_SMS_SUCCESS_PATH=status JIO_SMS_SUCCESS_VALUES=accepted
# Turnstile and Sentry are required in production; both go to the stub here.
export TURNSTILE_SITE_KEY=load-stub-site TURNSTILE_SECRET_KEY=load-stub-secret
export SENTRY_DSN="http://loadstub@${STUB#http://}/1"
export CRON_SECRET=${CRON_SECRET:-load-test-cron-secret-0123456789}
export METRICS_TOKEN=${METRICS_TOKEN:-load-metrics}
# Two-step sign-in is required for staff in production; the load test signs
# staff in with a password only.
export STAFF_TWO_STEP=optional
export SEED_DEMO_DATA=false
exec node --import ./ops/load/provider-redirect.js src/index.js
