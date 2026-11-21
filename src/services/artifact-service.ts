import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { ArtifactKind, DatabaseSchema } from '../db/types.js';
import { AppError } from '../errors/app-error.js';
import { validateArtifactContent } from '../schemas/artifact-schemas.js';
import { decodeCursor, encodeCursor } from '../utils/pagination.js';

export interface ArtifactSummaryDto {
  id: string;
  projectId: string;
  kind: ArtifactKind;
  title: string;
  schemaVersion: number;
  sourceUrl: string | null;
  byteLength: number;
  contentSha256: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactDetailDto extends ArtifactSummaryDto {
  content: unknown;
}

export interface CreateArtifactInput {
  kind: ArtifactKind;
  title: string;
  schemaVersion: number;
  sourceUrl?: string | null | undefined;
  content: unknown;
}

export interface UpdateArtifactInput {
  title?: string | undefined;
  schemaVersion: number;
  sourceUrl?: string | null | undefined;
  content: unknown;
  expectedVersion: number;
}

function toIsoString(val: Date | string): string {
  return val instanceof Date ? val.toISOString() : new Date(val).toISOString();
}

function mapArtifactSummaryRowToDto(row: {
  id: string;
  project_id: string;
  kind: ArtifactKind;
  title: string;
  schema_version: number;
  source_url: string | null;
  byte_length: number;
  content_sha256: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}): ArtifactSummaryDto {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    schemaVersion: row.schema_version,
    sourceUrl: row.source_url,
    byteLength: row.byte_length,
    contentSha256: row.content_sha256,
    version: row.version,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function computeSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class ArtifactService {
  private readonly db: Kysely<DatabaseSchema>;

  public constructor(db: Kysely<DatabaseSchema>) {
    this.db = db;
  }

  public async createArtifact(
    accountId: string,
    projectId: string,
    input: CreateArtifactInput,
  ): Promise<ArtifactDetailDto> {
    const { validatedContent, serializedJson, byteLength } = validateArtifactContent(
      input.kind,
      input.schemaVersion,
      input.content,
    );
    const contentSha256 = computeSha256(serializedJson);
    const now = new Date();
    const artifactId = randomUUID();

    return await this.db.transaction().execute(async (trx) => {
      const project = await trx
        .selectFrom('projects')
        .select(['id'])
        .where('id', '=', projectId)
        .where('account_id', '=', accountId)
        .executeTakeFirst();

      if (!project) {
        throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Project not found');
      }

      const insertedMeta = await trx
        .insertInto('artifacts')
        .values({
          id: artifactId,
          project_id: projectId,
          account_id: accountId,
          kind: input.kind,
          title: input.title,
          schema_version: input.schemaVersion,
          source_url: input.sourceUrl ?? null,
          byte_length: byteLength,
          content_sha256: contentSha256,
          version: 1,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('artifact_bodies')
        .values({
          artifact_id: artifactId,
          body_json: validatedContent,
        })
        .execute();

      return {
        ...mapArtifactSummaryRowToDto(insertedMeta),
        content: validatedContent,
      };
    });
  }

  public async listArtifacts(
    accountId: string,
    projectId: string,
    params: {
      limit: number;
      cursor?: string | undefined;
      kind?: ArtifactKind | undefined;
    },
  ): Promise<{ items: ArtifactSummaryDto[]; nextCursor: string | null }> {
    const project = await this.db
      .selectFrom('projects')
      .select(['id'])
      .where('id', '=', projectId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();

    if (!project) {
      throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Project not found');
    }

    let query = this.db
      .selectFrom('artifacts')
      .select([
        'id',
        'project_id',
        'kind',
        'title',
        'schema_version',
        'source_url',
        'byte_length',
        'content_sha256',
        'version',
        'created_at',
        'updated_at',
      ])
      .where('project_id', '=', projectId)
      .where('account_id', '=', accountId);

    if (params.kind !== undefined) {
      query = query.where('kind', '=', params.kind);
    }

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
    const items = pageRows.map((row) => mapArtifactSummaryRowToDto(row));
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

  public async getArtifact(
    accountId: string,
    projectId: string,
    artifactId: string,
  ): Promise<ArtifactDetailDto> {
    const row = await this.db
      .selectFrom('artifacts')
      .innerJoin('artifact_bodies', 'artifact_bodies.artifact_id', 'artifacts.id')
      .select([
        'artifacts.id as id',
        'artifacts.project_id as project_id',
        'artifacts.kind as kind',
        'artifacts.title as title',
        'artifacts.schema_version as schema_version',
        'artifacts.source_url as source_url',
        'artifacts.byte_length as byte_length',
        'artifacts.content_sha256 as content_sha256',
        'artifacts.version as version',
        'artifacts.created_at as created_at',
        'artifacts.updated_at as updated_at',
        'artifact_bodies.body_json as body_json',
      ])
      .where('artifacts.id', '=', artifactId)
      .where('artifacts.project_id', '=', projectId)
      .where('artifacts.account_id', '=', accountId)
      .executeTakeFirst();

    if (!row) {
      throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Artifact not found');
    }

    return {
      ...mapArtifactSummaryRowToDto(row),
      content: row.body_json,
    };
  }

  public async updateArtifact(
    accountId: string,
    projectId: string,
    artifactId: string,
    input: UpdateArtifactInput,
  ): Promise<ArtifactDetailDto> {
    const now = new Date();

    return await this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('artifacts')
        .selectAll()
        .where('id', '=', artifactId)
        .where('project_id', '=', projectId)
        .where('account_id', '=', accountId)
        .forUpdate()
        .executeTakeFirst();

      if (!existing) {
        throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Artifact not found');
      }

      if (existing.version !== input.expectedVersion) {
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          'Artifact has been modified by another request',
          [
            {
              field: 'expectedVersion',
              issue: `Expected version ${input.expectedVersion} does not match current version ${existing.version}`,
            },
          ],
        );
      }

      const { validatedContent, serializedJson, byteLength } = validateArtifactContent(
        existing.kind,
        input.schemaVersion,
        input.content,
      );
      const contentSha256 = computeSha256(serializedJson);

      const updatedMeta = await trx
        .updateTable('artifacts')
        .set({
          title: input.title ?? existing.title,
          schema_version: input.schemaVersion,
          source_url: input.sourceUrl !== undefined ? input.sourceUrl : existing.source_url,
          byte_length: byteLength,
          content_sha256: contentSha256,
          version: existing.version + 1,
          updated_at: now,
        })
        .where('id', '=', artifactId)
        .where('project_id', '=', projectId)
        .where('account_id', '=', accountId)
        .where('version', '=', input.expectedVersion)
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .updateTable('artifact_bodies')
        .set({
          body_json: validatedContent,
        })
        .where('artifact_id', '=', artifactId)
        .execute();

      return {
        ...mapArtifactSummaryRowToDto(updatedMeta),
        content: validatedContent,
      };
    });
  }

  public async deleteArtifact(
    accountId: string,
    projectId: string,
    artifactId: string,
  ): Promise<void> {
    const deleted = await this.db
      .deleteFrom('artifacts')
      .where('id', '=', artifactId)
      .where('project_id', '=', projectId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();

    if (Number(deleted.numDeletedRows) === 0) {
      throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Artifact not found');
    }
  }
}
