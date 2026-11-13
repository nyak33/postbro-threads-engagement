import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { Pool } from 'pg';

import { buildApp, type BuildAppOptions } from '../src/app';
import { migrateDatabase } from '../src/db/migrate';
import { MockThreadsOAuthClient } from '../src/integrations/threads/oauth-client';
import { mintLinkToken } from '../src/modules/auth/oauth-state';
import {
  connectionStringFor,
  createLoginRole,
  startEmbeddedPostgres,
  type EmbeddedPostgresTestContext,
} from './helpers/embedded-postgres';

// Fixed dummy, non-real test-only values. The mock OAuth client performs no
// I/O: no Meta, no network, no Telegram, disposable local Postgres only.
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
let ownerPool: Pool;

async function createOperator(telegramUserId: number, status = 'active'): Promise<number> {
  const result = await ownerPool.query<{ id: string }>(
    `INSERT INTO postbro.operators (telegram_user_id, status) VALUES ($1, $2) RETURNING id`,
    [telegramUserId, status],
  );
  return Number(result.rows[0]!.id);
}

function buildWithClient(oauthClient: MockThreadsOAuthClient): ReturnType<typeof buildApp> {
  const options: BuildAppOptions = {
    threadsAuth: { pool: appPool, signingSecret: SIGNING_SECRET, oauthClient },
  };
  return buildApp(options);
}

/**
 * Runs the D1 start flow and extracts the state from the redirect Location,
 * simulating Meta redirecting the browser back with that state.
 */
async function startAndExtractState(
  app: ReturnType<typeof buildApp>,
  operatorId: number,
): Promise<string> {
  const minted = await mintLinkToken(appPool, { operatorId, signingSecret: SIGNING_SECRET });
  const start = await app.inject({
    method: 'GET',
    url: `/auth/threads/start?link=${encodeURIComponent(minted.token)}`,
  });
  assert.equal(start.statusCode, 302);
  const url = new URL(start.headers.location as string);
  const state = url.searchParams.get('state');
  assert.ok(state);
  return state!;
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
});

after(async () => {
  if (appPool) await appPool.end();
  if (pg) await pg.stop();
});

test('callback: end-to-end D1 start -> fake Meta callback -> mocked exchanges -> safe pending result', async () => {
  const oauthClient = new MockThreadsOAuthClient({ config: OAUTH_CONFIG });
  const app = buildWithClient(oauthClient);
  try {
    const operatorId = await createOperator(920001);
    const state = await startAndExtractState(app, operatorId);

    const response = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=fake-code-1`,
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as Record<string, unknown>;
    assert.equal(body.status, 'simulation_pending_persistence');
    assert.equal(body.operatorId, operatorId);
    assert.equal(body.providerUserId, 'mock-threads-user-1');
    // Default mock scope evidence is UNVERIFIED — requested scopes are never
    // inferred as granted.
    assert.equal(body.scopesVerified, false);
    assert.deepEqual(body.grantedScopes, []);
    // No token material anywhere in the response.
    const raw = response.body;
    assert.ok(!raw.includes('mock-short-lived-token'));
    assert.ok(!raw.includes('mock-long-lived-token'));
    assert.ok(!raw.includes(OAUTH_CONFIG.appSecret));
    assert.ok(!raw.includes(SIGNING_SECRET));

    // Full mock sequence ran exactly once, in order.
    const methods = oauthClient.calls.map((c) => c.method);
    assert.deepEqual(
      methods.filter((m) => m !== 'buildAuthorizeUrl'),
      ['exchangeCode', 'exchangeLongLived', 'getMe', 'getGrantedScopes'],
    );

    // State was consumed exactly once.
    const sessions = await ownerPool.query(
      'SELECT consumed_at FROM postbro.oauth_sessions WHERE operator_id = $1',
      [operatorId],
    );
    assert.equal(sessions.rowCount, 1);
    assert.ok(sessions.rows[0]!.consumed_at !== null);
  } finally {
    await app.close();
  }
});

test('callback: replayed state is rejected and no provider calls occur', async () => {
  const oauthClient = new MockThreadsOAuthClient({ config: OAUTH_CONFIG });
  const app = buildWithClient(oauthClient);
  try {
    const operatorId = await createOperator(920002);
    const state = await startAndExtractState(app, operatorId);
    const url = `/auth/threads/callback?state=${encodeURIComponent(state)}&code=fake-code-2`;

    const first = await app.inject({ method: 'GET', url });
    assert.equal(first.statusCode, 200);

    const second = await app.inject({ method: 'GET', url });
    assert.equal(second.statusCode, 401);
    assert.deepEqual(second.json(), { error: 'invalid_state' });
    assert.equal(
      oauthClient.calls.filter((c) => c.method === 'exchangeCode').length,
      1,
    );
  } finally {
    await app.close();
  }
});

test('callback: missing/unknown/expired state and missing code fail closed', async () => {
  const oauthClient = new MockThreadsOAuthClient({ config: OAUTH_CONFIG });
  const app = buildWithClient(oauthClient);
  try {
    const noParams = await app.inject({ method: 'GET', url: '/auth/threads/callback' });
    assert.equal(noParams.statusCode, 400);

    const unknown = await app.inject({
      method: 'GET',
      url: '/auth/threads/callback?state=does-not-exist&code=x',
    });
    assert.equal(unknown.statusCode, 401);
    assert.deepEqual(unknown.json(), { error: 'invalid_state' });

    // Expired state: mint a session then force expiry in the past.
    const operatorId = await createOperator(920003);
    const state = await startAndExtractState(app, operatorId);
    await ownerPool.query(
      `UPDATE postbro.oauth_sessions SET expires_at = now() - interval '1 second'
        WHERE operator_id = $1`,
      [operatorId],
    );
    const expired = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=x`,
    });
    assert.equal(expired.statusCode, 401);
    assert.deepEqual(expired.json(), { error: 'invalid_state' });
    assert.equal(oauthClient.calls.filter((c) => c.method === 'exchangeCode').length, 0);
  } finally {
    await app.close();
  }
});

