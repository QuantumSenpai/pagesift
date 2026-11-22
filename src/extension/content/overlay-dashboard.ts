import type { TechStackOrganizedSummary } from '../engines/tech-stack-engine.js';
import type { ToolId } from '../protocol/messages.js';
import type { ActivityQueryItem } from '../storage/activity-history.js';
import type { ExtensionSettings } from '../storage/settings-storage.js';
import { createSvgIcon, triggerTapFeedback } from '../ui/theme.js';

export type OverlayMode = 'closed' | 'expanded' | 'minimized';
export type OverlayDrawerTab = 'none' | 'tools' | 'result' | 'editor' | 'customize';
export type OverlayPosition = ExtensionSettings['overlayPosition'];
export type OverlayThemeMode = ExtensionSettings['overlayThemeMode'];

export interface OverlayToolSummary {
  tool: ToolId;
  title: string;
  summary: string;
  techStackSummary?: TechStackOrganizedSummary;
  copyableText?: string;
  downloadFilename?: string;
  downloadMime?: string;
  downloadText?: string;
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
  onCloseOverlay: () => void;
  onStartPickerForTool: (tool: ToolId) => void;
  onRunOverlayTool: (
    tool: ToolId,
    options?: OverlayEditOptions,
  ) => Promise<OverlayToolSummary | null>;
  onOpenFullDashboard: (options?: {
    tool?: ToolId;
    autorun?: boolean;
    section?: 'tools' | 'history' | 'saved';
  }) => Promise<void>;
  onFetchSiteActivity: () => Promise<ActivityQueryItem[]>;
  onSaveCustomization?: (next: Partial<OverlayCustomizationState>) => Promise<void>;
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
  isDashboardTool?: boolean;
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
    id: 'measure',
    label: 'Measure',
    group: 'Inspect & Measure',
    keywords: 'distance gap spacing',
    isPicker: true,
  },
  {
    id: 'tech_stack',
    label: 'Tech Stack',
    group: 'Inspect & Measure',
    keywords: 'framework stack next react tailwind',
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
    id: 'clone_page',
    label: 'Clone Page',
    group: 'Extract & Export',
    keywords: 'zip snapshot html sanitize',
    isDashboardTool: true,
  },
  {
    id: 'assets',
    label: 'Assets',
    group: 'Extract & Export',
    keywords: 'images svg zip media',
    isDashboardTool: true,
  },
  {
    id: 'design_md',
    label: 'Design MD',
    group: 'Extract & Export',
    keywords: 'design system markdown',
  },
  {
    id: 'clone_prompt',
    label: 'Clone Prompt',
    group: 'Extract & Export',
    keywords: 'prompt react brief',
  },
  {
    id: 'capture',
    label: 'Capture',
    group: 'Capture & Viewports',
    keywords: 'screenshot png pdf full page',
    isDashboardTool: true,
  },
  {
    id: 'responsive',
    label: 'Responsive',
    group: 'Capture & Viewports',
    keywords: 'mobile tablet viewport sync',
    isDashboardTool: true,
  },
  {
    id: 'edit_text',
    label: 'Edit Text',
    group: 'Live Preview & Audit',
    keywords: 'copy preview inline edit',
    isPicker: true,
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
    keywords: 'wcag contrast audit spacing',
  },
];

const OVERLAY_GROUPS = [
  'Inspect & Measure',
  'Extract & Export',
  'Capture & Viewports',
  'Live Preview & Audit',
];

const PAGESIFT_ROOT_ATTR = 'data-pagesift-root';

