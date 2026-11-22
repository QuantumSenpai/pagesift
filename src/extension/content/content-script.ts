import { strFromU8 } from 'fflate';
import {
  buildAssetsZipArchive,
  extractPageAssets,
  type AssetBinaryFetcher,
} from '../engines/assets-engine.js';
import {
  buildCapturePlan,
  executeDomCaptureCoordinator,
  type CaptureMode,
  type CaptureRect,
} from '../engines/capture-engine.js';
import { exportStaticPageClone, prepareStaticPageClone } from '../engines/clone-page-engine.js';
import {
  generateLocalClonePrompt,
  type PromptTargetFramework,
} from '../engines/clone-prompt-engine.js';
import { extractPageColors } from '../engines/colors-engine.js';
import {
  extractPageDesignSnapshot,
  generateDesignMdFromPages,
} from '../engines/design-md-engine.js';
import { runLocalDesignReview } from '../engines/design-review-engine.js';
import { buildShortSelector, isPageSiftElement, PAGESIFT_ROOT_ATTR } from '../engines/dom-utils.js';
import { PageEditController } from '../engines/edit-engine.js';
import { extractPageFonts } from '../engines/fonts-engine.js';
import { inspectElement } from '../engines/inspect-engine.js';
import { measureElements } from '../engines/measure-engine.js';
import { detectPageTechStack } from '../engines/tech-stack-engine.js';
import {
  createErrorResponse,
  createSuccessResponse,
  validateMessageEnvelope,
  verifyDocumentBinding,
  type ExtensionMessageResponse,
  type MessageOperation,
  type RuntimeMessageEnvelope,
  type ToolId,
} from '../protocol/messages.js';

interface ChromeRuntimeLike {
  id?: string;
  onMessage?: {
    addListener: (
      cb: (
        message: unknown,
        sender: unknown,
        sendResponse: (response: ExtensionMessageResponse) => void,
      ) => boolean | undefined,
    ) => void;
  };
  sendMessage?: (message: unknown) => Promise<ExtensionMessageResponse>;
}

export interface ContentScriptAdapters {
  fetchAssetBinary?: AssetBinaryFetcher;
  captureViewportTab?: () => Promise<string>;
  sendBackgroundMessage?: (message: RuntimeMessageEnvelope) => Promise<ExtensionMessageResponse>;
}

interface ActiveCaptureDomState {
  originalScrollX: number;
  originalScrollY: number;
  savedPageSiftVisibility: Array<{ el: HTMLElement; visibility: string; priority: string }>;
  fixedOrStickySaved: Array<{ el: HTMLElement; visibility: string; priority: string }>;
}

const UNBOUND_CONTENT_OPERATIONS = new Set<MessageOperation>([
  'PING_CONTENT',
  'GET_DOCUMENT_CONTEXT',
  'GET_VIEWPORT_METRICS',
  'SET_RESPONSIVE_SYNC',
  'SYNC_SCROLL',
  'CANCEL_JOB',
  'CAPTURE_RESTORE',
]);

function uint8ToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength));
    let part = '';
    for (let j = 0; j < slice.byteLength; j += 1) {
      part += String.fromCharCode(slice[j] ?? 0);
    }
    binary += part;
  }
  return btoa(binary);
}

export class ContentScriptRuntime {
  public readonly documentId: string;
  private readonly doc: Document;
  private readonly win: Window;
  private readonly adapters: ContentScriptAdapters;
  private readonly editController: PageEditController;
  private activeTool: ToolId | null = null;
  private selectedElement: Element | null = null;
  private secondaryElement: Element | null = null;
  private overlayHost: HTMLElement | null = null;
  private highlightBox: HTMLElement | null = null;
  private badgeBox: HTMLElement | null = null;
  private rafPending = false;
  private lastPointerTarget: Element | null = null;
  private readonly activeAbortControllers = new Map<string, AbortController>();
  private activeCaptureState: ActiveCaptureDomState | null = null;
  private responsiveSyncEnabled = false;
  private suppressScrollEmitUntilMs = 0;
  private scrollEmitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastScrollEmitMs = 0;

  public constructor(doc: Document, win: Window, adapters: ContentScriptAdapters = {}) {
    this.doc = doc;
    this.win = win;
    this.adapters = adapters;
    this.documentId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.editController = new PageEditController(doc);
  }

