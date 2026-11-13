import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { Pool } from 'pg';

import { buildApp } from '../src/app';
import { migrateDatabase } from '../src/db/migrate';
import { MockThreadsOAuthClient } from '../src/integrations/threads/oauth-client';
import { mintLinkToken } from '../src/modules/auth/oauth-state';
import { decryptToken } from '../src/shared/token-crypto';
import {
  connectionStringFor,
  createLoginRole,
  startEmbeddedPostgres,
  type EmbeddedPostgresTestContext,
} from './helpers/embedded-postgres';

/**
 * PB-P0-003 slice D2b2: FULL SIMULATED THREADS LOGIN end-to-end.
 * Fastify.inject + disposable embedded PostgreSQL + MockThreadsOAuthClient.
 * No Meta, no network, no Telegram, no hosted DB, no real credentials.
 */

const SIGNING_SECRET = 'dummy-signing-secret-for-tests-only-000000';
const ENCRYPTION_KEY = { keyId: 'test-key-e2e', key: randomBytes(32) };
const OAUTH_CONFIG = {
  appId: 'fake-app-id-123',
  appSecret: 'fake-app-secret-NOT-REAL',
  redirectUri: 'http://127.0.0.1:3000/auth/threads/callback',
  scopes: ['threads_basic'],
};
const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

let pg: EmbeddedPostgresTestContext;
let appPool: Pool;
let ownerPool: Pool;
let oauthClient: MockThreadsOAuthClient;
let app: ReturnType<typeof buildApp>;

async function createOperator(telegramUserId: number, status = 'active'): Promise<number> {
  const result = await ownerPool.query<{ id: string }>(
    `INSERT INTO postbro.operators (telegram_user_id, status) VALUES ($1, $2) RETURNING id`,
    [telegramUserId, status],
  );
  return Number(result.rows[0]!.id);
}

async function extractStateFromStart(operatorId: number): Promise<string> {
  const minted = await mintLinkToken(appPool, { operatorId, signingSecret: SIGNING_SECRET });
  const start = await app.inject({
    method: 'GET',
    url: `/auth/threads/start?link=${encodeURIComponent(minted.token)}`,
  });
  assert.equal(start.statusCode, 302);
  const url = new URL(start.headers.location as string);
  assert.equal(url.origin + url.pathname, 'https://threads.com/oauth/authorize');
  const state = url.searchParams.get('state');
  assert.ok(state);
  return state!;
}

async function runCallback(state: string, code: string) {
  return app.inject({
    method: 'GET',
    url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
  });
}

before(async () => {
  pg = await startEmbeddedPostgres();
  ownerPool = pg.ownerPool;
  await migrateDatabase(pg.ownerPool, MIGRATIONS_DIR);
  const appPassword = randomBytes(16).toString('hex');
  await createLoginRole(pg.ownerPool, 'postbro_app_test', appPassword, 'postbro_app');
  appPool = new Pool({
    connectionString: connectionStringFor(pg.port, 'postbro_app_test', appPassword),
    max: 10,
  });
  oauthClient = new MockThreadsOAuthClient({
    config: OAUTH_CONFIG,
    userId: 'mock-threads-user-e2e',
    username: 'e2e-simulated',
    grantedScopes: { verified: true, scopes: ['threads_basic'] },
  });
  app = buildApp({
    threadsAuth: {
      pool: appPool,
      signingSecret: SIGNING_SECRET,
      oauthClient,
      tokenEncryptionKey: ENCRYPTION_KEY,
    },
  });
});

after(async () => {
  if (app) await app.close();
  if (appPool) await appPool.end();
  if (pg) await pg.stop();
});

