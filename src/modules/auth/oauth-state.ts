import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { type Pool } from 'pg';

import { setRlsContext } from '../../db/foundation';

/**
 * PB-P0-003 slice C: signed operator link tokens and OAuth state sessions.
 *
 * Link tokens:
 * - HMAC-SHA256 over `operatorId.jti.expiresAt.purpose`, base64url-encoded.
 * - Minted ONLY by a trusted operator context (future Telegram bot, PB-P0-004);
 *   never via unauthenticated HTTP. This module exposes mint + consume as
 *   service functions only.
 * - One-time: the jti is durably recorded at mint time and consumed atomically
 *   on first use; replay (including concurrent replay) is denied.
 * - Bootstraps exactly one Threads OAuth connect attempt; grants no general
 *   data or action access.
 *
 * OAuth state:
 * - >=128 bits from crypto.randomBytes, persisted ONLY as SHA-256 hash in
 *   postbro.oauth_sessions, bound to operator + purpose='threads_connect',
 *   default TTL 10 minutes, consumed atomically in a single UPDATE.
 */

export const LINK_TOKEN_TTL_MS = 5 * 60 * 1000;
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const OAUTH_STATE_BYTES = 32; // 256 bits >= required 128
export const OAUTH_STATE_PURPOSE = 'threads_connect';

export type LinkTokenConsumeFailure =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'replayed'
  | 'unknown_jti'
  | 'operator_inactive';

export class LinkTokenError extends Error {
  readonly reason: LinkTokenConsumeFailure;

  constructor(reason: LinkTokenConsumeFailure, message: string) {
    super(message);
    this.name = 'LinkTokenError';
    this.reason = reason;
  }
}

export type OAuthStateConsumeFailure = 'unknown' | 'expired' | 'replayed' | 'operator_inactive';

export class OAuthStateError extends Error {
  readonly reason: OAuthStateConsumeFailure;

