import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MockThreadsOAuthClient,
  THREADS_AUTHORIZE_URL,
  ThreadsOAuthError,
  ThreadsOAuthProviderError,
  buildAuthorizeUrl,
} from '../src/integrations/threads/oauth-client';
import type { ThreadsOAuthConfig } from '../src/config';

// Fixed dummy config — non-real, test-only values.
const CONFIG: ThreadsOAuthConfig = {
  appId: 'dummy-app-id',
  appSecret: 'dummy-app-secret',
  redirectUri: 'https://app.example.com/auth/threads/callback',
  scopes: ['threads_basic', 'threads_read_replies', 'threads_manage_replies'],
};

// Fixed dummy state standing in for a caller-generated random value.
const DUMMY_STATE = 'dummy-state-0123456789abcdef';

test('buildAuthorizeUrl produces the exact golden documented URL', () => {
  const url = buildAuthorizeUrl(CONFIG, { state: DUMMY_STATE });
  assert.equal(
    url,
    'https://threads.com/oauth/authorize' +
      '?client_id=dummy-app-id' +
      '&redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fthreads%2Fcallback' +
      '&response_type=code' +
      `&state=${DUMMY_STATE}` +
      '&scope=threads_basic%2Cthreads_read_replies%2Cthreads_manage_replies',
  );
});

test('buildAuthorizeUrl URL-encodes parameters with reserved characters', () => {
  const url = buildAuthorizeUrl(
    { ...CONFIG, appId: 'app id/with?chars' },
    { state: 'state with spaces&=' },
  );
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, THREADS_AUTHORIZE_URL);
  assert.equal(parsed.searchParams.get('client_id'), 'app id/with?chars');
  assert.equal(parsed.searchParams.get('state'), 'state with spaces&=');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
});

test('buildAuthorizeUrl rejects empty or missing state', () => {
  assert.throws(() => buildAuthorizeUrl(CONFIG, { state: '' }), ThreadsOAuthError);
  assert.throws(
    () => buildAuthorizeUrl(CONFIG, { state: undefined as unknown as string }),
    ThreadsOAuthError,
  );
});

test('buildAuthorizeUrl rejects invalid config', () => {
  assert.throws(
    () => buildAuthorizeUrl({ ...CONFIG, appId: '' }, { state: DUMMY_STATE }),
    ThreadsOAuthError,
  );
  assert.throws(
    () => buildAuthorizeUrl({ ...CONFIG, redirectUri: '' }, { state: DUMMY_STATE }),
    ThreadsOAuthError,
  );
  assert.throws(
    () => buildAuthorizeUrl({ ...CONFIG, scopes: ['threads_read_replies'] }, { state: DUMMY_STATE }),
    ThreadsOAuthError,
  );
});

test('buildAuthorizeUrl never includes the app secret', () => {
  const url = buildAuthorizeUrl(CONFIG, { state: DUMMY_STATE });
  assert.equal(url.includes(CONFIG.appSecret), false);
});

test('mock client happy path returns fixed dummy values and records calls', async () => {
  const client = new MockThreadsOAuthClient({ config: CONFIG, userId: 'user-42', username: 'tester' });

  const url = client.buildAuthorizeUrl({ state: DUMMY_STATE });
  assert.ok(url.startsWith(`${THREADS_AUTHORIZE_URL}?`));

  const shortLived = await client.exchangeCode('dummy-code');
  assert.equal(shortLived.userId, 'user-42');
  assert.ok(shortLived.accessToken.includes('NOT-REAL'));

  const longLived = await client.exchangeLongLived(shortLived.accessToken);
  assert.ok(longLived.accessToken.includes('NOT-REAL'));
  assert.equal(longLived.expiresInSeconds, 60 * 24 * 60 * 60);

  const refreshed = await client.refreshLongLived(longLived.accessToken);
  assert.ok(refreshed.accessToken.includes('NOT-REAL'));

  const me = await client.getMe(longLived.accessToken);
  assert.equal(me.id, 'user-42');
  assert.equal(me.username, 'tester');

  const scopes = await client.getGrantedScopes(longLived.accessToken);
  assert.equal(scopes.verified, false);
  assert.deepEqual(scopes.scopes, []);

  assert.deepEqual(
    client.calls.map((c) => c.method),
    ['buildAuthorizeUrl', 'exchangeCode', 'exchangeLongLived', 'refreshLongLived', 'getMe', 'getGrantedScopes'],
  );
});

test('mock client maps exchange failure to a provider error kind', async () => {
  const client = new MockThreadsOAuthClient({ config: CONFIG, failExchangeCode: 'invalid_code' });
  await assert.rejects(
    () => client.exchangeCode('dummy-code'),
    (error: unknown) =>
      error instanceof ThreadsOAuthProviderError && error.kind === 'invalid_code',
  );
});

test('mock client never reports requested scopes as granted by default', async () => {
  const client = new MockThreadsOAuthClient({ config: CONFIG });
  const scopes = await client.getGrantedScopes('mock-long-lived-token-NOT-REAL');
  assert.equal(scopes.verified, false);
  assert.deepEqual(scopes.scopes, []);
  assert.equal(CONFIG.scopes.length > 0, true); // requested scopes exist but are NOT granted
});

test('mock client can model verified granted-scope evidence', async () => {
  const client = new MockThreadsOAuthClient({
    config: CONFIG,
    grantedScopes: { verified: true, scopes: ['threads_basic'] },
  });
  const scopes = await client.getGrantedScopes('mock-long-lived-token-NOT-REAL');
  assert.equal(scopes.verified, true);
  assert.deepEqual(scopes.scopes, ['threads_basic']);
});

test('mock client rejects empty inputs on exchange methods', async () => {
  const client = new MockThreadsOAuthClient({ config: CONFIG });
  await assert.rejects(() => client.exchangeCode(''), ThreadsOAuthProviderError);
  await assert.rejects(() => client.exchangeLongLived(''), ThreadsOAuthProviderError);
  await assert.rejects(() => client.refreshLongLived(''), ThreadsOAuthProviderError);
  await assert.rejects(() => client.getMe(''), ThreadsOAuthProviderError);
  await assert.rejects(() => client.getGrantedScopes(''), ThreadsOAuthProviderError);
});
