import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createDatabaseContext } from './db/client.js';
import { runMigrationsToLatest } from './db/migrator.js';

async function startServer(): Promise<void> {
  const config = loadConfig(process.env);
  const dbContext = createDatabaseContext(config);

  await runMigrationsToLatest(dbContext.db);

  const app = await buildApp({ config, dbContext });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    app.log.info({ signal }, 'Initiating graceful shutdown');

    const forceTimer = setTimeout(() => {
      app.log.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 10000);
    forceTimer.unref();

    try {
      await app.close();
      clearTimeout(forceTimer);
      process.exit(0);
    } catch (err: unknown) {
      app.log.error({ err }, 'Error during graceful shutdown');
      clearTimeout(forceTimer);
      process.exit(1);
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await app.listen({
    host: config.HOST,
    port: config.PORT,
  });
}

startServer().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'Fatal startup failure';
  process.stderr.write(JSON.stringify({ event: 'startup_failed', message }) + '\n');
  process.exit(1);
});
