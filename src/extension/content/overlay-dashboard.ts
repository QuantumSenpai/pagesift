import { PAGESIFT_ROOT_ATTR } from '../engines/dom-utils.js';
import type { ToolId } from '../protocol/messages.js';

export type OverlayDisplayMode = 'closed' | 'expanded' | 'minimized';

export interface OverlaySiteActivityItem {
  id: string;
  tool: ToolId;
  actionLabel: string;
  status: string;
  startedAt: string;
  durationMs: number | null;
  resultSummary: string;
}

export interface OverlayToolSummary {
  tool: ToolId;
  title: string;
  summary: string;
  copyableText?: string | undefined;
  downloadFilename?: string | undefined;
  downloadMime?: string | undefined;
  downloadText?: string | undefined;
}

export interface OverlayDashboardCallbacks {
  getPageInfo: () => { title: string; url: string; hostname: string };
  getResourceUrl: (path: string) => string | null;
  onRunOverlayTool: (tool: ToolId) => Promise<OverlayToolSummary | null>;
  onStartPickerForTool: (tool: ToolId) => void;
  onOpenFullDashboard: (options?: {
    tool?: ToolId;
    autorun?: boolean;
    section?: 'tools' | 'history' | 'saved' | 'settings';
  }) => Promise<void>;
  onFetchSiteActivity: () => Promise<OverlaySiteActivityItem[]>;
  onCloseOverlay: () => void;
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
    keywords: 'element styles box model',
    isPicker: true,
  },
  {
    id: 'measure',
    label: 'Measure',
    group: 'Inspect & Measure',
    keywords: 'gap distance spacing',
    isPicker: true,
  },
  { id: 'colors', label: 'Colors', group: 'Inspect & Measure', keywords: 'palette hex tokens css' },
  { id: 'fonts', label: 'Fonts', group: 'Inspect & Measure', keywords: 'typography font-face' },
  {
    id: 'tech_stack',
    label: 'Tech Stack',
    group: 'Inspect & Measure',
    keywords: 'framework react vue next',
  },
  {
    id: 'clone_page',
    label: 'Clone Page',
    group: 'Extract & Export',
    keywords: 'snapshot zip html css',
    isDashboardTool: true,
  },
  {
    id: 'assets',
    label: 'Assets',
    group: 'Extract & Export',
    keywords: 'images svg icons fonts zip',
    isDashboardTool: true,
  },
  {
    id: 'design_md',
    label: 'Design MD',
    group: 'Extract & Export',
    keywords: 'markdown design system spec',
  },
  {
    id: 'clone_prompt',
    label: 'Clone Prompt',
    group: 'Extract & Export',
    keywords: 'brief prompt rebuild',
  },
  {
    id: 'capture',
    label: 'Capture',
    group: 'Capture & Viewports',
    keywords: 'screenshot png jpeg webp pdf',
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
    group: 'Live Preview',
    keywords: 'copy preview rewrite',
    isPicker: true,
  },
  { id: 'swap_font', label: 'Swap Font', group: 'Live Preview', keywords: 'typeface preview' },
  {
    id: 'arrange',
    label: 'Arrange',
    group: 'Live Preview',
    keywords: 'move hide remove layout',
    isPicker: true,
  },
  {
    id: 'design_review',
    label: 'Design Review',
    group: 'Live Preview',
    keywords: 'audit wcag contrast hierarchy',
  },
];

const OVERLAY_GROUPS = [
  'Inspect & Measure',
  'Extract & Export',
  'Capture & Viewports',
  'Live Preview',
];

