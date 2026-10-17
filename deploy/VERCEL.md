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
by restoring a branch to a minute before it.

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
| `NODE_ENV` | `production` | `production` | |
| `DATABASE_URL` | Neon `main`, pooled, `mango_app` | Neon `staging`, pooled | |
| `DATABASE_URL_UNPOOLED` | Neon `main`, direct, owner | Neon `staging`, direct | migrations only |
| `JWT_SECRET` | random, 64 hex | a different random | |
| `CRON_SECRET` | random, 32+ chars | random | Vercel sends it to the maintenance job |
| `CUSTOMER_ORIGIN` | `https://mandimangoes.in,https://www.mandimangoes.in` | the shop preview URL | comma-separated |
| `ADMIN_ORIGIN` | `https://ops.mandimangoes.in` | the panel preview URL | |
| `COOKIE_SAMESITE` | `lax` | `none` | previews are on different `*.vercel.app` names |
| `SEED_DEMO_DATA` | `false` | `true` | demo batches only on staging |
| `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` | first manager's login | same | used once, on an empty staff table; remove after |
| `STAFF_TWO_STEP` | `managers` (or `all`) | `optional` | managers must use an authenticator app |
| `GOOGLE_CLIENT_ID` | from step 4 | same | |
| `BLOB_READ_WRITE_TOKEN` | added by Vercel Blob (step 5) | same store or a second one | |
| `SENTRY_DSN` | from Sentry | same | |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | live keys | test keys | |
| `RAZORPAY_WEBHOOK_SECRET` | from the Razorpay webhook | test webhook | |
| `SMS_PROVIDER` and `JIO_SMS_*` | `jio` and Jio's values | `log` | see [mango-api/README.md](../mango-api/README.md#login-codes-by-sms-jio) |
| `WHATSAPP_*` | Meta's values | `log` | see [mango-api/README.md](../mango-api/README.md#whatsapp-order-updates) |
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
photos then go there; without it they are kept in the database.

## 6. Deploy

Push to `main` (or merge the pull request). Vercel builds all three projects. The
API build runs the migrations (over `DATABASE_URL_UNPOOLED`) and the
reference-data seed before it goes live, so a failed migration stops the deploy
and the old version keeps serving.

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
- **Sentry** e-mails you on new errors from the API.
- **Vercel → Logs** for request logs; **Neon → Monitoring** for database load.
- The panel's **Today** page shows a "Needs attention" card when messages, refunds or
  webhooks are failing.

## Go-live checks

- [ ] `npm run preflight` shows no errors.
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
