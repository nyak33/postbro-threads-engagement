/**
 * PB-P0-004: REAL Threads OAuth HTTP client behind the ThreadsOAuthClient
 * port defined in oauth-client.ts.
 *
 * Implements the official Meta Threads OAuth endpoints ONLY:
 * - POST https://graph.threads.net/oauth/access_token
 *     (authorization_code -> short-lived token; client_id, client_secret,
 *      code, grant_type=authorization_code, identical redirect_uri)
 * - GET  https://graph.threads.net/access_token
 *     (grant_type=th_exchange_token -> long-lived token;
 *      grant_type=th_refresh_token -> refreshed long-lived token)
 * - GET  https://graph.threads.net/v1.0/me?fields=id,username
 *
 * Security contract:
 * - Transport is INJECTED (HttpTransport). Tests never perform network I/O;
 *   production wiring passes the built-in fetch transport.
 * - The Graph host is fixed and allowlisted; redirects are never followed
 *   (redirect: 'manual' — a redirect from the provider fails closed).
 * - Timeouts (AbortSignal.timeout) and a hard response size cap are enforced.
 * - Tokens are passed via the Authorization header wherever the provider
 *   supports it (Bearer on /me and the token-exchange GETs), never in URLs.
 * - Secrets (client_secret) are sent ONLY in POST form bodies / POST
 *   requests and never appear in URLs, logs or error messages.
 * - Provider errors are sanitized: no response bodies, tokens, codes, or
 *   secrets are ever embedded in thrown errors or logs.
 * - Granted scopes: there is NO authoritative Threads endpoint documented
 *   that enumerates granted scopes for a user token. Therefore
 *   getGrantedScopes() FAILS CLOSED: { verified: false, scopes: [] } always.
 *   Requested scopes from config are NEVER reported as granted. (Decision
 *   recorded in docs/tasks/PB-P0-004.md.)
 */

import type { ThreadsOAuthConfig } from '../../config';
import {
  buildAuthorizeUrl,
  ThreadsOAuthError,
  ThreadsOAuthProviderError,
  type AuthorizeUrlParams,
  type GrantedScopesEvidence,
  type LongLivedTokenResult,
  type ShortLivedTokenResult,
  type ThreadsIdentity,
  type ThreadsOAuthClient,
  type ThreadsOAuthErrorKind,
} from './oauth-client';

export const THREADS_GRAPH_ORIGIN = 'https://graph.threads.net';
export const THREADS_API_VERSION = 'v1.0';

/** Hard bounds applied to every provider call. */
export const THREADS_HTTP_TIMEOUT_MS = 10_000;
export const THREADS_HTTP_MAX_BODY_BYTES = 64 * 1024;

/**
 * Minimal HTTP transport port so tests can inject a deterministic fake.
 * Implementations MUST NOT follow redirects; a non-2xx status is returned
 * to the caller for sanitized mapping.
 */
export interface HttpTransportResponse {
  status: number;
  body: string;
}

export interface HttpTransportRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBodyBytes: number;
}

export type HttpTransport = (request: HttpTransportRequest) => Promise<HttpTransportResponse>;

/** Error thrown when the response exceeds the size cap or times out. */
export class ThreadsHttpTransportError extends Error {
  readonly reason: 'timeout' | 'body_too_large' | 'redirect' | 'network';

  constructor(reason: 'timeout' | 'body_too_large' | 'redirect' | 'network', message: string) {
    super(message);
    this.name = 'ThreadsHttpTransportError';
    this.reason = reason;
  }
}

/**
 * Production fetch transport. redirect:'manual' ensures the client NEVER
 * follows a redirect; a 3xx from the token endpoints fails closed as a
 * provider error. Body is read with a hard byte cap. No response content is
 * ever logged.
 */
