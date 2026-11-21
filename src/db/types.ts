import type { ColumnType, Generated } from 'kysely';

export type ExportFormat = 'markdown' | 'json' | 'html_css';
export type ColorFormat = 'hex' | 'rgb' | 'hsl' | 'oklch';
export type SpacingUnit = 'px' | 'rem';
export type PromptTarget = 'generic' | 'react_tailwind' | 'html_css' | 'vue_css';
export type ArtifactKind =
  | 'design_reference'
  | 'rebuild_prompt'
  | 'design_token_export'
  | 'asset_manifest';

export interface AccountsTable {
  id: string;
  provider: string;
  provider_subject: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface AccountSettingsTable {
  account_id: string;
  default_export_format: ExportFormat;
  color_format: ColorFormat;
  spacing_unit: SpacingUnit;
  include_responsive_breakpoints: boolean;
  redact_query_params_in_urls: boolean;
  default_prompt_target: PromptTarget;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface OauthTransactionsTable {
  id: string;
  state: string;
  provider_code_verifier: string;
  client_redirect_uri: string;
  client_code_challenge: string;
  handoff_code_hash: string | null;
  account_id: string | null;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  handoff_expires_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  consumed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

export interface SessionsTable {
  id: string;
  account_id: string;
  refresh_token_hash: string;
  user_agent: string | null;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  revoked_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  last_used_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface ProjectsTable {
  id: string;
  account_id: string;
  name: string;
  description: string;
  source_domain: string | null;
  version: Generated<number>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface ArtifactsTable {
  id: string;
  project_id: string;
  account_id: string;
  kind: ArtifactKind;
  title: string;
  schema_version: number;
  source_url: string | null;
  byte_length: number;
  content_sha256: string;
  version: Generated<number>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface ArtifactBodiesTable {
  artifact_id: string;
  body_json: unknown;
}

export interface DatabaseSchema {
  accounts: AccountsTable;
  account_settings: AccountSettingsTable;
  oauth_transactions: OauthTransactionsTable;
  sessions: SessionsTable;
  projects: ProjectsTable;
  artifacts: ArtifactsTable;
  artifact_bodies: ArtifactBodiesTable;
}
