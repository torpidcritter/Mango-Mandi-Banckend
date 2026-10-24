#!/bin/bash
# Samples database connections and the API processes every second while a
# load test runs. Stop it (kill) when the run ends.
#
#   PGPASSWORD=... bash ops/load/sample.sh <database> <out.csv> <api pid> [more pids]
#
# Columns: unix time, connections to the database (all / active / idle /
# idle in transaction / waiting on a lock), then CPU % (of one core, over the
# last second) and RSS (MB) per pid.
# On staging (Neon), read connections from the Neon console instead: the
# pooler hides the server-side picture from pg_stat_activity.
set -u
DB=$1; OUT=$2; shift 2
HZ=$(getconf CLK_TCK)
declare -A last
header="t,conn,active,idle,idle_in_tx,lock_wait"
for p in "$@"; do header="$header,cpu_$p,rss_mb_$p"; last[$p]=$(awk '{print $14 + $15}' "/proc/$p/stat" 2>/dev/null || echo 0); done
echo "$header" > "$OUT"
while :; do
  row=$(psql -h "${PGHOST:-localhost}" -U "${PGUSER:-mango}" -d "$DB" -AtF, -c \
    "SELECT COUNT(*), COUNT(*) FILTER (WHERE state = 'active'), COUNT(*) FILTER (WHERE state = 'idle'),
            COUNT(*) FILTER (WHERE state LIKE 'idle in transaction%'), COUNT(*) FILTER (WHERE wait_event_type = 'Lock')
       FROM pg_stat_activity WHERE datname = '$DB' AND pid <> pg_backend_pid()" 2>/dev/null)
  procs=""
  for p in "$@"; do
    # From the tick counters: ps %cpu is a lifetime average.
    ticks=$(awk '{print $14 + $15}' "/proc/$p/stat" 2>/dev/null || echo 0)
    rss=$(awk '/VmRSS/ {printf "%d", $2 / 1024}' "/proc/$p/status" 2>/dev/null || echo 0)
    procs="$procs,$(( (ticks - ${last[$p]}) * 100 / HZ )),$rss"
    last[$p]=$ticks
  done
  echo "$(date +%s),$row$procs" >> "$OUT"
  sleep 1
done
