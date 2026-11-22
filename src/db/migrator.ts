import type { Kysely } from 'kysely';
import {
  Migrator,
  type Migration,
  type MigrationProvider,
  type MigrationResultSet,
} from 'kysely/migration';
import type { AppConfig } from '../config/env.js';
import { createMigrationDatabaseContext } from './client.js';
import type { DatabaseSchema } from './types.js';
import * as initialSchema from './migrations/001_initial_schema.js';

class StaticMigrationProvider implements MigrationProvider {
  public getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve({
      '001_initial_schema': {
        up: initialSchema.up,
        down: initialSchema.down,
      },
    });
  }
}

export async function runMigrationsToLatest(
  db: Kysely<DatabaseSchema>,
): Promise<MigrationResultSet> {
  const migrator = new Migrator({
    db,
    provider: new StaticMigrationProvider(),
  });

  const resultSet = await migrator.migrateToLatest();
  if (resultSet.error) {
    throw resultSet.error instanceof Error
      ? resultSet.error
      : new Error('Database migration failed');
  }

  return resultSet;
}

export async function runMigrationsWithDirectConnection(
  config: AppConfig,
): Promise<MigrationResultSet> {
  const migrationDbContext = createMigrationDatabaseContext(config);
  try {
    return await runMigrationsToLatest(migrationDbContext.db);
  } finally {
    await migrationDbContext.close();
  }
}
