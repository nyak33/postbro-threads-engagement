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