  public init(): void {
    this.win.addEventListener('keydown', this.handleKeyDown, true);
    this.win.addEventListener('pagehide', this.handlePageUnload);
    this.win.addEventListener('scroll', this.handleScrollOrResize, { passive: true });
    this.win.addEventListener('resize', this.handleScrollOrResize, { passive: true });
  }

  public dispose(): void {
    this.restoreCaptureDomState();
    this.deactivateInteractiveTools();
    this.editController.resetAll();
    this.responsiveSyncEnabled = false;
    if (this.scrollEmitTimer !== null) {
      clearTimeout(this.scrollEmitTimer);
      this.scrollEmitTimer = null;
    }
    for (const controller of this.activeAbortControllers.values()) {
      controller.abort();
    }
    this.activeAbortControllers.clear();
    this.win.removeEventListener('keydown', this.handleKeyDown, true);
    this.win.removeEventListener('pagehide', this.handlePageUnload);
    this.win.removeEventListener('scroll', this.handleScrollOrResize);
    this.win.removeEventListener('resize', this.handleScrollOrResize);
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.activeTool !== null) {
      this.deactivateInteractiveTools();
    }
  };

  private readonly handlePageUnload = (): void => {
    this.dispose();
  };

  private readonly handleScrollOrResize = (event?: Event): void => {
    if (this.activeTool && this.selectedElement && this.selectedElement.isConnected) {
      this.scheduleOverlayUpdate(this.selectedElement);
    }
    if (
      event?.type === 'scroll' &&
      this.responsiveSyncEnabled &&
      Date.now() >= this.suppressScrollEmitUntilMs
    ) {
      this.scheduleResponsiveScrollEmit();
    }
  };

  private scheduleResponsiveScrollEmit(): void {
    const now = Date.now();
    const minEmitIntervalMs = 45;
    const elapsed = now - this.lastScrollEmitMs;

    const emitNow = (): void => {
      this.scrollEmitTimer = null;
      if (!this.responsiveSyncEnabled || Date.now() < this.suppressScrollEmitUntilMs) {
        return;
      }
      this.lastScrollEmitMs = Date.now();
      const maxScrollX = Math.max(
        0,
        (this.doc.documentElement.scrollWidth || 0) - (this.win.innerWidth || 0),
      );
      const maxScrollY = Math.max(
        0,
        (this.doc.documentElement.scrollHeight || 0) - (this.win.innerHeight || 0),
      );
      const scrollXRatio =
        maxScrollX > 0 ? Math.max(0, Math.min(1, this.win.scrollX / maxScrollX)) : 0;
      const scrollYRatio =
        maxScrollY > 0 ? Math.max(0, Math.min(1, this.win.scrollY / maxScrollY)) : 0;

      const envelope: RuntimeMessageEnvelope = {
        schemaVersion: 1,
        requestId: `sync-out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        operation: 'SYNC_SCROLL',
        documentId: this.documentId,
        payload: { scrollXRatio, scrollYRatio },
      };

      if (this.adapters.sendBackgroundMessage) {
        void this.adapters.sendBackgroundMessage(envelope).catch(() => undefined);
      }
    };

    if (elapsed >= minEmitIntervalMs && this.scrollEmitTimer === null) {
      emitNow();
    } else if (this.scrollEmitTimer === null) {
      this.scrollEmitTimer = setTimeout(emitNow, Math.max(10, minEmitIntervalMs - elapsed));
    }
  }

  private readonly handlePointerMove = (event: MouseEvent): void => {
    if (!this.activeTool) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (!target || isPageSiftElement(target)) {
      return;
    }
    this.lastPointerTarget = target;
    this.scheduleOverlayUpdate(target);
  };

  private readonly handleClick = (event: MouseEvent): void => {
    if (!this.activeTool) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (!target || isPageSiftElement(target)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    if (this.activeTool === 'measure' && this.selectedElement && this.selectedElement !== target) {
      this.secondaryElement = target;
    } else {
      this.selectedElement = target;
    }
    this.scheduleOverlayUpdate(target);
  };

  private scheduleOverlayUpdate(target: Element): void {
    if (this.rafPending) {
      return;
    }
    this.rafPending = true;
    const raf =
      typeof this.win.requestAnimationFrame === 'function'
        ? this.win.requestAnimationFrame.bind(this.win)
        : (cb: FrameRequestCallback) =>
            setTimeout(() => {
              cb(Date.now());
            }, 16);

    raf(() => {
      this.rafPending = false;
      const el = this.lastPointerTarget ?? target;
      if (!el.isConnected) {
        return;
      }
      const rect = el.getBoundingClientRect();
      this.ensureOverlayDom();
      if (this.highlightBox && this.badgeBox) {
        this.highlightBox.style.transform = `translate(${Math.round(rect.left)}px, ${Math.round(rect.top)}px)`;
        this.highlightBox.style.width = `${Math.max(0, Math.round(rect.width))}px`;
        this.highlightBox.style.height = `${Math.max(0, Math.round(rect.height))}px`;
        this.highlightBox.style.display = 'block';
        this.badgeBox.textContent = `${buildShortSelector(el)} (${Math.round(rect.width)}×${Math.round(rect.height)})`;
      }
    });
  }

  private ensureOverlayDom(): void {
    if (this.overlayHost && this.overlayHost.isConnected) {
      return;
    }
    const host = this.doc.createElement('div');
    host.id = 'pagesift-root-host';
    host.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    host.style.position = 'fixed';
    host.style.top = '0';
    host.style.left = '0';
    host.style.width = '0';
    host.style.height = '0';
    host.style.zIndex = '2147483646';
    host.style.pointerEvents = 'none';

    const shadow = host.attachShadow({ mode: 'open' });
    const box = this.doc.createElement('div');
    box.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    box.style.position = 'fixed';
    box.style.top = '0';
    box.style.left = '0';
    box.style.border = '2px solid #3b82f6';
    box.style.backgroundColor = 'rgba(59, 130, 246, 0.12)';
    box.style.pointerEvents = 'none';
    box.style.boxSizing = 'border-box';
    box.style.display = 'none';

    const badge = this.doc.createElement('div');
    badge.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    badge.style.position = 'absolute';
    badge.style.top = '-24px';
    badge.style.left = '0';
    badge.style.backgroundColor = '#0f172a';
    badge.style.color = '#f8fafc';
    badge.style.fontFamily = 'monospace';
    badge.style.fontSize = '11px';
    badge.style.padding = '2px 6px';
    badge.style.borderRadius = '4px';
    badge.style.whiteSpace = 'nowrap';

    box.appendChild(badge);
    shadow.appendChild(box);
    this.doc.documentElement.appendChild(host);

    this.overlayHost = host;
    this.highlightBox = box;
    this.badgeBox = badge;
  }

  public activateInteractiveTool(tool: ToolId): void {
    this.activeTool = tool;
    this.ensureOverlayDom();
    this.doc.addEventListener('mousemove', this.handlePointerMove, true);
    this.doc.addEventListener('click', this.handleClick, true);
  }

  public deactivateInteractiveTools(): void {
    this.activeTool = null;
    this.lastPointerTarget = null;
    this.doc.removeEventListener('mousemove', this.handlePointerMove, true);
    this.doc.removeEventListener('click', this.handleClick, true);
    if (this.overlayHost && this.overlayHost.isConnected) {
      this.overlayHost.remove();
    }
    this.overlayHost = null;
    this.highlightBox = null;
    this.badgeBox = null;
  }

  private resolveTargetElement(selector?: unknown): Element {
    if (typeof selector === 'string' && selector.trim().length > 0) {
      const found = this.doc.querySelector(selector.trim());
      if (!found) {
        throw new Error(`No element matched selector "${selector.trim()}"`);
      }
      return found;
    }
    if (this.selectedElement && this.selectedElement.isConnected) {
      return this.selectedElement;
    }
    const fallback = this.doc.querySelector('main, article, section, header, div') ?? this.doc.body;
    return fallback;
  }

  private restoreCaptureDomState(): {
    restoredScroll: { scrollX: number; scrollY: number };
    restoredFixedElementsCount: number;
  } {
    const state = this.activeCaptureState;
    if (!state) {
      return {
        restoredScroll: { scrollX: this.win.scrollX, scrollY: this.win.scrollY },
        restoredFixedElementsCount: 0,
      };
    }

    for (const fixedItem of state.fixedOrStickySaved) {
      if (fixedItem.visibility) {
        fixedItem.el.style.setProperty('visibility', fixedItem.visibility, fixedItem.priority);
      } else {
        fixedItem.el.style.removeProperty('visibility');
      }
    }

    for (const item of state.savedPageSiftVisibility) {
      if (item.visibility) {
        item.el.style.setProperty('visibility', item.visibility, item.priority);
      } else {
        item.el.style.removeProperty('visibility');
      }
    }

    this.win.scrollTo(state.originalScrollX, state.originalScrollY);
    const count = state.fixedOrStickySaved.length;
    this.activeCaptureState = null;

    return {
      restoredScroll: { scrollX: this.win.scrollX, scrollY: this.win.scrollY },
      restoredFixedElementsCount: count,
    };
  }

  private async waitForPaintFrame(): Promise<void> {
    if (typeof this.win.requestAnimationFrame === 'function') {
      await new Promise<void>((resolve) => {
        this.win.requestAnimationFrame(() => {
          this.win.requestAnimationFrame(() => {
            resolve();
          });
        });
      });
    }
  }

  public async handleMessage(rawMessage: unknown): Promise<ExtensionMessageResponse> {
    const validated = validateMessageEnvelope(rawMessage);
    if (!validated.valid) {
      return validated.response;
    }

    const msg: RuntimeMessageEnvelope = validated.message;
    const bindingRequired = !UNBOUND_CONTENT_OPERATIONS.has(msg.operation);

    if (!verifyDocumentBinding(msg.documentId, this.documentId, bindingRequired)) {
      return createErrorResponse(
        msg.requestId,
        'STALE_DOCUMENT',
        msg.documentId
          ? 'Page navigated since operation was initiated; stale request rejected'
          : `Operation ${msg.operation} requires an active documentId binding`,
        msg.operation,
      );
    }

    try {
      switch (msg.operation) {
        case 'PING_CONTENT':
        case 'GET_DOCUMENT_CONTEXT':
          return createSuccessResponse(
            msg,
            {
              documentId: this.documentId,
              pageUrl: this.doc.location.href,
              pageTitle: this.doc.title,
              activeTool: this.activeTool,
              editHistory: this.editController.getStatus(),
              responsiveSyncEnabled: this.responsiveSyncEnabled,
            },
            this.documentId,
          );

        case 'GET_VIEWPORT_METRICS':
          return createSuccessResponse(
            msg,
            {
              innerWidth: this.win.innerWidth || 0,
              innerHeight: this.win.innerHeight || 0,
              outerWidth: this.win.outerWidth || 0,
              outerHeight: this.win.outerHeight || 0,
              devicePixelRatio: this.win.devicePixelRatio || 1,
              scrollX: this.win.scrollX,
              scrollY: this.win.scrollY,
              scrollWidth: this.doc.documentElement.scrollWidth || 0,
              scrollHeight: this.doc.documentElement.scrollHeight || 0,
              pageUrl: this.doc.location.href,
            },
            this.documentId,
          );

        case 'ACTIVATE_TOOL': {
          const tool = (msg.payload['tool'] as ToolId | undefined) ?? 'inspect';
          this.activateInteractiveTool(tool);
          return createSuccessResponse(
            msg,
            { activeTool: this.activeTool, documentId: this.documentId },
            this.documentId,
          );
        }

        case 'DEACTIVATE_TOOLS': {
          this.deactivateInteractiveTools();
          return createSuccessResponse(
            msg,
            { activeTool: null, documentId: this.documentId },
            this.documentId,
          );
        }

        case 'CANCEL_JOB': {
          const targetJobId =
            typeof msg.payload['jobId'] === 'string' ? msg.payload['jobId'] : msg.requestId;
          const ctrl = this.activeAbortControllers.get(targetJobId);
          if (ctrl) {
            ctrl.abort();
            this.activeAbortControllers.delete(targetJobId);
          }
          this.restoreCaptureDomState();
          return createSuccessResponse(
            msg,
            { cancelled: true, jobId: targetJobId },
            this.documentId,
          );
        }

        case 'RUN_INSPECT_ELEMENT': {
          const target = this.resolveTargetElement(msg.payload['selector']);
          const report = inspectElement(target, this.win);
          return createSuccessResponse(msg, { report }, this.documentId);
        }

        case 'RUN_COLORS_EXTRACT': {
          const report = extractPageColors(this.doc, this.win);
          return createSuccessResponse(msg, { report }, this.documentId);
        }

        case 'RUN_FONTS_EXTRACT': {
          const report = extractPageFonts(this.doc, this.win);
          return createSuccessResponse(msg, { report }, this.documentId);
        }

        case 'RUN_MEASURE': {
          const primary = this.resolveTargetElement(msg.payload['primarySelector']);
          const secondarySelector = msg.payload['secondarySelector'];
          const secondary =
            typeof secondarySelector === 'string' && secondarySelector.trim().length > 0
              ? this.doc.querySelector(secondarySelector.trim())
              : this.secondaryElement;
          const report = measureElements(primary, secondary, this.win);
          return createSuccessResponse(msg, { report }, this.documentId);
        }

        case 'RUN_ASSETS_EXTRACT': {
          const report = extractPageAssets(this.doc, this.win);
          const includeZip = msg.payload['includeZip'] === true;
          let zipBase64: string | null = null;
          let packagedFilesCount = 0;
          let skippedOrUnavailable: Array<{ id: string; url: string; reason: string }> = [];
          if (includeZip) {
            const zipRes = await buildAssetsZipArchive(report, this.adapters.fetchAssetBinary);
            zipBase64 = uint8ToBase64(zipRes.zipBytes);
            packagedFilesCount = zipRes.packagedFilesCount;
            skippedOrUnavailable = zipRes.skippedOrUnavailable;
          }
          return createSuccessResponse(
            msg,
            { report, zipBase64, packagedFilesCount, skippedOrUnavailable },
            this.documentId,
          );
        }

        case 'RUN_DESIGN_MD': {
          const currentSnapshot = extractPageDesignSnapshot(this.doc, this.win);
          const extraSnapshots = Array.isArray(msg.payload['additionalSnapshots'])
            ? (msg.payload['additionalSnapshots'] as (typeof currentSnapshot)[])
            : [];
          const result = generateDesignMdFromPages([currentSnapshot, ...extraSnapshots]);
          return createSuccessResponse(msg, { result, snapshot: currentSnapshot }, this.documentId);
        }

        case 'RUN_CLONE_PROMPT': {
          const framework =
            (msg.payload['targetFramework'] as PromptTargetFramework | undefined) ??
            'react_tailwind';
          const report = generateLocalClonePrompt(this.doc, this.win, framework);
          return createSuccessResponse(msg, { report }, this.documentId);
        }

        case 'RUN_CLONE_PAGE': {
          const abortCtrl = new AbortController();
          this.activeAbortControllers.set(msg.requestId, abortCtrl);
          try {
            if (msg.payload['prepareOnly'] === true) {
              const prepared = prepareStaticPageClone(this.doc, this.win, {
                signal: abortCtrl.signal,
              });
              return createSuccessResponse(msg, { prepared }, this.documentId);
            }
            const snapshot = await exportStaticPageClone(this.doc, this.win, {
              signal: abortCtrl.signal,
              ...(this.adapters.fetchAssetBinary
                ? { fetcher: this.adapters.fetchAssetBinary }
                : {}),
            });
            return createSuccessResponse(
              msg,
              {
                manifest: snapshot.manifest,
                htmlPreview: snapshot.htmlContent.slice(0, 4000),
                cssPreview: snapshot.cssContent.slice(0, 4000),
                zipBase64: uint8ToBase64(snapshot.zipBytes),
                zipSizeBytes: snapshot.zipBytes.byteLength,
              },
              this.documentId,
            );
          } finally {
            this.activeAbortControllers.delete(msg.requestId);
          }
        }

        case 'RUN_EDIT_TEXT': {
          const target = this.resolveTargetElement(msg.payload['selector']);
          const newText =
            typeof msg.payload['text'] === 'string' ? msg.payload['text'] : 'Edited Preview Text';
          const history = this.editController.applyTextEdit(target, newText);
          return createSuccessResponse(
            msg,
            { history, updatedHtml: sanitizePreviewSnippet(target) },
            this.documentId,
          );
        }

        case 'RUN_SWAP_FONT': {
          const scope =
            (msg.payload['scope'] as 'element' | 'similar' | 'page' | undefined) ?? 'element';
          const target =
            scope === 'page' ? this.doc.body : this.resolveTargetElement(msg.payload['selector']);
          const fontFamily =
            typeof msg.payload['fontFamily'] === 'string'
              ? msg.payload['fontFamily']
              : 'Georgia, serif';
          const remoteFontCssUrl =
            typeof msg.payload['remoteFontCssUrl'] === 'string' &&
            msg.payload['remoteFontCssUrl'].trim().length > 0
              ? msg.payload['remoteFontCssUrl'].trim()
              : undefined;
          const allowRemoteFontLoad = msg.payload['allowRemoteFontLoad'] === true;

          const history = this.editController.applyFontSwap({
            target,
            scope,
            fontFamily,
            ...(remoteFontCssUrl ? { remoteFontCssUrl } : {}),
            allowRemoteFontLoad,
          });
          return createSuccessResponse(msg, { history, fontFamily, scope }, this.documentId);
        }

        case 'RUN_ARRANGE': {
          const target = this.resolveTargetElement(msg.payload['selector']);
          const action =
            (msg.payload['action'] as 'move' | 'hide' | 'remove' | undefined) ?? 'move';
          const dx = typeof msg.payload['dx'] === 'number' ? msg.payload['dx'] : 0;
          const dy = typeof msg.payload['dy'] === 'number' ? msg.payload['dy'] : 0;
          const history = this.editController.applyArrangeMutation({
            target,
            action,
            dx,
            dy,
          });
          return createSuccessResponse(msg, { history, action, dx, dy }, this.documentId);
        }

        case 'EDIT_UNDO': {
          const history = this.editController.undo();
          return createSuccessResponse(msg, { history }, this.documentId);
        }

        case 'EDIT_REDO': {
          const history = this.editController.redo();
          return createSuccessResponse(msg, { history }, this.documentId);
        }

        case 'EDIT_RESET': {
          const history = this.editController.resetAll();
          return createSuccessResponse(msg, { history }, this.documentId);
        }

        case 'RUN_DESIGN_REVIEW': {
          const report = runLocalDesignReview(this.doc, this.win);
          return createSuccessResponse(msg, { report }, this.documentId);
        }

        case 'RUN_TECH_STACK': {
          const report = detectPageTechStack(this.doc);
          return createSuccessResponse(msg, { report }, this.documentId);
        }

        case 'CAPTURE_PREPARE': {
          this.restoreCaptureDomState();
          const mode = (msg.payload['mode'] as CaptureMode | undefined) ?? 'visible';
          const originalScrollX = this.win.scrollX;
          const originalScrollY = this.win.scrollY;
          let targetRect: CaptureRect | undefined;

          if (mode === 'element') {
            const el = this.resolveTargetElement(msg.payload['selector']);
            if (typeof el.scrollIntoView === 'function') {
              el.scrollIntoView({ block: 'center', inline: 'nearest' });
              await this.waitForPaintFrame();
            }
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
              throw new Error('Target element has zero visible width or height');
            }
            targetRect = {
              x: Math.max(0, rect.left),
              y: Math.max(0, rect.top),
              width: rect.width,
              height: rect.height,
            };
          } else if (
            mode === 'area' &&
            typeof msg.payload['rect'] === 'object' &&
            msg.payload['rect'] !== null
          ) {
            const r = msg.payload['rect'] as Record<string, number>;
            targetRect = {
              x: r['x'] ?? 0,
              y: r['y'] ?? 0,
              width: r['width'] ?? 400,
              height: r['height'] ?? 300,
            };
          }

          const pageSiftNodes = Array.from(
            this.doc.querySelectorAll<HTMLElement>(`[${PAGESIFT_ROOT_ATTR}], #pagesift-root-host`),
          );
          const savedPageSiftVisibility = pageSiftNodes.map((el) => ({
            el,
            visibility: el.style.getPropertyValue('visibility'),
            priority: el.style.getPropertyPriority('visibility'),
          }));
          for (const item of savedPageSiftVisibility) {
            item.el.style.setProperty('visibility', 'hidden', 'important');
          }

          const fixedOrStickySaved: Array<{
            el: HTMLElement;
            visibility: string;
            priority: string;
          }> = [];
          if (mode === 'full_page') {
            for (const node of Array.from(this.doc.querySelectorAll('*'))) {
              if (!('style' in node) || node.hasAttribute(PAGESIFT_ROOT_ATTR)) {
                continue;
              }
              const htmlNode = node as HTMLElement;
              const pos = this.win.getComputedStyle(htmlNode).position;
              if (pos === 'fixed' || pos === 'sticky') {
                fixedOrStickySaved.push({
                  el: htmlNode,
                  visibility: htmlNode.style.getPropertyValue('visibility'),
                  priority: htmlNode.style.getPropertyPriority('visibility'),
                });
              }
            }
          }

          this.activeCaptureState = {
            originalScrollX,
            originalScrollY,
            savedPageSiftVisibility,
            fixedOrStickySaved,
          };

          const plan = buildCapturePlan({
            mode,
            viewportWidth: this.win.innerWidth || 1280,
            viewportHeight: this.win.innerHeight || 800,
            documentWidth: Math.max(
              this.doc.documentElement.scrollWidth || 0,
              this.doc.body.scrollWidth || 0,
              this.win.innerWidth || 1280,
            ),
            documentHeight: Math.max(
              this.doc.documentElement.scrollHeight || 0,
              this.doc.body.scrollHeight || 0,
              this.win.innerHeight || 800,
            ),
            currentScrollX: this.win.scrollX,
            currentScrollY: this.win.scrollY,
            devicePixelRatio: this.win.devicePixelRatio || 1,
            ...(targetRect ? { targetRect } : {}),
          });

          await this.waitForPaintFrame();

          return createSuccessResponse(
            msg,
            {
              plan,
              pageTitle: this.doc.title || 'PageSift Capture',
              pageUrl: this.doc.location.href,
              viewportWidth: this.win.innerWidth || 1280,
              viewportHeight: this.win.innerHeight || 800,
              devicePixelRatio: this.win.devicePixelRatio || 1,
              fixedElementsCount: fixedOrStickySaved.length,
            },
            this.documentId,
          );
        }

        case 'CAPTURE_SCROLL_TO': {
          const scrollX = typeof msg.payload['scrollX'] === 'number' ? msg.payload['scrollX'] : 0;
          const scrollY = typeof msg.payload['scrollY'] === 'number' ? msg.payload['scrollY'] : 0;
          const hideFixed = msg.payload['hideFixed'] === true;
          const lazyWaitMs =
            typeof msg.payload['lazyWaitMs'] === 'number'
              ? Math.min(400, Math.max(0, msg.payload['lazyWaitMs']))
              : 50;

          if (hideFixed && this.activeCaptureState) {
            for (const fixedItem of this.activeCaptureState.fixedOrStickySaved) {
              fixedItem.el.style.setProperty('visibility', 'hidden', 'important');
            }
          }

          this.win.scrollTo(scrollX, scrollY);
          if (lazyWaitMs > 0) {
            await new Promise((r) => setTimeout(r, lazyWaitMs));
          }
          await this.waitForPaintFrame();

          return createSuccessResponse(
            msg,
            {
              actualScrollX: this.win.scrollX,
              actualScrollY: this.win.scrollY,
              viewportWidth: this.win.innerWidth || 1280,
              viewportHeight: this.win.innerHeight || 800,
              devicePixelRatio: this.win.devicePixelRatio || 1,
            },
            this.documentId,
          );
        }

        case 'CAPTURE_RESTORE': {
          const restored = this.restoreCaptureDomState();
          return createSuccessResponse(msg, restored, this.documentId);
        }

        case 'RUN_CAPTURE': {
          const mode = (msg.payload['mode'] as CaptureMode | undefined) ?? 'visible';
          let targetRect: CaptureRect | undefined;
          if (mode === 'element') {
            const el = this.resolveTargetElement(msg.payload['selector']);
            const rect = el.getBoundingClientRect();
            targetRect = {
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height,
            };
          } else if (
            mode === 'area' &&
            typeof msg.payload['rect'] === 'object' &&
            msg.payload['rect'] !== null
          ) {
            const r = msg.payload['rect'] as Record<string, number>;
            targetRect = {
              x: r['x'] ?? 0,
              y: r['y'] ?? 0,
              width: r['width'] ?? 400,
              height: r['height'] ?? 300,
            };
          }

          if (msg.payload['planOnly'] === true) {
            const plan = buildCapturePlan({
              mode,
              viewportWidth: this.win.innerWidth || 1280,
              viewportHeight: this.win.innerHeight || 800,
              documentWidth: Math.max(
                this.doc.documentElement.scrollWidth || 0,
                this.win.innerWidth || 1280,
              ),
              documentHeight: Math.max(
                this.doc.documentElement.scrollHeight || 0,
                this.win.innerHeight || 800,
              ),
              currentScrollX: this.win.scrollX,
              currentScrollY: this.win.scrollY,
              devicePixelRatio: this.win.devicePixelRatio || 1,
              ...(targetRect ? { targetRect } : {}),
            });
            return createSuccessResponse(msg, { plan }, this.documentId);
          }

          if (!this.adapters.captureViewportTab) {
            return createErrorResponse(
              msg.requestId,
              'TOOL_EXECUTION_ERROR',
              'Real browser tab capture must be executed through the background service worker',
              msg.operation,
            );
          }

          const coordinated = await executeDomCaptureCoordinator({
            doc: this.doc,
            win: this.win,
            mode,
            ...(targetRect ? { targetRect } : {}),
            minIntervalMs: 10,
            lazyWaitMs: 10,
            captureViewportTab: this.adapters.captureViewportTab,
          });
          return createSuccessResponse(msg, { coordinated }, this.documentId);
        }

        case 'SET_RESPONSIVE_SYNC': {
          this.responsiveSyncEnabled = msg.payload['enabled'] === true;
          if (!this.responsiveSyncEnabled && this.scrollEmitTimer !== null) {
            clearTimeout(this.scrollEmitTimer);
            this.scrollEmitTimer = null;
          }
          return createSuccessResponse(
            msg,
            { responsiveSyncEnabled: this.responsiveSyncEnabled },
            this.documentId,
          );
        }

        case 'SYNC_SCROLL': {
          const xRatio =
            typeof msg.payload['scrollXRatio'] === 'number' ? msg.payload['scrollXRatio'] : 0;
          const yRatio =
            typeof msg.payload['scrollYRatio'] === 'number' ? msg.payload['scrollYRatio'] : 0;
          const maxScrollX = Math.max(
            0,
            (this.doc.documentElement.scrollWidth || 0) - (this.win.innerWidth || 0),
          );
          const maxScrollY = Math.max(
            0,
            (this.doc.documentElement.scrollHeight || 0) - (this.win.innerHeight || 0),
          );
          this.suppressScrollEmitUntilMs = Date.now() + 260;
          this.win.scrollTo(Math.round(xRatio * maxScrollX), Math.round(yRatio * maxScrollY));
          return createSuccessResponse(
            msg,
            { scrollX: this.win.scrollX, scrollY: this.win.scrollY },
            this.documentId,
          );
        }

        default:
          return createErrorResponse(
            msg.requestId,
            'INVALID_MESSAGE',
            `Operation ${msg.operation} is not handled by the content script`,
            msg.operation,
          );
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Tool execution error';
      return createErrorResponse(
        msg.requestId,
        'TOOL_EXECUTION_ERROR',
        errorMessage,
        msg.operation,
      );
    }
  }
}

function sanitizePreviewSnippet(el: Element): string {
  return strFromU8(new TextEncoder().encode(el.outerHTML.slice(0, 500)));
}

function bootstrapContentScript(): void {
  const chromeGlobal = (globalThis as unknown as { chrome?: { runtime?: ChromeRuntimeLike } })
    .chrome;
  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    !chromeGlobal?.runtime?.onMessage
  ) {
    return;
  }

  const existing = (window as unknown as { __pagesiftContentRuntime?: ContentScriptRuntime })
    .__pagesiftContentRuntime;
  if (existing) {
    return;
  }

  const runtime = new ContentScriptRuntime(document, window, {
    sendBackgroundMessage: (message) => {
      if (!chromeGlobal.runtime?.sendMessage) {
        return Promise.reject(new Error('chrome.runtime.sendMessage unavailable'));
      }
      return chromeGlobal.runtime.sendMessage(message);
    },
  });
  runtime.init();
  (
    window as unknown as { __pagesiftContentRuntime?: ContentScriptRuntime }
  ).__pagesiftContentRuntime = runtime;

  chromeGlobal.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    void runtime.handleMessage(message).then((response) => {
      sendResponse(response);
    });
    return true;
  });
}

bootstrapContentScript();
