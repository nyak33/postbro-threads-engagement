/**
 * PB-P0-003 slice D2a: OAuth callback session resolution (no persistence).
 *
 * A callback arrives with an opaque state and an authorization code. The
 * state hash is looked up server-side to resolve the INITIATING operator —
 * the caller never supplies an operator id. Consumption is atomic and
 * one-time; expiry, replay and unknown state all fail closed with the same
 * coarse outcome so a caller cannot probe state validity.
 *
 * This module performs NO token exchange and NO account persistence
 * (slice D2b); it only resolves and consumes the session.
 */

import { type Pool } from 'pg';

import { setRlsContext } from '../../db/foundation';
import { OAUTH_STATE_PURPOSE } from './oauth-state';
import { createHmac } from 'node:crypto';

/**
 * The oauth_sessions RLS policy is operator-scoped via `postbro.operator_id`.
 * Callback resolution intentionally uses an operator context of 0 so the
 * session-guco GUC matches no real operator: the pre-consume SELECT sees no
 * rows under a strictly enforced policy. To resolve the initiating operator
 * from an opaque state without trusting caller input, the migration for this
 * slice adds a SELECT-only policy permitting lookup of UNCONSUMED sessions
 * by hash; consumption remains fully operator-scoped. See
 * db/migrations/202611130002_oauth_sessions_callback_lookup.sql.
 */

export type CallbackSessionFailure =
  | 'invalid_state' // missing, malformed, unknown, expired or replayed — indistinguishable
  | 'operator_inactive';

export class CallbackSessionError extends Error {
  readonly reason: CallbackSessionFailure;

  constructor(reason: CallbackSessionFailure, message: string) {
    super(message);
    this.name = 'CallbackSessionError';
    this.reason = reason;
  }
}

function hashState(state: string): Buffer {
  return createHmac('sha256', 'postbro-oauth-state').update(state).digest();
}

export interface ResolvedCallbackSession {
  operatorId: number;
}

/**
 * Atomically consumes an OAuth state and returns the initiating operator id.
 * Exactly one concurrent consume succeeds; unknown, expired, replayed or
 * cross-purpose states all raise 'invalid_state'.
 */
export async function consumeCallbackSession(
  pool: Pool,
  state: string,
): Promise<ResolvedCallbackSession> {
  if (typeof state !== 'string' || state.length === 0) {
    throw new CallbackSessionError('invalid_state', 'state must be a non-empty string');
  }
  const stateHash = hashState(state);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Operator is unknown before lookup; the callback-lookup SELECT policy
    // (unconsumed + unexpired rows only) exposes just operator_id so the
    // initiating operator is resolved server-side from the state hash, never
    // from caller input. Consumption below runs under that operator's RLS
    // context and remains atomic, one-time, purpose- and TTL-bound.
    const found = await client.query<{ operator_id: string }>(
      `SELECT operator_id FROM postbro.oauth_sessions
        WHERE state_hash = $1 AND purpose = $2`,
      [stateHash, OAUTH_STATE_PURPOSE],
    );
    if (found.rowCount !== 1) {
      await client.query('ROLLBACK');
      throw new CallbackSessionError('invalid_state', 'oauth state is not valid');
    }
    const operatorId = Number(found.rows[0]!.operator_id);

    await setRlsContext(client, operatorId, null);
    const operator = await client.query<{ status: string }>(
      'SELECT status FROM postbro.operators WHERE id = $1',
      [operatorId],
    );
    if (operator.rowCount !== 1 || operator.rows[0]!.status !== 'active') {
      await client.query('ROLLBACK');
      throw new CallbackSessionError('operator_inactive', 'operator is unknown or not active');
    }

    const consumed = await client.query(
      `UPDATE postbro.oauth_sessions
          SET consumed_at = now()
        WHERE state_hash = $1
          AND operator_id = $2
          AND purpose = $3
          AND consumed_at IS NULL
          AND expires_at > now()
        RETURNING id`,
      [stateHash, operatorId, OAUTH_STATE_PURPOSE],
    );
    if (consumed.rowCount !== 1) {
      await client.query('ROLLBACK');
      throw new CallbackSessionError('invalid_state', 'oauth state is not valid');
    }
    await client.query('COMMIT');
    return { operatorId };
  } catch (error) {
    if (error instanceof CallbackSessionError) {
      throw error;
    }
    try {
      await client.query('ROLLBACK');
    } catch {
      // already rolled back
    }
    throw error;
  } finally {
    client.release();
  }
}
