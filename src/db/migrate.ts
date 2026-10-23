import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { type Pool, type PoolClient } from 'pg';

export const DEFAULT_MIGRATIONS_DIR = path.join('db', 'migrations');
export const MIGRATION_ADVISORY_LOCK_KEY = 72742002;

interface MigrationLedgerRow {
  checksum: string | null;
}

export interface MigrationPlanEntry {
  version: string;
  checksum: string;
  status: 'pending' | 'applied' | 'modified_after_apply';
}

function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

function assertMigrationIsForwardOnlyAndTransactional(version: string, sql: string): void {
  const forbidden: Array<[RegExp, string]> = [
    [/\bCREATE\s+INDEX\s+CONCURRENTLY\b/i, 'CREATE INDEX CONCURRENTLY is not transaction-safe'],
    [/\bDROP\s+(TABLE|SCHEMA|DATABASE|ROLE)\b/i, 'destructive DROP statements are not allowed in forward migrations'],
    [/\bTRUNCATE\b/i, 'TRUNCATE is not allowed in forward migrations'],
    [/\bALTER\s+TYPE\s+\S+\s+ADD\s+VALUE\b/i, 'ALTER TYPE ADD VALUE requires separate transactional handling'],
    [/\b(VACUUM|CLUSTER|REINDEX|REFRESH\s+MATERIALIZED\s+VIEW)\b/i, 'statement cannot run inside the migration transaction'],
  ];

  for (const [pattern, reason] of forbidden) {
    if (pattern.test(sql)) {
      throw new Error(`Migration ${version} is not allowed: ${reason}`);
    }
  }
}

async function ensureMigrationLedger(client: PoolClient): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS postbro');
  await client.query(`
    CREATE TABLE IF NOT EXISTS postbro.schema_migrations (
      version text PRIMARY KEY,
      checksum text,
      applied_by text NOT NULL DEFAULT 'postbro-migrate',
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query('ALTER TABLE postbro.schema_migrations ADD COLUMN IF NOT EXISTS checksum text');
  await client.query(`ALTER TABLE postbro.schema_migrations ADD COLUMN IF NOT EXISTS applied_by text NOT NULL DEFAULT 'postbro-migrate'`);
}

async function readMigrationFiles(migrationsDir: string): Promise<Array<{ version: string; sql: string; checksum: string }>> {
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const migrations: Array<{ version: string; sql: string; checksum: string }> = [];
  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    assertMigrationIsForwardOnlyAndTransactional(file, sql);
    migrations.push({ version: file, sql, checksum: migrationChecksum(sql) });
  }
  return migrations;
}

async function ledgerEntry(client: PoolClient, version: string): Promise<MigrationLedgerRow | null> {
  const result = await client.query<MigrationLedgerRow>(
    'SELECT checksum FROM postbro.schema_migrations WHERE version = $1',
    [version],
  );
  return result.rows[0] ?? null;
}

export async function planMigrations(db: Pool, migrationsDir: string = DEFAULT_MIGRATIONS_DIR): Promise<MigrationPlanEntry[]> {
  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);
    await ensureMigrationLedger(client);
    const migrations = await readMigrationFiles(migrationsDir);
    const plan: MigrationPlanEntry[] = [];
    for (const migration of migrations) {
      const existing = await ledgerEntry(client, migration.version);
      if (!existing) {
        plan.push({ version: migration.version, checksum: migration.checksum, status: 'pending' });
      } else if (!existing.checksum) {
        throw new Error(`Migration ${migration.version} has a legacy ledger row without checksum; rebuild the disposable DB or reconcile the ledger manually`);
      } else if (existing.checksum !== migration.checksum) {
        plan.push({ version: migration.version, checksum: migration.checksum, status: 'modified_after_apply' });
      } else {
        plan.push({ version: migration.version, checksum: migration.checksum, status: 'applied' });
      }
    }
    return plan;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

export async function migrateDatabase(db: Pool, migrationsDir: string = DEFAULT_MIGRATIONS_DIR): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);
    await ensureMigrationLedger(client);
    const migrations = await readMigrationFiles(migrationsDir);

    for (const migration of migrations) {
      const existing = await ledgerEntry(client, migration.version);
      if (existing) {
        if (!existing.checksum) {
          throw new Error(`Migration ${migration.version} has a legacy ledger row without checksum; rebuild the disposable DB or reconcile the ledger manually`);
        }
        if (existing.checksum !== migration.checksum) {
          throw new Error(`Migration checksum mismatch for ${migration.version}; do not edit applied migrations`);
        }
        continue;
      }

      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO postbro.schema_migrations (version, checksum, applied_by) VALUES ($1, $2, $3)',
          [migration.version, migration.checksum, 'postbro-migrate'],
        );
        await client.query('COMMIT');
        applied.push(migration.version);
      } catch (error) {
        await client.query('ROLLBACK');
        const message = error instanceof Error ? error.message : 'unknown database error';
        throw new Error(`Migration ${migration.version} failed: ${message}`);
      }
    }

    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
