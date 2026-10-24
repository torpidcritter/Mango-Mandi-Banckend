# Releasing MandiMangoes (Vercel and Neon)

How a change goes from a pull request to customers, how to check it, and how to
take it back. The one-time setup is in [VERCEL.md](VERCEL.md); this page is for
every release. The Docker path has its own script (`deploy/deploy.sh`, which
already migrates, runs preflight, waits for `/ready` and rolls back on its own).

Who does it: the **owner** (or whoever holds the Vercel and Neon logins).
Time: about 20 minutes when nothing goes wrong, most of it waiting for builds.

## How a release works here (read once)

| Step | What runs it | Where it is in the code |
|------|--------------|-------------------------|
| Tests on every pull request | GitHub Actions CI: `build-and-test` (types, lint, unit, builds, **bundle scan**, panel specs), `api` (API suite twice: direct and through PgBouncer in transaction mode), `previous-release-on-new-schema` (the old API's tests on the new migrations), `e2e` (panel and shop against the real API), `production-images` | `.github/workflows/ci.yml` |
| Migrations | the **Vercel build** of `mandi-api`: `npm run vercel-build` = `node src/migrate.js && node src/seed.js`, over `DATABASE_URL_UNPOOLED` | `mango-api/package.json`, `mango-api/vercel.json` |
| Refusing the wrong database | the first migration stamps the database `production` or `preview` (`app_meta`); a build or an API that finds the other stamp refuses it; `PRODUCTION_DB_HOST` refuses it even before the stamp | `mango-api/src/migrate.js` `checkDatabaseEnvironment`, `src/preflight.js` |
| Refusing unsafe settings | every production start runs the preflight checks and exits on an error (weak `JWT_SECRET`, no Sentry, `ENABLE_DEV_ROUTES`, localhost origins, no `CRON_SECRET`, ...) | `mango-api/src/env.js` (end), `src/preflight.js` |
| Refusing an unsafe bundle | the shop and panel Vercel builds end with `node scripts/scan-bundle.mjs <dist> --forbid-localhost-in-production`: a secret, a dev route, a demo account or a mock fails any build, and a missing `VITE_API_URL` fails a production build | `vercel.json`, `customer-app/vercel.json`, `scripts/scan-bundle.mjs` |
| The new version goes live | Vercel, when the build succeeds. A failed build (a failed migration included) changes nothing: the old version keeps serving | Vercel |

**Migrations run before the new code serves, and they only add.** For a minute
after a deploy (and for as long as you stay rolled back) the *previous* code runs
on the *new* schema. That is why:

- a migration may add tables, columns (nullable or with a default), indexes and
  constraints that old code satisfies, but may not drop, rename or narrow
  anything. `mango-api/test/migrations.test.js` fails a migration that does,
  unless the file has a `-- contract:` line naming the release that stopped using
  it (that removal ships one release *after* the code stopped using it);
- CI's `previous-release-on-new-schema` job (`mango-api/scripts/n-minus-1.sh`) runs
  the old release's whole API suite on the new migrations. This is the **N-1 check**;
- each migration file runs in one transaction with a 5 s lock timeout, tried 3
  times (`src/migrate.js`, `MIGRATION_LOCK_TIMEOUT`). A file that fails is rolled
  back completely; the files before it stay applied.

## 0. Before you start

- [ ] The pull request's CI is green, all five jobs. Branch protection (below)
      makes this impossible to skip.
- [ ] If the pull request has a migration: read it. Only adds? Any `ALTER TABLE` on
      a big table has a `-- locks:` note saying what it locks and for how long?
- [ ] Nobody is in the middle of packing or dispatch, if the change touches orders,
      stock or the panel. Mornings before 8:00 IST are quiet.
- [ ] You know the current production deployment (Vercel → `mandi-api` →
      Deployments → the one marked **Current**). Write its URL down: it is your
      rollback target.

## 1. Staging first (the pull request's preview)

Every pull request gets preview deployments of all three projects, built with the
**Preview** environment variables: the Neon `staging` branch, Razorpay **test**
keys, `COOKIE_SAMESITE=none`. The preview API build runs the migrations against
`staging` first, so a migration that fails, or is slow on real-sized data, fails
there before it can touch production.

1. Open the pull request's Vercel comment, or Vercel → `mandi-api` → Deployments,
   and wait for the three previews to be **Ready**. A preview API build that failed
   at `migrate.js` stops here: fix the migration, never edit one that already ran
   on `staging` (add a new one).
2. Run the smoke test against the preview (from your computer, in `mango-api/`):

   ```sh
   npm run smoke -- --api https://<api preview>.vercel.app \
     --shop https://<shop preview>.vercel.app --panel https://<panel preview>.vercel.app
   ```

   Every line must be `ok` (or `check`, see below). Previews are behind Vercel
   Authentication (VERCEL.md step 7): create a secret under the project's
   Settings → Deployment Protection → **Protection Bypass for Automation** and add
   `--header "x-vercel-protection-bypass: <that secret>"` (the option can be
   given more than once). Keep the secret out of chat and the repo.
3. Click through what changed, in the preview shop and panel, signed in as the
   preview manager (`PREVIEW_ADMIN_EMAIL`). For payment changes: pay a test order
   with Razorpay's test card or UPI, then in Razorpay (test mode) → Webhooks check
   the delivery shows 200.
4. `cd mango-api && npm run preflight -- --online` with the **preview** values:
   no `FAIL` lines (preflight checks the role time limits, Razorpay keys and the
   WhatsApp number).

## 2. Promote the exact tested commit to production

The rule: **production gets the commit you tested on staging, nothing newer.**

- With branch protection's "Require branches to be up to date before merging"
  on, the pull request's head already contains everything on `main`, so the
  merge produces exactly the tree you tested.
- **Merge the pull request** (a squash or a merge commit; both give the same tree).
  Vercel builds `main` for production: the `mandi-api` build migrates Neon `main`
  over `DATABASE_URL_UNPOOLED`, then seeds reference data; the shop and panel
  builds rebuild with production `VITE_*` values and scan the bundle.
- Check the production deployment's commit (Vercel → Deployments → the new one →
  **Source**) is the merge of the pull request you tested. If anything else landed
  on `main` in between, stop and test that too.

