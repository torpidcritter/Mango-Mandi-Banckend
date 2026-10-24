# The every-minute maintenance job

`/internal/maintenance` does the background work: it cancels unpaid orders whose
10-minute hold ran out, checks Razorpay for payments whose webhook was lost,
retries refunds, refunds double payments, sends WhatsApp and SMS messages, and
re-checks orders against stock. It must run **every minute** in production.

Since 2026-10-22 a checkout also cancels expired holds on the boxes it needs
(lazy expiry), so a late job no longer blocks sales. Everything else above
still waits for the job.

## Which scheduler

| Hosting | Every-minute trigger | Cost |
|---------|----------------------|------|
| Docker / one server (`deploy/README.md`) or the local launcher | Built in: the API runs the job itself every minute. Nothing to set up. | none |
| Vercel **Pro** | Change `mango-api/vercel.json` `crons[0].schedule` to `* * * * *`. | Pro plan |
| Vercel **Hobby** | An external pinger (below). `vercel.json` keeps a once-a-day Vercel Cron (03:00 IST) as a backstop, which Hobby allows. | free |

Hobby refuses to deploy a project whose cron runs more than once a day, which is
why `vercel.json` ships with the daily schedule.

## External pinger (Vercel Hobby)

Any service that can call a URL every minute with a custom header works, for
example cron-job.org (free). Set it up like this:

1. URL: `https://<your API domain>/internal/maintenance`, method GET (POST also works).
2. Schedule: every minute.
3. Request header: `Authorization: Bearer <CRON_SECRET>`, the same value as the
   API's `CRON_SECRET` environment variable in Vercel. Type it into the
   service's own settings page. Never paste it into chat, a ticket or the repo.
4. Request timeout: 60 seconds (the function's limit).
5. Turn on the service's failure e-mail.

Check it works: in Vercel → Logs you should see `GET /internal/maintenance 200`
every minute, and `https://<your API domain>/ready` answers `{"ready":true,...}`.
A wrong secret shows as 401 in the logs and `/ready` turns 503 after 4 minutes.

Two runs at once are safe: the job takes a lease in the database (`job_leases`)
and the second run returns `{"skipped":true}`. A run killed at Vercel's 60-second
limit loses its lease after 65 seconds, so the next minute's run goes ahead.

## What records each run

- `maintenance_runs`: one row per step with the time it last succeeded
  (`last_ok_at`) or failed (`last_err_at`, `last_error`). The row `tick` is
  written at the end of every run that held the lease; a skipped run writes
  nothing, so it never hides a stuck job. These are latest-only, not a history.
- The history is the request log: one `GET /internal/maintenance 200` line per
  run (Vercel → Logs), and the Sentry cron monitor's check-ins.
- The panel's Needs attention card shows the last run and failing steps.

## Monitoring (required before launch)

`/ready` is the signal for an outside monitor. It needs no secret and says only
this:

| Answer | Meaning |
|--------|---------|
| `200 {"ready":true,"maintenanceAgeSeconds":42}` | Database answers, the last maintenance run finished 42 s ago |
| `503 {"ready":false,"maintenanceAgeSeconds":241}` | No run has finished for over 4 minutes: the scheduler (or every run) has stopped |
| `503 {"ready":false}` | The database doesn't answer |

In production a database where no run has ever finished also answers 503.

The rule is 4 minutes (three missed runs), so a monitor that checks every
minute alerts at most 5 minutes after the last good run, and one slow or skipped
run never trips it. A monitor that checks only every 3 or 5 minutes (common on
free plans) alerts up to about 7 or 9 minutes after the last run instead.

### Set up the uptime monitor (free)

Use a different service from the pinger, so one outage can't silence both.

1. Create an HTTP(S) monitor for `https://<your API domain>/ready`, method GET,
   no headers. It must count any status other than 200 as down (the default on
   most services).
2. Interval: every minute if the plan offers it; see above for what a longer
   interval means.
3. Alert by SMS or phone call to the on-call person named in
   `deploy/VERCEL.md` ("Watch it"), and by e-mail to the backup person.
4. If the service has a "confirm before alerting" or "retries" setting, keep it
   at one extra check at most; each extra check adds a minute.
5. Turn on the "back up" (recovery) notification too.

If no free service gives one-minute checks, a second cron-job.org job (a
separate account is better) that calls `/ready` every minute and e-mails on a
failure works as the monitor, together with the Sentry cron monitor below.

### Sentry cron monitor

The job checks in with Sentry on every run (monitor `maintenance`). In
Sentry → Crons turn on alerts for missed and failed check-ins. Write the owner's
name in the launch checklist (`deploy/VERCEL.md`, "Watch it").

### Test the alert (staging, then production)

1. Pause the pinger.
2. Watch `/ready`: `maintenanceAgeSeconds` climbs; after 4 minutes it answers
   503 and the monitor alerts within the next check.
3. Resume the pinger. The next run makes `/ready` answer 200; the monitor sends
   its recovery notice.
4. Write the times (paused, 503 seen, alert received, resumed, recovered) in the
   evidence list below.

## Evidence needed to call this done

- [ ] 24 hours of `/internal/maintenance 200` once a minute in staging logs
      (no gap over 2 minutes).
- [ ] The uptime monitor alerted within 5 minutes of the last run when the
      pinger was paused, and cleared when it was resumed (times written down).
- [ ] The Sentry `maintenance` monitor shows check-ins and has an alert rule.
