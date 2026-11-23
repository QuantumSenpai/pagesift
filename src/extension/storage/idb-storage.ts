import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { z } from 'zod';
import type { ToolId } from '../protocol/messages.js';
import {
  DEFAULT_ACTIVITY_MAX_ENTRIES,
  DEFAULT_ACTIVITY_RETENTION_DAYS,
  localActivitySchema,
  type ActivityQueryFilter,
  type ActivityQueryItem,
  type ActivityQueryResult,
  type LocalActivityRecord,
} from './activity-history.js';

export const LOCAL_DB_NAME = 'pagesift_local_db';
export const LOCAL_DB_VERSION = 4;
export const DEFAULT_SOFT_QUOTA_BYTES = 50 * 1024 * 1024;

export const localProjectSchema = z.strictObject({
  id: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(1000),
  sourceDomain: z.string().max(253).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type LocalProjectRecord = z.infer<typeof localProjectSchema>;

export const localArtifactKindSchema = z.enum([
  'inspect_report',
  'clone_snapshot',
  'clone_prompt',
  'design_md',
  'asset_manifest',
  'color_palette',
  'font_report',
  'capture_image',
  'design_review',
  'tech_stack',
  'motion_lab',
]);

export type LocalArtifactKind = z.infer<typeof localArtifactKindSchema>;

export const localArtifactSchema = z.strictObject({
  id: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128),
  kind: localArtifactKindSchema,
  title: z.string().trim().min(1).max(200),
  sourceUrl: z.string().max(2048).nullable(),
  schemaVersion: z.number().int().min(1),
  byteLength: z.number().int().min(0),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type LocalArtifactRecord = z.infer<typeof localArtifactSchema>;

export const localCaptureSchema = z.strictObject({
  id: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128),
  pageUrl: z.string().max(2048),
  pageTitle: z.string().max(300),
  mode: z.enum(['visible', 'area', 'element', 'full_page']),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']),
  width: z.number().int().min(1).max(32768),
  height: z.number().int().min(1).max(32768),
  byteLength: z.number().int().min(1),
  dataUrl: z.string().min(10),
  annotations: z
    .array(
      z.strictObject({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
        label: z.string().max(200),
        color: z.string().max(32),
      }),
    )
    .default([]),
  createdAt: z.iso.datetime(),
});

export type LocalCaptureRecord = z.infer<typeof localCaptureSchema>;

export const localJobSchema = z.strictObject({
  id: z.string().min(1).max(128),
  tool: z.string().min(1).max(64),
  tabId: z.number().int().min(0),
  documentId: z.string().min(1).max(128),
  status: z.enum(['running', 'completed', 'cancelled', 'failed', 'interrupted']),
  progressPercent: z.number().min(0).max(100),
  statusMessage: z.string().max(500),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type LocalJobRecord = z.infer<typeof localJobSchema>;

export const localBackupBundleSchema = z.strictObject({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  exportedAt: z.iso.datetime(),
  projects: z.array(localProjectSchema).max(1000),
  artifacts: z.array(localArtifactSchema).max(5000),
  captures: z.array(localCaptureSchema).max(1000),
  activities: z.array(localActivitySchema).max(2000).default([]),
});

export type LocalBackupBundle = z.infer<typeof localBackupBundleSchema>;

export interface PageSiftIndexedDbSchema extends DBSchema {
  projects: {
    key: string;
    value: LocalProjectRecord;
    indexes: {
      'by-updated': string;
    };
  };
  artifacts: {
    key: string;
    value: LocalArtifactRecord;
    indexes: {
      'by-project': string;
      'by-kind': string;
      'by-updated': string;
    };
  };
  captures: {
    key: string;
    value: LocalCaptureRecord;
    indexes: {
      'by-project': string;
    };
  };
  jobs: {
    key: string;
    value: LocalJobRecord;
    indexes: {
      'by-status': string;
    };
  };
  activities: {
    key: string;
    value: LocalActivityRecord;
    indexes: {
      'by-startedAt': string;
      'by-origin': string;
      'by-tool': string;
      'by-status': string;
      'by-session': string;
    };
  };
  motion_media: {
    key: string;
    value: LocalMotionMediaRecord;
    indexes: {
      'by-project': string;
      'by-session': string;
    };
  };
}

export interface LocalMotionMediaRecord {
  id: string;
  projectId: string;
  sessionId: string;
  kind: 'video' | 'frame';
  mimeType: 'video/webm' | 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  durationMs: number;
  tMs: number;
  byteLength: number;
  bytes: Uint8Array;
  createdAt: string;
}

export interface StorageUsageReport {
  projectCount: number;
  artifactCount: number;
  captureCount: number;
  jobCount: number;
  activityCount: number;
  motionMediaCount: number;
  usedBytes: number;
  softQuotaBytes: number;
  percentUsed: number;
}

export class QuotaExceededStorageError extends Error {
  public readonly usedBytes: number;
  public readonly requestedBytes: number;
  public readonly quotaBytes: number;

  public constructor(usedBytes: number, requestedBytes: number, quotaBytes: number) {
    super(
      `Local storage quota exceeded: used ${usedBytes} bytes, requested ${requestedBytes} bytes, quota ${quotaBytes} bytes`,
    );
    this.name = 'QuotaExceededStorageError';
    this.usedBytes = usedBytes;
    this.requestedBytes = requestedBytes;
    this.quotaBytes = quotaBytes;
  }
}

function measureRecordBytes(record: unknown): number {
  return new TextEncoder().encode(JSON.stringify(record)).byteLength;
}

export async function openPageSiftDb(
  dbName: string = LOCAL_DB_NAME,
  version: number = LOCAL_DB_VERSION,
): Promise<IDBPDatabase<PageSiftIndexedDbSchema>> {
  return openDB<PageSiftIndexedDbSchema>(dbName, version, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        const projectStore = db.createObjectStore('projects', { keyPath: 'id' });
        projectStore.createIndex('by-updated', 'updatedAt');

        const artifactStore = db.createObjectStore('artifacts', { keyPath: 'id' });
        artifactStore.createIndex('by-project', 'projectId');
        artifactStore.createIndex('by-updated', 'updatedAt');

        const captureStore = db.createObjectStore('captures', { keyPath: 'id' });
        captureStore.createIndex('by-project', 'projectId');
      }

      if (oldVersion < 2) {
        if (db.objectStoreNames.contains('artifacts')) {
          const artifactStore = transaction.objectStore('artifacts');
          if (!artifactStore.indexNames.contains('by-kind')) {
            artifactStore.createIndex('by-kind', 'kind');
          }
        }
        if (!db.objectStoreNames.contains('jobs')) {
          const jobStore = db.createObjectStore('jobs', { keyPath: 'id' });
          jobStore.createIndex('by-status', 'status');
        }
      }

      if (oldVersion < 3) {
        if (!db.objectStoreNames.contains('activities')) {
          const actStore = db.createObjectStore('activities', { keyPath: 'id' });
          actStore.createIndex('by-startedAt', 'startedAt');
          actStore.createIndex('by-origin', 'sourceOrigin');
          actStore.createIndex('by-tool', 'tool');
          actStore.createIndex('by-status', 'status');
          actStore.createIndex('by-session', 'sessionId');
        }
      }

      if (oldVersion < 4) {
        if (!db.objectStoreNames.contains('motion_media')) {
          const mediaStore = db.createObjectStore('motion_media', { keyPath: 'id' });
          mediaStore.createIndex('by-project', 'projectId');
          mediaStore.createIndex('by-session', 'sessionId');
        }
      }
    },
  });
}

export class LocalExtensionStorage {
  private readonly dbName: string;
  private readonly softQuotaBytes: number;
  private dbPromise: Promise<IDBPDatabase<PageSiftIndexedDbSchema>> | null = null;

  public constructor(
    dbName: string = LOCAL_DB_NAME,
    softQuotaBytes: number = DEFAULT_SOFT_QUOTA_BYTES,
  ) {
    this.dbName = dbName;
    this.softQuotaBytes = softQuotaBytes;
  }

  public async getDb(): Promise<IDBPDatabase<PageSiftIndexedDbSchema>> {
    if (!this.dbPromise) {
      this.dbPromise = openPageSiftDb(this.dbName, LOCAL_DB_VERSION);
    }
    return this.dbPromise;
  }

  public async close(): Promise<void> {
    if (this.dbPromise) {
      const db = await this.dbPromise;
      db.close();
      this.dbPromise = null;
    }
  }

  public async getStorageUsage(): Promise<StorageUsageReport> {
    const db = await this.getDb();
    const tx = db.transaction(
      ['projects', 'artifacts', 'captures', 'jobs', 'activities', 'motion_media'],
      'readonly',
    );
    const [projects, artifacts, captures, jobs, activities, motionMedia] = await Promise.all([
      tx.objectStore('projects').getAll(),
      tx.objectStore('artifacts').getAll(),
      tx.objectStore('captures').getAll(),
      tx.objectStore('jobs').getAll(),
      tx.objectStore('activities').getAll(),
      tx.objectStore('motion_media').getAll(),
    ]);
    await tx.done;

    let usedBytes = 0;
    for (const p of projects) {
      usedBytes += measureRecordBytes(p);
    }
    for (const a of artifacts) {
      usedBytes += measureRecordBytes(a);
    }
    for (const c of captures) {
      usedBytes += measureRecordBytes(c);
    }
    for (const j of jobs) {
      usedBytes += measureRecordBytes(j);
    }
    for (const act of activities) {
      usedBytes += measureRecordBytes(act);
    }
    for (const mm of motionMedia) {
      usedBytes += mm.byteLength;
    }

    const percentUsed =
      this.softQuotaBytes > 0
        ? Number(Math.min(100, (usedBytes / this.softQuotaBytes) * 100).toFixed(2))
        : 100;

    return {
      projectCount: projects.length,
      artifactCount: artifacts.length,
      captureCount: captures.length,
      jobCount: jobs.length,
      activityCount: activities.length,
      motionMediaCount: motionMedia.length,
      usedBytes,
      softQuotaBytes: this.softQuotaBytes,
      percentUsed,
    };
  }

  private async ensureQuotaAvailable(additionalBytes: number): Promise<void> {
    const usage = await this.getStorageUsage();
    if (usage.usedBytes + additionalBytes > this.softQuotaBytes) {
      throw new QuotaExceededStorageError(usage.usedBytes, additionalBytes, this.softQuotaBytes);
    }
  }

  public async saveProject(project: LocalProjectRecord): Promise<LocalProjectRecord> {
    const validated = localProjectSchema.parse(project);
    const bytes = measureRecordBytes(validated);
    await this.ensureQuotaAvailable(bytes);

    const db = await this.getDb();
    const tx = db.transaction('projects', 'readwrite');
    await tx.objectStore('projects').put(validated);
    await tx.done;
    return validated;
  }

  public async listProjects(): Promise<LocalProjectRecord[]> {
    const db = await this.getDb();
    const all = await db.getAll('projects');
    return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public async getProject(projectId: string): Promise<LocalProjectRecord | undefined> {
    const db = await this.getDb();
    return db.get('projects', projectId);
  }

  public async deleteProject(projectId: string): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(['projects', 'artifacts', 'captures', 'motion_media'], 'readwrite');
    await tx.objectStore('projects').delete(projectId);

    const artifactIndex = tx.objectStore('artifacts').index('by-project');
    const artifactKeys = await artifactIndex.getAllKeys(projectId);
    for (const key of artifactKeys) {
      await tx.objectStore('artifacts').delete(key);
    }

    const captureIndex = tx.objectStore('captures').index('by-project');
    const captureKeys = await captureIndex.getAllKeys(projectId);
    for (const key of captureKeys) {
      await tx.objectStore('captures').delete(key);
    }

    const mediaIndex = tx.objectStore('motion_media').index('by-project');
    const mediaKeys = await mediaIndex.getAllKeys(projectId);
    for (const key of mediaKeys) {
      await tx.objectStore('motion_media').delete(key);
    }

    await tx.done;
  }

  public async saveMotionMedia(
    input: Omit<LocalMotionMediaRecord, 'byteLength'>,
  ): Promise<LocalMotionMediaRecord> {
    const byteLength = input.bytes.byteLength;
    await this.ensureQuotaAvailable(byteLength + 256);
    const record: LocalMotionMediaRecord = {
      ...input,
      byteLength,
    };
    const db = await this.getDb();
    const tx = db.transaction('motion_media', 'readwrite');
    await tx.objectStore('motion_media').put(record);
    await tx.done;
    return record;
  }

  public async getMotionMedia(id: string): Promise<LocalMotionMediaRecord | undefined> {
    const db = await this.getDb();
    return db.get('motion_media', id);
  }

  public async listMotionMediaBySession(sessionId: string): Promise<LocalMotionMediaRecord[]> {
    const db = await this.getDb();
    return db.getAllFromIndex('motion_media', 'by-session', sessionId);
  }

  public async deleteMotionMedia(id: string): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction('motion_media', 'readwrite');
    await tx.objectStore('motion_media').delete(id);
    await tx.done;
  }

  public async deleteMotionMediaBySession(sessionId: string): Promise<number> {
    const db = await this.getDb();
    const tx = db.transaction('motion_media', 'readwrite');
    const keys = await tx.objectStore('motion_media').index('by-session').getAllKeys(sessionId);
    for (const key of keys) {
      await tx.objectStore('motion_media').delete(key);
    }
    await tx.done;
    return keys.length;
  }

  public async saveArtifact(
    input: Omit<LocalArtifactRecord, 'byteLength'>,
  ): Promise<LocalArtifactRecord> {
    const payloadBytes = measureRecordBytes(input.payload);
    const candidate: LocalArtifactRecord = {
      ...input,
      byteLength: payloadBytes,
    };
    const validated = localArtifactSchema.parse(candidate);
    const totalBytes = measureRecordBytes(validated);
    await this.ensureQuotaAvailable(totalBytes);

    const db = await this.getDb();
    const tx = db.transaction(['projects', 'artifacts'], 'readwrite');
    const project = await tx.objectStore('projects').get(validated.projectId);
    if (!project) {
      throw new Error(`Parent project ${validated.projectId} does not exist`);
    }
    await tx.objectStore('artifacts').put(validated);
    await tx.objectStore('projects').put({
      ...project,
      updatedAt: validated.updatedAt,
    });
    await tx.done;
    return validated;
  }

  public async listArtifacts(projectId?: string): Promise<LocalArtifactRecord[]> {
    const db = await this.getDb();
    const rows = projectId
      ? await db.getAllFromIndex('artifacts', 'by-project', projectId)
      : await db.getAll('artifacts');
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public async getArtifact(artifactId: string): Promise<LocalArtifactRecord | undefined> {
    const db = await this.getDb();
    return db.get('artifacts', artifactId);
  }

  public async deleteArtifact(artifactId: string): Promise<void> {
    const db = await this.getDb();
    await db.delete('artifacts', artifactId);
  }

  public async saveCapture(capture: LocalCaptureRecord): Promise<LocalCaptureRecord> {
    const validated = localCaptureSchema.parse(capture);
    const totalBytes = measureRecordBytes(validated);
    await this.ensureQuotaAvailable(totalBytes);

    const db = await this.getDb();
    const tx = db.transaction(['projects', 'captures'], 'readwrite');
    const project = await tx.objectStore('projects').get(validated.projectId);
    if (!project) {
      throw new Error(`Parent project ${validated.projectId} does not exist`);
    }
    await tx.objectStore('captures').put(validated);
    await tx.done;
    return validated;
  }

  public async listCaptures(projectId?: string): Promise<LocalCaptureRecord[]> {
    const db = await this.getDb();
    const rows = projectId
      ? await db.getAllFromIndex('captures', 'by-project', projectId)
      : await db.getAll('captures');
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public async upsertJob(job: LocalJobRecord): Promise<LocalJobRecord> {
    const validated = localJobSchema.parse(job);
    const db = await this.getDb();
    await db.put('jobs', validated);
    return validated;
  }

  public async getJob(jobId: string): Promise<LocalJobRecord | undefined> {
    const db = await this.getDb();
    return db.get('jobs', jobId);
  }

  public async recoverInterruptedJobs(): Promise<number> {
    const db = await this.getDb();
    const tx = db.transaction(['jobs', 'activities'], 'readwrite');
    const runningJobs = await tx.objectStore('jobs').index('by-status').getAll('running');
    const runningActivities = await tx
      .objectStore('activities')
      .index('by-status')
      .getAll('running');
    const nowIso = new Date().toISOString();

    for (const job of runningJobs) {
      await tx.objectStore('jobs').put({
        ...job,
        status: 'interrupted',
        statusMessage: 'Service worker terminated before job completion',
        updatedAt: nowIso,
      });
    }

    for (const activity of runningActivities) {
      const startedMs = Date.parse(activity.startedAt);
      const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : null;
      await tx.objectStore('activities').put({
        ...activity,
        status: 'interrupted',
        completedAt: nowIso,
        durationMs: elapsedMs,
        errorCategory: 'WORKER_INTERRUPTED',
        resultSummary: activity.resultSummary || 'Interrupted before completion',
      });
    }

    await tx.done;
    return runningJobs.length + runningActivities.length;
  }

  public async upsertActivity(record: LocalActivityRecord): Promise<LocalActivityRecord> {
    const validated = localActivitySchema.parse(record);
    const db = await this.getDb();
    await db.put('activities', validated);
    return validated;
  }

  public async getActivity(activityId: string): Promise<LocalActivityRecord | undefined> {
    const db = await this.getDb();
    return db.get('activities', activityId);
  }

  public async deleteActivity(activityId: string): Promise<void> {
    const db = await this.getDb();
    await db.delete('activities', activityId);
  }

  public async deleteActivitySession(sessionId: string): Promise<number> {
    const db = await this.getDb();
    const tx = db.transaction('activities', 'readwrite');
    const keys = await tx.objectStore('activities').index('by-session').getAllKeys(sessionId);
    for (const key of keys) {
      await tx.objectStore('activities').delete(key);
    }
    await tx.done;
    return keys.length;
  }

  public async clearActivities(): Promise<void> {
    const db = await this.getDb();
    await db.clear('activities');
  }

  public async pruneActivities(options?: {
    retentionDays?: number;
    maxEntries?: number;
    nowMs?: number;
  }): Promise<number> {
    const retentionDays = options?.retentionDays ?? DEFAULT_ACTIVITY_RETENTION_DAYS;
    const maxEntries = options?.maxEntries ?? DEFAULT_ACTIVITY_MAX_ENTRIES;
    const nowMs = options?.nowMs ?? Date.now();
    const cutoffIso = new Date(nowMs - retentionDays * 24 * 60 * 60 * 1000).toISOString();

    const db = await this.getDb();
    const tx = db.transaction('activities', 'readwrite');
    const store = tx.objectStore('activities');
    const all = await store.index('by-startedAt').getAll();
    let deleted = 0;

    const kept: LocalActivityRecord[] = [];
    for (const row of all) {
      if (row.startedAt < cutoffIso) {
        await store.delete(row.id);
        deleted += 1;
      } else {
        kept.push(row);
      }
    }

    if (kept.length > maxEntries) {
      const overflow = kept.length - maxEntries;
      for (let i = 0; i < overflow; i += 1) {
        const oldest = kept[i];
        if (oldest) {
          await store.delete(oldest.id);
          deleted += 1;
        }
      }
    }

    await tx.done;
    return deleted;
  }

  public async queryActivities(filter: ActivityQueryFilter = {}): Promise<ActivityQueryResult> {
    const db = await this.getDb();
    const tx = db.transaction(['activities', 'artifacts', 'captures'], 'readonly');
    const actStore = tx.objectStore('activities');

    let candidates: LocalActivityRecord[];
    if (filter.origin) {
      candidates = await actStore.index('by-origin').getAll(filter.origin);
    } else if (filter.tool) {
      candidates = await actStore.index('by-tool').getAll(filter.tool);
    } else if (filter.status) {
      candidates = await actStore.index('by-status').getAll(filter.status);
    } else {
      candidates = await actStore.index('by-startedAt').getAll();
    }

    const domainSet = new Set<string>();
    for (const row of candidates) {
      if (row.sourceDomain) {
        domainSet.add(row.sourceDomain);
      }
    }
    if (filter.origin || filter.tool || filter.status) {
      const allForDomains = await actStore.getAll();
      for (const row of allForDomains) {
        if (row.sourceDomain) {
          domainSet.add(row.sourceDomain);
        }
      }
    }

    const searchLower = filter.search?.trim().toLowerCase() ?? '';
    const filtered = candidates.filter((row) => {
      if (filter.origin && row.sourceOrigin !== filter.origin) return false;
      if (filter.domain && row.sourceDomain !== filter.domain) return false;
      if (filter.tool && row.tool !== filter.tool) return false;
      if (filter.status && row.status !== filter.status) return false;
      if (filter.fromIso && row.startedAt < filter.fromIso) return false;
      if (filter.toIso && row.startedAt > filter.toIso) return false;
      if (searchLower) {
        const hay =
          `${row.pageTitle} ${row.sourceUrl} ${row.tool} ${row.actionLabel} ${row.resultSummary}`.toLowerCase();
        if (!hay.includes(searchLower)) return false;
      }
      return true;
    });

    filtered.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    const limit = Math.max(1, Math.min(100, filter.limit ?? 25));
    const offset = Math.max(0, filter.offset ?? 0);
    const pageRows = filtered.slice(offset, offset + limit);

    const artStore = tx.objectStore('artifacts');
    const capStore = tx.objectStore('captures');
    const items: ActivityQueryItem[] = [];
    for (const row of pageRows) {
      let linkedResourceStatus: 'present' | 'removed' | 'none' = 'none';
      if (row.linkedArtifactId) {
        const exists = await artStore.getKey(row.linkedArtifactId);
        linkedResourceStatus = exists ? 'present' : 'removed';
      } else if (row.linkedCaptureId) {
        const exists = await capStore.getKey(row.linkedCaptureId);
        linkedResourceStatus = exists ? 'present' : 'removed';
      }
      items.push({ ...row, linkedResourceStatus });
    }

    await tx.done;
    return {
      items,
      totalMatching: filtered.length,
      hasMore: offset + pageRows.length < filtered.length,
      domains: Array.from(domainSet).sort(),
    };
  }

  public async StartToolJob(params: {
    id: string;
    tool: ToolId;
    tabId: number;
    documentId: string;
  }): Promise<LocalJobRecord> {
    const nowIso = new Date().toISOString();
    return this.upsertJob({
      id: params.id,
      tool: params.tool,
      tabId: params.tabId,
      documentId: params.documentId,
      status: 'running',
      progressPercent: 0,
      statusMessage: 'Started',
      startedAt: nowIso,
      updatedAt: nowIso,
    });
  }

  public async exportBackup(): Promise<LocalBackupBundle> {
    const db = await this.getDb();
    const tx = db.transaction(['projects', 'artifacts', 'captures', 'activities'], 'readonly');
    const [projects, artifacts, captures, activities] = await Promise.all([
      tx.objectStore('projects').getAll(),
      tx.objectStore('artifacts').getAll(),
      tx.objectStore('captures').getAll(),
      tx.objectStore('activities').getAll(),
    ]);
    await tx.done;

    return {
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      projects,
      artifacts,
      captures,
      activities,
    };
  }

  public async importBackup(rawBundle: unknown): Promise<{
    importedProjects: number;
    importedArtifacts: number;
    importedCaptures: number;
    importedActivities: number;
  }> {
    const validated = localBackupBundleSchema.parse(rawBundle);
    const projectIds = new Set(validated.projects.map((p) => p.id));

    for (const artifact of validated.artifacts) {
      if (!projectIds.has(artifact.projectId)) {
        throw new Error(
          `Backup bundle integrity failure: artifact ${artifact.id} references missing project ${artifact.projectId}`,
        );
      }
    }
    for (const capture of validated.captures) {
      if (!projectIds.has(capture.projectId)) {
        throw new Error(
          `Backup bundle integrity failure: capture ${capture.id} references missing project ${capture.projectId}`,
        );
      }
    }

    const totalBundleBytes = measureRecordBytes(validated);
    await this.ensureQuotaAvailable(totalBundleBytes);

    const db = await this.getDb();
    const tx = db.transaction(['projects', 'artifacts', 'captures', 'activities'], 'readwrite');
    for (const project of validated.projects) {
      await tx.objectStore('projects').put(project);
    }
    for (const artifact of validated.artifacts) {
      await tx.objectStore('artifacts').put(artifact);
    }
    for (const capture of validated.captures) {
      await tx.objectStore('captures').put(capture);
    }
    for (const activity of validated.activities) {
      await tx.objectStore('activities').put(activity);
    }
    await tx.done;

    return {
      importedProjects: validated.projects.length,
      importedArtifacts: validated.artifacts.length,
      importedCaptures: validated.captures.length,
      importedActivities: validated.activities.length,
    };
  }

  public async clearAll(): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(
      ['projects', 'artifacts', 'captures', 'jobs', 'activities', 'motion_media'],
      'readwrite',
    );
    await Promise.all([
      tx.objectStore('projects').clear(),
      tx.objectStore('artifacts').clear(),
      tx.objectStore('captures').clear(),
      tx.objectStore('jobs').clear(),
      tx.objectStore('activities').clear(),
      tx.objectStore('motion_media').clear(),
    ]);
    await tx.done;
  }
}
