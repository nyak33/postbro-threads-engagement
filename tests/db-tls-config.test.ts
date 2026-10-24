import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildDbPoolOptions } from '../src/db/client';
import { ConfigError, parseConfig } from '../src/config';

test('HC-04: TLS mode is explicit and insecure nonlocal modes or pooler port 6543 are rejected', () => {
  assert.throws(
    () => parseConfig({ DATABASE_URL: 'postgres://postbro@127.0.0.1:5432/postbro', DATABASE_SSL_MODE: 'prefer' }),
    (error: unknown) => error instanceof ConfigError && /DATABASE_SSL_MODE/.test(error.message),
  );

  assert.throws(
    () => parseConfig({ DATABASE_URL: 'postgres://postgres.project@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres' }),
    (error: unknown) => error instanceof ConfigError && /transaction pooler/i.test(error.message),
  );

  for (const mode of ['disable', 'require', 'verify-ca']) {
    assert.throws(
      () => parseConfig({
        DATABASE_URL: 'postgres://postgres.project@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres',
        DATABASE_SSL_MODE: mode,
      }),
      (error: unknown) => error instanceof ConfigError && /verify-full/.test(error.message),
      `expected nonlocal DATABASE_SSL_MODE=${mode} to be rejected`,
    );
  }
});

test('HC-04: PostgreSQL URL ssl parameters cannot override trusted TLS policy', () => {
  const urls = [
    'postgres://postgres.project:pa%23ss@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=disable',
    'postgres://postgres.project:pa%23ss@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=no-verify',
    'postgres://postgres.project:pa%23ss@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslrootcert=/tmp/untrusted.crt',
    'postgres://postgres.project:pa%23ss@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?ssl=0',
  ];

  for (const databaseUrl of urls) {
    assert.throws(
      () => parseConfig({ DATABASE_URL: databaseUrl, DATABASE_SSL_MODE: 'verify-full' }),
      (error: unknown) => error instanceof ConfigError && /SSL URL parameters/.test(error.message),
      `expected SSL URL parameters to be rejected: ${databaseUrl}`,
    );
  }
});

test('HC-04: local disposable DB uses sanitized connection fields with ssl disabled', () => {
  const local = buildDbPoolOptions(parseConfig({
    DATABASE_URL: 'postgres://postbro@127.0.0.1:5432/postbro',
    DATABASE_SSL_MODE: 'disable',
  }));

  assert.equal(local.connectionString, undefined);
  assert.equal(local.host, '127.0.0.1');
  assert.equal(local.port, 5432);
  assert.equal(local.database, 'postbro');
  assert.equal(local.user, 'postbro');
  assert.equal(local.ssl, false);
});

test('HC-04: hosted verify-full requires CA and returns effective verified TLS config', async () => {
  assert.throws(
    () => parseConfig({
      DATABASE_URL: 'postgres://postgres.project:pa%23ss@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres',
      DATABASE_SSL_MODE: 'verify-full',
    }),
    (error: unknown) => error instanceof ConfigError && /DATABASE_SSL_CA_PATH/.test(error.message),
  );

  const caPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'postbro-ca-')), 'ca.crt');
  await fs.writeFile(caPath, '-----BEGIN CERTIFICATE-----\nMIIBszCATpwCAQAwDQYJKoZIhvcNAQELBQAwADA=\n-----END CERTIFICATE-----\n', 'utf8');
  const hosted = buildDbPoolOptions(parseConfig({
    DATABASE_URL: 'postgres://postgres.project:pa%23ss@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres',
    DATABASE_SSL_MODE: 'verify-full',
    DATABASE_SSL_CA_PATH: caPath,
  }));

  assert.equal(hosted.connectionString, undefined);
  assert.equal(hosted.host, 'aws-0-ap-southeast-1.pooler.supabase.com');
  assert.equal(hosted.port, 5432);
  assert.equal(hosted.database, 'postgres');
  assert.equal(hosted.user, 'postgres.project');
  assert.equal(hosted.password, 'pa#ss');
  const ssl = hosted.ssl as { rejectUnauthorized: boolean; ca: string; checkServerIdentity?: unknown };
  assert.equal(ssl.rejectUnauthorized, true);
  assert.equal(ssl.ca.includes('BEGIN CERTIFICATE'), true);
  assert.equal(ssl.checkServerIdentity, undefined);
});
