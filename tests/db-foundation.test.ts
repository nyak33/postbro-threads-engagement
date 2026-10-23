import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { Pool } from 'pg';

import {
  approveApproval,
  claimDueJob,
  completeClaimedJob,
  consumeOauthSession,
  getAuthorizedAccount,
  markJobNeedsReconciliation,
  recordExecutionAttempt,
  rejectApproval,
  setRlsContext,
  supersedePendingApprovals,
} from '../src/db/foundation';
import { migrateDatabase } from '../src/db/migrate';
import {
  connectionStringFor,
  createLoginRole,
  startEmbeddedPostgres,
  type EmbeddedPostgresTestContext,
} from './helpers/embedded-postgres';

interface FoundationFixture {
  operatorOne: number;
  operatorTwo: number;
  operatorDisabled: number;
  accountA: number;
  accountB: number;
  accountDisabled: number;
  personaVersionA: number;
  personaVersionB: number;
}

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase', 'migrations');
const REQUIRED_TABLES = [
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

let pg: EmbeddedPostgresTestContext;
let appPool: Pool;
let anonPool: Pool;
let fixture: FoundationFixture;

async function seedFoundationFixture(): Promise<FoundationFixture> {
  const db = pg.ownerPool;
  const operatorOne = Number((await db.query<{ id: string }>(`INSERT INTO postbro.operators (telegram_user_id, status) VALUES (1001001, 'active') RETURNING id`)).rows[0]!.id);
  const operatorTwo = Number((await db.query<{ id: string }>(`INSERT INTO postbro.operators (telegram_user_id, status) VALUES (1001002, 'active') RETURNING id`)).rows[0]!.id);
  const operatorDisabled = Number((await db.query<{ id: string }>(`INSERT INTO postbro.operators (telegram_user_id, status) VALUES (1001003, 'disabled') RETURNING id`)).rows[0]!.id);

  const accountA = Number((await db.query<{ id: string }>(`INSERT INTO postbro.threads_accounts (provider_id, username, status, scopes) VALUES ('threads-a', 'account_a', 'active', ARRAY['threads_basic']) RETURNING id`)).rows[0]!.id);
  const accountB = Number((await db.query<{ id: string }>(`INSERT INTO postbro.threads_accounts (provider_id, username, status, scopes) VALUES ('threads-b', 'account_b', 'active', ARRAY['threads_basic']) RETURNING id`)).rows[0]!.id);
  const accountDisabled = Number((await db.query<{ id: string }>(`INSERT INTO postbro.threads_accounts (provider_id, username, status, scopes) VALUES ('threads-c', 'account_c', 'disabled', ARRAY['threads_basic']) RETURNING id`)).rows[0]!.id);

  await db.query(`INSERT INTO postbro.operator_accounts (operator_id, account_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner'), ($1, $5, 'owner')`, [operatorOne, accountA, operatorTwo, accountB, accountDisabled]);

  const personaA = Number((await db.query<{ id: string }>(`INSERT INTO postbro.personas (account_id, name, status) VALUES ($1, 'Persona A', 'active') RETURNING id`, [accountA])).rows[0]!.id);
  const personaB = Number((await db.query<{ id: string }>(`INSERT INTO postbro.personas (account_id, name, status) VALUES ($1, 'Persona B', 'active') RETURNING id`, [accountB])).rows[0]!.id);
  const personaVersionA = Number((await db.query<{ id: string }>(`INSERT INTO postbro.persona_versions (account_id, persona_id, version, content) VALUES ($1, $2, 1, '{"style":"a"}'::jsonb) RETURNING id`, [accountA, personaA])).rows[0]!.id);
  const personaVersionB = Number((await db.query<{ id: string }>(`INSERT INTO postbro.persona_versions (account_id, persona_id, version, content) VALUES ($1, $2, 1, '{"style":"b"}'::jsonb) RETURNING id`, [accountB, personaB])).rows[0]!.id);
  await db.query(`INSERT INTO postbro.persona_bindings (account_id, persona_version_id, status) VALUES ($1, $2, 'active')`, [accountA, personaVersionA]);

  return { operatorOne, operatorTwo, operatorDisabled, accountA, accountB, accountDisabled, personaVersionA, personaVersionB };
}

async function createDraft(accountId: number, content: string): Promise<number> {
  const result = await pg.ownerPool.query<{ id: string }>(
    `INSERT INTO postbro.drafts (account_id, content, status, version) VALUES ($1, $2, 'draft', 1) RETURNING id`,
    [accountId, content],
  );
  return Number(result.rows[0]!.id);
}

async function createPublishJob(accountId: number, actionKey: string, dueAt = new Date(Date.now() - 1000)): Promise<number> {
  const draftId = await createDraft(accountId, `draft for ${actionKey}`);
  const result = await pg.ownerPool.query<{ id: string }>(
    `INSERT INTO postbro.publish_jobs (account_id, draft_id, action_key, due_at, status)
     VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
    [accountId, draftId, actionKey, dueAt],
  );
  return Number(result.rows[0]!.id);
}

async function createPendingApproval(accountId: number, operatorId: number, actionKey: string, expiresAt = new Date(Date.now() + 60_000)): Promise<number> {
  const event = await pg.ownerPool.query<{ id: string }>(
    `INSERT INTO postbro.engagement_events (account_id, provider_reply_id, content) VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
    [accountId, `event-${actionKey}`],
  );
  const proposal = await pg.ownerPool.query<{ id: string }>(
    `INSERT INTO postbro.engagement_proposals (account_id, event_id, proposed_text, status, version) VALUES ($1, $2, 'safe reply', 'pending', 1) RETURNING id`,
    [accountId, Number(event.rows[0]!.id)],
  );
  const approval = await pg.ownerPool.query<{ id: string }>(
    `INSERT INTO postbro.approvals (account_id, operator_id, proposal_id, action_key, action_type, status, expires_at, version)
     VALUES ($1, $2, $3, $4, 'engagement_reply', 'pending', $5, 1) RETURNING id`,
    [accountId, operatorId, Number(proposal.rows[0]!.id), actionKey, expiresAt],
  );
  return Number(approval.rows[0]!.id);
}

function assertPgError(error: unknown, code: string): void {
  assert.ok(error && typeof error === 'object', 'expected a PostgreSQL error');
  assert.equal((error as { code?: string }).code, code);
}

before(async () => {
  pg = await startEmbeddedPostgres();
  await migrateDatabase(pg.ownerPool, MIGRATIONS_DIR);

  const appPassword = randomBytes(16).toString('hex');
  const anonPassword = randomBytes(16).toString('hex');
  await createLoginRole(pg.ownerPool, 'postbro_app_test', appPassword, 'postbro_app');
  await createLoginRole(pg.ownerPool, 'postbro_anon_test', anonPassword, 'postbro_anon');

  appPool = new Pool({ connectionString: connectionStringFor(pg.port, 'postbro_app_test', appPassword), max: 10 });
  anonPool = new Pool({ connectionString: connectionStringFor(pg.port, 'postbro_anon_test', anonPassword), max: 2 });
  fixture = await seedFoundationFixture();
});

after(async () => {
  if (appPool) {
    await appPool.end();
  }
  if (anonPool) {
    await anonPool.end();
  }
  if (pg) {
    await pg.stop();
  }
});

test('DB-01/DB-02: migrations are repeatable and create required RLS-enabled foundation tables', async () => {
  await migrateDatabase(pg.ownerPool, MIGRATIONS_DIR);

  const tables = await pg.ownerPool.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'postbro'`);
  const tableNames = new Set(tables.rows.map((row) => row.tablename));
  for (const table of REQUIRED_TABLES) {
    assert.ok(tableNames.has(table), `missing postbro.${table}`);
  }

  const rls = await pg.ownerPool.query<{ relname: string; relrowsecurity: boolean }>(
    `SELECT c.relname, c.relrowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'postbro' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'`,
  );
  assert.ok(rls.rows.length >= REQUIRED_TABLES.length);
  for (const row of rls.rows) {
    assert.equal(row.relrowsecurity, true, `RLS disabled on ${row.relname}`);
  }
});

