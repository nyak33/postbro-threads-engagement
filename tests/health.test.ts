import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app';

test('GET /health returns a stable health payload without configuration secrets', async () => {
  const app = buildApp();

  try {
    const response = await app.inject({ method: 'GET', url: '/health' });

    assert.equal(response.statusCode, 200);
    const body = response.json() as Record<string, unknown>;
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'postbro');
    assert.equal(typeof body.timestamp, 'string');
    assert.equal(body.config, undefined);
    assert.equal(body.env, undefined);
  } finally {
    await app.close();
  }
});

test('unknown routes return a predictable Fastify 404 response', async () => {
  const app = buildApp();

  try {
    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });

    assert.equal(response.statusCode, 404);
    const body = response.json() as Record<string, unknown>;
    assert.equal(body.error, 'Not Found');
    assert.equal(body.statusCode, 404);
  } finally {
    await app.close();
  }
});
