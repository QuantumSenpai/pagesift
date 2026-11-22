import { PassThrough } from 'node:stream';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDatabaseContext } from '../../src/db/client.js';
import { runMigrationsToLatest, runMigrationsWithDirectConnection } from '../../src/db/migrator.js';
import {
  startMockOidcBoundaryServer,
  type MockOidcBoundaryServer,
} from '../helpers/oidc-boundary-mock.js';
import {
  startIsolatedPostgresCluster,
  type IsolatedPostgresCluster,
} from '../helpers/postgres-harness.js';
import {
  authenticateTestUser,
  buildTestConfig,
  createTestAppInstance,
  TEST_EXTENSION_ORIGIN,
  TEST_GOOGLE_CLIENT_ID,
} from '../helpers/test-app.js';

describe('Migrations, health checks, security headers, CORS, OpenAPI, rate limits, and logging redaction', () => {
  let pgCluster: IsolatedPostgresCluster;
  let oidcServer: MockOidcBoundaryServer;

  beforeAll(async () => {
    pgCluster = await startIsolatedPostgresCluster();
    oidcServer = await startMockOidcBoundaryServer(TEST_GOOGLE_CLIENT_ID);
  });

  afterAll(async () => {
    await oidcServer.close();
    await pgCluster.stopCluster();
  });

  it('applies migrations cleanly on a fresh database and is safely idempotent on re-application', async () => {
    const disposable = await pgCluster.createDisposableDatabase();
    const config = buildTestConfig(disposable.databaseUrl, oidcServer);
    const dbContext = createDatabaseContext(config);

    try {
      const firstRun = await runMigrationsToLatest(dbContext.db);
      expect(firstRun.error).toBeUndefined();
      expect(firstRun.results?.length).toBe(1);
      expect(firstRun.results?.[0]?.migrationName).toBe('001_initial_schema');
      expect(firstRun.results?.[0]?.status).toBe('Success');

      const secondRun = await runMigrationsToLatest(dbContext.db);
      expect(secondRun.error).toBeUndefined();
      expect(secondRun.results?.length).toBe(0);
    } finally {
      await dbContext.close();
      await disposable.drop();
    }
  });

  it('runs migrations through DATABASE_URL_UNPOOLED when configured and falls back to DATABASE_URL when omitted', async () => {
    const directDb = await pgCluster.createDisposableDatabase();
    const fallbackDb = await pgCluster.createDisposableDatabase();

    const directConfig = buildTestConfig(
      'postgresql://pagesift_test@127.0.0.1:59999/unreachable_pooled_target',
      oidcServer,
      {
        DATABASE_URL_UNPOOLED: directDb.databaseUrl,
        DB_CONNECTION_TIMEOUT_MS: '500',
      },
    );
    const fallbackConfig = buildTestConfig(fallbackDb.databaseUrl, oidcServer);

    const directVerifyContext = createDatabaseContext(
      buildTestConfig(directDb.databaseUrl, oidcServer),
    );
    const fallbackVerifyContext = createDatabaseContext(fallbackConfig);

    try {
      const directFirstRun = await runMigrationsWithDirectConnection(directConfig);
      expect(directFirstRun.error).toBeUndefined();
      expect(directFirstRun.results).toHaveLength(1);
      expect(directFirstRun.results?.[0]?.status).toBe('Success');

      const directSecondRun = await runMigrationsWithDirectConnection(directConfig);
      expect(directSecondRun.error).toBeUndefined();
      expect(directSecondRun.results).toHaveLength(0);

      const directTables = await sql<{ tablename: string }>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
      `.execute(directVerifyContext.db);
      expect(directTables.rows.map((row) => row.tablename)).toEqual(
        expect.arrayContaining([
          'accounts',
          'account_settings',
          'oauth_transactions',
          'sessions',
          'projects',
          'artifacts',
          'artifact_bodies',
        ]),
      );

      const fallbackRun = await runMigrationsWithDirectConnection(fallbackConfig);
      expect(fallbackRun.error).toBeUndefined();
      expect(fallbackRun.results).toHaveLength(1);
      expect(fallbackRun.results?.[0]?.status).toBe('Success');

      const fallbackTables = await sql<{ tablename: string }>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
      `.execute(fallbackVerifyContext.db);
      expect(fallbackTables.rows.map((row) => row.tablename)).toEqual(
        expect.arrayContaining(['accounts', 'projects', 'artifacts']),
      );
    } finally {
      await directVerifyContext.close();
      await fallbackVerifyContext.close();
      await directDb.drop();
      await fallbackDb.drop();
    }
  });

  it('serves liveness and readiness endpoints and fails readiness when PostgreSQL is unavailable', async () => {
    const disposable = await pgCluster.createDisposableDatabase();
    const { app } = await createTestAppInstance(disposable.databaseUrl, oidcServer);

    try {
      const liveRes = await app.inject({
        method: 'GET',
        url: '/v1/health/live',
        headers: {
          'x-request-id': 'req-live-check-1234',
        },
      });
      expect(liveRes.statusCode).toBe(200);
      expect(liveRes.headers['x-request-id']).toBe('req-live-check-1234');
      expect(liveRes.json<{ status: string }>()).toMatchObject({ status: 'ok' });

      const readyRes = await app.inject({
        method: 'GET',
        url: '/v1/health/ready',
      });
      expect(readyRes.statusCode).toBe(200);
      expect(readyRes.json<{ status: string; database: string }>()).toMatchObject({
        status: 'ready',
        database: 'up',
      });
    } finally {
      await app.close();
      await disposable.drop();
    }

    const unreachableConfig = buildTestConfig(
      'postgresql://pagesift_test@127.0.0.1:59999/nonexistent',
      oidcServer,
      {
        DB_CONNECTION_TIMEOUT_MS: '200',
        READINESS_TIMEOUT_MS: '250',
      },
    );
    const unreachableDbContext = createDatabaseContext(unreachableConfig);
    const degradedApp = await buildApp({
      config: unreachableConfig,
      dbContext: unreachableDbContext,
    });
    await degradedApp.ready();

    try {
      const degradedReadyRes = await degradedApp.inject({
        method: 'GET',
        url: '/v1/health/ready',
      });
      expect(degradedReadyRes.statusCode).toBe(503);
      const errBody = degradedReadyRes.json<{
        error: { code: string; requestId: string };
      }>();
      expect(errBody.error.code).toBe('DEPENDENCY_UNAVAILABLE');
      expect(errBody.error.requestId).toBeTruthy();
    } finally {
      await degradedApp.close();
    }
  });

  it('enforces explicit CORS allowlist, security headers, and OpenAPI contract accuracy', async () => {
    const disposable = await pgCluster.createDisposableDatabase();
    const { app } = await createTestAppInstance(disposable.databaseUrl, oidcServer);

    try {
      const allowedCorsRes = await app.inject({
        method: 'GET',
        url: '/v1/health/live',
        headers: {
          origin: TEST_EXTENSION_ORIGIN,
        },
      });
      expect(allowedCorsRes.statusCode).toBe(200);
      expect(allowedCorsRes.headers['access-control-allow-origin']).toBe(TEST_EXTENSION_ORIGIN);
      expect(allowedCorsRes.headers['x-content-type-options']).toBe('nosniff');
      expect(allowedCorsRes.headers['x-frame-options']).toBe('DENY');
      expect(allowedCorsRes.headers['referrer-policy']).toBe('no-referrer');
      expect(String(allowedCorsRes.headers['content-security-policy'])).toContain(
        "default-src 'none'",
      );

      const disallowedCorsRes = await app.inject({
        method: 'GET',
        url: '/v1/health/live',
        headers: {
          origin: 'https://malicious.example.com',
        },
      });
      expect(disallowedCorsRes.statusCode).toBe(403);
      expect(disallowedCorsRes.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');

      const openApiRes = await app.inject({
        method: 'GET',
        url: '/v1/openapi.json',
      });
      expect(openApiRes.statusCode).toBe(200);
      const spec = openApiRes.json<{
        openapi: string;
        info: { title: string; version: string };
        paths: Record<string, unknown>;
      }>();
      expect(spec.openapi).toBe('3.1.0');
      expect(spec.info.title).toBe('PageSift Backend API');
      expect(Object.keys(spec.paths)).toEqual(
        expect.arrayContaining([
          '/v1/health/live',
          '/v1/health/ready',
          '/v1/auth/oauth/google/start',
          '/v1/auth/oauth/google/callback',
          '/v1/auth/token/exchange',
          '/v1/auth/token/refresh',
          '/v1/auth/signout',
          '/v1/account',
          '/v1/account/settings',
          '/v1/projects',
          '/v1/projects/{projectId}',
          '/v1/projects/{projectId}/artifacts',
          '/v1/projects/{projectId}/artifacts/{artifactId}',
        ]),
      );
    } finally {
      await app.close();
      await disposable.drop();
    }
  });

  it('enforces route rate limits with consistent 429 RATE_LIMITED responses', async () => {
    const disposable = await pgCluster.createDisposableDatabase();
    const { app } = await createTestAppInstance(disposable.databaseUrl, oidcServer, {
      RATE_LIMIT_AUTH_MAX: '2',
      RATE_LIMIT_AUTH_WINDOW_MS: '60000',
    });

    try {
      for (let i = 0; i < 2; i += 1) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/auth/token/refresh',
          payload: {
            refreshToken: 'invalid-refresh-token-of-valid-length-123456',
          },
        });
        expect(res.statusCode).toBe(401);
      }

      const rateLimitedRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/token/refresh',
        payload: {
          refreshToken: 'invalid-refresh-token-of-valid-length-123456',
        },
      });
      expect(rateLimitedRes.statusCode).toBe(429);
      const body = rateLimitedRes.json<{ error: { code: string; requestId: string } }>();
      expect(body.error.code).toBe('RATE_LIMITED');
      expect(body.error.requestId).toBeTruthy();
    } finally {
      await app.close();
      await disposable.drop();
    }
  });

  it('redacts authorization headers, tokens, and artifact contents from structured logs', async () => {
    const disposable = await pgCluster.createDisposableDatabase();
    const logStream = new PassThrough();
    const logChunks: string[] = [];
    logStream.on('data', (chunk: Buffer) => {
      logChunks.push(chunk.toString('utf8'));
    });

    const { app } = await createTestAppInstance(
      disposable.databaseUrl,
      oidcServer,
      {
        LOG_LEVEL: 'info',
      },
      logStream,
    );

    try {
      const authResult = await authenticateTestUser(app, oidcServer, {
        sub: 'google-sub-log-test',
        email: 'logtest@example.com',
        name: 'Log Test User',
      });

      const secretArtifactMarker = 'SUPER_SECRET_ARTIFACT_BODY_MARKER_987654321';
      const projectRes = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: {
          authorization: `Bearer ${authResult.accessToken}`,
        },
        payload: {
          name: 'Log Redaction Project',
        },
      });
      expect(projectRes.statusCode).toBe(201);
      const projectId = projectRes.json<{ project: { id: string } }>().project.id;

      const artifactRes = await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/artifacts`,
        headers: {
          authorization: `Bearer ${authResult.accessToken}`,
        },
        payload: {
          kind: 'design_reference',
          title: 'Design Doc',
          schemaVersion: 1,
          content: {
            markdown: `# Secret\n${secretArtifactMarker}`,
            pageTitle: 'Secret Page',
            viewport: { width: 1280, height: 800 },
            sections: ['Header'],
          },
        },
      });
      expect(artifactRes.statusCode).toBe(201);

      const combinedLogs = logChunks.join('');
      expect(combinedLogs.length).toBeGreaterThan(0);
      expect(combinedLogs).not.toContain(authResult.accessToken);
      expect(combinedLogs).not.toContain(authResult.refreshToken);
      expect(combinedLogs).not.toContain(secretArtifactMarker);

      const dummyCodeMarker = 'DUMMY_OAUTH_CODE_MARKER_99112233';
      const dummyStateMarker = 'DUMMY_OAUTH_STATE_MARKER_44556677';
      await app.inject({
        method: 'GET',
        url: `/v1/auth/oauth/google/callback?code=${dummyCodeMarker}&state=${dummyStateMarker}&scope=openid`,
        headers: {
          'x-request-id': 'req-oauth-redact-check-001',
        },
      });

      const logsAfterCallback = logChunks.join('');
      expect(logsAfterCallback).toContain('req-oauth-redact-check-001');
      expect(logsAfterCallback).toContain('/v1/auth/oauth/google/callback');
      expect(logsAfterCallback).not.toContain(dummyCodeMarker);
      expect(logsAfterCallback).not.toContain(dummyStateMarker);
    } finally {
      await app.close();
      await disposable.drop();
    }
  });
});
