# PostBro local database foundation and hosted-readiness runbook

**Scope:** PB-P0-002 local Supabase-compatible PostgreSQL foundation plus PB-P0-002H hosted-readiness hardening. This document does **not** create, connect to with credentials, migrate or modify the hosted Supabase project.

## Single migration authority

- Chosen authority: the PostBro application migration runner in `src/db/migrate.ts` and ledger table `postbro.schema_migrations`.
- Migration files live in `db/migrations/*.sql`, sorted by filename. The current foundation migration is `db/migrations/202610230001_database_foundation.sql`.
- `supabase/migrations` is intentionally not used for PostBro schema. Do not run `supabase db push` for PostBro tables; Supabase CLI uses a separate `supabase_migrations.schema_migrations` ledger and would not share history with the application runner.
- Each applied migration records a SHA-256 checksum. Re-running the same file is a no-op; editing an already-applied file fails with a checksum mismatch instead of silently succeeding.
- Migration execution holds PostgreSQL advisory lock `72742002`, checks/applies the ledger transactionally and rolls back a failed migration without a partial table or ledger row. Forward-only, transaction-unsafe or destructive statements are rejected by the runner.
- Pre-apply dry run for an explicitly provided disposable database: `DATABASE_URL='postgres://USER:***@HOST:5432/DB_NAME' npm run db:plan`. Apply only after approval: `npm run db:migrate`.

## Chosen local test approach

- Runtime: Node.js >=22 with `pg` for parameterized SQL.
- Disposable database: `embedded-postgres@17.10.0-beta.17`, which starts real PostgreSQL 17.10 binaries in a temporary data directory during `npm test`.
- Version gap: hosted `postbro-core` was reported as PostgreSQL 17.11. The pinned embedded package available on npm provides 17.10, not 17.11; this is documented as a local-vs-hosted rehearsal gap, not a claim of hosted compatibility.
- Why not Supabase CLI/Docker here: the Contabo Hermes user cannot access the system Docker socket and no hosted Supabase mutation is approved. Tests validate PostgreSQL SQL, constraints, transactions, grants and RLS locally, while hosted Supabase Auth/PostgREST/project behavior remains **HOSTED_SUPABASE_NOT_VERIFIED**.
- npm install scripts: `package.json` explicitly allows only `@embedded-postgres/linux-x64@17.10.0-beta.17` so its PostgreSQL symlink hydration postinstall can run. This is a reviewed test dependency, not a production service.

## Commands

```bash
npm ci
npm run lint
npm run typecheck
npm run build
npm test
```

`npm test` builds TypeScript and runs all unit plus database integration tests. The database tests start a disposable PostgreSQL cluster, apply `db/migrations/*.sql`, create synthetic test roles, run isolation/concurrency/checksum/crash-recovery checks and stop/delete the cluster.

To inspect or apply migrations to a separately provided disposable PostgreSQL database:

```bash
DATABASE_URL='postgres://USER:***@HOST:5432/DB_NAME' npm run db:plan
DATABASE_URL='postgres://USER:***@HOST:5432/DB_NAME' npm run db:migrate
```

Use only a database you are authorized to reset. Do not use a hosted or populated database for this task. `DATABASE_URL` remains a secret outside disposable local tests.

## Runtime identity and account isolation

- Migration creates group roles `postbro_app` and `postbro_anon` as `NOLOGIN`; it does not create or store a production runtime password.
- Future approved cloud provisioning should create a dedicated login such as `postbro_runtime` with a strong password supplied through a protected channel, then `GRANT postbro_app TO postbro_runtime`. The application must not run ordinary account queries as `postgres`, an owner role, Supabase `service_role` or any bypass-RLS identity.
- Server code sets transaction-scoped `postbro.operator_id` and `postbro.account_id` from trusted server-side authorization results, then commits/releases the pooled connection. Caller-supplied account IDs are not trusted.
- Local tests prove a member login inherits least-privilege access, cannot `SET ROLE postgres`, cannot create schema objects, is denied cross-account access and sees zero account rows without the transaction context.
- `postbro` remains a private schema. Do not grant it to Supabase `anon`, `authenticated` or expose it through the Data API.

## TLS and network strategy

