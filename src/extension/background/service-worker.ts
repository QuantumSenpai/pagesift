import {
  buildAllowlistedNvidiaContext,
  buildNvidiaEgressPreview,
  invokeNvidiaChatCompletion,
  type NvidiaSupportedSourceTool,
  type NvidiaTaskType,
} from '../ai/nvidia-client.js';
import { createCachedBatchFetcher, prefetchAssetsBatch } from '../engines/asset-fetcher.js';
import { buildAssetsZipArchive, type AssetExtractionReport } from '../engines/assets-engine.js';
import {
  composeCaptureFromTiles,
  encodeBytesToBase64,
  MIN_CAPTURE_INTERVAL_MS,
  verifyCaptureBinaryAndDimensions,
  type CaptureAnnotation,
  type CaptureExportMime,
  type CaptureMode,
  type CapturePlan,
  type CaptureRect,
  type CaptureTile,
} from '../engines/capture-engine.js';
import {
  finalizeStaticPageClone,
  type ClonePagePreparedPayload,
} from '../engines/clone-page-engine.js';
import {
  createResponsiveInspectionPlan,
  ResponsiveScrollSynchronizer,
  type ManagedResponsiveWindowRecord,
  type ResponsiveSessionState,
  type ResponsiveViewportPreset,
} from '../engines/responsive-engine.js';
import {
  createErrorResponse,
  createSuccessResponse,
  validateMessageEnvelope,
  validateSenderAuthorization,
  type ExtensionMessageResponse,
  type RuntimeMessageEnvelope,
  type SenderContextInfo,
} from '../protocol/messages.js';
import {
  LocalExtensionStorage,
  QuotaExceededStorageError,
  type LocalArtifactKind,
  type LocalJobRecord,
} from '../storage/idb-storage.js';
import {
  ExtensionSettingsStore,
  InMemoryKeyValueArea,
  type KeyValueArea,
} from '../storage/settings-storage.js';

export interface TargetTabInfo {
  id: number;
  windowId: number;
  url: string;
  title?: string;
  active: boolean;
  status?: string;
}

export interface OpenedResponsiveWindow {
  windowId: number;
  tabId: number;
}

export interface BackgroundEnvironmentAdapters {
  extensionId: string;
  storage: LocalExtensionStorage;
  settingsStore: ExtensionSettingsStore;
  sessionStateArea?: KeyValueArea;
  sendToTab?: (tabId: number, message: RuntimeMessageEnvelope) => Promise<ExtensionMessageResponse>;
  getTabInfo?: (tabId: number) => Promise<TargetTabInfo | null>;
  activateTabAndWindow?: (tabId: number, windowId: number) => Promise<void>;
  captureVisibleTab?: (windowId: number | undefined, format: 'png' | 'jpeg') => Promise<string>;
  openResponsiveWindow?: (
    url: string,
    width: number,
    height: number,
  ) => Promise<OpenedResponsiveWindow | null>;
  updateResponsiveWindow?: (windowId: number, width: number, height: number) => Promise<void>;
  closeResponsiveWindow?: (windowId: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  captureMinIntervalMs?: number;
  composeCaptureImpl?: typeof composeCaptureFromTiles;
}

const RESPONSIVE_SESSION_KEY = 'pagesift_responsive_session_v1';

interface CachedNvidiaPreview {
  payloadDigest: string;
  taskType: NvidiaTaskType;
  modelId: string;
  sanitizedContext: Record<string, unknown>;
  createdAtMs: number;
}

function isHttpOrHttpsUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function assertNotAborted(signal: AbortSignal, message: string): void {
  if (signal.aborted) {
    throw new Error(message);
  }
}

export class BackgroundCoordinator {
  private readonly env: BackgroundEnvironmentAdapters;
  private readonly scrollSync = new ResponsiveScrollSynchronizer(180);
  private readonly activeJobControllers = new Map<string, AbortController>();
  private readonly activeJobTabs = new Map<string, number>();
  private readonly previewCache = new Map<string, CachedNvidiaPreview>();
  private responsiveSession: ResponsiveSessionState | null = null;
  private lastCaptureTimestampMs = 0;

  public constructor(env: BackgroundEnvironmentAdapters) {
    this.env = env;
  }

  public async initialize(): Promise<{ recoveredJobsCount: number }> {
    const recoveredJobsCount = await this.env.storage.recoverInterruptedJobs();
    await this.restoreResponsiveSession();
    return { recoveredJobsCount };
  }

  private async persistResponsiveSession(): Promise<void> {
    if (!this.env.sessionStateArea) {
      return;
    }
    if (this.responsiveSession) {
      await this.env.sessionStateArea.set({ [RESPONSIVE_SESSION_KEY]: this.responsiveSession });
    } else {
      await this.env.sessionStateArea.remove(RESPONSIVE_SESSION_KEY);
    }
  }

  private async restoreResponsiveSession(): Promise<void> {
    if (!this.env.sessionStateArea) {
      return;
    }
    const raw = await this.env.sessionStateArea.get(RESPONSIVE_SESSION_KEY);
    const saved = raw[RESPONSIVE_SESSION_KEY] as ResponsiveSessionState | undefined;
    if (saved && Array.isArray(saved.windows)) {
      this.responsiveSession = saved;
      this.scrollSync.clearAllManagedTabs();
      this.scrollSync.setEnabled(saved.syncEnabled);
      this.scrollSync.registerManagedTabs(saved.windows.map((w) => w.tabId));
    }
  }

  public async handleManagedTabRemoved(tabId: number): Promise<void> {
    if (!this.responsiveSession) {
      await this.restoreResponsiveSession();
    }
    this.scrollSync.unregisterTab(tabId);
    if (!this.responsiveSession) {
      return;
    }
    const before = this.responsiveSession.windows.length;
    this.responsiveSession.windows = this.responsiveSession.windows.filter(
      (w) => w.tabId !== tabId,
    );
    if (this.responsiveSession.windows.length === 0) {
      this.responsiveSession = null;
    }
    if (before !== (this.responsiveSession?.windows.length ?? 0)) {
      await this.persistResponsiveSession();
    }
  }

  public async handleManagedWindowRemoved(windowId: number): Promise<void> {
    if (!this.responsiveSession) {
      await this.restoreResponsiveSession();
    }
    if (!this.responsiveSession) {
      return;
    }
    const removed = this.responsiveSession.windows.filter((w) => w.windowId === windowId);
    if (removed.length === 0) {
      return;
    }
    for (const item of removed) {
      this.scrollSync.unregisterTab(item.tabId);
    }
    this.responsiveSession.windows = this.responsiveSession.windows.filter(
      (w) => w.windowId !== windowId,
    );
    if (this.responsiveSession.windows.length === 0) {
      this.responsiveSession = null;
    }
    await this.persistResponsiveSession();
  }

