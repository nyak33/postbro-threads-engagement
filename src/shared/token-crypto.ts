import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * AES-256-GCM token encryption helper (PB-P0-003 slice A).
 *
 * Security contract:
 * - Keys are raw 32-byte buffers; callers load them from validated config
 *   (base64 TOKEN_ENCRYPTION_KEY) and are responsible for zeroizing if needed.
 * - Every encryption uses a fresh 96-bit random IV.
 * - Decryption is authenticated: wrong key, tampered ciphertext/tag, unknown
 *   version or unknown key id all fail with TokenDecryptionError and NEVER
 *   include plaintext, key material, or ciphertext in the error message.
 * - Nothing in this module logs or returns secrets on failure paths.
 */

export const TOKEN_ENCRYPTION_KEY_BYTES = 32;
export const TOKEN_ENCRYPTION_IV_BYTES = 12;
export const TOKEN_ENCRYPTION_TAG_BYTES = 16;
export const TOKEN_ENCRYPTION_VERSION = 1;

export class TokenEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenEncryptionError';
  }
}

export class TokenDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenDecryptionError';
  }
}

export interface TokenEncryptionKey {
  /** Stable identifier stored alongside ciphertext (e.g. token_key_id). */
  keyId: string;
  /** Raw 32-byte AES-256 key. */
  key: Buffer;
}

export interface EncryptedTokenPayload {
  v: number;
  kid: string;
  iv: string;
  data: string;
}

export function decodeTokenEncryptionKey(base64Key: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(base64Key, 'base64');
  } catch {
    throw new TokenEncryptionError('TOKEN_ENCRYPTION_KEY is not valid base64');
  }
  if (key.length !== TOKEN_ENCRYPTION_KEY_BYTES) {
    throw new TokenEncryptionError(
      `TOKEN_ENCRYPTION_KEY must decode to exactly ${TOKEN_ENCRYPTION_KEY_BYTES} bytes`,
    );
  }
  return key;
}

export function validateTokenEncryptionKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== TOKEN_ENCRYPTION_KEY_BYTES) {
    throw new TokenEncryptionError(
      `encryption key must be a Buffer of exactly ${TOKEN_ENCRYPTION_KEY_BYTES} bytes`,
    );
  }
}

export function encryptToken(plaintext: string, key: TokenEncryptionKey): string {
  validateTokenEncryptionKey(key.key);
  if (plaintext.length === 0) {
    throw new TokenEncryptionError('plaintext must not be empty');
  }
  const iv = randomBytes(TOKEN_ENCRYPTION_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload: EncryptedTokenPayload = {
    v: TOKEN_ENCRYPTION_VERSION,
    kid: key.keyId,
    iv: iv.toString('base64'),
    // ciphertext || auth tag, single base64 blob
    data: Buffer.concat([ciphertext, tag]).toString('base64'),
  };
  return JSON.stringify(payload);
}

function isEncryptedTokenPayload(value: unknown): value is EncryptedTokenPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['v'] === 'number' &&
    typeof v['kid'] === 'string' &&
    typeof v['iv'] === 'string' &&
    typeof v['data'] === 'string'
  );
}

/**
 * Decrypts a payload produced by encryptToken.
 * `keys` maps key id -> raw key so ciphertext encrypted under a rotated key
 * remains decryptable. Fails closed on any anomaly.
 */
export function decryptToken(serialized: string, keys: ReadonlyMap<string, Buffer>): string {
  let payload: unknown;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw new TokenDecryptionError('ciphertext payload is not valid JSON');
  }
  if (!isEncryptedTokenPayload(payload)) {
    throw new TokenDecryptionError('ciphertext payload has an invalid shape');
  }
  if (payload.v !== TOKEN_ENCRYPTION_VERSION) {
    throw new TokenDecryptionError('ciphertext payload has an unsupported version');
  }
  const key = keys.get(payload.kid);
  if (!key) {
    throw new TokenDecryptionError('ciphertext references an unknown key id');
  }
  if (key.length !== TOKEN_ENCRYPTION_KEY_BYTES) {
    throw new TokenDecryptionError('configured decryption key has an invalid length');
  }

  const iv = Buffer.from(payload.iv, 'base64');
  const combined = Buffer.from(payload.data, 'base64');
  if (iv.length !== TOKEN_ENCRYPTION_IV_BYTES) {
    throw new TokenDecryptionError('ciphertext payload has an invalid IV');
  }
  if (combined.length <= TOKEN_ENCRYPTION_TAG_BYTES) {
    throw new TokenDecryptionError('ciphertext payload is too short');
  }
  const ciphertext = combined.subarray(0, combined.length - TOKEN_ENCRYPTION_TAG_BYTES);
  const tag = combined.subarray(combined.length - TOKEN_ENCRYPTION_TAG_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new TokenDecryptionError('ciphertext failed authenticated decryption');
  }
}

/** Constant-time equality helper for callers comparing key ids etc. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
