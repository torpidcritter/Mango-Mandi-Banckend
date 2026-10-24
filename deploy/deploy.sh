#!/usr/bin/env bash
# Deploys a commit on this server: ./deploy/deploy.sh [git-ref]   (default origin/main)
# Builds the images, runs the go-live checks against the real settings and
# database, and only then replaces the running containers. If the new API is
# not ready within READY_WAIT_S seconds (default 90), it deploys the previous
# commit again on its own; NO_ROLLBACK=1 turns that off.
set -euo pipefail
cd "$(dirname "$0")/.."
ref="${1:-origin/main}"

[ -f deploy/.env ] || { echo "deploy/.env is missing: cp deploy/.env.example deploy/.env and fill it in"; exit 1; }
git fetch --quiet origin
# "main" means the latest main on GitHub, not a stale local copy
git rev-parse -q --verify "origin/$ref" >/dev/null && ref="origin/$ref"
previous="$(git rev-parse --short HEAD)"
git checkout --quiet --detach "$ref"
echo "Deploying $(git rev-parse --short HEAD) (was $previous)"

cd deploy
# Made here, not by Docker, so they belong to this user (the backup key goes in backup-config).
mkdir -p backups backup-config
docker compose build --pull
docker compose up -d --wait db
echo "Go-live checks:"
docker compose run --rm --no-deps api npm run --silent preflight -- --online
docker compose up -d --remove-orphans

wait_s="${READY_WAIT_S:-90}"
for _ in $(seq 1 $(( wait_s / 2 ))); do
  # /ready answers 503 until the database answers and maintenance has run.
  if docker compose exec -T api wget -qO- http://localhost:3000/ready >/dev/null 2>&1; then
    docker image prune -f >/dev/null
    echo "Live: $(git rev-parse --short HEAD). To go back: ./deploy/deploy.sh $previous"
    exit 0
  fi
  sleep 2
done
echo "The API did not become ready in ${wait_s}s. Logs: docker compose -f deploy/compose.yml logs api"
docker compose logs --tail=50 api || true
# Go back on our own: migrations only add, so the previous code runs on the new schema.
if [ -z "${NO_ROLLBACK:-}" ] && [ "$(git rev-parse --short HEAD)" != "$previous" ]; then
  echo "Rolling back to $previous"
  cd ..
  if NO_ROLLBACK=1 ./deploy/deploy.sh "$previous"; then
    echo "Rolled back to $previous: $ref is NOT live."
  else
    echo "The rollback to $previous failed too: fix by hand."
  fi
else
  echo "To go back: ./deploy/deploy.sh $previous"
fi
exit 1
