import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { Pool } from 'pg';

import { buildApp } from '../src/app';
import { migrateDatabase } from '../src/db/migrate';
import { MockThreadsOAuthClient } from '../src/integrations/threads/oauth-client';
import { mintLinkToken } from '../src/modules/auth/oauth-state';
import {
  connectionStringFor,
  createLoginRole,
  startEmbeddedPostgres,
  type EmbeddedPostgresTestContext,
} from './helpers/embedded-postgres';

// Fixed dummy, non-real test-only values. No Meta contact is made: the mock
// OAuth client performs no I/O and only formats the authorize URL locally.
const SIGNING_SECRET = 'dummy-signing-secret-for-tests-only-000000';
const OAUTH_CONFIG = {
  appId: 'fake-app-id-123',
  appSecret: 'fake-app-secret-NOT-REAL',
  redirectUri: 'http://127.0.0.1:3000/auth/threads/callback',
  scopes: ['threads_basic'],
};

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

let pg: EmbeddedPostgresTestContext;
let appPool: Pool;
let oauthClient: MockThreadsOAuthClient;
let app: ReturnType<typeof buildApp>;

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
  appPool = new Pool({
    connectionString: connectionStringFor(pg.port, 'postbro_app_test', appPassword),
    max: 10,
  });
  oauthClient = new MockThreadsOAuthClient({ config: OAUTH_CONFIG });
  app = buildApp({
    threadsAuth: { pool: appPool, signingSecret: SIGNING_SECRET, oauthClient },
  });
});

after(async () => {
  if (app) await app.close();
  if (appPool) await appPool.end();
  if (pg) await pg.stop();
});

test('start: valid signed link redirects to official Meta authorize URL with state', async () => {
  const operatorId = await createOperator(910001);
  const minted = await mintLinkToken(appPool, { operatorId, signingSecret: SIGNING_SECRET });

  const response = await app.inject({
    method: 'GET',
    url: `/auth/threads/start?link=${encodeURIComponent(minted.token)}`,
  });

  assert.equal(response.statusCode, 302);
  const location = response.headers.location;
  assert.equal(typeof location, 'string');
  const url = new URL(location as string);
  assert.equal(url.origin + url.pathname, 'https://threads.com/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), OAUTH_CONFIG.appId);
  assert.equal(url.searchParams.get('redirect_uri'), OAUTH_CONFIG.redirectUri);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'threads_basic');
  const state = url.searchParams.get('state');
  assert.ok(state && state.length >= 32, 'state present and high-entropy');

  // No secret material in the response.
  assert.ok(!location!.includes(OAUTH_CONFIG.appSecret));
  assert.ok(!location!.includes(SIGNING_SECRET));
  assert.equal(response.body, '');

  // State was persisted ONLY as a hash for this operator, unconsumed.
  const stored = await pg.ownerPool.query<{ operator_id: string; consumed_at: Date | null }>(
    `SELECT operator_id, consumed_at FROM postbro.oauth_sessions
      WHERE state_hash IS NOT NULL ORDER BY id DESC LIMIT 1`,
  );
  assert.equal(stored.rowCount, 1);
  assert.equal(Number(stored.rows[0]!.operator_id), operatorId);
  assert.equal(stored.rows[0]!.consumed_at, null);
});

test('start: replayed link is rejected after first use', async () => {
  const operatorId = await createOperator(910002);
  const minted = await mintLinkToken(appPool, { operatorId, signingSecret: SIGNING_SECRET });
  const url = `/auth/threads/start?link=${encodeURIComponent(minted.token)}`;

  const first = await app.inject({ method: 'GET', url });
  assert.equal(first.statusCode, 302);

  const second = await app.inject({ method: 'GET', url });
  assert.equal(second.statusCode, 401);
  assert.deepEqual(second.json(), { error: 'link_not_accepted' });
  assert.ok(!second.body.includes(minted.jti));
});

test('start: missing, malformed and forged links are rejected without secrets', async () => {
  const missing = await app.inject({ method: 'GET', url: '/auth/threads/start' });
  assert.equal(missing.statusCode, 400);

  const malformed = await app.inject({ method: 'GET', url: '/auth/threads/start?link=abc' });
  assert.equal(malformed.statusCode, 400);

  const operatorId = await createOperator(910003);
  const forged = `1.${randomBytes(16).toString('base64url')}.${Date.now() + 60000}.threads_connect.forged`;
  const forgedResponse = await app.inject({
    method: 'GET',
    url: `/auth/threads/start?link=${encodeURIComponent(forged)}`,
  });
  assert.equal(forgedResponse.statusCode, 401);
  assert.ok(!forgedResponse.body.includes(SIGNING_SECRET));
  assert.ok(!forgedResponse.body.includes(OAUTH_CONFIG.appSecret));
  void operatorId;
});

test('start: link minted for operator A cannot start a flow as operator B', async () => {
  const operatorA = await createOperator(910004);
  const operatorB = await createOperator(910005);
  const minted = await mintLinkToken(appPool, { operatorId: operatorA, signingSecret: SIGNING_SECRET });

  // Tamper the operator id field to operator B; signature no longer matches.
  const parts = minted.token.split('.');
  parts[0] = String(operatorB);
  const tampered = parts.join('.');

  const response = await app.inject({
    method: 'GET',
    url: `/auth/threads/start?link=${encodeURIComponent(tampered)}`,
  });
  assert.equal(response.statusCode, 401);

  // No OAuth session was created for operator B.
  const sessions = await pg.ownerPool.query(
    'SELECT id FROM postbro.oauth_sessions WHERE operator_id = $1',
    [operatorB],
  );
  assert.equal(sessions.rowCount, 0);
});

test('start: disabled operator link fails closed at the route', async () => {
  const operatorId = await createOperator(910006, 'disabled');
  await assert.rejects(() =>
    mintLinkToken(appPool, { operatorId, signingSecret: SIGNING_SECRET }),
  );

  // Mint while active, then disable: consume must fail closed.
  const activeId = await createOperator(910007);
  const minted = await mintLinkToken(appPool, { operatorId: activeId, signingSecret: SIGNING_SECRET });
  await pg.ownerPool.query('UPDATE postbro.operators SET status = $1 WHERE id = $2', [
    'disabled',
    activeId,
  ]);
  const response = await app.inject({
    method: 'GET',
    url: `/auth/threads/start?link=${encodeURIComponent(minted.token)}`,
  });
  assert.equal(response.statusCode, 401);
});

test('start: mock OAuth client performs no network and records only URL build', async () => {
  const exchangeCalls = oauthClient.calls.filter((c) => c.method !== 'buildAuthorizeUrl');
  assert.equal(exchangeCalls.length, 0);
});

test('health: unchanged when threads auth routes are enabled', async () => {
  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  assert.equal((response.json() as Record<string, unknown>).status, 'ok');
});
