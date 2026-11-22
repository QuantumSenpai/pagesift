import { loadConfig } from '../config/env.js';
import { runMigrationsWithDirectConnection } from './migrator.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const { results } = await runMigrationsWithDirectConnection(config);
  const executed = (results ?? []).map((item) => `${item.migrationName}:${item.status}`);
  process.stdout.write(
    JSON.stringify({
      event: 'migrations_completed',
      connectionMode: config.DATABASE_URL_UNPOOLED !== undefined ? 'direct' : 'default_fallback',
      executed,
    }) + '\n',
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'Unknown migration error';
  process.stderr.write(JSON.stringify({ event: 'migrations_failed', message }) + '\n');
  process.exit(1);
});
