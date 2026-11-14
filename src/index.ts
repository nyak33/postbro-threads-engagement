/**
 * PB-P0-004 slice B: production startup wiring.
 *
 * Behavior:
 * - /health works without any Meta/DB configuration (existing contract).
 * - Threads auth routes are registered ONLY when the full required config
 *   set is present and valid: DATABASE_URL (+ TLS), THREADS_* OAuth config,
 *   TOKEN_ENCRYPTION_KEY(+ID), APP_SIGNING_SECRET. Partial configuration
 *   fails fast in parseConfig; when none of it is set, login stays
 *   disabled (no mock fallback ever in production).
 * - The REAL ThreadsHttpOAuthClient is the only client wired here; no Meta
 *   network call is made at startup.
 * - The server binds to APP_HOST (default 127.0.0.1 loopback) so a reverse
 *   proxy fronts it; '0.0.0.0' requires explicit opt-in via APP_HOST.
 * - Secrets are never logged; graceful SIGINT/SIGTERM shutdown closes the
 *   Fastify app and the DB pool.
 */

import { buildApp } from './app';
import { parseConfig, type AppConfig } from './config';
import { closeDbPool, createDbPool } from './db/client';
import { ThreadsHttpOAuthClient } from './integrations/threads/oauth-client-http';
import type { ThreadsAuthRouteDeps } from './modules/auth/routes';
import type { Pool } from 'pg';

/** Loopback default: the node app is expected behind a reverse proxy. */
const DEFAULT_BIND_HOST = '127.0.0.1';

/**
 * Builds the Threads auth route dependencies when — and only when — the
 * complete required config is present. Returns undefined to leave login
 * disabled; never falls back to a mock client.
 */
export function buildThreadsAuthDeps(
  config: AppConfig,
  createPool: (cfg: AppConfig) => Pool = createDbPool,
): ThreadsAuthRouteDeps | undefined {
  const { threadsOAuth, tokenEncryptionKey, tokenEncryptionKeyId, appSigningSecret } = config;
  if (!threadsOAuth && !tokenEncryptionKey && !appSigningSecret && !config.databaseUrl) {
    return undefined; // auth not configured at all; login stays disabled
  }
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required when Threads auth is configured');
  }
  if (!threadsOAuth) {
    throw new Error('THREADS_* OAuth config is required when Threads auth is configured');
  }
  if (!tokenEncryptionKey || !tokenEncryptionKeyId) {
    throw new Error('TOKEN_ENCRYPTION_KEY and TOKEN_ENCRYPTION_KEY_ID are required');
  }
  if (!appSigningSecret) {
    throw new Error('APP_SIGNING_SECRET is required when Threads auth is configured');
  }
  return {
    pool: createPool(config),
    signingSecret: appSigningSecret,
    oauthClient: new ThreadsHttpOAuthClient({ config: threadsOAuth }),
    tokenEncryptionKey: { keyId: tokenEncryptionKeyId, key: tokenEncryptionKey },
  };
}

async function main(): Promise<void> {
  const config = parseConfig();
  const host = (process.env.APP_HOST ?? DEFAULT_BIND_HOST).trim() || DEFAULT_BIND_HOST;

  let pool: Pool | undefined;
  try {
    const deps = buildThreadsAuthDeps(config);
    pool = deps?.pool;
    const app = buildApp({ logger: true, ...(deps ? { threadsAuth: deps } : {}) });

    const shutdown = async (signal: string): Promise<void> => {
      app.log.info({ signal }, 'shutting down');
      try {
        await app.close();
      } finally {
        if (pool) {
          await closeDbPool(pool);
        }
      }
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    await app.listen({ host, port: config.port });
    app.log.info(
      {
        host,
        port: config.port,
        threadsAuthEnabled: deps !== undefined,
      },
      'postbro listening',
    );
  } catch (error) {
    // Never log config/secrets; error messages from config are sanitized
    // issue lists only. Close the pool on startup failure.
    if (pool) {
      await closeDbPool(pool).catch(() => undefined);
    }
    process.stderr.write(
      `${error instanceof Error ? error.message : 'startup failed'}\n`,
    );
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
