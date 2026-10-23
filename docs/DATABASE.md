# PostBro local database foundation runbook

**Scope:** PB-P0-002 local Supabase-compatible PostgreSQL foundation. This document describes the disposable local test database only. It does **not** create, connect to or verify a hosted Supabase project.

## Chosen local test approach

- Runtime: Node.js >=22 with `pg` for parameterized SQL.
- Disposable database: `embedded-postgres@17.10.0-beta.17`, which starts real PostgreSQL 17.10 binaries in a temporary data directory during `npm test`.
- Why not Supabase CLI/Docker here: the Contabo Hermes user cannot access the system Docker socket and no hosted Supabase project is approved. The test harness therefore validates PostgreSQL SQL, constraints, transactions, grants and RLS locally, while hosted Supabase Auth/PostgREST/project behavior remains **HOSTED_SUPABASE_NOT_VERIFIED**.
- npm install scripts: `package.json` explicitly allows only `@embedded-postgres/linux-x64@17.10.0-beta.17` so its PostgreSQL symlink hydration postinstall can run. This is a reviewed test dependency, not a production service.

## Commands

```bash
npm ci
npm run lint
npm run typecheck
npm run build
npm test
```

`npm test` builds TypeScript and runs all unit plus database integration tests. The database tests start a disposable PostgreSQL cluster, apply `supabase/migrations/*.sql`, create synthetic test roles, run isolation/concurrency checks and stop/delete the cluster.

To apply migrations to a separately provided disposable PostgreSQL database:

```bash
DATABASE_URL='postgres://USER:PASSWORD@HOST:5432/DB_NAME' npm run db:migrate
```

Use only a database you are authorized to reset. Do not use a hosted or populated database for this task. `DATABASE_URL` remains a secret outside disposable local tests.

## What is tested

- Versioned migration applies twice cleanly through the migration ledger.
- Account-scoped tables, foreign keys, uniqueness, checks and default UTC timestamps exist.
- Operator → account → active persona binding authorization fails closed for missing, disabled, revoked or cross-account combinations.
- RLS is enabled on foundation tables. The synthetic `postbro_anon` role has no schema/table access; the synthetic app role sees no account rows unless a transaction sets the server-side account context.
- One due job can be claimed by only one concurrent worker; stale lease tokens cannot finalize; `needs_reconciliation` is not auto-claimed.
- Approval transitions are atomic compare-and-swap; replay, expired and superseded approvals do not authorize.
- Hashed OAuth state is operator-bound, expiring and single-use.
- Duplicate engagement provider IDs are rejected within one account but isolated across accounts.
- Execution attempt action/attempt uniqueness is enforced; audit metadata rejects common secret-shaped keys.

## Deferred PRD entities

Implemented in this slice: `operators`, `oauth_sessions`, `threads_accounts`, `operator_accounts`, `personas`, `persona_versions`, `persona_bindings`, `drafts`, `publish_jobs`, `engagement_events`, `engagement_proposals`, `approvals`, `execution_attempts`, `audit_events`.

Deferred until their own scoped tasks: `posts` as separate published-post history, `edit_sessions`, `persona_observations`, `learning_candidates`, `discovery_results`, `insights_snapshots`, media/storage workflows, real OAuth token exchange/encryption, production workers and hosted Supabase verification.

## Migration failure recovery

- Test database: stop the test process; the harness uses a temporary directory and removes it after the run. Re-run `npm test` for a clean cluster.
- Manual disposable database: stop the database, delete/recreate the disposable cluster or database, then re-run `npm run db:migrate` from the clean state.
- Rollback for this foundation is destructive (`DROP SCHEMA postbro CASCADE`) and is **not** automated or approved for hosted/populated data. Any cloud migration or rollback requires separate owner approval, backup and rollback plan.

## Security notes and limitations

- The schema uses a private `postbro` schema, revoked public/default access, a least-privilege group role and RLS policies keyed by server-set transaction context. Backend authorization is still required and tested separately because Supabase server keys bypass RLS.
- Local embedded PostgreSQL does not prove hosted Supabase project region, Auth integration, PostgREST/Data API exposure defaults, Storage policies, backups, network controls or production secret handling.
- No Meta, Telegram product bot or hosted Supabase side effects are performed by these tests.
