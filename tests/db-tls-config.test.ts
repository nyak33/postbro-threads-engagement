import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildDbPoolOptions } from '../src/db/client';
import { ConfigError, parseConfig } from '../src/config';

test('HC-04: TLS mode is explicit and unsafe pooler/SSL settings are rejected', () => {
  assert.throws(
    () => parseConfig({ DATABASE_URL: 'postgres://postbro@127.0.0.1:5432/postbro', DATABASE_SSL_MODE: 'prefer' }),
    (error: unknown) => error instanceof ConfigError && /DATABASE_SSL_MODE/.test(error.message),
  );

  assert.throws(
    () => parseConfig({ DATABASE_URL: 'postgres://postgres.project@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres' }),
    (error: unknown) => error instanceof ConfigError && /transaction pooler/i.test(error.message),
  );
});

test('HC-04: local disposable DB may use ssl disable, but hosted verify-full requires a CA file', async () => {
  const local = buildDbPoolOptions(parseConfig({
    DATABASE_URL: 'postgres://postbro@127.0.0.1:5432/postbro',
    DATABASE_SSL_MODE: 'disable',
  }));
  assert.equal(local.ssl, false);

  assert.throws(
    () => buildDbPoolOptions(parseConfig({
      DATABASE_URL: 'postgres://postgres.project@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres',
      DATABASE_SSL_MODE: 'verify-full',
    })),
    (error: unknown) => error instanceof ConfigError && /DATABASE_SSL_CA_PATH/.test(error.message),
  );

  const caPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'postbro-ca-')), 'ca.crt');
  await fs.writeFile(caPath, '-----BEGIN CERTIFICATE-----\nMIIBszCATpwCAQAwDQYJKoZIhvcNAQELBQAwADA=\n-----END CERTIFICATE-----\n', 'utf8');
  const hosted = buildDbPoolOptions(parseConfig({
    DATABASE_URL: 'postgres://postgres.project@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres',
    DATABASE_SSL_MODE: 'verify-full',
    DATABASE_SSL_CA_PATH: caPath,
  }));
  assert.equal(typeof hosted.ssl, 'object');
  const ssl = hosted.ssl as { rejectUnauthorized: boolean; ca: string; checkServerIdentity?: unknown };
  assert.equal(ssl.rejectUnauthorized, true);
  assert.equal(ssl.ca.includes('BEGIN CERTIFICATE'), true);
  assert.equal(ssl.checkServerIdentity, undefined);
});

test('HC-04: verify-ca validates CA without hostname check', async () => {
  const caPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'postbro-ca-')), 'ca.crt');
  await fs.writeFile(caPath, '-----BEGIN CERTIFICATE-----\nMIIBszCATpwCAQAwDQYJKoZIhvcNAQELBQAwADA=\n-----END CERTIFICATE-----\n', 'utf8');
  const options = buildDbPoolOptions(parseConfig({
    DATABASE_URL: 'postgres://postgres.project@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres',
    DATABASE_SSL_MODE: 'verify-ca',
    DATABASE_SSL_CA_PATH: caPath,
  }));
  const ssl = options.ssl as { rejectUnauthorized: boolean; checkServerIdentity: () => undefined };
  assert.equal(ssl.rejectUnauthorized, true);
  assert.equal(ssl.checkServerIdentity(), undefined);
});
