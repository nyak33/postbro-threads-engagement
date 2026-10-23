import path from 'node:path';

import { createDbPool } from './client';
import { migrateDatabase } from './migrate';

async function main(): Promise<void> {
  const db = createDbPool();
  try {
    const applied = await migrateDatabase(db, path.join(process.cwd(), 'supabase', 'migrations'));
    process.stdout.write(`Applied migrations: ${applied.length > 0 ? applied.join(', ') : 'none'}\n`);
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown migration error';
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
