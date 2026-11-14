import assert from 'node:assert/strict';
import test from 'node:test';

import {
  THREADS_GRAPH_ORIGIN,
  ThreadsHttpOAuthClient,
  ThreadsHttpTransportError,
  type HttpTransport,
  type HttpTransportRequest,
} from '../src/integrations/threads/oauth-client-http';
import { ThreadsOAuthProviderError } from '../src/integrations/threads/oauth-client';
import type { ThreadsOAuthConfig } from '../src/config';

/** Fixed dummy config — non-real, test-only. */
const CONFIG: ThreadsOAuthConfig = {
  appId: 'dummy-app-id',
  appSecret: 'dummy-app-secret-NOT-REAL',
  redirectUri: 'https://app.example.com/auth/threads/callback',
  scopes: ['threads_basic'],
};

type RecordedCall = HttpTransportRequest;

function transportReturning(
  handler: (req: HttpTransportRequest) => { status: number; body: string },
): { transport: HttpTransport; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport: HttpTransport = (req) => {
    calls.push({ ...req });
    const res = handler(req);
    return Promise.resolve(res);
  };
  return { transport, calls };
}

function makeClient(transport: HttpTransport): ThreadsHttpOAuthClient {
  return new ThreadsHttpOAuthClient({ config: CONFIG, transport });
}

test('exchangeCode POSTs the documented form to the fixed Graph host', async () => {
  const { transport, calls } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ access_token: 'short-token', user_id: '12345' }),
  }));
  const client = makeClient(transport);

  const result = await client.exchangeCode('dummy-code');
  assert.equal(result.accessToken, 'short-token');
  assert.equal(result.userId, '12345');

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.method, 'POST');
  const url = new URL(call.url);
  assert.equal(url.origin, THREADS_GRAPH_ORIGIN);
  assert.equal(url.pathname, '/oauth/access_token');
  // Secret must be in the POST body, never in the URL.
  assert.equal(call.url.includes(CONFIG.appSecret), false);
  assert.ok(call.body);
  const form = new URLSearchParams(call.body);
  assert.equal(form.get('client_id'), CONFIG.appId);
  assert.equal(form.get('client_secret'), CONFIG.appSecret);
  assert.equal(form.get('code'), 'dummy-code');
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('redirect_uri'), CONFIG.redirectUri);
});

test('exchangeCode accepts numeric user_id', async () => {
  const { transport } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ access_token: 'tok', user_id: 987 }),
  }));
  const result = await makeClient(transport).exchangeCode('code');
  assert.equal(result.userId, '987');
});

test('exchangeCode rejects empty code and never calls the transport', async () => {
  const { transport, calls } = transportReturning(() => ({ status: 200, body: '{}' }));
  await assert.rejects(
    () => makeClient(transport).exchangeCode(''),
    (e: unknown) => e instanceof ThreadsOAuthProviderError && e.kind === 'invalid_code',
  );
  assert.equal(calls.length, 0);
});

test('exchangeCode fails closed on provider 400 error envelope', async () => {
  const { transport } = transportReturning(() => ({
    status: 400,
    body: JSON.stringify({ error: { message: 'bad code SECRET-DETAIL', type: 'OAuthException', code: 100 } }),
  }));
  await assert.rejects(
    () => makeClient(transport).exchangeCode('code'),
    (e: unknown) => {
      assert.ok(e instanceof ThreadsOAuthProviderError);
      assert.equal(e.kind, 'unknown');
      // Provider message content must never leak into the error.
      assert.equal(e.message.includes('SECRET-DETAIL'), false);
      return true;
    },
  );
});

test('exchangeCode fails closed on malformed JSON and missing fields', async () => {
  for (const body of ['not-json', '{"access_token":"tok"}', '{"user_id":"1"}', '[]', '"str"']) {
    const { transport } = transportReturning(() => ({ status: 200, body }));
    await assert.rejects(
      () => makeClient(transport).exchangeCode('code'),
      (e: unknown) => e instanceof ThreadsOAuthProviderError && e.kind === 'unknown',
    );
  }
});

test('exchangeCode fails closed on provider 5xx as provider_unavailable', async () => {
  const { transport } = transportReturning(() => ({ status: 503, body: '' }));
  await assert.rejects(
    () => makeClient(transport).exchangeCode('code'),
    (e: unknown) => e instanceof ThreadsOAuthProviderError && e.kind === 'provider_unavailable',
  );
});

