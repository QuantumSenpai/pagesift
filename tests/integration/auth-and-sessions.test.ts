import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  createTestAppInstance,
  generateClientPkcePair,
  TEST_EXTENSION_REDIRECT_URI,
  TEST_GOOGLE_CLIENT_ID,
} from '../helpers/test-app.js';

describe('Authentication, PKCE OAuth flow, session rotation, revocation, and account deletion cleanup', () => {
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

  it('completes the Chrome extension OAuth 2.0 + OIDC + PKCE flow without exposing secrets in redirect URLs', async () => {
    const disposable = await pgCluster.createDisposableDatabase();
    const { app } = await createTestAppInstance(disposable.databaseUrl, oidcServer);

    try {
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
      expect(startRes.statusCode).toBe(200);
      const startBody = startRes.json<{
        authorizationUrl: string;
        state: string;
      }>();

      const providerUrl = new URL(startBody.authorizationUrl);
      const providerCodeChallenge = providerUrl.searchParams.get('code_challenge');
      expect(providerCodeChallenge).toBeTruthy();

      const providerCode = oidcServer.issueAuthorizationCode({
        codeChallenge: providerCodeChallenge ?? '',
        claims: {
          sub: 'google-user-101',
          email: 'alice@example.com',
          name: 'Alice Designer',
          picture: 'https://example.com/alice.png',
        },
      });

      const callbackRes = await app.inject({
        method: 'GET',
        url: `/v1/auth/oauth/google/callback?code=${encodeURIComponent(providerCode)}&state=${encodeURIComponent(startBody.state)}&scope=email%20profile%20openid&authuser=0&prompt=consent`,
      });
      expect(callbackRes.statusCode).toBe(302);

      const locationHeader = String(callbackRes.headers.location);
      expect(locationHeader.startsWith(TEST_EXTENSION_REDIRECT_URI)).toBe(true);
      expect(locationHeader).not.toContain('accessToken');
      expect(locationHeader).not.toContain('refreshToken');

      const redirectUrl = new URL(locationHeader);
      const handoffCode = redirectUrl.searchParams.get('handoff_code') ?? '';
      const returnedState = redirectUrl.searchParams.get('state') ?? '';

      const wrongPkceRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/token/exchange',
        payload: {
          handoffCode,
          state: returnedState,
          codeVerifier: 'wrong_pkce_verifier_that_does_not_match_challenge_0000',
        },
      });
      expect(wrongPkceRes.statusCode).toBe(401);

      const exchangeRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/token/exchange',
        payload: {
          handoffCode,
          state: returnedState,
          codeVerifier,
        },
      });
      expect(exchangeRes.statusCode).toBe(200);
      const tokens = exchangeRes.json<{
        accessToken: string;
        refreshToken: string;
        account: { id: string; email: string; displayName: string };
      }>();
      expect(tokens.account.email).toBe('alice@example.com');
      expect(tokens.account.displayName).toBe('Alice Designer');

      const replayExchangeRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/token/exchange',
        payload: {
          handoffCode,
          state: returnedState,
          codeVerifier,
        },
      });
      expect(replayExchangeRes.statusCode).toBe(401);

      const accountRes = await app.inject({
        method: 'GET',
        url: '/v1/account',
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
        },
      });
      expect(accountRes.statusCode).toBe(200);
      expect(accountRes.json<{ account: { id: string } }>().account.id).toBe(tokens.account.id);
    } finally {
      await app.close();
      await disposable.drop();
    }
  });

  it('rejects disallowed redirect URIs, invalid states, and unauthenticated or forged bearer tokens', async () => {
    const disposable = await pgCluster.createDisposableDatabase();
    const { app } = await createTestAppInstance(disposable.databaseUrl, oidcServer);

    try {
      const { codeChallenge } = generateClientPkcePair();

      const badRedirectRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/oauth/google/start',
        payload: {
          redirectUri: 'https://untrusted-extension.chromiumapp.org/oauth2',
          codeChallenge,
          codeChallengeMethod: 'S256',
        },
      });
      expect(badRedirectRes.statusCode).toBe(400);
      expect(badRedirectRes.json<{ error: { code: string } }>().error.code).toBe(
        'VALIDATION_ERROR',
      );

      const badCallbackRes = await app.inject({
        method: 'GET',
        url: '/v1/auth/oauth/google/callback?code=fake-code&state=nonexistent-state-value-123456',
      });
      expect(badCallbackRes.statusCode).toBe(400);
      expect(badCallbackRes.json<{ error: { code: string } }>().error.code).toBe('OAUTH_ERROR');

      const deniedStartRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/oauth/google/start',
        payload: {
          redirectUri: TEST_EXTENSION_REDIRECT_URI,
          codeChallenge,
          codeChallengeMethod: 'S256',
        },
      });
      expect(deniedStartRes.statusCode).toBe(200);
      const deniedState = deniedStartRes.json<{ state: string }>().state;

      const deniedConsentRes = await app.inject({
        method: 'GET',
        url: `/v1/auth/oauth/google/callback?error=access_denied&error_description=User+denied+access&state=${encodeURIComponent(deniedState)}&authuser=0`,
      });
      expect(deniedConsentRes.statusCode).toBe(400);
      expect(
        deniedConsentRes.json<{ error: { code: string; message: string } }>().error,
      ).toMatchObject({
        code: 'OAUTH_ERROR',
      });

      const replayAfterDeniedRes = await app.inject({
        method: 'GET',
        url: `/v1/auth/oauth/google/callback?code=some-code-after-denial&state=${encodeURIComponent(deniedState)}`,
      });
      expect(replayAfterDeniedRes.statusCode).toBe(400);
      expect(replayAfterDeniedRes.json<{ error: { code: string } }>().error.code).toBe(
        'OAUTH_ERROR',
      );

      const missingAuthRes = await app.inject({
        method: 'GET',
        url: '/v1/account',
      });
      expect(missingAuthRes.statusCode).toBe(401);

      const forgedTokenRes = await app.inject({
        method: 'GET',
        url: '/v1/account',
        headers: {
          authorization: 'Bearer forged.jwt.token',
        },
      });
      expect(forgedTokenRes.statusCode).toBe(401);
    } finally {
      await app.close();
      await disposable.drop();
    }
  });

  it('rotates refresh tokens on refresh and immediately invalidates tokens on sign-out', async () => {
    const disposable = await pgCluster.createDisposableDatabase();
    const { app } = await createTestAppInstance(disposable.databaseUrl, oidcServer);

    try {
      const initialAuth = await authenticateTestUser(app, oidcServer, {
        sub: 'google-user-202',
        email: 'bob@example.com',
        name: 'Bob Engineer',
      });

      const refreshRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/token/refresh',
        payload: {
          refreshToken: initialAuth.refreshToken,
        },
      });
      expect(refreshRes.statusCode).toBe(200);
      const rotatedAuth = refreshRes.json<{
        accessToken: string;
        refreshToken: string;
      }>();
      expect(rotatedAuth.refreshToken).not.toBe(initialAuth.refreshToken);

      const reuseOldRefreshRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/token/refresh',
        payload: {
          refreshToken: initialAuth.refreshToken,
        },
      });
      expect(reuseOldRefreshRes.statusCode).toBe(401);

      const signOutRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/signout',
        headers: {
          authorization: `Bearer ${rotatedAuth.accessToken}`,
        },
        payload: {
          allSessions: false,
        },
      });
      expect(signOutRes.statusCode).toBe(204);

      const afterSignOutAccountRes = await app.inject({
        method: 'GET',
        url: '/v1/account',
        headers: {
          authorization: `Bearer ${rotatedAuth.accessToken}`,
        },
      });
      expect(afterSignOutAccountRes.statusCode).toBe(401);

      const afterSignOutRefreshRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/token/refresh',
        payload: {
          refreshToken: rotatedAuth.refreshToken,
        },
      });
      expect(afterSignOutRefreshRes.statusCode).toBe(401);
    } finally {
      await app.close();
      await disposable.drop();
    }
  });

  it('deletes an account and cascades cleanup of all owned sessions, settings, projects, and artifacts without affecting other accounts', async () => {
    const disposable = await pgCluster.createDisposableDatabase();
    const { app, dbContext } = await createTestAppInstance(disposable.databaseUrl, oidcServer);

    try {
      const userA = await authenticateTestUser(app, oidcServer, {
        sub: 'google-user-delete-a',
        email: 'delete-a@example.com',
        name: 'User A',
      });
      const userB = await authenticateTestUser(app, oidcServer, {
        sub: 'google-user-keep-b',
        email: 'keep-b@example.com',
        name: 'User B',
      });

      const projARes = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { authorization: `Bearer ${userA.accessToken}` },
        payload: { name: 'User A Project' },
      });
      expect(projARes.statusCode).toBe(201);
      const projAId = projARes.json<{ project: { id: string } }>().project.id;

      const artARes = await app.inject({
        method: 'POST',
        url: `/v1/projects/${projAId}/artifacts`,
        headers: { authorization: `Bearer ${userA.accessToken}` },
        payload: {
          kind: 'rebuild_prompt',
          title: 'User A Prompt',
          schemaVersion: 1,
          content: {
            prompt: 'Rebuild User A layout',
            targetFramework: 'html_css',
            includeLayout: true,
            includeTypography: true,
            includeColors: true,
            componentChecklist: ['Header'],
          },
        },
      });
      expect(artARes.statusCode).toBe(201);
      const artAId = artARes.json<{ artifact: { id: string } }>().artifact.id;

      const projBRes = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { authorization: `Bearer ${userB.accessToken}` },
        payload: { name: 'User B Project' },
      });
      expect(projBRes.statusCode).toBe(201);

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: '/v1/account',
        headers: { authorization: `Bearer ${userA.accessToken}` },
      });
      expect(deleteRes.statusCode).toBe(204);

      const remainingAccountA = await dbContext.db
        .selectFrom('accounts')
        .selectAll()
        .where('id', '=', userA.account.id)
        .execute();
      const remainingSettingsA = await dbContext.db
        .selectFrom('account_settings')
        .selectAll()
        .where('account_id', '=', userA.account.id)
        .execute();
      const remainingSessionsA = await dbContext.db
        .selectFrom('sessions')
        .selectAll()
        .where('account_id', '=', userA.account.id)
        .execute();
      const remainingProjectsA = await dbContext.db
        .selectFrom('projects')
        .selectAll()
        .where('account_id', '=', userA.account.id)
        .execute();
      const remainingArtifactsA = await dbContext.db
        .selectFrom('artifacts')
        .selectAll()
        .where('account_id', '=', userA.account.id)
        .execute();
      const remainingBodiesA = await dbContext.db
        .selectFrom('artifact_bodies')
        .selectAll()
        .where('artifact_id', '=', artAId)
        .execute();

      expect(remainingAccountA).toHaveLength(0);
      expect(remainingSettingsA).toHaveLength(0);
      expect(remainingSessionsA).toHaveLength(0);
      expect(remainingProjectsA).toHaveLength(0);
      expect(remainingArtifactsA).toHaveLength(0);
      expect(remainingBodiesA).toHaveLength(0);

      const userBProjectsRes = await app.inject({
        method: 'GET',
        url: '/v1/projects',
        headers: { authorization: `Bearer ${userB.accessToken}` },
      });
      expect(userBProjectsRes.statusCode).toBe(200);
      expect(userBProjectsRes.json<{ items: unknown[] }>().items).toHaveLength(1);
    } finally {
      await app.close();
      await disposable.drop();
    }
  });
});
