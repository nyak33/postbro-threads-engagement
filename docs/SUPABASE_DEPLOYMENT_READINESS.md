# PostBro Supabase deployment readiness report

**Target project:** `postbro-core` (`nqjlgalyjxifzisitzfa`), region `ap-southeast-1`, hosted PostgreSQL reported as 17.11.
**Reviewed migration:** `db/migrations/202610230001_database_foundation.sql`
**Migration SHA-256:** `a371429aa837cd31a907c56df98ef429c0a2bf23432e99ee0fd4f73ea741c8a0`
**PostgreSQL 17.11 rehearsal image:** `postgres:17.11@sha256:b8faeff7712663c2773a190181e1246e37e364b887611c04658c28b44e2408fe`

## Gate results

| Gate | Status | Evidence / boundary |
|---|---|---|
| Single migration-history authority | PASS | PostBro app runner + `postbro.schema_migrations`; SQL lives in `db/migrations`; `supabase/migrations` contains no PostBro SQL. |
| Migration locking, checksum, repeat execution | PASS | Advisory lock, SHA-256 ledger checksum and no-op repeat are tested locally and in the PostgreSQL 17.11 rehearsal. |
| Actual migration against PostgreSQL 17.11 | PASS when CI job `postgres-17-11-deployment-rehearsal` is green | GitHub Actions service uses the pinned PostgreSQL 17.11 image above; test asserts `SELECT version()` contains PostgreSQL 17.11 before migrating. |
| Tables, indexes, FKs, RLS and role permissions | PASS when CI job is green | Rehearsal verifies required tables/indexes/foreign keys, RLS enabled, `postbro_anon` denied and `postbro_app` least privilege. |
| Concurrent migrations on PostgreSQL 17.11 | PASS when CI job is green | Three concurrent runners against a fresh disposable database apply the migration exactly once. |
| Failure rollback / crash safety | PASS when CI job is green | Bad rehearsal migration rolls back with no partial table or ledger row. |
| Cross-account access denial | PASS when CI job is green | Runtime role cannot see unscoped rows and cannot access another operator/account. |
| Read-only `db:plan` | PASS | Virgin and initialized disposable DBs are unchanged by planning. |
| TLS configuration | PASS for deterministic config; NOT_RUN for hosted handshake | Non-local connections require `verify-full` + CA; URL `ssl*` overrides are rejected. Real Supabase CA handshake waits for approved credentials. |
| Direct IPv6 connectivity from Contabo | FAIL / NOT_READY | DNS resolves to IPv6, but no-auth TCP connect to direct port 5432 timed out on 2026-10-23. Do not rely on direct until re-tested successfully. |
| Supavisor session pooler connectivity | PASS for read-only TCP | Regional session pooler IPv4 port 5432 connected without credentials. Use session pooler for runtime until direct is proven; never use transaction pooler 6543. |
| Backup/restore runbook | PASS for documented split + disposable CI rehearsal | `docs/SUPABASE_BACKUP_RESTORE.md`; CI captures pre-first-migration baseline and verifies PostBro schema dump/restore in disposable PostgreSQL 17.11; actual hosted backup/restore NOT_RUN. |
| Pre-hosted-migration backup verified on target | NOT_RUN | Must be performed immediately before the owner-approved hosted migration using the split baseline procedure; target currently has no `postbro` schema. |
| Role/grant/ACL restoration | PASS for disposable CI verification; NOT_RUN hosted | CI restores schema with preserved ACLs after roles exist and exports role metadata with `pg_dumpall --dbname=... --roles-only --no-role-passwords`; managed Supabase role export restrictions require read-only PostBro-role inventory fallback and manual audited recreation. |
| Hosted Supabase migration / role creation / permission change | NOT_RUN | Strictly deferred to a separate owner-approved deployment operation. |

## Deployment readiness decision

**READY_FOR_OWNER_REVIEW, NOT GO FOR HOSTED WRITE.** The disposable PostgreSQL 17.11 rehearsal proves the reviewed migration and safety gates in CI, and the backup runbook now separates pre-first-migration baseline capture from PostBro schema backups with disposable restore verification. Before any hosted schema write, the owner must still approve the exact commit/migration checksum, provision protected credentials, select session-pooler or re-proven direct connectivity, verify TLS CA, take the correct baseline/schema backup for the current target state and agree on rollback/downtime.
