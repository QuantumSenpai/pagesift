import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config/env.js';
import { createAuthPreHandler, getRequiredAuthContext } from '../plugins/authenticate.js';
import { safeHttpUrlSchema } from '../schemas/artifact-schemas.js';
import type { ArtifactService } from '../services/artifact-service.js';
import type { AuthService } from '../services/auth-service.js';
import { validateWithZod } from '../utils/validation.js';

const artifactKindSchema = z.enum([
  'design_reference',
  'rebuild_prompt',
  'design_token_export',
  'asset_manifest',
]);

const projectParamsSchema = z.strictObject({
  projectId: z.uuid(),
});

const artifactParamsSchema = z.strictObject({
  projectId: z.uuid(),
  artifactId: z.uuid(),
});

const listArtifactsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().trim().min(1).max(512).optional(),
  kind: artifactKindSchema.optional(),
});

const createArtifactBodySchema = z.strictObject({
  kind: artifactKindSchema,
  title: z.string().trim().min(1).max(200),
  schemaVersion: z.number().int().min(1),
  sourceUrl: safeHttpUrlSchema.nullable().optional(),
  content: z.record(z.string(), z.unknown()),
});

const updateArtifactBodySchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  schemaVersion: z.number().int().min(1),
  sourceUrl: safeHttpUrlSchema.nullable().optional(),
  content: z.record(z.string(), z.unknown()),
  expectedVersion: z.number().int().min(1),
});

const artifactSummaryJsonSchema = {
  type: 'object',
  required: [
    'id',
    'projectId',
    'kind',
    'title',
    'schemaVersion',
    'sourceUrl',
    'byteLength',
    'contentSha256',
    'version',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    projectId: { type: 'string', format: 'uuid' },
    kind: {
      type: 'string',
      enum: ['design_reference', 'rebuild_prompt', 'design_token_export', 'asset_manifest'],
    },
    title: { type: 'string' },
    schemaVersion: { type: 'integer', minimum: 1 },
    sourceUrl: { type: ['string', 'null'] },
    byteLength: { type: 'integer', minimum: 1 },
    contentSha256: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

const artifactDetailJsonSchema = {
  type: 'object',
  required: [...artifactSummaryJsonSchema.required, 'content'],
  properties: {
    ...artifactSummaryJsonSchema.properties,
    content: {
      type: 'object',
      additionalProperties: true,
    },
  },
};

export function registerArtifactRoutes(
  app: FastifyInstance,
  config: AppConfig,
  authService: AuthService,
  artifactService: ArtifactService,
): void {
  const requireAuth = createAuthPreHandler(authService);
  const writeRateLimit = {
    max: config.RATE_LIMIT_WRITE_MAX,
    timeWindow: config.RATE_LIMIT_WRITE_WINDOW_MS,
  };

  app.post(
    '/v1/projects/:projectId/artifacts',
    {
      preHandler: [requireAuth],
      config: { rateLimit: writeRateLimit },
      schema: {
        tags: ['Artifacts'],
        summary: 'Save a versioned artifact under an owned project',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['projectId'],
          properties: {
            projectId: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          required: ['kind', 'title', 'schemaVersion', 'content'],
          properties: {
            kind: {
              type: 'string',
              enum: ['design_reference', 'rebuild_prompt', 'design_token_export', 'asset_manifest'],
            },
            title: { type: 'string', minLength: 1, maxLength: 200 },
            schemaVersion: { type: 'integer', minimum: 1 },
            sourceUrl: { type: ['string', 'null'] },
            content: { type: 'object', additionalProperties: true },
          },
        },
        response: {
          201: {
            type: 'object',
            required: ['artifact'],
            properties: {
              artifact: artifactDetailJsonSchema,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = getRequiredAuthContext(request);
      const params = validateWithZod(projectParamsSchema, request.params);
      const body = validateWithZod(createArtifactBodySchema, request.body);
      const artifact = await artifactService.createArtifact(auth.accountId, params.projectId, body);
      return reply.status(201).send({ artifact });
    },
  );

  app.get(
    '/v1/projects/:projectId/artifacts',
    {
      preHandler: [requireAuth],
      schema: {
        tags: ['Artifacts'],
        summary: 'List artifact metadata for an owned project without loading artifact bodies',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['projectId'],
          properties: {
            projectId: { type: 'string', format: 'uuid' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            cursor: { type: 'string' },
            kind: {
              type: 'string',
              enum: ['design_reference', 'rebuild_prompt', 'design_token_export', 'asset_manifest'],
            },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['items', 'nextCursor'],
            properties: {
              items: {
                type: 'array',
                items: artifactSummaryJsonSchema,
              },
              nextCursor: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = getRequiredAuthContext(request);
      const params = validateWithZod(projectParamsSchema, request.params);
      const query = validateWithZod(listArtifactsQuerySchema, request.query);
      const result = await artifactService.listArtifacts(auth.accountId, params.projectId, query);
      return reply.status(200).send(result);
    },
  );

  app.get(
    '/v1/projects/:projectId/artifacts/:artifactId',
    {
      preHandler: [requireAuth],
      schema: {
        tags: ['Artifacts'],
        summary: 'Retrieve full artifact metadata and body content',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['projectId', 'artifactId'],
          properties: {
            projectId: { type: 'string', format: 'uuid' },
            artifactId: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['artifact'],
            properties: {
              artifact: artifactDetailJsonSchema,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = getRequiredAuthContext(request);
      const params = validateWithZod(artifactParamsSchema, request.params);
      const artifact = await artifactService.getArtifact(
        auth.accountId,
        params.projectId,
        params.artifactId,
      );
      return reply.status(200).send({ artifact });
    },
  );

  app.put(
    '/v1/projects/:projectId/artifacts/:artifactId',
    {
      preHandler: [requireAuth],
      config: { rateLimit: writeRateLimit },
      schema: {
        tags: ['Artifacts'],
        summary: 'Update an artifact with optimistic concurrency control (expectedVersion)',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['projectId', 'artifactId'],
          properties: {
            projectId: { type: 'string', format: 'uuid' },
            artifactId: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          required: ['schemaVersion', 'content', 'expectedVersion'],
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 200 },
            schemaVersion: { type: 'integer', minimum: 1 },
            sourceUrl: { type: ['string', 'null'] },
            content: { type: 'object', additionalProperties: true },
            expectedVersion: { type: 'integer', minimum: 1 },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['artifact'],
            properties: {
              artifact: artifactDetailJsonSchema,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = getRequiredAuthContext(request);
      const params = validateWithZod(artifactParamsSchema, request.params);
      const body = validateWithZod(updateArtifactBodySchema, request.body);
      const artifact = await artifactService.updateArtifact(
        auth.accountId,
        params.projectId,
        params.artifactId,
        body,
      );
      return reply.status(200).send({ artifact });
    },
  );

  app.delete(
    '/v1/projects/:projectId/artifacts/:artifactId',
    {
      preHandler: [requireAuth],
      config: { rateLimit: writeRateLimit },
      schema: {
        tags: ['Artifacts'],
        summary: 'Delete an owned artifact and its stored body',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['projectId', 'artifactId'],
          properties: {
            projectId: { type: 'string', format: 'uuid' },
            artifactId: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          204: {
            type: 'null',
          },
        },
      },
    },
    async (request, reply) => {
      const auth = getRequiredAuthContext(request);
      const params = validateWithZod(artifactParamsSchema, request.params);
      await artifactService.deleteArtifact(auth.accountId, params.projectId, params.artifactId);
      return reply.status(204).send();
    },
  );
}
