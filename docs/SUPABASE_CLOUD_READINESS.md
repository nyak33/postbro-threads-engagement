# PostBro hosted Supabase readiness plan

**Target project for future approved deployment:** `postbro-core` (`nqjlgalyjxifzisitzfa`), region `ap-southeast-1`, reported hosted PostgreSQL 17.11. This document is a plan only. No hosted migration, role creation, permission change, credential configuration, Storage change or live provider action has been performed by this task.

## Approved boundary for this PR

- Allowed now: local disposable PostgreSQL rehearsals, read-only DNS/TCP checks without credentials, documentation and deterministic configuration validation.
- Not allowed now: hosted SQL, `CREATE`, `GRANT`, `ALTER`, migration, seed, role/password creation, Supabase Management API writes, Meta/Threads actions or production deployment.

## Pre-deploy prerequisites for a later owner-approved operation

1. Owner explicitly approves the exact migration SHA and target project.
2. Owner provisions a protected migration `DATABASE_URL` and runtime credential path outside Git/Telegram.
3. Download the Supabase CA certificate from Database Settings and store it locally with restrictive permissions; set `DATABASE_SSL_MODE=verify-full` and `DATABASE_SSL_CA_PATH`. Do not put `sslmode`, `sslrootcert`, `sslcert`, `sslkey` or `ssl` in `DATABASE_URL`; the application rejects those parameters so they cannot override verified TLS.
4. Re-run read-only network checks from the Contabo VPS:
   - `python3 -c 'import socket; print(socket.getaddrinfo("db.nqjlgalyjxifzisitzfa.supabase.co", 5432, type=socket.SOCK_STREAM))'`
   - `python3 -c 'import socket; s=socket.create_connection(("db.nqjlgalyjxifzisitzfa.supabase.co", 5432), timeout=8); print(s.getpeername()); s.close()'`
   - If direct times out again, use the session-pooler fallback only by explicit approval: host from Supabase Dashboard Connect → Session pooler, port 5432, TLS verify-full. Do not use transaction pooler port 6543.
5. Run `npm run db:plan` against the approved connection and confirm only the expected migration(s) are pending; confirm no `modified_after_apply` entries.
6. Take/verify Supabase backup/PITR or a logical backup available to the owner before schema write.
7. Apply with `npm run db:migrate` using the approved migration identity. Do not use `postgres` for ordinary runtime after provisioning.
8. Provision runtime login separately, e.g. role name `postbro_runtime`, password supplied via protected channel, `GRANT postbro_app TO postbro_runtime`. No password in logs/docs/PR.
9. Run read-only post-apply audit: tables/indexes exist, RLS enabled on all foundation tables, `postbro` schema not exposed to `anon`/`authenticated`, app role has only needed grants, ledger checksums match repo files, no public schema PostBro objects.
10. Record result, CI/run link, operator, backup reference and any deviations in the deployment review.

## Rollback and failure boundaries

- Local failed migrations are transaction-rolled back and tested.
- Hosted rollback of the foundation is destructive and not automatic: `DROP SCHEMA postbro CASCADE` would remove all PostBro data. It requires separate owner approval, backup verification and downtime assessment.
- If a hosted migration fails, stop, preserve logs without secrets, verify advisory lock release, inspect `postbro.schema_migrations`, and do not retry blindly until the failed statement and partial state are understood.
- Checksum mismatch means the applied SQL differs from the repo file; do not edit applied migrations. Create a new forward migration instead.

## Local-vs-hosted gaps that remain unproven

- Hosted PostgreSQL 17.11 disposable rehearsal: **PASS via CI job `postgres-17-11-deployment-rehearsal` when that job is green.** The job uses pinned `postgres:17.11@sha256:b8faeff7712663c2773a190181e1246e37e364b887611c04658c28b44e2408fe`; local embedded PostgreSQL 17.10 remains the non-CI developer fallback.
- Supabase Auth, PostgREST/Data API exposure defaults, Storage, project settings, SSL enforcement state, backups/PITR, logs, metrics and managed role behavior.
- Real TLS handshake/CA validation and credentials-based connectivity to the hosted project.
- Actual runtime login provisioning and password rotation.
