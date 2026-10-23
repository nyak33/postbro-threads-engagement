import { randomUUID } from 'node:crypto';

import { type Pool, type PoolClient } from 'pg';

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
         SELECT id
         FROM postbro.publish_jobs
         WHERE status = 'pending'
           AND due_at <= now()
         ORDER BY due_at, id
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
         AND status IN ('claimed', 'processing')`,
      [accountId, jobId, leaseToken, reason],
    );
    return result.rowCount === 1;
  });
}

export async function approveApproval(pool: Pool, operatorId: number, accountId: number, approvalId: number): Promise<boolean> {
  return withRlsContext(pool, operatorId, accountId, async (client) => {
    const result = await client.query(
      `UPDATE postbro.approvals
       SET status = 'approved', decided_at = now()
       WHERE id = $3
         AND account_id = $2
         AND operator_id = $1
         AND status = 'pending'
         AND expires_at > now()`,
      [operatorId, accountId, approvalId],
    );
    return result.rowCount === 1;
  });
}

export async function rejectApproval(pool: Pool, operatorId: number, accountId: number, approvalId: number): Promise<boolean> {
  return withRlsContext(pool, operatorId, accountId, async (client) => {
    const result = await client.query(
      `UPDATE postbro.approvals
       SET status = 'rejected', decided_at = now()
       WHERE id = $3
         AND account_id = $2
         AND operator_id = $1
         AND status = 'pending'
         AND expires_at > now()`,
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
): Promise<number> {
  return withRlsContext(pool, 0, accountId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO postbro.execution_attempts (account_id, job_id, action_key, attempt_no, outcome, provider_request)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [accountId, jobId, actionKey, attemptNo, outcome, providerRequest],
    );
    return Number(result.rows[0]!.id);
  });
}
