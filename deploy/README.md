# Going live

MandiMangoes runs on one Linux server with Docker. [`compose.yml`](compose.yml) starts five
things:

| Service | What it does |
|---------|--------------|
| `web` | Caddy: HTTPS for all three domains (certificates issued and renewed automatically), serves the customer shop and the staff panel, and forwards the API |
| `api` | mango-api: migrates the database on start, runs the maintenance loop |
| `db` | PostgreSQL 16, on a Docker volume |
| `backup` | a `pg_dump` at start and every 24 hours, encrypted, copied off the server, and kept 14 days in `deploy/backups/` (see [Backups](#backups)) |

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
   with `openssl rand -hex 32`. Never commit this file. `VITE_SUPPORT_WHATSAPP` (the shop's
   help WhatsApp number, country code and number, digits only) is required: the shop build
   fails without it, because every shop page shows customers how to reach a person.
5. **Deploy.**
   ```bash
   ./deploy/deploy.sh
   ```
   It builds the images and runs the go-live checks (below) against your real settings
   and database. Only when they pass does it start the new version. It then waits up to
   90 seconds (`READY_WAIT_S`) for `/ready`; if the new version never gets there, it
   deploys the previous commit again on its own and exits with an error
   (`NO_ROLLBACK=1` turns that off). Otherwise it prints the commit that is live and how
   to go back. The old containers stop before the new ones start, so expect up to a
   minute of downtime when a deploy goes wrong.
6. **Webhooks.** In Razorpay (Dashboard > Webhooks) add `https://API_DOMAIN/webhooks/razorpay`
   with events `payment.authorized`, `payment.captured`, `payment.failed`, `payment_link.paid`, `refund.processed`, `refund.failed` and the `payment.dispute.*` events (disputes are only recorded and shown in Needs attention). Use the same secret as `RAZORPAY_WEBHOOK_SECRET`. To rotate it, set the old one as `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` for a day (Razorpay may retry older events signed with it), then remove it.
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

**Backups.** Set up once, then checked by the staff panel: see [Backups](#backups).
`docker compose logs --tail 20 backup` shows the last runs.

**Monitoring.** Point an uptime checker (UptimeRobot, Better Stack) at
`https://API_DOMAIN/ready` and the shop's home page. The alert rules in
[`../mango-api/ops/alerts.yml`](../mango-api/ops/alerts.yml) need Prometheus scraping
`api:3000/metrics` from inside the server; Caddy keeps `/metrics` off the internet.
These rules and `/metrics` apply to this Docker setup only; on Vercel `/metrics` is
404 and alerting is Sentry plus an uptime monitor ([VERCEL.md, Watch it](VERCEL.md#8-watch-it)).

**Rolling back a migration.** Migrations only move forward. Going back to an older commit
keeps the newer tables, which older code ignores. If a migration itself is wrong, prefer a
new migration that repairs it. Restoring a backup loses every order, payment and account
deletion since the backup while Razorpay keeps the money, so after any restore run
`ops/replay-payments.js` and `ops/reapply-deletions.js` (see
[VERCEL.md, Rolling back](VERCEL.md#rolling-back)).

## Backups

The `backup` service takes a backup when it starts and every 24 hours after. A backup
holds customers' names, phones and addresses, so each one is:

- **encrypted** with your public key before it is written. Without the key it takes no
  backup at all: there is never an unencrypted copy on the server.
- **copied off the server** in the same run, because a backup on the server is lost with
  the server. Until the copy is set up, every run counts as failed.
- **kept 14 days** in `deploy/backups/` too (`BACKUP_RETAIN_DAYS` in `deploy/.env`).
- **recorded in the database.** When no backup has succeeded for 26 hours, the staff
  panel's **Needs attention** says so, and a failed run shows there as "Nightly backup
  is failing". After a failure it tries again in an hour.

Set it up once, right after the first deploy (until then Needs attention shows the
warning).

**1. Make a key pair on your own computer, not on the server.** Install GPG (Mac:
`brew install gnupg` or GPG Suite; Windows: Gpg4win; Linux already has it), then run:

```bash
gpg --quick-generate-key "MandiMangoes backups" default default never
gpg --armor --export "MandiMangoes backups" > backup-public-key.asc
gpg --armor --export-secret-keys "MandiMangoes backups" > backup-PRIVATE-key.asc
```

It asks for a passphrase: choose a strong one and write it down. Keep
`backup-PRIVATE-key.asc` and the passphrase offline in two places (for example a password
manager and a USB stick in a safe). Without them nobody can read the backups, you
included. Never put the private key on the server or in GitHub; the backup refuses to run
if it finds one. (On Vercel, the same public key goes in the `BACKUP_GPG_PUBLIC_KEY`
secret.)

**2. Put the public key on the server**, from your computer:

```bash
scp backup-public-key.asc deploy@YOUR_SERVER_IP:mandimangoes/deploy/backup-config/
```

`deploy.sh` makes the `deploy/backup-config/` folder (Git ignores it). The file must be
named `backup-public-key.asc`.

**3. Copy each backup off the server.** Any storage works. This uses
[rclone](https://rclone.org) with Backblaze B2 or any S3-compatible storage: create a
bucket (e.g. `mandimangoes-backups`) and an application key that can write to it but not
delete from it. Then on the server, once as root: `apt-get install -y unzip`. Then as
`deploy`:

```bash
cd ~/mandimangoes/deploy/backup-config
curl -fsSLO https://downloads.rclone.org/rclone-current-linux-amd64.zip   # an ARM server: linux-arm64
unzip -j rclone-current-linux-amd64.zip '*/rclone' && rm rclone-current-linux-amd64.zip
./rclone config --config ./rclone.conf   # n (new remote), name it offsite, pick your provider, paste the key
```

Then add this line to `deploy/.env`, **with the single quotes**:

```bash
BACKUP_UPLOAD_CMD='/backup-config/rclone --config /backup-config/rclone.conf copy "$BACKUP_FILE" offsite:mandimangoes-backups'
```

The backup service sees `deploy/backup-config/` as `/backup-config`, and `$BACKUP_FILE` is
the encrypted file it just wrote. Any other command that copies that file works too.

**4. Start it and check:**

```bash
cd ~/mandimangoes/deploy
docker compose up -d backup
docker compose logs --tail 20 backup
```

You should see `backup written: /backups/mango-....dump.gpg` and `backup copied off the
server`, and the file should be in your bucket. If you see `backup FAILED while ...`, the
line above it says what to fix. Fix it, then `docker compose restart backup`.

**Restore.** Prove the backups work once a month, on your own computer (it needs
PostgreSQL 16 and the private key):

1. Download a `mango-....dump.gpg` from the bucket.
2. Once per computer, import the private key: `gpg --import backup-PRIVATE-key.asc`.
3. Decrypt it (it asks for the passphrase):
   `gpg --decrypt mango-....dump.gpg > mango.dump`
4. Check it restores into a scratch database (the script creates and drops its own):
   `ADMIN_URL=postgres://USER:PASSWORD@localhost:5432/postgres ./mango-api/ops/restore-check.sh mango.dump`
   It should end with `restore check passed`.
5. Delete `mango.dump` afterwards: it is customers' data, unencrypted.

Putting a backup back into production loses every order since it was taken: read
**Rolling back a migration** above first.