test('exchangeLongLived uses th_exchange_token with bearer header', async () => {
  const { transport, calls } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ access_token: 'long-token', token_type: 'bearer', expires_in: 5184000 }),
  }));
  const result = await makeClient(transport).exchangeLongLived('short-token');
  assert.equal(result.accessToken, 'long-token');
  assert.equal(result.expiresInSeconds, 5184000);

  const call = calls[0]!;
  const url = new URL(call.url);
  assert.equal(url.origin, THREADS_GRAPH_ORIGIN);
  assert.equal(url.pathname, '/access_token');
  assert.equal(url.searchParams.get('grant_type'), 'th_exchange_token');
  assert.equal(url.searchParams.get('client_secret'), CONFIG.appSecret);
  // Token goes via Authorization header, never in URL.
  assert.equal(url.searchParams.get('access_token'), null);
  assert.equal(call.headers['authorization'], 'Bearer short-token');
});

test('refreshLongLived uses th_refresh_token', async () => {
  const { transport, calls } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ access_token: 'refreshed', token_type: 'bearer', expires_in: 5184000 }),
  }));
  await makeClient(transport).refreshLongLived('old-long-token');
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get('grant_type'), 'th_refresh_token');
  assert.equal(calls[0]!.headers['authorization'], 'Bearer old-long-token');
});

test('exchangeLongLived tolerates missing expires_in', async () => {
  const { transport } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ access_token: 'tok' }),
  }));
  const result = await makeClient(transport).exchangeLongLived('short');
  assert.equal(result.expiresInSeconds, undefined);
});

test('exchangeLongLived maps token-expired envelope (code 190)', async () => {
  const { transport } = transportReturning(() => ({
    status: 400,
    body: JSON.stringify({ error: { message: 'expired', type: 'OAuthException', code: 190 } }),
  }));
  await assert.rejects(
    () => makeClient(transport).exchangeLongLived('short'),
    (e: unknown) => e instanceof ThreadsOAuthProviderError && e.kind === 'token_expired',
  );
});

test('getMe GETs /v1.0/me with fields and bearer header only', async () => {
  const { transport, calls } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ id: '12345', username: 'tester' }),
  }));
  const me = await makeClient(transport).getMe('long-token');
  assert.deepEqual(me, { id: '12345', username: 'tester' });

  const call = calls[0]!;
  const url = new URL(call.url);
  assert.equal(url.origin, THREADS_GRAPH_ORIGIN);
  assert.equal(url.pathname, '/v1.0/me');
  assert.equal(url.searchParams.get('fields'), 'id,username');
  assert.equal(url.searchParams.get('access_token'), null);
  assert.equal(call.headers['authorization'], 'Bearer long-token');
});

test('getMe fails closed on missing id', async () => {
  const { transport } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ username: 'no-id' }),
  }));
  await assert.rejects(
    () => makeClient(transport).getMe('tok'),
    (e: unknown) => e instanceof ThreadsOAuthProviderError && e.kind === 'unknown',
  );
});

test('transport network failure maps to provider_unavailable and leaks nothing', async () => {
  const failing: HttpTransport = () =>
    Promise.reject(new Error('dns boom token=abc client_secret=shh'));
  await assert.rejects(
    () => makeClient(failing).getMe('tok'),
    (e: unknown) => {
      assert.ok(e instanceof ThreadsOAuthProviderError);
      assert.equal(e.kind, 'provider_unavailable');
      assert.equal(e.message.includes('token=abc'), false);
      assert.equal(e.message.includes('client_secret'), false);
      return true;
    },
  );
});

test('transport errors never expose the request URL (may contain client_secret)', async () => {
  // The long-lived GET URL necessarily contains client_secret (Meta's
  // documented contract); a redirect/oversize/network failure must not
  // propagate that URL through the thrown error.
  const secretUrlProbe: HttpTransport = (req) => {
    // Simulate a redirect failure carrying the URL (as a careless
    // transport might); the client must wrap it sanitized.
    return Promise.reject(
      new ThreadsHttpTransportError('redirect', `unexpected redirect for ${req.url}`),
    );
  };
  await assert.rejects(
    () => makeClient(secretUrlProbe).exchangeLongLived('short-token'),
    (e: unknown) => {
      assert.ok(e instanceof ThreadsOAuthProviderError);
      assert.equal(e.message.includes(CONFIG.appSecret), false);
      assert.equal(e.message.includes('client_secret='), false);
      assert.equal(e.message.includes('graph.threads.net'), false);
      return true;
    },
  );
});

test('getGrantedScopes always fails closed (no authoritative endpoint)', async () => {
  const { transport, calls } = transportReturning(() => ({ status: 200, body: '{}' }));
  const scopes = await makeClient(transport).getGrantedScopes('tok');
  assert.deepEqual(scopes, { verified: false, scopes: [] });
  // Must NOT make any network call.
  assert.equal(calls.length, 0);
});

test('client constructor rejects incomplete config', () => {
  assert.throws(
    () => new ThreadsHttpOAuthClient({ config: { ...CONFIG, appSecret: '' }, transport: () => Promise.resolve({ status: 200, body: '' }) }),
    /incomplete/,
  );
});
