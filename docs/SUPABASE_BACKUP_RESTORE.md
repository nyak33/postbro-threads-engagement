# PostBro Supabase Free backup and restore runbook

**Boundary:** runbook only. No hosted backup, restore, SQL write, credential or Supabase Management API action was performed in this task.

## Supabase Free plan assumption

Supabase documents daily backup access for paid plans and recommends that Free tier projects regularly export data using Supabase CLI `db dump` / logical backup and maintain off-site copies. Do not assume dashboard daily backups or PITR are available for `postbro-core`; verify the Database → Backups page before relying on them. Database backups do not include Storage objects, and custom role passwords are not stored in backups.

## Pre-deployment logical backup (owner-approved, protected credentials)

Run only after the owner approves the deployment operation and provides the migration connection through a protected channel:

```bash
# DATABASE_URL is read from the protected environment; do not echo it.
pg_dump "$DATABASE_URL" \
  --format=custom \
  --file="postbro-predeploy-$(date -u +%Y%m%dT%H%M%SZ).dump" \
  --schema=postbro \
  --no-owner \
  --no-privileges
```

Also record role/configuration metadata without passwords:

```bash
psql "$DATABASE_URL" -c "SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname IN ('postbro_app', 'postbro_anon', 'postbro_runtime');"
psql "$DATABASE_URL" -c "SELECT r.rolname AS member, g.rolname AS member_of FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member JOIN pg_roles g ON g.oid=m.roleid WHERE r.rolname='postbro_runtime';"
```

Store dumps outside the repository/Telegram with restricted permissions and an off-site copy. Record dump filename, SHA-256, operator, time, target project and migration file checksum.

## Disposable restore verification

Before trusting a backup, restore it into a disposable PostgreSQL 17.11 environment (for example the GitHub Actions `postgres:17.11` service used by CI or an owner-approved local equivalent):

```bash
createdb postbro_restore_test
pg_restore --dbname postbro_restore_test --no-owner --no-privileges postbro-predeploy-YYYYMMDDTHHMMSSZ.dump
```

Then verify:

1. `npm run db:plan` against the disposable restore reports the reviewed migration as `applied` with matching checksum, not `pending` or `modified_after_apply`.
2. Tables, indexes, foreign keys and RLS match the readiness report.
3. `postbro` schema is private; `anon`/unprivileged roles have no access.
4. Runtime login is recreated separately if needed; passwords are never restored from backup or committed.
5. Delete the disposable restore database after verification.

## Hosted rollback boundary

- Logical restore to the original hosted project is a destructive owner-approved operation with downtime; do not run it from CI.
- `DROP SCHEMA postbro CASCADE` is a destructive rollback of last resort only and requires backup verification plus owner approval.
- Supabase managed backups/PITR, if available, may restore the whole project and do not include Storage objects or custom role passwords. Record the exact gap and required password resets before using them.
