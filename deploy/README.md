# Going live

MandiMangoes runs on one Linux server with Docker. [`compose.yml`](compose.yml) starts five
things:

| Service | What it does |
|---------|--------------|
| `web` | Caddy: HTTPS for all three domains (certificates issued and renewed automatically), serves the customer shop and the staff panel, and forwards the API |
| `api` | mango-api: migrates the database on start, runs the maintenance loop |
| `db` | PostgreSQL 16, on a Docker volume |
| `backup` | a `pg_dump` at start and every 24 hours into `deploy/backups/`, kept 14 days |

| Address | Serves |
|---------|--------|
| `https://SHOP_DOMAIN` (and `www.`) | customer shop |
| `https://ADMIN_DOMAIN` | staff panel (hidden from search engines) |
| `https://API_DOMAIN` | API, plus the Razorpay and WhatsApp webhooks |

## What you need first

These take days to weeks and only the business can do them, so start them now:

- [ ] **Domain**, e.g. `mandimangoes.in`, with access to its DNS settings.
- [ ] **Server**: any VPS in India with Ubuntu 24.04, 2 vCPU, 4 GB RAM, 40 GB disk
  (AWS Lightsail Mumbai, DigitalOcean Bangalore, or similar).
- [ ] **Razorpay live account**: KYC done and live API keys issued.
- [ ] **Jio DLT**: entity registration, a 6-letter sender ID (e.g. `MANDIM`), and the OTP
  template approved word for word: `{#var#} is your MandiMangoes login code. It expires in 5 minutes.`
  Also Jio's SMS API URL and key.
- [ ] **WhatsApp** (optional at launch): Meta business verification, a WhatsApp business
  number, and the 12 templates in [`../mango-api/README.md`](../mango-api/README.md)
  approved. Until then leave `WHATSAPP_PROVIDER=log`. Orders still work, just without
  WhatsApp updates.

## First deploy

1. **DNS.** Add A records for `SHOP_DOMAIN`, `www.SHOP_DOMAIN`, `ADMIN_DOMAIN` and
   `API_DOMAIN`, all pointing at the server's IP.
2. **Server.** As root on a fresh Ubuntu server:
   ```bash
   curl -fsSL https://get.docker.com | sh
   adduser --disabled-password --gecos "" deploy && usermod -aG docker deploy
   ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
   ```
3. **Code.** As `deploy`:
   ```bash
   git clone https://github.com/torpidcritter/Mango-Mandi-Banckend.git mandimangoes
   cd mandimangoes
   cp deploy/.env.example deploy/.env && chmod 600 deploy/.env
   ```
   The repository is private, so this needs a GitHub deploy key or access token on the server.
4. **Settings.** Fill in `deploy/.env`. Every line is explained there. Generate secrets
   with `openssl rand -hex 32`. Never commit this file.
5. **Deploy.**
   ```bash
   ./deploy/deploy.sh
   ```
   It builds the images and runs the go-live checks (below) against your real settings
   and database. Only when they pass does it start the new version. It then prints the
   commit that is live and how to go back.
6. **Webhooks.** In Razorpay (Dashboard > Webhooks) add `https://API_DOMAIN/webhooks/razorpay`
   with events `payment.captured`, `payment.failed` and `payment_link.paid`. Use the same secret as `RAZORPAY_WEBHOOK_SECRET`.
   For WhatsApp, set the callback URL `https://API_DOMAIN/webhooks/whatsapp` and your
   `WHATSAPP_VERIFY_TOKEN` in the Meta app.
7. **Set up the shop.** Sign in to `https://ADMIN_DOMAIN` with `ADMIN_BOOTSTRAP_EMAIL`, then:
   change that password on the Staff page and add your staff, check the pincodes, add
   delivery slots and the delivery calendar on Planning, and receive your first batch.
8. **Test order.** Place a real order of one box in the shop, pay, then cancel it and
   check the refund arrives.

## Go-live checks

`./deploy/deploy.sh` runs them on every deploy. Run them any time with:

```bash
cd deploy && docker compose run --rm api npm run preflight -- --online
```

They stop the launch (`FAIL`) for:
- a weak `JWT_SECRET`
- missing Razorpay keys or the dev webhook secret
- SMS not going through Jio
- origins that aren't https
- demo staff logins in the database
- no way for anyone to sign in to the panel

They warn (`warn`) about:
- Razorpay test keys
- WhatsApp switched off
- no delivery slots

`--online` also asks Razorpay and Meta whether the keys work. The API itself also
refuses to start on any `FAIL` item.

## Automatic deploys

The `Deploy` GitHub Action deploys `main` after CI passes on it, and can be run by hand
(Actions > Deploy > Run workflow) with any commit. It does nothing until you set it up:

1. On the server, as `deploy`: `ssh-keygen -t ed25519 -f ~/.ssh/gha -N ""` and
   `cat ~/.ssh/gha.pub >> ~/.ssh/authorized_keys`.
2. In GitHub (Settings > Environments) create the environment `production`. Add a
   required reviewer if every deploy should wait for a person's approval.
3. In that environment, add these secrets:
   - `DEPLOY_SSH_KEY`: the contents of `~/.ssh/gha`
   - `DEPLOY_KNOWN_HOSTS`: the output of `ssh-keyscan YOUR_SERVER_IP`
4. Add these variables:
   - `DEPLOY_HOST`: the server's IP
   - `DEPLOY_USER` (optional, default `deploy`)
   - `DEPLOY_DIR` (optional, default `mandimangoes`)

## Day to day

| Task | Command (in `deploy/`) |
|------|-------------------------|
| Status | `docker compose ps` |
| API logs | `docker compose logs -f --tail 200 api` |
| Roll back | `../deploy/deploy.sh <commit printed by the last deploy>` |
| Restart the API | `docker compose restart api` |
| Database shell | `docker compose exec db psql -U mango mango` |

**Backups.** The `backup` service writes `deploy/backups/mango-*.dump` daily. A backup on
the same server is lost with the server, so copy them off it every night. For example,
use `rclone` to object storage in a cron job:
`0 3 * * * rclone copy ~/mandimangoes/deploy/backups remote:mandimangoes-backups`.
Prove the backups work once a month with
[`../mango-api/ops/restore-check.sh`](../mango-api/ops/restore-check.sh).

**Monitoring.** Point an uptime checker (UptimeRobot, Better Stack) at
`https://API_DOMAIN/ready` and the shop's home page. The alert rules in
[`../mango-api/ops/alerts.yml`](../mango-api/ops/alerts.yml) need Prometheus scraping
`api:3000/metrics` from inside the server; Caddy keeps `/metrics` off the internet.

**Rolling back a migration.** Migrations only move forward. Going back to an older commit
keeps the newer tables, which older code ignores. If a migration itself is wrong, restore
the last backup (see `restore-check.sh`) instead.
