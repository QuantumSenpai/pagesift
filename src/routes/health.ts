import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/env.js';
import type { DatabaseContext } from '../db/client.js';
import { AppError } from '../errors/app-error.js';

export function registerHealthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  dbContext: DatabaseContext,
): void {
  app.get(
    '/v1/health/live',
    {
      schema: {
        tags: ['Operations'],
        summary: 'Liveness probe',
        response: {
          200: {
            type: 'object',
            required: ['status', 'timestamp'],
            properties: {
              status: { type: 'string', enum: ['ok'] },
              timestamp: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      return reply.status(200).send({
        status: 'ok',
        timestamp: new Date().toISOString(),
      });
    },
  );

  app.get(
    '/v1/health/ready',
    {
      schema: {
        tags: ['Operations'],
        summary: 'Readiness probe checking PostgreSQL connectivity with timeout',
        response: {
          200: {
            type: 'object',
            required: ['status', 'database', 'latencyMs', 'timestamp'],
            properties: {
              status: { type: 'string', enum: ['ready'] },
              database: { type: 'string', enum: ['up'] },
              latencyMs: { type: 'integer' },
              timestamp: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const readiness = await dbContext.checkReadiness(config.READINESS_TIMEOUT_MS);
      if (!readiness.ok) {
        throw new AppError(
          503,
          'DEPENDENCY_UNAVAILABLE',
          'Database dependency is unavailable or timed out',
        );
      }
      return reply.status(200).send({
        status: 'ready',
        database: 'up',
        latencyMs: readiness.latencyMs,
        timestamp: new Date().toISOString(),
      });
    },
  );
}
