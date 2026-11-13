import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { Pool } from 'pg';

import { migrateDatabase } from '../src/db/migrate';
import {
  LinkTokenError,
  OAUTH_STATE_PURPOSE,
  OAuthStateError,
  consumeLinkToken,
  consumeOAuthSession,
  createOAuthSession,
  mintLinkToken,
} from '../src/modules/auth/oauth-state';
import {
  connectionStringFor,
  createLoginRole,
  startEmbeddedPostgres,
  type EmbeddedPostgresTestContext,
} from './helpers/embedded-postgres';

// Fixed dummy signing secret — non-real, test-only.
const SIGNING_SECRET = 'dummy-signing-secret-for-tests-only-000000';

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

let pg: EmbeddedPostgresTestContext;
let appPool: Pool;

async function createOperator(telegramUserId: number, status = 'active'): Promise<number> {
  const result = await pg.ownerPool.query<{ id: string }>(
    `INSERT INTO postbro.operators (telegram_user_id, status) VALUES ($1, $2) RETURNING id`,
    [telegramUserId, status],
  );
  return Number(result.rows[0]!.id);
}

before(async () => {
  pg = await startEmbeddedPostgres();
  await migrateDatabase(pg.ownerPool, MIGRATIONS_DIR);
  const appPassword = randomBytes(16).toString('hex');
  await createLoginRole(pg.ownerPool, 'postbro_app_test', appPassword, 'postbro_app');
  appPool = new Pool({ connectionString: connectionStringFor(pg.port, 'postbro_app_test', appPassword), max: 10 });
});

after(async () => {
  if (appPool) await appPool.end();
  if (pg) await pg.stop();
});

// --- Link tokens -------------------------------------------------------------

test('link token: valid mint and single consume succeeds', async () => {
  const operatorId = await createOperator(900001);
  const minted = await mintLinkToken(appPool, { operatorId, signingSecret: SIGNING_SECRET });
  assert.ok(minted.token.split('.').length === 5);
  const consumed = await consumeLinkToken(appPool, {
    token: minted.token,
    signingSecret: SIGNING_SECRET,
    operatorId,
  });
  assert.equal(consumed.jti, minted.jti);
});

test('link token: replay of the same token is denied', async () => {
  const operatorId = await createOperator(900002);
  const minted = await mintLinkToken(appPool, { operatorId, signingSecret: SIGNING_SECRET });
  await consumeLinkToken(appPool, { token: minted.token, signingSecret: SIGNING_SECRET, operatorId });
  await assert.rejects(
    () => consumeLinkToken(appPool, { token: minted.token, signingSecret: SIGNING_SECRET, operatorId }),
    (error: unknown) => error instanceof LinkTokenError && error.reason === 'replayed',
  );
});

test('link token: concurrent replay allows exactly one consume', async () => {
  const operatorId = await createOperator(900003);
  const minted = await mintLinkToken(appPool, { operatorId, signingSecret: SIGNING_SECRET });
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      consumeLinkToken(appPool, { token: minted.token, signingSecret: SIGNING_SECRET, operatorId }),
    ),
  );
  const ok = results.filter((r) => r.status === 'fulfilled');
  const replayed = results.filter(
    (r) => r.status === 'rejected' && (r.reason as LinkTokenError).reason === 'replayed',
  );
  assert.equal(ok.length, 1);
  assert.equal(ok.length + replayed.length, results.length);
});

test('link token: tampered signature and malformed tokens are rejected', async () => {
  const operatorId = await createOperator(900004);
  const minted = await mintLinkToken(appPool, { operatorId, signingSecret: SIGNING_SECRET });
  const parts = minted.token.split('.');
  const tampered = `${parts.slice(0, 4).join('.')}.${'A'.repeat(43)}`;
  await assert.rejects(
    () => consumeLinkToken(appPool, { token: tampered, signingSecret: SIGNING_SECRET, operatorId }),
    (error: unknown) => error instanceof LinkTokenError && error.reason === 'bad_signature',
  );
  await assert.rejects(
    () => consumeLinkToken(appPool, { token: 'not.a.token', signingSecret: SIGNING_SECRET, operatorId }),
    (error: unknown) => error instanceof LinkTokenError && error.reason === 'malformed',
  );
});

test('link token: wrong signing secret is rejected', async () => {
  const operatorId = await createOperator(900005);
  const minted = await mintLinkToken(appPool, { operatorId, signingSecret: SIGNING_SECRET });
  await assert.rejects(
    () =>
      consumeLinkToken(appPool, {
        token: minted.token,
        signingSecret: 'different-dummy-signing-secret-00000000',
        operatorId,
      }),
    (error: unknown) => error instanceof LinkTokenError && error.reason === 'bad_signature',
  );
});

test('link token: expired token is rejected', async () => {
  const operatorId = await createOperator(900006);
  const minted = await mintLinkToken(appPool, {
    operatorId,
    signingSecret: SIGNING_SECRET,
    now: new Date(Date.now() - 10 * 60 * 1000),
  });
  await assert.rejects(
    () => consumeLinkToken(appPool, { token: minted.token, signingSecret: SIGNING_SECRET, operatorId }),
    (error: unknown) => error instanceof LinkTokenError && error.reason === 'expired',
  );
});

