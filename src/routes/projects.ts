import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config/env.js';
import { createAuthPreHandler, getRequiredAuthContext } from '../plugins/authenticate.js';
import type { AuthService } from '../services/auth-service.js';
import type { ProjectService } from '../services/project-service.js';
import { paginationQuerySchema } from '../utils/pagination.js';
import { validateWithZod } from '../utils/validation.js';

const domainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
    'sourceDomain must be a valid hostname without protocol or path',
  );

const createProjectBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  sourceDomain: domainSchema.nullable().optional(),
});

const updateProjectBodySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).optional(),
    sourceDomain: domainSchema.nullable().optional(),
    expectedVersion: z.number().int().min(1),
  })
  .refine(
    (val) =>
      val.name !== undefined || val.description !== undefined || val.sourceDomain !== undefined,
    {
      message: 'At least one mutable project field must be provided',
    },
  );

const projectIdParamsSchema = z.strictObject({
  projectId: z.uuid(),
});

const projectJsonSchema = {
  type: 'object',
  required: ['id', 'name', 'description', 'sourceDomain', 'version', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    description: { type: 'string' },
    sourceDomain: { type: ['string', 'null'] },
    version: { type: 'integer', minimum: 1 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

export function registerProjectRoutes(
  app: FastifyInstance,
  config: AppConfig,
  authService: AuthService,
  projectService: ProjectService,
): void {
  const requireAuth = createAuthPreHandler(authService);
  const writeRateLimit = {
    max: config.RATE_LIMIT_WRITE_MAX,
    timeWindow: config.RATE_LIMIT_WRITE_WINDOW_MS,
  };

  app.post(
    '/v1/projects',
    {
      preHandler: [requireAuth],
      config: { rateLimit: writeRateLimit },
      schema: {
        tags: ['Projects'],
        summary: 'Create a new project owned by the authenticated account',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            description: { type: 'string', maxLength: 1000 },
            sourceDomain: { type: ['string', 'null'], maxLength: 253 },
          },
        },
        response: {
          201: {
            type: 'object',
            required: ['project'],
            properties: {
              project: projectJsonSchema,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = getRequiredAuthContext(request);
      const body = validateWithZod(createProjectBodySchema, request.body);
      const project = await projectService.createProject(auth.accountId, body);
      return reply.status(201).send({ project });
    },
  );

  app.get(
    '/v1/projects',
    {
      preHandler: [requireAuth],
      schema: {
        tags: ['Projects'],
        summary:
          'List projects owned by the authenticated account with deterministic cursor pagination',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            cursor: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['items', 'nextCursor'],
            properties: {
              items: {
                type: 'array',
                items: projectJsonSchema,
              },
              nextCursor: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = getRequiredAuthContext(request);
      const query = validateWithZod(paginationQuerySchema, request.query);
      const result = await projectService.listProjects(auth.accountId, query);
      return reply.status(200).send(result);
    },
  );

  app.get(
    '/v1/projects/:projectId',
    {
      preHandler: [requireAuth],
      schema: {
        tags: ['Projects'],
        summary: 'Retrieve a project by ID (enforcing ownership)',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['projectId'],
          properties: {
            projectId: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['project'],
            properties: {
              project: projectJsonSchema,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = getRequiredAuthContext(request);
      const params = validateWithZod(projectIdParamsSchema, request.params);
      const project = await projectService.getProject(auth.accountId, params.projectId);
      return reply.status(200).send({ project });
    },
  );

  app.patch(
    '/v1/projects/:projectId',
    {
      preHandler: [requireAuth],
      config: { rateLimit: writeRateLimit },
      schema: {
        tags: ['Projects'],
        summary: 'Update a project with optimistic concurrency control (expectedVersion)',
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
          required: ['expectedVersion'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            description: { type: 'string', maxLength: 1000 },
            sourceDomain: { type: ['string', 'null'], maxLength: 253 },
            expectedVersion: { type: 'integer', minimum: 1 },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['project'],
            properties: {
              project: projectJsonSchema,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = getRequiredAuthContext(request);
      const params = validateWithZod(projectIdParamsSchema, request.params);
      const body = validateWithZod(updateProjectBodySchema, request.body);
      const project = await projectService.updateProject(auth.accountId, params.projectId, body);
      return reply.status(200).send({ project });
    },
  );

  app.delete(
    '/v1/projects/:projectId',
    {
      preHandler: [requireAuth],
      config: { rateLimit: writeRateLimit },
      schema: {
        tags: ['Projects'],
        summary: 'Delete an owned project and cascade cleanup of its saved artifacts',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['projectId'],
          properties: {
            projectId: { type: 'string', format: 'uuid' },
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
      const params = validateWithZod(projectIdParamsSchema, request.params);
      await projectService.deleteProject(auth.accountId, params.projectId);
      return reply.status(204).send();
    },
  );
}