  constructor(reason: OAuthStateConsumeFailure, message: string) {
    super(message);
    this.name = 'OAuthStateError';
    this.reason = reason;
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function signPayload(signingSecret: string, payload: string): string {
  return base64url(createHmac('sha256', signingSecret).update(payload).digest());
}

function safeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface MintLinkTokenInput {
  operatorId: number;
  signingSecret: string;
  now?: Date;
}

export interface MintLinkTokenResult {
  token: string;
  jti: string;
  expiresAt: Date;
}

/**
 * Mints a signed one-time link token and durably records its jti. Trusted
 * operator context only (future Telegram bot); never exposed over public HTTP.
 */
export async function mintLinkToken(
  pool: Pool,
  input: MintLinkTokenInput,
): Promise<MintLinkTokenResult> {
  if (!input.signingSecret || input.signingSecret.length < 32) {
    throw new LinkTokenError('malformed', 'signing secret must be at least 32 characters');
  }
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + LINK_TOKEN_TTL_MS);
  const jti = base64url(randomBytes(16));
  const payload = `${input.operatorId}.${jti}.${expiresAt.getTime()}.${OAUTH_STATE_PURPOSE}`;
  const token = `${payload}.${signPayload(input.signingSecret, payload)}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setRlsContext(client, input.operatorId, null);
    // Fail closed on unknown/disabled operator at mint time too.
    const operator = await client.query<{ status: string }>(
      'SELECT status FROM postbro.operators WHERE id = $1',
      [input.operatorId],
    );
    if (operator.rowCount !== 1 || operator.rows[0]!.status !== 'active') {
      throw new LinkTokenError('operator_inactive', 'operator is unknown or not active');
    }
    await client.query(
      `INSERT INTO postbro.link_token_nonces (jti, operator_id, purpose, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [jti, input.operatorId, OAUTH_STATE_PURPOSE, expiresAt],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return { token, jti, expiresAt };
}

export interface ConsumeLinkTokenInput {
  token: string;
  signingSecret: string;
  operatorId: number;
  now?: Date;
}

/**
 * Verifies and atomically consumes a link token. Exactly one concurrent
 * consume of a given jti succeeds; all others fail with 'replayed'.
 */
export async function consumeLinkToken(
  pool: Pool,
  input: ConsumeLinkTokenInput,
): Promise<{ jti: string }> {
  const parts = input.token.split('.');
  if (parts.length !== 5) {
    throw new LinkTokenError('malformed', 'link token has an invalid shape');
  }
  const [operatorIdRaw, jti, expiresAtRaw, purpose, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const operatorId = Number(operatorIdRaw);
  const expiresAtMs = Number(expiresAtRaw);
  if (
    !Number.isInteger(operatorId) ||
    operatorId !== input.operatorId ||
    !Number.isFinite(expiresAtMs) ||
    purpose !== OAUTH_STATE_PURPOSE ||
    !jti
  ) {
    throw new LinkTokenError('malformed', 'link token fields are invalid');
  }
  const payload = `${operatorIdRaw}.${jti}.${expiresAtRaw}.${purpose}`;
  const expected = signPayload(input.signingSecret, payload);
  if (!safeEqualString(signature, expected)) {
    throw new LinkTokenError('bad_signature', 'link token signature is invalid');
  }
  const now = input.now ?? new Date();
  if (now.getTime() >= expiresAtMs) {
    throw new LinkTokenError('expired', 'link token has expired');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setRlsContext(client, operatorId, null);
    const operator = await client.query<{ status: string }>(
      'SELECT status FROM postbro.operators WHERE id = $1',
      [operatorId],
    );
    if (operator.rowCount !== 1 || operator.rows[0]!.status !== 'active') {
      throw new LinkTokenError('operator_inactive', 'operator is unknown or not active');
    }
    // Atomic single-use consumption: only an unconsumed, unexpired row
    // transitions; concurrent replay loses the row lock race and affects 0 rows.
    const consumed = await client.query(
      `UPDATE postbro.link_token_nonces
          SET consumed_at = now()
        WHERE jti = $1
          AND operator_id = $2
          AND consumed_at IS NULL
          AND expires_at > now()
        RETURNING jti`,
      [jti, operatorId],
    );
    if (consumed.rowCount !== 1) {
      const existing = await client.query<{ consumed_at: Date | null }>(
        'SELECT consumed_at FROM postbro.link_token_nonces WHERE jti = $1 AND operator_id = $2',
        [jti, operatorId],
      );
      await client.query('ROLLBACK');
      if (existing.rowCount !== 1) {
        throw new LinkTokenError('unknown_jti', 'link token nonce was not issued');
      }
      throw new LinkTokenError('replayed', 'link token was already used or has expired');
    }
    await client.query('COMMIT');
    return { jti };
  } catch (error) {
    if (error instanceof LinkTokenError) {
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

export function generateOAuthState(): string {
  return base64url(randomBytes(OAUTH_STATE_BYTES));
}

function hashState(state: string): Buffer {
  return createHmac('sha256', 'postbro-oauth-state').update(state).digest();
}

export interface CreateOAuthSessionInput {
  operatorId: number;
  now?: Date;
}

export interface CreateOAuthSessionResult {
  state: string;
  expiresAt: Date;
}

/**
 * Creates an OAuth session: returns the random state to embed in the
 * authorize URL and persists ONLY its SHA-256-derived hash.
 */
export async function createOAuthSession(
  pool: Pool,
  input: CreateOAuthSessionInput,
): Promise<CreateOAuthSessionResult> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + OAUTH_STATE_TTL_MS);
  const state = generateOAuthState();
  const stateHash = hashState(state);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setRlsContext(client, input.operatorId, null);
    const operator = await client.query<{ status: string }>(
      'SELECT status FROM postbro.operators WHERE id = $1',
      [input.operatorId],
    );
    if (operator.rowCount !== 1 || operator.rows[0]!.status !== 'active') {
      throw new OAuthStateError('operator_inactive', 'operator is unknown or not active');
    }
    await client.query(
      `INSERT INTO postbro.oauth_sessions (operator_id, state_hash, purpose, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [input.operatorId, stateHash, OAUTH_STATE_PURPOSE, expiresAt],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return { state, expiresAt };
}

export interface ConsumeOAuthSessionInput {
  operatorId: number;
  state: string;
}

/**
 * Atomically validates and consumes an OAuth state for the given operator.
 * Unknown, expired, replayed or cross-operator states all fail closed and
 * never consume a different operator's session.
 */
export async function consumeOAuthSession(
  pool: Pool,
  input: ConsumeOAuthSessionInput,
): Promise<void> {
  if (typeof input.state !== 'string' || input.state.length === 0) {
    throw new OAuthStateError('unknown', 'state must be a non-empty string');
  }
  const stateHash = hashState(input.state);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setRlsContext(client, input.operatorId, null);
    const operator = await client.query<{ status: string }>(
      'SELECT status FROM postbro.operators WHERE id = $1',
      [input.operatorId],
    );
    if (operator.rowCount !== 1 || operator.rows[0]!.status !== 'active') {
      throw new OAuthStateError('operator_inactive', 'operator is unknown or not active');
    }
    // RLS scopes rows to this operator; a cross-operator state is invisible
    // and therefore 'unknown'.
    const consumed = await client.query(
      `UPDATE postbro.oauth_sessions
          SET consumed_at = now()
        WHERE state_hash = $1
          AND operator_id = $2
          AND purpose = $3
          AND consumed_at IS NULL
          AND expires_at > now()
        RETURNING id`,
      [stateHash, input.operatorId, OAUTH_STATE_PURPOSE],
    );
    if (consumed.rowCount !== 1) {
      const existing = await client.query<{ consumed_at: Date | null; expires_at: Date }>(
        `SELECT consumed_at, expires_at FROM postbro.oauth_sessions
          WHERE state_hash = $1 AND operator_id = $2 AND purpose = $3`,
        [stateHash, input.operatorId, OAUTH_STATE_PURPOSE],
      );
      await client.query('ROLLBACK');
      if (existing.rowCount !== 1) {
        throw new OAuthStateError('unknown', 'oauth state was not issued for this operator');
      }
      const row = existing.rows[0]!;
      if (row.consumed_at !== null) {
        throw new OAuthStateError('replayed', 'oauth state was already used');
      }
      throw new OAuthStateError('expired', 'oauth state has expired');
    }
    await client.query('COMMIT');
  } catch (error) {
    if (error instanceof OAuthStateError) {
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