Alternative (stricter, optional): turn off automatic production deploys for the
three projects and, after merging, use Vercel → the tested preview deployment →
**Promote to Production**. Vercel then builds the same commit with the Production
environment variables (env values are baked into the build, so a rebuild is
unavoidable). Watch the dialog: it names the commit. Either way the guarantee is
"same commit, same lockfile", not "same bytes".

**Do not** use "Redeploy" on an *older* production deployment to ship a fix. It
rebuilds old code, which is a rollback (step 5), not a release.

## 3. While it builds

- Watch the `mandi-api` build log: `migration applied` per new file, then
  `npm run vercel-build` succeeding. If the build fails, **nothing changed for
  customers**; read "A migration failed" in step 5.
- The shop and panel builds end with `Bundle scan passed`.

## 4. Check production (within 10 minutes of going live)

```sh
cd mango-api
npm run smoke -- --api https://api.mandimangoes.in \
  --shop https://mandimangoes.in --panel https://ops.mandimangoes.in
npm run preflight -- --online          # with the production values in .env, from a trusted computer
```

The smoke test is read-only (`mango-api/scripts/smoke.mjs`). It checks:

| Check | Passes when |
|-------|-------------|
| `/health`, `/ready` | 200; `/ready` says the database answers and maintenance ran in the last 300 s |
| http → https | each site redirects plain http to https |
| security headers | API: nosniff, frame options, CSP, referrer policy, HSTS, no `X-Powered-By`; shop and panel: CSP header with `frame-ancestors 'none'` and `object-src 'none'`, nosniff, frame options, HSTS; panel `X-Robots-Tag: noindex` |
| CORS | the shop's and panel's origins are allowed with credentials; another origin and `null` get no `Access-Control-Allow-Origin` |
| refresh cookies | `mango_admin_rt` and `mm_customer_rt` are HttpOnly, Secure, SameSite, and scoped to their auth path (read from a logout with no session, which revokes nothing); a logout from another site is refused (403) |
| dev routes | `POST /v1/dev/pay` is 404 |
| cron secret | `/internal/maintenance` is 401 without it and with a wrong one |
| `/metrics` | not 200 (404 on Vercel) |
| webhooks | Razorpay: unsigned and badly signed bodies are 400; WhatsApp: unsigned body 401, wrong verify token 403 |
| deployed bundle | the shop's and panel's entry scripts have no secrets, dev routes, demo accounts or localhost API (same rules as the CI scan) |
| demo accounts | **`check`** by default: `npm run preflight` fails on any `@mandimangoes.test` staff in the database. `--check-demo-login` also tries one sign-in as the demo manager, which must be refused (it costs one password failure on that email, so it is off by default) |

