import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import { getAuthorizedAccount } from '../src/db/foundation';
import { DEFAULT_MIGRATIONS_DIR, migrateDatabase } from '../src/db/migrate';

const REHEARSAL_URL = process.env.POSTGRES_17_11_URL;
const test17 = REHEARSAL_URL ? test : test.skip;
const MIGRATION_FILE = '202610230001_database_foundation.sql';
const REQUIRED_TABLES = [
  'schema_migrations',
  'operators',
  'oauth_sessions',
  'threads_accounts',
  'operator_accounts',
  'personas',
  'persona_versions',
  'persona_bindings',
  'drafts',
  'publish_jobs',
  'engagement_events',
  'engagement_proposals',
  'approvals',
  'execution_attempts',
  'audit_events',
];
const REQUIRED_INDEXES = [
  'oauth_sessions_operator_expiry',
  'publish_jobs_due_pending',
  'approvals_one_pending_per_action',
  'audit_events_account_time',
];

function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

function rehearsalUrlForDatabase(database: string, role?: string, password?: string): string {
  const url = new URL(REHEARSAL_URL!);
  url.pathname = `/${database}`;
  if (role !== undefined) {
    url.username = encodeURIComponent(role);
  }
  if (password !== undefined) {
    url.password = encodeURIComponent(password);
  }
  return url.toString();
}

async function createRuntimeRole(owner: Pool, database: string): Promise<Pool> {
  const role = 'postbro_runtime_test';
  const password = randomBytes(16).toString('hex');
  const generated = await owner.query<{ sql: string }>(
    `SELECT format('DROP ROLE IF EXISTS %I; CREATE ROLE %I LOGIN PASSWORD %L; GRANT postbro_app TO %I;', $1::text, $1::text, $2::text, $1::text) AS sql`,
    [role, password],
  );
  await owner.query(generated.rows[0]!.sql);
  return new Pool({ connectionString: rehearsalUrlForDatabase(database, role, password), max: 4 });
}

async function verifyFoundationShape(pool: Pool): Promise<void> {
  const version = await pool.query<{ version: string }>('SELECT version() AS version');
  assert.ok(version.rows[0]!.version.includes('PostgreSQL 17.11'), version.rows[0]!.version);

  const tables = await pool.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'postbro'`);
  const tableNames = new Set(tables.rows.map((row) => row.tablename));
  for (const table of REQUIRED_TABLES) {
    assert.ok(tableNames.has(table), `missing postbro.${table}`);
  }

  const indexes = await pool.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname = 'postbro'`);
  const indexNames = new Set(indexes.rows.map((row) => row.indexname));
  for (const index of REQUIRED_INDEXES) {
    assert.ok(indexNames.has(index), `missing index ${index}`);
  }

  const foreignKeys = await pool.query<{ count: string }>(
    `SELECT count(*) FROM information_schema.table_constraints WHERE constraint_schema = 'postbro' AND constraint_type = 'FOREIGN KEY'`,
  );
  assert.ok(Number(foreignKeys.rows[0]!.count) >= 10, 'expected foundation foreign keys');

  const rls = await pool.query<{ relname: string; relrowsecurity: boolean }>(
    `SELECT c.relname, c.relrowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'postbro' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'`,
  );
  assert.ok(rls.rows.length >= REQUIRED_TABLES.length - 1);
  for (const row of rls.rows) {
    assert.equal(row.relrowsecurity, true, `RLS disabled on ${row.relname}`);
  }

  const grants = await pool.query<{ anon_schema: boolean; anon_table: boolean; app_schema: boolean }>(
    `SELECT
       has_schema_privilege('postbro_anon', 'postbro', 'USAGE') AS anon_schema,
       has_table_privilege('postbro_anon', 'postbro.threads_accounts', 'SELECT') AS anon_table,
       has_schema_privilege('postbro_app', 'postbro', 'USAGE') AS app_schema`,
  );
  assert.equal(grants.rows[0]!.anon_schema, false);
  assert.equal(grants.rows[0]!.anon_table, false);
  assert.equal(grants.rows[0]!.app_schema, true);
}

async function verifyChecksum(pool: Pool): Promise<void> {
  const sql = await fs.readFile(path.join(process.cwd(), DEFAULT_MIGRATIONS_DIR, MIGRATION_FILE), 'utf8');
  const checksum = migrationChecksum(sql);
  const ledger = await pool.query<{ checksum: string }>(
    'SELECT checksum FROM postbro.schema_migrations WHERE version = $1',
    [MIGRATION_FILE],
  );
  assert.equal(ledger.rows[0]!.checksum, checksum);
}

async function verifyConcurrentMigration(pool: Pool): Promise<void> {
  await pool.query('DROP DATABASE IF EXISTS postbro_rehearsal_concurrent');
  await pool.query('CREATE DATABASE postbro_rehearsal_concurrent');
  const concurrentPool = new Pool({ connectionString: rehearsalUrlForDatabase('postbro_rehearsal_concurrent'), max: 4 });
  try {
    const results = await Promise.all([
      migrateDatabase(concurrentPool, DEFAULT_MIGRATIONS_DIR),
      migrateDatabase(concurrentPool, DEFAULT_MIGRATIONS_DIR),
      migrateDatabase(concurrentPool, DEFAULT_MIGRATIONS_DIR),
    ]);
    assert.equal(results.reduce((count, applied) => count + applied.length, 0), 1);
    const ledger = await concurrentPool.query<{ count: string }>(
      'SELECT count(*) FROM postbro.schema_migrations WHERE version = $1',
      [MIGRATION_FILE],
    );
    assert.equal(Number(ledger.rows[0]!.count), 1);
  } finally {
    await concurrentPool.end();
    await pool.query('DROP DATABASE IF EXISTS postbro_rehearsal_concurrent');
  }
}