- Configuration supports `DATABASE_SSL_MODE=disable|require|verify-ca|verify-full` and `DATABASE_SSL_CA_PATH`, but non-local hosted PostgreSQL connections are policy-limited to `verify-full`; `disable`, `require` and `verify-ca` are rejected outside localhost. Local disposable PostgreSQL uses `disable`. The code rejects `ssl*` URL parameters and builds sanitized host/user/password connection fields instead of passing a connection string alongside TLS settings, so URL parameters cannot override verification. It never sets `rejectUnauthorized:false`.
- Port 6543 transaction pooler URLs are rejected for PostBro migration/runtime configuration. Use direct port 5432 when verified, otherwise Supavisor session pooler port 5432.
- Read-only VPS network check on 2026-10-23:
  - `db.nqjlgalyjxifzisitzfa.supabase.co` resolved to IPv6 `2406:da18:1248:be00::6aa6`; the VPS has an IPv6 default route, but a no-auth TCP connect to direct port 5432 timed out.
  - `aws-0-ap-southeast-1.pooler.supabase.com` resolved to IPv4 and no-auth TCP connect to session port 5432 succeeded; transaction port 6543 also connected but is not used by this design.
- Strategy until a later owner-run check proves direct connectivity: persistent application traffic uses Supavisor **session pooler port 5432** with TLS `verify-full` and the downloaded Supabase CA. Migrations prefer direct connection only after direct TCP/TLS is verified; if direct remains unavailable, the owner must explicitly approve a session-pooler migration fallback. Never use transaction pooler for migrations or session-sensitive operations.

## What is tested

- Versioned migration applies twice cleanly through the checksummed migration ledger.
- Concurrent migration runners are serialized by advisory lock; only one applies the migration.
- A failing migration rolls back with no partial table or ledger row; modified applied SQL fails checksum validation.
- Account-scoped tables, foreign keys, uniqueness, checks and default UTC timestamps exist.
- Operator → account → active persona binding authorization fails closed for missing, disabled, revoked or cross-account combinations.
- RLS is enabled on foundation tables. The synthetic `postbro_anon` role has no schema/table access; the synthetic app role sees no account rows unless a transaction sets the server-side account context.
- One due job can be claimed by only one concurrent worker; stale lease tokens cannot finalize; expired claimed jobs with no persisted provider attempt may be reclaimed with a new lease, while expired jobs with any persisted provider attempt are moved to `needs_reconciliation` instead of being blindly resent.
- Approval transitions are atomic compare-and-swap and re-check operator/account/binding plus the still-current proposal or draft version in the same transaction; replay, expired, stale-source and superseded approvals do not authorize.
- Hashed OAuth state is operator-bound, expiring and single-use.
- Duplicate engagement provider IDs are rejected within one account but isolated across accounts.
- Execution attempt action/attempt uniqueness is enforced; provider request/response metadata, job error reasons and audit reason/metadata are recursively redacted before persistence.
- TLS configuration rejects transaction-pooler port 6543, insecure non-local SSL modes and `ssl*` URL parameters; hosted connections require `verify-full` plus a CA file and use verified TLS fields without `rejectUnauthorized:false`.

## Deferred PRD entities

Implemented in this slice: `operators`, `oauth_sessions`, `threads_accounts`, `operator_accounts`, `personas`, `persona_versions`, `persona_bindings`, `drafts`, `publish_jobs`, `engagement_events`, `engagement_proposals`, `approvals`, `execution_attempts`, `audit_events`.

Deferred until their own scoped tasks: `posts` as separate published-post history, `edit_sessions`, `persona_observations`, `learning_candidates`, `discovery_results`, `insights_snapshots`, media/storage workflows, real OAuth token exchange/encryption, production workers and hosted Supabase verification. Current approvals are intentionally limited to a linked engagement proposal or draft so orphaned authorization rows are rejected; future action types need a reviewed schema amendment.

## Migration failure recovery

- Test database: stop the test process; the harness uses a temporary directory and removes it after the run. Re-run `npm test` for a clean cluster.
- Manual disposable database: stop the database, delete/recreate the disposable cluster or database, then re-run `npm run db:migrate` from the clean state.
- Rollback for this foundation is destructive (`DROP SCHEMA postbro CASCADE`) and is **not** automated or approved for hosted/populated data. Any cloud migration or rollback requires separate owner approval, backup and rollback plan.

## Security notes and limitations

- The schema uses a private `postbro` schema, revoked public/default access, a least-privilege group role and RLS policies keyed by server-set transaction context. Backend authorization is still required and tested separately because Supabase server keys bypass RLS.
- Local embedded PostgreSQL does not prove hosted Supabase project region, Auth integration, PostgREST/Data API exposure defaults, Storage policies, backups, network controls or production secret handling.
- No Meta, Telegram product bot or hosted Supabase side effects are performed by these tests.
