import Fastify, { type FastifyInstance } from 'fastify';

import { parseConfig } from './config';

export interface BuildAppOptions {
  logger?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = parseConfig(options.env ?? process.env);
  const app = Fastify({ logger: options.logger ?? false });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'postbro',
    timestamp: new Date().toISOString(),
    timezone: config.appTimezone,
  }));

  return app;
}
