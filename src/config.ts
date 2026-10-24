export type NodeEnvironment = 'development' | 'test' | 'production';
export type DatabaseSslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  port: number;
  appTimezone: string;
  publicBaseUrl?: string;
  databaseUrl?: string;
  databaseSslMode?: DatabaseSslMode;
  databaseSslCaPath?: string;
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
  if (publicBaseUrlValue) {
    try {
      const parsed = new URL(publicBaseUrlValue);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        issues.push('PUBLIC_BASE_URL must use http or https');
      } else {
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
  };
}
