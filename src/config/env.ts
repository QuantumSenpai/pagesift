import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

const booleanStringSchema = z.enum(['true', 'false']).transform((val) => val === 'true');

const originListSchema = z
  .string()
  .min(1)
  .transform((raw) =>
    raw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )
  .refine((origins) => origins.length > 0, {
    message: 'At least one origin must be configured',
  })
  .refine(
    (origins) =>
      origins.every((origin) => {
        if (origin === '*' || origin.includes('*') || origin.endsWith('/')) {
          return false;
        }
        try {
          const parsed = new URL(origin);
          return (
            (parsed.protocol === 'chrome-extension:' ||
              parsed.protocol === 'http:' ||
              parsed.protocol === 'https:') &&
            (parsed.pathname === '/' || parsed.pathname === '') &&
            parsed.search === '' &&
            parsed.hash === ''
          );
        } catch {
          return false;
        }
      }),
    {
      message:
        'Each CORS origin must be an explicit origin URL (chrome-extension://, http://, or https://) without wildcards or paths',
    },
  );

const redirectUriListSchema = z
  .string()
  .min(1)
  .transform((raw) =>
    raw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )
  .refine((uris) => uris.length > 0, {
    message: 'At least one allowed redirect URI must be configured',
  })
  .refine(
    (uris) =>
      uris.every((uri) => {
        if (uri.includes('*')) {
          return false;
        }
        try {
          const parsed = new URL(uri);
          if (parsed.hash !== '') {
            return false;
          }
          if (parsed.protocol === 'https:') {
            return true;
          }
          if (
            parsed.protocol === 'http:' &&
            (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
          ) {
            return true;
          }
          return false;
        } catch {
          return false;
        }
      }),
    {
      message:
        'Each redirect URI must be an explicit HTTPS URL (such as https://<ext-id>.chromiumapp.org/oauth2) or local loopback HTTP URL without wildcards or fragments',
    },
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: booleanStringSchema.default(false),
  DATABASE_URL: z
    .string()
    .trim()
    .min(1)
    .refine((val) => val.startsWith('postgresql://') || val.startsWith('postgres://'), {
      message: 'DATABASE_URL must be a valid PostgreSQL connection string',
    }),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(5000),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(500).max(300000).default(30000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(10000),
  READINESS_TIMEOUT_MS: z.coerce.number().int().min(50).max(30000).default(2000),
  CORS_ALLOWED_ORIGINS: originListSchema,
  ALLOWED_REDIRECT_URIS: redirectUriListSchema,
  JWT_ACCESS_SECRET: z.string().refine((val) => Buffer.byteLength(val, 'utf8') >= 32, {
    message: 'JWT_ACCESS_SECRET must be at least 32 bytes in UTF-8',
  }),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(7776000).default(2592000),
  OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(600),
  OAUTH_HANDOFF_TTL_SECONDS: z.coerce.number().int().min(15).max(300).default(60),
  GOOGLE_CLIENT_ID: z.string().trim().min(1),
  GOOGLE_CLIENT_SECRET: z.string().trim().min(1),
  GOOGLE_CALLBACK_URL: z.url(),
  OIDC_ISSUER: z.string().trim().min(1).default('https://accounts.google.com'),
  OIDC_AUTHORIZATION_ENDPOINT: z.url().default('https://accounts.google.com/o/oauth2/v2/auth'),
  OIDC_TOKEN_ENDPOINT: z.url().default('https://oauth2.googleapis.com/token'),
  OIDC_JWKS_URI: z.url().default('https://www.googleapis.com/oauth2/v3/certs'),
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().min(1).max(100000).default(300),
  RATE_LIMIT_GLOBAL_WINDOW_MS: z.coerce.number().int().min(200).max(3600000).default(60000),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).max(10000).default(20),
  RATE_LIMIT_AUTH_WINDOW_MS: z.coerce.number().int().min(200).max(3600000).default(60000),
  RATE_LIMIT_WRITE_MAX: z.coerce.number().int().min(1).max(10000).default(60),
  RATE_LIMIT_WRITE_WINDOW_MS: z.coerce.number().int().min(200).max(3600000).default(60000),
});

export type AppConfig = z.infer<typeof envSchema>;

export function readDotEnvFile(
  envFilePath: string = path.resolve(process.cwd(), '.env'),
): Record<string, string> {
  if (!fs.existsSync(envFilePath)) {
    return {};
  }
  const content = fs.readFileSync(envFilePath, 'utf8');
  const parsed = parseEnv(content);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
}

export function loadConfig(
  rawEnv: Record<string, string | undefined> = process.env,
  envFilePath: string = path.resolve(process.cwd(), '.env'),
): AppConfig {
  const fileValues = readDotEnvFile(envFilePath);
  const mergedEnv: Record<string, string | undefined> = { ...fileValues };
  for (const [key, value] of Object.entries(rawEnv)) {
    if (value !== undefined) {
      mergedEnv[key] = value;
    }
  }

  const result = envSchema.safeParse(mergedEnv);
  if (!result.success) {
    const formattedIssues = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${formattedIssues}`);
  }
  return result.data;
}
