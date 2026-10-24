# Supabase CLI boundary

PostBro does **not** use Supabase CLI migration history for the application schema.

- PostBro application migrations live in `db/migrations/` and are applied only by `src/db/migrate.ts` into ledger `postbro.schema_migrations`.
- Do not add PostBro schema SQL under `supabase/migrations/` and do not run `supabase db push` for PostBro tables.
- Supabase CLI may be considered later only for Supabase-managed/local-development concerns in a separately reviewed task; it must not manage `postbro` schema objects or replay `db/migrations`.

This boundary prevents duplicate migration-history authorities (`postbro.schema_migrations` vs `supabase_migrations.schema_migrations`) from diverging before any hosted database write is approved.
