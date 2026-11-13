export type NodeEnvironment = 'development' | 'test' | 'production';
export type DatabaseSslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

export interface ThreadsOAuthConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  port: number;
  appTimezone: string;
  publicBaseUrl?: string;
  databaseUrl?: string;
  databaseSslMode?: DatabaseSslMode;
  databaseSslCaPath?: string;
  threadsOAuth?: ThreadsOAuthConfig;
  tokenEncryptionKeyId?: string;
  /** Raw 32-byte key, base64-encoded in env. Never logged. */
  tokenEncryptionKey?: Buffer;
  appSigningSecret?: string;
}

export class ConfigError extends Error {
  constructor(issues: string[]) {
    super(`Invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
  }
}

const NODE_ENVS = new Set<NodeEnvironment>(['development', 'test', 'production']);
const DATABASE_SSL_MODES = new Set<DatabaseSslMode>(['disable', 'require', 'verify-ca', 'verify-full']);

function isNodeEnvironment(value: string): value is NodeEnvironment {
  return NODE_ENVS.has(value as NodeEnvironment);
}

function isDatabaseSslMode(value: string): value is DatabaseSslMode {
  return DATABASE_SSL_MODES.has(value as DatabaseSslMode);
}

function isLocalDatabaseHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function hasSslUrlParameters(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (key === 'ssl' || key.startsWith('ssl')) {
      return true;
    }
  }
  return false;
}

/**
 * Canonical base path of a URL: pathname without trailing slashes ('/' -> '').
 */
function canonicalBasePath(url: URL): string {
  return url.pathname.replace(/\/+$/, '');
}

/**
 * True when `redirect` sits under `base`: identical origin (scheme, host,
 * port — no credentials allowed) and redirect path equal to the base path or
 * strictly below it on a '/' boundary. Compares parsed URL components, never
 * raw string prefixes.
 */
function isUrlUnderBase(redirect: URL, base: URL): boolean {
  if (redirect.origin !== base.origin) {
    return false;
  }
  const basePath = canonicalBasePath(base);
  if (redirect.pathname === basePath) {
    return true;
  }
  const prefix = basePath === '' ? '/' : `${basePath}/`;
  return redirect.pathname.startsWith(prefix);
}

export function parseConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const issues: string[] = [];

  const nodeEnvValue = env.NODE_ENV ?? 'development';
  if (!isNodeEnvironment(nodeEnvValue)) {
    issues.push('NODE_ENV must be one of: development, test, production');
  }

  const portValue = env.PORT ?? '3000';
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    issues.push('PORT must be an integer between 0 and 65535');
  }

  const appTimezone = (env.APP_TIMEZONE ?? 'Asia/Kuala_Lumpur').trim();
  if (appTimezone.length === 0) {
    issues.push('APP_TIMEZONE must not be empty');
  }

  const publicBaseUrlValue = env.PUBLIC_BASE_URL?.trim();
  let publicBaseUrl: string | undefined;
  let publicBaseUrlParsed: URL | undefined;
  if (publicBaseUrlValue) {
    try {
      const parsed = new URL(publicBaseUrlValue);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        issues.push('PUBLIC_BASE_URL must use http or https');
      } else if (parsed.username !== '' || parsed.password !== '') {
        issues.push('PUBLIC_BASE_URL must not contain credentials');
      } else {
        publicBaseUrlParsed = parsed;
        publicBaseUrl = parsed.toString();
      }
    } catch {
      issues.push('PUBLIC_BASE_URL must be a valid URL');
    }
  }

  const databaseUrlValue = env.DATABASE_URL?.trim();
  let databaseUrl: string | undefined;
  let databaseHostIsLocal = false;
  if (databaseUrlValue) {
    try {
      const parsed = new URL(databaseUrlValue);
      if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
        issues.push('DATABASE_URL must use postgres or postgresql protocol');
      } else {
        if (parsed.port === '6543') {
          issues.push('DATABASE_URL port 6543 is a transaction pooler; use direct/session port 5432 for PostBro migration and persistent runtime connections');
        }
        if (hasSslUrlParameters(parsed)) {
          issues.push('SSL URL parameters are not allowed in DATABASE_URL; use DATABASE_SSL_MODE and DATABASE_SSL_CA_PATH so node-postgres URL parameters cannot override TLS verification');
        }
        databaseHostIsLocal = isLocalDatabaseHost(parsed.hostname);
        databaseUrl = databaseUrlValue;
      }
    } catch {
      issues.push('DATABASE_URL must be a valid PostgreSQL URL');
    }
  }

  const databaseSslModeValue = env.DATABASE_SSL_MODE?.trim();
  let databaseSslMode: DatabaseSslMode | undefined;
  if (databaseSslModeValue) {
    if (!isDatabaseSslMode(databaseSslModeValue)) {
      issues.push('DATABASE_SSL_MODE must be one of: disable, require, verify-ca, verify-full');
    } else if (databaseUrl && !databaseHostIsLocal && databaseSslModeValue !== 'verify-full') {
      issues.push('DATABASE_SSL_MODE must be verify-full for non-local hosted PostgreSQL connections');
    } else {
      databaseSslMode = databaseSslModeValue;
    }
  } else if (databaseUrl) {
    databaseSslMode = databaseHostIsLocal ? 'disable' : 'verify-full';
  }

  const databaseSslCaPathValue = env.DATABASE_SSL_CA_PATH?.trim();
  let databaseSslCaPath: string | undefined;
  if (databaseSslCaPathValue) {
    databaseSslCaPath = databaseSslCaPathValue;
  }
  if ((databaseSslMode === 'verify-ca' || databaseSslMode === 'verify-full') && !databaseSslCaPath) {
    issues.push('DATABASE_SSL_CA_PATH is required when DATABASE_SSL_MODE is verify-ca or verify-full');
  }

  // --- Threads OAuth config (PB-P0-003 slice A) ------------------------------
  // Optional: when NO OAuth-related env vars are set, the module stays disabled
  // and unrelated endpoints/tests run without Meta credentials. When ANY OAuth
  // var is present, the full set must be present and valid (fail fast).
  const threadsAppId = env.THREADS_APP_ID?.trim();
  const threadsAppSecret = env.THREADS_APP_SECRET?.trim();
  const threadsRedirectUriValue = env.THREADS_REDIRECT_URI?.trim();
  const threadsScopesValue = env.THREADS_SCOPES?.trim();
  const anyThreadsVarSet =
    threadsAppId !== undefined ||
    threadsAppSecret !== undefined ||
    threadsRedirectUriValue !== undefined ||
    threadsScopesValue !== undefined;

  let threadsOAuth: ThreadsOAuthConfig | undefined;
  if (anyThreadsVarSet) {
    if (!threadsAppId) {
      issues.push('THREADS_APP_ID is required when Threads OAuth is configured');
    }
    if (!threadsAppSecret) {
      issues.push('THREADS_APP_SECRET is required when Threads OAuth is configured');
    }
    let redirectUri: URL | undefined;
    if (!threadsRedirectUriValue) {
      issues.push('THREADS_REDIRECT_URI is required when Threads OAuth is configured');
    } else {
      try {
        redirectUri = new URL(threadsRedirectUriValue);
        if (redirectUri.username !== '' || redirectUri.password !== '') {
          issues.push('THREADS_REDIRECT_URI must not contain credentials');
        } else if (redirectUri.hash !== '') {
          issues.push('THREADS_REDIRECT_URI must not contain a fragment');
        } else if (redirectUri.search !== '') {
          issues.push('THREADS_REDIRECT_URI must not contain a query string');
        } else if (redirectUri.protocol !== 'https:') {
          if (!(nodeEnvValue !== 'production' && isLocalDatabaseHost(redirectUri.hostname))) {
            issues.push('THREADS_REDIRECT_URI must be an absolute HTTPS URL');
          }
        }
      } catch {
        issues.push('THREADS_REDIRECT_URI must be a valid absolute URL');
      }
    }
    if (!threadsScopesValue) {
      issues.push('THREADS_SCOPES is required when Threads OAuth is configured');
    }
    const scopes = (threadsScopesValue ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (threadsScopesValue && !scopes.includes('threads_basic')) {
      issues.push('THREADS_SCOPES must include threads_basic');
    }
    // In production the exact OAuth redirect URI must sit under the secure
    // public origin: same origin (scheme+host+port), HTTPS, and redirect path
    // on or below the PUBLIC_BASE_URL path on a '/' boundary. Comparison uses
    // parsed URL components, never string prefixes.
    if (nodeEnvValue === 'production' && redirectUri && redirectUri.protocol === 'https:') {
      if (!publicBaseUrlParsed) {
        issues.push('PUBLIC_BASE_URL is required in production when Threads OAuth is configured');
      } else if (publicBaseUrlParsed.protocol !== 'https:') {
        issues.push('PUBLIC_BASE_URL must use https in production when Threads OAuth is configured');
      } else if (!isUrlUnderBase(redirectUri, publicBaseUrlParsed)) {
        issues.push('THREADS_REDIRECT_URI origin must match PUBLIC_BASE_URL and its path must stay under the PUBLIC_BASE_URL path in production');
      }
    }
    if (
      threadsAppId &&
      threadsAppSecret &&
      redirectUri &&
      scopes.length > 0
    ) {
      threadsOAuth = {
        appId: threadsAppId,
        appSecret: threadsAppSecret,
        redirectUri: redirectUri.toString(),
        scopes,
      };
    }
  }

  // --- Token encryption key ---------------------------------------------------
  const tokenEncryptionKeyValue = env.TOKEN_ENCRYPTION_KEY?.trim();
  const tokenEncryptionKeyIdValue = env.TOKEN_ENCRYPTION_KEY_ID?.trim();
  let tokenEncryptionKey: Buffer | undefined;
  if (tokenEncryptionKeyValue) {
    try {
      const decoded = Buffer.from(tokenEncryptionKeyValue, 'base64');
      if (decoded.length !== 32) {
        issues.push('TOKEN_ENCRYPTION_KEY must be base64 of exactly 32 bytes');
      } else {
        tokenEncryptionKey = decoded;
      }
    } catch {
      issues.push('TOKEN_ENCRYPTION_KEY must be valid base64');
    }
    if (!tokenEncryptionKeyIdValue) {
      issues.push('TOKEN_ENCRYPTION_KEY_ID is required when TOKEN_ENCRYPTION_KEY is set');
    }
  } else if (tokenEncryptionKeyIdValue) {
    issues.push('TOKEN_ENCRYPTION_KEY_ID requires TOKEN_ENCRYPTION_KEY');
  }

  // --- Link-token signing secret ----------------------------------------------
  const appSigningSecret = env.APP_SIGNING_SECRET?.trim();
  if (appSigningSecret !== undefined && appSigningSecret.length > 0 && appSigningSecret.length < 32) {
    issues.push('APP_SIGNING_SECRET must be at least 32 characters when set');
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return {
    nodeEnv: nodeEnvValue as NodeEnvironment,
    port,
    appTimezone,
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    ...(databaseUrl ? { databaseUrl } : {}),
    ...(databaseSslMode ? { databaseSslMode } : {}),
    ...(databaseSslCaPath ? { databaseSslCaPath } : {}),
    ...(threadsOAuth ? { threadsOAuth } : {}),
    ...(tokenEncryptionKey ? { tokenEncryptionKey } : {}),
    ...(tokenEncryptionKeyIdValue && tokenEncryptionKey
      ? { tokenEncryptionKeyId: tokenEncryptionKeyIdValue }
      : {}),
    ...(appSigningSecret ? { appSigningSecret } : {}),
  };
}
