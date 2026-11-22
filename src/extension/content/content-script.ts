import { strFromU8 } from 'fflate';
import {
  buildAssetsZipArchive,
  extractPageAssets,
  type AssetBinaryFetcher,
} from '../engines/assets-engine.js';
import {
  buildCapturePlan,
  encodeBytesToBase64,
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
import type { ActivityQueryItem } from '../storage/activity-history.js';
import {
  OnPageOverlayDashboard,
  type OverlayCustomizationState,
  type OverlayEditOptions,
  type OverlayToolSummary,
} from './overlay-dashboard.js';

interface ChromeRuntimeLike {
  id?: string;
  getURL?: (path: string) => string;
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
  'TOGGLE_OVERLAY_DASHBOARD',
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
  private overlayShadow: ShadowRoot | null = null;
  private overlayDashboard: OnPageOverlayDashboard | null = null;
  private hoverBox: HTMLElement | null = null;
  private hoverBadge: HTMLElement | null = null;
  private selectedBox: HTMLElement | null = null;
  private selectedBadge: HTMLElement | null = null;
  private measureLineBox: HTMLElement | null = null;
  private measureBadge: HTMLElement | null = null;
  private onPageDock: HTMLElement | null = null;
  private dockStatusEl: HTMLElement | null = null;
  private restoreOverlayAfterPick = false;
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
    if (event.key !== 'Escape') {
      return;
    }
    if (this.activeTool !== null) {
      const shouldRestore = this.restoreOverlayAfterPick;
      this.restoreOverlayAfterPick = false;
      this.stopInteractivePickerOnly();
      if (shouldRestore && this.overlayDashboard) {
        this.overlayDashboard.openExpanded();
      } else if (!this.overlayDashboard || this.overlayDashboard.getMode() === 'closed') {
        this.deactivateInteractiveTools();
      }
      return;
    }
    if (this.overlayDashboard && this.overlayDashboard.getMode() !== 'closed') {
      if (this.overlayDashboard.isPipMenuOpen()) {
        this.overlayDashboard.togglePipMenu(false);
        return;
      }
      this.closeOverlayAndHost();
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

    if (this.restoreOverlayAfterPick && this.overlayDashboard) {
      const pickedTool = this.activeTool;
      const shouldCompleteMeasure = pickedTool !== 'measure' || this.secondaryElement !== null;
      if (shouldCompleteMeasure) {
        this.restoreOverlayAfterPick = false;
        this.stopInteractivePickerOnly();
        if (pickedTool === 'edit_text' || pickedTool === 'swap_font' || pickedTool === 'arrange') {
          this.overlayDashboard.showEditor(
            pickedTool,
            buildShortSelector(target),
            target.textContent,
          );
          return;
        }
        void this.executeOverlayTool(pickedTool).then((summary) => {
          this.overlayDashboard?.openExpanded();
          if (summary) {
            this.overlayDashboard?.showResultSummary(summary);
          }
        });
      } else {
        this.overlayDashboard.setMinimizedStatus(
          `1st: ${buildShortSelector(target)} · Click 2nd element`,
        );
      }
    }
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
      this.ensureOverlayDom();
      const hoverEl = this.lastPointerTarget ?? target;
      if (hoverEl.isConnected && this.hoverBox && this.hoverBadge) {
        const rect = hoverEl.getBoundingClientRect();
        this.hoverBox.style.transform = `translate(${Math.round(rect.left)}px, ${Math.round(rect.top)}px)`;
        this.hoverBox.style.width = `${Math.max(0, Math.round(rect.width))}px`;
        this.hoverBox.style.height = `${Math.max(0, Math.round(rect.height))}px`;
        this.hoverBox.style.display = hoverEl === this.selectedElement ? 'none' : 'block';
        this.hoverBadge.style.top =
          rect.top < 28 ? `${Math.max(4, Math.round(rect.height) + 4)}px` : '-24px';
        this.hoverBadge.textContent = `${buildShortSelector(hoverEl)} · ${Math.round(rect.width)}×${Math.round(rect.height)}`;
      }
      if (this.selectedBox && this.selectedBadge) {
        if (this.selectedElement && this.selectedElement.isConnected) {
          const sRect = this.selectedElement.getBoundingClientRect();
          this.selectedBox.style.transform = `translate(${Math.round(sRect.left)}px, ${Math.round(sRect.top)}px)`;
          this.selectedBox.style.width = `${Math.max(0, Math.round(sRect.width))}px`;
          this.selectedBox.style.height = `${Math.max(0, Math.round(sRect.height))}px`;
          this.selectedBox.style.display = 'block';
          this.selectedBadge.style.top =
            sRect.top < 28 ? `${Math.max(4, Math.round(sRect.height) + 4)}px` : '-24px';
          this.selectedBadge.textContent = `Selected: ${buildShortSelector(this.selectedElement)} · ${Math.round(sRect.width)}×${Math.round(sRect.height)}`;
        } else {
          this.selectedBox.style.display = 'none';
        }
      }
      if (this.measureLineBox && this.measureBadge) {
        if (
          this.activeTool === 'measure' &&
          this.selectedElement &&
          this.selectedElement.isConnected &&
          this.secondaryElement &&
          this.secondaryElement.isConnected
        ) {
          const a = this.selectedElement.getBoundingClientRect();
          const b = this.secondaryElement.getBoundingClientRect();
          const hGap = Math.max(
            0,
            Math.round(
              a.right < b.left ? b.left - a.right : b.right < a.left ? a.left - b.right : 0,
            ),
          );
          const vGap = Math.max(
            0,
            Math.round(
              a.bottom < b.top ? b.top - a.bottom : b.bottom < a.top ? a.top - b.bottom : 0,
            ),
          );
          const midX = Math.round((a.left + a.width / 2 + (b.left + b.width / 2)) / 2);
          const midY = Math.round((a.top + a.height / 2 + (b.top + b.height / 2)) / 2);
          this.measureLineBox.style.transform = `translate(${midX}px, ${midY}px)`;
          this.measureLineBox.style.display = 'block';
          this.measureBadge.textContent = `Gap: ${hGap}px H · ${vGap}px V`;
        } else {
          this.measureLineBox.style.display = 'none';
        }
      }
      this.updateOnPageDockState();
    });
  }

  private updateOnPageDockState(): void {
    if (!this.dockStatusEl || !this.onPageDock) {
      return;
    }
    const toolName = this.activeTool ?? 'idle';
    const selLabel =
      this.selectedElement && this.selectedElement.isConnected
        ? buildShortSelector(this.selectedElement)
        : 'Click an element';
    this.dockStatusEl.textContent = `${toolName.replace('_', ' ')} · ${selLabel}`;
    this.onPageDock.querySelectorAll<HTMLButtonElement>('button[data-dock-tool]').forEach((btn) => {
      const active = btn.getAttribute('data-dock-tool') === this.activeTool;
      btn.style.backgroundColor = active ? '#0f766e' : 'transparent';
      btn.style.color = active ? '#ffffff' : '#cbd5e1';
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

    const hoverBox = this.doc.createElement('div');
    hoverBox.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    hoverBox.style.position = 'fixed';
    hoverBox.style.top = '0';
    hoverBox.style.left = '0';
    hoverBox.style.border = '1.5px dashed #2972ff';
    hoverBox.style.backgroundColor = 'rgba(0, 87, 255, 0.1)';
    hoverBox.style.pointerEvents = 'none';
    hoverBox.style.boxSizing = 'border-box';
    hoverBox.style.display = 'none';

    const hoverBadge = this.doc.createElement('div');
    hoverBadge.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    hoverBadge.style.position = 'absolute';
    hoverBadge.style.top = '-24px';
    hoverBadge.style.left = '0';
    hoverBadge.style.backgroundColor = '#00001e';
    hoverBadge.style.color = '#f4f6fb';
    hoverBadge.style.border = '1px solid #2972ff';
    hoverBadge.style.fontFamily = '"IBM Plex Mono", ui-monospace, monospace';
    hoverBadge.style.fontSize = '11px';
    hoverBadge.style.padding = '2px 6px';
    hoverBadge.style.borderRadius = '4px';
    hoverBadge.style.whiteSpace = 'nowrap';
    hoverBox.appendChild(hoverBadge);

    const selectedBox = this.doc.createElement('div');
    selectedBox.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    selectedBox.style.position = 'fixed';
    selectedBox.style.top = '0';
    selectedBox.style.left = '0';
    selectedBox.style.border = '2px solid #0057ff';
    selectedBox.style.boxShadow =
      '0 0 0 1px rgba(244, 246, 251, 0.9), inset 0 0 0 1px rgba(0, 0, 30, 0.5)';
    selectedBox.style.backgroundColor = 'rgba(0, 87, 255, 0.12)';
    selectedBox.style.pointerEvents = 'none';
    selectedBox.style.boxSizing = 'border-box';
    selectedBox.style.display = 'none';

    const selectedBadge = this.doc.createElement('div');
    selectedBadge.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    selectedBadge.style.position = 'absolute';
    selectedBadge.style.top = '-24px';
    selectedBadge.style.left = '0';
    selectedBadge.style.backgroundColor = '#18181b';
    selectedBadge.style.color = '#ffffff';
    selectedBadge.style.border = '1px solid #2563eb';
    selectedBadge.style.boxShadow = '0 4px 12px rgba(15, 23, 42, 0.18)';
    selectedBadge.style.fontFamily = '"IBM Plex Mono", ui-monospace, monospace';
    selectedBadge.style.fontSize = '11px';
    selectedBadge.style.fontWeight = '600';
    selectedBadge.style.padding = '2px 7px';
    selectedBadge.style.borderRadius = '4px';
    selectedBadge.style.whiteSpace = 'nowrap';
    selectedBox.appendChild(selectedBadge);

    const measureLineBox = this.doc.createElement('div');
    measureLineBox.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    measureLineBox.style.position = 'fixed';
    measureLineBox.style.top = '0';
    measureLineBox.style.left = '0';
    measureLineBox.style.pointerEvents = 'none';
    measureLineBox.style.display = 'none';

    const measureBadge = this.doc.createElement('div');
    measureBadge.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    measureBadge.style.backgroundColor = '#18181b';
    measureBadge.style.color = '#ffffff';
    measureBadge.style.border = '1px solid #2563eb';
    measureBadge.style.boxShadow = '0 4px 12px rgba(15, 23, 42, 0.18)';
    measureBadge.style.fontFamily = '"IBM Plex Mono", ui-monospace, monospace';
    measureBadge.style.fontSize = '11px';
    measureBadge.style.fontWeight = '600';
    measureBadge.style.padding = '3px 8px';
    measureBadge.style.borderRadius = '4px';
    measureBadge.style.whiteSpace = 'nowrap';
    measureBadge.style.transform = 'translate(-50%, -50%)';
    measureLineBox.appendChild(measureBadge);

    const dock = this.doc.createElement('div');
    dock.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    dock.setAttribute('role', 'toolbar');
    dock.setAttribute('aria-label', 'PageSift on-page dock');
    dock.style.position = 'fixed';
    dock.style.left = '0';
    dock.style.right = '0';
    dock.style.bottom = '18px';
    dock.style.margin = '0 auto';
    dock.style.width = 'fit-content';
    dock.style.display = 'flex';
    dock.style.alignItems = 'center';
    dock.style.gap = '6px';
    dock.style.padding = '6px 10px';
    dock.style.borderRadius = '8px';
    dock.style.backgroundColor = '#ffffff';
    dock.style.color = '#111827';
    dock.style.border = '1px solid #e5e7eb';
    dock.style.boxShadow = '0 12px 32px rgba(15, 23, 42, 0.12), 0 2px 6px rgba(15, 23, 42, 0.05)';
    dock.style.fontFamily = '"Instrument Sans", system-ui, -apple-system, sans-serif';
    dock.style.fontSize = '12.5px';
    dock.style.pointerEvents = 'auto';

    const brandDot = this.doc.createElement('span');
    brandDot.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    brandDot.style.width = '7px';
    brandDot.style.height = '7px';
    brandDot.style.borderRadius = '2px';
    brandDot.style.backgroundColor = '#0f766e';
    dock.appendChild(brandDot);

    const statusEl = this.doc.createElement('span');
    statusEl.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    statusEl.style.fontFamily = '"IBM Plex Mono", ui-monospace, monospace';
    statusEl.style.fontSize = '12px';
    statusEl.style.color = '#374151';
    statusEl.style.maxWidth = '180px';
    statusEl.style.overflow = 'hidden';
    statusEl.style.textOverflow = 'ellipsis';
    statusEl.style.whiteSpace = 'nowrap';
    statusEl.textContent = 'PageSift';
    dock.appendChild(statusEl);

    const dockTools: Array<{ id: ToolId; label: string }> = [
      { id: 'inspect', label: 'Inspect' },
      { id: 'measure', label: 'Measure' },
      { id: 'edit_text', label: 'Edit' },
      { id: 'arrange', label: 'Arrange' },
    ];
    for (const item of dockTools) {
      const btn = this.doc.createElement('button');
      btn.type = 'button';
      btn.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
      btn.setAttribute('data-dock-tool', item.id);
      btn.textContent = item.label;
      btn.style.border = '1px solid #e5e7eb';
      btn.style.borderRadius = '6px';
      btn.style.padding = '4px 9px';
      btn.style.fontSize = '12px';
      btn.style.fontWeight = '600';
      btn.style.cursor = 'pointer';
      btn.style.backgroundColor = '#f5f6f8';
      btn.style.color = '#111827';
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.activeTool = item.id;
        this.updateOnPageDockState();
      });
      dock.appendChild(btn);
    }

    const closeBtn = this.doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    closeBtn.setAttribute('aria-label', 'Dismiss PageSift overlay (Escape)');
    closeBtn.textContent = 'Esc';
    closeBtn.style.border = '1px solid #18181b';
    closeBtn.style.borderRadius = '6px';
    closeBtn.style.padding = '4px 9px';
    closeBtn.style.fontSize = '12px';
    closeBtn.style.fontWeight = '600';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.backgroundColor = '#18181b';
    closeBtn.style.color = '#ffffff';
    closeBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.deactivateInteractiveTools();
    });
    dock.appendChild(closeBtn);

    shadow.appendChild(hoverBox);
    shadow.appendChild(selectedBox);
    shadow.appendChild(measureLineBox);
    shadow.appendChild(dock);
    this.doc.documentElement.appendChild(host);

    this.overlayHost = host;
    this.overlayShadow = shadow;
    this.hoverBox = hoverBox;
    this.hoverBadge = hoverBadge;
    this.selectedBox = selectedBox;
    this.selectedBadge = selectedBadge;
    this.measureLineBox = measureLineBox;
    this.measureBadge = measureBadge;
    this.onPageDock = dock;
    this.dockStatusEl = statusEl;
    this.updateOnPageDockState();
  }

  private ensureOverlayDashboard(): OnPageOverlayDashboard {
    this.ensureOverlayDom();
    if (!this.overlayShadow) {
      throw new Error('Overlay shadow root unavailable');
    }
    if (!this.overlayDashboard) {
      const chromeApi = (globalThis as unknown as { chrome?: { runtime?: ChromeRuntimeLike } })
        .chrome;
      this.overlayDashboard = new OnPageOverlayDashboard(this.doc, this.overlayShadow, {
        getPageInfo: () => ({
          title: this.doc.title || 'Untitled Page',
          url: this.doc.location.href,
          hostname: this.doc.location.hostname || 'local',
        }),
        getResourceUrl: (relPath) =>
          chromeApi?.runtime?.getURL ? chromeApi.runtime.getURL(relPath) : null,
        getInteractiveSnapshotHtml: () => {
          const prepared = prepareStaticPageClone(this.doc, this.win, {});
          const combinedCss = prepared.cssBlocks.map((b) => b.cssText).join('\n');
          return prepared.sanitizedHtmlTemplate.replace(
            '</head>',
            `<style>${combinedCss.replace(/<\/style/gi, '<\\/style')}</style></head>`,
          );
        },
        onRunOverlayTool: (tool, options) => this.executeOverlayTool(tool, options),
        onEditHistoryCommand: (command) => {
          if (command === 'EDIT_UNDO') this.editController.undo();
          else if (command === 'EDIT_REDO') this.editController.redo();
          else this.editController.resetAll();
          const st = this.editController.getStatus();
          return Promise.resolve({
            ok: true,
            message: `${command.replace('EDIT_', '')} applied (undo stack: ${st.undoCount}, redo: ${st.redoCount}).`,
          });
        },
        onSaveCustomization: async (next) => {
          if (!this.adapters.sendBackgroundMessage) {
            return;
          }
          await this.adapters
            .sendBackgroundMessage({
              schemaVersion: 1,
              requestId: `ov-cust-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              operation: 'UPDATE_OVERLAY_CUSTOMIZATION',
              documentId: this.documentId,
              payload: {
                ...(next.theme ? { theme: next.theme } : {}),
                ...(next.position ? { overlayPosition: next.position } : {}),
                ...(next.themeMode ? { overlayThemeMode: next.themeMode } : {}),
                ...(next.pinnedTools ? { overlayPinnedTools: next.pinnedTools } : {}),
              },
            })
            .catch(() => undefined);
        },
        onOpenSettings: async () => {
          if (!this.adapters.sendBackgroundMessage) {
            return;
          }
          await this.adapters
            .sendBackgroundMessage({
              schemaVersion: 1,
              requestId: `open-opt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              operation: 'OPEN_OPTIONS_PAGE',
              documentId: this.documentId,
              payload: {},
            })
            .catch(() => undefined);
        },
        onOpenSiteResponsiveWindows: async () => {
          if (!this.adapters.sendBackgroundMessage) {
            return { ok: false, message: 'Background channel unavailable.' };
          }
          const res = await this.adapters
            .sendBackgroundMessage({
              schemaVersion: 1,
              requestId: `ov-resp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              operation: 'OPEN_SITE_RESPONSIVE_WINDOWS',
              documentId: this.documentId,
              payload: { syncEnabled: true },
            })
            .catch(() => null);
          if (!res || !res.ok) {
            return {
              ok: false,
              message: res?.error.message ?? 'Could not open responsive browser windows.',
            };
          }
          const data = res.data as { openedTabIds?: number[] };
          return {
            ok: true,
            message: `Opened ${(data.openedTabIds ?? []).length} synced viewport window(s).`,
          };
        },
        onStartPickerForTool: (tool) => {
          this.restoreOverlayAfterPick = true;
          this.activeTool = tool;
          if (this.onPageDock) {
            this.onPageDock.style.display = 'none';
          }
          this.doc.addEventListener('mousemove', this.handlePointerMove, true);
          this.doc.addEventListener('click', this.handleClick, true);
        },
        onOpenFullDashboard: async (opts) => {
          if (!this.adapters.sendBackgroundMessage) {
            return;
          }
          await this.adapters
            .sendBackgroundMessage({
              schemaVersion: 1,
              requestId: `open-dash-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              operation: 'OPEN_FULL_DASHBOARD',
              documentId: this.documentId,
              payload: {
                ...(opts?.tool ? { tool: opts.tool } : {}),
                ...(opts?.autorun ? { autorun: true } : {}),
                ...(opts?.section ? { section: opts.section } : {}),
              },
            })
            .catch(() => undefined);
        },
        onFetchSiteActivity: async (): Promise<ActivityQueryItem[]> => {
          if (!this.adapters.sendBackgroundMessage) {
            return [];
          }
          const res = await this.adapters
            .sendBackgroundMessage({
              schemaVersion: 1,
              requestId: `site-hist-${Date.now()}`,
              operation: 'LIST_SITE_ACTIVITY',
              documentId: this.documentId,
              payload: { limit: 6 },
            })
            .catch(() => null);
          if (!res || !res.ok) {
            return [];
          }
          const data = res.data as { items?: ActivityQueryItem[] };
          return Array.isArray(data.items) ? data.items : [];
        },
        onCloseOverlay: () => {
          this.closeOverlayAndHost();
        },
      });
    }
    return this.overlayDashboard;
  }

  private async syncOverlayThemeFromSettings(): Promise<void> {
    if (!this.adapters.sendBackgroundMessage || !this.overlayDashboard) {
      return;
    }
    try {
      const res = await this.adapters.sendBackgroundMessage({
        schemaVersion: 1,
        requestId: `overlay-theme-${Date.now()}`,
        operation: 'GET_SETTINGS',
        payload: {},
      });
      if (res.ok) {
        const settings = (
          res.data as {
            settings?: {
              theme?: string;
              overlayPosition?: OverlayCustomizationState['position'];
              overlayThemeMode?: OverlayCustomizationState['themeMode'];
              overlayPinnedTools?: ToolId[];
            };
          }
        ).settings;
        const theme = settings?.theme;
        if (theme === 'light') {
          this.overlayDashboard.setResolvedTheme('light');
        } else if (theme === 'system') {
          const prefersDark =
            typeof this.win.matchMedia === 'function'
              ? this.win.matchMedia('(prefers-color-scheme: dark)').matches
              : true;
          this.overlayDashboard.setResolvedTheme(prefersDark ? 'dark' : 'light');
        } else {
          this.overlayDashboard.setResolvedTheme('dark');
        }
        this.overlayDashboard.applyCustomization({
          ...(settings?.overlayPosition ? { position: settings.overlayPosition } : {}),
          ...(settings?.overlayThemeMode ? { themeMode: settings.overlayThemeMode } : {}),
          ...(settings?.overlayPinnedTools ? { pinnedTools: settings.overlayPinnedTools } : {}),
        });
      }
    } catch {
      return;
    }
  }

  public toggleOverlayDashboard(
    mode: 'toggle' | 'open' | 'close' | 'minimize' | 'action_click' | 'pip' = 'toggle',
  ): 'expanded' | 'minimized' | 'closed' {
    if (this.win.name === 'pagesift-responsive-frame') {
      return 'closed';
    }
    const currentMode = this.overlayDashboard?.getMode() ?? 'closed';
    if (mode === 'close' || (mode === 'toggle' && currentMode !== 'closed')) {
      this.closeOverlayAndHost();
      return 'closed';
    }
    const dash = this.ensureOverlayDashboard();
    if (this.onPageDock) {
      this.onPageDock.style.display = 'none';
    }
    void this.syncOverlayThemeFromSettings();
    if (mode === 'action_click') {
      return dash.handleToolbarActionClick();
    }
    if (mode === 'pip') {
      dash.togglePipMenu();
      return dash.getMode();
    }
    if (mode === 'minimize') {
      dash.minimize(this.doc.location.hostname || 'PageSift');
      return 'minimized';
    }
    dash.openExpanded();
    return 'expanded';
  }

  private stopInteractivePickerOnly(): void {
    this.activeTool = null;
    this.lastPointerTarget = null;
    this.doc.removeEventListener('mousemove', this.handlePointerMove, true);
    this.doc.removeEventListener('click', this.handleClick, true);
    if (this.hoverBox) this.hoverBox.style.display = 'none';
    if (this.selectedBox) this.selectedBox.style.display = 'none';
    if (this.measureLineBox) this.measureLineBox.style.display = 'none';
  }

  private closeOverlayAndHost(): void {
    this.restoreOverlayAfterPick = false;
    this.overlayDashboard?.close();
    this.overlayDashboard = null;
    this.deactivateInteractiveTools();
  }

  private async recordOverlayActivity(params: {
    activityId: string;
    tool: ToolId;
    actionLabel: string;
    status: 'completed' | 'failed';
    durationMs: number;
    optionsSummary?: Record<string, unknown>;
    resultSummary: string;
    errorCategory?: string;
  }): Promise<void> {
    if (!this.adapters.sendBackgroundMessage) {
      return;
    }
    await this.adapters
      .sendBackgroundMessage({
        schemaVersion: 1,
        requestId: `rec-act-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        operation: 'RECORD_LOCAL_ACTIVITY',
        documentId: this.documentId,
        payload: {
          activityId: params.activityId,
          tool: params.tool,
          actionLabel: params.actionLabel,
          pageTitle: this.doc.title || 'Untitled Page',
          status: params.status,
          durationMs: Math.max(0, Math.round(params.durationMs)),
          ...(params.optionsSummary ? { optionsSummary: params.optionsSummary } : {}),
          resultSummary: params.resultSummary,
          ...(params.errorCategory ? { errorCategory: params.errorCategory } : {}),
        },
      })
      .catch(() => undefined);
  }

  private async executeOverlayTool(
    tool: ToolId,
    options?: OverlayEditOptions,
  ): Promise<OverlayToolSummary | null> {
    const startMono = performance.now();
    const activityId = `ov-${tool}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      if (tool === 'inspect') {
        const target = this.resolveTargetElement();
        const report = inspectElement(target, this.win);
        const summaryText = `${report.selector} · ${Math.round(report.boundingBox.width)}×${Math.round(report.boundingBox.height)}px · ${report.typography.fontSize} ${report.typography.fontFamily.split(',')[0] ?? ''}`;
        await this.recordOverlayActivity({
          activityId,
          tool,
          actionLabel: 'Inspect Element',
          status: 'completed',
          durationMs: performance.now() - startMono,
          optionsSummary: { selector: report.selector },
          resultSummary: summaryText,
        });
        return {
          tool,
          title: `Inspected ${report.selector}`,
          summary: summaryText,
          copyableText: report.safeHtml,
        };
      }
      if (tool === 'measure') {
        const primary = this.resolveTargetElement();
        const report = measureElements(primary, this.secondaryElement, this.win);
        const summaryText = report.distance
          ? `${report.primary.selector} → ${report.secondary?.selector ?? ''}: ${report.distance.horizontalGap}px H, ${report.distance.verticalGap}px V`
          : `${report.primary.selector}: ${report.primary.width}×${report.primary.height}px`;
        await this.recordOverlayActivity({
          activityId,
          tool,
          actionLabel: 'Measure Elements',
          status: 'completed',
          durationMs: performance.now() - startMono,
          optionsSummary: { primarySelector: report.primary.selector },
          resultSummary: summaryText,
        });
        return {
          tool,
          title: 'Measurement',
          summary: summaryText,
          copyableText: JSON.stringify(report, null, 2),
        };
      }
      if (tool === 'colors') {
        const report = extractPageColors(this.doc, this.win);
        const summaryText = `${report.colors.length} colors, ${report.customProperties.length} CSS variables, ${report.gradients.length} gradients`;
        await this.recordOverlayActivity({
          activityId,
          tool,
          actionLabel: 'Extract Colors',
          status: 'completed',
          durationMs: performance.now() - startMono,
          optionsSummary: { format: 'cssVariables' },
          resultSummary: summaryText,
        });
        return {
          tool,
          title: 'Color Palette',
          summary: summaryText,
          copyableText: report.exports.cssVariables,
          downloadFilename: 'pagesift-colors.css',
          downloadMime: 'text/css;charset=utf-8',
          downloadText: report.exports.cssVariables,
        };
      }
      if (tool === 'fonts') {
        const report = extractPageFonts(this.doc, this.win);
        const topFam = report.families
          .slice(0, 3)
          .map((f) => f.primaryFamily)
          .join(', ');
        const summaryText = `${report.families.length} families (${topFam || 'system'}), ${report.fontFaceDeclarations.length} @font-face rules`;
        await this.recordOverlayActivity({
          activityId,
          tool,
          actionLabel: 'Inspect Fonts',
          status: 'completed',
          durationMs: performance.now() - startMono,
          resultSummary: summaryText,
        });
        return {
          tool,
          title: 'Typography',
          summary: summaryText,
          copyableText: JSON.stringify(report, null, 2),
        };
      }
      if (tool === 'clone_page') {
        const cloned = await exportStaticPageClone(this.doc, this.win, {
          ...(this.adapters.fetchAssetBinary ? { fetcher: this.adapters.fetchAssetBinary } : {}),
        });
        const summaryText = `${cloned.manifest.files.length} packaged files (${(cloned.zipBytes.byteLength / 1024).toFixed(1)} KiB sanitized ZIP)`;
        await this.recordOverlayActivity({
          activityId,
          tool,
          actionLabel: 'Clone Page Snapshot ZIP',
          status: 'completed',
          durationMs: performance.now() - startMono,
          resultSummary: summaryText,
        });
        return {
          tool,
          title: 'Clone Page ZIP Ready',
          summary: summaryText,
          downloadFilename: 'pagesift-clone.zip',
          downloadMime: 'application/zip',
          downloadBase64: encodeBytesToBase64(cloned.zipBytes),
        };
      }
      if (tool === 'assets') {
        const report = extractPageAssets(this.doc, this.win);
        const archived = await buildAssetsZipArchive(report, this.adapters.fetchAssetBinary);
        const summaryText = `${archived.packagedFilesCount} assets packaged from ${report.summary.totalDiscovered} discovered`;
        await this.recordOverlayActivity({
          activityId,
          tool,
          actionLabel: 'Extract Assets ZIP',
          status: 'completed',
          durationMs: performance.now() - startMono,
          resultSummary: summaryText,
        });
        return {
          tool,
          title: 'Assets Extracted',
          summary: summaryText,
          copyableText: JSON.stringify(report, null, 2),
          downloadFilename: 'pagesift-assets.zip',
          downloadMime: 'application/zip',
          downloadBase64: encodeBytesToBase64(archived.zipBytes),
        };
      }
      if (tool === 'capture') {
        if (!this.adapters.sendBackgroundMessage) {
          throw new Error('Background capture channel unavailable');
        }
        const capRes = await this.adapters.sendBackgroundMessage({
          schemaVersion: 1,
          requestId: activityId,
          operation: 'CAPTURE_OWN_TAB',
          documentId: this.documentId,
          payload: { format: 'image/png' },
        });
        if (!capRes.ok) {
          throw new Error(capRes.error.message);
        }
        const capData = capRes.data as { dataUrl: string; mimeType: string };
        const base64Part = capData.dataUrl.split(',')[1] ?? '';
        return {
          tool,
          title: 'Page Capture Ready',
          summary: 'Captured visible viewport as PNG locally.',
          imageDataUrl: capData.dataUrl,
          downloadFilename: 'pagesift-capture.png',
          downloadMime: capData.mimeType || 'image/png',
          downloadBase64: base64Part,
        };
      }
      if (tool === 'design_md') {
        const snap = extractPageDesignSnapshot(this.doc, this.win);
        const res = generateDesignMdFromPages([snap]);
        const summaryText = `Generated DESIGN.md (${res.markdown.length.toLocaleString()} chars)`;
        await this.recordOverlayActivity({
          activityId,
          tool,
          actionLabel: 'Generate DESIGN.md',
          status: 'completed',
          durationMs: performance.now() - startMono,
          resultSummary: summaryText,
        });
        return {
          tool,
          title: 'DESIGN.md Ready',
          summary: summaryText,
          copyableText: res.markdown,
          downloadFilename: 'DESIGN.md',
          downloadMime: 'text/markdown;charset=utf-8',
          downloadText: res.markdown,
        };
      }
      if (tool === 'clone_prompt') {
        const report = generateLocalClonePrompt(this.doc, this.win, 'react_tailwind');
        const summaryText = `Generated React + Tailwind brief (${report.prompt.length.toLocaleString()} chars)`;
        await this.recordOverlayActivity({
          activityId,
          tool,
          actionLabel: 'Generate Clone Prompt',
          status: 'completed',
          durationMs: performance.now() - startMono,
          optionsSummary: { targetFramework: 'react_tailwind' },
          resultSummary: summaryText,
        });
        return {
          tool,
          title: 'Clone Prompt Ready',
          summary: summaryText,
          copyableText: report.prompt,
          downloadFilename: 'pagesift-clone-prompt.md',
          downloadMime: 'text/markdown;charset=utf-8',
          downloadText: report.prompt,
        };
      }
      if (tool === 'design_review') {
        const report = runLocalDesignReview(this.doc, this.win);
        const summaryText = `${report.findings.length} findings (${report.metrics.contrastFailuresCount} contrast issues)`;
        await this.recordOverlayActivity({
          activityId,
          tool,
          actionLabel: 'Design Review',
          status: 'completed',
          durationMs: performance.now() - startMono,
          resultSummary: summaryText,
        });
        return {
          tool,
          title: 'Design Review',
          summary: summaryText,
          copyableText: report.localFixPrompt,
        };
      }
      if (tool === 'tech_stack') {
        const report = detectPageTechStack(this.doc);
        const summaryText = report.organizedSummary.oneLiner;
        await this.recordOverlayActivity({
          activityId,
          tool,
          actionLabel: 'Detect Tech Stack',
          status: 'completed',
          durationMs: performance.now() - startMono,
          resultSummary: summaryText,
        });
        return {
          tool,
          title: `Tech Stack (${report.detections.length} Detected)`,
          summary: summaryText,
          techStackSummary: report.organizedSummary,
          copyableText: JSON.stringify(report.organizedSummary, null, 2),
        };
      }
      if (tool === 'edit_text') {
        const target = this.resolveTargetElement();
        const selector = buildShortSelector(target);
        if (typeof options?.text !== 'string')
          throw new Error('Choose replacement text before applying a preview');
        this.editController.applyTextEdit(target, options.text);
        const summaryText = `Previewed text edit on ${selector} (reversible)`;
        await this.recordOverlayActivity({
          activityId,
          tool,
          actionLabel: 'Edit Text Preview',
          status: 'completed',
          durationMs: performance.now() - startMono,
          optionsSummary: { selector },
          resultSummary: summaryText,
        });
        return { tool, title: 'Edit Text Preview', summary: summaryText };
      }
      if (tool === 'swap_font') {
        const target = this.resolveTargetElement();
        const selector = buildShortSelector(target);
        this.editController.applyFontSwap({
          target,
          scope: 'element',
          fontFamily: options?.fontFamily ?? '',
        });
        const summaryText = `Swapped font on ${selector} to ${options?.fontFamily ?? ''} (reversible)`;
        await this.recordOverlayActivity({
          activityId,
          tool,
          actionLabel: 'Swap Font Preview',
          status: 'completed',
          durationMs: performance.now() - startMono,
          optionsSummary: { selector, fontFamily: options?.fontFamily ?? '' },
          resultSummary: summaryText,
        });
        return { tool, title: 'Swap Font Preview', summary: summaryText };
      }
      if (tool === 'arrange') {
        const target = this.resolveTargetElement();
        const selector = buildShortSelector(target);
        this.editController.applyArrangeMutation({
          target,
          action: options?.action ?? 'move',
          dx: options?.dx ?? 0,
          dy: options?.dy ?? 0,
        });
        const summaryText = `${options?.action === 'hide' ? 'Hid' : options?.action === 'remove' ? 'Removed from layout' : 'Moved'} ${selector}${!options?.action || options.action === 'move' ? ` by ${options?.dx ?? 0}px, ${options?.dy ?? 0}px` : ''} (reversible)`;
        await this.recordOverlayActivity({
          activityId,
          tool,
          actionLabel: 'Arrange Element',
          status: 'completed',
          durationMs: performance.now() - startMono,
          optionsSummary: { selector, action: options?.action ?? 'move' },
          resultSummary: summaryText,
        });
        return { tool, title: 'Arrange Preview', summary: summaryText };
      }
      return null;
    } catch (err: unknown) {
      const msgText = err instanceof Error ? err.message : 'Tool execution failed';
      await this.recordOverlayActivity({
        activityId,
        tool,
        actionLabel: tool,
        status: 'failed',
        durationMs: performance.now() - startMono,
        resultSummary: msgText,
        errorCategory: 'TOOL_EXECUTION_ERROR',
      });
      return { tool, title: 'Action failed', summary: msgText };
    }
  }

  public activateInteractiveTool(tool: ToolId): void {
    this.activeTool = tool;
    this.ensureOverlayDom();
    if (
      this.onPageDock &&
      (!this.overlayDashboard || this.overlayDashboard.getMode() === 'closed')
    ) {
      this.onPageDock.style.display = 'flex';
    }
    this.updateOnPageDockState();
    this.doc.addEventListener('mousemove', this.handlePointerMove, true);
    this.doc.addEventListener('click', this.handleClick, true);
  }

  public deactivateInteractiveTools(): void {
    this.activeTool = null;
    this.lastPointerTarget = null;
    this.restoreOverlayAfterPick = false;
    this.overlayDashboard?.close();
    this.overlayDashboard = null;
    this.doc.removeEventListener('mousemove', this.handlePointerMove, true);
    this.doc.removeEventListener('click', this.handleClick, true);
    if (this.overlayHost && this.overlayHost.isConnected) {
      this.overlayHost.remove();
    }
    this.overlayHost = null;
    this.overlayShadow = null;
    this.hoverBox = null;
    this.hoverBadge = null;
    this.selectedBox = null;
    this.selectedBadge = null;
    this.measureLineBox = null;
    this.measureBadge = null;
    this.onPageDock = null;
    this.dockStatusEl = null;
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

        case 'TOGGLE_OVERLAY_DASHBOARD': {
          const reqMode =
            (msg.payload['mode'] as
              | 'toggle'
              | 'open'
              | 'close'
              | 'minimize'
              | 'action_click'
              | 'pip'
              | undefined) ?? 'toggle';
          const nextMode = this.toggleOverlayDashboard(reqMode);
          return createSuccessResponse(
            msg,
            { overlayMode: nextMode, documentId: this.documentId },
            this.documentId,
          );
        }

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
