import { Pool } from 'pg';

import { type AppConfig, ConfigError, parseConfig } from '../config';

export function createDbPool(config: AppConfig = parseConfig()): Pool {
  if (!config.databaseUrl) {
    throw new ConfigError(['DATABASE_URL is required only when database operations are invoked']);
  }

  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  });
}

export async function closeDbPool(pool: Pool): Promise<void> {
  await pool.end();
}
