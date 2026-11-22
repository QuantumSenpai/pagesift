import type {
  TechStackDetectionEntry,
  TechStackOrganizedSummary,
} from '../engines/tech-stack-engine.js';
import type { ToolId } from '../protocol/messages.js';
import type { ActivityQueryItem } from '../storage/activity-history.js';
import type { ExtensionSettings } from '../storage/settings-storage.js';
import {
  createSvgIcon,
  createTechCategoryIcon,
  createTechIconElement,
  triggerTapFeedback,
} from '../ui/theme.js';

export type OverlayMode = 'closed' | 'expanded' | 'minimized';
export type OverlayDrawerTab = 'none' | 'tools' | 'result' | 'editor' | 'customize' | 'responsive';
export type OverlayPosition = ExtensionSettings['overlayPosition'];
export type OverlayThemeMode = ExtensionSettings['overlayThemeMode'];

export interface OverlayToolSummary {
  tool: ToolId;
  title: string;
  summary: string;
  techStackSummary?: TechStackOrganizedSummary;
  techStackDetections?: TechStackDetectionEntry[];
  imageDataUrl?: string;
  copyableText?: string;
  downloadFilename?: string;
  downloadMime?: string;
  downloadText?: string;
  downloadBase64?: string;
}

export interface OverlayCustomizationState {
  position: OverlayPosition;
  themeMode: OverlayThemeMode;
  pinnedTools: ToolId[];
}

export interface OverlayEditOptions {
  text?: string;
  fontFamily?: string;
  action?: 'move' | 'hide' | 'remove';
  dx?: number;
  dy?: number;
}

export interface OverlayDashboardCallbacks {
  getPageInfo: () => { hostname: string; url: string; title: string };
  getResourceUrl: (path: string) => string | null;
  getInteractiveSnapshotHtml?: () => string;
  onCloseOverlay: () => void;
  onStartPickerForTool: (tool: ToolId) => void;
  onRunOverlayTool: (
    tool: ToolId,
    options?: OverlayEditOptions,
  ) => Promise<OverlayToolSummary | null>;
  onOpenFullDashboard: (options?: {
    tool?: ToolId;
    autorun?: boolean;
    section?: 'tools' | 'history' | 'saved' | 'settings';
  }) => Promise<void>;
  onOpenSettings?: () => Promise<void>;
  onOpenSiteResponsiveWindows?: () => Promise<{ ok: boolean; message: string }>;
  onFetchSiteActivity: () => Promise<ActivityQueryItem[]>;
  onSaveCustomization?: (
    next: Partial<OverlayCustomizationState> & { theme?: ExtensionSettings['theme'] },
  ) => Promise<void>;
  onEditHistoryCommand?: (
    command: 'EDIT_UNDO' | 'EDIT_REDO' | 'EDIT_RESET',
  ) => Promise<{ ok: boolean; message: string }>;
}

interface OverlayToolDef {
  id: ToolId;
  label: string;
  group: string;
  keywords: string;
  isPicker?: boolean;
  isResponsiveStage?: boolean;
  badgeText?: string;
}

const OVERLAY_TOOLS: OverlayToolDef[] = [
  {
    id: 'inspect',
    label: 'Inspect',
    group: 'Inspect & Measure',
    keywords: 'css box dom styles',
    isPicker: true,
  },
  {
    id: 'clone_page',
    label: 'Clone Page',
    group: 'Extract & Export',
    keywords: 'zip snapshot html sanitize',
  },
  {
    id: 'clone_prompt',
    label: 'Clone Prompt',
    group: 'Extract & Export',
    keywords: 'prompt react brief',
  },
  {
    id: 'design_md',
    label: 'Design MD',
    group: 'Extract & Export',
    keywords: 'design system markdown',
  },
  {
    id: 'assets',
    label: 'Assets',
    group: 'Extract & Export',
    keywords: 'images svg zip media',
  },
  {
    id: 'colors',
    label: 'Colors',
    group: 'Inspect & Measure',
    keywords: 'palette hex swatch tokens',
  },
  {
    id: 'fonts',
    label: 'Fonts',
    group: 'Inspect & Measure',
    keywords: 'typography font-face family',
  },
  {
    id: 'measure',
    label: 'Measure',
    group: 'Inspect & Measure',
    keywords: 'distance gap spacing',
    isPicker: true,
  },
  {
    id: 'edit_text',
    label: 'Edit Text',
    group: 'Live Preview & Audit',
    keywords: 'copy preview inline edit',
    isPicker: true,
  },
  {
    id: 'capture',
    label: 'Capture',
    group: 'Capture & Viewports',
    keywords: 'screenshot png pdf full page',
  },
  {
    id: 'responsive',
    label: 'Responsive',
    group: 'Capture & Viewports',
    keywords: 'mobile tablet viewport sync interactive preview',
    isResponsiveStage: true,
  },
  {
    id: 'swap_font',
    label: 'Swap Font',
    group: 'Live Preview & Audit',
    keywords: 'font swap preview',
    isPicker: true,
  },
  {
    id: 'arrange',
    label: 'Arrange',
    group: 'Live Preview & Audit',
    keywords: 'move hide remove layout',
    isPicker: true,
  },
  {
    id: 'design_review',
    label: 'Design Review',
    group: 'Live Preview & Audit',
    keywords: 'wcag contrast audit spacing ai slop',
    badgeText: 'Beta',
  },
  {
    id: 'tech_stack',
    label: 'Tech Stack',
    group: 'Inspect & Measure',
    keywords: 'framework stack next react tailwind',
  },
];

const OVERLAY_GROUPS = [
  'Inspect & Measure',
  'Extract & Export',
  'Capture & Viewports',
  'Live Preview & Audit',
];

const RESPONSIVE_STAGE_PRESETS = [
  { id: 'mobile', label: 'Mobile', width: 375, height: 812 },
  { id: 'tablet', label: 'Tablet', width: 768, height: 1024 },
  { id: 'laptop', label: 'Laptop', width: 1280, height: 800 },
] as const;

const PAGESIFT_ROOT_ATTR = 'data-pagesift-root';