export const fetchHttpTransport: HttpTransport = async (request) => {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(request.timeoutMs),
    });
  } catch {
    throw new ThreadsHttpTransportError('network', 'provider request failed');
  }

  if (response.status >= 300 && response.status < 400) {
    throw new ThreadsHttpTransportError('redirect', 'provider returned an unexpected redirect');
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return { status: response.status, body: '' };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > request.maxBodyBytes) {
        void reader.cancel().catch(() => undefined);
        throw new ThreadsHttpTransportError('body_too_large', 'provider response too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { status: response.status, body: Buffer.concat(chunks).toString('utf8') };
};

function mapProviderErrorStatus(status: number): ThreadsOAuthErrorKind {
  if (status === 400 || status === 401) return 'invalid_code';
  if (status === 403) return 'permission_denied';
  if (status >= 500) return 'provider_unavailable';
  return 'unknown';
}

function parseJsonObject(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return undefined;
}

/**
 * Detects the documented Meta error envelope { "error": { "type", "code", ... } }.
 * NEVER includes provider messages in the mapped outcome.
 */
function providerErrorKind(body: string): ThreadsOAuthErrorKind | undefined {
  const parsed = parseJsonObject(body);
  if (!parsed) return undefined;
  const err = parsed['error'];
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as Record<string, unknown>)['code'];
  // 190 = token expired/invalid; 102/104 auth/session failures on Graph.
  if (code === 190) return 'token_expired';
  return 'unknown';
}

