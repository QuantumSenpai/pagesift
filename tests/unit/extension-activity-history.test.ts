import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { BackgroundCoordinator } from '../../src/extension/background/service-worker.js';
import { validateSenderAuthorization } from '../../src/extension/protocol/messages.js';
import {
  buildResearchSessionId,
  groupDateLabelForLocalDisplay,
  sanitizeActivityOptions,
  sanitizeActivitySourceUrl,
  sanitizeActivitySummary,
  sanitizeActivityTitle,
} from '../../src/extension/storage/activity-history.js';
import { LocalExtensionStorage } from '../../src/extension/storage/idb-storage.js';
import {
  ExtensionSettingsStore,
  InMemoryKeyValueArea,
} from '../../src/extension/storage/settings-storage.js';

const EXT_ID = 'ffffffffffffffffffffffffffffffff';
const EXT_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/workspace.html` };
const TAB_SENDER = {
  id: EXT_ID,
  url: 'https://docs.example.com/guide?token=SECRET_TOKEN_999&api_key=nvapi-12345#hash',
  tab: {
    id: 17,
    url: 'https://docs.example.com/guide?token=SECRET_TOKEN_999&api_key=nvapi-12345#hash',
  },
};

describe('Local Research Activity History — Schema, Sanitization, Lifecycle, Filters, Retention & Security', () => {
  it('sanitizes URLs, titles, options, and summaries strictly without storing secrets, query strings, HTML, or base64 data', () => {
    const cleanUrl = sanitizeActivitySourceUrl(
      'https://alice:hunter2@app.example.com:8443/dashboard/view?session=abc&token=xyz#frag',
    );
    expect(cleanUrl.sourceUrl).toBe('https://app.example.com:8443/dashboard/view');
    expect(cleanUrl.sourceOrigin).toBe('https://app.example.com:8443');
    expect(cleanUrl.sourceDomain).toBe('app.example.com');
    expect(cleanUrl.sourceUrl).not.toContain('hunter2');
    expect(cleanUrl.sourceUrl).not.toContain('token=');
    expect(cleanUrl.sourceUrl).not.toContain('#frag');

    const title = sanitizeActivityTitle('  Hello\u0000\u0007\nWorld  ' + 'X'.repeat(240));
    expect(title.length).toBeLessThanOrEqual(160);
    expect(title).not.toContain('\u0000');

    const safeOpts = sanitizeActivityOptions({
      mode: 'full_page',
      exportMime: 'image/png',
      selector: '#hero-card',
      password: 'NEVER_STORE_PASSWORD',
      apiKey: 'nvapi-secret-999999',
      cookie: 'sid=123',
      text: 'Private entered text',
      html: '<div>secret</div>',
      dataUrl: 'data:image/png;base64,AAAA',
    });
    expect(safeOpts).toEqual({
      mode: 'full_page',
      exportMime: 'image/png',
      selector: '#hero-card',
    });

    const summary = sanitizeActivitySummary(
      'Captured data:image/png;base64,iVBORw0KGgoAAAANS with nvapi-secret-123456',
    );
    expect(summary).not.toContain('iVBOR');
    expect(summary).not.toContain('nvapi-secret');
    expect(summary).toContain('[binary-omitted]');
    expect(summary).toContain('[redacted]');
  });

  it('prunes expired history on a fresh worker wake even while recording is paused', async () => {
    const storage = new LocalExtensionStorage(`history-retention-wake-${Date.now()}`);
    const settingsStore = new ExtensionSettingsStore(
      new InMemoryKeyValueArea(),
      new InMemoryKeyValueArea(),
    );
    await settingsStore.updateSettings({ recordActivityHistory: false });
    const oldIso = new Date(Date.now() - 100 * 86400000).toISOString();
    await storage.upsertActivity({
      id: 'expired',
      sessionId: 'session-old',
      tool: 'colors',
      actionLabel: 'Extract Colors',
      sourceUrl: 'https://example.com/',
      sourceOrigin: 'https://example.com',
      sourceDomain: 'example.com',
      pageTitle: 'Old page',
      startedAt: oldIso,
      completedAt: oldIso,
      durationMs: 1,
      status: 'completed',
      optionsSummary: {},
      resultSummary: 'Old palette',
      linkedArtifactId: null,
      linkedCaptureId: null,
      errorCategory: null,
    });
    try {
      const coordinator = new BackgroundCoordinator({
        extensionId: EXT_ID,
        storage,
        settingsStore,
      });
      await coordinator.handleRuntimeMessage(
        {
          schemaVersion: 1,
          requestId: 'wake-query',
          operation: 'QUERY_ACTIVITY_HISTORY',
          payload: {},
        },
        EXT_SENDER,
      );
      expect(await storage.getActivity('expired')).toBeUndefined();
    } finally {
      await storage.close();
    }
  });

  it('finishes existing activity after recording is paused without recording new actions', async () => {
    const storage = new LocalExtensionStorage(`history-pause-lifecycle-${Date.now()}`);
    const settingsStore = new ExtensionSettingsStore(
      new InMemoryKeyValueArea(),
      new InMemoryKeyValueArea(),
    );
    const coordinator = new BackgroundCoordinator({ extensionId: EXT_ID, storage, settingsStore });
    const message = (status: 'running' | 'completed') => ({
      schemaVersion: 1,
      requestId: `pause-${status}`,
      operation: 'RECORD_LOCAL_ACTIVITY',
      payload: {
        activityId: 'started-before-pause',
        tool: 'colors',
        actionLabel: 'Extract Colors',
        status,
        resultSummary: 'Palette',
      },
    });
    try {
      await coordinator.handleRuntimeMessage(message('running'), TAB_SENDER);
      await settingsStore.updateSettings({ recordActivityHistory: false });
      await coordinator.handleRuntimeMessage(message('completed'), TAB_SENDER);
      expect((await storage.getActivity('started-before-pause'))?.status).toBe('completed');
      expect((await storage.queryActivities()).totalMatching).toBe(1);
    } finally {
      await storage.close();
    }
  });

  it('exposes only sender-tab jobs and rejects cross-tab cancellation from overlays', async () => {
    const storage = new LocalExtensionStorage(`history-overlay-jobs-${Date.now()}`);
    const settingsStore = new ExtensionSettingsStore(
      new InMemoryKeyValueArea(),
      new InMemoryKeyValueArea(),
    );
    const coordinator = new BackgroundCoordinator({ extensionId: EXT_ID, storage, settingsStore });
    await coordinator.initialize();
    await storage.StartToolJob({
      id: 'same-tab-job',
      tool: 'clone_page',
      tabId: 17,
      documentId: 'doc-own',
    });
    await storage.StartToolJob({
      id: 'other-tab-job',
      tool: 'capture',
      tabId: 99,
      documentId: 'doc-other',
    });
    try {
      const result = await coordinator.handleRuntimeMessage(
        { schemaVersion: 1, requestId: 'site-jobs-list', operation: 'LIST_SITE_JOBS', payload: {} },
        TAB_SENDER,
      );
      expect(result.ok).toBe(true);
      if (result.ok)
        expect((result.data as { jobs: Array<{ id: string }> }).jobs.map((job) => job.id)).toEqual([
          'same-tab-job',
        ]);
      const cancel = await coordinator.handleRuntimeMessage(
        {
          schemaVersion: 1,
          requestId: 'wrong-tab-cancel',
          operation: 'CANCEL_JOB',
          payload: { jobId: 'other-tab-job' },
        },
        TAB_SENDER,
      );
      expect(cancel.ok).toBe(false);
      expect((await storage.getJob('other-tab-job'))?.status).toBe('running');
    } finally {
      await storage.close();
    }
  });

  it('upgrades IndexedDB from v2 to v3 preserving existing records and adds indexed activities store', async () => {
    const dbName = `pagesift_v2_to_v3_${Date.now()}`;
    const v2 = await openDB(dbName, 2, {
      upgrade(db) {
        const p = db.createObjectStore('projects', { keyPath: 'id' });
        p.createIndex('by-updated', 'updatedAt');
        const a = db.createObjectStore('artifacts', { keyPath: 'id' });
        a.createIndex('by-project', 'projectId');
        a.createIndex('by-kind', 'kind');
        a.createIndex('by-updated', 'updatedAt');
        const c = db.createObjectStore('captures', { keyPath: 'id' });
        c.createIndex('by-project', 'projectId');
        const j = db.createObjectStore('jobs', { keyPath: 'id' });
        j.createIndex('by-status', 'status');
      },
    });
    const nowIso = new Date().toISOString();
    await v2.put('projects', {
      id: 'proj-v2',
      name: 'Existing v2 Project',
      description: 'Survives v3 upgrade',
      sourceDomain: 'example.com',
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    v2.close();

    const storage = new LocalExtensionStorage(dbName);
    try {
      const projects = await storage.listProjects();
      expect(projects.map((p) => p.id)).toEqual(['proj-v2']);
      const db = await storage.getDb();
      expect(db.objectStoreNames.contains('activities')).toBe(true);
    } finally {
      await storage.close();
    }
  });

  it('records one lifecycle record per action, honors disabled recording, strips secrets, supports filters/pagination/retention/deletion, and recovers interrupted activities on wake', async () => {
    const dbName = `pagesift_act_lifecycle_${Date.now()}`;
    const storage = new LocalExtensionStorage(dbName);
    const localArea = new InMemoryKeyValueArea();
    const sessionArea = new InMemoryKeyValueArea();
    const settingsStore = new ExtensionSettingsStore(localArea, sessionArea);

    const coordinator = new BackgroundCoordinator({
      extensionId: EXT_ID,
      storage,
      settingsStore,
      sessionStateArea: sessionArea,
    });

    try {
      const startRes = await coordinator.handleRuntimeMessage(
        {
          schemaVersion: 1,
          requestId: 'req-act-1',
          operation: 'RECORD_LOCAL_ACTIVITY',
          payload: {
            activityId: 'act-single-lifecycle-1',
            tool: 'colors',
            actionLabel: 'Extract Colors',
            pageTitle: 'Guide — Secret?token=123',
            status: 'running',
            optionsSummary: { format: 'tailwindV4', password: 'leaked' },
            resultSummary: 'Scanning document',
          },
        },
        TAB_SENDER,
      );
      expect(startRes.ok).toBe(true);

      const completeRes = await coordinator.handleRuntimeMessage(
        {
          schemaVersion: 1,
          requestId: 'req-act-2',
          operation: 'RECORD_LOCAL_ACTIVITY',
          payload: {
            activityId: 'act-single-lifecycle-1',
            tool: 'colors',
            actionLabel: 'Extract Colors',
            pageTitle: 'Guide — Docs',
            status: 'completed',
            durationMs: 42,
            optionsSummary: { format: 'tailwindV4', token: 'secret-token' },
            resultSummary: 'Extracted 12 colors and 4 CSS variables',
          },
        },
        TAB_SENDER,
      );
      expect(completeRes.ok).toBe(true);

      const queryAll = await coordinator.handleRuntimeMessage(
        {
          schemaVersion: 1,
          requestId: 'req-query-1',
          operation: 'QUERY_ACTIVITY_HISTORY',
          payload: {},
        },
        EXT_SENDER,
      );
      expect(queryAll.ok).toBe(true);
      if (queryAll.ok) {
        const res = queryAll.data as {
          items: Array<{
            id: string;
            status: string;
            sourceUrl: string;
            durationMs: number;
            optionsSummary: Record<string, unknown>;
          }>;
          totalMatching: number;
        };
        expect(res.totalMatching).toBe(1);
        expect(res.items[0]?.id).toBe('act-single-lifecycle-1');
        expect(res.items[0]?.status).toBe('completed');
        expect(res.items[0]?.durationMs).toBe(42);
        expect(res.items[0]?.sourceUrl).toBe('https://docs.example.com/guide');
        expect(res.items[0]?.sourceUrl).not.toContain('SECRET_TOKEN_999');
        expect(res.items[0]?.optionsSummary).toEqual({ format: 'tailwindV4' });
      }

      const siteOnlyRes = await coordinator.handleRuntimeMessage(
        {
          schemaVersion: 1,
          requestId: 'req-site-act-1',
          operation: 'LIST_SITE_ACTIVITY',
          payload: { limit: 5 },
        },
        TAB_SENDER,
      );
      expect(siteOnlyRes.ok).toBe(true);
      if (siteOnlyRes.ok) {
        const data = siteOnlyRes.data as { items: Array<{ sourceOrigin: string }> };
        expect(data.items.length).toBe(1);
        expect(data.items[0]?.sourceOrigin).toBe('https://docs.example.com');
      }

      expect(validateSenderAuthorization(TAB_SENDER, EXT_ID, 'DELETE_ACTIVITY_ENTRY').allowed).toBe(
        false,
      );
      expect(
        validateSenderAuthorization(TAB_SENDER, EXT_ID, 'CLEAR_ACTIVITY_HISTORY').allowed,
      ).toBe(false);

      await settingsStore.updateSettings({ recordActivityHistory: false });
      const disabledRes = await coordinator.handleRuntimeMessage(
        {
          schemaVersion: 1,
          requestId: 'req-act-disabled',
          operation: 'RECORD_LOCAL_ACTIVITY',
          payload: {
            activityId: 'act-should-not-save',
            tool: 'fonts',
            actionLabel: 'Inspect Fonts',
            status: 'completed',
            resultSummary: 'Should not be saved',
          },
        },
        TAB_SENDER,
      );
      expect(disabledRes.ok).toBe(true);
      expect(await storage.getActivity('act-should-not-save')).toBeUndefined();

      await settingsStore.updateSettings({ recordActivityHistory: true });
      const nowMs = Date.now();
      const oldIso = new Date(nowMs - 120 * 24 * 60 * 60 * 1000).toISOString();
      const recentIso = new Date(nowMs - 1000).toISOString();

      await storage.upsertActivity({
        id: 'act-old-pruned',
        sessionId: buildResearchSessionId('old.example.com', oldIso),
        tool: 'inspect',
        actionLabel: 'Inspect Element',
        sourceUrl: 'https://old.example.com/',
        sourceOrigin: 'https://old.example.com',
        sourceDomain: 'old.example.com',
        pageTitle: 'Old Site',
        startedAt: oldIso,
        completedAt: oldIso,
        durationMs: 12,
        status: 'completed',
        optionsSummary: {},
        resultSummary: 'Old entry',
        linkedArtifactId: 'art-deleted-id',
        linkedCaptureId: null,
        errorCategory: null,
      });

      await storage.upsertActivity({
        id: 'act-running-before-crash',
        sessionId: buildResearchSessionId('live.example.com', recentIso),
        tool: 'capture',
        actionLabel: 'Full Page Capture',
        sourceUrl: 'https://live.example.com/page',
        sourceOrigin: 'https://live.example.com',
        sourceDomain: 'live.example.com',
        pageTitle: 'Live Site',
        startedAt: recentIso,
        completedAt: null,
        durationMs: null,
        status: 'running',
        optionsSummary: { mode: 'full_page' },
        resultSummary: 'In progress',
        linkedArtifactId: null,
        linkedCaptureId: null,
        errorCategory: null,
      });

      const deletedByRetention = await storage.pruneActivities({
        retentionDays: 90,
        maxEntries: 500,
        nowMs,
      });
      expect(deletedByRetention).toBe(1);
      expect(await storage.getActivity('act-old-pruned')).toBeUndefined();

      const freshAfterCrash = new BackgroundCoordinator({
        extensionId: EXT_ID,
        storage,
        settingsStore,
        sessionStateArea: sessionArea,
      });
      const recoveredQuery = await freshAfterCrash.handleRuntimeMessage(
        {
          schemaVersion: 1,
          requestId: 'req-after-crash-query',
          operation: 'QUERY_ACTIVITY_HISTORY',
          payload: { status: 'interrupted' },
        },
        EXT_SENDER,
      );
      expect(recoveredQuery.ok).toBe(true);
      if (recoveredQuery.ok) {
        const res = recoveredQuery.data as {
          items: Array<{ id: string; status: string; errorCategory: string | null }>;
        };
        expect(res.items.some((i) => i.id === 'act-running-before-crash')).toBe(true);
        expect(res.items[0]?.status).toBe('interrupted');
        expect(res.items[0]?.errorCategory).toBe('WORKER_INTERRUPTED');
      }

      const backup = await storage.exportBackup();
      expect(backup.schemaVersion).toBe(2);
      expect(backup.activities.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(backup)).not.toContain('SECRET_TOKEN_999');

      await storage.clearActivities();
      expect((await storage.queryActivities()).totalMatching).toBe(0);

      const imported = await storage.importBackup(backup);
      expect(imported.importedActivities).toBe(backup.activities.length);
      expect((await storage.queryActivities()).totalMatching).toBe(backup.activities.length);

      expect(groupDateLabelForLocalDisplay(new Date().toISOString())).toBe('Today');
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      expect(groupDateLabelForLocalDisplay(yesterday.toISOString())).toBe('Yesterday');
    } finally {
      await storage.close();
    }
  });
});
