import { readFileSync } from 'node:fs';

import { Pool, type PoolConfig } from 'pg';

import { type AppConfig, ConfigError, parseConfig } from '../config';

function resolveSslMode(config: AppConfig): NonNullable<AppConfig['databaseSslMode']> {
  if (config.databaseSslMode) {
    return config.databaseSslMode;
  }
  if (!config.databaseUrl) {
    return 'disable';
  }
  const hostname = new URL(config.databaseUrl).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' ? 'disable' : 'verify-full';
}

export function buildDbPoolOptions(config: AppConfig = parseConfig()): PoolConfig {
  if (!config.databaseUrl) {
    throw new ConfigError(['DATABASE_URL is required only when database operations are invoked']);
  }

  const sslMode = resolveSslMode(config);
  const base: PoolConfig = {
    connectionString: config.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  };

  if (sslMode === 'disable') {
    return { ...base, ssl: false };
  }

  if (sslMode === 'require') {
    return { ...base, ssl: { rejectUnauthorized: true } };
  }

  if (!config.databaseSslCaPath) {
    throw new ConfigError(['DATABASE_SSL_CA_PATH is required when DATABASE_SSL_MODE is verify-ca or verify-full']);
  }
  const ca = readFileSync(config.databaseSslCaPath, 'utf8');
  if (sslMode === 'verify-ca') {
    return {
      ...base,
      ssl: {
        ca,
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined,
      },
    };
  }

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
