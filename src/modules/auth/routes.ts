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
import { ThreadsOAuthProviderError } from '../../integrations/threads/oauth-client';
import { CallbackSessionError, consumeCallbackSession } from './callback-session';
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

  /**
   * GET /auth/threads/callback?state=...&code=...
   *
   * Slice D2a: resolves the initiating operator server-side from the state
   * hash, consumes the state atomically, then runs the MOCK provider
   * sequence exchangeCode -> exchangeLongLived -> getMe and verifies the
   * immutable user id matches. NO account persistence happens here, so a
   * fully mocked success returns status 'simulation_pending_persistence'
   * (never a connected/success claim) and never exposes token material.
   */
  app.get('/auth/threads/callback', async (request, reply) => {
    const query = request.query as Record<string, unknown>;

    // Provider-reported error (user denied, etc.) — safe coarse mapping.
    if (typeof query.error === 'string' && query.error.length > 0) {
      return reply.code(400).send({ error: 'provider_error' });
    }

    const state = typeof query.state === 'string' ? query.state : '';
    const code = typeof query.code === 'string' ? query.code : '';
    if (state.length === 0 || code.length === 0) {
      return reply.code(400).send({ error: 'invalid_callback' });
    }

    let operatorId: number;
    try {
      const resolved = await consumeCallbackSession(deps.pool, state);
      operatorId = resolved.operatorId;
    } catch (error) {
      if (error instanceof CallbackSessionError) {
        // Unknown/expired/replayed state and inactive operator both fail
        // closed with the same coarse outcome.
        return reply.code(401).send({ error: 'invalid_state' });
      }
      throw error;
    }

    // Mock provider sequence (no network). Token material stays in memory
    // and is never returned or logged.
    let providerUserId: string;
    let scopesVerified: boolean;
    let grantedScopes: string[];
    try {
      const shortLived = await deps.oauthClient.exchangeCode(code);
      providerUserId = shortLived.userId;
      const longLived = await deps.oauthClient.exchangeLongLived(shortLived.accessToken);
      const identity = await deps.oauthClient.getMe(longLived.accessToken);
      if (identity.id !== providerUserId) {
        return reply.code(502).send({ error: 'identity_mismatch' });
      }
      const scopes = await deps.oauthClient.getGrantedScopes(longLived.accessToken);
      // Granted scopes are trusted ONLY from positively verified provider
      // evidence; requested scopes are never inferred as granted.
      scopesVerified = scopes.verified;
      grantedScopes = scopes.verified ? scopes.scopes : [];
    } catch (error) {
      if (error instanceof ThreadsOAuthProviderError) {
        return reply.code(502).send({ error: 'provider_exchange_failed' });
      }
      throw error;
    }

    return reply.code(200).send({
      status: 'simulation_pending_persistence',
      operatorId,
      providerUserId,
      scopesVerified,
      grantedScopes,
    });
  });
}
