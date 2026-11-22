import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { createDatabaseContext, type DatabaseContext } from '../../src/db/client.js';
import { runMigrationsToLatest } from '../../src/db/migrator.js';
import type { AuthTokenResult } from '../../src/services/auth-service.js';
import type { MockIdentityClaimSet, MockOidcBoundaryServer } from './oidc-boundary-mock.js';

export const TEST_EXTENSION_ORIGIN = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const TEST_EXTENSION_REDIRECT_URI =
  'https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/oauth2';
export const TEST_GOOGLE_CLIENT_ID = 'pagesift-test-client.apps.googleusercontent.com';

export function buildTestConfig(
  databaseUrl: string,
  oidcServer: MockOidcBoundaryServer,
  overrides: Partial<Record<string, string>> = {},
): AppConfig {
  return loadConfig(
    {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '0',
      LOG_LEVEL: 'silent',
      TRUST_PROXY: 'false',
      DATABASE_URL: databaseUrl,
      DB_POOL_MAX: '10',
      DB_CONNECTION_TIMEOUT_MS: '3000',
      DB_IDLE_TIMEOUT_MS: '10000',
      DB_STATEMENT_TIMEOUT_MS: '5000',
      READINESS_TIMEOUT_MS: '1000',
      CORS_ALLOWED_ORIGINS: `${TEST_EXTENSION_ORIGIN},http://localhost:5173`,
      ALLOWED_REDIRECT_URIS: `${TEST_EXTENSION_REDIRECT_URI},http://127.0.0.1:5173/auth/callback`,
      JWT_ACCESS_SECRET: 'test_jwt_access_secret_with_at_least_32_bytes_entropy_9999',
      ACCESS_TOKEN_TTL_SECONDS: '900',
      REFRESH_TOKEN_TTL_SECONDS: '2592000',
      OAUTH_STATE_TTL_SECONDS: '600',
      OAUTH_HANDOFF_TTL_SECONDS: '60',
      GOOGLE_CLIENT_ID: TEST_GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: 'test-google-client-secret-value',
      GOOGLE_CALLBACK_URL: 'http://127.0.0.1:3000/v1/auth/oauth/google/callback',
      OIDC_ISSUER: oidcServer.issuer,
      OIDC_AUTHORIZATION_ENDPOINT: oidcServer.authorizationEndpoint,
      OIDC_TOKEN_ENDPOINT: oidcServer.tokenEndpoint,
      OIDC_JWKS_URI: oidcServer.jwksUri,
      RATE_LIMIT_GLOBAL_MAX: '500',
      RATE_LIMIT_GLOBAL_WINDOW_MS: '60000',
      RATE_LIMIT_AUTH_MAX: '50',
      RATE_LIMIT_AUTH_WINDOW_MS: '60000',
      RATE_LIMIT_WRITE_MAX: '100',
      RATE_LIMIT_WRITE_WINDOW_MS: '60000',
      ...overrides,
    },
    null,
  );
}

export async function createTestAppInstance(
  databaseUrl: string,
  oidcServer: MockOidcBoundaryServer,
  overrides: Partial<Record<string, string>> = {},
  loggerDestination?: NodeJS.WritableStream,
): Promise<{
  app: FastifyInstance;
  config: AppConfig;
  dbContext: DatabaseContext;
}> {
  const config = buildTestConfig(databaseUrl, oidcServer, overrides);
  const dbContext = createDatabaseContext(config);
  await runMigrationsToLatest(dbContext.db);
  const app = await buildApp({
    config,
    dbContext,
    ...(loggerDestination ? { loggerDestination } : {}),
  });
  await app.ready();
  return { app, config, dbContext };
}

export function generateClientPkcePair(): {
  codeVerifier: string;
  codeChallenge: string;
} {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
  return { codeVerifier, codeChallenge };
}

export async function authenticateTestUser(
  app: FastifyInstance,
  oidcServer: MockOidcBoundaryServer,
  claims: MockIdentityClaimSet,
): Promise<AuthTokenResult> {
  const { codeVerifier, codeChallenge } = generateClientPkcePair();

  const startRes = await app.inject({
    method: 'POST',
    url: '/v1/auth/oauth/google/start',
    payload: {
      redirectUri: TEST_EXTENSION_REDIRECT_URI,
      codeChallenge,
      codeChallengeMethod: 'S256',
    },
  });

  if (startRes.statusCode !== 200) {
    throw new Error(`OAuth start failed with status ${startRes.statusCode}: ${startRes.body}`);
  }

  const startBody = startRes.json<{
    authorizationUrl: string;
    state: string;
    expiresAt: string;
  }>();

  const providerAuthUrl = new URL(startBody.authorizationUrl);
  const providerCodeChallenge = providerAuthUrl.searchParams.get('code_challenge');
  if (!providerCodeChallenge) {
    throw new Error('Provider authorization URL did not include code_challenge');
  }

  const providerCode = oidcServer.issueAuthorizationCode({
    codeChallenge: providerCodeChallenge,
    claims,
  });

  const callbackRes = await app.inject({
    method: 'GET',
    url: `/v1/auth/oauth/google/callback?code=${encodeURIComponent(providerCode)}&state=${encodeURIComponent(startBody.state)}`,
  });

  if (callbackRes.statusCode !== 302) {
    throw new Error(
      `OAuth callback failed with status ${callbackRes.statusCode}: ${callbackRes.body}`,
    );
  }

  const redirectLocation = callbackRes.headers.location;
  if (typeof redirectLocation !== 'string') {
    throw new Error('OAuth callback did not return a Location header');
  }

  const redirectUrl = new URL(redirectLocation);
  const handoffCode = redirectUrl.searchParams.get('handoff_code');
  const returnedState = redirectUrl.searchParams.get('state');

  if (!handoffCode || !returnedState) {
    throw new Error('OAuth callback redirect URL missing handoff_code or state');
  }

  const exchangeRes = await app.inject({
    method: 'POST',
    url: '/v1/auth/token/exchange',
    payload: {
      handoffCode,
      state: returnedState,
      codeVerifier,
    },
  });

  if (exchangeRes.statusCode !== 200) {
    throw new Error(
      `Token exchange failed with status ${exchangeRes.statusCode}: ${exchangeRes.body}`,
    );
  }

  return exchangeRes.json<AuthTokenResult>();
}
