#!/usr/bin/env bash
# Records a backup's outcome as the step 'backup' in maintenance_runs, so the
# API's Needs attention card and health alert (Sentry) warn when backups stop.
# The GitHub backup workflow (.github/workflows/backup.yml) runs it as its last
# step, the Vercel path's equivalent of BACKUP_HEARTBEAT=true in ops/backup.sh.
#
#   HEARTBEAT_DATABASE_URL=... ./ops/backup-heartbeat.sh ok
#   HEARTBEAT_DATABASE_URL=... ./ops/backup-heartbeat.sh error "backup failed while ..."
#
# HEARTBEAT_DATABASE_URL logs in as a role that can write this one table and
# read nothing else (deploy/VERCEL.md, Backups):
#   CREATE ROLE mango_backup_beat LOGIN PASSWORD '<random>';
#   GRANT USAGE ON SCHEMA public TO mango_backup_beat;
#   GRANT SELECT (step), INSERT (step, last_ok_at, last_err_at, last_error),
#         UPDATE (last_ok_at, last_err_at, last_error) ON maintenance_runs TO mango_backup_beat;
# (SELECT on the key column is what INSERT ... ON CONFLICT needs to find the row.)
# Only fixed messages go in: never a URL, a key or a command line.
set -euo pipefail
: "${HEARTBEAT_DATABASE_URL:?set HEARTBEAT_DATABASE_URL}"
outcome="${1:-}"
case "$outcome" in
  ok)
    psql "$HEARTBEAT_DATABASE_URL" -qAtX -v ON_ERROR_STOP=1 -c \
      "INSERT INTO maintenance_runs (step, last_ok_at) VALUES ('backup', now()) ON CONFLICT (step) DO UPDATE SET last_ok_at = now()" >/dev/null
    echo "backup heartbeat recorded"
    ;;
  error)
    msg="${2:-backup failed}"
    psql "$HEARTBEAT_DATABASE_URL" -qAtX -v ON_ERROR_STOP=1 -v msg="${msg:0:500}" >/dev/null <<'SQL'
INSERT INTO maintenance_runs (step, last_err_at, last_error) VALUES ('backup', now(), :'msg')
ON CONFLICT (step) DO UPDATE SET last_err_at = now(), last_error = :'msg';
SQL
    echo "backup failure recorded"
    ;;
  *)
    echo "usage: $0 ok | error <message>" >&2
    exit 2
    ;;
esac
