import { readFileSync } from 'node:fs';

import { Pool, type PoolConfig } from 'pg';

import { type AppConfig, ConfigError, parseConfig } from '../config';

function isLocalDatabaseHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function resolveSslMode(config: AppConfig, hostname: string): NonNullable<AppConfig['databaseSslMode']> {
  if (config.databaseSslMode) {
    return config.databaseSslMode;
  }
  return isLocalDatabaseHost(hostname) ? 'disable' : 'verify-full';
}

function assertNoSslUrlParameters(url: URL): void {
  for (const key of url.searchParams.keys()) {
    if (key === 'ssl' || key.startsWith('ssl')) {
      throw new ConfigError(['SSL URL parameters are not allowed in DATABASE_URL; use DATABASE_SSL_MODE and DATABASE_SSL_CA_PATH']);
    }
  }
}

export function buildDbPoolOptions(config: AppConfig = parseConfig()): PoolConfig {
  if (!config.databaseUrl) {
    throw new ConfigError(['DATABASE_URL is required only when database operations are invoked']);
  }

  const parsed = new URL(config.databaseUrl);
  assertNoSslUrlParameters(parsed);
  const sslMode = resolveSslMode(config, parsed.hostname);
  const base: PoolConfig = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    database: parsed.pathname.replace(/^\//, '') || 'postgres',
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  };

  if (sslMode === 'disable') {
    if (!isLocalDatabaseHost(parsed.hostname)) {
      throw new ConfigError(['DATABASE_SSL_MODE must be verify-full for non-local hosted PostgreSQL connections']);
    }
    return { ...base, ssl: false };
  }

  if (sslMode === 'require' || sslMode === 'verify-ca') {
    if (!isLocalDatabaseHost(parsed.hostname)) {
      throw new ConfigError(['DATABASE_SSL_MODE must be verify-full for non-local hosted PostgreSQL connections']);
    }
    return { ...base, ssl: { rejectUnauthorized: true } };
  }

  if (!config.databaseSslCaPath) {
    throw new ConfigError(['DATABASE_SSL_CA_PATH is required when DATABASE_SSL_MODE is verify-full']);
  }
  const ca = readFileSync(config.databaseSslCaPath, 'utf8');
  return {
    ...base,
    ssl: {
      ca,
      rejectUnauthorized: true,
    },
  };
}

export function createDbPool(config: AppConfig = parseConfig()): Pool {
  return new Pool(buildDbPoolOptions(config));
}

export async function closeDbPool(pool: Pool): Promise<void> {
  await pool.end();
}
