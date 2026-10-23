import { randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';

export interface EmbeddedPostgresTestContext {
  databaseDir: string;
  databaseUrl: string;
  ownerPool: Pool;
  port: number;
  stop: () => Promise<void>;
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to allocate a free local port');
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

export async function startEmbeddedPostgres(): Promise<EmbeddedPostgresTestContext> {
  const databaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'postbro-pg-'));
  const port = await getFreePort();
  const password = randomBytes(16).toString('hex');
  const pg = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password,
    port,
    persistent: false,
    onLog: () => undefined,
    onError: () => undefined,
  });

  await pg.initialise();
  await pg.start();

  const databaseUrl = `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`;
  const ownerPool = new Pool({ connectionString: databaseUrl, max: 4 });

  return {
    databaseDir,
    databaseUrl,
    ownerPool,
    port,
    stop: async () => {
      await ownerPool.end();
      await pg.stop();
      await fs.rm(databaseDir, { recursive: true, force: true });
    },
  };
}

export async function createLoginRole(
  ownerPool: Pool,
  role: string,
  password: string,
  memberOf: string,
): Promise<string> {
  const { rows } = await ownerPool.query<{ sql: string }>(
    `SELECT format(
       'DROP ROLE IF EXISTS %I; CREATE ROLE %I LOGIN PASSWORD %L; GRANT %I TO %I;',
       $1::text, $1::text, $2::text, $3::text, $1::text
     ) AS sql`,
    [role, password, memberOf],
  );
  const sql = rows[0]!.sql;
  if (!sql) {
    throw new Error('Failed to generate login role SQL');
  }
  await ownerPool.query(sql);
  return `postgres://${role}:${encodeURIComponent(password)}@127.0.0.1:${ownerPool.options.port ?? 5432}/postgres`;
}

export function connectionStringFor(port: number, role: string, password: string): string {
  return `postgres://${role}:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`;
}
