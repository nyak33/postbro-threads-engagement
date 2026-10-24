#!/usr/bin/env bash
set -euo pipefail

IMAGE='postgres:17.11@sha256:b8faeff7712663c2773a190181e1246e37e364b887611c04658c28b44e2408fe'
BACKUP_DIR=$(mktemp -d)
trap 'rm -rf "$BACKUP_DIR"' EXIT
DOCKER=(docker run --rm --add-host=host.docker.internal:host-gateway -e PGPASSWORD=postgres -v "$BACKUP_DIR:/backup" "$IMAGE")

"${DOCKER[@]}" pg_dump --host host.docker.internal --port 5432 --username postgres --dbname postgres \
  --format=custom --file /backup/postbro-schema.dump --schema=postbro --no-owner

test -s "$BACKUP_DIR/postbro-schema.dump"

"${DOCKER[@]}" pg_restore --list /backup/postbro-schema.dump > "$BACKUP_DIR/postbro-schema.list"
grep -q 'SCHEMA - postbro' "$BACKUP_DIR/postbro-schema.list"
grep -q 'TABLE postbro threads_accounts' "$BACKUP_DIR/postbro-schema.list"
grep -q 'TABLE postbro schema_migrations' "$BACKUP_DIR/postbro-schema.list"

"${DOCKER[@]}" pg_dumpall --dbname=postgres://postgres:postgres@host.docker.internal:5432/postgres --roles-only --no-role-passwords --file /backup/postbro-roles.sql
grep -q 'postbro_app' "$BACKUP_DIR/postbro-roles.sql"
grep -q 'postbro_anon' "$BACKUP_DIR/postbro-roles.sql"
if grep -Eiq 'password|scram-sha-256|md5' "$BACKUP_DIR/postbro-roles.sql"; then
  echo 'role export unexpectedly contains password/hash material' >&2
  exit 1
fi

"${DOCKER[@]}" createdb --host host.docker.internal --port 5432 --username postgres postbro_restore_test
"${DOCKER[@]}" pg_restore --host host.docker.internal --port 5432 --username postgres --dbname postbro_restore_test \
  --no-owner /backup/postbro-schema.dump

table_count=$("${DOCKER[@]}" psql --host host.docker.internal --port 5432 --username postgres --dbname postbro_restore_test \
  --tuples-only --no-align -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'postbro';")
if [ "$table_count" -lt 14 ]; then
  echo "unexpected restored postbro table count: $table_count" >&2
  exit 1
fi

privileges=$("${DOCKER[@]}" psql --host host.docker.internal --port 5432 --username postgres --dbname postbro_restore_test \
  --tuples-only --no-align -c "SELECT has_table_privilege('postbro_app', 'postbro.threads_accounts', 'SELECT'), has_table_privilege('postbro_anon', 'postbro.threads_accounts', 'SELECT');")
test "$privileges" = 't|f'

echo "postbro schema backup/restore rehearsal passed: $(sha256sum "$BACKUP_DIR/postbro-schema.dump" | awk '{print $1}')"