test('E2E simulated login: link -> start -> fake Meta callback -> encrypted persisted account', async () => {
  // (1) Mint one-time signed link (trusted helper) + (2) start redirect.
  const operatorId = await createOperator(940001);
  const state = await extractStateFromStart(operatorId);

  // (3) Fake Meta callback with NOT-REAL code.
  const callback = await runCallback(state, 'NOT-REAL-code-e2e');
  assert.equal(callback.statusCode, 200);
  const body = callback.json() as Record<string, unknown>;
  assert.equal(body.status, 'connected');
  assert.equal(body.operatorId, operatorId);
  assert.equal(body.scopesVerified, true);
  assert.deepEqual(body.grantedScopes, ['threads_basic']);
  const accountId = body.accountId as number;
  assert.ok(accountId > 0);

  // No secrets/tokens in response.
  assert.ok(!callback.body.includes('mock-long-lived-token'));
  assert.ok(!callback.body.includes('mock-short-lived-token'));
  assert.ok(!callback.body.includes(OAUTH_CONFIG.appSecret));
  assert.ok(!callback.body.includes(SIGNING_SECRET));

  // (4) Persisted account: encrypted ciphertext (not plaintext), expiry,
  // verified scopes, correct operator binding.
  const account = await ownerPool.query<{
    provider_id: string;
    username: string;
    scopes: string[];
    status: string;
    token_ciphertext: Buffer;
    token_key_id: string;
    token_expires_at: Date;
  }>('SELECT * FROM postbro.threads_accounts WHERE id = $1', [accountId]);
  assert.equal(account.rowCount, 1);
  const row = account.rows[0]!;
  assert.equal(row.provider_id, 'mock-threads-user-e2e');
  assert.equal(row.username, 'e2e-simulated');
  assert.deepEqual(row.scopes, ['threads_basic']);
  assert.equal(row.status, 'active');
  assert.equal(row.token_key_id, 'test-key-e2e');
  assert.ok(row.token_expires_at > new Date(), 'token expiry in the future');

  const ciphertextText = row.token_ciphertext.toString('utf8');
  assert.ok(!ciphertextText.includes('mock-long-lived-token'), 'no plaintext token in DB');
  const decrypted = decryptToken(ciphertextText, new Map([['test-key-e2e', ENCRYPTION_KEY.key]]));
  assert.equal(decrypted, 'mock-long-lived-token-NOT-REAL');

  const binding = await ownerPool.query(
    `SELECT role FROM postbro.operator_accounts WHERE operator_id = $1 AND account_id = $2`,
    [operatorId, accountId],
  );
  assert.equal(binding.rowCount, 1);
  assert.equal(binding.rows[0]!.role, 'owner');

  // Replay: same state fails and provider is NOT called again.
  const exchangesBefore = oauthClient.calls.filter((c) => c.method === 'exchangeCode').length;
  const replay = await runCallback(state, 'NOT-REAL-code-e2e');
  assert.equal(replay.statusCode, 401);
  assert.deepEqual(replay.json(), { error: 'invalid_state' });
  const exchangesAfter = oauthClient.calls.filter((c) => c.method === 'exchangeCode').length;
  assert.equal(exchangesAfter, exchangesBefore);

  // (5a) Same-owner reconnect: new link + state, same provider id -> SAME row.
  const state2 = await extractStateFromStart(operatorId);
  const reconnect = await runCallback(state2, 'NOT-REAL-code-e2e-reconnect');
  assert.equal(reconnect.statusCode, 200);
  const reconnectBody = reconnect.json() as Record<string, unknown>;
  assert.equal(reconnectBody.status, 'connected');
  assert.equal(reconnectBody.accountId, accountId, 'same account row updated');
  const accountCount = await ownerPool.query(
    `SELECT count(*)::int AS n FROM postbro.threads_accounts WHERE provider_id = 'mock-threads-user-e2e'`,
  );
  assert.equal(accountCount.rows[0]!.n, 1);

  // (5b) Cross-operator hijack attempt: different operator, same provider id.
  const attacker = await createOperator(940002);
  const state3 = await extractStateFromStart(attacker);
  const ciphertextBefore = (
    await ownerPool.query<{ token_ciphertext: Buffer }>(
      'SELECT token_ciphertext FROM postbro.threads_accounts WHERE id = $1',
      [accountId],
    )
  ).rows[0]!.token_ciphertext.toString('utf8');

  const hijack = await runCallback(state3, 'NOT-REAL-code-e2e-hijack');
  assert.equal(hijack.statusCode, 403);
  assert.deepEqual(hijack.json(), { error: 'provider_owned_by_other_operator' });

  const unchanged = await ownerPool.query<{ token_ciphertext: Buffer }>(
    'SELECT token_ciphertext FROM postbro.threads_accounts WHERE id = $1',
    [accountId],
  );
  assert.equal(
    unchanged.rows[0]!.token_ciphertext.toString('utf8'),
    ciphertextBefore,
    'original token ciphertext unchanged after hijack attempt',
  );
  const bindings = await ownerPool.query(
    'SELECT count(*)::int AS n FROM postbro.operator_accounts WHERE account_id = $1',
    [accountId],
  );
  assert.equal(bindings.rows[0]!.n, 1, 'no attacker binding created');

  // (6) All mock calls are local method invocations; verify sequence counts
  // only (mock performs no I/O by construction).
  const methods = oauthClient.calls.map((c) => c.method);
  assert.ok(methods.includes('buildAuthorizeUrl'));
  assert.ok(methods.includes('exchangeCode'));
  assert.ok(methods.includes('getMe'));
});