  public async handleManagedTabUpdated(tabId: number, status?: string): Promise<void> {
    if (status !== 'complete') {
      return;
    }
    if (!this.responsiveSession) {
      await this.restoreResponsiveSession();
    }
    if (!this.responsiveSession) {
      return;
    }
    const isManaged = this.responsiveSession.windows.some((w) => w.tabId === tabId);
    if (isManaged && this.env.sendToTab) {
      await this.env
        .sendToTab(tabId, {
          schemaVersion: 1,
          requestId: `sync-rebind-${Date.now()}`,
          operation: 'SET_RESPONSIVE_SYNC',
          tabId,
          payload: { enabled: this.responsiveSession.syncEnabled },
        })
        .catch(() => undefined);
    }
  }

  private async updateJob(
    job: LocalJobRecord,
    updates: Partial<Pick<LocalJobRecord, 'status' | 'progressPercent' | 'statusMessage'>>,
  ): Promise<LocalJobRecord> {
    const next: LocalJobRecord = {
      ...job,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    return this.env.storage.upsertJob(next);
  }

  private async verifyTargetTabForCapture(
    tabId: number,
    expectedUrlPrefix?: string,
  ): Promise<TargetTabInfo> {
    if (!this.env.getTabInfo) {
      return {
        id: tabId,
        windowId: 0,
        url: expectedUrlPrefix ?? 'https://localhost/',
        active: true,
      };
    }

    const tab = await this.env.getTabInfo(tabId);
    if (!tab) {
      throw new Error(`Target tab ${tabId} was closed or is no longer available`);
    }
    if (!isHttpOrHttpsUrl(tab.url)) {
      throw new Error(
        `Cannot capture restricted or non-web page (${tab.url || 'unknown URL'}). Switch to an http:// or https:// page.`,
      );
    }
    if (expectedUrlPrefix && tab.url !== expectedUrlPrefix) {
      throw new Error('Target tab navigated away during capture; capture aborted safely');
    }
    if (!tab.active && this.env.activateTabAndWindow) {
      await this.env.activateTabAndWindow(tab.id, tab.windowId);
      await new Promise((r) => setTimeout(r, 120));
      const rechecked = await this.env.getTabInfo(tabId);
      if (!rechecked || !rechecked.active) {
        throw new Error(
          'Target tab could not be focused before screenshot capture; refusing to capture a different tab',
        );
      }
      if (expectedUrlPrefix && rechecked.url !== expectedUrlPrefix) {
        throw new Error('Target tab navigated during activation; capture aborted');
      }
      return rechecked;
    }
    if (!tab.active) {
      throw new Error(
        'Target tab is not active and cannot be activated; refusing to capture an unrelated tab',
      );
    }
    return tab;
  }

  private async waitForResponsiveTabMetrics(
    tabId: number,
    timeoutMs = 5000,
  ): Promise<{
    innerWidth: number;
    innerHeight: number;
    outerWidth: number;
    outerHeight: number;
  } | null> {
    if (!this.env.sendToTab) {
      return null;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await this.env.sendToTab(tabId, {
          schemaVersion: 1,
          requestId: `vp-metrics-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          operation: 'GET_VIEWPORT_METRICS',
          tabId,
          payload: {},
        });
        if (res.ok) {
          const d = res.data as {
            innerWidth?: number;
            innerHeight?: number;
            outerWidth?: number;
            outerHeight?: number;
          };
          if (typeof d.innerWidth === 'number' && d.innerWidth > 0) {
            return {
              innerWidth: d.innerWidth,
              innerHeight: d.innerHeight ?? 0,
              outerWidth: d.outerWidth ?? d.innerWidth,
              outerHeight: d.outerHeight ?? d.innerHeight ?? 0,
            };
          }
        }
      } catch {
        await new Promise((r) => setTimeout(r, 120));
        continue;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    return null;
  }

  public async handleRuntimeMessage(
    rawMessage: unknown,
    sender: SenderContextInfo,
  ): Promise<ExtensionMessageResponse> {
    const envelopeResult = validateMessageEnvelope(rawMessage);
    if (!envelopeResult.valid) {
      return envelopeResult.response;
    }

    const msg = envelopeResult.message;
    const senderAuth = validateSenderAuthorization(sender, this.env.extensionId, msg.operation);

    if (!senderAuth.allowed) {
      return createErrorResponse(
        msg.requestId,
        'UNAUTHORIZED_SENDER',
        senderAuth.reason ?? 'Sender is not authorized for this operation',
        msg.operation,
      );
    }

    try {
      switch (msg.operation) {
        case 'GET_SETTINGS': {
          const settings = await this.env.settingsStore.getSettings();
          return createSuccessResponse(msg, { settings });
        }

        case 'UPDATE_SETTINGS': {
          const settings = await this.env.settingsStore.updateSettings(msg.payload['settings']);
          return createSuccessResponse(msg, { settings });
        }

        case 'SET_NVIDIA_API_KEY': {
          const apiKey = typeof msg.payload['apiKey'] === 'string' ? msg.payload['apiKey'] : '';
          await this.env.settingsStore.setSessionNvidiaApiKey(apiKey);
          const status = await this.env.settingsStore.getNvidiaKeyStatus();
          return createSuccessResponse(msg, { status });
        }

        case 'CLEAR_NVIDIA_API_KEY': {
          await this.env.settingsStore.clearSessionNvidiaApiKey();
          const status = await this.env.settingsStore.getNvidiaKeyStatus();
          return createSuccessResponse(msg, { status });
        }

        case 'GET_NVIDIA_KEY_STATUS': {
          const status = await this.env.settingsStore.getNvidiaKeyStatus();
          return createSuccessResponse(msg, { status });
        }

        case 'RUN_NVIDIA_ENHANCEMENT': {
          const settings = await this.env.settingsStore.getSettings();
          const modelId =
            typeof msg.payload['modelId'] === 'string' && msg.payload['modelId'].trim().length > 0
              ? msg.payload['modelId'].trim()
              : settings.nvidiaModelId;
          const taskType = msg.payload['taskType'] as NvidiaTaskType;
          const sourceTool = msg.payload['sourceTool'] as NvidiaSupportedSourceTool;
          const toolOutput =
            typeof msg.payload['toolOutput'] === 'object' && msg.payload['toolOutput'] !== null
              ? (msg.payload['toolOutput'] as Record<string, unknown>)
              : {};

          const rebuiltContext = buildAllowlistedNvidiaContext({
            taskType,
            sourceTool,
            toolOutput,
          });

          const egressPreview = buildNvidiaEgressPreview({
            modelId,
            endpoint: settings.nvidiaEndpoint,
            taskType,
            sanitizedContext: rebuiltContext,
          });

          if (msg.payload['previewOnly'] === true) {
            this.previewCache.set(egressPreview.payloadDigest, {
              payloadDigest: egressPreview.payloadDigest,
              taskType,
              modelId,
              sanitizedContext: rebuiltContext,
              createdAtMs: Date.now(),
            });
            if (this.previewCache.size > 20) {
              const oldestKey = this.previewCache.keys().next().value;
              if (oldestKey) {
                this.previewCache.delete(oldestKey);
              }
            }
            return createSuccessResponse(msg, {
              egressPreview,
              payloadDigest: egressPreview.payloadDigest,
            });
          }

          const confirmedDigest = msg.payload['confirmedPayloadDigest'];
          if (
            typeof confirmedDigest !== 'string' ||
            confirmedDigest !== egressPreview.payloadDigest
          ) {
            return createErrorResponse(
              msg.requestId,
              'AI_CONFIGURATION_ERROR',
              'Data egress preview must be reviewed and confirmed for the current payload before sending to NVIDIA AI',
              msg.operation,
            );
          }

          const cached = this.previewCache.get(confirmedDigest);
          if (!cached || cached.taskType !== taskType || cached.modelId !== modelId) {
            return createErrorResponse(
              msg.requestId,
              'AI_CONFIGURATION_ERROR',
              'Preview confirmation expired or does not match the current task/model. Click Preview NVIDIA Data Egress again.',
              msg.operation,
            );
          }

          const apiKey = await this.env.settingsStore.getSessionNvidiaApiKey();
          if (!apiKey) {
            return createErrorResponse(
              msg.requestId,
              'AI_CONFIGURATION_ERROR',
              'No NVIDIA API key is set in session storage. Configure your key in Options first.',
              msg.operation,
            );
          }

          const abortCtrl = new AbortController();
          this.activeJobControllers.set(msg.requestId, abortCtrl);
          try {
            const completion = await invokeNvidiaChatCompletion({
              apiKey,
              modelId,
              endpoint: settings.nvidiaEndpoint,
              taskType,
              sanitizedContext: cached.sanitizedContext,
              signal: abortCtrl.signal,
              ...(this.env.fetchImpl ? { fetchImpl: this.env.fetchImpl } : {}),
            });
            return createSuccessResponse(msg, { completion });
          } finally {
            this.activeJobControllers.delete(msg.requestId);
          }
        }

        case 'CANCEL_JOB': {
          const targetJobId =
            typeof msg.payload['jobId'] === 'string' ? msg.payload['jobId'] : msg.requestId;
          const ctrl = this.activeJobControllers.get(targetJobId);
          if (ctrl) {
            ctrl.abort();
            this.activeJobControllers.delete(targetJobId);
          }
          const boundTabId = this.activeJobTabs.get(targetJobId) ?? msg.tabId;
          if (typeof boundTabId === 'number' && this.env.sendToTab) {
            await this.env
              .sendToTab(boundTabId, {
                schemaVersion: 1,
                requestId: `cancel-${Date.now()}`,
                operation: 'CANCEL_JOB',
                tabId: boundTabId,
                payload: { jobId: targetJobId },
              })
              .catch(() => undefined);
          }
          const existingJob = await this.env.storage.getJob(targetJobId);
          if (existingJob && existingJob.status === 'running') {
            await this.updateJob(existingJob, {
              status: 'cancelled',
              statusMessage: 'Cancelled by user',
            });
          }
          return createSuccessResponse(msg, { cancelled: true, jobId: targetJobId });
        }

        case 'GET_JOB_STATUS': {
          const jobId = String(msg.payload['jobId']);
          const job = await this.env.storage.getJob(jobId);
          return createSuccessResponse(msg, { job: job ?? null });
        }

        case 'LIST_JOBS': {
          const db = await this.env.storage.getDb();
          const jobs = await db.getAll('jobs');
          jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          return createSuccessResponse(msg, { jobs: jobs.slice(0, 50) });
        }

        case 'LIST_PROJECTS_FROM_IDB': {
          let projects = await this.env.storage.listProjects();
          if (projects.length === 0) {
            const nowIso = new Date().toISOString();
            const defaultProj = await this.env.storage.saveProject({
              id: 'proj-default',
              name: 'Default Workspace',
              description: 'Local PageSift captures and artifacts',
              sourceDomain: null,
              createdAt: nowIso,
              updatedAt: nowIso,
            });
            projects = [defaultProj];
          }
          const projectId =
            typeof msg.payload['projectId'] === 'string'
              ? msg.payload['projectId']
              : (projects[0]?.id ?? 'proj-default');
          const artifacts = await this.env.storage.listArtifacts(projectId);
          const captures = await this.env.storage.listCaptures(projectId);
          return createSuccessResponse(msg, { projects, artifacts, captures });
        }

        case 'SAVE_ARTIFACT_TO_IDB': {
          const nowIso = new Date().toISOString();
          let projectId =
            typeof msg.payload['projectId'] === 'string'
              ? msg.payload['projectId']
              : 'proj-default';
          const existingProject = await this.env.storage.getProject(projectId);
          if (!existingProject) {
            const projectName =
              typeof msg.payload['projectName'] === 'string'
                ? msg.payload['projectName']
                : 'Default Workspace';
            await this.env.storage.saveProject({
              id: projectId,
              name: projectName,
              description: 'Local PageSift project',
              sourceDomain: null,
              createdAt: nowIso,
              updatedAt: nowIso,
            });
          } else if (typeof msg.payload['createNewProjectName'] === 'string') {
            projectId = `proj-${Date.now()}`;
            await this.env.storage.saveProject({
              id: projectId,
              name: msg.payload['createNewProjectName'],
              description: 'Created from PageSift Workspace',
              sourceDomain: null,
              createdAt: nowIso,
              updatedAt: nowIso,
            });
          }

          const kind = (msg.payload['kind'] as LocalArtifactKind | undefined) ?? 'inspect_report';
          const title =
            typeof msg.payload['title'] === 'string' ? msg.payload['title'] : `${kind} artifact`;
          const sourceUrl =
            typeof msg.payload['sourceUrl'] === 'string' ? msg.payload['sourceUrl'] : null;
          const artifactPayload =
            typeof msg.payload['artifactPayload'] === 'object' &&
            msg.payload['artifactPayload'] !== null
              ? (msg.payload['artifactPayload'] as Record<string, unknown>)
              : {};

          const saved = await this.env.storage.saveArtifact({
            id: `art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            projectId,
            kind,
            title,
            sourceUrl,
            schemaVersion: 1,
            payload: artifactPayload,
            createdAt: nowIso,
            updatedAt: nowIso,
          });
          return createSuccessResponse(msg, { artifact: saved });
        }

        case 'SAVE_CAPTURE_TO_IDB': {
          const nowIso = new Date().toISOString();
          const projectId =
            typeof msg.payload['projectId'] === 'string'
              ? msg.payload['projectId']
              : 'proj-default';
          const existingProject = await this.env.storage.getProject(projectId);
          if (!existingProject) {
            await this.env.storage.saveProject({
              id: projectId,
              name: 'Default Workspace',
              description: 'Local PageSift project',
              sourceDomain: null,
              createdAt: nowIso,
              updatedAt: nowIso,
            });
          }
          const dataUrl = typeof msg.payload['dataUrl'] === 'string' ? msg.payload['dataUrl'] : '';
          const verified = verifyCaptureBinaryAndDimensions(dataUrl);
          const saved = await this.env.storage.saveCapture({
            id: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            projectId,
            pageUrl:
              typeof msg.payload['pageUrl'] === 'string'
                ? msg.payload['pageUrl']
                : 'https://localhost/',
            pageTitle:
              typeof msg.payload['pageTitle'] === 'string'
                ? msg.payload['pageTitle']
                : 'PageSift Capture',
            mode: (msg.payload['mode'] as CaptureMode | undefined) ?? 'visible',
            mimeType: verified.mimeType,
            width: verified.width,
            height: verified.height,
            byteLength: verified.byteLength,
            dataUrl,
            annotations: Array.isArray(msg.payload['annotations'])
              ? (msg.payload['annotations'] as CaptureAnnotation[])
              : [],
            createdAt: nowIso,
          });
          return createSuccessResponse(msg, { capture: saved });
        }

        case 'GET_STORAGE_USAGE': {
          const usage = await this.env.storage.getStorageUsage();
          return createSuccessResponse(msg, { usage });
        }

        case 'EXPORT_DB_BACKUP': {
          const backup = await this.env.storage.exportBackup();
          return createSuccessResponse(msg, { backup });
        }

        case 'IMPORT_DB_BACKUP': {
          const result = await this.env.storage.importBackup(msg.payload['backup']);
          return createSuccessResponse(msg, { result });
        }

        case 'CLEAR_ALL_LOCAL_DATA': {
          await this.env.storage.clearAll();
          return createSuccessResponse(msg, { cleared: true });
        }

        case 'RUN_ASSETS_EXTRACT': {
          if (typeof msg.tabId !== 'number' || !this.env.sendToTab) {
            return createErrorResponse(
              msg.requestId,
              'INVALID_MESSAGE',
              'RUN_ASSETS_EXTRACT requires an active target tabId',
              msg.operation,
            );
          }
          const includeZip = msg.payload['includeZip'] === true;
          const abortCtrl = new AbortController();
          this.activeJobControllers.set(msg.requestId, abortCtrl);
          this.activeJobTabs.set(msg.requestId, msg.tabId);
          let job = await this.env.storage.StartToolJob({
            id: msg.requestId,
            tool: 'assets',
            tabId: msg.tabId,
            documentId: msg.documentId ?? 'unbound',
          });

          try {
            const discoverRes = await this.env.sendToTab(msg.tabId, {
              ...msg,
              payload: { includeZip: false },
            });
            if (!discoverRes.ok) {
              await this.updateJob(job, {
                status: 'failed',
                statusMessage: discoverRes.error.message,
              });
              return discoverRes;
            }

            const { report } = discoverRes.data as { report: AssetExtractionReport };
            if (!includeZip) {
              await this.updateJob(job, {
                status: 'completed',
                progressPercent: 100,
                statusMessage: `Discovered ${report.summary.totalDiscovered} assets`,
              });
              return createSuccessResponse(
                msg,
                { report, zipBase64: null, packagedFilesCount: 0, skippedOrUnavailable: [] },
                discoverRes.documentId,
              );
            }

            const httpUrls = report.assets
              .filter((a) => a.availabilityStatus === 'http_reference')
              .map((a) => a.url);

            job = await this.updateJob(job, {
              progressPercent: 30,
              statusMessage: `Fetching ${httpUrls.length} external assets`,
            });

            const prefetched = await prefetchAssetsBatch(httpUrls, {
              signal: abortCtrl.signal,
              ...(this.env.fetchImpl ? { fetchImpl: this.env.fetchImpl } : {}),
            });
            if (abortCtrl.signal.aborted) {
              throw new Error('Asset archive export cancelled by user');
            }

            const zipRes = await buildAssetsZipArchive(
              report,
              createCachedBatchFetcher(prefetched),
              { signal: abortCtrl.signal },
            );

            await this.updateJob(job, {
              status: 'completed',
              progressPercent: 100,
              statusMessage: `Packaged ${zipRes.packagedFilesCount} files into assets ZIP`,
            });

            return createSuccessResponse(
              msg,
              {
                report,
                zipBase64: encodeBytesToBase64(zipRes.zipBytes),
                zipSizeBytes: zipRes.zipBytes.byteLength,
                packagedFilesCount: zipRes.packagedFilesCount,
                packagedAssets: zipRes.packagedAssets,
                skippedOrUnavailable: zipRes.skippedOrUnavailable,
                jobId: job.id,
              },
              discoverRes.documentId,
            );
          } catch (err: unknown) {
            const cancelled = abortCtrl.signal.aborted;
            const errMsg = err instanceof Error ? err.message : 'Assets extraction failed';
            await this.updateJob(job, {
              status: cancelled ? 'cancelled' : 'failed',
              statusMessage: errMsg,
            });
            return createErrorResponse(
              msg.requestId,
              cancelled ? 'JOB_CANCELLED' : 'TOOL_EXECUTION_ERROR',
              errMsg,
              msg.operation,
            );
          } finally {
            this.activeJobControllers.delete(msg.requestId);
            this.activeJobTabs.delete(msg.requestId);
          }
        }

        case 'RUN_CLONE_PAGE': {
          if (typeof msg.tabId !== 'number' || !this.env.sendToTab) {
            return createErrorResponse(
              msg.requestId,
              'INVALID_MESSAGE',
              'RUN_CLONE_PAGE requires an active target tabId',
              msg.operation,
            );
          }
          const abortCtrl = new AbortController();
          this.activeJobControllers.set(msg.requestId, abortCtrl);
          this.activeJobTabs.set(msg.requestId, msg.tabId);
          let job = await this.env.storage.StartToolJob({
            id: msg.requestId,
            tool: 'clone_page',
            tabId: msg.tabId,
            documentId: msg.documentId ?? 'unbound',
          });

          try {
            const prepareRes = await this.env.sendToTab(msg.tabId, {
              ...msg,
              payload: { prepareOnly: true },
            });
            if (!prepareRes.ok) {
              await this.updateJob(job, {
                status: 'failed',
                statusMessage: prepareRes.error.message,
              });
              return prepareRes;
            }

            const { prepared } = prepareRes.data as { prepared: ClonePagePreparedPayload };
            const urls = prepared.candidateAssetUrls.map((c) => c.url);
            job = await this.updateJob(job, {
              progressPercent: 45,
              statusMessage: `Downloading ${urls.length} snapshot assets`,
            });

            const prefetched = await prefetchAssetsBatch(urls, {
              signal: abortCtrl.signal,
              ...(this.env.fetchImpl ? { fetchImpl: this.env.fetchImpl } : {}),
            });
            if (abortCtrl.signal.aborted) {
              throw new Error('Clone page snapshot cancelled by user');
            }

            const snapshot = await finalizeStaticPageClone(prepared, {
              fetcher: createCachedBatchFetcher(prefetched),
              signal: abortCtrl.signal,
            });

            await this.updateJob(job, {
              status: 'completed',
              progressPercent: 100,
              statusMessage: `Snapshot packaged (${snapshot.manifest.rewrittenAssets.length} bundled assets)`,
            });

            return createSuccessResponse(
              msg,
              {
                manifest: snapshot.manifest,
                htmlPreview: snapshot.htmlContent.slice(0, 4000),
                cssPreview: snapshot.cssContent.slice(0, 4000),
                zipBase64: encodeBytesToBase64(snapshot.zipBytes),
                zipSizeBytes: snapshot.zipBytes.byteLength,
                jobId: job.id,
              },
              prepareRes.documentId,
            );
          } catch (err: unknown) {
            const cancelled = abortCtrl.signal.aborted;
            const errMsg = err instanceof Error ? err.message : 'Clone page failed';
            await this.updateJob(job, {
              status: cancelled ? 'cancelled' : 'failed',
              statusMessage: errMsg,
            });
            return createErrorResponse(
              msg.requestId,
              cancelled ? 'JOB_CANCELLED' : 'TOOL_EXECUTION_ERROR',
              errMsg,
              msg.operation,
            );
          } finally {
            this.activeJobControllers.delete(msg.requestId);
            this.activeJobTabs.delete(msg.requestId);
          }
        }

        case 'RUN_RESPONSIVE_INSPECT': {
          const targetUrl =
            typeof msg.payload['targetUrl'] === 'string' ? msg.payload['targetUrl'] : '';
          const customViewports = msg.payload['customViewports'] as
            | ResponsiveViewportPreset[]
            | undefined;
          const plan = createResponsiveInspectionPlan(targetUrl, customViewports);
          const openWindows = msg.payload['openWindows'] !== false;
          const syncEnabled = msg.payload['syncEnabled'] !== false;
          const managedWindows: ManagedResponsiveWindowRecord[] = [];
          const openedTabIds: number[] = [];

          if (openWindows && this.env.openResponsiveWindow) {
            if (this.responsiveSession) {
              await this.closeActiveResponsiveSession();
            }

            for (const vp of plan.viewports) {
              const opened = await this.env.openResponsiveWindow(
                plan.targetUrl,
                vp.width,
                vp.height,
              );
              if (!opened) {
                continue;
              }
              openedTabIds.push(opened.tabId);
              let actualInnerWidth: number | null = null;
              let actualInnerHeight: number | null = null;
              let chromeDeltaWidth: number | null = null;
              let chromeDeltaHeight: number | null = null;

              const initialMetrics = await this.waitForResponsiveTabMetrics(opened.tabId, 4500);
              if (initialMetrics) {
                actualInnerWidth = initialMetrics.innerWidth;
                actualInnerHeight = initialMetrics.innerHeight;
                chromeDeltaWidth = Math.max(
                  0,
                  initialMetrics.outerWidth - initialMetrics.innerWidth,
                );
                chromeDeltaHeight = Math.max(
                  0,
                  initialMetrics.outerHeight - initialMetrics.innerHeight,
                );

                if (
                  this.env.updateResponsiveWindow &&
                  (actualInnerWidth !== vp.width || actualInnerHeight !== vp.height)
                ) {
                  await this.env
                    .updateResponsiveWindow(
                      opened.windowId,
                      vp.width + chromeDeltaWidth,
                      vp.height + chromeDeltaHeight,
                    )
                    .catch(() => undefined);
                  await new Promise((r) => setTimeout(r, 120));
                  const afterMetrics = await this.waitForResponsiveTabMetrics(opened.tabId, 1500);
                  if (afterMetrics) {
                    actualInnerWidth = afterMetrics.innerWidth;
                    actualInnerHeight = afterMetrics.innerHeight;
                  }
                }
              }

              const sizeConstrainedByBrowser =
                actualInnerWidth !== null &&
                actualInnerHeight !== null &&
                (Math.abs(actualInnerWidth - vp.width) > 4 ||
                  Math.abs(actualInnerHeight - vp.height) > 4);

              managedWindows.push({
                presetId: vp.id,
                label: vp.label,
                windowId: opened.windowId,
                tabId: opened.tabId,
                requestedWidth: vp.width,
                requestedHeight: vp.height,
                actualInnerWidth,
                actualInnerHeight,
                chromeDeltaWidth,
                chromeDeltaHeight,
                sizeConstrainedByBrowser,
              });
            }

            this.scrollSync.clearAllManagedTabs();
            this.scrollSync.setEnabled(syncEnabled);
            this.scrollSync.registerManagedTabs(openedTabIds);

            this.responsiveSession = {
              sessionId: `resp-${Date.now()}`,
              targetUrl: plan.targetUrl,
              syncEnabled,
              windows: managedWindows,
              createdAt: new Date().toISOString(),
            };
            await this.persistResponsiveSession();

            const sendToTabFn = this.env.sendToTab;
            if (sendToTabFn) {
              await Promise.all(
                openedTabIds.map((tId) =>
                  sendToTabFn(tId, {
                    schemaVersion: 1,
                    requestId: `sync-init-${Date.now()}-${tId}`,
                    operation: 'SET_RESPONSIVE_SYNC',
                    tabId: tId,
                    payload: { enabled: syncEnabled },
                  }).catch(() => undefined),
                ),
              );
            }
          }

          return createSuccessResponse(msg, {
            plan,
            openedTabIds,
            session: this.responsiveSession,
          });
        }

        case 'SET_RESPONSIVE_SYNC': {
          if (!this.responsiveSession) {
            await this.restoreResponsiveSession();
          }
          const enabled = msg.payload['enabled'] === true;
          this.scrollSync.setEnabled(enabled);
          if (this.responsiveSession) {
            this.responsiveSession.syncEnabled = enabled;
            await this.persistResponsiveSession();
            const sendToTabFn = this.env.sendToTab;
            if (sendToTabFn) {
              await Promise.all(
                this.responsiveSession.windows.map((w) =>
                  sendToTabFn(w.tabId, {
                    schemaVersion: 1,
                    requestId: `sync-toggle-${Date.now()}-${w.tabId}`,
                    operation: 'SET_RESPONSIVE_SYNC',
                    tabId: w.tabId,
                    payload: { enabled },
                  }).catch(() => undefined),
                ),
              );
            }
          }
          return createSuccessResponse(msg, {
            syncEnabled: enabled,
            session: this.responsiveSession,
          });
        }

        case 'GET_RESPONSIVE_SESSION': {
          if (!this.responsiveSession) {
            await this.restoreResponsiveSession();
          }
          return createSuccessResponse(msg, { session: this.responsiveSession });
        }

        case 'CLOSE_RESPONSIVE_SESSION': {
          const closed = await this.closeActiveResponsiveSession();
          return createSuccessResponse(msg, closed);
        }

        case 'SYNC_SCROLL': {
          if (!this.responsiveSession) {
            await this.restoreResponsiveSession();
          }
          const sourceTabId = sender.tab?.id ?? msg.tabId ?? -1;
          const scrollXRatio =
            typeof msg.payload['scrollXRatio'] === 'number' ? msg.payload['scrollXRatio'] : 0;
          const scrollYRatio =
            typeof msg.payload['scrollYRatio'] === 'number' ? msg.payload['scrollYRatio'] : 0;

          const broadcast = this.scrollSync.computeBroadcastTargets({
            sourceTabId,
            scrollXRatio,
            scrollYRatio,
          });

          const sendToTabFn = this.env.sendToTab;
          if (broadcast.shouldBroadcast && sendToTabFn) {
            await Promise.all(
              broadcast.targetTabIds.map((targetTabId) =>
                sendToTabFn(targetTabId, {
                  schemaVersion: 1,
                  requestId: `sync-${Date.now()}-${targetTabId}`,
                  operation: 'SYNC_SCROLL',
                  tabId: targetTabId,
                  payload: {
                    scrollXRatio: broadcast.scrollXRatio,
                    scrollYRatio: broadcast.scrollYRatio,
                  },
                }).catch(() => undefined),
              ),
            );
          }
          return createSuccessResponse(msg, { broadcast });
        }

        case 'RUN_CAPTURE': {
          if (typeof msg.tabId !== 'number' || !this.env.sendToTab || !this.env.captureVisibleTab) {
            return createErrorResponse(
              msg.requestId,
              'TOOL_EXECUTION_ERROR',
              'Real screenshot capture requires a target tabId, content script channel, and chrome.tabs.captureVisibleTab',
              msg.operation,
            );
          }

          const tabId = msg.tabId;
          const mode = (msg.payload['mode'] as CaptureMode | undefined) ?? 'visible';
          const exportMime =
            (msg.payload['exportMime'] as CaptureExportMime | undefined) ?? 'image/png';
          const selector =
            typeof msg.payload['selector'] === 'string' ? msg.payload['selector'] : undefined;
          const rect = msg.payload['rect'] as CaptureRect | undefined;
          const cropRect = msg.payload['cropRect'] as CaptureRect | undefined;
          const annotations = msg.payload['annotations'] as CaptureAnnotation[] | undefined;
          const quality =
            typeof msg.payload['quality'] === 'number' ? msg.payload['quality'] : 0.92;
          const minIntervalMs = this.env.captureMinIntervalMs ?? MIN_CAPTURE_INTERVAL_MS;

          const abortCtrl = new AbortController();
          this.activeJobControllers.set(msg.requestId, abortCtrl);
          this.activeJobTabs.set(msg.requestId, tabId);

          let job = await this.env.storage.StartToolJob({
            id: msg.requestId,
            tool: 'capture',
            tabId,
            documentId: msg.documentId ?? 'unbound',
          });

          let preparedDom = false;
          try {
            const initialTab = await this.verifyTargetTabForCapture(tabId);
            const expectedTabUrl = initialTab.url;

            const prepareRes = await this.env.sendToTab(tabId, {
              schemaVersion: 1,
              requestId: `${msg.requestId}-prep`,
              operation: 'CAPTURE_PREPARE',
              tabId,
              ...(msg.documentId ? { documentId: msg.documentId } : {}),
              payload: {
                mode,
                ...(selector ? { selector } : {}),
                ...(rect ? { rect } : {}),
              },
            });
            if (!prepareRes.ok) {
              await this.updateJob(job, {
                status: 'failed',
                statusMessage: prepareRes.error.message,
              });
              return prepareRes;
            }
            preparedDom = true;

            const prepData = prepareRes.data as {
              plan: CapturePlan;
              pageTitle: string;
              pageUrl: string;
              viewportWidth: number;
              viewportHeight: number;
              devicePixelRatio: number;
              fixedElementsCount: number;
            };
            const boundDocumentId = prepareRes.documentId ?? msg.documentId;

            const tiles: CaptureTile[] = [];
            let nestedScrollDetected = false;

            for (let idx = 0; idx < prepData.plan.tiles.length; idx += 1) {
              const tileSpec = prepData.plan.tiles[idx];
              if (!tileSpec) {
                continue;
              }
              if (abortCtrl.signal.aborted) {
                throw new Error('Capture cancelled by user');
              }

              let actualScrollX = tileSpec.scrollX;
              let actualScrollY = tileSpec.scrollY;
              let viewportWidth = prepData.viewportWidth;
              let viewportHeight = prepData.viewportHeight;
              let devicePixelRatio = prepData.devicePixelRatio;

              if (prepData.plan.tiles.length > 1) {
                const scrollRes = await this.env.sendToTab(tabId, {
                  schemaVersion: 1,
                  requestId: `${msg.requestId}-tile-${idx}`,
                  operation: 'CAPTURE_SCROLL_TO',
                  tabId,
                  ...(boundDocumentId ? { documentId: boundDocumentId } : {}),
                  payload: {
                    tileIndex: tileSpec.tileIndex,
                    scrollX: tileSpec.scrollX,
                    scrollY: tileSpec.scrollY,
                    hideFixed: tileSpec.tileIndex > 0,
                    lazyWaitMs: 60,
                  },
                });
                if (!scrollRes.ok) {
                  throw new Error(scrollRes.error.message);
                }
                const scrollData = scrollRes.data as {
                  actualScrollX: number;
                  actualScrollY: number;
                  viewportWidth: number;
                  viewportHeight: number;
                  devicePixelRatio: number;
                };
                actualScrollX = scrollData.actualScrollX;
                actualScrollY = scrollData.actualScrollY;
                viewportWidth = scrollData.viewportWidth;
                viewportHeight = scrollData.viewportHeight;
                devicePixelRatio = scrollData.devicePixelRatio;

                const prevTile = tiles[tiles.length - 1];
                if (
                  tileSpec.tileIndex > 0 &&
                  prevTile &&
                  actualScrollY <= prevTile.actualScrollY &&
                  tileSpec.scrollY > prevTile.scrollY
                ) {
                  nestedScrollDetected = true;
                  break;
                }
              }

              const elapsed = Date.now() - this.lastCaptureTimestampMs;
              if (this.lastCaptureTimestampMs > 0 && elapsed < minIntervalMs) {
                await new Promise((r) => setTimeout(r, minIntervalMs - elapsed));
              }
              assertNotAborted(abortCtrl.signal, 'Capture cancelled by user');

              const verifiedTab = await this.verifyTargetTabForCapture(tabId, expectedTabUrl);
              let tileDataUrl: string;
              try {
                tileDataUrl = await this.env.captureVisibleTab(verifiedTab.windowId, 'png');
              } catch (capErr: unknown) {
                const capMsg = capErr instanceof Error ? capErr.message : '';
                if (!capMsg.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) {
                  throw capErr;
                }
                await new Promise((r) => setTimeout(r, Math.max(minIntervalMs, 600)));
                assertNotAborted(abortCtrl.signal, 'Capture cancelled by user');
                const retryTab = await this.verifyTargetTabForCapture(tabId, expectedTabUrl);
                tileDataUrl = await this.env.captureVisibleTab(retryTab.windowId, 'png');
              }
              this.lastCaptureTimestampMs = Date.now();

              tiles.push({
                tileIndex: tileSpec.tileIndex,
                scrollX: tileSpec.scrollX,
                scrollY: tileSpec.scrollY,
                actualScrollX,
                actualScrollY,
                viewportWidth,
                viewportHeight,
                devicePixelRatio,
                dataUrl: tileDataUrl,
              });

              const percent = Math.round(((idx + 1) / prepData.plan.tiles.length) * 80);
              job = await this.updateJob(job, {
                progressPercent: percent,
                statusMessage: `Captured tile ${idx + 1} of ${prepData.plan.tiles.length}`,
              });
            }

            const composeFn = this.env.composeCaptureImpl ?? composeCaptureFromTiles;
            const composed = await composeFn({
              tiles,
              plan: prepData.plan,
              exportMime,
              ...(cropRect ? { cropRect } : {}),
              ...(annotations ? { annotations } : {}),
              title:
                typeof msg.payload['title'] === 'string' && msg.payload['title'].trim().length > 0
                  ? msg.payload['title']
                  : prepData.pageTitle,
              pageUrl: prepData.pageUrl,
              quality,
            });

            const verified = verifyCaptureBinaryAndDimensions(composed.dataUrl);

            await this.updateJob(job, {
              status: 'completed',
              progressPercent: 100,
              statusMessage: `Captured ${verified.width}×${verified.height} (${verified.mimeType})`,
            });

            return createSuccessResponse(
              msg,
              {
                dataUrl: composed.dataUrl,
                ...(composed.previewPngDataUrl
                  ? { previewPngDataUrl: composed.previewPngDataUrl }
                  : {}),
                verified,
                plan: prepData.plan,
                tilesCaptured: tiles.length,
                nestedScrollDetected,
                pageTitle: prepData.pageTitle,
                pageUrl: prepData.pageUrl,
                jobId: job.id,
              },
              boundDocumentId,
            );
          } catch (err: unknown) {
            const cancelled = abortCtrl.signal.aborted;
            const errMsg = err instanceof Error ? err.message : 'Capture failed';
            await this.updateJob(job, {
              status: cancelled ? 'cancelled' : 'failed',
              statusMessage: errMsg,
            });
            return createErrorResponse(
              msg.requestId,
              cancelled ? 'JOB_CANCELLED' : 'TOOL_EXECUTION_ERROR',
              errMsg,
              msg.operation,
            );
          } finally {
            if (preparedDom) {
              await this.env
                .sendToTab(tabId, {
                  schemaVersion: 1,
                  requestId: `${msg.requestId}-restore`,
                  operation: 'CAPTURE_RESTORE',
                  tabId,
                  payload: {},
                })
                .catch(() => undefined);
            }
            const senderTabId = sender.tab?.id;
            if (
              typeof senderTabId === 'number' &&
              senderTabId !== tabId &&
              this.env.getTabInfo &&
              this.env.activateTabAndWindow
            ) {
              const senderTab = await this.env.getTabInfo(senderTabId).catch(() => null);
              if (senderTab) {
                await this.env
                  .activateTabAndWindow(senderTab.id, senderTab.windowId)
                  .catch(() => undefined);
              }
            }
            this.activeJobControllers.delete(msg.requestId);
            this.activeJobTabs.delete(msg.requestId);
          }
        }

        default: {
          if (typeof msg.tabId === 'number' && this.env.sendToTab) {
            return await this.env.sendToTab(msg.tabId, msg);
          }
          return createErrorResponse(
            msg.requestId,
            'INVALID_MESSAGE',
            `Operation ${msg.operation} requires an active target tabId`,
            msg.operation,
          );
        }
      }
    } catch (err: unknown) {
      if (err instanceof QuotaExceededStorageError) {
        return createErrorResponse(msg.requestId, 'QUOTA_EXCEEDED', err.message, msg.operation);
      }
      const messageText = err instanceof Error ? err.message : 'Background operation failed';
      const code =
        msg.operation === 'RUN_NVIDIA_ENHANCEMENT' ? 'AI_PROVIDER_ERROR' : 'TOOL_EXECUTION_ERROR';
      return createErrorResponse(msg.requestId, code, messageText, msg.operation);
    }
  }

