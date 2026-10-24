#!/usr/bin/env bash
# OPS-12: proves the previous release still works on the new schema.
# A deploy migrates first, so for a while (and after a rollback) the old code
# runs against the new tables. This checks out the old API, adds the new
# migration files to it, and runs the old API's own tests on that schema.
#
#   scripts/n-minus-1.sh <old-ref>      e.g. origin/main, or a PR's base commit
#   (TEST_DATABASE_URL must point at a throwaway *_test database)
set -euo pipefail
OLD_REF="${1:?usage: n-minus-1.sh <old-ref>}"
: "${TEST_DATABASE_URL:?set TEST_DATABASE_URL to a *_test database}"
ROOT="$(git rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'git -C "$ROOT" worktree remove --force "$WORK/old" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

git -C "$ROOT" worktree add --detach "$WORK/old" "$OLD_REF" >/dev/null
OLD_API="$WORK/old/mango-api"
old_count=$(ls "$OLD_API/migrations"/*.sql | wc -l)
new_count=$(ls "$ROOT/mango-api/migrations"/*.sql | wc -l)
echo "old release $(git -C "$ROOT" rev-parse --short "$OLD_REF"): $old_count migrations; new schema: $new_count"
# The new files only add to the old ones; an edited old file would be a bug of its own.
for f in "$OLD_API/migrations"/*.sql; do
  if ! cmp -s "$f" "$ROOT/mango-api/migrations/$(basename "$f")"; then
    echo "migration $(basename "$f") changed after it shipped"; exit 1
  fi
done
cp "$ROOT/mango-api/migrations"/*.sql "$OLD_API/migrations/"
cd "$OLD_API"
npm ci --silent --no-audit --no-fund
npm test
