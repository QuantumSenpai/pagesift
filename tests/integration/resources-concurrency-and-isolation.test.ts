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
  TEST_GOOGLE_CLIENT_ID,
} from '../helpers/test-app.js';

describe('Account settings, projects, saved artifacts, cross-account isolation, concurrency, and restart persistence', () => {
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

  it('retrieves and updates account settings and rejects arbitrary unknown JSON fields', async () => {
    const disposable = await pgCluster.createDisposableDatabase();
    const { app } = await createTestAppInstance(disposable.databaseUrl, oidcServer);

    try {
      const user = await authenticateTestUser(app, oidcServer, {
        sub: 'google-settings-user',
        email: 'settings@example.com',
        name: 'Settings User',
      });

      const getRes = await app.inject({
        method: 'GET',
        url: '/v1/account/settings',
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json<{ settings: Record<string, unknown> }>().settings).toMatchObject({
        defaultExportFormat: 'markdown',
        colorFormat: 'hex',
        spacingUnit: 'px',
        includeResponsiveBreakpoints: true,
        redactQueryParamsInUrls: true,
        defaultPromptTarget: 'generic',
      });

      const updateRes = await app.inject({
        method: 'PUT',
        url: '/v1/account/settings',
        headers: { authorization: `Bearer ${user.accessToken}` },
        payload: {
          defaultExportFormat: 'json',
          colorFormat: 'oklch',
          spacingUnit: 'rem',
          includeResponsiveBreakpoints: false,
          redactQueryParamsInUrls: true,
          defaultPromptTarget: 'react_tailwind',
        },
      });
      expect(updateRes.statusCode).toBe(200);
      expect(updateRes.json<{ settings: Record<string, unknown> }>().settings).toMatchObject({
        defaultExportFormat: 'json',
        colorFormat: 'oklch',
        spacingUnit: 'rem',
        includeResponsiveBreakpoints: false,
        defaultPromptTarget: 'react_tailwind',
      });

      const arbitraryBlobRes = await app.inject({
        method: 'PUT',
        url: '/v1/account/settings',
        headers: { authorization: `Bearer ${user.accessToken}` },
        payload: {
          defaultExportFormat: 'json',
          colorFormat: 'oklch',
          spacingUnit: 'rem',
          includeResponsiveBreakpoints: false,
          redactQueryParamsInUrls: true,
          defaultPromptTarget: 'react_tailwind',
          unrestrictedArbitraryKey: { nested: true },
        },
      });
      expect(arbitraryBlobRes.statusCode).toBe(400);
      expect(arbitraryBlobRes.json<{ error: { code: string } }>().error.code).toBe(
        'VALIDATION_ERROR',
      );
    } finally {
      await app.close();
      await disposable.drop();
    }
  });

  it('enforces project ownership, pagination ordering, optimistic concurrency, and rejects client-supplied owner fields', async () => {
    const disposable = await pgCluster.createDisposableDatabase();
    const { app } = await createTestAppInstance(disposable.databaseUrl, oidcServer);

    try {
      const userA = await authenticateTestUser(app, oidcServer, {
        sub: 'google-proj-user-a',
        email: 'proja@example.com',
        name: 'Project User A',
      });
      const userB = await authenticateTestUser(app, oidcServer, {
        sub: 'google-proj-user-b',
        email: 'projb@example.com',
        name: 'Project User B',
      });

      const spoofOwnerRes = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { authorization: `Bearer ${userA.accessToken}` },
        payload: {
          name: 'Spoofed Owner Project',
          accountId: userB.account.id,
        },
      });
      expect(spoofOwnerRes.statusCode).toBe(400);

      const createdIds: string[] = [];
      for (const name of ['Project Alpha', 'Project Beta', 'Project Gamma']) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/projects',
          headers: { authorization: `Bearer ${userA.accessToken}` },
          payload: {
            name,
            description: `Description for ${name}`,
            sourceDomain: 'example.com',
          },
        });
        expect(res.statusCode).toBe(201);
        createdIds.push(res.json<{ project: { id: string } }>().project.id);
      }

      const duplicateNameRes = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { authorization: `Bearer ${userA.accessToken}` },
        payload: { name: 'Project Alpha' },
      });
      expect(duplicateNameRes.statusCode).toBe(409);

      const page1Res = await app.inject({
        method: 'GET',
        url: '/v1/projects?limit=2',
        headers: { authorization: `Bearer ${userA.accessToken}` },
      });
      expect(page1Res.statusCode).toBe(200);
      const page1 = page1Res.json<{
        items: Array<{ id: string; name: string }>;
        nextCursor: string | null;
      }>();
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBeTruthy();

      const page2Res = await app.inject({
        method: 'GET',
        url: `/v1/projects?limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
        headers: { authorization: `Bearer ${userA.accessToken}` },
      });
      expect(page2Res.statusCode).toBe(200);
      const page2 = page2Res.json<{
        items: Array<{ id: string; name: string }>;
        nextCursor: string | null;
      }>();
      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();

      const combinedIds = [...page1.items.map((i) => i.id), ...page2.items.map((i) => i.id)];
      expect(new Set(combinedIds).size).toBe(3);

      const targetProjectId = createdIds[0] ?? '';

      const updateV1Res = await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${targetProjectId}`,
        headers: { authorization: `Bearer ${userA.accessToken}` },
        payload: {
          description: 'Updated description v2',
          expectedVersion: 1,
        },
      });
      expect(updateV1Res.statusCode).toBe(200);
      expect(updateV1Res.json<{ project: { version: number } }>().project.version).toBe(2);

      const staleUpdateRes = await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${targetProjectId}`,
        headers: { authorization: `Bearer ${userA.accessToken}` },
        payload: {
          description: 'Stale overwrite attempt',
          expectedVersion: 1,
        },
      });
      expect(staleUpdateRes.statusCode).toBe(409);
      expect(staleUpdateRes.json<{ error: { code: string } }>().error.code).toBe(
        'VERSION_CONFLICT',
      );

      const crossGetRes = await app.inject({
        method: 'GET',
        url: `/v1/projects/${targetProjectId}`,
        headers: { authorization: `Bearer ${userB.accessToken}` },
      });
      expect(crossGetRes.statusCode).toBe(404);

      const crossPatchRes = await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${targetProjectId}`,
        headers: { authorization: `Bearer ${userB.accessToken}` },
        payload: {
          name: 'Hacked by B',
          expectedVersion: 2,
        },
      });
      expect(crossPatchRes.statusCode).toBe(404);

      const crossDeleteRes = await app.inject({
        method: 'DELETE',
        url: `/v1/projects/${targetProjectId}`,
        headers: { authorization: `Bearer ${userB.accessToken}` },
      });
      expect(crossDeleteRes.statusCode).toBe(404);
    } finally {
      await app.close();
      await disposable.drop();
    }
  });

  it('manages all four saved artifact types with separated body storage, optimistic concurrency, inert untrusted data handling, and cross-account protection', async () => {
    const disposable = await pgCluster.createDisposableDatabase();
    const { app, dbContext } = await createTestAppInstance(disposable.databaseUrl, oidcServer);

    try {
      const owner = await authenticateTestUser(app, oidcServer, {
        sub: 'google-art-owner',
        email: 'owner@example.com',
        name: 'Artifact Owner',
      });
      const intruder = await authenticateTestUser(app, oidcServer, {
        sub: 'google-art-intruder',
        email: 'intruder@example.com',
        name: 'Artifact Intruder',
      });

      const projRes = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: 'Design System Capture' },
      });
      expect(projRes.statusCode).toBe(201);
      const projectId = projRes.json<{ project: { id: string } }>().project.id;

      const untrustedPayloads = '<script>window.evil=true;</script><img src=x onerror=alert(1)>';

      const designRefRes = await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/artifacts`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: {
          kind: 'design_reference',
          title: `DESIGN.md ${untrustedPayloads}`,
          schemaVersion: 1,
          sourceUrl: 'https://example.com/pricing',
          content: {
            markdown: `# Pricing Page\n\n${untrustedPayloads}`,
            pageTitle: 'Example Pricing',
            viewport: { width: 1440, height: 900 },
            sections: ['Header', 'Tiers'],
          },
        },
      });
      expect(designRefRes.statusCode).toBe(201);
      expect(String(designRefRes.headers['content-type'])).toContain('application/json');
      expect(designRefRes.headers['x-content-type-options']).toBe('nosniff');
      const designRef = designRefRes.json<{
        artifact: {
          id: string;
          version: number;
          byteLength: number;
          content: { markdown: string };
        };
      }>().artifact;
      expect(designRef.version).toBe(1);
      expect(designRef.content.markdown).toContain(untrustedPayloads);

      const promptRes = await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/artifacts`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: {
          kind: 'rebuild_prompt',
          title: 'Rebuild Pricing Grid',
          schemaVersion: 1,
          content: {
            prompt: 'Create a 3-column pricing grid with sticky header.',
            targetFramework: 'react_tailwind',
            includeLayout: true,
            includeTypography: true,
            includeColors: true,
            componentChecklist: ['PricingCard', 'BillingToggle'],
          },
        },
      });
      expect(promptRes.statusCode).toBe(201);

      const tokensRes = await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/artifacts`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: {
          kind: 'design_token_export',
          title: 'Core Tokens',
          schemaVersion: 1,
          content: {
            colors: [{ name: 'brand-500', value: '#3b82f6' }],
            typography: [],
            spacing: [{ token: 'gap-md', value: '16px' }],
          },
        },
      });
      expect(tokensRes.statusCode).toBe(201);

      const manifestRes = await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/artifacts`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: {
          kind: 'asset_manifest',
          title: 'Page SVG Assets',
          schemaVersion: 1,
          content: {
            assets: [
              {
                url: 'https://example.com/static/logo.svg',
                kind: 'svg',
                mimeType: 'image/svg+xml',
                filename: 'logo.svg',
                width: 120,
                height: 36,
                altText: 'Brand Logo',
              },
            ],
          },
        },
      });
      expect(manifestRes.statusCode).toBe(201);

      const listRes = await app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/artifacts?limit=10`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });
      expect(listRes.statusCode).toBe(200);
      const listBody = listRes.json<{
        items: Array<Record<string, unknown>>;
        nextCursor: string | null;
      }>();
      expect(listBody.items).toHaveLength(4);
      for (const item of listBody.items) {
        expect(item).not.toHaveProperty('content');
        expect(typeof item['byteLength']).toBe('number');
        expect(typeof item['contentSha256']).toBe('string');
      }

      const filteredListRes = await app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/artifacts?kind=asset_manifest`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });
      expect(filteredListRes.statusCode).toBe(200);
      expect(filteredListRes.json<{ items: unknown[] }>().items).toHaveLength(1);

      const updateArtRes = await app.inject({
        method: 'PUT',
        url: `/v1/projects/${projectId}/artifacts/${designRef.id}`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: {
          title: 'Updated DESIGN.md v2',
          schemaVersion: 1,
          expectedVersion: 1,
          content: {
            markdown: '# Updated Pricing Page v2',
            pageTitle: 'Example Pricing v2',
            viewport: { width: 1440, height: 900 },
            sections: ['Header', 'Tiers', 'FAQ'],
          },
        },
      });
      expect(updateArtRes.statusCode).toBe(200);
      expect(updateArtRes.json<{ artifact: { version: number } }>().artifact.version).toBe(2);

      const conflictArtRes = await app.inject({
        method: 'PUT',
        url: `/v1/projects/${projectId}/artifacts/${designRef.id}`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: {
          title: 'Concurrent Stale Write',
          schemaVersion: 1,
          expectedVersion: 1,
          content: {
            markdown: '# Should Not Overwrite',
            pageTitle: 'Stale',
            viewport: { width: 1440, height: 900 },
            sections: ['Header'],
          },
        },
      });
      expect(conflictArtRes.statusCode).toBe(409);
      expect(conflictArtRes.json<{ error: { code: string } }>().error.code).toBe(
        'VERSION_CONFLICT',
      );

      const verifyNotOverwrittenRes = await app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/artifacts/${designRef.id}`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });
      expect(verifyNotOverwrittenRes.statusCode).toBe(200);
      expect(
        verifyNotOverwrittenRes.json<{
          artifact: { title: string; content: { markdown: string } };
        }>().artifact,
      ).toMatchObject({
        title: 'Updated DESIGN.md v2',
        content: {
          markdown: '# Updated Pricing Page v2',
        },
      });

      const intruderListRes = await app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/artifacts`,
        headers: { authorization: `Bearer ${intruder.accessToken}` },
      });
      expect(intruderListRes.statusCode).toBe(404);

      const intruderGetRes = await app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/artifacts/${designRef.id}`,
        headers: { authorization: `Bearer ${intruder.accessToken}` },
      });
      expect(intruderGetRes.statusCode).toBe(404);

      const intruderCreateRes = await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/artifacts`,
        headers: { authorization: `Bearer ${intruder.accessToken}` },
        payload: {
          kind: 'rebuild_prompt',
          title: 'Injected Prompt',
          schemaVersion: 1,
          content: {
            prompt: 'Intruder prompt',
            targetFramework: 'generic',
            includeLayout: true,
            includeTypography: true,
            includeColors: true,
            componentChecklist: [],
          },
        },
      });
      expect(intruderCreateRes.statusCode).toBe(404);

      const intruderPutRes = await app.inject({
        method: 'PUT',
        url: `/v1/projects/${projectId}/artifacts/${designRef.id}`,
        headers: { authorization: `Bearer ${intruder.accessToken}` },
        payload: {
          title: 'Tampered',
          schemaVersion: 1,
          expectedVersion: 2,
          content: {
            markdown: '# Tampered',
            pageTitle: 'Tampered',
            viewport: { width: 1000, height: 800 },
            sections: ['Main'],
          },
        },
      });
      expect(intruderPutRes.statusCode).toBe(404);

      const intruderDeleteRes = await app.inject({
        method: 'DELETE',
        url: `/v1/projects/${projectId}/artifacts/${designRef.id}`,
        headers: { authorization: `Bearer ${intruder.accessToken}` },
      });
      expect(intruderDeleteRes.statusCode).toBe(404);

      const deleteSingleArtifactRes = await app.inject({
        method: 'DELETE',
        url: `/v1/projects/${projectId}/artifacts/${designRef.id}`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });
      expect(deleteSingleArtifactRes.statusCode).toBe(204);

      const deletedBodyRows = await dbContext.db
        .selectFrom('artifact_bodies')
        .selectAll()
        .where('artifact_id', '=', designRef.id)
        .execute();
      expect(deletedBodyRows).toHaveLength(0);
    } finally {
      await app.close();
      await disposable.drop();
    }
  });

  it('rolls back the transaction cleanly if a multi-table operation fails mid-transaction', async () => {
    const disposable = await pgCluster.createDisposableDatabase();
    const { app, dbContext } = await createTestAppInstance(disposable.databaseUrl, oidcServer);

    try {
      const user = await authenticateTestUser(app, oidcServer, {
        sub: 'google-tx-rollback-user',
        email: 'txrollback@example.com',
        name: 'Rollback User',
      });

      const projRes = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { authorization: `Bearer ${user.accessToken}` },
        payload: { name: 'Rollback Project' },
      });
      expect(projRes.statusCode).toBe(201);
      const projectId = projRes.json<{ project: { id: string } }>().project.id;

      await expect(
        dbContext.db.transaction().execute(async (trx) => {
          await trx
            .insertInto('artifacts')
            .values({
              id: '22222222-2222-4222-8222-222222222222',
              project_id: projectId,
              account_id: user.account.id,
              kind: 'rebuild_prompt',
              title: 'Should Rollback',
              schema_version: 1,
              source_url: null,
              byte_length: 120,
              content_sha256: 'abc',
              version: 1,
              created_at: new Date(),
              updated_at: new Date(),
            })
            .execute();

          throw new Error('Simulated failure before artifact_bodies insert');
        }),
      ).rejects.toThrow('Simulated failure before artifact_bodies insert');

      const orphanedRows = await dbContext.db
        .selectFrom('artifacts')
        .selectAll()
        .where('id', '=', '22222222-2222-4222-8222-222222222222')
        .execute();
      expect(orphanedRows).toHaveLength(0);
    } finally {
      await app.close();
      await disposable.drop();
    }
  });

  it('persists accounts, sessions, settings, projects, and artifacts across application restarts', async () => {
    const disposable = await pgCluster.createDisposableDatabase();
    const firstInstance = await createTestAppInstance(disposable.databaseUrl, oidcServer);

    let accessToken: string;
    let projectId: string;
    let artifactId: string;

    try {
      const auth = await authenticateTestUser(firstInstance.app, oidcServer, {
        sub: 'google-restart-user',
        email: 'restart@example.com',
        name: 'Restart User',
      });
      accessToken = auth.accessToken;

      const projRes = await firstInstance.app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: 'Persistent Project' },
      });
      expect(projRes.statusCode).toBe(201);
      projectId = projRes.json<{ project: { id: string } }>().project.id;

      const artRes = await firstInstance.app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/artifacts`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          kind: 'design_reference',
          title: 'Persistent Artifact',
          schemaVersion: 1,
          content: {
            markdown: '# Persisted across restart',
            pageTitle: 'Persistent Page',
            viewport: { width: 1280, height: 720 },
            sections: ['Hero'],
          },
        },
      });
      expect(artRes.statusCode).toBe(201);
      artifactId = artRes.json<{ artifact: { id: string } }>().artifact.id;
    } finally {
      await firstInstance.app.close();
    }

    const secondInstance = await createTestAppInstance(disposable.databaseUrl, oidcServer);
    try {
      const getArtRes = await secondInstance.app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/artifacts/${artifactId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(getArtRes.statusCode).toBe(200);
      expect(
        getArtRes.json<{ artifact: { title: string; content: { markdown: string } } }>().artifact,
      ).toMatchObject({
        title: 'Persistent Artifact',
        content: {
          markdown: '# Persisted across restart',
        },
      });
    } finally {
      await secondInstance.app.close();
      await disposable.drop();
    }
  });
});