Then, by hand (5 minutes):

| What | How | Good looks like |
|------|-----|-----------------|
| Scheduler | Vercel → `mandi-api` → Logs, filter `/internal/maintenance` | a `200` every minute (Pro cron or the external pinger, deploy/SCHEDULER.md); never `401` |
| Sentry cron monitor | Sentry → Crons → `maintenance` | check-ins every minute, status OK |
| Webhooks | Razorpay → Webhooks → the production webhook → recent deliveries | 200s after the deploy time (if any payment happened); none `4xx` |
| WhatsApp webhook | Meta app → WhatsApp → Configuration | callback verified (green) |
| DB connections | Neon → `main` → Monitoring → Connections | below the compute's limit, no climb after the deploy |
| Notification worker | panel → Today → Needs attention | no "Sending WhatsApp updates is failing", no growing "WhatsApp messages not delivered" |
| Errors | Sentry → Issues, last 30 minutes | nothing new from this release |
| A real path | open the shop on a phone, add a box to the cart, reach the payment step (do not pay); open the panel's Today page | works, looks right |

If any of these fail and you can't fix it in 10 minutes, **roll back** (step 5)
and fix calmly.

## 5. Rolling back

### Code: Vercel Instant Rollback (seconds)

Vercel → the project → Deployments → the last good production deployment →
**Instant Rollback** (or **Promote to Production** on it). Do it for `mandi-api`
first, then the shop and panel if they changed. No rebuild runs, so no migration
runs. Then run the smoke test again.

Why it is safe: the database keeps the new migrations, and the previous code was
proven to work on them by the N-1 check in CI. New columns are ignored by old
code; new tables are unused. Nothing is lost.

Business rules (Planning → Rules) are the one exception for releases older than
the one with migration 032. From 032 on, the API drops rule keys it doesn't know
when it reads them, so a rollback keeps working after a newer release saved
rules. Releases before it (`main` at bd5d2bf and older) refuse any unknown key
and answer 500 on every request. Before rolling back to one of those, check
whether rules were saved on the newer release, and if so save a copy without the
new keys first (Neon → SQL editor on `main`):

```sql
INSERT INTO app_config (version, value, changed_by)
SELECT version + 1,
       value - 'maxUnpaidOrders' - 'maxHeldBoxes' - 'outForDeliveryAlertHours' - 'maxPreorderMoves' - 'seasonEndsOn',
       'rollback'
  FROM app_config ORDER BY version DESC LIMIT 1;
```

The newer release reads that copy too (the missing keys take their defaults), so
rolling forward again needs nothing more.

Then:
- Tell staff to reload the panel.
- Leave the rollback in place until the fix is merged and passes staging.
- After an Instant Rollback, Vercel stops giving new production builds the
  production domains until you promote one again (the Deployments page says so
  at the top). So the next merge to `main` builds but may not go live by itself:
  after the fix is merged, check its deployment and **Promote** it.

