import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { Pool } from 'pg';

import { migrateDatabase } from '../src/db/migrate';
import {
  PersistOAuthCompletionError,
  persistOAuthCompletion,
} from '../src/modules/auth/persist-oauth';
import { decryptToken, type TokenEncryptionKey } from '../src/shared/token-crypto';
import {
  connectionStringFor,
  createLoginRole,
  startEmbeddedPostgres,
  type EmbeddedPostgresTestContext,
} from './helpers/embedded-postgres';

// Test-only, non-real key material and tokens. No network, no Meta.
const ENCRYPTION_KEY: TokenEncryptionKey = {
  keyId: 'test-key-1',
  key: randomBytes(32),
};
const PLAINTEXT_TOKEN = 'mock-long-lived-token-NOT-REAL-d2b1';

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

let pg: EmbeddedPostgresTestContext;
let appPool: Pool;
let ownerPool: Pool;

async function createOperator(telegramUserId: number, status = 'active'): Promise<number> {
  const result = await ownerPool.query<{ id: string }>(
    `INSERT INTO postbro.operators (telegram_user_id, status) VALUES ($1, $2) RETURNING id`,
    [telegramUserId, status],
  );
  return Number(result.rows[0]!.id);
}

function baseInput(operatorId: number, providerId: string) {
  return {
    operatorId,
    exchangeUserId: providerId,
    identityUserId: providerId,
    username: 'simulated-user',
    longLivedToken: PLAINTEXT_TOKEN,
    tokenExpiresInSeconds: 3600,
    grantedScopes: { verified: true, scopes: ['threads_basic'] },
    encryptionKey: ENCRYPTION_KEY,
  };
}

async function getAccount(providerId: string) {
  const result = await ownerPool.query<{
    id: string;
    username: string | null;
    scopes: string[];
    token_ciphertext: Buffer | null;
    token_key_id: string | null;
    token_expires_at: Date | null;
  }>('SELECT * FROM postbro.threads_accounts WHERE provider_id = $1', [providerId]);
  return result.rows[0];
}

before(async () => {
  pg = await startEmbeddedPostgres();
  ownerPool = pg.ownerPool;
  await migrateDatabase(pg.ownerPool, MIGRATIONS_DIR);
  const appPassword = randomBytes(16).toString('hex');
  await createLoginRole(pg.ownerPool, 'postbro_app_test', appPassword, 'postbro_app');
  appPool = new Pool({
    connectionString: connectionStringFor(pg.port, 'postbro_app_test', appPassword),
    max: 10,
  });
});

after(async () => {
  if (appPool) await appPool.end();
  if (pg) await pg.stop();
});

test('persist: first connect stores ciphertext, binding, verified scopes and expiry', async () => {
  const operatorId = await createOperator(930001);
  const result = await persistOAuthCompletion(appPool, baseInput(operatorId, 'provider-930001'));

  assert.ok(result.accountId > 0);
  assert.equal(result.scopesVerified, true);
  assert.deepEqual(result.grantedScopes, ['threads_basic']);

  const account = await getAccount('provider-930001');
  assert.ok(account);
  assert.equal(account!.username, 'simulated-user');
  assert.deepEqual(account!.scopes, ['threads_basic']);
  assert.equal(account!.token_key_id, 'test-key-1');
  assert.ok(account!.token_expires_at !== null);

  // Ciphertext present, differs from plaintext, and does not contain it.
  const ciphertextText = account!.token_ciphertext!.toString('utf8');
  assert.ok(!ciphertextText.includes(PLAINTEXT_TOKEN));
  assert.notEqual(ciphertextText, PLAINTEXT_TOKEN);
  // Round-trips via token-crypto under the same key.
  const decrypted = decryptToken(ciphertextText, new Map([['test-key-1', ENCRYPTION_KEY.key]]));
  assert.equal(decrypted, PLAINTEXT_TOKEN);

  // Ownership binding exists.
  const binding = await ownerPool.query(
    'SELECT role FROM postbro.operator_accounts WHERE operator_id = $1 AND account_id = $2',
    [operatorId, result.accountId],
  );
  assert.equal(binding.rowCount, 1);
  assert.equal(binding.rows[0]!.role, 'owner');
});

test('persist: same-owner reconnect updates the SAME row and rotates ciphertext', async () => {
  const operatorId = await createOperator(930002);
  const first = await persistOAuthCompletion(appPool, baseInput(operatorId, 'provider-930002'));
  const beforeRow = await getAccount('provider-930002');

  const second = await persistOAuthCompletion(appPool, {
    ...baseInput(operatorId, 'provider-930002'),
    username: 'renamed-user',
    longLivedToken: 'mock-long-lived-token-NOT-REAL-rotated',
  });

  assert.equal(second.accountId, first.accountId);
  const count = await ownerPool.query(
    'SELECT count(*)::int AS n FROM postbro.threads_accounts WHERE provider_id = $1',
    ['provider-930002'],
  );
  assert.equal(count.rows[0]!.n, 1, 'no duplicate account row');

  const afterRow = await getAccount('provider-930002');
  assert.equal(afterRow!.username, 'renamed-user');
  assert.notEqual(
    afterRow!.token_ciphertext!.toString('utf8'),
    beforeRow!.token_ciphertext!.toString('utf8'),
    'ciphertext rotated on reconnect',
  );
  const decrypted = decryptToken(
    afterRow!.token_ciphertext!.toString('utf8'),
    new Map([['test-key-1', ENCRYPTION_KEY.key]]),
  );
  assert.equal(decrypted, 'mock-long-lived-token-NOT-REAL-rotated');
});

