import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createDatabaseContext } from './db/client.js';
import { runMigrationsWithDirectConnection } from './db/migrator.js';

async function startServer(): Promise<void> {
  const config = loadConfig(process.env);

  await runMigrationsWithDirectConnection(config);

  const dbContext = createDatabaseContext(config);
  let app: Awaited<ReturnType<typeof buildApp>>;
  try {
    app = await buildApp({ config, dbContext });
  } catch (err: unknown) {
    await dbContext.close();
    throw err;
  }

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
