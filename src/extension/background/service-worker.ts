import {
  buildNvidiaEgressPreview,
  invokeNvidiaChatCompletion,
  type NvidiaTaskType,
} from '../ai/nvidia-client.js';
import {
  buildPdfDocumentFromCapture,
  verifyCaptureBinaryAndDimensions,
  type CaptureExportMime,
} from '../engines/capture-engine.js';
import {
  createResponsiveInspectionPlan,
  ResponsiveScrollSynchronizer,
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
} from '../storage/idb-storage.js';
import {
  ExtensionSettingsStore,
  InMemoryKeyValueArea,
  type KeyValueArea,
} from '../storage/settings-storage.js';

export interface BackgroundEnvironmentAdapters {
  extensionId: string;
  storage: LocalExtensionStorage;
  settingsStore: ExtensionSettingsStore;
  sendToTab?: (tabId: number, message: RuntimeMessageEnvelope) => Promise<ExtensionMessageResponse>;
  captureVisibleTab?: (windowId?: number, format?: 'png' | 'jpeg') => Promise<string>;
  openResponsiveWindow?: (url: string, width: number, height: number) => Promise<number | null>;
  fetchImpl?: typeof fetch;
}

export class BackgroundCoordinator {
  private readonly env: BackgroundEnvironmentAdapters;
  private readonly scrollSync = new ResponsiveScrollSynchronizer(150);

  public constructor(env: BackgroundEnvironmentAdapters) {
    this.env = env;
  }

  public async initialize(): Promise<{ recoveredJobsCount: number }> {
    const recoveredJobsCount = await this.env.storage.recoverInterruptedJobs();
    return { recoveredJobsCount };
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
          const taskType =
            (msg.payload['taskType'] as NvidiaTaskType | undefined) ?? 'enhance_clone_prompt';
          const sanitizedContext =
            typeof msg.payload['sanitizedContext'] === 'object' &&
            msg.payload['sanitizedContext'] !== null
              ? (msg.payload['sanitizedContext'] as Record<string, unknown>)
              : {};

          if (msg.payload['previewOnly'] === true) {
            const egressPreview = buildNvidiaEgressPreview({
              modelId,
              endpoint: settings.nvidiaEndpoint,
              taskType,
              sanitizedContext,
            });
            return createSuccessResponse(msg, { egressPreview });
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

          const completion = await invokeNvidiaChatCompletion({
            apiKey,
            modelId,
            endpoint: settings.nvidiaEndpoint,
            taskType,
            sanitizedContext,
            ...(this.env.fetchImpl ? { fetchImpl: this.env.fetchImpl } : {}),
          });
          return createSuccessResponse(msg, { completion });
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

        case 'RUN_RESPONSIVE_INSPECT': {
          const targetUrl =
            typeof msg.payload['targetUrl'] === 'string'
              ? msg.payload['targetUrl']
              : 'https://example.com';
          const plan = createResponsiveInspectionPlan(targetUrl);
          const openedTabIds: number[] = [];

          if (msg.payload['openWindows'] === true && this.env.openResponsiveWindow) {
            for (const vp of plan.viewports) {
              const tabId = await this.env.openResponsiveWindow(
                plan.targetUrl,
                vp.width,
                vp.height,
              );
              if (typeof tabId === 'number') {
                openedTabIds.push(tabId);
              }
            }
            this.scrollSync.registerManagedTabs(openedTabIds);
          }

          return createSuccessResponse(msg, { plan, openedTabIds });
        }

        case 'SYNC_SCROLL': {
          const sourceTabId = sender.tab?.id ?? msg.tabId ?? 0;
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
                  requestId: `sync-${Date.now()}`,
                  operation: 'SYNC_SCROLL',
                  tabId: targetTabId,
                  payload: {
                    scrollXRatio: broadcast.scrollXRatio,
                    scrollYRatio: broadcast.scrollYRatio,
                  },
                }),
              ),
            );
          }
          return createSuccessResponse(msg, { broadcast });
        }

        case 'RUN_CAPTURE': {
          const exportMime =
            (msg.payload['exportMime'] as CaptureExportMime | undefined) ?? 'image/png';
          const width = typeof msg.payload['width'] === 'number' ? msg.payload['width'] : 1280;
          const height = typeof msg.payload['height'] === 'number' ? msg.payload['height'] : 800;
          const title =
            typeof msg.payload['title'] === 'string' ? msg.payload['title'] : 'PageSift Capture';
          const pageUrl =
            typeof msg.payload['pageUrl'] === 'string'
              ? msg.payload['pageUrl']
              : 'https://localhost/';

          let dataUrl: string;
          if (exportMime === 'application/pdf') {
            dataUrl = buildPdfDocumentFromCapture({ width, height, title, pageUrl });
          } else if (typeof msg.payload['preparedDataUrl'] === 'string') {
            dataUrl = msg.payload['preparedDataUrl'];
          } else if (this.env.captureVisibleTab) {
            dataUrl = await this.env.captureVisibleTab(
              undefined,
              exportMime === 'image/jpeg' ? 'jpeg' : 'png',
            );
          } else {
            throw new Error('No tab capture source available for screenshot');
          }

          const verified = verifyCaptureBinaryAndDimensions(dataUrl);
          return createSuccessResponse(msg, {
            dataUrl,
            verified,
          });
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
    sendMessage?: (tabId: number, message: unknown) => Promise<ExtensionMessageResponse>;
    captureVisibleTab?: (
      windowId: number | undefined,
      options: { format: 'png' | 'jpeg' },
    ) => Promise<string>;
  };
  windows?: {
    create?: (createData: {
      url: string;
      type: 'popup';
      width: number;
      height: number;
    }) => Promise<{ tabs?: Array<{ id?: number }> }>;
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
    sendToTab: async (tabId, message) => {
      if (!chromeApi.tabs?.sendMessage) {
        throw new Error('chrome.tabs.sendMessage is unavailable');
      }
      return chromeApi.tabs.sendMessage(tabId, message);
    },
    captureVisibleTab: async (windowId, format = 'png') => {
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
      });
      return win.tabs?.[0]?.id ?? null;
    },
  });

  chromeApi.runtime.onInstalled?.addListener(() => {
    void coordinator.initialize();
  });
  chromeApi.runtime.onStartup?.addListener(() => {
    void coordinator.initialize();
  });

  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void coordinator.handleRuntimeMessage(message, sender).then((res) => {
      sendResponse(res);
    });
    return true;
  });
}

bootstrapServiceWorker();
