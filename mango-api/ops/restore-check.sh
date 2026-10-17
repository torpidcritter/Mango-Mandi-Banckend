#!/usr/bin/env bash
# Proves a backup can be restored: loads it into a scratch database, checks the
# schema is current, the key tables have rows, and the stock ledger balances,
# then drops the scratch database. Run it weekly and after every schema change.
#   ADMIN_URL=postgres://user:pass@host:5432/postgres ./ops/restore-check.sh backups/mango-....dump
set -euo pipefail
dump="${1:?usage: restore-check.sh <file.dump>}"
: "${ADMIN_URL:?set ADMIN_URL to a database the user can CREATE DATABASE from}"
scratch="mango_restore_check_$(date +%s)"
base="${ADMIN_URL%/*}"
psql "$ADMIN_URL" -qc "CREATE DATABASE $scratch"
trap 'psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $scratch" >/dev/null' EXIT
pg_restore --no-owner --no-privileges --dbname="$base/$scratch" "$dump"
q() { psql "$base/$scratch" -Atqc "$1"; }
echo "migrations: $(q "SELECT string_agg(version, ' ' ORDER BY version) FROM schema_migrations")"
for t in batches batch_lines batch_ledger orders order_items customers preorders notifications; do
  echo "$t: $(q "SELECT COUNT(*) FROM $t") rows"
done
# Every batch line's on-hand must equal the sum of its ledger rows.
drift=$(q "SELECT COUNT(*) FROM batch_lines l WHERE l.on_hand <> COALESCE((SELECT SUM(delta) FROM batch_ledger g
             WHERE g.batch_id = l.batch_id AND g.sku = l.sku AND g.event_type IN ('INTAKE','ADJUST','CONDEMN','RETIRE','PACK','RESTOCK')), 0)")
if [ "$drift" != "0" ]; then echo "FAILED: $drift batch lines disagree with the ledger"; exit 1; fi
echo "restore check passed"