test('E2E failure paths: invalid code and unverified scopes fail safely', async () => {
  // Invalid code -> provider_exchange_failed, no account row.
  const failingClient = new MockThreadsOAuthClient({
    config: OAUTH_CONFIG,
    failExchangeCode: 'invalid_code',
  });
  const failingApp = buildApp({
    threadsAuth: {
      pool: appPool,
      signingSecret: SIGNING_SECRET,
      oauthClient: failingClient,
      tokenEncryptionKey: ENCRYPTION_KEY,
    },
  });
  try {
    const operatorId = await createOperator(940003);
    const minted = await mintLinkToken(appPool, { operatorId, signingSecret: SIGNING_SECRET });
    const start = await failingApp.inject({
      method: 'GET',
      url: `/auth/threads/start?link=${encodeURIComponent(minted.token)}`,
    });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const response = await failingApp.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=bad`,
    });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), { error: 'provider_exchange_failed' });
  } finally {
    await failingApp.close();
  }
  const rows = await ownerPool.query(
    `SELECT count(*)::int AS n FROM postbro.threads_accounts WHERE provider_id = 'mock-threads-user-1'`,
  );
  assert.equal(rows.rows[0]!.n, 0, 'no account persisted on provider failure');

  // Unverified scopes -> connected but persisted scopes are EMPTY.
  const unverifiedClient = new MockThreadsOAuthClient({
    config: OAUTH_CONFIG,
    userId: 'mock-threads-user-unverified',
    grantedScopes: { verified: false, scopes: [] },
  });
  const unverifiedApp = buildApp({
    threadsAuth: {
      pool: appPool,
      signingSecret: SIGNING_SECRET,
      oauthClient: unverifiedClient,
      tokenEncryptionKey: ENCRYPTION_KEY,
    },
  });
  try {
    const operatorId = await createOperator(940004);
    const minted = await mintLinkToken(appPool, { operatorId, signingSecret: SIGNING_SECRET });
    const start = await unverifiedApp.inject({
      method: 'GET',
      url: `/auth/threads/start?link=${encodeURIComponent(minted.token)}`,
    });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const response = await unverifiedApp.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=ok`,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as Record<string, unknown>;
    assert.equal(body.status, 'connected');
    assert.equal(body.scopesVerified, false);
    assert.deepEqual(body.grantedScopes, []);
    const persisted = await ownerPool.query<{ scopes: string[] }>(
      `SELECT scopes FROM postbro.threads_accounts WHERE provider_id = 'mock-threads-user-unverified'`,
    );
    assert.deepEqual(persisted.rows[0]!.scopes, [], 'unverified scopes persist as empty');
  } finally {
    await unverifiedApp.close();
  }
});

test('E2E: /health works with OAuth deps injected; nothing reaches the network', async () => {
  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 200);
  assert.equal((health.json() as Record<string, unknown>).status, 'ok');
  // Mock client performs no I/O by construction; no fetch/http calls exist
  // in the route path.
});
