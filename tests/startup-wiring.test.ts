import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import type { Pool } from 'pg';

import { buildApp } from '../src/app';
import { parseConfig, type AppConfig } from '../src/config';
import { buildThreadsAuthDeps } from '../src/index';
import { ThreadsHttpOAuthClient } from '../src/integrations/threads/oauth-client-http';

const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  PORT: '3000',
  APP_TIMEZONE: 'Asia/Kuala_Lumpur',
};

const AUTH_ENV: NodeJS.ProcessEnv = {
  ...BASE_ENV,
  DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/postbro',
  THREADS_APP_ID: 'dummy-app-id',
  THREADS_APP_SECRET: 'dummy-app-secret-NOT-REAL',
  THREADS_REDIRECT_URI: 'http://127.0.0.1:3000/auth/threads/callback',
  THREADS_SCOPES: 'threads_basic',
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  TOKEN_ENCRYPTION_KEY_ID: 'key-1',
  APP_SIGNING_SECRET: 'dummy-signing-secret-for-tests-only-000000',
};

test('no auth config -> deps undefined, /health works, auth routes absent', async () => {
  const config = parseConfig(BASE_ENV);
  assert.equal(buildThreadsAuthDeps(config), undefined);
  const app = buildApp({ env: BASE_ENV });
  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 200);
  const start = await app.inject({ method: 'GET', url: '/auth/threads/start' });
  assert.equal(start.statusCode, 404);
  await app.close();
});

test('full auth config -> real HTTP client wired, no network at startup', async () => {
  const config = parseConfig(AUTH_ENV);
  let poolCreated = 0;
  const fakePool = { end: () => Promise.resolve() } as unknown as Pool;
  const deps = buildThreadsAuthDeps(config, () => {
    poolCreated += 1;
    return fakePool;
  });
  assert.ok(deps);
  assert.ok(deps.oauthClient instanceof ThreadsHttpOAuthClient);
  assert.equal(deps.signingSecret, AUTH_ENV.APP_SIGNING_SECRET);
  assert.equal(deps.tokenEncryptionKey.keyId, 'key-1');
  assert.equal(poolCreated, 1);

  const app = buildApp({ env: AUTH_ENV, threadsAuth: deps });
  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 200);
  // Route exists now (fails closed without a valid link, no network).
  const start = await app.inject({ method: 'GET', url: '/auth/threads/start' });
  assert.equal(start.statusCode, 400);
  await app.close();
});

test('partial auth config fails fast (missing signing secret)', () => {
  const env = { ...AUTH_ENV };
  delete env.APP_SIGNING_SECRET;
  const config = parseConfig(env);
  assert.throws(() => buildThreadsAuthDeps(config, () => ({}) as Pool), /APP_SIGNING_SECRET/);
});

test('partial auth config fails fast (missing encryption key)', () => {
  const env = { ...AUTH_ENV };
  delete env.TOKEN_ENCRYPTION_KEY;
  delete env.TOKEN_ENCRYPTION_KEY_ID;
  const config = parseConfig(env);
  assert.throws(() => buildThreadsAuthDeps(config, () => ({}) as Pool), /TOKEN_ENCRYPTION_KEY/);
});

test('missing DATABASE_URL with auth config fails', () => {
  const env = { ...AUTH_ENV };
  delete env.DATABASE_URL;
  const config = parseConfig(env);
  assert.throws(() => buildThreadsAuthDeps(config, () => ({}) as Pool), /DATABASE_URL/);
});

test('missing OAuth config with other auth vars fails', () => {
  const env: NodeJS.ProcessEnv = { ...AUTH_ENV };
  delete env.THREADS_APP_ID;
  delete env.THREADS_APP_SECRET;
  delete env.THREADS_REDIRECT_URI;
  delete env.THREADS_SCOPES;
  const config: AppConfig = parseConfig(env);
  assert.throws(() => buildThreadsAuthDeps(config, () => ({}) as Pool), /THREADS_\*/);
});
