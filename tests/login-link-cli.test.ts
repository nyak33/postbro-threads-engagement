import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { Pool } from 'pg';

import { buildApp } from '../src/app';
import { migrateDatabase } from '../src/db/migrate';
import { MockThreadsOAuthClient } from '../src/integrations/threads/oauth-client';
import { consumeLinkToken, mintLinkToken, LinkTokenError } from '../src/modules/auth/oauth-state';
import {
  connectionStringFor,
  createLoginRole,
  startEmbeddedPostgres,
  type EmbeddedPostgresTestContext,
} from './helpers/embedded-postgres';

/**
 * PB-P0-004 slice C: one-time link mint/consume against a REAL disposable
 * embedded PostgreSQL (the same DB + HMAC code the CLI uses). The CLI entry
 * itself is not executed here (no network, no env secrets); its core mint
 * operation and the server-side one-time semantics are fully exercised.
 */

const SIGNING_SECRET = 'dummy-signing-secret-for-tests-only-000000';
const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');
const OAUTH_CONFIG = {
  appId: 'fake-app-id-123',
  appSecret: 'fake-app-secret-NOT-REAL',
  redirectUri: 'http://127.0.0.1:3000/auth/threads/callback',
  scopes: ['threads_basic'],
};

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

test('minted link token round-trips through full start flow with exact public URL shape', async () => {
  const operatorId = await createOperator(900001);
  const minted = await mintLinkToken(appPool, { operatorId, signingSecret: SIGNING_SECRET });
  assert.ok(minted.token.split('.').length === 5);

  const publicBaseUrl = 'https://staging.example.com';
  const link = new URL('/auth/threads/start', publicBaseUrl);
  link.searchParams.set('link', minted.token);
  assert.equal(link.origin, publicBaseUrl);

  const app = buildApp({
    threadsAuth: {
      pool: appPool,
      signingSecret: SIGNING_SECRET,
      oauthClient: new MockThreadsOAuthClient({ config: OAUTH_CONFIG }),
      tokenEncryptionKey: { keyId: 'k1', key: randomBytes(32) },
    },
  });
  const start = await app.inject({ method: 'GET', url: link.pathname + link.search });
  assert.equal(start.statusCode, 302);
  await app.close();

  // Reuse prevention: consuming the same jti again must fail as replayed.
  await assert.rejects(
    () =>
      consumeLinkToken(appPool, {
        token: minted.token,
        signingSecret: SIGNING_SECRET,
        operatorId,
      }),
    (e: unknown) => e instanceof LinkTokenError && e.reason === 'replayed',
  );
});

test('mint refuses unknown or inactive operators (fail closed)', async () => {
  const inactive = await createOperator(900002, 'disabled');
  await assert.rejects(
    () => mintLinkToken(appPool, { operatorId: inactive, signingSecret: SIGNING_SECRET }),
    (e: unknown) => e instanceof LinkTokenError && e.reason === 'operator_inactive',
  );
  await assert.rejects(
    () => mintLinkToken(appPool, { operatorId: 424242, signingSecret: SIGNING_SECRET }),
    (e: unknown) => e instanceof LinkTokenError && e.reason === 'operator_inactive',
  );
});

test('minted token has bounded short TTL and fresh jti per mint', async () => {
  const operatorId = await createOperator(900003);
  const a = await mintLinkToken(appPool, { operatorId, signingSecret: SIGNING_SECRET });
  const b = await mintLinkToken(appPool, { operatorId, signingSecret: SIGNING_SECRET });
  assert.notEqual(a.jti, b.jti);
  const ttlMs = a.expiresAt.getTime() - Date.now();
  assert.ok(ttlMs > 0 && ttlMs <= 5 * 60 * 1000);
});
