/**
 * PB-P0-003 slice D1: GET /auth/threads/start — consumes a signed one-time
 * operator link token, creates a hashed one-time OAuth state session and
 * redirects to the official Meta authorize URL. The redirect is returned to
 * the caller; this server never executes it.
 *
 * Fail closed: missing/malformed/expired/replayed/forged links all return a
 * generic 400/401 without revealing which check failed beyond a coarse
 * reason, and never leak tokens, secrets or other operators' data.
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import type { ThreadsOAuthClient } from '../../integrations/threads/oauth-client';
import {
  LinkTokenError,
  consumeLinkToken,
  createOAuthSession,
} from './oauth-state';

export interface ThreadsAuthRouteDeps {
  pool: Pool;
  /** Server-side HMAC signing secret (APP_SIGNING_SECRET). Never exposed. */
  signingSecret: string;
  oauthClient: ThreadsOAuthClient;
}

/**
 * Extracts the UNVERIFIED operator id from a link token solely to scope the
 * atomic consume; authenticity is enforced by consumeLinkToken's signature
 * check. Returns undefined when the shape is not plausible.
 */
function unverifiedOperatorIdFromToken(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 5) {
    return undefined;
  }
  const operatorId = Number(parts[0]);
  if (!Number.isInteger(operatorId) || operatorId <= 0) {
    return undefined;
  }
  return operatorId;
}

export function registerThreadsAuthRoutes(app: FastifyInstance, deps: ThreadsAuthRouteDeps): void {
  app.get('/auth/threads/start', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const link = typeof query.link === 'string' ? query.link : '';
    if (link.length === 0) {
      return reply.code(400).send({ error: 'invalid_link' });
    }

    const operatorId = unverifiedOperatorIdFromToken(link);
    if (operatorId === undefined) {
      return reply.code(400).send({ error: 'invalid_link' });
    }

    try {
      await consumeLinkToken(deps.pool, {
        token: link,
        signingSecret: deps.signingSecret,
        operatorId,
      });
    } catch (error) {
      // Fail closed, no detail that would aid forging; never leak the token.
      if (error instanceof LinkTokenError) {
        return reply.code(401).send({ error: 'link_not_accepted' });
      }
      throw error;
    }

    const session = await createOAuthSession(deps.pool, { operatorId });
    const authorizeUrl = deps.oauthClient.buildAuthorizeUrl({ state: session.state });
    return reply.code(302).header('location', authorizeUrl).send();
  });
}
