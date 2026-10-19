# Going live on Vercel and Neon

This is the hosted setup: three Vercel projects from this one repository, and a
Neon Postgres database in Singapore. Nothing to patch, back up by hand or renew.
(The single-server Docker setup in [README.md](README.md) still works if you ever
want to leave Vercel.)

| Vercel project | Root directory | Serves | Example domain |
|----------------|----------------|--------|----------------|
| `mandi-api` | `mango-api` | the API, the Razorpay and WhatsApp webhooks, the maintenance job | `api.mandimangoes.in` |
| `mandi-shop` | `customer-app` | the customer shop | `mandimangoes.in` and `www.` |
| `mandi-admin` | `/` (repo root) | the staff panel (hidden from search engines) | `ops.mandimangoes.in` |

Each folder already has its `vercel.json`, so Vercel needs no build settings typed in.
The API runs in Singapore (`sin1`), next to the database.

## What you need first

- [ ] **Vercel Pro** (about $20 a month per member). Pro is needed for the
  maintenance job to run every minute; Hobby only allows once a day, and holds,
  payment checks and WhatsApp messages would stall.
- [ ] **Neon** account (the Launch plan is enough to start).
- [ ] **A domain**, e.g. `mandimangoes.in`, with access to its DNS.
- [ ] **Razorpay live account** with KYC done. Jio DLT and Meta WhatsApp approval
  are the same as in [README.md](README.md#what-you-need-first); start them now,
  they take weeks.
- [ ] **A Google OAuth client** for "Sign in with Google" (step 4).
- [ ] **Sentry** project (free tier is fine) for error alerts.

## 1. Neon

1. Create a project in **AWS Asia Pacific (Singapore)**, Postgres 16 or newer.
2. Keep the default branch as `main` (production). Create a second branch
   `staging` from it for preview deployments.
3. In the SQL editor on `main`, make a separate login for the app that can read
   and write data but cannot change the schema, and give both roles a query
   time limit:

   ```sql
   CREATE ROLE mango_app LOGIN PASSWORD '<a long random password>';
   GRANT USAGE ON SCHEMA public TO mango_app;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mango_app;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mango_app;
   -- Tables the owner creates later (new migrations) get the same rights.
   ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mango_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
     GRANT USAGE, SELECT ON SEQUENCES TO mango_app;
   ALTER ROLE mango_app SET statement_timeout = '10s';
   -- A transaction left open (a function stopped mid-request) gives its connection back.
   ALTER ROLE mango_app SET idle_in_transaction_session_timeout = '30s';
   ALTER ROLE neondb_owner SET statement_timeout = '60s';
   ```

   Run the first deploy (step 3) before the two `GRANT ... ON ALL` lines matter;
   if you made the role before the tables existed, run those two lines again after.
4. Copy two connection strings from **Connect**:
   - **Pooled** (host has `-pooler`), logged in as `mango_app`: this is `DATABASE_URL`.
   - **Direct** (no `-pooler`), logged in as the owner: this is
     `DATABASE_URL_UNPOOLED`. Only migrations use it.

   Do the same on the `staging` branch for the preview values.

Neon keeps point-in-time history (7 days on Launch), so a bad change can be undone
by restoring a branch to a minute before it. See [Backups and restore drill](#backups-and-restore-drill).

The first deploy against each branch records which environment it belongs to
(production for `main`, preview for `staging`). After that a preview build
pointed at `main` by mistake fails instead of migrating or serving it, and the
API refuses to use it; production refuses `staging` the same way.

## 2. Create the three Vercel projects

For each row in the table above: **Add New → Project**, import this GitHub
repository, set the **Root Directory**, and leave the build settings as detected.
Then add the domain under **Settings → Domains** and the DNS record Vercel shows.

Put the shop and the panel on the same domain as the API (`mandimangoes.in`,
`ops.mandimangoes.in`, `api.mandimangoes.in`). The sign-in cookie then works with
the default `COOKIE_SAMESITE=lax`.

## 3. Environment variables

Set these under each project's **Settings → Environment Variables**. Generate
secrets with `openssl rand -hex 32`. Never commit them.

### `mandi-api`

| Variable | Production | Preview | Notes |
|----------|-----------|---------|-------|
| `NODE_ENV` | `production` | `production` | required: on Vercel the API won't start without it (no fake payments or logged codes on any deploy) |
| `DATABASE_URL` | Neon `main`, pooled, `mango_app` | Neon `staging`, pooled | |
| `DATABASE_URL_UNPOOLED` | Neon `main`, direct, owner | Neon `staging`, direct | migrations only |
| `JWT_SECRET` | random, 64 hex | a different random | |
| `LABEL_TOKEN_SECRET` | random, 64 hex | a different random | signs box label QR codes; changing it makes printed labels unreadable |
| `CRON_SECRET` | random, 32+ chars | random | Vercel sends it to the maintenance job |
| `CUSTOMER_ORIGIN` | `https://mandimangoes.in,https://www.mandimangoes.in` | the shop preview URL | comma-separated |
| `ADMIN_ORIGIN` | `https://ops.mandimangoes.in` | the panel preview URL | |
| `COOKIE_SAMESITE` | `lax` | `none` | previews are on different `*.vercel.app` names |
| `SEED_DEMO_DATA` | `false` | `true` | demo batches only on previews; demo staff logins are never made on Vercel |
| `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` | first manager's login | same | used once, on an empty staff table; remove after |
| `STAFF_TWO_STEP` | `managers` (or `all`) | `optional` | managers and operators must use an authenticator app |
| `GOOGLE_CLIENT_ID` | from step 4 | same | |
| `BLOB_READ_WRITE_TOKEN` | added by Vercel Blob (step 5) | same store or a second one | required in production |
| `SENTRY_DSN` | from Sentry | same | |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | live keys | test keys | a preview refuses live keys |
| `RAZORPAY_WEBHOOK_SECRET` | from the Razorpay webhook | test webhook | |
| `SMS_PROVIDER` and `JIO_SMS_*` | `jio` and Jio's values | `log` (codes in the Vercel logs) | see [mango-api/README.md](../mango-api/README.md#login-codes-by-sms-jio) |
| `WHATSAPP_*` | Meta's values | `log` | see [mango-api/README.md](../mango-api/README.md#whatsapp-order-updates) |
| `OTP_DAILY_LIMIT` | `3000` | `200` | login codes per day before sending pauses; Sentry warns at 80% |
| `METRICS_TOKEN` | random | | protects `/metrics` |

`TRUST_PROXY` and the database pool size are set for Vercel automatically.

### `mandi-shop` and `mandi-admin`

| Variable | Production | Preview |
|----------|-----------|---------|
| `VITE_API_URL` | `https://api.mandimangoes.in` | the API preview URL |

### Check before the first real deploy

From a terminal with the production values in `mango-api/.env`:

```sh
cd mango-api && npm run preflight
```

It lists every missing or unsafe setting. In production the API also refuses to
start when one of the hard errors is present.

## 4. Sign in with Google

1. In [Google Cloud console](https://console.cloud.google.com/), **APIs & Services →
   OAuth consent screen**: app name MandiMangoes, support email, the privacy notice
   URL `https://mandimangoes.in/privacy`. Publish it.
2. **Credentials → Create credentials → OAuth client ID → Web application**.
   Under **Authorized JavaScript origins** add `https://mandimangoes.in`,
   `https://www.mandimangoes.in` and `https://ops.mandimangoes.in`. No redirect URIs
   are needed.
3. Put the client ID in `GOOGLE_CLIENT_ID` on `mandi-api`. Google sign-in for staff
   only works for emails already added on the Staff page.

## 5. Photos in Vercel Blob

On `mandi-api`: **Storage → Create → Blob**, choose private access, and connect it
to the project. Vercel adds `BLOB_READ_WRITE_TOKEN` for you. Delivery and claim
photos then go there. Production won't start without it, so photos never end up
in the database; previews may keep them there.

## 6. Deploy

Push to `main` (or merge the pull request). Vercel builds all three projects. The
API build runs the migrations (over `DATABASE_URL_UNPOOLED`) and the
reference-data seed before it goes live, so a failed migration stops the deploy
and the old version keeps serving.

For a minute after a deploy the old version still runs against the new schema,
so migrations only add: a new column or table first, and the removal of the old
one a release later, once no code uses it. A test refuses a migration that
drops, renames or narrows something unless the file has a `-- contract:` line
saying which release stopped using it.

Then point the webhooks at the API:

- Razorpay dashboard → **Webhooks**: `https://api.mandimangoes.in/webhooks/razorpay`,
  events `payment.captured`, `payment.failed` and `payment_link.paid`.
- Meta app → **WhatsApp → Configuration**: callback `https://api.mandimangoes.in/webhooks/whatsapp`
  with your `WHATSAPP_VERIFY_TOKEN`, subscribed to `messages`.

## 7. Protect it

- **Firewall rate limit on sign-in.** On `mandi-api`, **Firewall → Configure → New
  rule**: if the request path starts with `/v1/auth/` or `/admin/v1/auth/`, rate limit
  to 20 requests per minute per IP, action **Deny**. The API has its own limits too;
  this stops floods before they cost function time.
- **Turn on Vercel's bot protection** in the shop project's Firewall settings.
- **Deployment protection.** On all three projects, **Settings → Deployment
  Protection → Vercel Authentication** for previews, so only your team can open them.
- **Two-step sign-in** on every account that can change production: GitHub, Vercel,
  Neon, Razorpay, Google Cloud and Meta.
- **Branch protection on GitHub** for `main`: require the CI check to pass and one
  approval before merging. Vercel only deploys what reaches `main`.
- **Least access.** Vercel team members who only look at logs get the Viewer role;
  only the owner holds the production database password.

## 8. Watch it

- **Uptime monitor** (Better Stack, UptimeRobot, or Vercel's own): check
  `https://api.mandimangoes.in/ready` every minute and alert by SMS. It fails when the
  database is down or the maintenance job has not run for a few minutes.
- **Sentry cron monitor.** The maintenance job checks in with Sentry on every run, and
  the first run creates the monitor `maintenance`. In Sentry → **Crons**, open it and
  turn on an alert for missed and failed check-ins. Together with the uptime monitor,
  someone hears about a stopped job even if nobody opens the panel.
- **Sentry** e-mails you on new errors from the API, and warns when login codes reach
  80% of the day's budget.
- **Vercel → Logs** for request logs; **Neon → Monitoring** for database load.
- The panel's **Today** page shows a "Needs attention" card when messages, refunds or
  webhooks are failing.

## Backups and restore drill

- **What you can lose (RPO): under a minute.** Neon keeps every change for the
  history window (7 days on Launch, longer on Scale), so `main` can be restored to
  any second inside it.
- **How long it takes (RTO): aim for an hour**, from deciding to restore to the shop
  taking orders again.
- **Drill** before launch and monthly in season: make a branch of `main` at a time a
  few minutes ago, then run `DRILL_URL=<its connection string> ./mango-api/ops/restore-drill.sh`.
  It checks the schema, row counts and that the stock books balance. Delete the
  branch afterwards; it holds customer data.
- **Off-Neon copy** weekly: `mango-api/ops/backup.sh` writes a `pg_dump` you keep
  somewhere else, and `ops/restore-check.sh` proves it loads.

## Load test

`mango-api/ops/load/shop.js` is a [k6](https://k6.io) script. Run the browse
scenario against staging, and the checkout spike (50 buyers at once) against a
local copy, before the season opens. The top of the file has the commands and
the pass marks.

## Go-live checks

- [ ] `npm run preflight -- --online` shows no errors.
- [ ] Razorpay test webhooks sent to the staging API confirm orders.
- [ ] The Sentry cron monitor and the uptime monitor are set up and alert someone.
- [ ] One restore drill done.
- [ ] `https://api.mandimangoes.in/ready` returns `{"ready":true,...}`.
- [ ] Sign in to the panel as the bootstrap manager, set up two-step, then remove
      `ADMIN_BOOTSTRAP_*`.
- [ ] Add staff on the Staff page; add pincodes, slots and the first batch.
- [ ] Place one real order with a live card or UPI, then cancel it and see the
      refund arrive.
- [ ] Get the privacy notice at `/privacy` reviewed by a lawyer before launch.

## Rolling back

- **Code:** Vercel → the project → **Deployments**, pick the last good one,
  **Promote to Production**. It takes seconds.
- **Data:** Neon → **Branches → main → Restore**, to a time before the problem.
  If the bad deploy included a migration, restore the database to just before
  that deploy as well, so the older code and the schema match.
