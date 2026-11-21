import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/types.js';
import { AppError } from '../errors/app-error.js';
import { decodeCursor, encodeCursor } from '../utils/pagination.js';

export interface ProjectDto {
  id: string;
  name: string;
  description: string;
  sourceDomain: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string | undefined;
  sourceDomain?: string | null | undefined;
}

export interface UpdateProjectInput {
  name?: string | undefined;
  description?: string | undefined;
  sourceDomain?: string | null | undefined;
  expectedVersion: number;
}

function toIsoString(val: Date | string): string {
  return val instanceof Date ? val.toISOString() : new Date(val).toISOString();
}

function mapProjectRowToDto(row: {
  id: string;
  name: string;
  description: string;
  source_domain: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceDomain: row.source_domain,
    version: row.version,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function isUniqueConstraintError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return (err as { code?: string }).code === '23505';
  }
  return false;
}

export class ProjectService {
  private readonly db: Kysely<DatabaseSchema>;

  public constructor(db: Kysely<DatabaseSchema>) {
    this.db = db;
  }

  public async createProject(accountId: string, input: CreateProjectInput): Promise<ProjectDto> {
    const now = new Date();
    const projectId = randomUUID();

    try {
      const inserted = await this.db
        .insertInto('projects')
        .values({
          id: projectId,
          account_id: accountId,
          name: input.name,
          description: input.description ?? '',
          source_domain: input.sourceDomain ?? null,
          version: 1,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return mapProjectRowToDto(inserted);
    } catch (err: unknown) {
      if (isUniqueConstraintError(err)) {
        throw new AppError(409, 'CONFLICT', 'A project with this name already exists');
      }
      throw err;
    }
  }

  public async getProject(accountId: string, projectId: string): Promise<ProjectDto> {
    const row = await this.db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', projectId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();

    if (!row) {
      throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Project not found');
    }

    return mapProjectRowToDto(row);
  }

  public async listProjects(
    accountId: string,
    params: { limit: number; cursor?: string | undefined },
  ): Promise<{ items: ProjectDto[]; nextCursor: string | null }> {
    let query = this.db.selectFrom('projects').selectAll().where('account_id', '=', accountId);

    if (params.cursor) {
      const decoded = decodeCursor(params.cursor);
      query = query.where(
        sql<boolean>`(updated_at, id) < (${decoded.updatedAt.toISOString()}::timestamptz, ${decoded.id}::uuid)`,
      );
    }

    const rows = await query
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc')
      .limit(params.limit + 1)
      .execute();

    const hasNextPage = rows.length > params.limit;
    const pageRows = hasNextPage ? rows.slice(0, params.limit) : rows;
    const items = pageRows.map((row) => mapProjectRowToDto(row));
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasNextPage && lastRow
        ? encodeCursor({ updatedAt: lastRow.updated_at, id: lastRow.id })
        : null;

    return {
      items,
      nextCursor,
    };
  }

  public async updateProject(
    accountId: string,
    projectId: string,
    input: UpdateProjectInput,
  ): Promise<ProjectDto> {
    const now = new Date();

    return await this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('projects')
        .selectAll()
        .where('id', '=', projectId)
        .where('account_id', '=', accountId)
        .forUpdate()
        .executeTakeFirst();

      if (!existing) {
        throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Project not found');
      }

      if (existing.version !== input.expectedVersion) {
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          'Project has been modified by another request',
          [
            {
              field: 'expectedVersion',
              issue: `Expected version ${input.expectedVersion} does not match current version ${existing.version}`,
            },
          ],
        );
      }

      try {
        const updated = await trx
          .updateTable('projects')
          .set({
            name: input.name ?? existing.name,
            description: input.description ?? existing.description,
            source_domain:
              input.sourceDomain !== undefined ? input.sourceDomain : existing.source_domain,
            version: existing.version + 1,
            updated_at: now,
          })
          .where('id', '=', projectId)
          .where('account_id', '=', accountId)
          .where('version', '=', input.expectedVersion)
          .returningAll()
          .executeTakeFirstOrThrow();

        return mapProjectRowToDto(updated);
      } catch (err: unknown) {
        if (isUniqueConstraintError(err)) {
          throw new AppError(409, 'CONFLICT', 'A project with this name already exists');
        }
        throw err;
      }
    });
  }

  public async deleteProject(accountId: string, projectId: string): Promise<void> {
    const deleted = await this.db
      .deleteFrom('projects')
      .where('id', '=', projectId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();

    if (Number(deleted.numDeletedRows) === 0) {
      throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Project not found');
    }
  }
}
