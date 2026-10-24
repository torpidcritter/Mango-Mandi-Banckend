#!/usr/bin/env bash
# Nightly logical backup of the mango database, encrypted and copied off the
# server, kept locally for RETAIN_DAYS days.
#   DATABASE_URL=... BACKUP_DIR=/backups BACKUP_GPG_PUBLIC_KEY_FILE=key.asc ./ops/backup.sh
#
# The dump holds customers' names, phones and addresses, so it is always
# encrypted to a GPG public key (only the holder of the private key, kept
# offline, can read it). With no key the script fails and writes nothing.
# BACKUP_ALLOW_PLAINTEXT=true allows an unencrypted dump, for a laptop only.
#
# Settings:
#   BACKUP_GPG_PUBLIC_KEY_FILE  an ASCII-armoured public key; imported into a
#                               throwaway keyring for this run
#   BACKUP_GPG_RECIPIENT        or: a key already in the caller's keyring
#   BACKUP_UPLOAD_CMD           copies the encrypted file off the server; run
#                               with bash, the file's path in $BACKUP_FILE
#   BACKUP_REQUIRE_UPLOAD=true  a run with no BACKUP_UPLOAD_CMD fails
#   BACKUP_HEARTBEAT=true       records the outcome in maintenance_runs (step
#                               'backup'), so the API warns when backups stop
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"

stage="starting"
gnupg_home=""
dump=""

# Writes the outcome where the API's Needs attention view and health check see
# it. Only fixed messages go in: never a URL, a key or a command line.
heartbeat() {
  [ "${BACKUP_HEARTBEAT:-}" = "true" ] || return 0
  if [ "$1" = "ok" ]; then
    psql "$DATABASE_URL" -qAtX -v ON_ERROR_STOP=1 -c \
      "INSERT INTO maintenance_runs (step, last_ok_at) VALUES ('backup', now()) ON CONFLICT (step) DO UPDATE SET last_ok_at = now()" >/dev/null
  else
    psql "$DATABASE_URL" -qAtX -v ON_ERROR_STOP=1 -v msg="$2" >/dev/null <<'SQL'
INSERT INTO maintenance_runs (step, last_err_at, last_error) VALUES ('backup', now(), :'msg')
ON CONFLICT (step) DO UPDATE SET last_err_at = now(), last_error = :'msg';
SQL
  fi
}

finish() {
  status=$?
  # Half-written files never stay behind.
  [ -n "$dump" ] && rm -f "$dump.part" "$dump.gpg.part"
  if [ -n "$gnupg_home" ]; then
    gpgconf --kill all >/dev/null 2>&1 || true
    rm -rf "$gnupg_home"
  fi
  if [ "$status" -ne 0 ]; then
    echo "backup FAILED while $stage" >&2
    heartbeat error "backup failed while $stage" || echo "could not record the failure in the database" >&2
  fi
  exit "$status"
}
trap finish EXIT

fail() { stage="$1"; echo "$2" >&2; exit 1; }

# Encryption first: never take a dump that can't be encrypted.
stage="loading the backup key"
recipient="${BACKUP_GPG_RECIPIENT:-}"
key_file="${BACKUP_GPG_PUBLIC_KEY_FILE:-}"
if [ -n "$key_file" ]; then
  [ -s "$key_file" ] || fail "loading the backup key: no public key file" "No public key at $key_file. See deploy/README.md, Backups."
  if grep -q "PRIVATE KEY BLOCK" "$key_file"; then
    fail "loading the backup key: the key file holds a PRIVATE key" \
      "$key_file holds a PRIVATE key. Put only the public key on the server; keep the private key offline."
  fi
  gnupg_home="$(mktemp -d)"
  export GNUPGHOME="$gnupg_home"
  gpg --batch --quiet --import "$key_file" 2>/dev/null || fail "loading the backup key: it is not a GPG public key" "$key_file is not a GPG public key."
  if [ -z "$recipient" ]; then
    recipient="$(gpg --batch --with-colons --list-keys | awk -F: '/^fpr/ {print $10; exit}')"
  fi
fi
if [ -z "$recipient" ] && [ "${BACKUP_ALLOW_PLAINTEXT:-}" != "true" ]; then
  fail "loading the backup key: no public key set" \
    "No backup taken: set BACKUP_GPG_PUBLIC_KEY_FILE (or BACKUP_GPG_RECIPIENT). Backups hold customers' details and are never written unencrypted."
fi
stage="dumping the database"
mkdir -p "$BACKUP_DIR"
dump="$BACKUP_DIR/mango-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --no-privileges --file="$dump.part" "$DATABASE_URL"

if [ -n "$recipient" ]; then
  stage="encrypting the dump"
  gpg --batch --yes --quiet --trust-model always --recipient "$recipient" --output "$dump.gpg.part" --encrypt "$dump.part"
  mv "$dump.gpg.part" "$dump.gpg"
  file="$dump.gpg"
else
  echo "WARNING: BACKUP_ALLOW_PLAINTEXT=true: this dump is NOT encrypted. Never use this on a server." >&2
  mv "$dump.part" "$dump"
  file="$dump"
fi

stage="deleting old backups"
find "$BACKUP_DIR" -name 'mango-*.dump*' -mtime +"$RETAIN_DAYS" -delete
echo "backup written: $file ($(du -h "$file" | cut -f1))"

if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then
  stage="copying the backup off the server"
  case "$file" in *.gpg) ;; *) fail "copying the backup off the server: refused an unencrypted file" "Refusing to upload an unencrypted dump." ;; esac
  # The command itself is not printed: it may hold a storage password.
  BACKUP_FILE="$file" timeout "${BACKUP_UPLOAD_TIMEOUT_S:-3600}" bash -c "$BACKUP_UPLOAD_CMD"
  echo "backup copied off the server"
elif [ "${BACKUP_REQUIRE_UPLOAD:-}" = "true" ]; then
  fail "copying the backup off the server: BACKUP_UPLOAD_CMD is not set" \
    "The backup is only on this server: set BACKUP_UPLOAD_CMD (see deploy/README.md, Backups)."
fi

stage="recording the backup"
heartbeat ok
stage="done"
