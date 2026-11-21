import { loadConfig } from '../config/env.js';
import { createDatabaseContext } from './client.js';
import { runMigrationsToLatest } from './migrator.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const dbContext = createDatabaseContext(config);

  try {
    const { results } = await runMigrationsToLatest(dbContext.db);
    const executed = (results ?? []).map((item) => `${item.migrationName}:${item.status}`);
    process.stdout.write(
      JSON.stringify({
        event: 'migrations_completed',
        executed,
      }) + '\n',
    );
  } finally {
    await dbContext.close();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'Unknown migration error';
  process.stderr.write(JSON.stringify({ event: 'migrations_failed', message }) + '\n');
  process.exit(1);
});
