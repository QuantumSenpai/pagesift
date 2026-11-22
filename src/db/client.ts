import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { resolveDirectDatabaseUrl, type AppConfig } from '../config/env.js';
import type { DatabaseSchema } from './types.js';

const { Pool } = pg;

export interface DatabaseContextOptions {
  connectionString?: string;
  poolMax?: number;
}

export interface DatabaseContext {
  db: Kysely<DatabaseSchema>;
  pool: pg.Pool;
  checkReadiness: (timeoutMs: number) => Promise<{ ok: boolean; latencyMs: number }>;
  close: () => Promise<void>;
}

export function createDatabaseContext(
  config: AppConfig,
  options: DatabaseContextOptions = {},
): DatabaseContext {
  const pool = new Pool({
    connectionString: options.connectionString ?? config.DATABASE_URL,
    max: options.poolMax ?? config.DB_POOL_MAX,
    connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: config.DB_IDLE_TIMEOUT_MS,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    query_timeout: config.DB_STATEMENT_TIMEOUT_MS,
  });

  const db = new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({
      pool,
    }),
  });

  let isClosed = false;

  const checkReadiness = async (timeoutMs: number): Promise<{ ok: boolean; latencyMs: number }> => {
    const startedAt = performance.now();
    let timerId: NodeJS.Timeout | undefined;

    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timerId = setTimeout(() => {
          reject(new Error('Database readiness timeout exceeded'));
        }, timeoutMs);
      });

      await Promise.race([sql`SELECT 1`.execute(db), timeoutPromise]);
      const latencyMs = Math.round(performance.now() - startedAt);
      return { ok: true, latencyMs };
    } catch {
      const latencyMs = Math.round(performance.now() - startedAt);
      return { ok: false, latencyMs };
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    }
  };

  const close = async (): Promise<void> => {
    if (isClosed) {
      return;
    }
    isClosed = true;
    await db.destroy();
  };

  return {
    db,
    pool,
    checkReadiness,
    close,
  };
}

export function createMigrationDatabaseContext(config: AppConfig): DatabaseContext {
  return createDatabaseContext(config, {
    connectionString: resolveDirectDatabaseUrl(config),
    poolMax: 1,
  });
}
