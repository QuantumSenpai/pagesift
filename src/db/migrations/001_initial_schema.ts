import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('accounts')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('provider', 'text', (col) => col.notNull())
    .addColumn('provider_subject', 'text', (col) => col.notNull())
    .addColumn('email', 'text', (col) => col.notNull().unique())
    .addColumn('display_name', 'text', (col) => col.notNull())
    .addColumn('avatar_url', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addUniqueConstraint('uq_accounts_provider_subject', ['provider', 'provider_subject'])
    .execute();

  await db.schema
    .createTable('account_settings')
    .addColumn('account_id', 'uuid', (col) =>
      col.primaryKey().references('accounts.id').onDelete('cascade'),
    )
    .addColumn('default_export_format', 'text', (col) =>
      col
        .notNull()
        .defaultTo('markdown')
        .check(sql`default_export_format IN ('markdown', 'json', 'html_css')`),
    )
    .addColumn('color_format', 'text', (col) =>
      col
        .notNull()
        .defaultTo('hex')
        .check(sql`color_format IN ('hex', 'rgb', 'hsl', 'oklch')`),
    )
    .addColumn('spacing_unit', 'text', (col) =>
      col
        .notNull()
        .defaultTo('px')
        .check(sql`spacing_unit IN ('px', 'rem')`),
    )
    .addColumn('include_responsive_breakpoints', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('redact_query_params_in_urls', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('default_prompt_target', 'text', (col) =>
      col
        .notNull()
        .defaultTo('generic')
        .check(sql`default_prompt_target IN ('generic', 'react_tailwind', 'html_css', 'vue_css')`),
    )
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createTable('oauth_transactions')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('state', 'text', (col) => col.notNull().unique())
    .addColumn('provider_code_verifier', 'text', (col) => col.notNull())
    .addColumn('client_redirect_uri', 'text', (col) => col.notNull())
    .addColumn('client_code_challenge', 'text', (col) => col.notNull())
    .addColumn('handoff_code_hash', 'text', (col) => col.unique())
    .addColumn('account_id', 'uuid', (col) => col.references('accounts.id').onDelete('cascade'))
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('handoff_expires_at', 'timestamptz')
    .addColumn('consumed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('idx_oauth_transactions_expires_at')
    .on('oauth_transactions')
    .column('expires_at')
    .execute();

  await db.schema
    .createTable('sessions')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('account_id', 'uuid', (col) =>
      col.notNull().references('accounts.id').onDelete('cascade'),
    )
    .addColumn('refresh_token_hash', 'text', (col) => col.notNull().unique())
    .addColumn('user_agent', 'text')
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('revoked_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('last_used_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('idx_sessions_account_active')
    .on('sessions')
    .columns(['account_id', 'revoked_at', 'expires_at'])
    .execute();

  await db.schema
    .createTable('projects')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('account_id', 'uuid', (col) =>
      col.notNull().references('accounts.id').onDelete('cascade'),
    )
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('description', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('source_domain', 'text')
    .addColumn('version', 'integer', (col) =>
      col
        .notNull()
        .defaultTo(1)
        .check(sql`version >= 1`),
    )
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addUniqueConstraint('uq_projects_account_name', ['account_id', 'name'])
    .execute();

  await sql`CREATE INDEX idx_projects_account_updated_id ON projects (account_id, updated_at DESC, id DESC)`.execute(
    db,
  );

  await db.schema
    .createTable('artifacts')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('project_id', 'uuid', (col) =>
      col.notNull().references('projects.id').onDelete('cascade'),
    )
    .addColumn('account_id', 'uuid', (col) =>
      col.notNull().references('accounts.id').onDelete('cascade'),
    )
    .addColumn('kind', 'text', (col) =>
      col
        .notNull()
        .check(
          sql`kind IN ('design_reference', 'rebuild_prompt', 'design_token_export', 'asset_manifest')`,
        ),
    )
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('schema_version', 'integer', (col) => col.notNull().check(sql`schema_version >= 1`))
    .addColumn('source_url', 'text')
    .addColumn('byte_length', 'integer', (col) =>
      col.notNull().check(sql`byte_length > 0 AND byte_length <= 262144`),
    )
    .addColumn('content_sha256', 'text', (col) => col.notNull())
    .addColumn('version', 'integer', (col) =>
      col
        .notNull()
        .defaultTo(1)
        .check(sql`version >= 1`),
    )
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await sql`CREATE INDEX idx_artifacts_project_updated_id ON artifacts (project_id, account_id, updated_at DESC, id DESC)`.execute(
    db,
  );

  await sql`CREATE INDEX idx_artifacts_project_kind_updated_id ON artifacts (project_id, account_id, kind, updated_at DESC, id DESC)`.execute(
    db,
  );

  await db.schema
    .createTable('artifact_bodies')
    .addColumn('artifact_id', 'uuid', (col) =>
      col.primaryKey().references('artifacts.id').onDelete('cascade'),
    )
    .addColumn('body_json', 'jsonb', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('artifact_bodies').ifExists().execute();
  await db.schema.dropTable('artifacts').ifExists().execute();
  await db.schema.dropTable('projects').ifExists().execute();
  await db.schema.dropTable('sessions').ifExists().execute();
  await db.schema.dropTable('oauth_transactions').ifExists().execute();
  await db.schema.dropTable('account_settings').ifExists().execute();
  await db.schema.dropTable('accounts').ifExists().execute();
}
