import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { AppConfig } from './config/env.js';
import type { DatabaseContext } from './db/client.js';
import { AppError, formatPublicError } from './errors/app-error.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { ArtifactService } from './services/artifact-service.js';
import { AuthService } from './services/auth-service.js';
import { ProjectService } from './services/project-service.js';
import { SettingsService } from './services/settings-service.js';

export interface BuildAppOptions {
  config: AppConfig;
  dbContext: DatabaseContext;
  loggerDestination?: NodeJS.WritableStream;
}

const SENSITIVE_QUERY_KEYS = new Set([
  'code',
  'state',
  'handoff_code',
  'access_token',
  'refresh_token',
  'id_token',
  'token',
  'key',
  'api_key',
  'client_secret',
  'code_verifier',
]);

export function sanitizeLoggedUrl(rawUrl: string): string {
  const queryStart = rawUrl.indexOf('?');
  if (queryStart === -1) {
    return rawUrl;
  }
  const pathname = rawUrl.slice(0, queryStart);
  const rawSearch = rawUrl.slice(queryStart + 1);
  const searchParams = new URLSearchParams(rawSearch);
  let modified = false;

  for (const key of Array.from(searchParams.keys())) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      searchParams.set(key, '[REDACTED]');
      modified = true;
    }
  }

  if (!modified) {
    return rawUrl;
  }

  return `${pathname}?${searchParams.toString()}`;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, dbContext, loggerDestination } = options;

  const loggerOptions = {
    level: config.LOG_LEVEL,
    serializers: {
      req(request: { method: string; url: string; host: string; ip: string }) {
        return {
          method: request.method,
          url: sanitizeLoggedUrl(request.url),
          host: request.host,
          remoteAddress: request.ip,
        };
      },
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'res.headers.location',
        '*.accessToken',
        '*.refreshToken',
        '*.handoffCode',
        '*.codeVerifier',
        '*.clientSecret',
        '*.password',
        '*.content',
        '*.markdown',
        '*.prompt',
      ],
      censor: '[REDACTED]',
    },
    ...(loggerDestination ? { stream: loggerDestination } : {}),
  };

  const app = Fastify({
    logger: loggerOptions,
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 524288,
    requestIdHeader: 'x-request-id',
    genReqId: (req) => {
      const candidate = req.headers['x-request-id'];
      if (typeof candidate === 'string' && /^[A-Za-z0-9._-]{8,128}$/.test(candidate)) {
        return candidate;
      }
      return randomUUID();
    },
  });

  app.setValidatorCompiler(() => {
    return () => true;
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  app.addHook('onClose', async () => {
    await dbContext.close();
  });

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    frameguard: {
      action: 'deny',
    },
    referrerPolicy: {
      policy: 'no-referrer',
    },
  });

  const allowedOriginsSet = new Set(config.CORS_ALLOWED_ORIGINS);
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, false);
        return;
      }
      if (allowedOriginsSet.has(origin)) {
        callback(null, origin);
        return;
      }
      callback(new AppError(403, 'FORBIDDEN', 'Origin is not allowed by CORS policy'), false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    credentials: true,
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_GLOBAL_MAX,
    timeWindow: config.RATE_LIMIT_GLOBAL_WINDOW_MS,
    errorResponseBuilder: (request) => {
      return {
        statusCode: 429,
        ...formatPublicError('RATE_LIMITED', 'Rate limit exceeded, please retry later', request.id),
      };
    },
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'PageSift Backend API',
        version: '1.0.0',
        description:
          'PageSift backend API for extension authentication, account settings, project organization, and explicitly saved design artifacts.',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  });

  const authService = new AuthService(dbContext.db, config);
  const settingsService = new SettingsService(dbContext.db);
  const projectService = new ProjectService(dbContext.db);
  const artifactService = new ArtifactService(dbContext.db);

  registerHealthRoutes(app, config, dbContext);
  registerAuthRoutes(app, config, authService);
  registerAccountRoutes(app, config, authService);
  registerSettingsRoutes(app, config, authService, settingsService);
  registerProjectRoutes(app, config, authService, projectService);
  registerArtifactRoutes(app, config, authService, artifactService);

  app.get(
    '/v1/openapi.json',
    {
      schema: {
        tags: ['Operations'],
        summary: 'Retrieve the OpenAPI 3.1.0 specification document',
      },
    },
    async (_request, reply) => {
      return reply.status(200).send(app.swagger());
    },
  );

  app.setNotFoundHandler((request, reply) => {
    void reply
      .status(404)
      .send(formatPublicError('RESOURCE_NOT_FOUND', 'Route not found', request.id));
  });

  app.setErrorHandler((error: FastifyError | AppError | Error, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error, code: error.code }, error.message);
      }
      void reply
        .status(error.statusCode)
        .send(formatPublicError(error.code, error.message, request.id, error.details));
      return;
    }

    const fastifyCode = 'code' in error && typeof error.code === 'string' ? error.code : '';
    const statusCode =
      'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;

    if (statusCode === 413 || fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      void reply
        .status(413)
        .send(
          formatPublicError(
            'PAYLOAD_TOO_LARGE',
            'Request payload exceeds maximum allowed size',
            request.id,
          ),
        );
      return;
    }

    if (statusCode === 429) {
      void reply
        .status(429)
        .send(
          formatPublicError('RATE_LIMITED', 'Rate limit exceeded, please retry later', request.id),
        );
      return;
    }

    if (
      statusCode === 400 ||
      fastifyCode === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
      fastifyCode === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
      fastifyCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE'
    ) {
      void reply
        .status(400)
        .send(
          formatPublicError('VALIDATION_ERROR', 'Malformed request body or headers', request.id),
        );
      return;
    }

    request.log.error({ err: error }, 'Unhandled request error');
    void reply
      .status(500)
      .send(
        formatPublicError(
          'INTERNAL_ERROR',
          'An unexpected internal server error occurred',
          request.id,
        ),
      );
  });

  return app;
}
