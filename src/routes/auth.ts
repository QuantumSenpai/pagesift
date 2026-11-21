import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config/env.js';
import { createAuthPreHandler, getRequiredAuthContext } from '../plugins/authenticate.js';
import type { AuthService } from '../services/auth-service.js';
import { validateWithZod } from '../utils/validation.js';

const oauthStartBodySchema = z.strictObject({
  redirectUri: z.url().max(512),
  codeChallenge: z
    .string()
    .min(43)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, 'codeChallenge must be base64url encoded'),
  codeChallengeMethod: z.literal('S256'),
});

const oauthCallbackQuerySchema = z.looseObject({
  code: z.string().trim().min(1).max(2048).optional(),
  state: z.string().trim().min(16).max(512).optional(),
  error: z.string().trim().min(1).max(256).optional(),
  error_description: z.string().trim().max(1024).optional(),
});

const tokenExchangeBodySchema = z.strictObject({
  handoffCode: z.string().trim().min(16).max(512),
  state: z.string().trim().min(16).max(512),
  codeVerifier: z
    .string()
    .min(43)
    .max(128)
    .regex(/^[A-Za-z0-9._~-]+$/, 'codeVerifier must use valid PKCE characters'),
});

const tokenRefreshBodySchema = z.strictObject({
  refreshToken: z.string().trim().min(16).max(512),
});

const signOutBodySchema = z
  .strictObject({
    allSessions: z.boolean().optional(),
  })
  .optional();

export function registerAuthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  authService: AuthService,
): void {
  const requireAuth = createAuthPreHandler(authService);
  const authRateLimit = {
    max: config.RATE_LIMIT_AUTH_MAX,
    timeWindow: config.RATE_LIMIT_AUTH_WINDOW_MS,
  };

  app.post(
    '/v1/auth/oauth/google/start',
    {
      config: { rateLimit: authRateLimit },
      schema: {
        tags: ['Authentication'],
        summary: 'Initiate Google OAuth 2.0 / OIDC sign-in with PKCE',
        body: {
          type: 'object',
          required: ['redirectUri', 'codeChallenge', 'codeChallengeMethod'],
          properties: {
            redirectUri: { type: 'string', format: 'uri' },
            codeChallenge: { type: 'string', minLength: 43, maxLength: 128 },
            codeChallengeMethod: { type: 'string', enum: ['S256'] },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['authorizationUrl', 'state', 'expiresAt'],
            properties: {
              authorizationUrl: { type: 'string', format: 'uri' },
              state: { type: 'string' },
              expiresAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = validateWithZod(oauthStartBodySchema, request.body);
      const result = await authService.startGoogleOAuth(body);
      return reply.status(200).send(result);
    },
  );

  app.get(
    '/v1/auth/oauth/google/callback',
    {
      config: { rateLimit: authRateLimit },
      schema: {
        tags: ['Authentication'],
        summary: 'OAuth 2.0 / OIDC callback from Google returning a PKCE-locked handoff code',
        querystring: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            state: { type: 'string' },
            error: { type: 'string' },
            error_description: { type: 'string' },
            scope: { type: 'string' },
            authuser: { type: 'string' },
            prompt: { type: 'string' },
          },
          additionalProperties: true,
        },
      },
    },
    async (request, reply) => {
      const query = validateWithZod(oauthCallbackQuerySchema, request.query);
      const { redirectTo } = await authService.handleGoogleOAuthCallback({
        ...(query.code !== undefined ? { code: query.code } : {}),
        ...(query.state !== undefined ? { state: query.state } : {}),
        ...(query.error !== undefined ? { error: query.error } : {}),
        ...(query.error_description !== undefined
          ? { errorDescription: query.error_description }
          : {}),
      });
      return reply.redirect(redirectTo, 302);
    },
  );

  app.post(
    '/v1/auth/token/exchange',
    {
      config: { rateLimit: authRateLimit },
      schema: {
        tags: ['Authentication'],
        summary: 'Exchange single-use handoff code and client PKCE codeVerifier for session tokens',
        body: {
          type: 'object',
          required: ['handoffCode', 'state', 'codeVerifier'],
          properties: {
            handoffCode: { type: 'string' },
            state: { type: 'string' },
            codeVerifier: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            required: [
              'accessToken',
              'accessTokenExpiresAt',
              'refreshToken',
              'refreshTokenExpiresAt',
              'account',
            ],
            properties: {
              accessToken: { type: 'string' },
              accessTokenExpiresAt: { type: 'string', format: 'date-time' },
              refreshToken: { type: 'string' },
              refreshTokenExpiresAt: { type: 'string', format: 'date-time' },
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
      const body = validateWithZod(tokenExchangeBodySchema, request.body);
      const userAgent =
        typeof request.headers['user-agent'] === 'string'
          ? request.headers['user-agent'].slice(0, 512)
          : null;
      const result = await authService.exchangeHandoffCode({
        ...body,
        userAgent,
      });
      return reply.status(200).send(result);
    },
  );

  app.post(
    '/v1/auth/token/refresh',
    {
      config: { rateLimit: authRateLimit },
      schema: {
        tags: ['Authentication'],
        summary: 'Rotate refresh token and issue new access token',
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: {
            refreshToken: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            required: [
              'accessToken',
              'accessTokenExpiresAt',
              'refreshToken',
              'refreshTokenExpiresAt',
              'account',
            ],
            properties: {
              accessToken: { type: 'string' },
              accessTokenExpiresAt: { type: 'string', format: 'date-time' },
              refreshToken: { type: 'string' },
              refreshTokenExpiresAt: { type: 'string', format: 'date-time' },
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
      const body = validateWithZod(tokenRefreshBodySchema, request.body);
      const userAgent =
        typeof request.headers['user-agent'] === 'string'
          ? request.headers['user-agent'].slice(0, 512)
          : null;
      const result = await authService.refreshSession({
        refreshToken: body.refreshToken,
        userAgent,
      });
      return reply.status(200).send(result);
    },
  );

  app.post(
    '/v1/auth/signout',
    {
      preHandler: [requireAuth],
      config: { rateLimit: authRateLimit },
      schema: {
        tags: ['Authentication'],
        summary: 'Revoke current session or all sessions for the authenticated account',
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
      const parsedBody =
        request.body === undefined || request.body === null
          ? undefined
          : validateWithZod(signOutBodySchema, request.body);
      await authService.signOut({
        accountId: auth.accountId,
        sessionId: auth.sessionId,
        allSessions: parsedBody?.allSessions ?? false,
      });
      return reply.status(204).send();
    },
  );
}