test('callback: provider error param maps to safe coarse rejection', async () => {
  const oauthClient = new MockThreadsOAuthClient({ config: OAUTH_CONFIG });
  const app = buildWithClient(oauthClient);
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/threads/callback?error=access_denied&state=whatever&code=x',
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: 'provider_error' });
  } finally {
    await app.close();
  }
});

test('callback: provider exchange failure maps to provider_exchange_failed', async () => {
  const oauthClient = new MockThreadsOAuthClient({
    config: OAUTH_CONFIG,
    failExchangeCode: 'invalid_code',
  });
  const app = buildWithClient(oauthClient);
  try {
    const operatorId = await createOperator(920004);
    const state = await startAndExtractState(app, operatorId);
    const response = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=bad-code`,
    });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), { error: 'provider_exchange_failed' });
  } finally {
    await app.close();
  }
});

test('callback: immutable id mismatch between exchange and getMe is rejected', async () => {
  // exchangeCode returns userId A; getMe must return the same id. A mock
  // whose identity differs simulates a confused provider response.
  const oauthClient = new MockThreadsOAuthClient({ config: OAUTH_CONFIG, userId: 'user-A' });
  const originalGetMe = oauthClient.getMe.bind(oauthClient);
  oauthClient.getMe = async (token: string) => {
    const me = await originalGetMe(token);
    return { ...me, id: 'user-B-attacker' };
  };
  const app = buildWithClient(oauthClient);
  try {
    const operatorId = await createOperator(920005);
    const state = await startAndExtractState(app, operatorId);
    const response = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=fake-code-3`,
    });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), { error: 'identity_mismatch' });
  } finally {
    await app.close();
  }
});

test('callback: verified granted-scope evidence is reported as verified', async () => {
  const oauthClient = new MockThreadsOAuthClient({
    config: OAUTH_CONFIG,
    grantedScopes: { verified: true, scopes: ['threads_basic'] },
  });
  const app = buildWithClient(oauthClient);
  try {
    const operatorId = await createOperator(920006);
    const state = await startAndExtractState(app, operatorId);
    const response = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=fake-code-4`,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as Record<string, unknown>;
    assert.equal(body.scopesVerified, true);
    assert.deepEqual(body.grantedScopes, ['threads_basic']);
    // Still no persistence claim.
    assert.equal(body.status, 'simulation_pending_persistence');
  } finally {
    await app.close();
  }
});

test('callback: disabled operator session fails closed', async () => {
  const oauthClient = new MockThreadsOAuthClient({ config: OAUTH_CONFIG });
  const app = buildWithClient(oauthClient);
  try {
    const operatorId = await createOperator(920007);
    const state = await startAndExtractState(app, operatorId);
    await ownerPool.query('UPDATE postbro.operators SET status = $1 WHERE id = $2', [
      'disabled',
      operatorId,
    ]);
    const response = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=x`,
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'invalid_state' });
    // Session must NOT have been consumed by the failed attempt.
    const sessions = await ownerPool.query(
      'SELECT consumed_at FROM postbro.oauth_sessions WHERE operator_id = $1',
      [operatorId],
    );
    assert.equal(sessions.rows[0]!.consumed_at, null);
    assert.equal(oauthClient.calls.filter((c) => c.method === 'exchangeCode').length, 0);
  } finally {
    await app.close();
  }
});
