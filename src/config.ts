export type NodeEnvironment = 'development' | 'test' | 'production';

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  port: number;
  appTimezone: string;
  publicBaseUrl?: string;
}

export class ConfigError extends Error {
  constructor(issues: string[]) {
    super(`Invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
  }
}

const NODE_ENVS = new Set<NodeEnvironment>(['development', 'test', 'production']);

function isNodeEnvironment(value: string): value is NodeEnvironment {
  return NODE_ENVS.has(value as NodeEnvironment);
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

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return {
    nodeEnv: nodeEnvValue as NodeEnvironment,
    port,
    appTimezone,
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
  };
}