  private async closeActiveResponsiveSession(): Promise<{
    closedWindowIds: number[];
    closedTabIds: number[];
  }> {
    if (!this.responsiveSession) {
      await this.restoreResponsiveSession();
    }
    if (!this.responsiveSession) {
      return { closedWindowIds: [], closedTabIds: [] };
    }
    const windowsToClose = [...this.responsiveSession.windows];
    const closedWindowIds: number[] = [];
    const closedTabIds: number[] = [];

    const sendToTabFn = this.env.sendToTab;
    if (sendToTabFn) {
      await Promise.all(
        windowsToClose.map((w) =>
          sendToTabFn(w.tabId, {
            schemaVersion: 1,
            requestId: `sync-close-${Date.now()}-${w.tabId}`,
            operation: 'SET_RESPONSIVE_SYNC',
            tabId: w.tabId,
            payload: { enabled: false },
          }).catch(() => undefined),
        ),
      );
    }

    if (this.env.closeResponsiveWindow) {
      for (const w of windowsToClose) {
        try {
          await this.env.closeResponsiveWindow(w.windowId);
          closedWindowIds.push(w.windowId);
          closedTabIds.push(w.tabId);
        } catch {
          continue;
        }
      }
    }

    this.scrollSync.clearAllManagedTabs();
    this.responsiveSession = null;
    await this.persistResponsiveSession();

    return { closedWindowIds, closedTabIds };
  }
}

