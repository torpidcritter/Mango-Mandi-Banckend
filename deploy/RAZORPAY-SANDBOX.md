# Razorpay test-mode run (before any real money)

Goal: prove the payment paths against Razorpay itself, in **test mode**, on a
staging deployment with a staging database. No live keys, no real money, no
production data. The result is evidence for the launch checklist.

## Rules

- Only `rzp_test_...` keys. The kit refuses live keys, and preflight refuses
  live keys on previews.
- Keys and the webhook secret go into the staging environment's settings
  (Vercel → Settings → Environment Variables, Preview/staging only) by the
  account owner. Never paste them into chat, tickets, commits or logs.
- Staging uses the Neon `staging` branch, never `main`.
- Use Razorpay's own test cards and test UPI handles from Razorpay's test-mode
  documentation. Don't use a real card.

## Set up (owner)

1. Razorpay dashboard → switch to **Test Mode** → Settings → API Keys → generate a test key.
2. Settings → Webhooks → add `https://<staging API>/webhooks/razorpay` with a new secret,
   events: `payment.authorized`, `payment.captured`, `payment.failed`, `payment_link.paid`,
   `refund.processed`, `refund.failed`.
3. Set on staging: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`. Redeploy.
4. Payment capture: automatic (the code also captures authorized payments that match an order).

## Scenarios (fill in the evidence table)

| # | Do this | Expect |
|---|---------|--------|
| R1 | Shop: order 1 box, pay with a test card that succeeds | Order CONFIRMED within seconds; one `payment.captured` in the webhook log |
| R2 | Order, pay with a test card that fails | Order stays PAYMENT_PENDING, Pay offered again; after the hold, CANCELLED with "We didn't receive your payment in time" |
| R3 | Order, close the payment window, wait 11 minutes | Order CANCELLED (hold expired), stock back in the catalogue |
| R4 | Order, pay successfully, then cancel it from the order page | Refund created; `refund.processed` arrives; order shows "Your refund ... has been sent" |
| R5 | Pause the webhook in the dashboard, pay an order, wait 3 minutes, resume | The maintenance job's reconcile confirms the order without the webhook |
| R6 | Re-send one `payment.captured` from the webhook log 3 times | Order confirmed once; one ORDER_CONFIRMED message |
| R7 | WhatsApp chat order, pay the link in test mode | Order CONFIRMED via `payment_link.paid` |
| R8 | Delayed payment: order, open Checkout, wait until the order page says the hold ran out (11 minutes), then finish paying if Razorpay still lets you | The late payment is matched: order CONFIRMED (on its date, or moved to the next day with stock, or flagged at risk), never refunded and never charged twice |
| R9 | Only if test mode can make a refund fail: repeat R4 with that refund | `refund.failed` arrives (our result `refund_failed`); the order's history says a new refund will be sent; the next maintenance run sends it and `check` shows the second refund |

Scenario map for the launch gate: success = R1 and R7, failure = R2, delayed
payment = R5 (webhook late) and R8 (payment late), duplicate webhook = R6,
refund = R4 (and R9 where possible). R3 checks the hold.

After each scenario, collect the ids from both sides:

1. **Our side.** Every webhook writes one API log line `razorpay webhook` with our
   request id (`reqId`, also sent back as the `X-Request-Id` header), Razorpay's
   event id (the `x-razorpay-event-id` header), the payment, order, link and
   refund ids, and what we did (`confirmed`, `duplicate`, `refund_due`, ...).
   Export the staging API logs for the scenario's time (Vercel → Logs, or
   `docker compose logs api > api.log`) and run:

   ```bash
   cd mango-api
   node scripts/razorpay-sandbox.mjs webhooks ~/Downloads/api.log
   ```

   It prints one Markdown row per webhook. Paste them under the scenario.
   For the shop's own calls, the order page's request id is in the browser's
   network tab (`X-Request-Id` on `POST /v1/checkout/confirm`).
2. **Razorpay's side.** Read-only, test keys from the environment:

   ```bash
   node scripts/razorpay-sandbox.mjs check order_XXXXXXXX
   ```

   It lists the order, each payment and each refund with their status, and
   prints an evidence row with our order number (the Razorpay receipt).
3. The webhook event ids are also in the Razorpay dashboard's webhook event log;
   they must match the `Event id` column from step 1.

Then copy each webhook body from the dashboard's event log into a file and run:

```bash
node scripts/razorpay-sandbox.mjs sanitize ~/Downloads/r1-captured.json
```

This removes emails, phone numbers, UPI handles and card details, and writes
`test/fixtures/razorpay/*.json`. Commit the fixtures: `npm test` replays them
(test/razorpay-fixtures.test.js), so later changes are checked against what
Razorpay really sends.

## Evidence log

One row per scenario. "Our request ids" and "Event ids" come from the
`webhooks` command; the payment and refund ids from `check`.

| # | Date | Our order no. | Our request ids | Razorpay order / link id | Event ids | Payment ids | Refund ids | Result |
|---|------|---------------|-----------------|--------------------------|-----------|-------------|------------|--------|
| R1 | | | | | | | | |
| R2 | | | | | | | | |
| R3 | | | | | | | | |
| R4 | | | | | | | | |
| R5 | | | | | | | | |
| R6 | | | | | | | | |
| R7 | | | | | | | | |
| R8 | | | | | | | | |
| R9 | | | | | | | | |

## What runs without test keys (checked on every `npm test`)

- Signature check on every webhook (`x-razorpay-signature`, raw body), the
  replay of the scenarios above against our stand-in gateway (shop-payments,
  pay-fixes, remediation tests), and the sanitizer.
- `test/p0-verify.test.js`: each webhook's log line carries our request id and
  Razorpay's ids, and the `webhooks` command turns those lines into rows.
- `test/razorpay-fixtures.test.js` replays recorded bodies; it is skipped until
  fixtures from this run are committed.

Until this table is filled in, payments are **not verified against Razorpay**:
the code is tested only against our own stand-in.
