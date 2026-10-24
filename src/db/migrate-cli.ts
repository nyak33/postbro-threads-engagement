import { createDbPool } from './client';
import { DEFAULT_MIGRATIONS_DIR, migrateDatabase, planMigrations } from './migrate';

async function main(): Promise<void> {
  const planOnly = process.argv.includes('--plan');
  const db = createDbPool();
  try {
    if (planOnly) {
      const plan = await planMigrations(db, DEFAULT_MIGRATIONS_DIR);
      for (const entry of plan) {
        process.stdout.write(`${entry.status} ${entry.version} ${entry.checksum}\n`);
      }
      if (plan.some((entry) => entry.status === 'modified_after_apply')) {
        process.exit(2);
      }
      return;
    }

    const applied = await migrateDatabase(db, DEFAULT_MIGRATIONS_DIR);
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
