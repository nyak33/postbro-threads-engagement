import { randomUUID } from 'node:crypto';

import { type Pool, type PoolClient } from 'pg';

import { redactErrorMessage, redactProviderMetadata } from './redaction';

export interface AuthorizedAccount {
  id: number;
  providerId: string;
  username: string | null;
  status: string;
  scopes: string[];
}

export interface ClaimedJob {
  id: number;
  leaseToken: string;
  attempts: number;
}

export interface RecordAuditEventInput {
  operatorId: number | null;
  accountId: number;
  action: string;
  reason?: string;
  outcome: string;
  metadata?: Record<string, unknown>;
}

export async function setRlsContext(client: PoolClient, operatorId: number, accountId: number | null): Promise<void> {
  await client.query('SELECT set_config($1, $2, true), set_config($3, $4, true)', [
    'postbro.operator_id',
    String(operatorId),
    'postbro.account_id',
    String(accountId ?? 0),
  ]);
}

async function withRlsContext<T>(
  pool: Pool,
  operatorId: number,
  accountId: number | null,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setRlsContext(client, operatorId, accountId);
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getAuthorizedAccount(
  pool: Pool,
  operatorId: number,
  accountId: number,
): Promise<AuthorizedAccount | null> {
  return withRlsContext(pool, operatorId, accountId, async (client) => {
    const result = await client.query<{
      id: string;
      provider_id: string;
      username: string | null;
      status: string;
      scopes: string[];
    }>(
      `SELECT ta.id, ta.provider_id, ta.username, ta.status, ta.scopes
       FROM postbro.operators o
       JOIN postbro.operator_accounts oa
         ON oa.operator_id = o.id
       JOIN postbro.threads_accounts ta
         ON ta.id = oa.account_id
       JOIN postbro.persona_bindings pb
         ON pb.account_id = ta.id
        AND pb.status = 'active'
       WHERE o.id = $1
         AND o.status = 'active'
         AND ta.id = $2
         AND ta.status = 'active'`,
      [operatorId, accountId],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      id: Number(row.id),
      providerId: row.provider_id,
      username: row.username,
      status: row.status,
      scopes: row.scopes,
    };
  });
}

export async function claimDueJob(pool: Pool, accountId: number, workerId: string): Promise<ClaimedJob | null> {
  const leaseToken = randomUUID();
  return withRlsContext(pool, 0, accountId, async (client) => {
    await client.query(
      `UPDATE postbro.publish_jobs pj
       SET status = 'needs_reconciliation',
           claimed_by = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           last_error = 'lease expired after provider attempt',
           updated_at = now()
       WHERE pj.account_id = $1::bigint
         AND pj.status IN ('claimed', 'processing')
         AND pj.lease_expires_at <= now()
         AND EXISTS (
           SELECT 1
           FROM postbro.execution_attempts ea
           WHERE ea.account_id = pj.account_id
             AND ea.job_id = pj.id
         )`,
      [accountId],
    );

    const result = await client.query<{ id: string; attempts: number }>(
      `UPDATE postbro.publish_jobs pj
       SET status = 'claimed',
           claimed_by = $2,
           lease_token = $3,
           lease_expires_at = now() + interval '5 minutes',
           attempts = pj.attempts + 1,
           updated_at = now()
       WHERE pj.account_id = $1::bigint
         AND pj.id = (
           SELECT p2.id
           FROM postbro.publish_jobs p2
           WHERE p2.account_id = $1::bigint
             AND (
               (p2.status = 'pending' AND p2.due_at <= now())
               OR (
                 p2.status IN ('claimed', 'processing')
                 AND p2.lease_expires_at <= now()
                 AND NOT EXISTS (
                   SELECT 1
                   FROM postbro.execution_attempts ea
                   WHERE ea.account_id = p2.account_id
                     AND ea.job_id = p2.id
                 )
               )
             )
           ORDER BY COALESCE(p2.lease_expires_at, p2.due_at), p2.id
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
       RETURNING pj.id, pj.attempts`,
      [accountId, workerId, leaseToken],
    );

    const row = result.rows[0];
    return row ? { id: Number(row.id), leaseToken, attempts: row.attempts } : null;
  });
}

export async function completeClaimedJob(
  pool: Pool,
  accountId: number,
  jobId: number,
  leaseToken: string,
  outcome: 'confirmed' | 'failed',
): Promise<boolean> {
  return withRlsContext(pool, 0, accountId, async (client) => {
    const result = await client.query(
      `UPDATE postbro.publish_jobs
       SET status = $4,
           claimed_by = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = now()
       WHERE account_id = $1
         AND id = $2
         AND lease_token = $3
         AND lease_expires_at > now()
         AND status IN ('claimed', 'processing')`,
      [accountId, jobId, leaseToken, outcome],
    );
    return result.rowCount === 1;
  });
}

export async function markJobNeedsReconciliation(
  pool: Pool,
  accountId: number,
  jobId: number,
  leaseToken: string,
  reason: string,
): Promise<boolean> {
  const safeReason = redactErrorMessage(reason);
  return withRlsContext(pool, 0, accountId, async (client) => {
    const result = await client.query(
      `UPDATE postbro.publish_jobs
       SET status = 'needs_reconciliation',
           claimed_by = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           last_error = $4,
           updated_at = now()
       WHERE account_id = $1
         AND id = $2
         AND lease_token = $3
         AND lease_expires_at > now()
         AND status IN ('claimed', 'processing')`,
      [accountId, jobId, leaseToken, safeReason],
    );
    return result.rowCount === 1;
  });
}

const APPROVAL_AUTHZ_AND_SOURCE_SQL = `
  AND EXISTS (
    SELECT 1
    FROM postbro.operators o
    JOIN postbro.operator_accounts oa
      ON oa.operator_id = o.id
     AND oa.account_id = a.account_id
    JOIN postbro.threads_accounts ta
      ON ta.id = a.account_id
    JOIN postbro.persona_bindings pb
      ON pb.account_id = ta.id
     AND pb.status = 'active'
    WHERE o.id = a.operator_id
      AND o.status = 'active'
      AND ta.status = 'active'
  )
  AND (
    (
      a.proposal_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM postbro.engagement_proposals ep
        WHERE ep.account_id = a.account_id
          AND ep.id = a.proposal_id
          AND ep.status = 'pending'
          AND ep.version = a.version
      )
    )
    OR (
      a.draft_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM postbro.drafts d
        WHERE d.account_id = a.account_id
          AND d.id = a.draft_id
          AND d.status IN ('draft', 'approved')
          AND d.version = a.version
      )
    )
  )`;

export async function approveApproval(pool: Pool, operatorId: number, accountId: number, approvalId: number): Promise<boolean> {
  return withRlsContext(pool, operatorId, accountId, async (client) => {
    const result = await client.query(
      `UPDATE postbro.approvals a
       SET status = 'approved', decided_at = now()
       WHERE a.id = $3
         AND a.account_id = $2
         AND a.operator_id = $1
         AND a.status = 'pending'
         AND a.expires_at > now()
         ${APPROVAL_AUTHZ_AND_SOURCE_SQL}`,
      [operatorId, accountId, approvalId],
    );
    return result.rowCount === 1;
  });
}

export async function rejectApproval(pool: Pool, operatorId: number, accountId: number, approvalId: number): Promise<boolean> {
  return withRlsContext(pool, operatorId, accountId, async (client) => {
    const result = await client.query(
      `UPDATE postbro.approvals a
       SET status = 'rejected', decided_at = now()
       WHERE a.id = $3
         AND a.account_id = $2
         AND a.operator_id = $1
         AND a.status = 'pending'
         AND a.expires_at > now()
         ${APPROVAL_AUTHZ_AND_SOURCE_SQL}`,
      [operatorId, accountId, approvalId],
    );
    return result.rowCount === 1;
  });
}

export async function supersedePendingApprovals(
  pool: Pool,
  operatorId: number,
  accountId: number,
  actionKey: string,
): Promise<number> {
  return withRlsContext(pool, operatorId, accountId, async (client) => {
    const result = await client.query(
      `UPDATE postbro.approvals
       SET status = 'superseded', decided_at = now()
       WHERE account_id = $2
         AND operator_id = $1
         AND action_key = $3
         AND status = 'pending'`,
      [operatorId, accountId, actionKey],
    );
    return result.rowCount ?? 0;
  });
}

export async function consumeOauthSession(pool: Pool, operatorId: number, stateHash: Buffer): Promise<boolean> {
  return withRlsContext(pool, operatorId, null, async (client) => {
    const result = await client.query(
      `UPDATE postbro.oauth_sessions
       SET consumed_at = now()
       WHERE operator_id = $1
         AND state_hash = $2
         AND consumed_at IS NULL
         AND expires_at > now()
       RETURNING id`,
      [operatorId, stateHash],
    );
    return result.rowCount === 1;
  });
}

export async function recordExecutionAttempt(
  pool: Pool,
  accountId: number,
  jobId: number,
  actionKey: string,
  attemptNo: number,
  outcome: 'success' | 'failed' | 'ambiguous' | 'needs_reconciliation',
  providerRequest: Record<string, unknown>,
  providerResponse: Record<string, unknown> = {},
): Promise<number> {
  const safeRequest = redactProviderMetadata(providerRequest);
  const safeResponse = redactProviderMetadata(providerResponse);
  return withRlsContext(pool, 0, accountId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO postbro.execution_attempts (account_id, job_id, action_key, attempt_no, outcome, provider_request, provider_response)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [accountId, jobId, actionKey, attemptNo, outcome, safeRequest, safeResponse],
    );
    return Number(result.rows[0]!.id);
  });
}

export async function recordAuditEvent(pool: Pool, input: RecordAuditEventInput): Promise<number> {
  const safeReason = input.reason === undefined ? null : redactErrorMessage(input.reason);
  const safeMetadata = redactProviderMetadata(input.metadata ?? {});

  return withRlsContext(pool, input.operatorId ?? 0, input.accountId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO postbro.audit_events (actor_type, operator_id, account_id, action, reason, outcome, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.operatorId === null ? 'system' : 'operator',
        input.operatorId,
        input.accountId,
        input.action,
        safeReason,
        input.outcome,
        safeMetadata,
      ],
    );
    return Number(result.rows[0]!.id);
  });
}