### A migration failed during the build

The build log shows `Migration <file> failed: ...`. The file ran inside one
transaction, so it left nothing half-done; the files before it in the same
release stay applied (they only add, so the running code doesn't mind). The old
code is still serving. Then:

1. `Migration ... failed ... (a table it changes stayed locked ...)`: a long
   transaction held a lock. Look in Neon → SQL editor:
   `SELECT pid, state, now() - xact_start AS age, query FROM pg_stat_activity WHERE state <> 'idle' ORDER BY age DESC;`
   Wait for it or end it, then Vercel → the failed deployment → **Redeploy**.
2. Any other error: the migration is wrong for production data (staging is a
   copy from when the branch was made; production may have grown rows staging
   lacks). Do not edit the failed file if it ran anywhere; write a new migration
   that works, merge, deploy. If the failed file never ran anywhere (it failed
   everywhere), fixing it in place is fine.
3. Never "fix" production by hand in the SQL editor to make a migration pass
   without writing the same change as a migration.

### Data went wrong (not code)

Roll **forward**: correct the rows or ship a fix. Restoring the database is the
last resort; the steps (Neon restore, `ops/replay-payments.js`,
`ops/reapply-deletions.js`) are in VERCEL.md "Rolling back" and RUNBOOKS.md.

## 6. Branch protection (click once; the owner)

GitHub → the repository → **Settings → Rules → Rulesets → New branch ruleset**
(or **Settings → Branches → Add classic branch protection rule**):

| Setting | Value |
|---------|-------|
| Name / target | `main` (Target branches → Include default branch) |
| Enforcement status | **Active** |
| Bypass list | **empty** (not even administrators; this is what stops an emergency push from skipping CI) |
| Restrict deletions | on |
| Block force pushes | on |
| Require a pull request before merging | on; required approvals **1** if a second person reviews, **0** if you work alone (GitHub won't let you approve your own pull request) |
| Dismiss stale approvals when new commits are pushed | on |
| Require status checks to pass | on, with **Require branches to be up to date before merging** on |
| Required checks | `build-and-test`, `api`, `previous-release-on-new-schema`, `e2e`, `production-images` (type each name; they appear after one CI run) |
| Require conversation resolution | on (optional) |

Check it: `gh api repos/<owner>/<repo>/branches/main/protection` (classic rule)
or `gh api repos/<owner>/<repo>/rulesets` (ruleset) returns the rule, and a test
push straight to `main` is refused.

Also: GitHub → Settings → Environments is only used by the Docker path's Deploy
workflow; on Vercel, Vercel deploys whatever reaches `main`, which is why the
rule above matters.

## 7. Neon settings (the owner, once; re-check each season)

### Two branches, two sets of roles

| | Production | Staging (previews) |
|---|---|---|
| Neon branch | `main` | `staging` (made from `main`, VERCEL.md step 1) |
| App login (`DATABASE_URL`) | `mango_app`, **pooled** host (`-pooler`) | `mango_app` on `staging`, pooled |
| Migrations (`DATABASE_URL_UNPOOLED`) | the owner role (`neondb_owner`), **direct** host | the owner role on `staging`, direct |
| Backups (`BACKUP_DATABASE_URL`, GitHub secret) | a read-only role, **direct** host | none |
| Backup heartbeat (`BACKUP_HEARTBEAT_DATABASE_URL`) | `mango_backup_beat` (writes one table) | none |
| `PRODUCTION_DB_HOST` | the `main` endpoint host, set on **both** Production and Preview | |

A branch made from `main` starts with copies of `main`'s roles. Reset the
passwords of the roles on `staging` (Neon → Branches → `staging` → Roles → Reset
password) so a preview's credentials can never open `main`, then put the new
ones in the Preview variables. (`PRODUCTION_DB_HOST` and the environment stamp
already stop a preview *deployment* from using `main`; this covers a leaked
preview password.)

### Pooled vs direct

- The API uses the **pooled** URL. Neon's pooler is PgBouncer in **transaction
  mode**: each transaction may get a different server connection, so session
  settings (`SET statement_timeout`) don't stick. That is why the time limits
  below go on the **role**. CI runs the whole API suite through PgBouncer in
  transaction mode to prove stock locking still holds (`ci.yml`, job `api`).
- **Migrations** need the **direct** URL (they take a session advisory lock,
  `src/migrate.js`). Preflight refuses a pooled `DATABASE_URL` without
  `DATABASE_URL_UNPOOLED` on Vercel.
- `pg_dump` (backups) uses the direct URL too.

### Connection limits

| Setting | Value | Where |
|---------|-------|-------|
| `DB_POOL_MAX` (connections per Vercel instance) | **5** (the default on Vercel; leave it unset) | `src/env.js:16` |
| `DB_CONNECT_TIMEOUT_MS` (wait for a free connection, then answer 503 "busy, retry") | **5000** (default) | `src/env.js:18`, `src/db.js:28` |
| idle connection release on Vercel | 5 s (fixed) | `src/db.js:25` |
| Neon compute size | start at the smallest that keeps **autoscaling max ≥ 1 CU** in season; Neon's `max_connections` grows with compute size. Check Neon's connection table for your size | Neon → Branch `main` → Compute |
| Neon pooler | on (the `-pooler` host); it accepts thousands of client connections and shares a smaller number of server connections | Neon |

Rule of thumb: instances × 5 is the most client connections the API opens; the
pooler absorbs them. If Neon → Monitoring shows server connections near the
compute's limit during a sale, raise the compute's minimum size for the day
rather than `DB_POOL_MAX`.

### Time limits (match what the code expects)

| Role | Setting | Value | Why this value |
|------|---------|-------|----------------|
| `mango_app` | `statement_timeout` | **10s** | the same as the code's `DB_STATEMENT_TIMEOUT_MS` default (10 000 ms, `src/env.js:17`), which the code sets itself only on a direct URL (`src/db.js:23`); a request or a maintenance step never needs longer, and the maintenance run's budget is 45 s inside Vercel's 60 s limit |
| `mango_app` | `idle_in_transaction_session_timeout` | **30s** | the code never sets it; a Vercel function frozen or killed mid-transaction would otherwise hold its stock row locks until the connection dies |
| `mango_app` | `lock_timeout` | **5s** | below the statement timeout, so a request stuck behind a locked stock or order row gives up early with a retryable 503 BUSY instead of holding a connection for 10 s (LOAD-3 in LOAD-TEST.md) |
| owner (migrations) | `statement_timeout` | **60s** | migrations on real data; each file also has a 5 s **lock** timeout (`MIGRATION_LOCK_TIMEOUT`, tried 3 times) so it never queues behind traffic for long |
| read-only backup role | `statement_timeout` | **0** (none) or `15min` | `pg_dump` runs one long transaction |

```sql
ALTER ROLE mango_app SET statement_timeout = '10s';
ALTER ROLE mango_app SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE mango_app SET lock_timeout = '5s';
ALTER ROLE neondb_owner SET statement_timeout = '60s';
```

Run the same four lines on `staging`. `npm run preflight -- --online` reads both
values over `DATABASE_URL` and **fails** when either is unset on a pooled URL
(`src/preflight.js` `checkRoleTimeouts`). If you ever change
`DB_STATEMENT_TIMEOUT_MS`, change the role's `statement_timeout` to match.

### History (restore) window

Neon → Project settings → History retention (restore window): **7 days** (the
Launch plan's maximum; 1 day is the paid-plan default). This is what makes a
restore to "a minute before the mistake" possible; see RESTORE-DRILL.md in the
readiness notes and VERCEL.md "Backups and restore drill".