interface ChromeGlobalApis {
  runtime?: {
    id?: string;
    onInstalled?: { addListener: (cb: () => void) => void };
    onStartup?: { addListener: (cb: () => void) => void };
    onMessage?: {
      addListener: (
        cb: (
          message: unknown,
          sender: SenderContextInfo,
          sendResponse: (res: ExtensionMessageResponse) => void,
        ) => boolean | undefined,
      ) => void;
    };
  };
  storage?: {
    local?: KeyValueArea;
    session?: KeyValueArea;
  };
  tabs?: {
    get?: (tabId: number) => Promise<{
      id?: number;
      windowId?: number;
      url?: string;
      title?: string;
      active?: boolean;
      status?: string;
    }>;
    update?: (tabId: number, updateProps: { active?: boolean }) => Promise<unknown>;
    sendMessage?: (tabId: number, message: unknown) => Promise<ExtensionMessageResponse>;
    captureVisibleTab?: (
      windowId: number | undefined,
      options: { format: 'png' | 'jpeg' },
    ) => Promise<string>;
    onRemoved?: { addListener: (cb: (tabId: number) => void) => void };
    onUpdated?: {
      addListener: (cb: (tabId: number, changeInfo: { status?: string }) => void) => void;
    };
  };
  windows?: {
    create?: (createData: {
      url: string;
      type: 'popup';
      width: number;
      height: number;
      focused?: boolean;
    }) => Promise<{ id?: number; tabs?: Array<{ id?: number }> }>;
    update?: (
      windowId: number,
      updateInfo: { width?: number; height?: number; focused?: boolean },
    ) => Promise<unknown>;
    remove?: (windowId: number) => Promise<void>;
    onRemoved?: { addListener: (cb: (windowId: number) => void) => void };
  };
}

