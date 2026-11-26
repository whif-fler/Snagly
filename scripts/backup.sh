#!/usr/bin/env sh
# Consistent offline backup of the Snagly data volume.
# Usage: ./scripts/backup.sh
set -eu

cd "$(dirname "$0")/.."
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="snagly-data-${STAMP}.tar.gz"

mkdir -p backups

start_app() {
  docker compose start snagly >/dev/null 2>&1 || true
}
trap start_app EXIT

echo "Stopping Snagly for a consistent SQLite copy..."
docker compose stop snagly

echo "Archiving volume snagly-data -> backups/${ARCHIVE}"
docker run --rm \
  -v snagly-data:/data:ro \
  -v "${PWD}/backups:/backup" \
  alpine:3.24.4 \
  tar czf "/backup/${ARCHIVE}" -C /data .

echo "Backup written. Restarting Snagly."
