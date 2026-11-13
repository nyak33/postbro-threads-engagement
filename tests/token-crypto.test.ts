import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  TOKEN_ENCRYPTION_KEY_BYTES,
  TOKEN_ENCRYPTION_VERSION,
  TokenDecryptionError,
  TokenEncryptionError,
  decryptToken,
  decodeTokenEncryptionKey,
  encryptToken,
} from '../src/shared/token-crypto';

// Fixed dummy keys — non-real, test-only values per spec section 4.10.
const DUMMY_KEY_A = Buffer.alloc(TOKEN_ENCRYPTION_KEY_BYTES, 0x11);
const DUMMY_KEY_B = Buffer.alloc(TOKEN_ENCRYPTION_KEY_BYTES, 0x22);
const KEY_ID_A = 'test-key-a';
const KEY_ID_B = 'test-key-b';

test('encrypt/decrypt round-trip returns the original plaintext', () => {
  const secret = 'dummy-token-plaintext-for-tests';
  const serialized = encryptToken(secret, { keyId: KEY_ID_A, key: DUMMY_KEY_A });
  const keys = new Map([[KEY_ID_A, DUMMY_KEY_A]]);
  assert.equal(decryptToken(serialized, keys), secret);
});

test('ciphertext differs from plaintext and does not contain it', () => {
  const secret = 'dummy-token-plaintext-for-tests';
  const serialized = encryptToken(secret, { keyId: KEY_ID_A, key: DUMMY_KEY_A });
  assert.notEqual(serialized, secret);
  assert.equal(serialized.includes(secret), false);
});

test('two encryptions of the same plaintext produce different ciphertexts (random IV)', () => {
  const secret = 'dummy-token-plaintext-for-tests';
  const first = encryptToken(secret, { keyId: KEY_ID_A, key: DUMMY_KEY_A });
  const second = encryptToken(secret, { keyId: KEY_ID_A, key: DUMMY_KEY_A });
  assert.notEqual(first, second);
});

test('payload carries version and key id', () => {
  const serialized = encryptToken('x'.repeat(8), { keyId: KEY_ID_A, key: DUMMY_KEY_A });
  const payload = JSON.parse(serialized) as { v: number; kid: string };
  assert.equal(payload.v, TOKEN_ENCRYPTION_VERSION);
  assert.equal(payload.kid, KEY_ID_A);
});

test('tampered ciphertext fails authenticated decryption', () => {
  const serialized = encryptToken('dummy-token', { keyId: KEY_ID_A, key: DUMMY_KEY_A });
  const payload = JSON.parse(serialized) as { v: number; kid: string; iv: string; data: string };
  const data = Buffer.from(payload.data, 'base64');
  data[0] = (data[0] ?? 0) ^ 0xff;
  payload.data = data.toString('base64');
  const keys = new Map([[KEY_ID_A, DUMMY_KEY_A]]);
  assert.throws(() => decryptToken(JSON.stringify(payload), keys), TokenDecryptionError);
});

test('wrong key fails authenticated decryption', () => {
  const serialized = encryptToken('dummy-token', { keyId: KEY_ID_A, key: DUMMY_KEY_A });
  const keys = new Map([[KEY_ID_A, DUMMY_KEY_B]]);
  assert.throws(() => decryptToken(serialized, keys), TokenDecryptionError);
});

test('unknown key id fails', () => {
  const serialized = encryptToken('dummy-token', { keyId: KEY_ID_A, key: DUMMY_KEY_A });
  const keys = new Map([[KEY_ID_B, DUMMY_KEY_B]]);
  assert.throws(() => decryptToken(serialized, keys), TokenDecryptionError);
});

test('decryption with a rotated key still works when old key is retained', () => {
  const serialized = encryptToken('dummy-token', { keyId: KEY_ID_A, key: DUMMY_KEY_A });
  const keys = new Map([
    [KEY_ID_A, DUMMY_KEY_A],
    [KEY_ID_B, DUMMY_KEY_B],
  ]);
  assert.equal(decryptToken(serialized, keys), 'dummy-token');
});

test('unsupported version fails', () => {
  const serialized = encryptToken('dummy-token', { keyId: KEY_ID_A, key: DUMMY_KEY_A });
  const payload = JSON.parse(serialized) as Record<string, unknown>;
  payload['v'] = 999;
  const keys = new Map([[KEY_ID_A, DUMMY_KEY_A]]);
  assert.throws(() => decryptToken(JSON.stringify(payload), keys), TokenDecryptionError);
});

test('malformed payloads fail without leaking material', () => {
  const keys = new Map([[KEY_ID_A, DUMMY_KEY_A]]);
  assert.throws(() => decryptToken('not-json', keys), TokenDecryptionError);
  assert.throws(() => decryptToken('{"v":1}', keys), TokenDecryptionError);
  try {
    decryptToken('{"v":1}', keys);
    assert.fail('should have thrown');
  } catch (error) {
    assert.ok(error instanceof TokenDecryptionError);
    assert.equal(error.message.includes('dummy'), false);
  }
});

test('invalid key length rejected on encrypt', () => {
  assert.throws(
    () => encryptToken('dummy-token', { keyId: KEY_ID_A, key: Buffer.alloc(16, 0x33) }),
    TokenEncryptionError,
  );
});

test('empty plaintext rejected', () => {
  assert.throws(
    () => encryptToken('', { keyId: KEY_ID_A, key: DUMMY_KEY_A }),
    TokenEncryptionError,
  );
});

test('decodeTokenEncryptionKey validates base64 and length', () => {
  const good = randomBytes(TOKEN_ENCRYPTION_KEY_BYTES).toString('base64');
  assert.equal(decodeTokenEncryptionKey(good).length, TOKEN_ENCRYPTION_KEY_BYTES);
  assert.throws(() => decodeTokenEncryptionKey(Buffer.alloc(16).toString('base64')), TokenEncryptionError);
});
