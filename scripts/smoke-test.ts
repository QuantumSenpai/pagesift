import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { startMockOidcBoundaryServer } from '../tests/helpers/oidc-boundary-mock.js';
import { startIsolatedPostgresCluster } from '../tests/helpers/postgres-harness.js';
import {
  generateClientPkcePair,
  TEST_EXTENSION_ORIGIN,
  TEST_EXTENSION_REDIRECT_URI,
  TEST_GOOGLE_CLIENT_ID,
} from '../tests/helpers/test-app.js';

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => {
          resolve(port);
        });
      } else {
        srv.close(() => {
          reject(new Error('Unable to allocate port'));
        });
      }
    });
    srv.on('error', reject);
  });
}

async function waitForServerLive(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/v1/health/live`);
      if (res.status === 200) {
        return;
      }
    } catch (err) {
      if (err instanceof Error && Date.now() >= deadline) {
        throw err;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timed out waiting for built server to pass /v1/health/live');
}

async function main(): Promise<void> {
  const distServerPath = path.join(process.cwd(), 'dist', 'server.js');
  if (!fs.existsSync(distServerPath)) {
    throw new Error('dist/server.js not found. Run "npm run build" before smoke test.');
  }

  const pgCluster = await startIsolatedPostgresCluster();
  const disposableDb = await pgCluster.createDisposableDatabase();
  const oidcServer = await startMockOidcBoundaryServer(TEST_GOOGLE_CLIENT_ID);
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const callbackUrl = `${baseUrl}/v1/auth/oauth/google/callback`;

  const child = spawn(process.execPath, [distServerPath], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      LOG_LEVEL: 'warn',
      TRUST_PROXY: 'false',
      DATABASE_URL: disposableDb.databaseUrl,
      DB_POOL_MAX: '10',
      DB_CONNECTION_TIMEOUT_MS: '5000',
      DB_IDLE_TIMEOUT_MS: '10000',
      DB_STATEMENT_TIMEOUT_MS: '5000',
      READINESS_TIMEOUT_MS: '2000',
      CORS_ALLOWED_ORIGINS: `${TEST_EXTENSION_ORIGIN},http://localhost:5173`,
      ALLOWED_REDIRECT_URIS: TEST_EXTENSION_REDIRECT_URI,
      JWT_ACCESS_SECRET: 'smoke_test_jwt_secret_at_least_32_bytes_long_value_1234',
      ACCESS_TOKEN_TTL_SECONDS: '900',
      REFRESH_TOKEN_TTL_SECONDS: '2592000',
      OAUTH_STATE_TTL_SECONDS: '600',
      OAUTH_HANDOFF_TTL_SECONDS: '60',
      GOOGLE_CLIENT_ID: TEST_GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: 'smoke-test-google-secret',
      GOOGLE_CALLBACK_URL: callbackUrl,
      OIDC_ISSUER: oidcServer.issuer,
      OIDC_AUTHORIZATION_ENDPOINT: oidcServer.authorizationEndpoint,
      OIDC_TOKEN_ENDPOINT: oidcServer.tokenEndpoint,
      OIDC_JWKS_URI: oidcServer.jwksUri,
      RATE_LIMIT_GLOBAL_MAX: '500',
      RATE_LIMIT_GLOBAL_WINDOW_MS: '60000',
      RATE_LIMIT_AUTH_MAX: '100',
      RATE_LIMIT_AUTH_WINDOW_MS: '60000',
      RATE_LIMIT_WRITE_MAX: '200',
      RATE_LIMIT_WRITE_WINDOW_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServerLive(baseUrl, 10000);

    const readyRes = await fetch(`${baseUrl}/v1/health/ready`);
    if (readyRes.status !== 200) {
      throw new Error(`Expected /v1/health/ready 200, received ${readyRes.status}`);
    }

    const openApiRes = await fetch(`${baseUrl}/v1/openapi.json`);
    if (openApiRes.status !== 200) {
      throw new Error(`Expected /v1/openapi.json 200, received ${openApiRes.status}`);
    }
    const openApiDoc = (await openApiRes.json()) as Record<string, unknown>;
    fs.writeFileSync(
      path.join(process.cwd(), 'docs', 'openapi.json'),
      JSON.stringify(openApiDoc, null, 2) + '\n',
      'utf8',
    );

    const { codeVerifier, codeChallenge } = generateClientPkcePair();
    const startRes = await fetch(`${baseUrl}/v1/auth/oauth/google/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: TEST_EXTENSION_ORIGIN,
      },
      body: JSON.stringify({
        redirectUri: TEST_EXTENSION_REDIRECT_URI,
        codeChallenge,
        codeChallengeMethod: 'S256',
      }),
    });
    if (startRes.status !== 200) {
      throw new Error(`OAuth start failed: ${startRes.status}`);
    }
    const startJson = (await startRes.json()) as {
      authorizationUrl: string;
      state: string;
    };
    const providerAuthUrl = new URL(startJson.authorizationUrl);
    const providerChallenge = providerAuthUrl.searchParams.get('code_challenge') ?? '';

    const providerCode = oidcServer.issueAuthorizationCode({
      codeChallenge: providerChallenge,
      claims: {
        sub: 'smoke-user-sub-1',
        email: 'smoke@pagesift.example.com',
        name: 'Smoke Test Engineer',
      },
    });

    const callbackRes = await fetch(
      `${baseUrl}/v1/auth/oauth/google/callback?code=${encodeURIComponent(providerCode)}&state=${encodeURIComponent(startJson.state)}`,
      { redirect: 'manual' },
    );
    if (callbackRes.status !== 302) {
      throw new Error(`Expected 302 from callback, got ${callbackRes.status}`);
    }
    const redirectLocation = callbackRes.headers.get('location') ?? '';
    const redirectUrl = new URL(redirectLocation);
    const handoffCode = redirectUrl.searchParams.get('handoff_code') ?? '';
    const state = redirectUrl.searchParams.get('state') ?? '';

    const exchangeRes = await fetch(`${baseUrl}/v1/auth/token/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handoffCode,
        state,
        codeVerifier,
      }),
    });
    if (exchangeRes.status !== 200) {
      throw new Error(`Token exchange failed: ${exchangeRes.status}`);
    }
    const authData = (await exchangeRes.json()) as {
      accessToken: string;
      refreshToken: string;
    };

    const projectRes = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${authData.accessToken}`,
      },
      body: JSON.stringify({
        name: 'Smoke Verified Project',
        description: 'End-to-end HTTP smoke verification',
        sourceDomain: 'pagesift.dev',
      }),
    });
    if (projectRes.status !== 201) {
      throw new Error(`Project creation failed: ${projectRes.status}`);
    }
    const projectJson = (await projectRes.json()) as {
      project: { id: string; version: number };
    };

    const artifactRes = await fetch(`${baseUrl}/v1/projects/${projectJson.project.id}/artifacts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${authData.accessToken}`,
      },
      body: JSON.stringify({
        kind: 'design_reference',
        title: 'Smoke DESIGN.md',
        schemaVersion: 1,
        sourceUrl: 'https://pagesift.dev/demo',
        content: {
          markdown: '# Smoke Design System\n\nVerified over real HTTP.',
          pageTitle: 'PageSift Demo',
          viewport: { width: 1440, height: 900 },
          sections: ['Hero', 'CTA'],
        },
      }),
    });
    if (artifactRes.status !== 201) {
      throw new Error(`Artifact creation failed: ${artifactRes.status}`);
    }

    const signOutRes = await fetch(`${baseUrl}/v1/auth/signout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${authData.accessToken}`,
      },
      body: JSON.stringify({ allSessions: true }),
    });
    if (signOutRes.status !== 204) {
      throw new Error(`Sign-out failed: ${signOutRes.status}`);
    }

    const exitCodePromise = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        resolve(code);
      });
    });

    child.kill('SIGTERM');
    const exitCode = await exitCodePromise;
    if (exitCode !== 0) {
      throw new Error(`Expected graceful SIGTERM exit code 0, received ${String(exitCode)}`);
    }

    process.stdout.write(
      JSON.stringify({
        event: 'smoke_test_passed',
        baseUrl,
        verifiedEndpoints: [
          'GET /v1/health/live',
          'GET /v1/health/ready',
          'GET /v1/openapi.json',
          'POST /v1/auth/oauth/google/start',
          'GET /v1/auth/oauth/google/callback',
          'POST /v1/auth/token/exchange',
          'POST /v1/projects',
          'POST /v1/projects/:projectId/artifacts',
          'POST /v1/auth/signout',
        ],
        gracefulShutdownExitCode: exitCode,
      }) + '\n',
    );
  } finally {
    if (!child.killed) {
      child.kill('SIGKILL');
    }
    await oidcServer.close();
    await disposableDb.drop();
    await pgCluster.stopCluster();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'Smoke test failed';
  process.stderr.write(JSON.stringify({ event: 'smoke_test_failed', message }) + '\n');
  process.exit(1);
});
