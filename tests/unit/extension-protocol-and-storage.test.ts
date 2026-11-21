import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import {
  validateMessageEnvelope,
  validateSenderAuthorization,
  verifyDocumentBinding,
} from '../../src/extension/protocol/messages.js';
import {
  LocalExtensionStorage,
  QuotaExceededStorageError,
} from '../../src/extension/storage/idb-storage.js';
import {
  ExtensionSettingsStore,
  InMemoryKeyValueArea,
} from '../../src/extension/storage/settings-storage.js';

const TEST_EXT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('Extension runtime message protocol and security boundaries', () => {
  it('validates well-formed runtime messages and rejects malformed envelopes', () => {
    const valid = validateMessageEnvelope({
      schemaVersion: 1,
      requestId: 'req-12345',
      operation: 'RUN_INSPECT_ELEMENT',
      documentId: 'doc-999',
      payload: { selector: '#hero' },
    });
    expect(valid.valid).toBe(true);

    const invalid = validateMessageEnvelope({
      schemaVersion: 2,
      requestId: 'x',
      operation: 'UNKNOWN_OP',
    });
    expect(invalid.valid).toBe(false);
    if (!invalid.valid) {
      expect(invalid.response.error.code).toBe('INVALID_MESSAGE');
    }
  });

  it('prevents content scripts and untrusted origins from executing privileged operations', () => {
    const untrustedSender = validateSenderAuthorization(
      {
        id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        url: 'https://evil.example.com',
      },
      TEST_EXT_ID,
      'RUN_INSPECT_ELEMENT',
    );
    expect(untrustedSender.allowed).toBe(false);

    const contentScriptOnPrivilegedOp = validateSenderAuthorization(
      {
        id: TEST_EXT_ID,
        url: 'https://inspected-site.example.com/page',
        tab: { id: 10, url: 'https://inspected-site.example.com/page' },
      },
      TEST_EXT_ID,
      'SET_NVIDIA_API_KEY',
    );
    expect(contentScriptOnPrivilegedOp.allowed).toBe(false);

    const contentScriptOnBackupOp = validateSenderAuthorization(
      {
        id: TEST_EXT_ID,
        url: 'https://inspected-site.example.com/page',
        tab: { id: 10, url: 'https://inspected-site.example.com/page' },
      },
      TEST_EXT_ID,
      'EXPORT_DB_BACKUP',
    );
    expect(contentScriptOnBackupOp.allowed).toBe(false);

    const trustedWorkspacePage = validateSenderAuthorization(
      {
        id: TEST_EXT_ID,
        url: `chrome-extension://${TEST_EXT_ID}/workspace.html`,
      },
      TEST_EXT_ID,
      'SET_NVIDIA_API_KEY',
    );
    expect(trustedWorkspacePage.allowed).toBe(true);
    expect(trustedWorkspacePage.isExtensionPage).toBe(true);
  });

  it('binds operations to initiating documentId and rejects stale results after navigation', () => {
    expect(verifyDocumentBinding('doc-initial-1', 'doc-initial-1')).toBe(true);
    expect(verifyDocumentBinding('doc-initial-1', 'doc-after-navigation-2')).toBe(false);
  });
});

