/**
 * PB-P0-003 slice D2b1: persist a simulated Threads OAuth completion.
 *
 * Service only — no route wiring (D2b2). The CALLER (callback route) must
 * already have verified the immutable provider user id equality between the
 * token exchange and /me before invoking this service; it is re-asserted
 * here as a defensive check.
 *
 * Guarantees:
 * - Token material is AES-256-GCM encrypted in memory via token-crypto and
 *   only ciphertext + key id + expiry reach the database. Plaintext never
 *   touches the DB, logs or errors.
 * - Granted scopes recorded ONLY from positively verified provider evidence;
 *   unverified evidence stores an empty scope list (feature-gated).
 * - Atomicity and ownership enforcement live in the DB function
 *   postbro.connect_threads_account (SECURITY DEFINER, row lock, same-owner
 *   reconnect, cross-operator takeover rejected); nothing is written outside
 *   that single call, so failures leave no partial data.
 */

import { type Pool } from 'pg';

import {
  encryptToken,
  type TokenEncryptionKey,
} from '../../shared/token-crypto';

export type PersistFailure =
  | 'identity_mismatch'
  | 'invalid_input'
  | 'operator_inactive'
  | 'provider_owned_by_other_operator';

export class PersistOAuthCompletionError extends Error {
  readonly reason: PersistFailure;

  constructor(reason: PersistFailure, message: string) {
    super(message);
    this.name = 'PersistOAuthCompletionError';
    this.reason = reason;
  }
}

export interface PersistOAuthCompletionInput {
  operatorId: number;
  /** Immutable provider user id from the token exchange. */
  exchangeUserId: string;
  /** Immutable provider user id from GET /me. */
  identityUserId: string;
  username?: string | undefined;
  /** Long-lived token plaintext — encrypted in memory, never persisted raw. */
  longLivedToken: string;
  /** Seconds until the long-lived token expires, if reported. */
  tokenExpiresInSeconds?: number | undefined;
  /** Positively verified granted-scope evidence; unverified => empty. */
  grantedScopes: { verified: boolean; scopes: string[] };
  encryptionKey: TokenEncryptionKey;
  now?: Date;
}

export interface PersistOAuthCompletionResult {
  accountId: number;
  scopesVerified: boolean;
  grantedScopes: string[];
}

function mapDbError(error: unknown): PersistOAuthCompletionError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('provider_owned_by_other_operator')) {
    return new PersistOAuthCompletionError(
      'provider_owned_by_other_operator',
      'provider account is owned by a different operator',
    );
  }
  if (message.includes('operator_inactive')) {
    return new PersistOAuthCompletionError('operator_inactive', 'operator is unknown or not active');
  }
  if (message.includes('invalid_ciphertext') || message.includes('invalid_input')) {
    return new PersistOAuthCompletionError('invalid_input', 'invalid persistence input');
  }
  return new PersistOAuthCompletionError('invalid_input', 'persistence failed');
}

export async function persistOAuthCompletion(
  pool: Pool,
  input: PersistOAuthCompletionInput,
): Promise<PersistOAuthCompletionResult> {
  if (
    !Number.isInteger(input.operatorId) ||
    input.operatorId <= 0 ||
    typeof input.exchangeUserId !== 'string' ||
    input.exchangeUserId.length === 0 ||
    typeof input.longLivedToken !== 'string' ||
    input.longLivedToken.length === 0
  ) {
    throw new PersistOAuthCompletionError('invalid_input', 'invalid persistence input');
  }
  // Defensive re-check: the callback must have verified this already.
  if (input.identityUserId !== input.exchangeUserId) {
    throw new PersistOAuthCompletionError(
      'identity_mismatch',
      'provider identity does not match token exchange user id',
    );
  }

  const now = input.now ?? new Date();
  const expiresAt =
    typeof input.tokenExpiresInSeconds === 'number' && input.tokenExpiresInSeconds > 0
      ? new Date(now.getTime() + input.tokenExpiresInSeconds * 1000)
      : null;

  // Encrypt in memory; only the serialized ciphertext payload is stored.
  const ciphertextJson = encryptToken(input.longLivedToken, input.encryptionKey);
  const ciphertext = Buffer.from(ciphertextJson, 'utf8');

  const scopesVerified = input.grantedScopes.verified === true;
  const scopes = scopesVerified ? input.grantedScopes.scopes : [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The SECURITY DEFINER function runs as owner and performs the locked,
    // ownership-checked insert/update atomically; no RLS GUCs are needed or
    // set here beyond keeping the transaction scoped to this call.
    const result = await client.query<{ account_id: string }>(
      `SELECT postbro.connect_threads_account($1, $2, $3, $4, $5, $6, $7) AS account_id`,
      [
        input.operatorId,
        input.exchangeUserId,
        input.username ?? null,
        scopes,
        ciphertext,
        input.encryptionKey.keyId,
        expiresAt,
      ],
    );
    await client.query('COMMIT');
    return {
      accountId: Number(result.rows[0]!.account_id),
      scopesVerified,
      grantedScopes: scopes,
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // already rolled back
    }
    if (error instanceof PersistOAuthCompletionError) {
      throw error;
    }
    throw mapDbError(error);
  } finally {
    client.release();
  }
}