test('DB-02/DB-05: schema rejects duplicate and cross-account writes while allowing isolated same external IDs', async () => {
  await assert.rejects(
    pg.ownerPool.query(`INSERT INTO postbro.threads_accounts (provider_id, username, status) VALUES ('threads-a', 'duplicate', 'active')`),
    (error: unknown) => {
      assertPgError(error, '23505');
      return true;
    },
  );

  await assert.rejects(
    pg.ownerPool.query(`INSERT INTO postbro.persona_bindings (account_id, persona_version_id, status) VALUES ($1, $2, 'active')`, [fixture.accountB, fixture.personaVersionA]),
    (error: unknown) => {
      assertPgError(error, '23503');
      return true;
    },
  );

  await pg.ownerPool.query(`INSERT INTO postbro.engagement_events (account_id, provider_reply_id, content) VALUES ($1, 'reply-shared', '{}'::jsonb)`, [fixture.accountA]);
  await assert.rejects(
    pg.ownerPool.query(`INSERT INTO postbro.engagement_events (account_id, provider_reply_id, content) VALUES ($1, 'reply-shared', '{}'::jsonb)`, [fixture.accountA]),
    (error: unknown) => {
      assertPgError(error, '23505');
      return true;
    },
  );
  await pg.ownerPool.query(`INSERT INTO postbro.engagement_events (account_id, provider_reply_id, content) VALUES ($1, 'reply-shared', '{}'::jsonb)`, [fixture.accountB]);

  const eventA = await pg.ownerPool.query<{ id: string }>(`SELECT id FROM postbro.engagement_events WHERE account_id = $1 AND provider_reply_id = 'reply-shared'`, [fixture.accountA]);
  await assert.rejects(
    pg.ownerPool.query(`INSERT INTO postbro.engagement_proposals (account_id, event_id, proposed_text, status) VALUES ($1, $2, 'cross account', 'pending')`, [fixture.accountB, Number(eventA.rows[0]!.id)]),
    (error: unknown) => {
      assertPgError(error, '23503');
      return true;
    },
  );
});

