import type { Kysely } from 'kysely';
import type {
  ColorFormat,
  DatabaseSchema,
  ExportFormat,
  PromptTarget,
  SpacingUnit,
} from '../db/types.js';
import { AppError } from '../errors/app-error.js';

export interface AccountSettingsDto {
  defaultExportFormat: ExportFormat;
  colorFormat: ColorFormat;
  spacingUnit: SpacingUnit;
  includeResponsiveBreakpoints: boolean;
  redactQueryParamsInUrls: boolean;
  defaultPromptTarget: PromptTarget;
  updatedAt: string;
}

export interface UpdateAccountSettingsInput {
  defaultExportFormat: ExportFormat;
  colorFormat: ColorFormat;
  spacingUnit: SpacingUnit;
  includeResponsiveBreakpoints: boolean;
  redactQueryParamsInUrls: boolean;
  defaultPromptTarget: PromptTarget;
}

function mapSettingsRowToDto(row: {
  default_export_format: ExportFormat;
  color_format: ColorFormat;
  spacing_unit: SpacingUnit;
  include_responsive_breakpoints: boolean;
  redact_query_params_in_urls: boolean;
  default_prompt_target: PromptTarget;
  updated_at: Date | string;
}): AccountSettingsDto {
  const updatedAtIso =
    row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : new Date(row.updated_at).toISOString();

  return {
    defaultExportFormat: row.default_export_format,
    colorFormat: row.color_format,
    spacingUnit: row.spacing_unit,
    includeResponsiveBreakpoints: row.include_responsive_breakpoints,
    redactQueryParamsInUrls: row.redact_query_params_in_urls,
    defaultPromptTarget: row.default_prompt_target,
    updatedAt: updatedAtIso,
  };
}

export class SettingsService {
  private readonly db: Kysely<DatabaseSchema>;

  public constructor(db: Kysely<DatabaseSchema>) {
    this.db = db;
  }

  public async getSettings(accountId: string): Promise<AccountSettingsDto> {
    const row = await this.db
      .selectFrom('account_settings')
      .selectAll()
      .where('account_id', '=', accountId)
      .executeTakeFirst();

    if (!row) {
      throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Account settings not found');
    }

    return mapSettingsRowToDto(row);
  }

  public async updateSettings(
    accountId: string,
    input: UpdateAccountSettingsInput,
  ): Promise<AccountSettingsDto> {
    const now = new Date();

    const updatedRow = await this.db
      .updateTable('account_settings')
      .set({
        default_export_format: input.defaultExportFormat,
        color_format: input.colorFormat,
        spacing_unit: input.spacingUnit,
        include_responsive_breakpoints: input.includeResponsiveBreakpoints,
        redact_query_params_in_urls: input.redactQueryParamsInUrls,
        default_prompt_target: input.defaultPromptTarget,
        updated_at: now,
      })
      .where('account_id', '=', accountId)
      .returningAll()
      .executeTakeFirst();

    if (!updatedRow) {
      throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Account settings not found');
    }

    return mapSettingsRowToDto(updatedRow);
  }
}
