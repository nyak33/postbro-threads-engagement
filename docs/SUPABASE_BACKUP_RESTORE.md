# PostBro Supabase Free backup and restore runbook

**Boundary:** runbook only. No hosted backup, restore, SQL write, credential or Supabase Management API action was performed in this task.

## Supabase Free plan assumption

Supabase documents daily backup access for paid plans and recommends that Free tier projects regularly export data using Supabase CLI `db dump` / logical backup and maintain off-site copies. Do not assume dashboard daily backups or PITR are available for `postbro-core`; verify the Database → Backups page before relying on them. Database backups do not include Storage objects, and custom role passwords are not stored in backups.

## Backup state split

### A. Pre-first-migration baseline (no `postbro` schema exists)

Use this before the first approved hosted migration. Do **not** run `pg_dump --schema=postbro` yet; on a fresh target project the schema does not exist and the backup would be invalid or empty.

Capture a truthful baseline:

```bash
# Read-only inventory; safe to record without secrets.
psql "$DATABASE_URL" -c "SELECT version();"
psql "$DATABASE_URL" -c "SELECT nspname FROM pg_namespace ORDER BY nspname;"
psql "$DATABASE_URL" -c "SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles ORDER BY rolname;"
psql "$DATABASE_URL" -c "SELECT to_regclass('postbro.schema_migrations') AS postbro_ledger;"
```

For a brand-new dedicated project, the application rollback boundary is that `postbro` is absent. If the owner wants an export of the pre-existing platform state, use one of these after understanding scope:

- `supabase db dump` for a Supabase-aware export. This requires Supabase CLI/Docker/network access and protected credentials; document exactly what the CLI includes/excludes before relying on it.
- `pg_dump "$DATABASE_URL" --format=custom --file baseline.dump --no-owner` for a whole-database logical dump. On hosted Supabase this may include managed schemas; treat it as a baseline/reference, not a clean permission-equivalent PostBro restore.

Verify the baseline artifact before migration: file exists, is non-empty, `sha256sum` is recorded, and the inventory output proves `postbro` schema/ledger are absent.

### B. PostBro schema backups (after `postbro` exists)

Use this after the reviewed migration has been applied:

```bash
pg_dump "$DATABASE_URL" \
  --format=custom \
  --file="postbro-schema-$(date -u +%Y%m%dT%H%M%SZ).dump" \
  --schema=postbro \
  --no-owner
```

Do not use `--no-privileges` for the restorable schema backup; grants/ACLs must be preserved and then verified on restore. Record role/grant metadata separately because roles and memberships are cluster-level and passwords are never included. Use `pg_dumpall --roles-only --no-role-passwords` only where the operator is allowed to export cluster role metadata. Managed Supabase role exports may be restricted; in that case fall back to read-only inventory limited to PostBro role names and memberships (`pg_roles`, `pg_auth_members`) plus manually audited recreation statements. Do not restore Supabase-managed roles wholesale.

```bash
pg_dumpall --dbname="$DATABASE_URL" --roles-only --no-role-passwords --file="postbro-roles-$(date -u +%Y%m%dT%H%M%SZ).sql"
psql "$DATABASE_URL" -c "SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname IN ('postbro_app', 'postbro_anon', 'postbro_runtime');"
psql "$DATABASE_URL" -c "SELECT r.rolname AS member, g.rolname AS member_of FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member JOIN pg_roles g ON g.oid=m.roleid WHERE r.rolname='postbro_runtime';"
```

Store dumps outside the repository/Telegram with restricted permissions and an off-site copy. Record dump filename, SHA-256, operator, time, target project and migration file checksum.

## Disposable restore verification

The GitHub Actions PostgreSQL 17.11 rehearsal includes a disposable schema dump/restore check. For a manual disposable verification, restore into a fresh PostgreSQL 17.11 database after creating the required NOLOGIN roles if they do not already exist in that cluster:

```bash
# Roles are cluster-level and are not created by a schema-only pg_dump.
psql "$RESTORE_URL" -c "CREATE ROLE postbro_app NOLOGIN; CREATE ROLE postbro_anon NOLOGIN;"
pg_restore --dbname "$RESTORE_URL" --no-owner postbro-schema-YYYYMMDDTHHMMSSZ.dump
```

Then verify:

1. `npm run db:plan` against the disposable restore reports the reviewed migration as `applied` with matching checksum, not `pending` or `modified_after_apply`.
2. Tables, indexes, foreign keys and RLS match the readiness report.
3. Restored grants/ACLs are verified explicitly; for example `has_table_privilege('postbro_app', 'postbro.threads_accounts', 'SELECT')` is true and `postbro_anon`/public roles remain denied.
4. Runtime login and membership are recreated separately if needed, using the recorded role metadata; passwords are never restored from backup or committed.
5. Delete the disposable restore database after verification.

## Hosted rollback boundary

- Logical restore to the original hosted project is a destructive owner-approved operation with downtime; do not run it from CI.
- `DROP SCHEMA postbro CASCADE` is a destructive rollback of last resort only and requires backup verification plus owner approval.
- Supabase managed backups/PITR, if available, may restore the whole project and do not include Storage objects or custom role passwords. Record the exact gap and required password resets before using them.
