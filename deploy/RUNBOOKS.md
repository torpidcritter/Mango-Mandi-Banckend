# Incident runbooks

What to do when something goes wrong in production, in plain steps. Each runbook
says how you notice, who acts, and the exact way back. Paths like
`src/admin/reports.js:96` are in `mango-api/`.

**Roles** used below: **Owner** (holds the Vercel, Neon, Razorpay, Meta and GitHub
logins; usually also the developer on call), **Manager** (panel role MANAGER),
**Operator** (panel role OPERATOR; managers can do everything operators can).

**Where alerts come from** (deploy/VERCEL.md "Watch it"): the uptime monitor on
`/ready`, Sentry (errors, the `maintenance` cron monitor, and the warnings the
maintenance job sends at most hourly, `src/maintenance.js` `checkHealth` and
`runAudit`), and the panel's **Needs attention** card on Today
(`GET /admin/v1/attention`, `src/admin/reports.js:96`; shown by
`src/pages/NeedsAttention.tsx`).

Golden rules:
- **Money goes back only** when a customer cancels before PACKED, or a manager
  cancels an order or booking we can't deliver. The automatic refunds below
  (second payments, rejected captures, payments after a cancel) are refunds of
  money that bought nothing; never invent another kind.
- Never edit data in the Neon SQL editor unless a runbook here says so, and write
  down what you ran in the incident note.
- Never paste a secret into chat, a ticket or the repo.

---

## Every Needs attention item: who owns it and the way back