function formatRelativeTime(utcIso: string): string {
  const diffSec = Math.max(0, Math.round((Date.now() - new Date(utcIso).getTime()) / 1000));
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  return new Date(utcIso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export class OnPageOverlayDashboard {
  private readonly doc: Document;
  private readonly shadow: ShadowRoot;
  private readonly callbacks: OverlayDashboardCallbacks;

  private mode: OverlayMode = 'closed';
  private drawerTab: OverlayDrawerTab = 'none';
  private resolvedTheme: 'light' | 'dark' = 'light';
  private customization: OverlayCustomizationState = {
    position: 'bottom-center',
    themeMode: 'follow',
    pinnedTools: ['inspect', 'tech_stack', 'colors', 'fonts', 'capture'],
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

  private anchor: HTMLElement | null = null;
  private stage: HTMLElement | null = null;
  private dockBar: HTMLElement | null = null;
  private pinnedStrip: HTMLElement | null = null;
  private minBar: HTMLElement | null = null;
  private drawer: HTMLElement | null = null;
  private drawerContent: HTMLElement | null = null;
  private allToolsBtn: HTMLButtonElement | null = null;
  private customizeBtn: HTMLButtonElement | null = null;
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

  public setResolvedTheme(theme: 'light' | 'dark'): void {
    this.resolvedTheme = theme;
    const effective =
      this.customization.themeMode === 'follow' ? theme : this.customization.themeMode;
    this.anchor?.setAttribute('data-theme', effective);
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
    this.renderPinnedBarTools();
    if (this.drawerTab === 'customize') {
      this.renderDrawer();
    }
  }

  public openExpanded(openDrawer = false): void {
    this.mode = 'expanded';
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

  public minimize(statusText?: string): void {
    this.mode = 'minimized';
    this.drawerTab = 'none';
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
    this.anchor?.remove();
    this.anchor = null;
    this.stage = null;
    this.dockBar = null;
    this.pinnedStrip = null;
    this.minBar = null;
    this.drawer = null;
    this.drawerContent = null;
  }

  public refreshSiteActivity(): Promise<void> {
    if (this.drawerTab === 'tools') {
      this.renderDrawer();
    }
    return Promise.resolve();
  }

  private syncAnchorPlacement(): void {
    if (!this.anchor) {
      return;
    }
    this.anchor.setAttribute('data-pos', this.customization.position);
  }

  private injectFontsStyle(): void {
    const fonts = [
      { fam: 'Instrument Sans', weight: 400, file: 'fonts/instrument-sans-400.woff2' },
      { fam: 'Instrument Sans', weight: 500, file: 'fonts/instrument-sans-500.woff2' },
      { fam: 'Instrument Sans', weight: 600, file: 'fonts/instrument-sans-600.woff2' },
      { fam: 'Instrument Sans', weight: 700, file: 'fonts/instrument-sans-700.woff2' },
      { fam: 'IBM Plex Mono', weight: 400, file: 'fonts/ibm-plex-mono-400.woff2' },
      { fam: 'IBM Plex Mono', weight: 500, file: 'fonts/ibm-plex-mono-500.woff2' },
      { fam: 'IBM Plex Mono', weight: 600, file: 'fonts/ibm-plex-mono-600.woff2' },
    ];
    let css = '';
    for (const f of fonts) {
      const url = this.callbacks.getResourceUrl(f.file);
      if (url) {
        css += `@font-face { font-family: "${f.fam}"; font-style: normal; font-weight: ${f.weight}; font-display: swap; src: url("${url}") format("woff2"); }\n`;
      }
    }
    if (css) {
      const style = this.doc.createElement('style');
      style.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
      style.textContent = css;
      this.shadow.appendChild(style);
    }
  }

  private mountDom(): void {
    this.injectFontsStyle();
    const iconUrl = this.callbacks.getResourceUrl('icons/icon-32.png');

    const styleEl = this.doc.createElement('style');
    styleEl.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    styleEl.textContent = `
      .ps-anchor {
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
        --positive: #0f766e;
        --positive-surface: #f0fdfa;
        --positive-border: #99f6e4;
        --shadow-sm: 0 2px 6px rgba(15, 23, 42, 0.06), 0 1px 2px rgba(15, 23, 42, 0.04);
        --shadow-md: 0 8px 22px rgba(15, 23, 42, 0.09), 0 2px 6px rgba(15, 23, 42, 0.04);
        --shadow-lg: 0 18px 42px rgba(15, 23, 42, 0.14), 0 4px 12px rgba(15, 23, 42, 0.06);
        --ease: cubic-bezier(0.22, 1, 0.36, 1);
        position: fixed;
        bottom: 18px;
        left: 0;
        right: 0;
        margin: 0 auto;
        width: fit-content;
        max-width: calc(100vw - 24px);
        z-index: 2147483647;
        pointer-events: none;
        font-family: "Instrument Sans", system-ui, -apple-system, sans-serif;
        font-size: 13px;
        line-height: 1.45;
        color: var(--text);
      }
      .ps-anchor[data-theme="dark"] {
        --bg: #15171d;
        --elevated: #1c1f27;
        --subtle: #242834;
        --border: #282c38;
        --border-strong: #373d4e;
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
        --positive: #14b8a6;
        --positive-surface: #042f2e;
        --positive-border: #115e59;
        --shadow-sm: 0 3px 8px rgba(0, 0, 0, 0.36);
        --shadow-md: 0 10px 26px rgba(0, 0, 0, 0.45);
        --shadow-lg: 0 20px 50px rgba(0, 0, 0, 0.62);
      }
      .ps-anchor[data-pos="bottom-right"] {
        left: auto;
        right: 18px;
        margin: 0;
      }
      .ps-anchor[data-pos="top-center"] {
        top: 18px;
        bottom: auto;
      }
      .ps-anchor * { box-sizing: border-box; }
      .ps-stage {
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
        flex-wrap: wrap;
        gap: 6px;
        padding: 6px 8px;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 10px;
        box-shadow: var(--shadow-lg);
        pointer-events: auto;
        max-width: 100%;
      }
      .ps-minbar {
        display: none;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: var(--shadow-lg);
        pointer-events: auto;
        max-width: 100%;
      }
      .ps-drawer {
        display: none;
        width: min(720px, calc(100vw - 24px));
        max-height: min(62vh, 520px);
        overflow-y: auto;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 10px;
        box-shadow: var(--shadow-lg);
        pointer-events: auto;
        padding: 14px;
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
        0% { transform: scale(0.965); }
        60% { transform: scale(1.01); }
        100% { transform: scale(1); }
      }
      .ps-brand {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 3px 6px 3px 4px;
        border-right: 1px solid var(--border);
        min-width: 0;
      }
      .ps-brand img {
        width: 20px;
        height: 20px;
        border-radius: 4px;
        flex: 0 0 auto;
      }
      .ps-sq-dot {
        width: 7px;
        height: 7px;
        border-radius: 2px;
        background: var(--positive);
        flex: 0 0 auto;
      }
      .ps-host {
        font-family: "IBM Plex Mono", ui-monospace, monospace;
        font-size: 12px;
        font-weight: 500;
        color: var(--secondary);
        max-width: 130px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ps-pinned-strip {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 5px;
      }
      .ps-actions-strip {
        display: flex;
        align-items: center;
        gap: 5px;
        padding-left: 4px;
        border-left: 1px solid var(--border);
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
        background: var(--bg);
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
      .ps-btn:hover {
        background: var(--elevated);
        border-color: var(--border-strong);
        box-shadow: var(--shadow-md);
        transform: translateY(-1px);
      }
      .ps-btn:active {
        transform: translateY(1px) scale(0.975);
        box-shadow: var(--shadow-sm);
      }
      .ps-btn.tap-confirm {
        animation: ps-tap 210ms var(--ease);
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
        grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
        gap: 6px;
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
        grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
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
        gap: 6px;
      }
      .ps-stack-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        font-size: 12.5px;
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
        background: var(--bg);
        color: var(--text);
        font-family: inherit;
        font-size: 13px;
      }
      @media (prefers-reduced-motion: reduce) {
        * { transition: none !important; animation: none !important; }
      }
    `;

    const anchor = this.doc.createElement('div');
    anchor.className = 'ps-anchor';
    anchor.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    anchor.setAttribute('data-theme', this.resolvedTheme);
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

    const dockBar = this.doc.createElement('div');
    dockBar.className = 'ps-dock ps-panel';
    dockBar.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    dockBar.setAttribute('role', 'toolbar');
    dockBar.setAttribute('aria-label', 'PageSift Horizontal Command Bar');

    const brand = this.doc.createElement('div');
    brand.className = 'ps-brand';
    if (iconUrl) {
      const img = this.doc.createElement('img');
      img.src = iconUrl;
      img.alt = 'PageSift';
      brand.appendChild(img);
    }
    const dot = this.doc.createElement('span');
    dot.className = 'ps-sq-dot';
    brand.appendChild(dot);

    const pageInfo = this.callbacks.getPageInfo();
    const hostSpan = this.doc.createElement('span');
    hostSpan.className = 'ps-host';
    hostSpan.textContent = pageInfo.hostname || 'PageSift';
    brand.appendChild(hostSpan);
    dockBar.appendChild(brand);

    const pinnedStrip = this.doc.createElement('div');
    pinnedStrip.className = 'ps-pinned-strip';
    dockBar.appendChild(pinnedStrip);

    const actionsStrip = this.doc.createElement('div');
    actionsStrip.className = 'ps-actions-strip';

    const allToolsBtn = this.doc.createElement('button');
    allToolsBtn.type = 'button';
    allToolsBtn.className = 'ps-btn';
    allToolsBtn.setAttribute('data-ps-action', 'toggle-tools');
    allToolsBtn.textContent = 'All 15';
    allToolsBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.drawerTab = this.drawerTab === 'tools' ? 'none' : 'tools';
      this.renderDrawer();
    });

    const customizeBtn = this.doc.createElement('button');
    customizeBtn.type = 'button';
    customizeBtn.className = 'ps-btn ghost';
    customizeBtn.setAttribute('data-ps-action', 'customize');
    customizeBtn.textContent = 'Customize';
    customizeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.drawerTab = this.drawerTab === 'customize' ? 'none' : 'customize';
      this.renderDrawer();
    });

    const openDashBtn = this.doc.createElement('button');
    openDashBtn.type = 'button';
    openDashBtn.className = 'ps-btn ink';
    openDashBtn.setAttribute('data-ps-action', 'open-dashboard');
    openDashBtn.textContent = 'Dashboard';
    openDashBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void this.callbacks.onOpenFullDashboard();
    });

    const minBtn = this.doc.createElement('button');
    minBtn.type = 'button';
    minBtn.className = 'ps-btn ghost';
    minBtn.setAttribute('data-ps-action', 'minimize');
    minBtn.setAttribute('aria-label', 'Minimize overlay');
    minBtn.textContent = '-';
    minBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.minimize(pageInfo.hostname || 'PageSift');
    });

    const closeBtn = this.doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ps-btn ghost';
    closeBtn.setAttribute('data-ps-action', 'close');
    closeBtn.setAttribute('aria-label', 'Close overlay');
    closeBtn.textContent = 'x';
    closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.callbacks.onCloseOverlay();
    });

    actionsStrip.append(allToolsBtn, customizeBtn, openDashBtn, minBtn, closeBtn);
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
    minText.textContent = pageInfo.hostname || 'PageSift';

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
    this.pinnedStrip = pinnedStrip;
    this.minBar = minBar;
    this.drawer = drawer;
    this.drawerContent = drawerContent;
    this.allToolsBtn = allToolsBtn;
    this.customizeBtn = customizeBtn;
    this.minStatusText = minText;

    this.renderPinnedBarTools();
  }

  private renderPinnedBarTools(): void {
    if (!this.pinnedStrip) {
      return;
    }
    this.pinnedStrip.textContent = '';
    for (const id of this.customization.pinnedTools) {
      const def = OVERLAY_TOOLS.find((t) => t.id === id);
      if (!def) continue;
      const btn = this.doc.createElement('button');
      btn.type = 'button';
      btn.className = 'ps-btn';
      btn.setAttribute('data-overlay-bar-tool', def.id);
      const sq = this.doc.createElement('span');
      sq.className = 'ps-tile-icon';
      sq.appendChild(createSvgIcon(def.id, '', this.doc));
      const lbl = this.doc.createElement('span');
      lbl.textContent = def.label;
      btn.append(sq, lbl);
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void this.handleToolClick(def);
      });
      this.pinnedStrip.appendChild(btn);
    }
  }

  private syncDrawerVisibility(): void {
    const isOpen = this.mode === 'expanded' && this.drawerTab !== 'none';
    this.drawer?.classList.toggle('open', isOpen);
    this.allToolsBtn?.classList.toggle('active', this.drawerTab === 'tools');
    this.customizeBtn?.classList.toggle('active', this.drawerTab === 'customize');
  }

  private renderDrawer(): void {
    this.syncDrawerVisibility();
    if (!this.drawerContent || this.drawerTab === 'none') {
      return;
    }
    this.drawerContent.textContent = '';

    if (this.drawerTab === 'tools') {
      const head = this.doc.createElement('div');
      head.className = 'ps-drawer-head';
      head.appendChild(this.createEl('span', 'ps-drawer-title', 'All 15 Local Tools'));
      const headBtns = this.doc.createElement('div');
      headBtns.style.display = 'flex';
      headBtns.style.gap = '6px';
      const histBtn = this.createButton('History', 'ps-btn', () => {
        void this.callbacks.onOpenFullDashboard({ section: 'history' });
      });
      const closePanel = this.createButton('Done', 'ps-btn ghost', () => {
        this.drawerTab = 'none';
        this.syncDrawerVisibility();
      });
      headBtns.append(histBtn, closePanel);
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
      if (s.downloadText && s.downloadFilename) {
        acts.appendChild(
          this.createButton('Download', 'ps-btn', () => {
            const blob = new Blob([s.downloadText ?? ''], {
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

      if (s.techStackSummary && s.techStackSummary.groups.length > 0) {
        const stackGrid = this.doc.createElement('div');
        stackGrid.className = 'ps-stack-grid';
        for (const grp of s.techStackSummary.groups) {
          const card = this.doc.createElement('div');
          card.className = 'ps-stack-card';
          const title = this.doc.createElement('strong');
          title.style.fontSize = '12.5px';
          title.textContent = grp.label;
          card.appendChild(title);
          for (const item of grp.items) {
            const line = this.doc.createElement('div');
            line.className = 'ps-stack-item';
            const left = this.doc.createElement('span');
            left.textContent = item.technology;
            const right = this.doc.createElement('span');
            right.className = item.confidence === 'high' ? 'ps-tag positive' : 'ps-tag accent';
            right.textContent = item.confidence;
            line.append(left, right);
            card.appendChild(line);
          }
          stackGrid.appendChild(card);
        }
        this.drawerContent.appendChild(stackGrid);
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
        inp.placeholder = 'Font family (e.g. Georgia, serif)';
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
        ['light', 'Light Paper'],
        ['dark', 'Charcoal Dark'],
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

      this.drawerContent.appendChild(
        this.createEl('div', 'ps-group-title', 'Pinned Quick Bar Tools (select 3 to 6)'),
      );
      const pinGrid = this.doc.createElement('div');
      pinGrid.className = 'ps-tool-grid';
      for (const def of OVERLAY_TOOLS) {
        const lbl = this.doc.createElement('label');
        lbl.style.display = 'flex';
        lbl.style.alignItems = 'center';
        lbl.style.gap = '6px';
        lbl.style.fontSize = '12.5px';
        lbl.style.padding = '5px 8px';
        lbl.style.border = '1px solid var(--border)';
        lbl.style.borderRadius = '6px';
        lbl.style.background = 'var(--elevated)';
        lbl.style.cursor = 'pointer';

        const cb = this.doc.createElement('input');
        cb.type = 'checkbox';
        cb.checked = this.customization.pinnedTools.includes(def.id);
        cb.addEventListener('change', () => {
          const current = new Set(this.customization.pinnedTools);
          if (cb.checked) {
            if (current.size >= 6) {
              cb.checked = false;
              return;
            }
            current.add(def.id);
          } else {
            if (current.size <= 3) {
              cb.checked = true;
              return;
            }
            current.delete(def.id);
          }
          const ordered = OVERLAY_TOOLS.map((t) => t.id).filter((id) => current.has(id));
          this.applyCustomization({ pinnedTools: ordered });
          void this.callbacks.onSaveCustomization?.({ pinnedTools: ordered });
        });
        lbl.append(cb, this.doc.createTextNode(def.label));
        pinGrid.appendChild(lbl);
      }
      this.drawerContent.appendChild(pinGrid);
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
        btn.setAttribute('data-overlay-tool', toolDef.id);
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
    if (toolDef.isDashboardTool) {
      await this.callbacks.onOpenFullDashboard({
        tool: toolDef.id,
        autorun: toolDef.id !== 'responsive',
      });
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