test('link token: unknown or disabled operator fails closed at mint and consume', async () => {
  await assert.rejects(
    () => mintLinkToken(appPool, { operatorId: 999999, signingSecret: SIGNING_SECRET }),
    (error: unknown) => error instanceof LinkTokenError && error.reason === 'operator_inactive',
  );
  const disabledId = await createOperator(900007, 'disabled');
  await assert.rejects(
    () => mintLinkToken(appPool, { operatorId: disabledId, signingSecret: SIGNING_SECRET }),
    (error: unknown) => error instanceof LinkTokenError && error.reason === 'operator_inactive',
  );
});

test('link token: token minted for operator A cannot be consumed as operator B', async () => {
  const operatorA = await createOperator(900008);
  const operatorB = await createOperator(900009);
  const minted = await mintLinkToken(appPool, { operatorId: operatorA, signingSecret: SIGNING_SECRET });
  await assert.rejects(
    () =>
      consumeLinkToken(appPool, { token: minted.token, signingSecret: SIGNING_SECRET, operatorId: operatorB }),
    (error: unknown) => error instanceof LinkTokenError && error.reason === 'malformed',
  );
});

// --- OAuth state sessions ----------------------------------------------------

test('oauth state: create persists only a 32-byte hash and consume succeeds once', async () => {
  const operatorId = await createOperator(900010);
  const session = await createOAuthSession(appPool, { operatorId });
  assert.ok(session.state.length >= 40);
  const rows = await pg.ownerPool.query<{ state_hash: Buffer; purpose: string }>(
    `SELECT state_hash, purpose FROM postbro.oauth_sessions WHERE operator_id = $1`,
    [operatorId],
  );
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0]!.state_hash.length, 32);
  assert.equal(rows.rows[0]!.purpose, OAUTH_STATE_PURPOSE);
  // Plaintext state is never stored.
  assert.notEqual(rows.rows[0]!.state_hash.toString('utf8'), session.state);
  await consumeOAuthSession(appPool, { operatorId, state: session.state });
});

test('oauth state: replayed state is denied', async () => {
  const operatorId = await createOperator(900011);
  const session = await createOAuthSession(appPool, { operatorId });
  await consumeOAuthSession(appPool, { operatorId, state: session.state });
  await assert.rejects(
    () => consumeOAuthSession(appPool, { operatorId, state: session.state }),
    (error: unknown) => error instanceof OAuthStateError && error.reason === 'replayed',
  );
});

test('oauth state: unknown state is denied and consumes nothing', async () => {
  const operatorId = await createOperator(900012);
  await assert.rejects(
    () => consumeOAuthSession(appPool, { operatorId, state: 'never-issued-state' }),
    (error: unknown) => error instanceof OAuthStateError && error.reason === 'unknown',
  );
  const count = await pg.ownerPool.query<{ c: string }>(
    `SELECT count(*) AS c FROM postbro.oauth_sessions WHERE operator_id = $1 AND consumed_at IS NOT NULL`,
    [operatorId],
  );
  assert.equal(Number(count.rows[0]!.c), 0);
});

test('oauth state: expired state is denied', async () => {
  const operatorId = await createOperator(900013);
  const session = await createOAuthSession(appPool, {
    operatorId,
    now: new Date(Date.now() - 20 * 60 * 1000),
  });
  await assert.rejects(
    () => consumeOAuthSession(appPool, { operatorId, state: session.state }),
    (error: unknown) => error instanceof OAuthStateError && error.reason === 'expired',
  );
});

test('oauth state: cross-operator state is invisible (unknown) and not consumed', async () => {
  const operatorA = await createOperator(900014);
  const operatorB = await createOperator(900015);
  const session = await createOAuthSession(appPool, { operatorId: operatorA });
  await assert.rejects(
    () => consumeOAuthSession(appPool, { operatorId: operatorB, state: session.state }),
    (error: unknown) => error instanceof OAuthStateError && error.reason === 'unknown',
  );
  const row = await pg.ownerPool.query<{ consumed_at: Date | null }>(
    `SELECT consumed_at FROM postbro.oauth_sessions WHERE operator_id = $1`,
    [operatorA],
  );
  assert.equal(row.rows[0]!.consumed_at, null);
});

test('oauth state: concurrent consume of the same state allows exactly one success', async () => {
  const operatorId = await createOperator(900016);
  const session = await createOAuthSession(appPool, { operatorId });
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => consumeOAuthSession(appPool, { operatorId, state: session.state })),
  );
  const ok = results.filter((r) => r.status === 'fulfilled');
  const replayed = results.filter(
    (r) => r.status === 'rejected' && (r.reason as OAuthStateError).reason === 'replayed',
  );
  assert.equal(ok.length, 1);
  assert.equal(ok.length + replayed.length, results.length);
});

test('oauth state: disabled operator cannot create a session', async () => {
  const disabledId = await createOperator(900017, 'disabled');
  await assert.rejects(
    () => createOAuthSession(appPool, { operatorId: disabledId }),
    (error: unknown) => error instanceof OAuthStateError && error.reason === 'operator_inactive',
  );
});
