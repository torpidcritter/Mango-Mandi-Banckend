#!/usr/bin/env bash
# Restore drill for Neon: proves the database can be brought back to a point in
# time and that what comes back is usable. Run it before launch and once a
# month in season. Targets: RPO under 1 minute (Neon keeps every change for the
# history window, 7 days on Launch), RTO 1 hour (restore, check, repoint).
#
# 1. Make a branch of main as it was a few minutes ago (console: Branches →
#    Create branch → "Point in time"), or with the Neon CLI:
#      neonctl branches create --project-id <id> --name drill-$(date +%Y%m%d) \
#        --parent main --parent-timestamp "$(date -u -d '-10 min' +%FT%TZ)"
#      neonctl connection-string drill-$(date +%Y%m%d) --project-id <id>
# 2. DRILL_URL=<that connection string> ./ops/restore-drill.sh
# 3. Delete the branch afterwards (it is a full copy of customer data).
set -euo pipefail
: "${DRILL_URL:?set DRILL_URL to the connection string of the restored branch}"
start=$(date +%s)
q() { psql "$DRILL_URL" -Atqc "$1"; }
echo "belongs to: $(q "SELECT value FROM app_meta WHERE key = 'environment'")"
echo "migrations: $(q "SELECT MAX(version) FROM schema_migrations")"
echo "newest order: $(q "SELECT MAX(placed_at) FROM orders")"
for t in batches batch_lines batch_ledger orders order_items customers preorders notifications admin_users; do
  echo "$t: $(q "SELECT COUNT(*) FROM $t") rows"
done
drift=$(q "SELECT COUNT(*) FROM batch_lines l WHERE l.on_hand <> COALESCE((SELECT SUM(delta) FROM batch_ledger g
             WHERE g.batch_id = l.batch_id AND g.sku = l.sku AND g.event_type IN ('INTAKE','ADJUST','CONDEMN','RETIRE','PACK','RESTOCK')), 0)")
held=$(q "SELECT COUNT(*) FROM batch_lines l WHERE l.held <> COALESCE((SELECT SUM(quantity) FROM order_stock s WHERE s.line_id = l.id AND s.state = 'held'), 0)
             OR l.committed <> COALESCE((SELECT SUM(quantity) FROM order_stock s WHERE s.line_id = l.id AND s.state = 'committed'), 0)")
if [ "$drift" != "0" ] || [ "$held" != "0" ]; then echo "FAILED: $drift on-hand and $held held/committed lines disagree with their sources"; exit 1; fi
echo "restore drill passed in $(( $(date +%s) - start ))s; note the time it took you end to end against the 1 hour target"