function formatRelativeTime(utcIso: string): string {
  const ts = Date.parse(utcIso);
  if (Number.isNaN(ts)) {
    return '';
  }
  const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export class OnPageOverlayDashboard {
  private readonly doc: Document;
  private readonly shadow: ShadowRoot;
  private readonly callbacks: OverlayDashboardCallbacks;
  private mode: OverlayDisplayMode = 'closed';
  private wrapper: HTMLElement | null = null;
  private expandedPanel: HTMLElement | null = null;
  private minimizedBar: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private toolsContainer: HTMLElement | null = null;
  private resultBox: HTMLElement | null = null;
  private historyList: HTMLElement | null = null;
  private minStatusText: HTMLElement | null = null;
  private activeFilter = '';
  private lastSummary: OverlayToolSummary | null = null;
  private busy = false;
  private theme: 'dark' | 'light' = 'dark';

  public constructor(doc: Document, shadow: ShadowRoot, callbacks: OverlayDashboardCallbacks) {
    this.doc = doc;
    this.shadow = shadow;
    this.callbacks = callbacks;
  }

  public getMode(): OverlayDisplayMode {
    return this.mode;
  }

  public setTheme(theme: 'dark' | 'light'): void {
    this.theme = theme;
    this.wrapper?.setAttribute('data-theme', theme);
  }

  public setMinimizedStatus(text: string): void {
    if (this.minStatusText) {
      this.minStatusText.textContent = text;
    }
  }

  public showResultSummary(summary: OverlayToolSummary): void {
    this.lastSummary = summary;
    this.renderResultSummary();
    void this.refreshSiteActivity();
  }

  public openExpanded(): void {
    this.ensureMounted();
    this.mode = 'expanded';
    if (this.expandedPanel) this.expandedPanel.style.display = 'flex';
    if (this.minimizedBar) this.minimizedBar.style.display = 'none';
    void this.refreshSiteActivity();
    this.searchInput?.focus();
  }

  public minimize(statusNote?: string): void {
    this.ensureMounted();
    this.mode = 'minimized';
    if (this.expandedPanel) this.expandedPanel.style.display = 'none';
    if (this.minimizedBar) this.minimizedBar.style.display = 'flex';
    if (statusNote && this.minStatusText) {
      this.minStatusText.textContent = statusNote;
    }
  }

  public close(): void {
    this.mode = 'closed';
    if (this.wrapper && this.wrapper.isConnected) {
      this.wrapper.remove();
    }
    this.wrapper = null;
    this.expandedPanel = null;
    this.minimizedBar = null;
    this.searchInput = null;
    this.toolsContainer = null;
    this.resultBox = null;
    this.historyList = null;
    this.minStatusText = null;
  }

  private ensureMounted(): void {
    if (this.wrapper && this.wrapper.isConnected) {
      return;
    }

    const font400 = this.callbacks.getResourceUrl('fonts/instrument-sans-400.woff2');
    const font600 = this.callbacks.getResourceUrl('fonts/instrument-sans-600.woff2');
    const mono400 = this.callbacks.getResourceUrl('fonts/ibm-plex-mono-400.woff2');
    const iconUrl = this.callbacks.getResourceUrl('icons/icon-32.png');

    const styleEl = this.doc.createElement('style');
    const fontCss = [
      font400
        ? `@font-face { font-family: "Instrument Sans"; font-weight: 400; src: url("${font400}") format("woff2"); font-display: swap; }`
        : '',
      font600
        ? `@font-face { font-family: "Instrument Sans"; font-weight: 600; src: url("${font600}") format("woff2"); font-display: swap; }`
        : '',
      mono400
        ? `@font-face { font-family: "IBM Plex Mono"; font-weight: 400; src: url("${mono400}") format("woff2"); font-display: swap; }`
        : '',
    ].join('\n');

    styleEl.textContent = `${fontCss}
      .ps-wrap {
        --bg: #00001e;
        --surface: #070928;
        --elevated: #0e1138;
        --subtle: #14194a;
        --border: #1d235c;
        --border-strong: #2e367d;
        --text: #f4f6fb;
        --secondary: #c5ccdf;
        --muted: #8f99bb;
        --accent: #0057ff;
        --accent-hover: #2972ff;
        --accent-surface: #0a1b54;
        --accent-text: #74a6ff;
        --positive: #14b8a6;
        --danger: #ef4444;
        font-family: "Instrument Sans", system-ui, -apple-system, sans-serif;
        font-size: 13px;
        line-height: 1.45;
        color: var(--text);
        pointer-events: none;
      }
      .ps-wrap[data-theme="light"] {
        --bg: #fdfdfc;
        --surface: #ffffff;
        --elevated: #f5f5f1;
        --subtle: #ebebea;
        --border: #e2e2da;
        --border-strong: #c8c8be;
        --text: #171717;
        --secondary: #3f3f3c;
        --muted: #5c5c57;
        --accent: #0057ff;
        --accent-hover: #0046d1;
        --accent-surface: #ebf1ff;
        --accent-text: #0048d6;
        --positive: #0f766e;
        --danger: #dc2626;
      }
      .ps-panel {
        position: fixed;
        top: 14px;
        right: 14px;
        width: 356px;
        max-width: calc(100vw - 24px);
        max-height: calc(100vh - 28px);
        display: flex;
        flex-direction: column;
        background: var(--bg);
        border: 1px solid var(--border-strong);
        border-radius: 10px;
        overflow: hidden;
        pointer-events: auto;
        box-sizing: border-box;
      }
      .ps-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px;
        background: var(--surface);
        border-bottom: 1px solid var(--border);
      }
      .ps-brand {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .ps-brand img {
        width: 20px;
        height: 20px;
        border-radius: 4px;
        flex: 0 0 auto;
      }
      .ps-host {
        font-family: "IBM Plex Mono", ui-monospace, monospace;
        font-size: 12px;
        color: var(--secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ps-header-actions {
        display: flex;
        align-items: center;
        gap: 4px;
        flex: 0 0 auto;
      }
      .ps-btn {
        font-family: inherit;
        font-size: 12.5px;
        font-weight: 500;
        color: var(--text);
        background: var(--surface);
        border: 1px solid var(--border-strong);
        border-radius: 6px;
        min-height: 30px;
        padding: 4px 9px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        white-space: nowrap;
      }
      .ps-btn:hover {
        background: var(--subtle);
      }
      .ps-btn:focus-visible,
      .ps-search:focus-visible {
        outline: 2px solid var(--accent-text);
        outline-offset: 1px;
      }
      .ps-btn.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: #ffffff;
        font-weight: 600;
      }
      .ps-btn.primary:hover {
        background: var(--accent-hover);
      }
      .ps-btn.ghost {
        background: transparent;
        border-color: transparent;
        color: var(--secondary);
      }
      .ps-btn.ghost:hover {
        background: var(--subtle);
        color: var(--text);
      }
      .ps-body {
        overflow-y: auto;
        padding: 10px 12px 12px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .ps-search {
        width: 100%;
        box-sizing: border-box;
        font-family: inherit;
        font-size: 13px;
        color: var(--text);
        background: var(--surface);
        border: 1px solid var(--border-strong);
        border-radius: 6px;
        min-height: 34px;
        padding: 6px 10px;
      }
      .ps-group-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--muted);
        margin: 0 0 6px;
      }
      .ps-tool-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 6px;
      }
      .ps-tool-btn {
        justify-content: flex-start;
        text-align: left;
        background: var(--surface);
        border: 1px solid var(--border);
        padding: 6px 9px;
        min-height: 32px;
        font-size: 12.5px;
      }
      .ps-tool-btn:hover {
        border-color: var(--accent);
        background: var(--accent-surface);
      }
      .ps-result {
        background: var(--surface);
        border: 1px solid var(--border-strong);
        border-radius: 8px;
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .ps-result-title {
        font-weight: 600;
        font-size: 13px;
      }
      .ps-result-text {
        font-size: 12.5px;
        color: var(--secondary);
        overflow-wrap: anywhere;
      }
      .ps-section-sep {
        border-top: 1px solid var(--border);
        padding-top: 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .ps-hist-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 5px 0;
        border-bottom: 1px solid var(--border);
        font-size: 12px;
      }
      .ps-hist-row:last-child {
        border-bottom: none;
      }
      .ps-hist-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--secondary);
      }
      .ps-hist-time {
        font-family: "IBM Plex Mono", ui-monospace, monospace;
        font-size: 11.5px;
        color: var(--muted);
        flex: 0 0 auto;
      }
      .ps-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--positive);
        display: inline-block;
        flex: 0 0 auto;
      }
      .ps-minbar {
        position: fixed;
        right: 16px;
        bottom: 16px;
        display: none;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 8px;
        background: var(--bg);
        border: 1px solid var(--border-strong);
        pointer-events: auto;
        max-width: calc(100vw - 24px);
      }
      .ps-min-text {
        font-family: "IBM Plex Mono", ui-monospace, monospace;
        font-size: 12px;
        color: var(--secondary);
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      @media (prefers-reduced-motion: reduce) {
        * { transition: none !important; animation: none !important; }
      }
    `;

    const wrap = this.doc.createElement('div');
    wrap.className = 'ps-wrap';
    wrap.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    wrap.setAttribute('data-theme', this.theme);
    wrap.appendChild(styleEl);

    const panel = this.doc.createElement('section');
    panel.className = 'ps-panel';
    panel.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'PageSift Overlay Dashboard');

    const header = this.doc.createElement('div');
    header.className = 'ps-header';
    const brand = this.doc.createElement('div');
    brand.className = 'ps-brand';
    if (iconUrl) {
      const img = this.doc.createElement('img');
      img.src = iconUrl;
      img.alt = 'PageSift';
      brand.appendChild(img);
    }
    const pageInfo = this.callbacks.getPageInfo();
    const hostSpan = this.doc.createElement('span');
    hostSpan.className = 'ps-host';
    hostSpan.textContent = pageInfo.hostname || 'PageSift';
    brand.appendChild(hostSpan);
    header.appendChild(brand);

    const hActions = this.doc.createElement('div');
    hActions.className = 'ps-header-actions';

    const openDashBtn = this.doc.createElement('button');
    openDashBtn.type = 'button';
    openDashBtn.className = 'ps-btn primary';
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
    minBtn.textContent = '–';
    minBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.minimize(pageInfo.hostname || 'PageSift');
    });

    const closeBtn = this.doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ps-btn ghost';
    closeBtn.setAttribute('data-ps-action', 'close');
    closeBtn.setAttribute('aria-label', 'Close overlay');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.callbacks.onCloseOverlay();
    });

    hActions.append(openDashBtn, minBtn, closeBtn);
    header.appendChild(hActions);
    panel.appendChild(header);

    const body = this.doc.createElement('div');
    body.className = 'ps-body';

    const search = this.doc.createElement('input');
    search.type = 'search';
    search.className = 'ps-search';
    search.placeholder = 'Search 15 tools...';
    search.setAttribute('aria-label', 'Filter tools');
    search.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
    });
    search.addEventListener('input', () => {
      this.activeFilter = search.value.trim().toLowerCase();
      this.renderTools();
    });
    body.appendChild(search);

    const resultBox = this.doc.createElement('div');
    resultBox.style.display = 'none';
    body.appendChild(resultBox);

    const toolsContainer = this.doc.createElement('div');
    toolsContainer.style.display = 'flex';
    toolsContainer.style.flexDirection = 'column';
    toolsContainer.style.gap = '10px';
    body.appendChild(toolsContainer);

    const historySection = this.doc.createElement('div');
    historySection.className = 'ps-section-sep';
    const histHdr = this.doc.createElement('div');
    histHdr.style.display = 'flex';
    histHdr.style.alignItems = 'center';
    histHdr.style.justifyContent = 'space-between';
    const histTitle = this.doc.createElement('span');
    histTitle.className = 'ps-group-title';
    histTitle.style.margin = '0';
    histTitle.textContent = 'Recent on this site';
    const allHistBtn = this.doc.createElement('button');
    allHistBtn.type = 'button';
    allHistBtn.className = 'ps-btn ghost';
    allHistBtn.style.minHeight = '26px';
    allHistBtn.style.fontSize = '12px';
    allHistBtn.textContent = 'Full History';
    allHistBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void this.callbacks.onOpenFullDashboard({ section: 'history' });
    });
    histHdr.append(histTitle, allHistBtn);
    historySection.appendChild(histHdr);

    const historyList = this.doc.createElement('div');
    historyList.setAttribute('data-ps-site-history', 'true');
    historySection.appendChild(historyList);
    body.appendChild(historySection);

    panel.appendChild(body);
    wrap.appendChild(panel);

    const minBar = this.doc.createElement('div');
    minBar.className = 'ps-minbar';
    minBar.setAttribute(PAGESIFT_ROOT_ATTR, 'true');
    minBar.setAttribute('role', 'toolbar');
    minBar.setAttribute('aria-label', 'PageSift minimized bar');

    const dot = this.doc.createElement('span');
    dot.className = 'ps-dot';
    const minText = this.doc.createElement('span');
    minText.className = 'ps-min-text';
    minText.textContent = pageInfo.hostname || 'PageSift';

    const expandBtn = this.doc.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'ps-btn primary';
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

    minBar.append(dot, minText, expandBtn, minDashBtn, minCloseBtn);
    wrap.appendChild(minBar);

    this.shadow.appendChild(wrap);
    this.wrapper = wrap;
    this.expandedPanel = panel;
    this.minimizedBar = minBar;
    this.searchInput = search;
    this.toolsContainer = toolsContainer;
    this.resultBox = resultBox;
    this.historyList = historyList;
    this.minStatusText = minText;

    this.renderTools();
    this.renderResultSummary();
  }

  private renderTools(): void {
    if (!this.toolsContainer) {
      return;
    }
    this.toolsContainer.textContent = '';

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

      const section = this.doc.createElement('div');
      const title = this.doc.createElement('div');
      title.className = 'ps-group-title';
      title.textContent = group;
      section.appendChild(title);

      const grid = this.doc.createElement('div');
      grid.className = 'ps-tool-grid';
      for (const toolDef of matches) {
        const btn = this.doc.createElement('button');
        btn.type = 'button';
        btn.className = 'ps-btn ps-tool-btn';
        btn.setAttribute('data-overlay-tool', toolDef.id);
        btn.textContent = toolDef.label;
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          void this.handleToolClick(toolDef);
        });
        grid.appendChild(btn);
      }
      section.appendChild(grid);
      this.toolsContainer.appendChild(section);
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
      this.minimize(`Pick element (${toolDef.label}) · Esc cancels`);
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

  private renderResultSummary(): void {
    if (!this.resultBox) {
      return;
    }
    if (!this.lastSummary) {
      this.resultBox.style.display = 'none';
      return;
    }
    const summary = this.lastSummary;
    this.resultBox.style.display = 'block';
    this.resultBox.textContent = '';

    const card = this.doc.createElement('div');
    card.className = 'ps-result';
    card.setAttribute('data-ps-overlay-result', summary.tool);

    const title = this.doc.createElement('div');
    title.className = 'ps-result-title';
    title.textContent = summary.title;
    card.appendChild(title);

    const text = this.doc.createElement('div');
    text.className = 'ps-result-text';
    text.textContent = summary.summary;
    card.appendChild(text);

    const actions = this.doc.createElement('div');
    actions.style.display = 'flex';
    actions.style.flexWrap = 'wrap';
    actions.style.gap = '6px';

    if (summary.copyableText) {
      const copyBtn = this.doc.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'ps-btn';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void navigator.clipboard.writeText(summary.copyableText ?? '').then(() => {
          copyBtn.textContent = 'Copied';
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
          }, 1200);
        });
      });
      actions.appendChild(copyBtn);
    }

    if (summary.downloadText && summary.downloadFilename) {
      const dlBtn = this.doc.createElement('button');
      dlBtn.type = 'button';
      dlBtn.className = 'ps-btn';
      dlBtn.textContent = 'Download';
      dlBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const blob = new Blob([summary.downloadText ?? ''], {
          type: summary.downloadMime ?? 'text/plain;charset=utf-8',
        });
        const url = URL.createObjectURL(blob);
        const a = this.doc.createElement('a');
        a.href = url;
        a.download = summary.downloadFilename ?? 'pagesift-output.txt';
        a.style.display = 'none';
        this.doc.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => {
          URL.revokeObjectURL(url);
        }, 15000);
      });
      actions.appendChild(dlBtn);
    }

    const openBtn = this.doc.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'ps-btn primary';
    openBtn.textContent = 'Open in Dashboard';
    openBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void this.callbacks.onOpenFullDashboard({ tool: summary.tool, autorun: true });
    });
    actions.appendChild(openBtn);

    card.appendChild(actions);
    this.resultBox.appendChild(card);
  }

  public async refreshSiteActivity(): Promise<void> {
    const listEl = this.historyList;
    if (!listEl) {
      return;
    }
    const items = await this.callbacks.onFetchSiteActivity().catch(() => []);
    if (this.historyList !== listEl) {
      return;
    }
    listEl.textContent = '';
    if (items.length === 0) {
      const empty = this.doc.createElement('div');
      empty.style.fontSize = '12px';
      empty.style.color = 'var(--muted)';
      empty.textContent = 'No PageSift actions recorded on this site yet.';
      this.historyList.appendChild(empty);
      return;
    }

    for (const item of items.slice(0, 4)) {
      const row = this.doc.createElement('div');
      row.className = 'ps-hist-row';
      const label = this.doc.createElement('span');
      label.className = 'ps-hist-label';
      label.textContent = `${item.actionLabel}${item.resultSummary ? ` · ${item.resultSummary}` : ''}`;
      const time = this.doc.createElement('span');
      time.className = 'ps-hist-time';
      time.textContent = formatRelativeTime(item.startedAt);
      row.append(label, time);
      this.historyList.appendChild(row);
    }
  }
}