async function verifyFailureRollback(pool: Pool): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'postbro-pg17-failure-'));
  try {
    await fs.writeFile(
      path.join(dir, '20990101000000_pg17_failure.sql'),
      `CREATE TABLE postbro.pg17_failure_partial (id bigint PRIMARY KEY);
       INSERT INTO postbro.pg17_failure_missing VALUES (1);`,
      'utf8',
    );
    await assert.rejects(migrateDatabase(pool, dir), /pg17_failure_missing|does not exist/i);
    const partial = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'postbro' AND table_name = 'pg17_failure_partial'
       ) AS exists`,
    );
    assert.equal(partial.rows[0]!.exists, false);
    const ledger = await pool.query<{ count: string }>(
      `SELECT count(*) FROM postbro.schema_migrations WHERE version = '20990101000000_pg17_failure.sql'`,
    );
    assert.equal(Number(ledger.rows[0]!.count), 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function verifyRuntimeIsolation(pool: Pool): Promise<void> {
  const operatorOne = Number((await pool.query<{ id: string }>(`INSERT INTO postbro.operators (telegram_user_id, status) VALUES (17011, 'active') RETURNING id`)).rows[0]!.id);
  const operatorTwo = Number((await pool.query<{ id: string }>(`INSERT INTO postbro.operators (telegram_user_id, status) VALUES (17012, 'active') RETURNING id`)).rows[0]!.id);
  const accountA = Number((await pool.query<{ id: string }>(`INSERT INTO postbro.threads_accounts (provider_id, username, status, scopes) VALUES ('pg17-a', 'pg17_a', 'active', ARRAY['threads_basic']) RETURNING id`)).rows[0]!.id);
  const accountB = Number((await pool.query<{ id: string }>(`INSERT INTO postbro.threads_accounts (provider_id, username, status, scopes) VALUES ('pg17-b', 'pg17_b', 'active', ARRAY['threads_basic']) RETURNING id`)).rows[0]!.id);
  await pool.query(`INSERT INTO postbro.operator_accounts (operator_id, account_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`, [operatorOne, accountA, operatorTwo, accountB]);
  const personaA = Number((await pool.query<{ id: string }>(`INSERT INTO postbro.personas (account_id, name, status) VALUES ($1, 'PG17 A', 'active') RETURNING id`, [accountA])).rows[0]!.id);
  const personaB = Number((await pool.query<{ id: string }>(`INSERT INTO postbro.personas (account_id, name, status) VALUES ($1, 'PG17 B', 'active') RETURNING id`, [accountB])).rows[0]!.id);
  const versionA = Number((await pool.query<{ id: string }>(`INSERT INTO postbro.persona_versions (account_id, persona_id, version, content) VALUES ($1, $2, 1, '{}'::jsonb) RETURNING id`, [accountA, personaA])).rows[0]!.id);
  const versionB = Number((await pool.query<{ id: string }>(`INSERT INTO postbro.persona_versions (account_id, persona_id, version, content) VALUES ($1, $2, 1, '{}'::jsonb) RETURNING id`, [accountB, personaB])).rows[0]!.id);
  await pool.query(`INSERT INTO postbro.persona_bindings (account_id, persona_version_id, status) VALUES ($1, $2, 'active'), ($3, $4, 'active')`, [accountA, versionA, accountB, versionB]);

  const runtimePool = await createRuntimeRole(pool, 'postgres');
  try {
    const current = await runtimePool.query<{ current_user: string }>('SELECT current_user');
    assert.equal(current.rows[0]!.current_user, 'postbro_runtime_test');
    await assert.rejects(runtimePool.query('SET ROLE postgres'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, '42501');
      return true;
    });
    const unscoped = await runtimePool.query('SELECT id FROM postbro.threads_accounts');
    assert.equal(unscoped.rowCount, 0);

    const allowed = await getAuthorizedAccount(runtimePool, operatorOne, accountA);
    assert.equal(allowed?.id, accountA);
    assert.equal(await getAuthorizedAccount(runtimePool, operatorOne, accountB), null);
    assert.equal(await getAuthorizedAccount(runtimePool, operatorTwo, accountA), null);
  } finally {
    await runtimePool.end();
  }
}

test17('PostgreSQL 17.11 disposable deployment rehearsal', async () => {
  const pool = new Pool({ connectionString: REHEARSAL_URL, max: 6 });
  try {
    const applied = await migrateDatabase(pool, DEFAULT_MIGRATIONS_DIR);
    assert.deepEqual(applied, [MIGRATION_FILE]);
    assert.deepEqual(await migrateDatabase(pool, DEFAULT_MIGRATIONS_DIR), []);

    await verifyFoundationShape(pool);
    await verifyChecksum(pool);
    await verifyConcurrentMigration(pool);
    await verifyFailureRollback(pool);
    await verifyRuntimeIsolation(pool);
  } finally {
    await pool.end();
  }
});
