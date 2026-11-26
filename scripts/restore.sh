#!/usr/bin/env sh
# Restore a Snagly data volume from a backup created by scripts/backup.sh.
# This REPLACES all current cloud data. Requires FORCE=1.
# Usage: FORCE=1 ./scripts/restore.sh backups/snagly-data-YYYY....tar.gz
set -eu

cd "$(dirname "$0")/.."

if [ "${FORCE:-}" != "1" ]; then
  echo "Refusing to overwrite data without FORCE=1." >&2
  exit 1
fi

ARCHIVE="$1"
if [ -z "${ARCHIVE:-}" ] || [ ! -f "$ARCHIVE" ]; then
  echo "Usage: FORCE=1 ./scripts/restore.sh backups/<archive>.tar.gz" >&2
  exit 1
fi
ARCHIVE_ABS="$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")"

start_app() {
  docker compose start snagly >/dev/null 2>&1 || true
}
trap start_app EXIT

echo "Stopping Snagly..."
docker compose stop snagly

echo "Restoring ${ARCHIVE_ABS} into volume snagly-data..."
docker run --rm \
  -v snagly-data:/data \
  -v "${ARCHIVE_ABS}:/backup/archive.tar.gz:ro" \
  alpine:3.24.4 \
  sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null || true; tar xzf /backup/archive.tar.gz -C /data'

echo "Restore complete. Starting Snagly."