function formatRelativeTime(utcIso: string): string {
  const diffSec = Math.max(0, Math.round((Date.now() - new Date(utcIso).getTime()) / 1000));
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  return new Date(utcIso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export class OnPageOverlayDashboard {
  private readonly doc: Document;
  private readonly shadow: ShadowRoot;
  private readonly callbacks: OverlayDashboardCallbacks;

  private mode: OverlayMode = 'closed';
  private drawerTab: OverlayDrawerTab = 'none';
  private pipMenuOpen = false;
  private resolvedTheme: 'light' | 'dark' = 'dark';
  private customization: OverlayCustomizationState = {
    position: 'bottom-center',
    themeMode: 'follow',
    pinnedTools: ['inspect', 'tech_stack', 'colors', 'fonts', 'responsive'],
  };
  private activeFilter = '';
  private busy = false;
  private lastSummary: OverlayToolSummary | null = null;
  private editorState: {
    tool: 'edit_text' | 'swap_font' | 'arrange';
    selector: string;
    initialValue: string;
    statusText?: string;
  } | null = null;

  private respWidth = 375;
  private respHeight = 812;
  private respLayout: 'single' | 'grid' = 'single';
  private respSourceMode: 'live' | 'snapshot' = 'live';
  private respScale = 0.72;
  private respStatusMsg = 'Interactive preview active inside overlay.';

  private anchor: HTMLElement | null = null;
  private stage: HTMLElement | null = null;
  private dockBar: HTMLElement | null = null;
  private toolsStrip: HTMLElement | null = null;
  private themeToggleBtn: HTMLButtonElement | null = null;
  private pipMenuEl: HTMLElement | null = null;
  private pipBtn: HTMLButtonElement | null = null;
  private minBar: HTMLElement | null = null;
  private drawer: HTMLElement | null = null;
  private drawerContent: HTMLElement | null = null;
  private allToolsBtn: HTMLButtonElement | null = null;
  private minStatusText: HTMLElement | null = null;

  public constructor(doc: Document, shadow: ShadowRoot, callbacks: OverlayDashboardCallbacks) {
    this.doc = doc;
    this.shadow = shadow;
    this.callbacks = callbacks;
    this.mountDom();
  }

  public getMode(): OverlayMode {
    return this.mode;
  }

  public isPipMenuOpen(): boolean {
    return this.pipMenuOpen;
  }

  public setResolvedTheme(theme: 'light' | 'dark'): void {
    this.resolvedTheme = theme;
    const effective = this.getEffectiveTheme();
    this.anchor?.setAttribute('data-theme', effective);
    this.syncThemeButtonIcon();
    if (this.pipMenuOpen) {
      this.renderPipMenu();
    }
  }

  public getEffectiveTheme(): 'light' | 'dark' {
    return this.customization.themeMode === 'follow'
      ? this.resolvedTheme
      : this.customization.themeMode;
  }

  public applyCustomization(next: Partial<OverlayCustomizationState>): void {
    this.customization = {
      position: next.position ?? this.customization.position,
      themeMode: next.themeMode ?? this.customization.themeMode,
      pinnedTools:
        Array.isArray(next.pinnedTools) && next.pinnedTools.length >= 3
          ? next.pinnedTools.slice(0, 6)
          : this.customization.pinnedTools,
    };
    this.syncAnchorPlacement();
    this.setResolvedTheme(this.resolvedTheme);
    if (this.drawerTab === 'customize') {
      this.renderDrawer();
    }
  }

  public openExpanded(openDrawer = false): void {
    this.mode = 'expanded';
    this.pipMenuOpen = false;
    this.syncPipVisibility();
    if (this.dockBar) {
      this.dockBar.style.display = 'flex';
      this.dockBar.classList.remove('ps-enter');
      void this.dockBar.getBoundingClientRect();
      this.dockBar.classList.add('ps-enter');
    }
    if (this.minBar) {
      this.minBar.style.display = 'none';
    }
    if (openDrawer) {
      this.drawerTab = 'tools';
      this.renderDrawer();
    } else if (this.drawerTab === 'none') {
      this.syncDrawerVisibility();
    }
  }

  public togglePipMenu(force?: boolean): boolean {
    if (this.mode === 'closed') {
      this.openExpanded(false);
    }
    const next = force ?? !this.pipMenuOpen;
    this.pipMenuOpen = next;
    if (next) {
      this.renderPipMenu();
    }
    this.syncPipVisibility();
    return this.pipMenuOpen;
  }

  public handleToolbarActionClick(): 'expanded' | 'minimized' | 'closed' {
    if (this.mode === 'closed') {
      this.openExpanded(false);
      return 'expanded';
    }
    this.togglePipMenu();
    return this.mode;
  }

  public minimize(statusText?: string): void {
    this.mode = 'minimized';
    this.drawerTab = 'none';
    this.pipMenuOpen = false;
    this.syncPipVisibility();
    this.syncDrawerVisibility();
    if (this.dockBar) {
      this.dockBar.style.display = 'none';
    }
    if (this.minBar) {
      this.minBar.style.display = 'flex';
      this.minBar.classList.remove('ps-enter');
      void this.minBar.getBoundingClientRect();
      this.minBar.classList.add('ps-enter');
    }
    if (this.minStatusText && statusText) {
      this.minStatusText.textContent = statusText;
    }
  }

  public setMinimizedStatus(statusText: string): void {
    if (this.minStatusText) {
      this.minStatusText.textContent = statusText;
    }
  }

  public showResultSummary(summary: OverlayToolSummary): void {
    this.lastSummary = summary;
    this.drawerTab = 'result';
    this.pipMenuOpen = false;
    this.syncPipVisibility();
    if (this.mode !== 'expanded') {
      this.openExpanded(false);
    }
    this.renderDrawer();
  }

  public showResponsivePreview(): void {
    this.drawerTab = 'responsive';
    this.pipMenuOpen = false;
    this.syncPipVisibility();
    if (this.mode !== 'expanded') {
      this.openExpanded(false);
    }
    this.renderDrawer();
  }

  public showEditor(
    tool: 'edit_text' | 'swap_font' | 'arrange',
    selector: string,
    currentText: string,
  ): void {
    this.editorState = {
      tool,
      selector,
      initialValue: tool === 'edit_text' ? currentText.trim().slice(0, 240) : 'Georgia, serif',
    };
    this.drawerTab = 'editor';
    this.openExpanded(false);
    this.renderDrawer();
  }

  public close(): void {
    this.mode = 'closed';
    this.drawerTab = 'none';
    this.pipMenuOpen = false;
    this.anchor?.remove();
    this.anchor = null;
    this.stage = null;
    this.dockBar = null;
    this.toolsStrip = null;
    this.themeToggleBtn = null;
    this.pipMenuEl = null;
    this.pipBtn = null;
    this.minBar = null;
    this.drawer = null;
    this.drawerContent = null;
    this.allToolsBtn = null;
    this.minStatusText = null;
  }

  private syncAnchorPlacement(): void {
    if (!this.anchor) return;
    this.anchor.setAttribute('data-pos', this.customization.position);
  }

  private syncThemeButtonIcon(): void {
    if (!this.themeToggleBtn) return;
    const effective = this.getEffectiveTheme();
    this.themeToggleBtn.textContent = '';
    this.themeToggleBtn.appendChild(
      createSvgIcon(effective === 'dark' ? 'sun' : 'moon', '', this.doc),
    );
    this.themeToggleBtn.setAttribute(
      'aria-label',
      effective === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
    );
    this.themeToggleBtn.title = effective === 'dark' ? 'Switch to Light' : 'Switch to Dark';
  }

  private syncPipVisibility(): void {
    this.pipMenuEl?.classList.toggle('open', this.pipMenuOpen);
    this.pipBtn?.classList.toggle('active', this.pipMenuOpen);
  }

  private toggleQuickTheme(): void {
    const current = this.getEffectiveTheme();
    const next: 'light' | 'dark' = current === 'dark' ? 'light' : 'dark';
    this.customization.themeMode = 'follow';
    this.setResolvedTheme(next);
    void this.callbacks.onSaveCustomization?.({ theme: next, themeMode: 'follow' });
  }

  private mountDom(): void {
    const fontsCss = ['400', '500', '600', '700']
      .map((w) => {
        const u = this.callbacks.getResourceUrl(`fonts/instrument-sans-${w}.woff2`);
        return u
          ? `@font-face{font-family:'Instrument Sans';font-style:normal;font-weight:${w};font-display:swap;src:url('${u}') format('woff2');}`
          : '';
      })
      .join('');
    const monoCss = ['400', '500', '600']
      .map((w) => {
        const u = this.callbacks.getResourceUrl(`fonts/ibm-plex-mono-${w}.woff2`);
        return u
          ? `@font-face{font-family:'IBM Plex Mono';font-style:normal;font-weight:${w};font-display:swap;src:url('${u}') format('woff2');}`
          : '';
      })
      .join('');

    const styleEl = this.doc.createElement('style');
    styleEl.textContent = `
      ${fontsCss}${monoCss}
      .ps-anchor {
        --bg: #121218;
        --elevated: #1b1c25;
        --subtle: #252735;
        --border: #2c2e3b;
        --border-strong: #46435e;
        --text: #f4f4f5;
        --secondary: #d4d4d8;
        --muted: #9ca3af;
        --ink: #f4f4f5;
        --ink-hover: #e4e4e7;
        --ink-fg: #111827;
        --accent: #2563eb;
        --accent-hover: #3b82f6;
        --accent-surface: #172554;
        --accent-border: #1e40af;
        --accent-text: #93c5fd;
        --beta-bg: #2a2440;
        --beta-border: #4c4175;
        --beta-text: #c4b5fd;
        --positive: #14b8a6;
        --positive-surface: #042f2e;
        --positive-border: #115e59;
        --shadow-sm: 0 3px 8px rgba(0, 0, 0, 0.36);
        --shadow-md: 0 10px 26px rgba(0, 0, 0, 0.48);
        --shadow-lg: 0 22px 54px rgba(0, 0, 0, 0.68), 0 4px 16px rgba(0, 0, 0, 0.42);
        --ease: cubic-bezier(0.22, 1, 0.36, 1);
        position: fixed;
        bottom: 16px;
        left: 0;
        right: 0;
        margin: 0 auto;
        width: fit-content;
        max-width: calc(100vw - 20px);
        z-index: 2147483647;
        pointer-events: none;
        font-family: "Instrument Sans", system-ui, -apple-system, sans-serif;
        font-size: 13px;
        line-height: 1.4;
        color: var(--text);
      }
      .ps-anchor[data-theme="light"] {
        --bg: #ffffff;
        --elevated: #f5f6f8;
        --subtle: #eef0f4;
        --border: #e5e7eb;
        --border-strong: #d1d5db;
        --text: #111827;
        --secondary: #374151;
        --muted: #6b7280;
        --ink: #18181b;
        --ink-hover: #27272a;
        --ink-fg: #ffffff;
        --accent: #2563eb;
        --accent-hover: #1d4ed8;
        --accent-surface: #eff6ff;
        --accent-border: #bfdbfe;
        --accent-text: #1d4ed8;
        --beta-bg: #eef2ff;
        --beta-border: #c7d2fe;
        --beta-text: #4338ca;
        --positive: #0f766e;
        --positive-surface: #f0fdfa;
        --positive-border: #99f6e4;
        --shadow-sm: 0 2px 6px rgba(15, 23, 42, 0.06), 0 1px 2px rgba(15, 23, 42, 0.04);
        --shadow-md: 0 8px 22px rgba(15, 23, 42, 0.1), 0 2px 6px rgba(15, 23, 42, 0.05);
        --shadow-lg: 0 18px 42px rgba(15, 23, 42, 0.16), 0 4px 12px rgba(15, 23, 42, 0.07);
      }
      .ps-anchor[data-pos="bottom-right"] {
        left: auto;
        right: 18px;
        margin: 0;
      }
      .ps-anchor[data-pos="top-center"] {
        top: 16px;
        bottom: auto;
      }
      .ps-anchor * { box-sizing: border-box; }
      .ps-stage {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        max-width: 100%;
      }
      .ps-anchor[data-pos="bottom-right"] .ps-stage {
        align-items: flex-end;
      }
      .ps-anchor[data-pos="top-center"] .ps-stage {
        flex-direction: column-reverse;
      }
      .ps-dock {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-wrap: nowrap;
        gap: 4px;
        padding: 5px 8px;
        background: var(--bg);
        border: 1px solid var(--border-strong);
        border-radius: 10px;
        box-shadow: var(--shadow-lg);
        pointer-events: auto;
        max-width: 100%;
      }
      .ps-tools-strip {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-wrap: nowrap;
        gap: 2px;
      }
      .ps-dock-divider {
        width: 1px;
        height: 26px;
        background: var(--border);
        margin: 0 5px;
        flex: 0 0 auto;
      }
      .ps-actions-strip {
        display: flex;
        align-items: center;
        gap: 2px;
        flex: 0 0 auto;
      }
      .ps-dock-tool {
        position: relative;
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 3px;
        min-width: 48px;
        padding: 5px 6px;
        border-radius: 6px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--secondary);
        font-family: inherit;
        font-size: 10.5px;
        font-weight: 500;
        line-height: 1.15;
        cursor: pointer;
        white-space: nowrap;
        transition:
          background-color 120ms var(--ease),
          border-color 120ms var(--ease),
          color 120ms var(--ease),
          transform 120ms var(--ease),
          box-shadow 120ms var(--ease);
      }
      .ps-dock-tool svg {
        width: 16px;
        height: 16px;
        flex: 0 0 auto;
      }
      @media (max-width: 1120px) {
        .ps-dock,
        .ps-tools-strip {
          flex-wrap: wrap;
        }
      }
      .ps-dock-tool:hover {
        background: var(--elevated);
        border-color: var(--border);
        color: var(--text);
        transform: translateY(-1px);
        box-shadow: var(--shadow-sm);
      }
      .ps-dock-tool:active {
        transform: translateY(1px) scale(0.97);
      }
      .ps-dock-tool.active {
        background: var(--accent-surface);
        border-color: var(--accent-border);
        color: var(--accent-text);
        font-weight: 600;
      }
      .ps-dock-tool.tap-confirm,
      .ps-icon-btn.tap-confirm,
      .ps-btn.tap-confirm {
        animation: ps-tap 210ms var(--ease);
      }
      .ps-beta-badge {
        position: absolute;
        top: 1px;
        right: 2px;
        padding: 1px 4px;
        border-radius: 4px;
        border: 1px solid var(--beta-border);
        background: var(--beta-bg);
        color: var(--beta-text);
        font-size: 9px;
        font-weight: 600;
        line-height: 1.1;
        letter-spacing: 0.01em;
      }
      .ps-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 36px;
        border-radius: 7px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--secondary);
        cursor: pointer;
        transition:
          background-color 120ms var(--ease),
          border-color 120ms var(--ease),
          color 120ms var(--ease),
          transform 120ms var(--ease);
      }
      .ps-icon-btn svg {
        width: 16px;
        height: 16px;
      }
      .ps-icon-btn:hover {
        background: var(--elevated);
        border-color: var(--border);
        color: var(--text);
        transform: translateY(-1px);
      }
      .ps-icon-btn:active {
        transform: translateY(1px) scale(0.96);
      }
      .ps-icon-btn.active {
        background: var(--accent-surface);
        border-color: var(--accent-border);
        color: var(--accent-text);
      }
      .ps-pip-menu {
        display: none;
        position: absolute;
        bottom: calc(100% + 10px);
        right: 0;
        width: 268px;
        padding: 10px;
        background: var(--bg);
        border: 1px solid var(--border-strong);
        border-radius: 10px;
        box-shadow: var(--shadow-lg);
        pointer-events: auto;
        z-index: 4;
      }
      .ps-anchor[data-pos="top-center"] .ps-pip-menu {
        bottom: auto;
        top: calc(100% + 10px);
      }
      .ps-pip-menu.open {
        display: flex;
        flex-direction: column;
        gap: 6px;
        animation: ps-rise 160ms var(--ease);
      }
      .ps-pip-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 4px 4px 8px;
        border-bottom: 1px solid var(--border);
      }
      .ps-pip-brand {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        font-weight: 600;
        font-size: 12.5px;
      }
      .ps-pip-brand img {
        width: 18px;
        height: 18px;
        border-radius: 4px;
      }
      .ps-pip-item {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 9px;
        width: 100%;
        min-height: 34px;
        padding: 6px 10px;
        border-radius: 6px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--text);
        font-family: inherit;
        font-size: 12.5px;
        font-weight: 500;
        cursor: pointer;
        text-align: left;
        transition:
          background-color 120ms var(--ease),
          border-color 120ms var(--ease),
          transform 120ms var(--ease);
      }
      .ps-pip-item svg {
        width: 15px;
        height: 15px;
        color: var(--muted);
        flex: 0 0 auto;
      }
      .ps-pip-item:hover {
        background: var(--elevated);
        border-color: var(--border);
        transform: translateX(1px);
      }
      .ps-minbar {
        display: none;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        background: var(--bg);
        border: 1px solid var(--border-strong);
        border-radius: 8px;
        box-shadow: var(--shadow-lg);
        pointer-events: auto;
        max-width: 100%;
      }
      .ps-drawer {
        display: none;
        width: min(760px, calc(100vw - 24px));
        max-height: min(64vh, 540px);
        overflow-y: auto;
        background: var(--bg);
        border: 1px solid var(--border-strong);
        border-radius: 10px;
        box-shadow: var(--shadow-lg);
        pointer-events: auto;
        padding: 14px;
      }
      .ps-drawer.ps-drawer-wide {
        width: min(1060px, calc(100vw - 24px));
        max-height: min(76vh, 720px);
      }
      .ps-drawer.open {
        display: block;
        animation: ps-rise 180ms var(--ease);
      }
      .ps-enter {
        animation: ps-rise 180ms var(--ease);
      }
      @keyframes ps-rise {
        from { opacity: 0; transform: translateY(6px) scale(0.985); }
        to { opacity: 1; transform: none; }
      }
      @keyframes ps-tap {
        0% { transform: scale(0.96); }
        60% { transform: scale(1.02); }
        100% { transform: scale(1); }
      }
      .ps-sq-dot {
        width: 7px;
        height: 7px;
        border-radius: 2px;
        background: var(--positive);
        flex: 0 0 auto;
      }
      .ps-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: 31px;
        padding: 4px 10px;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: var(--elevated);
        color: var(--text);
        font-family: inherit;
        font-size: 12.5px;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        box-shadow: var(--shadow-sm);
        transition:
          background-color 120ms var(--ease),
          border-color 120ms var(--ease),
          box-shadow 120ms var(--ease),
          transform 120ms var(--ease);
      }
      .ps-btn svg {
        width: 14px;
        height: 14px;
        flex: 0 0 auto;
      }
      .ps-btn:hover {
        background: var(--subtle);
        border-color: var(--border-strong);
        box-shadow: var(--shadow-md);
        transform: translateY(-1px);
      }
      .ps-btn:active {
        transform: translateY(1px) scale(0.975);
        box-shadow: var(--shadow-sm);
      }
      .ps-btn.active {
        background: var(--accent-surface);
        border-color: var(--accent-border);
        color: var(--accent-text);
        font-weight: 600;
      }
      .ps-btn.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: #ffffff;
        font-weight: 600;
      }
      .ps-btn.primary:hover {
        background: var(--accent-hover);
        border-color: var(--accent-hover);
      }
      .ps-btn.ink {
        background: var(--ink);
        border-color: var(--ink);
        color: var(--ink-fg);
        font-weight: 600;
      }
      .ps-btn.ink:hover {
        background: var(--ink-hover);
        border-color: var(--ink-hover);
      }
      .ps-btn.ghost {
        background: transparent;
        border-color: transparent;
        color: var(--muted);
        box-shadow: none;
        padding: 4px 8px;
      }
      .ps-btn.ghost:hover {
        background: var(--subtle);
        color: var(--text);
        box-shadow: none;
        transform: none;
      }
      .ps-search {
        width: 100%;
        min-height: 34px;
        padding: 6px 11px;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: var(--elevated);
        color: var(--text);
        font-family: inherit;
        font-size: 13px;
        box-shadow: var(--shadow-sm);
        outline: none;
        margin-bottom: 10px;
      }
      .ps-search:focus {
        border-color: var(--accent);
        background: var(--bg);
      }
      .ps-group-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--muted);
        margin: 10px 0 6px;
      }
      .ps-tool-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
        gap: 6px;
      }
      .ps-tile-icon {
        width: 18px;
        height: 18px;
        border-radius: 4px;
        background: var(--accent-surface);
        border: 1px solid var(--accent-border);
        color: var(--accent-text);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
      }
      .ps-tile-icon svg {
        width: 12px;
        height: 12px;
      }
      .ps-tag {
        display: inline-flex;
        align-items: center;
        padding: 2px 7px;
        border-radius: 4px;
        border: 1px solid var(--border);
        background: var(--elevated);
        color: var(--secondary);
        font-size: 11.5px;
        font-weight: 500;
      }
      .ps-tag.positive {
        background: var(--positive-surface);
        border-color: var(--positive-border);
        color: var(--positive);
      }
      .ps-tag.accent {
        background: var(--accent-surface);
        border-color: var(--accent-border);
        color: var(--accent-text);
      }
      .ps-drawer-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        flex-wrap: wrap;
        padding-bottom: 10px;
        margin-bottom: 10px;
        border-bottom: 1px solid var(--border);
      }
      .ps-drawer-title {
        font-size: 14px;
        font-weight: 600;
        color: var(--text);
      }
      .ps-stack-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(225px, 1fr));
        gap: 8px;
        margin: 10px 0;
      }
      .ps-stack-card {
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: var(--elevated);
        box-shadow: var(--shadow-sm);
        display: flex;
        flex-direction: column;
        gap: 7px;
      }
      .ps-stack-card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding-bottom: 5px;
        border-bottom: 1px solid var(--border);
      }
      .tech-cat-heading {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12.5px;
        font-weight: 600;
      }
      .tech-cat-icon {
        width: 14px;
        height: 14px;
        color: var(--accent-text);
        flex: 0 0 auto;
      }
      .ps-stack-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 12.5px;
      }
      .tech-row-left {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .tech-badge-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 5px;
        border: 1px solid var(--border-strong);
        background: var(--bg);
        color: var(--text);
        flex: 0 0 auto;
      }
      .ps-site-list {
        display: flex;
        flex-direction: column;
        gap: 5px;
        margin-top: 8px;
      }
      .ps-site-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 12px;
        padding: 5px 8px;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: var(--elevated);
      }
      .ps-min-text {
        font-family: "IBM Plex Mono", ui-monospace, monospace;
        font-size: 12px;
        color: var(--secondary);
        max-width: 220px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ps-field {
        width: 100%;
        min-height: 34px;
        padding: 6px 10px;
        border-radius: 6px;
        border: 1px solid var(--border-strong);
        background: var(--elevated);
        color: var(--text);
        font-family: inherit;
        font-size: 13px;
      }
      .ps-resp-toolbar {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 10px;
      }
      .ps-num {
        width: 72px;
        min-height: 31px;
        padding: 4px 8px;
        border-radius: 6px;
        border: 1px solid var(--border-strong);
        background: var(--elevated);
        color: var(--text);
        font-family: "IBM Plex Mono", ui-monospace, monospace;
        font-size: 12px;
      }
      .ps-resp-stage {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        justify-content: center;
        gap: 14px;
        padding: 12px;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: var(--elevated);
        overflow: auto;
        max-height: 52vh;
      }
      .ps-device-shell {
        display: flex;
        flex-direction: column;
        gap: 6px;
        background: var(--bg);
        border: 1px solid var(--border-strong);
        border-radius: 8px;
        padding: 8px;
        box-shadow: var(--shadow-md);
      }
      .ps-device-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 11.5px;
        font-family: "IBM Plex Mono", ui-monospace, monospace;
        color: var(--muted);
      }
      .ps-device-viewport {
        overflow: hidden;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: #ffffff;
        position: relative;
      }
      .ps-resp-iframe {
        display: block;
        border: 0;
        background: #ffffff;
        transform-origin: top left;
      }
      .ps-capture-preview {
        display: block;
        max-width: 100%;
        max-height: 280px;
        margin-top: 10px;
        border-radius: 6px;
        border: 1px solid var(--border-strong);
        box-shadow: var(--shadow-md);
      }
      @media (prefers-reduced-motion: reduce) {
        * { transition: none !important; animation: none !important; }
      }
    `;

    const anchor = this.doc.createElement('div');
    anchor.className = 'ps-anchor';
    anchor.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    anchor.setAttribute('data-theme', this.getEffectiveTheme());
    anchor.setAttribute('data-pos', this.customization.position);
    anchor.appendChild(styleEl);

    anchor.addEventListener(
      'click',
      (ev) => {
        triggerTapFeedback(ev.target);
      },
      true,
    );

    const stage = this.doc.createElement('div');
    stage.className = 'ps-stage';
    stage.setAttribute(PAGESIFT_ROOT_ATTR, 'true');

    const drawer = this.doc.createElement('section');
    drawer.className = 'ps-drawer';
    drawer.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    drawer.setAttribute('role', 'region');
    drawer.setAttribute('aria-label', 'PageSift Overlay Panel');
    const drawerContent = this.doc.createElement('div');
    drawerContent.className = 'ps-drawer-content';
    drawer.appendChild(drawerContent);
    stage.appendChild(drawer);

    const pipMenu = this.doc.createElement('div');
    pipMenu.className = 'ps-pip-menu';
    pipMenu.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    pipMenu.setAttribute('role', 'dialog');
    pipMenu.setAttribute('aria-label', 'PageSift Quick Menu');
    stage.appendChild(pipMenu);

    const dockBar = this.doc.createElement('div');
    dockBar.className = 'ps-dock ps-panel';
    dockBar.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    dockBar.setAttribute('role', 'toolbar');
    dockBar.setAttribute('aria-label', 'PageSift Horizontal Command Bar');

    const toolsStrip = this.doc.createElement('div');
    toolsStrip.className = 'ps-tools-strip';
    for (const def of OVERLAY_TOOLS) {
      const btn = this.doc.createElement('button');
      btn.type = 'button';
      btn.className = 'ps-dock-tool';
      btn.setAttribute('data-overlay-bar-tool', def.id);
      btn.setAttribute('data-overlay-tool', def.id);
      btn.title = def.label;
      btn.appendChild(createSvgIcon(def.id, '', this.doc));
      const lbl = this.doc.createElement('span');
      lbl.textContent = def.label;
      btn.appendChild(lbl);
      if (def.badgeText) {
        const b = this.doc.createElement('span');
        b.className = 'ps-beta-badge';
        b.textContent = def.badgeText;
        btn.appendChild(b);
      }
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void this.handleToolClick(def);
      });
      toolsStrip.appendChild(btn);
    }
    dockBar.appendChild(toolsStrip);

    const divider = this.doc.createElement('div');
    divider.className = 'ps-dock-divider';
    dockBar.appendChild(divider);

    const actionsStrip = this.doc.createElement('div');
    actionsStrip.className = 'ps-actions-strip';

    const pipBtn = this.doc.createElement('button');
    pipBtn.type = 'button';
    pipBtn.className = 'ps-icon-btn';
    pipBtn.setAttribute('data-ps-action', 'pip-menu');
    pipBtn.setAttribute('aria-label', 'Open quick menu and settings');
    pipBtn.title = 'Quick Menu & Settings';
    pipBtn.appendChild(createSvgIcon('user', '', this.doc));
    pipBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.togglePipMenu();
    });

    const themeBtn = this.doc.createElement('button');
    themeBtn.type = 'button';
    themeBtn.className = 'ps-icon-btn';
    themeBtn.setAttribute('data-ps-action', 'toggle-theme');
    themeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.toggleQuickTheme();
    });

    const allToolsBtn = this.doc.createElement('button');
    allToolsBtn.type = 'button';
    allToolsBtn.className = 'ps-icon-btn';
    allToolsBtn.setAttribute('data-ps-action', 'toggle-tools');
    allToolsBtn.setAttribute('aria-label', 'Search tools and site activity');
    allToolsBtn.title = 'Tools & Site Activity';
    allToolsBtn.appendChild(createSvgIcon('grid', '', this.doc));
    allToolsBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.pipMenuOpen = false;
      this.syncPipVisibility();
      this.drawerTab = this.drawerTab === 'tools' ? 'none' : 'tools';
      this.renderDrawer();
    });

    const minBtn = this.doc.createElement('button');
    minBtn.type = 'button';
    minBtn.className = 'ps-icon-btn';
    minBtn.setAttribute('data-ps-action', 'minimize');
    minBtn.setAttribute('aria-label', 'Minimize overlay');
    minBtn.title = 'Minimize';
    minBtn.appendChild(createSvgIcon('minus', '', this.doc));
    minBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const pageInfo = this.callbacks.getPageInfo();
      this.minimize(pageInfo.hostname || 'PageSift');
    });

    const closeBtn = this.doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ps-icon-btn';
    closeBtn.setAttribute('data-ps-action', 'close');
    closeBtn.setAttribute('aria-label', 'Close overlay');
    closeBtn.title = 'Close';
    closeBtn.appendChild(createSvgIcon('close', '', this.doc));
    closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.callbacks.onCloseOverlay();
    });

    actionsStrip.append(pipBtn, themeBtn, allToolsBtn, minBtn, closeBtn);
    dockBar.appendChild(actionsStrip);
    stage.appendChild(dockBar);

    const minBar = this.doc.createElement('div');
    minBar.className = 'ps-minbar';
    minBar.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    minBar.setAttribute('role', 'toolbar');
    minBar.setAttribute('aria-label', 'PageSift minimized bar');

    const mDot = this.doc.createElement('span');
    mDot.className = 'ps-sq-dot';
    const minText = this.doc.createElement('span');
    minText.className = 'ps-min-text';
    minText.textContent = this.callbacks.getPageInfo().hostname || 'PageSift';

    const expandBtn = this.doc.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'ps-btn ink';
    expandBtn.setAttribute('data-ps-action', 'expand');
    expandBtn.textContent = 'Expand';
    expandBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.openExpanded();
    });

    const minDashBtn = this.doc.createElement('button');
    minDashBtn.type = 'button';
    minDashBtn.className = 'ps-btn';
    minDashBtn.setAttribute('data-ps-action', 'open-dashboard-min');
    minDashBtn.textContent = 'Dashboard';
    minDashBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void this.callbacks.onOpenFullDashboard();
    });

    const minCloseBtn = this.doc.createElement('button');
    minCloseBtn.type = 'button';
    minCloseBtn.className = 'ps-btn ghost';
    minCloseBtn.setAttribute('aria-label', 'Close overlay');
    minCloseBtn.textContent = 'Esc';
    minCloseBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.callbacks.onCloseOverlay();
    });

    minBar.append(mDot, minText, expandBtn, minDashBtn, minCloseBtn);
    stage.appendChild(minBar);

    anchor.appendChild(stage);
    this.shadow.appendChild(anchor);

    this.anchor = anchor;
    this.stage = stage;
    this.dockBar = dockBar;
    this.toolsStrip = toolsStrip;
    this.themeToggleBtn = themeBtn;
    this.pipMenuEl = pipMenu;
    this.pipBtn = pipBtn;
    this.minBar = minBar;
    this.drawer = drawer;
    this.drawerContent = drawerContent;
    this.allToolsBtn = allToolsBtn;
    this.minStatusText = minText;

    this.syncThemeButtonIcon();
  }

  private renderPipMenu(): void {
    if (!this.pipMenuEl) return;
    this.pipMenuEl.textContent = '';

    const info = this.callbacks.getPageInfo();
    const head = this.doc.createElement('div');
    head.className = 'ps-pip-head';

    const brand = this.doc.createElement('div');
    brand.className = 'ps-pip-brand';
    const iconUrl = this.callbacks.getResourceUrl('icons/icon-32.png');
    if (iconUrl) {
      const img = this.doc.createElement('img');
      img.src = iconUrl;
      img.alt = 'PageSift';
      brand.appendChild(img);
    }
    const hostSpan = this.doc.createElement('span');
    hostSpan.textContent = info.hostname || 'PageSift';
    brand.appendChild(hostSpan);

    const themeTag = this.doc.createElement('span');
    themeTag.className = 'ps-tag accent';
    themeTag.textContent = this.getEffectiveTheme() === 'dark' ? 'Dark' : 'Light';
    head.append(brand, themeTag);
    this.pipMenuEl.appendChild(head);

    const addAction = (
      label: string,
      iconName: string,
      actionAttr: string,
      onClick: () => void,
    ): void => {
      const btn = this.doc.createElement('button');
      btn.type = 'button';
      btn.className = 'ps-pip-item';
      btn.setAttribute('data-ps-action', actionAttr);
      btn.appendChild(createSvgIcon(iconName, '', this.doc));
      btn.appendChild(this.doc.createTextNode(label));
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onClick();
      });
      this.pipMenuEl?.appendChild(btn);
    };

    addAction('Settings & API Keys', 'settings', 'open-settings', () => {
      this.pipMenuOpen = false;
      this.syncPipVisibility();
      if (this.callbacks.onOpenSettings) {
        void this.callbacks.onOpenSettings();
      } else {
        void this.callbacks.onOpenFullDashboard({ section: 'settings' });
      }
    });

    addAction('Open Full Dashboard', 'external', 'open-dashboard', () => {
      this.pipMenuOpen = false;
      this.syncPipVisibility();
      void this.callbacks.onOpenFullDashboard();
    });

    addAction('Responsive Interactive View', 'responsive', 'open-responsive-stage', () => {
      this.showResponsivePreview();
    });

    addAction('Customize Dock', 'sliders', 'customize', () => {
      this.pipMenuOpen = false;
      this.syncPipVisibility();
      this.drawerTab = 'customize';
      this.renderDrawer();
    });

    const isDark = this.getEffectiveTheme() === 'dark';
    addAction(
      isDark ? 'Switch to Light Theme' : 'Switch to Dark Theme',
      isDark ? 'sun' : 'moon',
      'pip-toggle-theme',
      () => {
        this.toggleQuickTheme();
      },
    );

    addAction('Close Overlay', 'close', 'pip-close-overlay', () => {
      this.callbacks.onCloseOverlay();
    });
  }

  private syncDrawerVisibility(): void {
    const isOpen = this.mode === 'expanded' && this.drawerTab !== 'none';
    this.drawer?.classList.toggle('open', isOpen);
    this.drawer?.classList.toggle('ps-drawer-wide', this.drawerTab === 'responsive');
    this.allToolsBtn?.classList.toggle('active', this.drawerTab === 'tools');
    if (this.toolsStrip) {
      const buttons = this.toolsStrip.querySelectorAll<HTMLButtonElement>(
        'button[data-overlay-bar-tool]',
      );
      buttons.forEach((b) => {
        const id = b.getAttribute('data-overlay-bar-tool');
        const active =
          (this.drawerTab === 'responsive' && id === 'responsive') ||
          (this.drawerTab === 'result' && this.lastSummary?.tool === id) ||
          (this.drawerTab === 'editor' && this.editorState?.tool === id);
        b.classList.toggle('active', active);
      });
    }
  }

  private triggerDownloadFromSummary(s: OverlayToolSummary): void {
    const blob = s.downloadBase64
      ? new Blob([base64ToBytes(s.downloadBase64) as BlobPart], {
          type: s.downloadMime ?? 'application/zip',
        })
      : new Blob([s.downloadText ?? ''], {
          type: s.downloadMime ?? 'text/plain;charset=utf-8',
        });
    const url = URL.createObjectURL(blob);
    const a = this.doc.createElement('a');
    a.href = url;
    a.download = s.downloadFilename ?? 'pagesift-output.txt';
    a.style.display = 'none';
    this.doc.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 15000);
  }

  private renderResponsiveStageDrawer(): void {
    if (!this.drawerContent) return;
    const head = this.doc.createElement('div');
    head.className = 'ps-drawer-head';
    head.appendChild(
      this.createEl('span', 'ps-drawer-title', 'Direct Responsive & Interactive Preview'),
    );
    const headActs = this.doc.createElement('div');
    headActs.style.display = 'flex';
    headActs.style.gap = '6px';
    headActs.style.flexWrap = 'wrap';
    if (this.callbacks.onOpenSiteResponsiveWindows) {
      const openWinFn = this.callbacks.onOpenSiteResponsiveWindows;
      headActs.appendChild(
        this.createButton('Synced OS Windows', 'ps-btn', () => {
          this.respStatusMsg = 'Launching synced multi-viewport windows...';
          this.renderDrawer();
          void openWinFn().then((r) => {
            this.respStatusMsg = r.message;
            this.renderDrawer();
          });
        }),
      );
    }
    headActs.appendChild(
      this.createButton('Dashboard', 'ps-btn primary', () => {
        void this.callbacks.onOpenFullDashboard({ tool: 'responsive', autorun: false });
      }),
    );
    headActs.appendChild(
      this.createButton('Done', 'ps-btn ghost', () => {
        this.drawerTab = 'none';
        this.syncDrawerVisibility();
      }),
    );
    head.appendChild(headActs);
    this.drawerContent.appendChild(head);

    const toolbar = this.doc.createElement('div');
    toolbar.className = 'ps-resp-toolbar';

    for (const preset of RESPONSIVE_STAGE_PRESETS) {
      const active =
        this.respLayout === 'single' &&
        this.respWidth === preset.width &&
        this.respHeight === preset.height;
      const b = this.createButton(
        `${preset.label} ${preset.width}x${preset.height}`,
        active ? 'ps-btn active' : 'ps-btn',
        () => {
          this.respLayout = 'single';
          this.respWidth = preset.width;
          this.respHeight = preset.height;
          this.respScale = preset.width >= 1000 ? 0.56 : 0.72;
          this.renderDrawer();
        },
      );
      b.setAttribute('data-ps-resp-preset', preset.id);
      toolbar.appendChild(b);
    }

    const gridBtn = this.createButton(
      'Side-by-Side',
      this.respLayout === 'grid' ? 'ps-btn active' : 'ps-btn',
      () => {
        this.respLayout = this.respLayout === 'grid' ? 'single' : 'grid';
        this.renderDrawer();
      },
    );
    gridBtn.setAttribute('data-ps-resp-mode', 'grid');
    toolbar.appendChild(gridBtn);

    const rotateBtn = this.doc.createElement('button');
    rotateBtn.type = 'button';
    rotateBtn.className = 'ps-btn';
    rotateBtn.setAttribute('data-ps-resp-rotate', 'true');
    rotateBtn.appendChild(createSvgIcon('rotate', '', this.doc));
    rotateBtn.appendChild(this.doc.createTextNode('Rotate'));
    rotateBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.respLayout = 'single';
      const w = this.respWidth;
      this.respWidth = this.respHeight;
      this.respHeight = w;
      this.renderDrawer();
    });
    toolbar.appendChild(rotateBtn);

    const wInput = this.doc.createElement('input');
    wInput.type = 'number';
    wInput.min = '240';
    wInput.max = '2560';
    wInput.value = String(this.respWidth);
    wInput.className = 'ps-num';
    wInput.setAttribute('aria-label', 'Responsive width');
    wInput.setAttribute('data-ps-resp-width', 'true');

    const hInput = this.doc.createElement('input');
    hInput.type = 'number';
    hInput.min = '320';
    hInput.max = '2560';
    hInput.value = String(this.respHeight);
    hInput.className = 'ps-num';
    hInput.setAttribute('aria-label', 'Responsive height');
    hInput.setAttribute('data-ps-resp-height', 'true');

    const applyCustom = (): void => {
      const nextW = Math.max(240, Math.min(2560, Number.parseInt(wInput.value, 10) || 375));
      const nextH = Math.max(320, Math.min(2560, Number.parseInt(hInput.value, 10) || 812));
      this.respLayout = 'single';
      this.respWidth = nextW;
      this.respHeight = nextH;
      this.respScale = nextW >= 1000 ? 0.54 : 0.72;
      this.renderDrawer();
    };
    const applyBtn = this.createButton('Apply', 'ps-btn', applyCustom);
    applyBtn.setAttribute('data-ps-resp-apply', 'true');
    toolbar.append(wInput, this.createEl('span', undefined, 'x'), hInput, applyBtn);

    const sourceBtn = this.createButton(
      this.respSourceMode === 'live' ? 'Mode: Live Page' : 'Mode: Safe DOM Snapshot',
      'ps-btn',
      () => {
        this.respSourceMode = this.respSourceMode === 'live' ? 'snapshot' : 'live';
        this.respStatusMsg =
          this.respSourceMode === 'live'
            ? 'Live interactive URL mode (switch to Safe DOM Snapshot if a site blocks iframes).'
            : 'Interactive DOM snapshot mode rendered safely in srcdoc.';
        this.renderDrawer();
      },
    );
    sourceBtn.setAttribute('data-ps-resp-source', 'true');
    toolbar.appendChild(sourceBtn);

    this.drawerContent.appendChild(toolbar);

    const statusLine = this.createEl('div', undefined, this.respStatusMsg);
    statusLine.style.fontSize = '12px';
    statusLine.style.color = 'var(--muted)';
    statusLine.style.marginBottom = '8px';
    this.drawerContent.appendChild(statusLine);

    const stageBox = this.doc.createElement('div');
    stageBox.className = 'ps-resp-stage';

    const pageUrl = this.callbacks.getPageInfo().url;
    const frames =
      this.respLayout === 'grid'
        ? [
            { label: 'Mobile', width: 375, height: 812, scale: 0.52 },
            { label: 'Tablet', width: 768, height: 1024, scale: 0.44 },
          ]
        : [
            {
              label: `${this.respWidth}x${this.respHeight}`,
              width: this.respWidth,
              height: this.respHeight,
              scale: this.respScale,
            },
          ];

    for (const f of frames) {
      const shell = this.doc.createElement('div');
      shell.className = 'ps-device-shell';

      const dHead = this.doc.createElement('div');
      dHead.className = 'ps-device-head';
      dHead.appendChild(this.createEl('span', undefined, `${f.label} (${f.width}x${f.height}px)`));
      dHead.appendChild(this.createEl('span', undefined, `${Math.round(f.scale * 100)}% zoom`));
      shell.appendChild(dHead);

      const scaledW = Math.round(f.width * f.scale);
      const scaledH = Math.min(420, Math.round(f.height * f.scale));
      const viewport = this.doc.createElement('div');
      viewport.className = 'ps-device-viewport';
      viewport.style.width = `${scaledW}px`;
      viewport.style.height = `${scaledH}px`;

      const iframe = this.doc.createElement('iframe');
      iframe.className = 'ps-resp-iframe';
      iframe.name = 'pagesift-responsive-frame';
      iframe.title = `Responsive preview ${f.width} by ${f.height}`;
      iframe.style.width = `${f.width}px`;
      iframe.style.height = `${Math.round(scaledH / f.scale)}px`;
      iframe.style.transform = `scale(${f.scale})`;

      if (this.respSourceMode === 'snapshot' && this.callbacks.getInteractiveSnapshotHtml) {
        iframe.setAttribute('sandbox', 'allow-same-origin allow-forms');
        iframe.srcdoc = this.callbacks.getInteractiveSnapshotHtml();
      } else {
        iframe.src = pageUrl;
      }

      viewport.appendChild(iframe);
      shell.appendChild(viewport);
      stageBox.appendChild(shell);
    }

    this.drawerContent.appendChild(stageBox);
  }

  private renderDrawer(): void {
    this.syncDrawerVisibility();
    if (!this.drawerContent || this.drawerTab === 'none') {
      return;
    }
    this.drawerContent.textContent = '';

    if (this.drawerTab === 'responsive') {
      this.renderResponsiveStageDrawer();
      return;
    }

    if (this.drawerTab === 'tools') {
      const head = this.doc.createElement('div');
      head.className = 'ps-drawer-head';
      head.appendChild(this.createEl('span', 'ps-drawer-title', 'All 15 Local Tools'));
      const headBtns = this.doc.createElement('div');
      headBtns.style.display = 'flex';
      headBtns.style.gap = '6px';
      const customBtn = this.createButton('Customize', 'ps-btn', () => {
        this.drawerTab = 'customize';
        this.renderDrawer();
      });
      const histBtn = this.createButton('History', 'ps-btn', () => {
        void this.callbacks.onOpenFullDashboard({ section: 'history' });
      });
      const dashBtn = this.createButton('Dashboard', 'ps-btn primary', () => {
        void this.callbacks.onOpenFullDashboard();
      });
      const closePanel = this.createButton('Done', 'ps-btn ghost', () => {
        this.drawerTab = 'none';
        this.syncDrawerVisibility();
      });
      headBtns.append(customBtn, histBtn, dashBtn, closePanel);
      head.appendChild(headBtns);
      this.drawerContent.appendChild(head);

      const search = this.doc.createElement('input');
      search.type = 'search';
      search.className = 'ps-search';
      search.value = this.activeFilter;
      search.placeholder = 'Filter 15 tools...';
      search.setAttribute('aria-label', 'Filter tools');
      search.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
      });
      const gridContainer = this.doc.createElement('div');
      search.addEventListener('input', () => {
        this.activeFilter = search.value.trim().toLowerCase();
        this.fillToolsGrid(gridContainer);
      });
      this.drawerContent.appendChild(search);
      this.fillToolsGrid(gridContainer);
      this.drawerContent.appendChild(gridContainer);

      const siteSep = this.doc.createElement('div');
      siteSep.style.marginTop = '12px';
      siteSep.style.paddingTop = '10px';
      siteSep.style.borderTop = '1px solid var(--border)';
      siteSep.appendChild(this.createEl('div', 'ps-group-title', 'Recent on this site'));
      const siteList = this.doc.createElement('div');
      siteList.className = 'ps-site-list';
      siteSep.appendChild(siteList);
      this.drawerContent.appendChild(siteSep);

      void this.callbacks.onFetchSiteActivity().then((items) => {
        siteList.textContent = '';
        if (items.length === 0) {
          siteList.appendChild(
            this.createEl('span', 'muted', 'No PageSift actions recorded on this site yet.'),
          );
          return;
        }
        for (const item of items.slice(0, 4)) {
          const row = this.doc.createElement('div');
          row.className = 'ps-site-row';
          row.appendChild(
            this.createEl('span', undefined, `${item.actionLabel}: ${item.resultSummary}`),
          );
          row.appendChild(this.createEl('span', 'ps-tag', formatRelativeTime(item.startedAt)));
          siteList.appendChild(row);
        }
      });
      return;
    }

    if (this.drawerTab === 'result' && this.lastSummary) {
      const s = this.lastSummary;
      const head = this.doc.createElement('div');
      head.className = 'ps-drawer-head';
      head.appendChild(this.createEl('span', 'ps-drawer-title', s.title));
      const acts = this.doc.createElement('div');
      acts.style.display = 'flex';
      acts.style.gap = '6px';
      acts.style.flexWrap = 'wrap';
      if (s.copyableText) {
        const copyBtn = this.doc.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'ps-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          void navigator.clipboard.writeText(s.copyableText ?? '').then(() => {
            copyBtn.textContent = 'Copied';
            setTimeout(() => {
              copyBtn.textContent = 'Copy';
            }, 1200);
          });
        });
        acts.appendChild(copyBtn);
      }
      if ((s.downloadText || s.downloadBase64) && s.downloadFilename) {
        acts.appendChild(
          this.createButton('Download', 'ps-btn', () => {
            this.triggerDownloadFromSummary(s);
          }),
        );
      }
      acts.appendChild(
        this.createButton('Open in Dashboard', 'ps-btn primary', () => {
          void this.callbacks.onOpenFullDashboard({ tool: s.tool, autorun: true });
        }),
      );
      acts.appendChild(
        this.createButton('Close', 'ps-btn ghost', () => {
          this.drawerTab = 'none';
          this.syncDrawerVisibility();
        }),
      );
      head.appendChild(acts);
      this.drawerContent.appendChild(head);

      this.drawerContent.appendChild(this.createEl('div', undefined, s.summary));

      if (s.imageDataUrl) {
        const img = this.doc.createElement('img');
        img.src = s.imageDataUrl;
        img.alt = 'Captured page screenshot preview';
        img.className = 'ps-capture-preview';
        this.drawerContent.appendChild(img);
      }

      if (s.techStackSummary && s.techStackSummary.groups.length > 0) {
        const searchBox = this.doc.createElement('input');
        searchBox.type = 'search';
        searchBox.className = 'ps-search';
        searchBox.style.marginTop = '8px';
        searchBox.placeholder = 'Search detected stack or evidence (e.g. React, HTTP/3, og:)...';
        searchBox.setAttribute('aria-label', 'Filter detected technologies and evidence');
        searchBox.setAttribute('data-ps-tech-search', 'true');
        searchBox.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
        });

        const stackGrid = this.doc.createElement('div');
        stackGrid.className = 'ps-stack-grid';
        const detectionsByTech = new Map(
          (s.techStackDetections ?? []).map((d) => [d.technology, d]),
        );

        const renderFilteredStack = (queryRaw: string): void => {
          stackGrid.textContent = '';
          const query = queryRaw.trim().toLowerCase();
          for (const grp of s.techStackSummary?.groups ?? []) {
            const matchedItems = grp.items.filter((item) => {
              if (!query) return true;
              const det = detectionsByTech.get(item.technology);
              const evidenceText = det ? det.evidence.join(' ').toLowerCase() : '';
              return (
                item.technology.toLowerCase().includes(query) ||
                grp.label.toLowerCase().includes(query) ||
                item.shortReason.toLowerCase().includes(query) ||
                evidenceText.includes(query)
              );
            });
            if (matchedItems.length === 0) {
              continue;
            }
            const card = this.doc.createElement('div');
            card.className = 'ps-stack-card';

            const cardHead = this.doc.createElement('div');
            cardHead.className = 'ps-stack-card-head';
            const catTitle = this.doc.createElement('span');
            catTitle.className = 'tech-cat-heading';
            catTitle.appendChild(createTechCategoryIcon(grp.category, this.doc));
            catTitle.appendChild(this.doc.createTextNode(grp.label));
            const countTag = this.createEl('span', 'ps-tag', String(matchedItems.length));
            cardHead.append(catTitle, countTag);
            card.appendChild(cardHead);

            for (const item of matchedItems) {
              const line = this.doc.createElement('div');
              line.className = 'ps-stack-item';
              const left = this.doc.createElement('div');
              left.className = 'tech-row-left';
              left.appendChild(createTechIconElement(item.technology, this.doc));
              const meta = this.doc.createElement('div');
              meta.style.display = 'flex';
              meta.style.flexDirection = 'column';
              meta.style.minWidth = '0';
              const nameEl = this.doc.createElement('strong');
              nameEl.textContent = item.technology;
              const det = detectionsByTech.get(item.technology);
              const detailLine =
                query && det
                  ? (det.evidence.find((ev) => ev.toLowerCase().includes(query)) ??
                    item.shortReason)
                  : item.shortReason;
              const reasonEl = this.doc.createElement('span');
              reasonEl.textContent = detailLine;
              reasonEl.style.fontSize = '11px';
              reasonEl.style.color = 'var(--muted)';
              meta.append(nameEl, reasonEl);
              left.appendChild(meta);

              const right = this.doc.createElement('span');
              right.className = item.confidence === 'high' ? 'ps-tag positive' : 'ps-tag accent';
              right.textContent = item.confidence;
              line.append(left, right);
              card.appendChild(line);
            }
            stackGrid.appendChild(card);
          }
          if (stackGrid.childNodes.length === 0) {
            stackGrid.appendChild(
              this.createEl('span', 'muted', 'No detected technology or evidence matched query.'),
            );
          }
        };

        searchBox.addEventListener('input', () => {
          renderFilteredStack(searchBox.value);
        });
        renderFilteredStack('');
        this.drawerContent.append(searchBox, stackGrid);
      }
      return;
    }

    if (this.drawerTab === 'editor' && this.editorState) {
      const ed = this.editorState;
      const head = this.doc.createElement('div');
      head.className = 'ps-drawer-head';
      head.appendChild(
        this.createEl('span', 'ps-drawer-title', `${ed.tool.replace('_', ' ')} (${ed.selector})`),
      );
      head.appendChild(
        this.createButton('Close', 'ps-btn ghost', () => {
          this.drawerTab = 'none';
          this.syncDrawerVisibility();
        }),
      );
      this.drawerContent.appendChild(head);

      const form = this.doc.createElement('form');
      form.setAttribute('data-ps-edit-form', 'true');
      form.style.display = 'flex';
      form.style.flexDirection = 'column';
      form.style.gap = '10px';

      let inputEl: HTMLTextAreaElement | HTMLInputElement | null = null;
      let actionSelect: HTMLSelectElement | null = null;

      if (ed.tool === 'arrange') {
        actionSelect = this.doc.createElement('select');
        actionSelect.className = 'ps-field';
        for (const [val, lbl] of [
          ['move', 'Move (+16px, +16px)'],
          ['hide', 'Hide Element (visibility: hidden)'],
          ['remove', 'Collapse Element (display: none)'],
        ] as const) {
          const opt = this.doc.createElement('option');
          opt.value = val;
          opt.textContent = lbl;
          actionSelect.appendChild(opt);
        }
        form.appendChild(actionSelect);
      } else if (ed.tool === 'edit_text') {
        const ta = this.doc.createElement('textarea');
        ta.className = 'ps-field';
        ta.rows = 2;
        ta.setAttribute('data-ps-edit-text', 'true');
        ta.value = ed.initialValue;
        ta.placeholder = 'Replacement preview text...';
        ta.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
        });
        inputEl = ta;
        form.appendChild(ta);
      } else {
        const inp = this.doc.createElement('input');
        inp.type = 'text';
        inp.className = 'ps-field';
        inp.value = ed.initialValue;
        inp.placeholder = 'e.g. Georgia, serif';
        inp.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
        });
        inputEl = inp;
        form.appendChild(inp);
      }

      const statusMsg = this.createEl(
        'div',
        undefined,
        ed.statusText ?? 'Reversible preview only. Reloading the page resets edits.',
      );
      statusMsg.style.fontSize = '12px';
      statusMsg.style.color = 'var(--muted)';

      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const opts: OverlayEditOptions =
          ed.tool === 'edit_text'
            ? { text: inputEl?.value ?? '' }
            : ed.tool === 'swap_font'
              ? { fontFamily: inputEl?.value || 'Georgia, serif' }
              : {
                  action: (actionSelect?.value as 'move' | 'hide' | 'remove' | undefined) ?? 'move',
                  dx: 16,
                  dy: 16,
                };
        void this.callbacks.onRunOverlayTool(ed.tool, opts).then((res) => {
          if (res) {
            statusMsg.textContent = res.summary;
          }
        });
      });

      const row = this.doc.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '6px';
      row.style.flexWrap = 'wrap';
      const applyBtn = this.doc.createElement('button');
      applyBtn.type = 'submit';
      applyBtn.className = 'ps-btn primary';
      applyBtn.textContent = 'Apply';
      row.appendChild(applyBtn);

      if (this.callbacks.onEditHistoryCommand) {
        const historyCmd = this.callbacks.onEditHistoryCommand;
        for (const [cmd, lbl] of [
          ['EDIT_UNDO', 'Undo'],
          ['EDIT_REDO', 'Redo'],
          ['EDIT_RESET', 'Reset All'],
        ] as const) {
          row.appendChild(
            this.createButton(lbl, 'ps-btn', () => {
              void historyCmd(cmd).then((r) => {
                statusMsg.textContent = r.message;
              });
            }),
          );
        }
      }
      form.append(row, statusMsg);
      this.drawerContent.appendChild(form);
      return;
    }

    if (this.drawerTab === 'customize') {
      const head = this.doc.createElement('div');
      head.className = 'ps-drawer-head';
      head.appendChild(this.createEl('span', 'ps-drawer-title', 'Customize Overlay Dock'));
      head.appendChild(
        this.createButton('Done', 'ps-btn ghost', () => {
          this.drawerTab = 'none';
          this.syncDrawerVisibility();
        }),
      );
      this.drawerContent.appendChild(head);

      const grid = this.doc.createElement('div');
      grid.style.display = 'grid';
      grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(220px, 1fr))';
      grid.style.gap = '12px';

      const posWrap = this.doc.createElement('div');
      posWrap.appendChild(this.createEl('div', 'ps-group-title', 'Dock Position'));
      const posSel = this.doc.createElement('select');
      posSel.className = 'ps-field';
      for (const [v, l] of [
        ['bottom-center', 'Bottom Center (Default)'],
        ['bottom-right', 'Bottom Right'],
        ['top-center', 'Top Center'],
      ] as const) {
        const opt = this.doc.createElement('option');
        opt.value = v;
        opt.textContent = l;
        opt.selected = this.customization.position === v;
        posSel.appendChild(opt);
      }
      posSel.addEventListener('change', () => {
        const val = posSel.value as OverlayPosition;
        this.applyCustomization({ position: val });
        void this.callbacks.onSaveCustomization?.({ position: val });
      });
      posWrap.appendChild(posSel);

      const themeWrap = this.doc.createElement('div');
      themeWrap.appendChild(this.createEl('div', 'ps-group-title', 'Overlay Surface Theme'));
      const themeSel = this.doc.createElement('select');
      themeSel.className = 'ps-field';
      for (const [v, l] of [
        ['follow', 'Match Dashboard'],
        ['dark', 'Charcoal Dark Surface'],
        ['light', 'Light Surface'],
      ] as const) {
        const opt = this.doc.createElement('option');
        opt.value = v;
        opt.textContent = l;
        opt.selected = this.customization.themeMode === v;
        themeSel.appendChild(opt);
      }
      themeSel.addEventListener('change', () => {
        const val = themeSel.value as OverlayThemeMode;
        this.applyCustomization({ themeMode: val });
        void this.callbacks.onSaveCustomization?.({ themeMode: val });
      });
      themeWrap.appendChild(themeSel);

      grid.append(posWrap, themeWrap);
      this.drawerContent.appendChild(grid);
    }
  }

  private fillToolsGrid(container: HTMLElement): void {
    container.textContent = '';
    for (const group of OVERLAY_GROUPS) {
      const matches = OVERLAY_TOOLS.filter((t) => {
        if (t.group !== group) return false;
        if (!this.activeFilter) return true;
        return (
          t.label.toLowerCase().includes(this.activeFilter) ||
          t.keywords.includes(this.activeFilter) ||
          t.id.includes(this.activeFilter)
        );
      });
      if (matches.length === 0) {
        continue;
      }
      container.appendChild(this.createEl('div', 'ps-group-title', group));
      const grid = this.doc.createElement('div');
      grid.className = 'ps-tool-grid';
      for (const toolDef of matches) {
        const btn = this.doc.createElement('button');
        btn.type = 'button';
        btn.className = 'ps-btn';
        btn.style.justifyContent = 'flex-start';
        btn.setAttribute('data-overlay-tool-drawer', toolDef.id);
        const sq = this.doc.createElement('span');
        sq.className = 'ps-tile-icon';
        sq.appendChild(createSvgIcon(toolDef.id, '', this.doc));
        btn.append(sq, this.doc.createTextNode(toolDef.label));
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          void this.handleToolClick(toolDef);
        });
        grid.appendChild(btn);
      }
      container.appendChild(grid);
    }
  }

  private async handleToolClick(toolDef: OverlayToolDef): Promise<void> {
    if (this.busy) {
      return;
    }
    if (toolDef.isResponsiveStage) {
      this.showResponsivePreview();
      return;
    }
    if (toolDef.isPicker) {
      this.minimize(`Pick element (${toolDef.label}) | Esc cancels`);
      this.callbacks.onStartPickerForTool(toolDef.id);
      return;
    }

    this.busy = true;
    try {
      const summary = await this.callbacks.onRunOverlayTool(toolDef.id);
      if (summary) {
        this.showResultSummary(summary);
      }
    } finally {
      this.busy = false;
    }
  }

  private createEl(
    tag: keyof HTMLElementTagNameMap,
    className?: string,
    text?: string,
  ): HTMLElement {
    const node = this.doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  private createButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
    const btn = this.doc.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = label;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onClick();
    });
    return btn;
  }
}
