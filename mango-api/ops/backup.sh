#!/usr/bin/env bash
# Nightly logical backup of the mango database, kept for RETAIN_DAYS days.
# Run from cron or a scheduled job:  DATABASE_URL=... BACKUP_DIR=/backups ./ops/backup.sh
# Copy BACKUP_DIR off the database host (object storage) as well: a backup on
# the same disk as the database is not a backup.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/mango-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --no-privileges --file="$file.part" "$DATABASE_URL"
mv "$file.part" "$file"
find "$BACKUP_DIR" -name 'mango-*.dump' -mtime +"$RETAIN_DAYS" -delete
echo "backup written: $file ($(du -h "$file" | cut -f1))"