| Item (as the panel shows it) | Raised by | Owner | Way back |
|---|---|---|---|
| **The background loop has stopped** | no `tick` in `maintenance_runs` for 5 min (`reports.js:86`, `LOOP_STALE_MS`) | Owner | [Scheduler stopped](#scheduler-stopped). The panel names both: the scheduler on Vercel, restarting the API on the Docker server |
| **<step> is failing** since ... | a step's `last_err_at` is newer than its `last_ok_at` (`reports.js` `failingSteps`; `maintenance.js` `step()`) | Owner | Read the error shown; Vercel → Logs, search `maintenance step failed` and the step name. Fix the cause (below by step); the item clears on the step's next success. `refunds`/`duplicate-payments`/`refund-checks`/`reconcile`: [Stuck refunds](#stuck-or-failed-refunds) and Razorpay keys. `notifications`: [Failed notifications](#failed-notifications). `audit`: [Stock discrepancy](#stock-discrepancy-ledger-audit-drift). `preorders`, `rebalance-*`, `sweep`, `retire`, `cleanup`, `retention`, `config`: a bug or the database; Sentry has the stack |
| **No backup in the last 26 hours** | `backupStatus` (`maintenance.js`), when `BACKUP_HEARTBEAT_EXPECTED=true` or a backup was ever recorded | Owner | GitHub → Actions → **Backup** → the last run. Red at "Check the backup is set up": secrets missing. Red later: open the log. No run at all: GitHub paused the schedule (60 days without repository activity): click **Enable workflow**, then **Run workflow**. The item clears when a run's heartbeat step succeeds. (Docker server: `docker compose logs backup`; the panel names both) |
| **Refund not sent** for N, asked for at ... | a refund requested 30 min ago and not sent (`reports.js:108-125`) | Manager watches, Owner fixes | [Stuck refunds](#stuck-or-failed-refunds). Razorpay can never send it: Manager → **Paid back another way** on the item |
| **Refund not sent** for N **(second payment)** | a `duplicate_payments` row unrefunded after 30 min | Owner | [Duplicate payment](#duplicate-payment) |
| **Refund not sent** for N **(sent, not confirmed by Razorpay)** | `refund_status = 'pending'` for 5 days | Owner | [Stuck refunds](#stuck-or-failed-refunds), "Sent but not confirmed" |
| **WhatsApp message not delivered** (kind) for N after k tries | `notifications.status = 'FAILED'` in the last 7 days | Operator | **Send again** on the item (`POST /admin/v1/notifications/:id/retry`), after the cause is fixed: [Failed notifications](#failed-notifications) |
| **Call the customer** for N: k deliveries missed | `DELIVERY_FAILED` with 3+ attempts (`MAX_DELIVERY_ATTEMPTS`, `src/orders.js:74`) | Operator calls; Manager decides | [Failed deliveries](#failed-deliveries) |
| **Retry can't go out as packed** for N | a missed delivery whose stock is too old for a retry (`at_risk`, fewer than 3 attempts) | Manager | [Failed deliveries](#failed-deliveries): send a replacement, move the date, or cancel with a refund (undeliverable) |
| **Overdue:** N was due ... | paid order past its date, or out for delivery 8+ h with no result (`src/stock-watch.js` `overdueOrders`; also a Sentry warning) | Operator | Find out where it is (the rider), tell the customer, then record the result on the order page (delivered with proof, missed, or moved with **Reschedule**). Clears when the order's status moves on |
| **Check a photo delivery** / **Check a delivery marked without proof** | delivered with only a photo, or by a manager's override (`photoReviews`) | Operator (not the rider who delivered) | **Looks right** or **Doubtful** on the item (`POST /admin/v1/delivery-reviews/:id`); Doubtful asks for a note and someone calls the customer. A claim, if any, resolves only as Replacement or Reject |
| **Payment disputed** (status) for N, ₹, by date | an open `payment_disputes` row (`payment.dispute.*` webhooks) | Owner | [Dispute](#dispute-chargeback) |
| **Razorpay webhook problem** / **WhatsApp webhook problem** at ... | a `webhook_failures` row in the last 7 days (`src/payments.js` `recordWebhookFailure`, `src/app.js` webhook handlers) | Owner | Depends on the reason text: [Unmatched webhook](#unmatched-webhook-payment-for-an-order-we-dont-have), [Rejected capture](#payment-captured-but-rejected-or-order-cancelled), [Webhooks failing](#webhooks-failing-500). Manager: **Mark resolved** (with a note) once handled; **Refund this payment** on a captured payment that matches no order |
| **Stock counts disagree with the ledger** for SKU in its batch | `auditLedger` (`src/inventory.js:233`), hourly; also Sentry | Manager stops selling it; Owner repairs | [Stock discrepancy](#stock-discrepancy-ledger-audit-drift). Manager: **Repair from the ledger** on the item (preview, then a reason) |
| **k boxes from N** (returned / cancelled after it left) | `packed` stock on a CANCELLED or RTO order (`returnedStockPending`) | Operator | Order page → **Returned boxes**: put back on the shelf (if the batch is still on sale) or write off with a reason (`POST /admin/v1/orders/:id/returned-stock`) |
| **Preorder P** (moved k times / after the season ends) | `preordersNeedingDecision` | Manager | Preorders page: **Cancel** with a refund (manager cancel of a booking we can't deliver). Or **Keep booking** on the item (a reason; it comes back only if the booking moves again) |
| **k new reviews with 1 or 2 stars** | pending low ratings from the last 7 days | Operator | Reviews page: read, reply or moderate; call the customer if needed. A review never opens a claim |

Sentry warnings with no panel item of their own:

| Sentry message | Owner | Way back |
|---|---|---|
| WhatsApp messages are overdue: the maintenance run is not sending them | Owner | [Failed notifications](#failed-notifications), [Scheduler stopped](#scheduler-stopped) |
| Refunds are overdue | Owner | [Stuck refunds](#stuck-or-failed-refunds) |
| Razorpay payments could not be matched or were rejected (3+ in an hour) | Owner | the Webhook problems items |
| Payments were confirmed by polling: Razorpay webhooks may not be arriving | Owner | [Webhooks not arriving](#webhooks-not-arriving) |
| WhatsApp messages failing (over 5% in a day) | Owner | [Failed notifications](#failed-notifications) |
| Orders are past their delivery date | Operator | the Overdue items |
| No backup in the last 26 hours | Owner | the backup item above |
| Stock counters disagree with the ledger | Owner | [Stock discrepancy](#stock-discrepancy-ledger-audit-drift) |
| Login codes reached 80% of the day's budget | Owner | look for one number or address pumping codes (Vercel logs); raise `OTP_DAILY_LIMIT` only if it is real demand |
| Cron monitor `maintenance`: missed or failed check-in | Owner | [Scheduler stopped](#scheduler-stopped) |

### Problems the code raised with no recovery path (closed 23 Oct)

Each now has a manager action in the panel. Every one needs a reason, is safe to
repeat, and is written to the staff activity (`staff_audit`) inside its own
transaction, with the order or booking history or the batch ledger where it
touches them (`mango-api/src/admin/recovery.js`, tests `test/recovery.test.js`,
`tests/recovery.spec.ts`).

| Problem | Recovery path now |
|---|---|
| Ledger drift (`ledgerDrift`) | Needs attention → **Repair from the ledger** (Manager). Shows the counts now and after; applies exactly that preview (`GET`/`POST /admin/v1/batches/:id/lines/:lineId/repair`). Counters are set to the ledger (on hand, reserve buffer) and the order stock (held, to pack); the ledger is never changed, only a `STATUS` row (delta 0) records the repair. Refused when the ledger can't cover what is promised (no-oversell guard): count the shelf, record it with Adjust stock or Short arrival, then repair |
| Webhook problems (`webhookFailures`) | **Mark resolved** with a note (Manager, `POST /admin/v1/webhook-failures/:id/resolve`); it leaves Needs attention and the hourly Sentry count. Rows still age out after 30 days |
| Preorder decision "keep it" | **Keep booking** with a reason (Manager, `POST /admin/v1/preorders/:id/keep`); recorded on the booking's history; it comes back only if the booking moves again |
| A refund that will never go through Razorpay | Pay the customer back another way, then **Paid back another way** on the Refunds not sent item with the payment's reference (Manager, `POST /admin/v1/refunds/:id/paid-another-way`). Retries stop; it stays a refund in Analytics (`refunded_at`, `refund_status = 'manual'`, `refund_id = 'manual:<reference>'`). Refused while a refund attempt holds the lease, within 30 minutes of the request, and when Razorpay already shows a refund for the payment |
| A captured payment that matches no order (live) | Check in the Razorpay dashboard that it bought nothing, then **Refund this payment** on the webhook problem (Manager, `POST /admin/v1/webhook-failures/:id/refund`). It is refunded in full like a second payment (`duplicate_payments`, leased, a new receipt per attempt); refused if the payment now belongs to an order or booking |
| Sign out every staff member at once | Staff page → **Sign out all staff** with a reason (Manager, `POST /admin/v1/staff/sign-out-all`), optionally keeping your own session |
| Panel text on Vercel | Fixed: the cards name the scheduler and the GitHub Backup workflow for Vercel, and the API restart and backup service for Docker |
| Step names without a label | Fixed: every step `maintenance.js` can report has a label (unit test `tests/unit/step-labels.unit.ts`) |

---

## Payments

How payments flow: checkout creates a Razorpay order; the Razorpay webhook
(`POST /webhooks/razorpay`, signed) confirms it; the maintenance job also polls
Razorpay for orders still pending (`reconcile` step) in case a webhook is lost;
the order page's payment-status poll does the same for its own order (OPS-24).
Everything is idempotent by payment id (`processed_webhooks`).

### Unmatched webhook (payment for an order we don't have)

Notice: Webhook problem "payment.captured for an order we don't have (order_...)" or
"After a restore: captured payment pay_... matches no order".
Owner:
1. Razorpay dashboard → Payments → search the payment id or the Razorpay order id.
   Note amount, contact, time.
2. Is it from **another site or test** sharing the Razorpay account (wrong
   webhook URL in Razorpay)? Then fix the webhook settings; nothing to do here.
3. Is it **ours but the order is missing** (after a restore, or a checkout that
   crashed after Razorpay took the money)? Search the panel's Orders by the
   customer's phone. If the order exists under another number, the money is
   confirmed by the next reconcile; nothing to do.
4. If it bought nothing: after a restore, run
   `node --env-file=.env ops/replay-payments.js --from <restore point>` (lists them)
   and `--refund-missing` to refund them in full. Outside a restore, a Manager clicks
   **Refund this payment** on the webhook problem (full refund, like a second
   payment). Tell the customer.

### Payment captured but rejected, or order cancelled

- **Rejected capture** (short amount, other currency, no amount): the webhook
  records "Payment pay_... for ord_... not accepted: <reason>" and the payment is
  refunded in full automatically (a `duplicate_payments` row). Check the refund
  goes through (it shows as "(second payment)" in Refunds not sent if it hasn't
  after 30 min). Find why: a tampered checkout, or a price changed mid-checkout.
- **Paid after the order was cancelled** (the customer cancelled, or the 10-minute
  hold ran out and the sweeper cancelled it, then the payment landed): the API
  refunds it automatically and does **not** revive the order (VERCEL.md "Refunds
  the system sends on its own"). Operator: call the customer, offer to place the
  order again. Nothing to fix.

### Duplicate payment

Two tabs or a retried link paid twice. The second payment alone is refunded
automatically by the `duplicate-payments` step; the order stays paid once. If
"(second payment)" stays in Refunds not sent, follow [Stuck refunds](#stuck-or-failed-refunds).

### Dispute (chargeback)

Notice: "Payment disputed" in Needs attention (from `payment.dispute.*` webhooks;
recorded only, `PAY-B12`).
Owner, before the "respond by" date:
1. Razorpay dashboard → Disputes → the dispute. Upload evidence: the order page
   (screenshot), delivery proof (code, photo, the rider's record), WhatsApp
   messages sent (order page history).
2. Don't refund by hand while a dispute is open (the customer could be paid twice).
3. The item clears when Razorpay reports won, lost or closed.

### Webhooks not arriving

Notice: Sentry "Payments were confirmed by polling".
Owner: Razorpay → Webhooks → the production webhook: URL
`https://api.mandimangoes.in/webhooks/razorpay`, active, the events in VERCEL.md
step 6, recent deliveries. Failing with 400 `BAD_SIGNATURE`: the secret differs
from `RAZORPAY_WEBHOOK_SECRET` (see [rotation](#razorpay-webhook-secret)).
Orders still confirm through polling, a minute or so late, while you fix it.

### Webhooks failing (500)

Notice: Webhook problem with an error message (not "order we don't have"), Sentry
error `webhook processing failed`. The webhook answered 500, so Razorpay retries
it. Owner: read the Sentry stack; usually the database (see [Downtime](#downtime-or-database-outage)).
After the fix, Razorpay's retries and the reconcile step catch up; check the
affected orders in the panel.

---

## Stuck or failed refunds

A refund is requested (customer cancel before PACKED, a manager cancel, an
automatic one above), then sent by the API right away and retried by the
`refunds` step every minute. Every attempt is leased and Razorpay is asked first
whether a refund already exists, so a retry never pays twice
(`src/payments.js` `refundOrder`, `gatewayRefund`).

**"Refund not sent" (requested, not sent after 30 min)**: Owner
1. Needs attention → Background jobs: is `Sending refunds` failing? The error says why.
2. Common causes: Razorpay keys wrong or rotated (`npm run preflight -- --online`
   says "Razorpay rejected the keys"); Razorpay down (status.razorpay.com); the
   scheduler stopped ([Scheduler stopped](#scheduler-stopped)); Razorpay refusing
   that refund (the step's error shows Razorpay's message).
3. Fix the cause; the next run sends it. Nothing to click.

**"Sent, not confirmed by Razorpay" (5 days)**: Razorpay accepted the refund but
never sent `refund.processed`, and the `refund-checks` step hasn't seen it
processed. Razorpay dashboard → Refunds → the refund id (order page). Processed
there: the webhook was lost; the next `refund-checks` run records it. Failed there:
`refund.failed` resets it and it is sent again. Stuck at the bank: contact
Razorpay support with the refund id.

**A refund that can never go through** (account closed, bank refused for good): pay
the customer back another way (bank transfer, UPI), then a Manager clicks **Paid back
another way** on the Refunds not sent item and gives the payment's reference and why.
Check the Razorpay dashboard first that no refund went out (the API also asks Razorpay
and refuses if one shows). Retries stop and it still counts as a refund in Analytics.

---

## Stock discrepancy (ledger audit drift)

Every box movement writes a `batch_ledger` row; each batch line's counters must
equal the ledger (on hand, reserve buffer) and the order stock (held, committed).
The hourly `audit` step checks it; drift shows in Needs attention and Sentry.

Manager, at once: **stop selling that batch line** until it is explained. There
is no off-sale switch for one line, so on the batch page raise the line's
**reserve buffer** to its free stock (that changes only the buffer, not on hand).
Don't adjust on hand yet: it would hide the evidence and, since it moves the counter and the ledger together,
doesn't repair the drift.

Owner:
1. Needs attention shows both numbers: `on hand 40 vs 38` = counter 40, ledger 38.
2. Batch page → **Ledger**: the history of that line. Count what is physically on
   the shelf.
3. Find the cause in Vercel logs and Sentry around the first alert (an error during
   a pack or a cancel, a hand edit in SQL). Keep the evidence.
4. Repair: Manager, Needs attention → **Repair from the ledger** on the item. It
   shows the counts now and after the repair (on hand and reserve buffer from the
   ledger, held and to pack from the orders); give the cause as the reason. The
   ledger itself is not changed; a `STATUS` row records the repair. If it says the
   ledger can't cover what is promised, count the shelf and record extra boxes with
   **Adjust stock** (or fewer with **Short arrival**) first, then repair.

   If the shelf count differs from the ledger too, record the difference afterwards
   with **Adjust stock** in the panel (with a reason), so it is in the ledger.
5. The item clears at once (Needs attention re-checks on each load); Sentry's hourly audit stops alerting.

---

## Downtime or database outage

Notice: the uptime monitor on `/ready` (503), customers reporting errors, Sentry
"database unavailable" (reported at most once a minute, `src/app.js`).
What customers see: the API answers 503 "We are having trouble right now. Please
try again in a minute." (`UNAVAILABLE`, Retry-After 5) or "We are very busy"
(`BUSY`, pool timeout). Nothing is half-written: each change is one transaction.

Owner:
1. Which part? `curl -s https://api.mandimangoes.in/health` (the function runs) and
   `/ready` (database and maintenance). Vercel status (vercel-status.com), Neon
   status (neonstatus.com), Neon → `main` → Monitoring.
2. **Neon down or suspended**: wait; nothing in the app can help. Check the Neon
   project isn't over a plan limit (compute hours, storage) and that the compute
   isn't set to a size too small for the load.
3. **Too many connections** (`BUSY` 503s, Neon errors `53300`): raise the compute's
   minimum size for the day; check for a long query in `pg_stat_activity`.
4. **A bad deploy**: roll back (RELEASE.md step 5).
5. After it is back: `/ready` is 200 within a minute or two (the next maintenance
   run). Holds that expired during the outage are released by the sweeper;
   payments taken meanwhile are confirmed by Razorpay's webhook retries and the
   `reconcile` step. Check Needs attention, and the Razorpay webhook deliveries for
   the outage window.
6. If data was lost (Neon lost the branch, which is unlikely), restore: VERCEL.md
   "Rolling back" and the readiness notes' RESTORE-DRILL.md.

## Scheduler stopped

Notice: `/ready` 503 with `maintenanceAgeSeconds` over 300, Needs attention "The
background loop has stopped", Sentry cron monitor missed check-ins.
Effect: payment checks, refund retries, WhatsApp messages and the stock audit
wait. Checkout still works (it releases expired holds itself, SCHEDULER.md).
Owner:
1. Vercel → `mandi-api` → Logs, path `/internal/maintenance`:
   - **no requests**: the pinger stopped (cron-job.org: is the job enabled, did it
     send a failure e-mail?) or, on Pro, `vercel.json`'s cron is not `* * * * *`;
   - **401**: `CRON_SECRET` differs between Vercel and the pinger (after a rotation);
   - **500**: the run fails: Sentry has the error; a step failing does not stop the
     tick, so a 500 means the run itself (often the database);
   - **200 with `{"skipped":true}` every time**: a lease is stuck; it expires in 65 s
     (`LEASE_MS`), so this means two schedulers call at once, which is harmless.
2. Run one by hand to unblock it now:
   `curl -s -H "Authorization: Bearer $CRON_SECRET" https://api.mandimangoes.in/internal/maintenance`
   (type the secret into your shell from the password manager; don't paste it into chat).
3. Docker server only: `docker compose logs --tail 100 api`, then `docker compose restart api`.

## Failed notifications

Notice: "WhatsApp message not delivered" items, Sentry "WhatsApp messages failing"
or "WhatsApp messages are overdue".
Messages retry at 1, 5, 15, 60 and 180 minutes and are skipped after 24 hours
(an old update is no longer news, `src/notify.js`).
Owner:
1. The error on the item says why. `npm run preflight -- --online` checks the
   token and number with Meta.
2. Token expired or revoked: make a new permanent (system user) token in Meta
   Business settings, set `WHATSAPP_TOKEN` on `mandi-api` (Production), Redeploy.
3. Template not approved or paused: WhatsApp Manager → Message templates.
4. Number quality low or messaging limit reached: WhatsApp Manager → Phone numbers.
5. Overdue but not failing: the scheduler ([Scheduler stopped](#scheduler-stopped)).
Then Operator: **Send again** on each item that still matters (a delivery code for
today, yes; yesterday's "packed", no).

## Login codes not arriving

Notice: Sentry "Login codes are not being sent" (3 failed sends in 10 minutes)
or "Login codes are going out on the backup channel" (5 in an hour), or
customers saying the code never came. Google sign-in still works meanwhile.
Owner:
1. Vercel → `mandi-api` → Logs, search `login code not sent on this channel` and
   `Jio SMS answered`: the line says which channel failed and why.
2. SMS (Jio) failing: check the DLT sender, template and entity ids still match
   what is registered, the `JIO_SMS_API_KEY`, and the Jio status page or account
   manager. A changed success reply needs `JIO_SMS_SUCCESS_PATH` / `_VALUES`.
3. WhatsApp failing: the token or the login-code (authentication) template
   ([Failed notifications](#failed-notifications) steps 1 to 3).
4. One channel down for more than an hour: set `OTP_DEFAULT_CHANNEL` to the
   working one (`sms` or `whatsapp`) on `mandi-api` (Production) and Redeploy, so
   customers stop waiting for the failing channel first. Set it back afterwards.
5. Both down: post on the shop's WhatsApp and social pages that phone sign-in is
   down and Google sign-in works, until one channel is back.

## Failed deliveries

- After each missed delivery the order is `DELIVERY_FAILED` and can be sent out
  again (Operator: Deliveries, or Reschedule on the order page).
- **3 missed** ("Call the customer"): Operator calls the customer (or the gift
  recipient), agrees a day, then a Manager sends it from the order page. If it
  can't be delivered at all, a **Manager cancels** it, which refunds it (the
  "undeliverable" refund in the owner's rules).
- **Retry can't go out as packed** (stock too old for a retry): Manager sends a
  replacement, moves the date, or cancels with a refund. The customer hasn't been
  told a new date yet.
- **Out for delivery 8+ hours**: call the rider; record the real result.

---

## Compromised credentials

Do the rotation first, investigate after. Each change on Vercel needs a
**Redeploy** of the current production deployment to take effect
(Vercel → Deployments → Current → Redeploy; it rebuilds the same commit; the
migration step finds nothing to do).

### `JWT_SECRET`
Signs every access and refresh token (staff and customers) and, unless
`OTP_PEPPER` is set, peppers login-code hashes.
1. `openssl rand -hex 32`, set it as `JWT_SECRET` on `mandi-api` Production, Redeploy.
2. Effect: every staff member and customer is signed out (their tokens no longer
   verify); login codes sent in the last 5 minutes stop working (they ask again).
3. If only staff were affected, prefer the staff-only steps below.

### Razorpay webhook secret
1. Razorpay → Webhooks → the webhook → edit → new secret.
2. Same minute, on `mandi-api`: set `RAZORPAY_WEBHOOK_SECRET` to the new one and
   `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` to the old one, Redeploy. Webhooks signed with
   either verify (`src/payments.js` `verifySignature`); preflight warns while
   `_PREVIOUS` is set.
3. A day later (Razorpay's retries of older events are done), delete
   `RAZORPAY_WEBHOOK_SECRET_PREVIOUS`, Redeploy.
   If the *old* secret leaked, skip the day's grace: unset `_PREVIOUS` at once
   (some retried events will fail and be picked up by the reconcile step instead).

### Razorpay API keys
Razorpay → Account & settings → API keys → Regenerate. Set `RAZORPAY_KEY_ID` and
`RAZORPAY_KEY_SECRET`, Redeploy. Checkouts in flight fail once and the customer
retries. `npm run preflight -- --online` confirms the new keys.

### Meta (WhatsApp) token and app secret
- `WHATSAPP_TOKEN`: Meta Business settings → System users → revoke the token,
  generate a new one with the same permissions; set it, Redeploy.
- `WHATSAPP_APP_SECRET` (signs incoming webhooks): Meta app → Settings → Basic →
  reset the app secret; set it, Redeploy at once. There is no `_PREVIOUS` for this
  one, so webhooks between the reset and the redeploy answer 401 and Meta retries
  them.
- `WHATSAPP_VERIFY_TOKEN`: change it in both places; it is only used when Meta
  verifies the callback.

### `CRON_SECRET`
Set a new one in Vercel and in the pinger at the same time, Redeploy. A gap of
more than 5 minutes turns `/ready` red.

### Staff sessions
- One person (lost phone, left the company): Staff page → **Reset two-step**
  (ends their sessions, `POST /staff/:id/two-step/reset`), change their password,
  or **Remove** them. Each revokes their refresh sessions and stops their access
  tokens within seconds (`session_version`, 5 s cache in `src/auth.js`).
- Everyone at once: Manager, Staff page → **Sign out all staff** with a reason
  (`POST /admin/v1/staff/sign-out-all`): every other staff member's refresh
  sessions are revoked and their access tokens stop working (`session_version`);
  untick "Keep me signed in" to end your own session too.

  Staff sign in again with password and two-step. Then check Staff → Audit for
  what was done with the stolen session.

### Database passwords
Neon → `main` → Roles → the role → Reset password. `mango_app` → `DATABASE_URL`;
owner → `DATABASE_URL_UNPOOLED`; then Redeploy. Backup roles → the GitHub secrets.

### After any rotation
`npm run smoke -- ...` and `npm run preflight -- --online` (RELEASE.md step 4), and
write down what was rotated and when.
