#!/usr/bin/env bash
# Deploys a commit on this server: ./deploy/deploy.sh [git-ref]   (default origin/main)
# Builds the images, runs the go-live checks against the real settings and
# database, and only then replaces the running containers.
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
docker compose build --pull
docker compose up -d --wait db
echo "Go-live checks:"
docker compose run --rm --no-deps api npm run --silent preflight -- --online
docker compose up -d --remove-orphans

for _ in $(seq 1 30); do
  if docker compose exec -T api wget -qO- http://localhost:3000/ready >/dev/null 2>&1; then
    docker image prune -f >/dev/null
    echo "Live: $(git rev-parse --short HEAD). To go back: ./deploy/deploy.sh $previous"
    exit 0
  fi
  sleep 2
done
echo "The API did not become ready. Logs: docker compose -f deploy/compose.yml logs api"
echo "To go back: ./deploy/deploy.sh $previous"
exit 1