test('persist: cross-operator takeover is rejected and original token untouched', async () => {
  const ownerA = await createOperator(930003);
  const ownerB = await createOperator(930004);
  await persistOAuthCompletion(appPool, baseInput(ownerA, 'provider-930003'));
  const before = await getAccount('provider-930003');

  await assert.rejects(
    () => persistOAuthCompletion(appPool, baseInput(ownerB, 'provider-930003')),
    (error: unknown) =>
      error instanceof PersistOAuthCompletionError &&
      error.reason === 'provider_owned_by_other_operator',
  );

  const after = await getAccount('provider-930003');
  assert.equal(
    after!.token_ciphertext!.toString('utf8'),
    before!.token_ciphertext!.toString('utf8'),
    'token ciphertext not overwritten by takeover attempt',
  );
  // No binding created for the attacker.
  const bindings = await ownerPool.query(
    'SELECT count(*)::int AS n FROM postbro.operator_accounts WHERE account_id = $1',
    [after!.id],
  );
  assert.equal(bindings.rows[0]!.n, 1);
});

test('persist: concurrent same-provider connects by different operators — exactly one wins', async () => {
  const ownerA = await createOperator(930005);
  const ownerB = await createOperator(930006);
  const providerId = 'provider-930005';

  const outcomes = await Promise.allSettled([
    persistOAuthCompletion(appPool, baseInput(ownerA, providerId)),
    persistOAuthCompletion(appPool, baseInput(ownerB, providerId)),
  ]);

  const succeeded = outcomes.filter((o) => o.status === 'fulfilled');
  const rejected = outcomes.filter(
    (o) =>
      o.status === 'rejected' &&
      o.reason instanceof PersistOAuthCompletionError &&
      (o.reason as PersistOAuthCompletionError).reason === 'provider_owned_by_other_operator',
  );
  // Exactly one winner; the loser is rejected with the takeover error.
  assert.equal(succeeded.length, 1);
  assert.equal(rejected.length, 1);

  const account = await getAccount(providerId);
  assert.ok(account);
  const bindings = await ownerPool.query(
    'SELECT operator_id FROM postbro.operator_accounts WHERE account_id = $1',
    [account!.id],
  );
  assert.equal(bindings.rowCount, 1, 'exactly one ownership binding');
});

test('persist: unverified grants store empty scopes', async () => {
  const operatorId = await createOperator(930007);
  const result = await persistOAuthCompletion(appPool, {
    ...baseInput(operatorId, 'provider-930007'),
    grantedScopes: { verified: false, scopes: [] },
  });
  assert.equal(result.scopesVerified, false);
  assert.deepEqual(result.grantedScopes, []);
  const account = await getAccount('provider-930007');
  assert.deepEqual(account!.scopes, []);
});

test('persist: identity mismatch is rejected before any DB write', async () => {
  const operatorId = await createOperator(930008);
  await assert.rejects(
    () =>
      persistOAuthCompletion(appPool, {
        ...baseInput(operatorId, 'provider-930008'),
        identityUserId: 'different-provider-id',
      }),
    (error: unknown) =>
      error instanceof PersistOAuthCompletionError && error.reason === 'identity_mismatch',
  );
  const account = await getAccount('provider-930008');
  assert.equal(account, undefined, 'no account row created');
});

test('persist: disabled operator fails closed with rollback', async () => {
  const operatorId = await createOperator(930009, 'disabled');
  await assert.rejects(
    () => persistOAuthCompletion(appPool, baseInput(operatorId, 'provider-930009')),
    (error: unknown) =>
      error instanceof PersistOAuthCompletionError && error.reason === 'operator_inactive',
  );
  const account = await getAccount('provider-930009');
  assert.equal(account, undefined);
  const bindings = await ownerPool.query(
    'SELECT count(*)::int AS n FROM postbro.operator_accounts WHERE operator_id = $1',
    [operatorId],
  );
  assert.equal(bindings.rows[0]!.n, 0);
});

test('persist: empty token and empty provider id are invalid input', async () => {
  const operatorId = await createOperator(930010);
  await assert.rejects(
    () =>
      persistOAuthCompletion(appPool, {
        ...baseInput(operatorId, 'provider-930010'),
        longLivedToken: '',
      }),
    (error: unknown) =>
      error instanceof PersistOAuthCompletionError && error.reason === 'invalid_input',
  );
  await assert.rejects(
    () => persistOAuthCompletion(appPool, baseInput(operatorId, '')),
    (error: unknown) =>
      error instanceof PersistOAuthCompletionError && error.reason === 'invalid_input',
  );
});

test('persist: app role cannot read other operators accounts directly (RLS intact)', async () => {
  // The service works through the SECURITY DEFINER function; direct table
  // access under an operator-scoped RLS context remains restricted.
  const operatorId = await createOperator(930011);
  await persistOAuthCompletion(appPool, baseInput(operatorId, 'provider-930011'));

  const client = await appPool.connect();
  try {
    await client.query("SELECT set_config('postbro.operator_id', '999999', true)");
    await client.query("SELECT set_config('postbro.account_id', '999999', true)");
    const direct = await client.query('SELECT id FROM postbro.threads_accounts');
    assert.equal(direct.rowCount, 0, 'app role sees nothing under foreign RLS context');
  } finally {
    client.release();
  }
});