test('DB-03/DB-06: account authorization is fail-closed and RLS denies non-privileged/default access', async () => {
  const allowed = await getAuthorizedAccount(appPool, fixture.operatorOne, fixture.accountA);
  assert.equal(allowed?.id, fixture.accountA);
  assert.equal(allowed?.providerId, 'threads-a');

  assert.equal(await getAuthorizedAccount(appPool, fixture.operatorTwo, fixture.accountA), null);
  assert.equal(await getAuthorizedAccount(appPool, fixture.operatorDisabled, fixture.accountA), null);
  assert.equal(await getAuthorizedAccount(appPool, fixture.operatorOne, fixture.accountDisabled), null);
  assert.equal(await getAuthorizedAccount(appPool, fixture.operatorTwo, fixture.accountB), null, 'active account without persona binding must fail closed');

  const defaultRead = await appPool.query(`SELECT id FROM postbro.threads_accounts`);
  assert.equal(defaultRead.rowCount, 0, 'app role without SET LOCAL account context must see no account rows');

  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await setRlsContext(client, fixture.operatorOne, fixture.accountA);
    const scoped = await client.query<{ id: string }>(`SELECT id FROM postbro.threads_accounts`);
    assert.deepEqual(scoped.rows.map((row) => Number(row.id)), [fixture.accountA]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  await assert.rejects(anonPool.query(`SELECT id FROM postbro.threads_accounts`), (error: unknown) => {
    assertPgError(error, '42501');
    return true;
  });
});

test('DB-04: concurrent due-job claims produce exactly one lease and stale workers cannot finalize', async () => {
  const jobId = await createPublishJob(fixture.accountA, `publish-${randomUUID()}`);
  const claims = await Promise.all(
    Array.from({ length: 6 }, (_, index) => claimDueJob(appPool, fixture.accountA, `worker-${index}`)),
  );
  const winners = claims.filter((claim) => claim !== null);
  assert.equal(winners.length, 1);
  assert.equal(winners[0]?.id, jobId);
  assert.equal(winners[0]?.attempts, 1);

  const stale = await completeClaimedJob(appPool, fixture.accountA, jobId, randomUUID(), 'confirmed');
  assert.equal(stale, false);
  const completed = await completeClaimedJob(appPool, fixture.accountA, jobId, winners[0]!.leaseToken, 'confirmed');
  assert.equal(completed, true);
});

test('DB-04/DB-05: ambiguous publish outcome becomes needs_reconciliation and is not auto-claimed or duplicated', async () => {
  const actionKey = `ambiguous-${randomUUID()}`;
  const jobId = await createPublishJob(fixture.accountA, actionKey);
  const claim = await claimDueJob(appPool, fixture.accountA, 'worker-ambiguous');
  assert.ok(claim);
  assert.equal(claim?.id, jobId);

  assert.equal(await markJobNeedsReconciliation(appPool, fixture.accountA, jobId, randomUUID(), 'timeout'), false);
  assert.equal(await markJobNeedsReconciliation(appPool, fixture.accountA, jobId, claim!.leaseToken, 'timeout'), true);
  assert.equal(await claimDueJob(appPool, fixture.accountA, 'worker-retry'), null);

  await assert.rejects(createPublishJob(fixture.accountA, actionKey), (error: unknown) => {
    assertPgError(error, '23505');
    return true;
  });
});

test('DB-04: approval compare-and-swap allows one winner and rejects replay, expiry and stale versions', async () => {
  const approvalId = await createPendingApproval(fixture.accountA, fixture.operatorOne, `approval-${randomUUID()}`);
  const [first, second] = await Promise.all([
    approveApproval(appPool, fixture.operatorOne, fixture.accountA, approvalId),
    approveApproval(appPool, fixture.operatorOne, fixture.accountA, approvalId),
  ]);
  assert.equal([first, second].filter(Boolean).length, 1);
  assert.equal(await rejectApproval(appPool, fixture.operatorOne, fixture.accountA, approvalId), false);

  const expiredApproval = await createPendingApproval(fixture.accountA, fixture.operatorOne, `expired-${randomUUID()}`, new Date(Date.now() - 1000));
  assert.equal(await approveApproval(appPool, fixture.operatorOne, fixture.accountA, expiredApproval), false);

  const staleActionKey = `stale-${randomUUID()}`;
  const staleApproval = await createPendingApproval(fixture.accountA, fixture.operatorOne, staleActionKey);
  await supersedePendingApprovals(appPool, fixture.operatorOne, fixture.accountA, staleActionKey);
  assert.equal(await approveApproval(appPool, fixture.operatorOne, fixture.accountA, staleApproval), false);
});

test('DB-06: hashed OAuth state is operator-bound, expiring and single-use', async () => {
  const stateHash = randomBytes(32);
  const expiredHash = randomBytes(32);
  await pg.ownerPool.query(
    `INSERT INTO postbro.oauth_sessions (operator_id, state_hash, purpose, expires_at) VALUES ($1, $2, 'threads_connect', now() + interval '5 minutes'), ($1, $3, 'threads_connect', now() - interval '1 second')`,
    [fixture.operatorOne, stateHash, expiredHash],
  );

  assert.equal(await consumeOauthSession(appPool, fixture.operatorOne, stateHash), true);
  assert.equal(await consumeOauthSession(appPool, fixture.operatorOne, stateHash), false);
  assert.equal(await consumeOauthSession(appPool, fixture.operatorTwo, stateHash), false);
  assert.equal(await consumeOauthSession(appPool, fixture.operatorOne, expiredHash), false);
});

test('DB-05/DB-08: execution attempts deduplicate action attempts and audit records avoid sensitive payloads', async () => {
  const jobId = await createPublishJob(fixture.accountA, `attempt-${randomUUID()}`);
  const attempt = await recordExecutionAttempt(appPool, fixture.accountA, jobId, 'action-attempt-1', 1, 'ambiguous', { redacted: true });
  assert.ok(attempt > 0);

  await assert.rejects(
    recordExecutionAttempt(appPool, fixture.accountA, jobId, 'action-attempt-1', 1, 'ambiguous', { redacted: true }),
    (error: unknown) => {
      assertPgError(error, '23505');
      return true;
    },
  );

  const auditColumns = await pg.ownerPool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'postbro' AND table_name = 'audit_events'`,
  );
  const names = new Set(auditColumns.rows.map((row) => row.column_name));
  for (const forbidden of ['token', 'access_token', 'refresh_token', 'secret', 'password', 'private_key']) {
    assert.equal(names.has(forbidden), false, `audit_events must not contain ${forbidden}`);
  }
});
