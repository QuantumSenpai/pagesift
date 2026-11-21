import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config/env.js';
import { createAuthPreHandler, getRequiredAuthContext } from '../plugins/authenticate.js';
import type { AuthService } from '../services/auth-service.js';
import type { SettingsService } from '../services/settings-service.js';
import { validateWithZod } from '../utils/validation.js';

const updateSettingsBodySchema = z.strictObject({
  defaultExportFormat: z.enum(['markdown', 'json', 'html_css']),
  colorFormat: z.enum(['hex', 'rgb', 'hsl', 'oklch']),
  spacingUnit: z.enum(['px', 'rem']),
  includeResponsiveBreakpoints: z.boolean(),
  redactQueryParamsInUrls: z.boolean(),
  defaultPromptTarget: z.enum(['generic', 'react_tailwind', 'html_css', 'vue_css']),
});

const settingsResponseProperties = {
  defaultExportFormat: { type: 'string', enum: ['markdown', 'json', 'html_css'] },
  colorFormat: { type: 'string', enum: ['hex', 'rgb', 'hsl', 'oklch'] },
  spacingUnit: { type: 'string', enum: ['px', 'rem'] },
  includeResponsiveBreakpoints: { type: 'boolean' },
  redactQueryParamsInUrls: { type: 'boolean' },
  defaultPromptTarget: {
    type: 'string',
    enum: ['generic', 'react_tailwind', 'html_css', 'vue_css'],
  },
  updatedAt: { type: 'string', format: 'date-time' },
};

export function registerSettingsRoutes(
  app: FastifyInstance,
  config: AppConfig,
  authService: AuthService,
  settingsService: SettingsService,
): void {
  const requireAuth = createAuthPreHandler(authService);
  const writeRateLimit = {
    max: config.RATE_LIMIT_WRITE_MAX,
    timeWindow: config.RATE_LIMIT_WRITE_WINDOW_MS,
  };

  app.get(
    '/v1/account/settings',
    {
      preHandler: [requireAuth],
      schema: {
        tags: ['Settings'],
        summary: 'Retrieve authenticated account preferences',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['settings'],
            properties: {
              settings: {
                type: 'object',
                required: [
                  'defaultExportFormat',
                  'colorFormat',
                  'spacingUnit',
                  'includeResponsiveBreakpoints',
                  'redactQueryParamsInUrls',
                  'defaultPromptTarget',
                  'updatedAt',
                ],
                properties: settingsResponseProperties,
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = getRequiredAuthContext(request);
      const settings = await settingsService.getSettings(auth.accountId);
      return reply.status(200).send({ settings });
    },
  );

  app.put(
    '/v1/account/settings',
    {
      preHandler: [requireAuth],
      config: { rateLimit: writeRateLimit },
      schema: {
        tags: ['Settings'],
        summary: 'Replace authenticated account preferences with strictly validated settings',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: [
            'defaultExportFormat',
            'colorFormat',
            'spacingUnit',
            'includeResponsiveBreakpoints',
            'redactQueryParamsInUrls',
            'defaultPromptTarget',
          ],
          properties: {
            defaultExportFormat: { type: 'string', enum: ['markdown', 'json', 'html_css'] },
            colorFormat: { type: 'string', enum: ['hex', 'rgb', 'hsl', 'oklch'] },
            spacingUnit: { type: 'string', enum: ['px', 'rem'] },
            includeResponsiveBreakpoints: { type: 'boolean' },
            redactQueryParamsInUrls: { type: 'boolean' },
            defaultPromptTarget: {
              type: 'string',
              enum: ['generic', 'react_tailwind', 'html_css', 'vue_css'],
            },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['settings'],
            properties: {
              settings: {
                type: 'object',
                required: [
                  'defaultExportFormat',
                  'colorFormat',
                  'spacingUnit',
                  'includeResponsiveBreakpoints',
                  'redactQueryParamsInUrls',
                  'defaultPromptTarget',
                  'updatedAt',
                ],
                properties: settingsResponseProperties,
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = getRequiredAuthContext(request);
      const body = validateWithZod(updateSettingsBodySchema, request.body);
      const settings = await settingsService.updateSettings(auth.accountId, body);
      return reply.status(200).send({ settings });
    },
  );
}