function bootstrapServiceWorker(): void {
  const chromeApi = (globalThis as unknown as { chrome?: ChromeGlobalApis }).chrome;
  if (!chromeApi?.runtime?.onMessage || !chromeApi.runtime.id) {
    return;
  }

  const localArea = chromeApi.storage?.local ?? new InMemoryKeyValueArea();
  const sessionArea = chromeApi.storage?.session ?? new InMemoryKeyValueArea();
  const storage = new LocalExtensionStorage();
  const settingsStore = new ExtensionSettingsStore(localArea, sessionArea);

  const coordinator = new BackgroundCoordinator({
    extensionId: chromeApi.runtime.id,
    storage,
    settingsStore,
    sessionStateArea: sessionArea,
    sendToTab: async (tabId, message) => {
      if (!chromeApi.tabs?.sendMessage) {
        throw new Error('chrome.tabs.sendMessage is unavailable');
      }
      return chromeApi.tabs.sendMessage(tabId, message);
    },
    getTabInfo: async (tabId) => {
      if (!chromeApi.tabs?.get) {
        return null;
      }
      try {
        const tab = await chromeApi.tabs.get(tabId);
        if (typeof tab.id !== 'number' || typeof tab.windowId !== 'number') {
          return null;
        }
        return {
          id: tab.id,
          windowId: tab.windowId,
          url: tab.url ?? '',
          ...(tab.title ? { title: tab.title } : {}),
          active: tab.active === true,
          ...(tab.status ? { status: tab.status } : {}),
        };
      } catch {
        return null;
      }
    },
    activateTabAndWindow: async (tabId, windowId) => {
      if (chromeApi.windows?.update) {
        await chromeApi.windows.update(windowId, { focused: true });
      }
      if (chromeApi.tabs?.update) {
        await chromeApi.tabs.update(tabId, { active: true });
      }
    },
    captureVisibleTab: async (windowId, format) => {
      if (!chromeApi.tabs?.captureVisibleTab) {
        throw new Error('chrome.tabs.captureVisibleTab is unavailable');
      }
      return chromeApi.tabs.captureVisibleTab(windowId, { format });
    },
    openResponsiveWindow: async (url, width, height) => {
      if (!chromeApi.windows?.create) {
        return null;
      }
      const win = await chromeApi.windows.create({
        url,
        type: 'popup',
        width,
        height,
        focused: false,
      });
      const tabId = win.tabs?.[0]?.id;
      if (typeof win.id !== 'number' || typeof tabId !== 'number') {
        return null;
      }
      return { windowId: win.id, tabId };
    },
    updateResponsiveWindow: async (windowId, width, height) => {
      if (chromeApi.windows?.update) {
        await chromeApi.windows.update(windowId, { width, height });
      }
    },
    closeResponsiveWindow: async (windowId) => {
      if (chromeApi.windows?.remove) {
        await chromeApi.windows.remove(windowId);
      }
    },
  });

  chromeApi.runtime.onInstalled?.addListener(() => {
    void coordinator.initialize();
  });
  chromeApi.runtime.onStartup?.addListener(() => {
    void coordinator.initialize();
  });
  chromeApi.tabs?.onRemoved?.addListener((tabId) => {
    void coordinator.handleManagedTabRemoved(tabId);
  });
  chromeApi.windows?.onRemoved?.addListener((windowId) => {
    void coordinator.handleManagedWindowRemoved(windowId);
  });
  chromeApi.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
    void coordinator.handleManagedTabUpdated(tabId, changeInfo.status);
  });

  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void coordinator.handleRuntimeMessage(message, sender).then((res) => {
      sendResponse(res);
    });
    return true;
  });
}

bootstrapServiceWorker();