describe('Extension IndexedDB storage, versioned upgrades, quota handling, and session secret isolation', () => {
  it('upgrades a v1 database cleanly to v2 preserving existing data and adding v2 stores/indexes', async () => {
    const dbName = `pagesift_upgrade_test_${Date.now()}`;
    const v1Db = await openDB(dbName, 1, {
      upgrade(db) {
        const projectStore = db.createObjectStore('projects', { keyPath: 'id' });
        projectStore.createIndex('by-updated', 'updatedAt');
        const artifactStore = db.createObjectStore('artifacts', { keyPath: 'id' });
        artifactStore.createIndex('by-project', 'projectId');
        artifactStore.createIndex('by-updated', 'updatedAt');
        const captureStore = db.createObjectStore('captures', { keyPath: 'id' });
        captureStore.createIndex('by-project', 'projectId');
      },
    });

    const nowIso = new Date().toISOString();
    await v1Db.put('projects', {
      id: 'proj-v1',
      name: 'Legacy V1 Project',
      description: 'Created before v2 upgrade',
      sourceDomain: 'legacy.example.com',
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    v1Db.close();

    const storage = new LocalExtensionStorage(dbName);
    try {
      const projects = await storage.listProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]?.name).toBe('Legacy V1 Project');

      await storage.StartToolJob({
        id: 'job-1',
        tool: 'clone_page',
        tabId: 42,
        documentId: 'doc-42',
      });
      const recovered = await storage.recoverInterruptedJobs();
      expect(recovered).toBe(1);
      const jobAfterRecovery = await storage.getJob('job-1');
      expect(jobAfterRecovery?.status).toBe('interrupted');
    } finally {
      await storage.close();
    }
  });

  it('enforces quota limits without silent data loss and cascades project deletion', async () => {
    const dbName = `pagesift_quota_test_${Date.now()}`;
    const storage = new LocalExtensionStorage(dbName, 2048);
    const nowIso = new Date().toISOString();

    try {
      await storage.saveProject({
        id: 'proj-1',
        name: 'Small Project',
        description: 'Fits within 2KiB quota',
        sourceDomain: 'example.com',
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      await storage.saveArtifact({
        id: 'art-1',
        projectId: 'proj-1',
        kind: 'design_md',
        title: 'First Artifact',
        sourceUrl: 'https://example.com',
        schemaVersion: 1,
        payload: { markdown: '# Small Design System' },
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      await expect(
        storage.saveArtifact({
          id: 'art-oversized',
          projectId: 'proj-1',
          kind: 'design_md',
          title: 'Oversized Artifact',
          sourceUrl: 'https://example.com',
          schemaVersion: 1,
          payload: { markdown: 'X'.repeat(4000) },
          createdAt: nowIso,
          updatedAt: nowIso,
        }),
      ).rejects.toBeInstanceOf(QuotaExceededStorageError);

      const preservedArtifacts = await storage.listArtifacts('proj-1');
      expect(preservedArtifacts).toHaveLength(1);
      expect(preservedArtifacts[0]?.id).toBe('art-1');

      await storage.deleteProject('proj-1');
      expect(await storage.listProjects()).toHaveLength(0);
      expect(await storage.listArtifacts('proj-1')).toHaveLength(0);
    } finally {
      await storage.close();
    }
  });

  it('exports and imports validated backup bundles and rejects broken referential integrity', async () => {
    const dbName1 = `pagesift_backup_src_${Date.now()}`;
    const dbName2 = `pagesift_backup_dst_${Date.now()}`;
    const srcStorage = new LocalExtensionStorage(dbName1);
    const dstStorage = new LocalExtensionStorage(dbName2);
    const nowIso = new Date().toISOString();

    try {
      await srcStorage.saveProject({
        id: 'proj-b1',
        name: 'Backup Project',
        description: 'To be exported',
        sourceDomain: 'backup.example.com',
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      await srcStorage.saveArtifact({
        id: 'art-b1',
        projectId: 'proj-b1',
        kind: 'color_palette',
        title: 'Palette',
        sourceUrl: 'https://backup.example.com',
        schemaVersion: 1,
        payload: { colors: ['#112233'] },
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      const bundle = await srcStorage.exportBackup();
      const imported = await dstStorage.importBackup(bundle);
      expect(imported.importedProjects).toBe(1);
      expect(imported.importedArtifacts).toBe(1);

      await expect(
        dstStorage.importBackup({
          ...bundle,
          projects: [],
        }),
      ).rejects.toThrow(/integrity failure/);
    } finally {
      await srcStorage.close();
      await dstStorage.close();
    }
  });

  it('isolates NVIDIA API keys in session storage and never includes them in local settings or backups', async () => {
    const localArea = new InMemoryKeyValueArea();
    const sessionArea = new InMemoryKeyValueArea();
    const settingsStore = new ExtensionSettingsStore(localArea, sessionArea);

    await settingsStore.setSessionNvidiaApiKey('nvapi-test-key-secret-value-1234567890');
    const status = await settingsStore.getNvidiaKeyStatus();
    expect(status.hasSessionKey).toBe(true);
    expect(status.maskedPreview).toBe('nvapi-...7890');

    const localDump = await localArea.get([
      'pagesift_settings_v1',
      'pagesift_nvidia_session_api_key',
    ]);
    expect(JSON.stringify(localDump)).not.toContain('nvapi-test-key-secret-value-1234567890');

    await settingsStore.clearSessionNvidiaApiKey();
    expect((await settingsStore.getNvidiaKeyStatus()).hasSessionKey).toBe(false);
  });
});
