import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/env.js';
import { createAuthPreHandler, getRequiredAuthContext } from '../plugins/authenticate.js';
import type { AuthService } from '../services/auth-service.js';

export function registerAccountRoutes(
  app: FastifyInstance,
  config: AppConfig,
  authService: AuthService,
): void {
  const requireAuth = createAuthPreHandler(authService);
  const writeRateLimit = {
    max: config.RATE_LIMIT_WRITE_MAX,
    timeWindow: config.RATE_LIMIT_WRITE_WINDOW_MS,
  };

  app.get(
    '/v1/account',
    {
      preHandler: [requireAuth],
      schema: {
        tags: ['Account'],
        summary: 'Retrieve the authenticated account profile',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['account'],
            properties: {
              account: {
                type: 'object',
                required: [
                  'id',
                  'provider',
                  'email',
                  'displayName',
                  'avatarUrl',
                  'createdAt',
                  'updatedAt',
                ],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  provider: { type: 'string' },
                  email: { type: 'string', format: 'email' },
                  displayName: { type: 'string' },
                  avatarUrl: { type: ['string', 'null'] },
                  createdAt: { type: 'string', format: 'date-time' },
                  updatedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = getRequiredAuthContext(request);
      return reply.status(200).send({
        account: auth.account,
      });
    },
  );

  app.delete(
    '/v1/account',
    {
      preHandler: [requireAuth],
      config: { rateLimit: writeRateLimit },
      schema: {
        tags: ['Account'],
        summary: 'Delete the authenticated account and cascade cleanup of all owned data',
        security: [{ bearerAuth: [] }],
        response: {
          204: {
            type: 'null',
          },
        },
      },
    },
    async (request, reply) => {
      const auth = getRequiredAuthContext(request);
      await authService.deleteAccount(auth.accountId);
      return reply.status(204).send();
    },
  );
}
