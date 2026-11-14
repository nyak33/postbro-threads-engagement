/**
 * PB-P0-004 slice C: one-time TEST operator login-link CLI.
 *
 * Mints a signed one-time Threads connect link for a single EXISTING ACTIVE
 * operator. This CLI is the ONLY way to obtain such a link in this phase —
 * no public mint endpoint exists. It is invoked locally by an authorized
 * operator with protected env config (DATABASE_URL, APP_SIGNING_SECRET,
 * PUBLIC_BASE_URL); it never creates operators and never prints secrets.
 *
 * Usage:
 *   node dist/src/modules/auth/login-link-cli.js --operator <id>
 *
 * Output: the full one-time link URL on stdout (the operator chose to run
 * this, so the link is the intended artifact), plus jti/expiry on stderr.
 * The link itself contains no secrets — only operator id, jti, expiry and
 * HMAC signature — but it MUST still be treated as a credential (one-time).
 *
 * First operator setup is a documented, separately approved procedure
 * (see docs/tasks/PB-P0-004.md); this CLI refuses unknown/inactive ids.
 */

import { parseConfig } from '../../config';
import { closeDbPool, createDbPool } from '../../db/client';
import { mintLinkToken } from './oauth-state';

function usage(): never {
  process.stderr.write(
    'usage: login-link-cli --operator <positive integer id>\n' +
      'env required: DATABASE_URL (+ TLS vars), APP_SIGNING_SECRET, PUBLIC_BASE_URL\n',
  );
  process.exit(64);
}

function parseOperatorId(argv: string[]): number {
  const idx = argv.indexOf('--operator');
  if (idx === -1 || idx + 1 >= argv.length) {
    usage();
  }
  const value = Number(argv[idx + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    process.stderr.write('--operator must be a positive integer operator id\n');
    process.exit(64);
  }
  return value;
}

async function main(): Promise<void> {
  const operatorId = parseOperatorId(process.argv.slice(2));
  const config = parseConfig();

  if (!config.databaseUrl) {
    process.stderr.write('DATABASE_URL is required\n');
    process.exit(78); // EX_CONFIG
  }
  if (!config.appSigningSecret) {
    process.stderr.write('APP_SIGNING_SECRET is required\n');
    process.exit(78);
  }
  if (!config.publicBaseUrl) {
    process.stderr.write('PUBLIC_BASE_URL is required to build the link\n');
    process.exit(78);
  }

  const pool = createDbPool(config);
  try {
    const minted = await mintLinkToken(pool, {
      operatorId,
      signingSecret: config.appSigningSecret,
    });
    const base = new URL(config.publicBaseUrl);
    const link = new URL('/auth/threads/start', base);
    link.searchParams.set('link', minted.token);
    process.stdout.write(`${link.toString()}\n`);
    process.stderr.write(
      `one-time link minted: operator=${operatorId} jti=${minted.jti} ` +
        `expiresAt=${minted.expiresAt.toISOString()}\n` +
        'Link is one-time and short-lived; deliver it to the operator over a private channel only.\n',
    );
  } finally {
    await closeDbPool(pool);
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
