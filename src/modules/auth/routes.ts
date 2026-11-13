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
import type { TokenEncryptionKey } from '../../shared/token-crypto';
import { CallbackSessionError, consumeCallbackSession } from './callback-session';
import {
  LinkTokenError,
  consumeLinkToken,
  createOAuthSession,
} from './oauth-state';
import {
  PersistOAuthCompletionError,
  persistOAuthCompletion,
} from './persist-oauth';

export interface ThreadsAuthRouteDeps {
  pool: Pool;
  /** Server-side HMAC signing secret (APP_SIGNING_SECRET). Never exposed. */
  signingSecret: string;
  oauthClient: ThreadsOAuthClient;
  /**
   * AES-256-GCM key for encrypting token material before persistence.
   * Required: the callback never stores plaintext and fails closed without
   * a configured key.
   */
  tokenEncryptionKey: TokenEncryptionKey;
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
   * Slice D2b2 (final): resolves the initiating operator server-side from
   * the state hash, consumes the state atomically, runs the provider
   * sequence exchangeCode -> exchangeLongLived -> getMe, verifies the
   * immutable user id matches, then persists the account with AES-GCM
   * encrypted token material atomically via persistOAuthCompletion. Only
   * AFTER persistence success does it report status 'connected' with the
   * account id and VERIFIED granted scopes. Tokens, client secret, signing
   * secret and crypto key are never returned or logged.
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

    // Provider sequence (mock in tests; no network here). Token material
    // stays in memory and is handed to persistence, which encrypts it.
    let persisted;
    try {
      const shortLived = await deps.oauthClient.exchangeCode(code);
      const longLived = await deps.oauthClient.exchangeLongLived(shortLived.accessToken);
      const identity = await deps.oauthClient.getMe(longLived.accessToken);
      if (identity.id !== shortLived.userId) {
        return reply.code(502).send({ error: 'identity_mismatch' });
      }
      // Granted scopes are trusted ONLY from positively verified provider
      // evidence; requested scopes are never inferred as granted.
      const scopes = await deps.oauthClient.getGrantedScopes(longLived.accessToken);

      persisted = await persistOAuthCompletion(deps.pool, {
        operatorId,
        exchangeUserId: shortLived.userId,
        identityUserId: identity.id,
        username: identity.username,
        longLivedToken: longLived.accessToken,
        tokenExpiresInSeconds: longLived.expiresInSeconds,
        grantedScopes: scopes,
        encryptionKey: deps.tokenEncryptionKey,
      });
    } catch (error) {
      if (error instanceof ThreadsOAuthProviderError) {
        return reply.code(502).send({ error: 'provider_exchange_failed' });
      }
      if (error instanceof PersistOAuthCompletionError) {
        // Fail closed with no row changes (the persistence transaction
        // already rolled back) and a safe, non-misleading error.
        if (error.reason === 'provider_owned_by_other_operator') {
          return reply.code(403).send({ error: 'provider_owned_by_other_operator' });
        }
        if (error.reason === 'identity_mismatch') {
          return reply.code(502).send({ error: 'identity_mismatch' });
        }
        return reply.code(401).send({ error: 'invalid_state' });
      }
      throw error;
    }

    return reply.code(200).send({
      status: 'connected',
      accountId: persisted.accountId,
      operatorId,
      scopesVerified: persisted.scopesVerified,
      grantedScopes: persisted.grantedScopes,
    });
  });
}
