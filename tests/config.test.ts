import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigError, parseConfig } from '../src/config';

test('parseConfig returns safe defaults for the health-only scaffold', () => {
  const config = parseConfig({});

  assert.equal(config.nodeEnv, 'development');
  assert.equal(config.port, 3000);
  assert.equal(config.appTimezone, 'Asia/Kuala_Lumpur');
  assert.equal(config.publicBaseUrl, undefined);
});

test('parseConfig rejects a non-numeric PORT', () => {
  assert.throws(
    () => parseConfig({ PORT: 'not-a-number' }),
    (error: unknown) => error instanceof ConfigError && /PORT/.test(error.message),
  );
});

test('parseConfig rejects an unsupported NODE_ENV', () => {
  assert.throws(
    () => parseConfig({ NODE_ENV: 'staging' }),
    (error: unknown) => error instanceof ConfigError && /NODE_ENV/.test(error.message),
  );
});

test('parseConfig rejects an invalid PUBLIC_BASE_URL when provided', () => {
  assert.throws(
    () => parseConfig({ PUBLIC_BASE_URL: 'not a url' }),
    (error: unknown) => error instanceof ConfigError && /PUBLIC_BASE_URL/.test(error.message),
  );
});

test('parseConfig accepts an optional PostgreSQL DATABASE_URL', () => {
  const config = parseConfig({ DATABASE_URL: 'postgres://postbro@127.0.0.1:5432/postbro_test' });

  assert.equal(config.databaseUrl, 'postgres://postbro@127.0.0.1:5432/postbro_test');
});

test('parseConfig rejects a non-PostgreSQL DATABASE_URL', () => {
  assert.throws(
    () => parseConfig({ DATABASE_URL: 'https://example.com/not-a-db' }),
    (error: unknown) => error instanceof ConfigError && /DATABASE_URL/.test(error.message),
  );
});

// --- PB-P0-003 slice A: OAuth + crypto config validation ---------------------

// Fixed dummy values, non-real, test-only.
const DUMMY_KEY_B64 = Buffer.alloc(32, 0xab).toString('base64');
const VALID_OAUTH_ENV = {
  THREADS_APP_ID: 'dummy-app-id',
  THREADS_APP_SECRET: 'dummy-app-secret',
  THREADS_REDIRECT_URI: 'https://app.example.com/auth/threads/callback',
  THREADS_SCOPES: 'threads_basic,threads_read_replies,threads_manage_replies',
};

test('parseConfig succeeds with no OAuth env vars set (module disabled)', () => {
  const config = parseConfig({});
  assert.equal(config.threadsOAuth, undefined);
  assert.equal(config.tokenEncryptionKey, undefined);
  assert.equal(config.appSigningSecret, undefined);
});

test('parseConfig parses a valid Threads OAuth config in production', () => {
  const config = parseConfig({
    NODE_ENV: 'production',
    PUBLIC_BASE_URL: 'https://app.example.com',
    ...VALID_OAUTH_ENV,
  });
  assert.equal(config.threadsOAuth?.appId, 'dummy-app-id');
  assert.equal(config.threadsOAuth?.redirectUri, 'https://app.example.com/auth/threads/callback');
  assert.deepEqual(config.threadsOAuth?.scopes, [
    'threads_basic',
    'threads_read_replies',
    'threads_manage_replies',
  ]);
});

test('parseConfig fails fast on partial Threads OAuth config', () => {
  assert.throws(
    () => parseConfig({ THREADS_APP_ID: 'dummy-app-id' }),
    (error: unknown) =>
      error instanceof ConfigError &&
      /THREADS_APP_SECRET/.test(error.message) &&
      /THREADS_REDIRECT_URI/.test(error.message),
  );
});

