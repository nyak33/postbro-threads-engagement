import { promises as fs } from 'node:fs';
import path from 'node:path';

import { type Pool } from 'pg';

async function ensureMigrationLedger(db: Pool): Promise<void> {
  await db.query('CREATE SCHEMA IF NOT EXISTS postbro');
  await db.query(`
    CREATE TABLE IF NOT EXISTS postbro.schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function migrateDatabase(db: Pool, migrationsDir: string): Promise<string[]> {
  await ensureMigrationLedger(db);
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const applied: string[] = [];

  for (const file of files) {
    const existing = await db.query('SELECT 1 FROM postbro.schema_migrations WHERE version = $1', [file]);
    if (existing.rowCount === 1) {
      continue;
    }

    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO postbro.schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (error) {
      await client.query('ROLLBACK');
      const message = error instanceof Error ? error.message : 'unknown database error';
      throw new Error(`Migration ${file} failed: ${message}`);
    } finally {
      client.release();
    }
  }

  return applied;
}
