import Fastify, { type FastifyInstance } from 'fastify';

import { parseConfig } from './config';
import {
  registerThreadsAuthRoutes,
  type ThreadsAuthRouteDeps,
} from './modules/auth/routes';

export interface BuildAppOptions {
  logger?: boolean;
  env?: NodeJS.ProcessEnv;
  /**
   * When provided (with pool, signing secret and OAuth client), enables
   * GET /auth/threads/start. Omitted by default so the app and /health run
   * without database or Meta configuration.
   */
  threadsAuth?: ThreadsAuthRouteDeps;
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

  if (options.threadsAuth) {
    registerThreadsAuthRoutes(app, options.threadsAuth);
  }

  return app;
}