test('parseConfig rejects non-HTTPS redirect URI', () => {
  assert.throws(
    () =>
      parseConfig({
        ...VALID_OAUTH_ENV,
        THREADS_REDIRECT_URI: 'http://evil.example.com/callback',
      }),
    (error: unknown) => error instanceof ConfigError && /THREADS_REDIRECT_URI must be an absolute HTTPS URL/.test(error.message),
  );
});

test('parseConfig allows http localhost redirect URI outside production', () => {
  const config = parseConfig({
    NODE_ENV: 'development',
    ...VALID_OAUTH_ENV,
    THREADS_REDIRECT_URI: 'http://localhost:3000/auth/threads/callback',
  });
  assert.equal(config.threadsOAuth?.redirectUri, 'http://localhost:3000/auth/threads/callback');
});

test('parseConfig rejects production redirect URI outside PUBLIC_BASE_URL origin', () => {
  assert.throws(
    () =>
      parseConfig({
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'https://app.example.com',
        ...VALID_OAUTH_ENV,
        THREADS_REDIRECT_URI: 'https://other.example.com/auth/threads/callback',
      }),
    (error: unknown) => error instanceof ConfigError && /THREADS_REDIRECT_URI must start with PUBLIC_BASE_URL/.test(error.message),
  );
});

test('parseConfig rejects non-https PUBLIC_BASE_URL in production with OAuth configured', () => {
  assert.throws(
    () =>
      parseConfig({
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'http://app.example.com',
        ...VALID_OAUTH_ENV,
        THREADS_REDIRECT_URI: 'http://app.example.com/auth/threads/callback',
      }),
    (error: unknown) => error instanceof ConfigError,
  );
});

test('parseConfig requires threads_basic in scopes', () => {
  assert.throws(
    () =>
      parseConfig({
        ...VALID_OAUTH_ENV,
        THREADS_SCOPES: 'threads_read_replies',
      }),
    (error: unknown) => error instanceof ConfigError && /threads_basic/.test(error.message),
  );
});

test('parseConfig parses a valid token encryption key and key id', () => {
  const config = parseConfig({
    TOKEN_ENCRYPTION_KEY: DUMMY_KEY_B64,
    TOKEN_ENCRYPTION_KEY_ID: 'v1',
  });
  assert.equal(config.tokenEncryptionKey?.length, 32);
  assert.equal(config.tokenEncryptionKeyId, 'v1');
});

test('parseConfig rejects a wrong-length token encryption key', () => {
  assert.throws(
    () => parseConfig({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64'), TOKEN_ENCRYPTION_KEY_ID: 'v1' }),
    (error: unknown) => error instanceof ConfigError && /TOKEN_ENCRYPTION_KEY must be base64 of exactly 32 bytes/.test(error.message),
  );
});

test('parseConfig rejects key id without key and vice versa', () => {
  assert.throws(
    () => parseConfig({ TOKEN_ENCRYPTION_KEY_ID: 'v1' }),
    (error: unknown) => error instanceof ConfigError && /requires TOKEN_ENCRYPTION_KEY/.test(error.message),
  );
  assert.throws(
    () => parseConfig({ TOKEN_ENCRYPTION_KEY: DUMMY_KEY_B64 }),
    (error: unknown) => error instanceof ConfigError && /TOKEN_ENCRYPTION_KEY_ID is required/.test(error.message),
  );
});

test('parseConfig rejects a too-short APP_SIGNING_SECRET', () => {
  assert.throws(
    () => parseConfig({ APP_SIGNING_SECRET: 'short' }),
    (error: unknown) => error instanceof ConfigError && /APP_SIGNING_SECRET/.test(error.message),
  );
});

test('config error messages never include secret values', () => {
  const secretValue = 'dummy-app-secret-value';
  try {
    parseConfig({ ...VALID_OAUTH_ENV, THREADS_APP_SECRET: secretValue, THREADS_REDIRECT_URI: 'bad' });
    assert.fail('should have thrown');
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.message.includes(secretValue), false);
    assert.equal(error.message.includes(DUMMY_KEY_B64), false);
  }
});
