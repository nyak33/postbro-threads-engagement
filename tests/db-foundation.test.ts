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
  recordAuditEvent,
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

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');
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

test('HC-03: least-privilege runtime role cannot escalate and postbro stays private', async () => {
  const current = await appPool.query<{ current_user: string }>(`SELECT current_user`);
  assert.equal(current.rows[0]!.current_user, 'postbro_app_test');

  await assert.rejects(appPool.query(`SET ROLE postgres`), (error: unknown) => {
    assertPgError(error, '42501');
    return true;
  });
  await assert.rejects(appPool.query(`CREATE TABLE postbro.runtime_escalation_test (id bigint)`), (error: unknown) => {
    assertPgError(error, '42501');
    return true;
  });

  const privileges = await pg.ownerPool.query<{ schema_usage: boolean; table_select: boolean }>(
    `SELECT
       has_schema_privilege('postbro_anon', 'postbro', 'USAGE') AS schema_usage,
       has_table_privilege('postbro_anon', 'postbro.threads_accounts', 'SELECT') AS table_select`,
  );
  assert.equal(privileges.rows[0]!.schema_usage, false);
  assert.equal(privileges.rows[0]!.table_select, false);
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
  const jobId = await createPublishJob(fixture.accountA, `attempt-${randomUUID()}`, new Date(Date.now() + 60_000));
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

test('DB-03/DB-04 regression: approval action boundary revalidates authorization and source eligibility', async () => {
  const disabledOperatorApproval = await createPendingApproval(fixture.accountA, fixture.operatorOne, `disabled-op-${randomUUID()}`);
  await pg.ownerPool.query(`UPDATE postbro.operators SET status = 'disabled', updated_at = now() WHERE id = $1`, [fixture.operatorOne]);
  try {
    assert.equal(await approveApproval(appPool, fixture.operatorOne, fixture.accountA, disabledOperatorApproval), false);
    assert.equal(await rejectApproval(appPool, fixture.operatorOne, fixture.accountA, disabledOperatorApproval), false);
  } finally {
    await pg.ownerPool.query(`UPDATE postbro.operators SET status = 'active', updated_at = now() WHERE id = $1`, [fixture.operatorOne]);
  }

  const disabledAccountApproval = await createPendingApproval(fixture.accountA, fixture.operatorOne, `disabled-account-${randomUUID()}`);
  await pg.ownerPool.query(`UPDATE postbro.threads_accounts SET status = 'disabled', updated_at = now() WHERE id = $1`, [fixture.accountA]);
  try {
    assert.equal(await approveApproval(appPool, fixture.operatorOne, fixture.accountA, disabledAccountApproval), false);
  } finally {
    await pg.ownerPool.query(`UPDATE postbro.threads_accounts SET status = 'active', updated_at = now() WHERE id = $1`, [fixture.accountA]);
  }

  const noBindingApproval = await createPendingApproval(fixture.accountB, fixture.operatorTwo, `no-binding-${randomUUID()}`);
  assert.equal(await approveApproval(appPool, fixture.operatorTwo, fixture.accountB, noBindingApproval), false);

  const staleSourceApproval = await createPendingApproval(fixture.accountA, fixture.operatorOne, `stale-source-${randomUUID()}`);
  const proposal = await pg.ownerPool.query<{ proposal_id: string }>(`SELECT proposal_id FROM postbro.approvals WHERE id = $1`, [staleSourceApproval]);
  await pg.ownerPool.query(`UPDATE postbro.engagement_proposals SET status = 'superseded', updated_at = now() WHERE id = $1`, [Number(proposal.rows[0]!.proposal_id)]);
  assert.equal(await approveApproval(appPool, fixture.operatorOne, fixture.accountA, staleSourceApproval), false);
});

test('DB-04 regression: expired job leases recover safely and stale or cross-account workers are denied', async () => {
  const jobId = await createPublishJob(fixture.accountA, `lease-${randomUUID()}`);
  const first = await claimDueJob(appPool, fixture.accountA, 'worker-a');
  assert.ok(first);
  await pg.ownerPool.query(`UPDATE postbro.publish_jobs SET lease_expires_at = now() - interval '1 second', updated_at = now() WHERE id = $1`, [jobId]);

  const second = await claimDueJob(appPool, fixture.accountA, 'worker-b');
  assert.ok(second);
  assert.equal(second?.id, jobId);
  assert.notEqual(second?.leaseToken, first?.leaseToken);
  assert.equal(await completeClaimedJob(appPool, fixture.accountA, jobId, first!.leaseToken, 'confirmed'), false);
  assert.equal(await completeClaimedJob(appPool, fixture.accountA, jobId, second!.leaseToken, 'confirmed'), true);

  const ambiguousJobId = await createPublishJob(fixture.accountA, `lease-ambiguous-${randomUUID()}`);
  const ambiguousClaim = await claimDueJob(appPool, fixture.accountA, 'worker-ambiguous-lease');
  assert.ok(ambiguousClaim);
  await recordExecutionAttempt(appPool, fixture.accountA, ambiguousJobId, `lease-ambiguous-attempt-${randomUUID()}`, 1, 'ambiguous', { status: 'timeout' });
  await pg.ownerPool.query(`UPDATE postbro.publish_jobs SET lease_expires_at = now() - interval '1 second', updated_at = now() WHERE id = $1`, [ambiguousJobId]);
  assert.equal(await claimDueJob(appPool, fixture.accountA, 'worker-reclaimer'), null);
  const ambiguousStatus = await pg.ownerPool.query<{ status: string }>(`SELECT status FROM postbro.publish_jobs WHERE id = $1`, [ambiguousJobId]);
  assert.equal(ambiguousStatus.rows[0]!.status, 'needs_reconciliation');

  const crossAccountJobId = await createPublishJob(fixture.accountB, `cross-account-${randomUUID()}`);
  assert.equal(await claimDueJob(appPool, fixture.accountA, 'worker-cross-account'), null);
  const crossAccountClaim = await claimDueJob(appPool, fixture.accountB, 'worker-b');
  assert.equal(crossAccountClaim?.id, crossAccountJobId);
});

test('DB-02/DB-03 regression: approvals and execution attempts enforce account/source integrity', async () => {
  const draftA = await createDraft(fixture.accountA, `integrity-${randomUUID()}`);
  await assert.rejects(
    pg.ownerPool.query(
      `INSERT INTO postbro.approvals (account_id, operator_id, draft_id, action_key, action_type, status, expires_at)
       VALUES (999999, $1, $2, 'bad-account', 'publish_draft', 'pending', now() + interval '5 minutes')`,
      [fixture.operatorOne, draftA],
    ),
    (error: unknown) => {
      assertPgError(error, '23503');
      return true;
    },
  );

  const eventB = await pg.ownerPool.query<{ id: string }>(`INSERT INTO postbro.engagement_events (account_id, provider_reply_id, content) VALUES ($1, $2, '{}'::jsonb) RETURNING id`, [fixture.accountB, `integrity-${randomUUID()}`]);
  const proposalB = await pg.ownerPool.query<{ id: string }>(`INSERT INTO postbro.engagement_proposals (account_id, event_id, proposed_text, status) VALUES ($1, $2, 'B proposal', 'pending') RETURNING id`, [fixture.accountB, Number(eventB.rows[0]!.id)]);
  await assert.rejects(
    pg.ownerPool.query(
      `INSERT INTO postbro.approvals (account_id, operator_id, proposal_id, action_key, action_type, status, expires_at)
       VALUES ($1, $2, $3, 'cross-operator', 'engagement_reply', 'pending', now() + interval '5 minutes')`,
      [fixture.accountB, fixture.operatorOne, Number(proposalB.rows[0]!.id)],
    ),
    (error: unknown) => {
      assertPgError(error, '23503');
      return true;
    },
  );

  await assert.rejects(
    pg.ownerPool.query(
      `INSERT INTO postbro.approvals (account_id, operator_id, action_key, action_type, status, expires_at)
       VALUES ($1, $2, 'missing-source', 'engagement_reply', 'pending', now() + interval '5 minutes')`,
      [fixture.accountA, fixture.operatorOne],
    ),
    (error: unknown) => {
      assertPgError(error, '23514');
      return true;
    },
  );

  await assert.rejects(
    pg.ownerPool.query(
      `INSERT INTO postbro.execution_attempts (account_id, job_id, action_key, attempt_no, outcome)
       VALUES ($1, NULL, 'missing-job', 1, 'failed')`,
      [fixture.accountA],
    ),
    (error: unknown) => {
      assertPgError(error, '23502');
      return true;
    },
  );

  const jobA = await createPublishJob(fixture.accountA, `attempt-integrity-${randomUUID()}`, new Date(Date.now() + 60_000));
  await assert.rejects(
    pg.ownerPool.query(
      `INSERT INTO postbro.execution_attempts (account_id, job_id, action_key, attempt_no, outcome)
       VALUES (999999, $1, 'bad-attempt-account', 1, 'failed')`,
      [jobA],
    ),
    (error: unknown) => {
      assertPgError(error, '23503');
      return true;
    },
  );
});

test('DB-08 regression: provider payloads, errors and audit metadata are recursively redacted before persistence', async () => {
  const jobId = await createPublishJob(fixture.accountA, `redaction-${randomUUID()}`);
  const claim = await claimDueJob(appPool, fixture.accountA, 'worker-redaction');
  assert.ok(claim);
  assert.equal(
    await markJobNeedsReconciliation(appPool, fixture.accountA, jobId, claim!.leaseToken, 'Meta timeout Bearer synthetic-token-123 access_token=abc123'),
    true,
  );
  const job = await pg.ownerPool.query<{ last_error: string }>(`SELECT last_error FROM postbro.publish_jobs WHERE id = $1`, [jobId]);
  assert.equal(job.rows[0]!.last_error.includes('synthetic-token-123'), false);
  assert.equal(job.rows[0]!.last_error.includes('abc123'), false);
  assert.equal(job.rows[0]!.last_error.includes('[REDACTED]'), true);

  const attemptId = await recordExecutionAttempt(
    appPool,
    fixture.accountA,
    jobId,
    `redaction-attempt-${randomUUID()}`,
    1,
    'needs_reconciliation',
    {
      access_token: 'nested-token-123',
      safe_status: 'timeout',
      nested: { client_secret: 'secret-456' },
      list: [{ password: 'pass-000' }],
    },
    {
      authorization: 'Bearer response-token-789',
      results: [{ refresh_token: 'refresh-000' }],
    },
  );
  const storedAttempt = await pg.ownerPool.query<{ request: string; response: string }>(
    `SELECT provider_request::text AS request, provider_response::text AS response FROM postbro.execution_attempts WHERE id = $1`,
    [attemptId],
  );
  const storedPayload = `${storedAttempt.rows[0]!.request} ${storedAttempt.rows[0]!.response}`;
  for (const forbidden of ['nested-token-123', 'secret-456', 'pass-000', 'response-token-789', 'refresh-000']) {
    assert.equal(storedPayload.includes(forbidden), false, `stored provider payload leaked ${forbidden}`);
  }
  assert.equal(storedPayload.includes('[REDACTED]'), true);

  const auditId = await recordAuditEvent(appPool, {
    operatorId: fixture.operatorOne,
    accountId: fixture.accountA,
    action: 'pb_p0_002_redaction_test',
    reason: 'failure contained token audit-secret-123',
    outcome: 'failed',
    metadata: { access_token: 'audit-token-456', nested: { refresh_token: 'audit-refresh-789' }, safe: 'yes' },
  });
  const audit = await pg.ownerPool.query<{ reason: string; metadata: string }>(
    `SELECT reason, metadata::text FROM postbro.audit_events WHERE id = $1`,
    [auditId],
  );
  const storedAudit = `${audit.rows[0]!.reason} ${audit.rows[0]!.metadata}`;
  for (const forbidden of ['audit-secret-123', 'audit-token-456', 'audit-refresh-789']) {
    assert.equal(storedAudit.includes(forbidden), false, `stored audit payload leaked ${forbidden}`);
  }
});
