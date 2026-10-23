import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { migrateDatabase, DEFAULT_MIGRATIONS_DIR } from '../src/db/migrate';
import { startEmbeddedPostgres, type EmbeddedPostgresTestContext } from './helpers/embedded-postgres';

let pg: EmbeddedPostgresTestContext;
let tempDirs: string[];

async function makeMigrationDir(fileName: string, sql: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'postbro-migrations-'));
  tempDirs.push(dir);
  await fs.writeFile(path.join(dir, fileName), sql, 'utf8');
  return dir;
}

async function tableExists(name: string): Promise<boolean> {
  const result = await pg.ownerPool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'postbro' AND table_name = $1
     ) AS exists`,
    [name],
  );
  return result.rows[0]!.exists;
}

before(async () => {
  pg = await startEmbeddedPostgres();
  tempDirs = [];
});

after(async () => {
  await pg.stop();
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('HC-01/HC-02: migration runner uses one application ledger and verifies checksums', async () => {
  assert.equal(DEFAULT_MIGRATIONS_DIR, path.join('db', 'migrations'));

  const dir = await makeMigrationDir(
    '202610230001_hardening_test.sql',
    `CREATE TABLE postbro.hardening_checksum_test (id bigint PRIMARY KEY);`,
  );

  const applied = await migrateDatabase(pg.ownerPool, dir);
  assert.deepEqual(applied, ['202610230001_hardening_test.sql']);
  assert.equal(await tableExists('hardening_checksum_test'), true);
  assert.deepEqual(await migrateDatabase(pg.ownerPool, dir), []);

  await fs.appendFile(path.join(dir, '202610230001_hardening_test.sql'), '\n-- modified after apply\n', 'utf8');
  await assert.rejects(migrateDatabase(pg.ownerPool, dir), /checksum mismatch/i);
});

test('HC-02: concurrent migration processes are serialized by advisory lock', async () => {
  const dir = await makeMigrationDir(
    '202610230002_concurrent_test.sql',
    `CREATE TABLE postbro.hardening_concurrent_test (id bigint PRIMARY KEY);`,
  );

  const results = await Promise.all([
    migrateDatabase(pg.ownerPool, dir),
    migrateDatabase(pg.ownerPool, dir),
    migrateDatabase(pg.ownerPool, dir),
  ]);

  assert.equal(results.reduce((count, applied) => count + applied.length, 0), 1);
  const ledger = await pg.ownerPool.query<{ count: string }>(
    `SELECT count(*) FROM postbro.schema_migrations WHERE version = '202610230002_concurrent_test.sql'`,
  );
  assert.equal(Number(ledger.rows[0]!.count), 1);
  assert.equal(await tableExists('hardening_concurrent_test'), true);
});

test('HC-02: failed migration rolls back without partial table or ledger row', async () => {
  const dir = await makeMigrationDir(
    '202610230003_failure_test.sql',
    `CREATE TABLE postbro.hardening_failure_test (id bigint PRIMARY KEY);
     INSERT INTO postbro.hardening_missing_table VALUES (1);`,
  );

  await assert.rejects(migrateDatabase(pg.ownerPool, dir), /hardening_missing_table|does not exist/i);
  assert.equal(await tableExists('hardening_failure_test'), false);
  const ledger = await pg.ownerPool.query<{ count: string }>(
    `SELECT count(*) FROM postbro.schema_migrations WHERE version = '202610230003_failure_test.sql'`,
  );
  assert.equal(Number(ledger.rows[0]!.count), 0);
});

test('HC-01: Supabase CLI SQL migration directory is not used as a second authority', async () => {
  const supabaseMigrations = path.join(process.cwd(), 'supabase', 'migrations');
  const entries = await fs.readdir(supabaseMigrations, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
  assert.equal(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.sql')).length, 0);
});
