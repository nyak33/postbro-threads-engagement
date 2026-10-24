#!/usr/bin/env bash
set -euo pipefail

IMAGE='postgres:17.11@sha256:b8faeff7712663c2773a190181e1246e37e364b887611c04658c28b44e2408fe'
BACKUP_DIR=$(mktemp -d)
trap 'rm -rf "$BACKUP_DIR"' EXIT

docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -e PGPASSWORD=postgres \
  -v "$BACKUP_DIR:/backup" \
  "$IMAGE" \
  pg_dump --host host.docker.internal --port 5432 --username postgres --dbname postgres \
    --format=custom --file /backup/postbro-prebaseline.dump --no-owner

test -s "$BACKUP_DIR/postbro-prebaseline.dump"

docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -v "$BACKUP_DIR:/backup" \
  "$IMAGE" \
  pg_restore --list /backup/postbro-prebaseline.dump > /backup/postbro-prebaseline.list

test -s "$BACKUP_DIR/postbro-prebaseline.list"
if grep -q 'postbro' "$BACKUP_DIR/postbro-prebaseline.list"; then
  echo 'unexpected postbro object in pre-first-migration baseline' >&2
  exit 1
fi

echo "pre-first-migration baseline captured: $(sha256sum "$BACKUP_DIR/postbro-prebaseline.dump" | awk '{print $1}')"