function requireString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireStringOrNumber(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

export interface ThreadsHttpOAuthClientOptions {
  config: ThreadsOAuthConfig;
  /** Injected transport; defaults to the production fetch transport. */
  transport?: HttpTransport;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

/**
 * Real Threads OAuth client. Performs network I/O ONLY through the injected
 * transport; all other behavior is deterministic and fail-closed.
 */
export class ThreadsHttpOAuthClient implements ThreadsOAuthClient {
  private readonly config: ThreadsOAuthConfig;
  private readonly transport: HttpTransport;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;

  constructor(options: ThreadsHttpOAuthClientOptions) {
    this.config = options.config;
    this.transport = options.transport ?? fetchHttpTransport;
    this.timeoutMs = options.timeoutMs ?? THREADS_HTTP_TIMEOUT_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? THREADS_HTTP_MAX_BODY_BYTES;
    if (!this.config.appId || !this.config.appSecret || !this.config.redirectUri) {
      throw new ThreadsOAuthError('Threads OAuth config is incomplete');
    }
  }

  buildAuthorizeUrl(params: AuthorizeUrlParams): string {
    return buildAuthorizeUrl(this.config, params);
  }

  /**
   * POST https://graph.threads.net/oauth/access_token
   * Form-encoded body per official Meta docs. client_secret travels ONLY in
   * this POST body, never in any URL. Response must be a JSON object with
   * non-empty string access_token and string/numeric user_id; anything else
   * (including an error envelope or malformed JSON) fails closed.
   */
  async exchangeCode(code: string): Promise<ShortLivedTokenResult> {
    if (typeof code !== 'string' || code.length === 0) {
      throw new ThreadsOAuthProviderError('invalid_code', 'authorization code must be non-empty');
    }
    const form = new URLSearchParams({
      client_id: this.config.appId,
      client_secret: this.config.appSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: this.config.redirectUri,
    });
    const res = await this.request({
      method: 'POST',
      url: `${THREADS_GRAPH_ORIGIN}/oauth/access_token`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (res.status !== 200) {
      throw new ThreadsOAuthProviderError(
        providerErrorKind(res.body) ?? mapProviderErrorStatus(res.status),
        'provider rejected the authorization code exchange',
      );
    }
    const parsed = parseJsonObject(res.body);
    if (!parsed) {
      throw new ThreadsOAuthProviderError('unknown', 'provider returned malformed JSON');
    }
    const accessToken = requireString(parsed['access_token']);
    const userId = requireStringOrNumber(parsed['user_id']);
    if (!accessToken || !userId) {
      throw new ThreadsOAuthProviderError('unknown', 'provider response missing required fields');
    }
    return { accessToken, userId, tokenType: 'bearer' };
  }

  /**
   * GET https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=...
   * The short-lived token is passed via the Authorization header; client
   * secret is required as a query parameter by the documented endpoint.
   */
  async exchangeLongLived(shortLivedToken: string): Promise<LongLivedTokenResult> {
    return this.getLongLived(shortLivedToken, 'th_exchange_token');
  }

  /**
   * GET https://graph.threads.net/access_token?grant_type=th_refresh_token
   * Refreshes an existing long-lived token (>=24h old per Meta docs).
   */
  async refreshLongLived(longLivedToken: string): Promise<LongLivedTokenResult> {
    return this.getLongLived(longLivedToken, 'th_refresh_token');
  }

  private async getLongLived(
    token: string,
    grantType: 'th_exchange_token' | 'th_refresh_token',
  ): Promise<LongLivedTokenResult> {
    if (typeof token !== 'string' || token.length === 0) {
      throw new ThreadsOAuthProviderError('unknown', 'token must be non-empty');
    }
    const url = new URL(`${THREADS_GRAPH_ORIGIN}/access_token`);
    url.searchParams.set('grant_type', grantType);
    url.searchParams.set('client_secret', this.config.appSecret);
    const res = await this.request({
      method: 'GET',
      url: url.toString(),
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status !== 200) {
      throw new ThreadsOAuthProviderError(
        providerErrorKind(res.body) ?? mapProviderErrorStatus(res.status),
        'provider rejected the token exchange',
      );
    }
    const parsed = parseJsonObject(res.body);
    if (!parsed) {
      throw new ThreadsOAuthProviderError('unknown', 'provider returned malformed JSON');
    }
    const accessToken = requireString(parsed['access_token']);
    if (!accessToken) {
      throw new ThreadsOAuthProviderError('unknown', 'provider response missing access_token');
    }
    const expiresRaw = parsed['expires_in'];
    const expiresInSeconds =
      typeof expiresRaw === 'number' && Number.isFinite(expiresRaw) && expiresRaw > 0
        ? Math.floor(expiresRaw)
        : undefined;
    return {
      accessToken,
      tokenType: requireString(parsed['token_type']) ?? 'bearer',
      ...(expiresInSeconds !== undefined ? { expiresInSeconds } : {}),
    };
  }

  /**
   * GET https://graph.threads.net/v1.0/me?fields=id,username
   * Token via Authorization header only.
   */
  async getMe(accessToken: string): Promise<ThreadsIdentity> {
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new ThreadsOAuthProviderError('revoked', 'access token must be non-empty');
    }
    const url = new URL(`${THREADS_GRAPH_ORIGIN}/${THREADS_API_VERSION}/me`);
    url.searchParams.set('fields', 'id,username');
    const res = await this.request({
      method: 'GET',
      url: url.toString(),
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (res.status !== 200) {
      throw new ThreadsOAuthProviderError(
        providerErrorKind(res.body) ?? mapProviderErrorStatus(res.status),
        'provider rejected the identity request',
      );
    }
    const parsed = parseJsonObject(res.body);
    if (!parsed) {
      throw new ThreadsOAuthProviderError('unknown', 'provider returned malformed JSON');
    }
    const id = requireStringOrNumber(parsed['id']);
    if (!id) {
      throw new ThreadsOAuthProviderError('unknown', 'provider response missing id');
    }
    const username = requireString(parsed['username']);
    return { id, ...(username ? { username } : {}) };
  }

  /**
   * FAIL CLOSED: Meta documents no Threads user-token scope enumeration
   * endpoint. Requested scopes are NEVER reported as granted. Until an
   * authoritative verification channel is identified and verified, granted
   * scopes stay unverified and empty (all scope-dependent actions disabled).
   */
  getGrantedScopes(_accessToken: string): Promise<GrantedScopesEvidence> {
    return Promise.resolve({ verified: false, scopes: [] });
  }

  private async request(req: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<HttpTransportResponse> {
    // Enforce the fixed allowlisted origin at the boundary.
    const parsed = new URL(req.url);
    if (parsed.origin !== THREADS_GRAPH_ORIGIN) {
      throw new ThreadsOAuthError('refusing to call non-allowlisted Threads host');
    }
    try {
      return await this.transport({
        method: req.method,
        url: req.url,
        headers: req.headers,
        ...(req.body !== undefined ? { body: req.body } : {}),
        timeoutMs: this.timeoutMs,
        maxBodyBytes: this.maxBodyBytes,
      });
    } catch (error) {
      if (error instanceof ThreadsHttpTransportError) {
        const kind: ThreadsOAuthErrorKind =
          error.reason === 'timeout' ? 'provider_unavailable' : 'unknown';
        throw new ThreadsOAuthProviderError(kind, 'provider request failed');
      }
      if (error instanceof ThreadsOAuthProviderError) {
        throw error;
      }
      throw new ThreadsOAuthProviderError('provider_unavailable', 'provider request failed');
    }
  }
}
