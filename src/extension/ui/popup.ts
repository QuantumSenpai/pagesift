import type {
  ExtensionMessageResponse,
  MessageOperation,
  RuntimeMessageEnvelope,
  ToolId,
} from '../protocol/messages.js';
import {
  applyThemePreference,
  createSvgIcon,
  formatThemeLabel,
  nextThemePreference,
  readCachedTheme,
  type ThemePreference,
} from './theme.js';

interface ChromePopupApis {
  runtime?: {
    sendMessage: (msg: RuntimeMessageEnvelope) => Promise<ExtensionMessageResponse>;
    getURL?: (path: string) => string;
  };
  tabs?: {
    query: (queryInfo: {
      active?: boolean;
      currentWindow?: boolean;
    }) => Promise<Array<{ id?: number; url?: string; title?: string }>>;
    create: (props: { url: string }) => Promise<{ id?: number }>;
    sendMessage: (
      tabId: number,
      message: RuntimeMessageEnvelope,
    ) => Promise<ExtensionMessageResponse>;
  };
}

let activeTabId: number | null = null;
let activeTabUrl = '';
let activeTabInspectable = false;
let currentThemePref: ThemePreference = readCachedTheme();
let onPageDockActive = false;

function getChromeApi(): ChromePopupApis {
  return (globalThis as unknown as { chrome?: ChromePopupApis }).chrome ?? {};
}

function isInspectableHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function sendBg(
  operation: MessageOperation,
  payload: Record<string, unknown> = {},
): Promise<ExtensionMessageResponse> {
  const api = getChromeApi();
  if (!api.runtime?.sendMessage) {
    throw new Error('Extension runtime messaging is unavailable');
  }
  return api.runtime.sendMessage({
    schemaVersion: 1,
    requestId: `pop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    operation,
    payload,
  });
}

async function openPersistentWorkspace(tool?: ToolId, autorun = false): Promise<void> {
  const api = getChromeApi();
  const base = api.runtime?.getURL ? api.runtime.getURL('workspace.html') : 'workspace.html';
  const params = new URLSearchParams();
  if (activeTabId !== null && activeTabInspectable) {
    params.set('tabId', String(activeTabId));
    params.set('targetUrl', activeTabUrl);
  }
  if (tool) {
    params.set('tool', tool);
  }
  if (autorun && activeTabInspectable) {
    params.set('autorun', '1');
  }
  const query = params.toString();
  const targetUrl = query ? `${base}?${query}` : base;

  if (api.tabs?.create) {
    await api.tabs.create({ url: targetUrl });
  } else {
    window.open(targetUrl, '_blank', 'noopener');
  }
}

function updateThemeButtonLabel(): void {
  const btn = document.getElementById('popup-theme-btn');
  if (btn) {
    btn.textContent = formatThemeLabel(currentThemePref);
  }
}

async function syncThemeFromSettings(): Promise<void> {
  applyThemePreference(currentThemePref);
  updateThemeButtonLabel();
  try {
    const res = await sendBg('GET_SETTINGS');
    if (res.ok) {
      const settings = (res.data as { settings?: { theme?: ThemePreference } }).settings;
      if (
        settings?.theme === 'system' ||
        settings?.theme === 'light' ||
        settings?.theme === 'dark'
      ) {
        currentThemePref = settings.theme;
        applyThemePreference(currentThemePref);
        updateThemeButtonLabel();
      }
    }
  } catch {
    return;
  }
}

async function inspectCurrentTabState(): Promise<void> {
  const api = getChromeApi();
  const statusPill = document.getElementById('popup-page-status');
  const statusText = document.getElementById('popup-page-status-text');
  const titleEl = document.getElementById('popup-page-title');
  const urlEl = document.getElementById('popup-page-url');
  const restrictedEl = document.getElementById('popup-restricted-notice');
  const dockBtn = document.getElementById('popup-toggle-dock-btn') as HTMLButtonElement | null;

  const params = new URLSearchParams(window.location.search);
  const queryTabId = params.get('tabId');
  const queryUrl = params.get('targetUrl');

  let tabTitle = 'Active Browser Tab';
  if (queryTabId && /^\d+$/.test(queryTabId) && queryUrl) {
    activeTabId = Number.parseInt(queryTabId, 10);
    activeTabUrl = queryUrl;
    tabTitle = params.get('targetTitle') ?? queryUrl;
  } else if (api.tabs?.query) {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    const first = tabs[0];
    if (first && typeof first.id === 'number') {
      activeTabId = first.id;
      activeTabUrl = first.url ?? '';
      tabTitle = first.title ?? first.url ?? 'Untitled Page';
    }
  }

  activeTabInspectable = activeTabId !== null && isInspectableHttpUrl(activeTabUrl);

  if (titleEl) {
    titleEl.textContent = tabTitle;
  }
  if (urlEl) {
    urlEl.textContent = activeTabUrl || 'No active web URL detected';
  }

  if (activeTabInspectable) {
    statusPill?.classList.remove('warning', 'danger');
    statusPill?.classList.add('success');
    if (statusText) {
      statusText.textContent = 'Ready to inspect';
    }
    if (restrictedEl) {
      restrictedEl.style.display = 'none';
    }
    if (dockBtn) {
      dockBtn.disabled = false;
    }
    if (activeTabId !== null && api.tabs?.sendMessage) {
      try {
        const ctx = await api.tabs.sendMessage(activeTabId, {
          schemaVersion: 1,
          requestId: `pop-ctx-${Date.now()}`,
          operation: 'GET_DOCUMENT_CONTEXT',
          tabId: activeTabId,
          payload: {},
        });
        if (ctx.ok) {
          const data = ctx.data as { activeTool?: string | null; pageTitle?: string };
          onPageDockActive = Boolean(data.activeTool);
          if (dockBtn) {
            dockBtn.textContent = onPageDockActive
              ? 'Hide On-Page Inspector Dock'
              : 'Show On-Page Inspector Dock';
          }
          if (data.pageTitle && titleEl) {
            titleEl.textContent = data.pageTitle;
          }
        }
      } catch {
        if (statusText) {
          statusText.textContent = 'Reload page to attach script';
        }
        statusPill?.classList.remove('success');
        statusPill?.classList.add('warning');
      }
    }
  } else {
    statusPill?.classList.remove('success');
    statusPill?.classList.add('warning');
    if (statusText) {
      statusText.textContent = 'Restricted page';
    }
    if (restrictedEl) {
      restrictedEl.style.display = 'block';
    }
    if (dockBtn) {
      dockBtn.disabled = true;
    }
    document.querySelectorAll<HTMLButtonElement>('button[data-quick-tool]').forEach((btn) => {
      btn.disabled = true;
    });
  }
}

async function loadRecentLocalWork(): Promise<void> {
  const listEl = document.getElementById('popup-recent-list');
  const summaryEl = document.getElementById('popup-storage-summary');
  if (!listEl) {
    return;
  }

  try {
    const [projRes, jobsRes, usageRes] = await Promise.all([
      sendBg('LIST_PROJECTS_FROM_IDB'),
      sendBg('LIST_JOBS'),
      sendBg('GET_STORAGE_USAGE'),
    ]);

    if (usageRes.ok && summaryEl) {
      const usage = (
        usageRes.data as {
          usage: { projectCount: number; artifactCount: number; captureCount: number };
        }
      ).usage;
      summaryEl.textContent = `${usage.projectCount} proj · ${usage.artifactCount} artifacts · ${usage.captureCount} captures`;
    }

    listEl.textContent = '';
    const items: Array<{ label: string; badge: string; tone: string }> = [];

    if (jobsRes.ok) {
      const jobs = (
        jobsRes.data as { jobs: Array<{ tool: string; status: string; statusMessage: string }> }
      ).jobs;
      for (const job of jobs.slice(0, 3)) {
        const tone =
          job.status === 'completed'
            ? 'success'
            : job.status === 'interrupted' || job.status === 'failed'
              ? 'warning'
              : 'accent';
        items.push({
          label: `${job.tool.replace('_', ' ')}: ${job.statusMessage}`,
          badge: job.status,
          tone,
        });
      }
    }

    if (projRes.ok) {
      const data = projRes.data as {
        artifacts: Array<{ title: string; kind: string }>;
        captures: Array<{ pageTitle: string; mimeType: string }>;
      };
      for (const art of data.artifacts.slice(0, 3)) {
        items.push({ label: art.title, badge: art.kind.replace('_', ' '), tone: '' });
      }
      for (const cap of data.captures.slice(0, 2)) {
        items.push({ label: cap.pageTitle, badge: cap.mimeType.split('/')[1] ?? 'img', tone: '' });
      }
    }

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.style.fontSize = '11.5px';
      empty.textContent = 'No saved local artifacts yet. Run any tool in Workspace.';
      listEl.appendChild(empty);
      return;
    }

    for (const item of items.slice(0, 5)) {
      const row = document.createElement('div');
      row.className = 'popup-recent-item';
      const label = document.createElement('span');
      label.className = 'truncate';
      label.textContent = item.label;
      const badge = document.createElement('span');
      badge.className = item.tone ? `pill ${item.tone}` : 'pill';
      badge.textContent = item.badge;
      row.appendChild(label);
      row.appendChild(badge);
      listEl.appendChild(row);
    }
  } catch {
    listEl.textContent = 'Local storage status unavailable.';
  }
}

function attachQuickToolIcons(): void {
  document.querySelectorAll<HTMLButtonElement>('button[data-quick-tool]').forEach((btn) => {
    const tool = btn.getAttribute('data-quick-tool');
    if (tool) {
      btn.prepend(createSvgIcon(tool));
    }
  });
  const openBtn = document.getElementById('popup-open-workspace-btn');
  openBtn?.prepend(createSvgIcon('external'));
}

function initPopup(): void {
  attachQuickToolIcons();
  void syncThemeFromSettings();
  void inspectCurrentTabState();
  void loadRecentLocalWork();

  document.getElementById('popup-theme-btn')?.addEventListener('click', () => {
    void (async () => {
      currentThemePref = nextThemePreference(currentThemePref);
      applyThemePreference(currentThemePref);
      updateThemeButtonLabel();
      await sendBg('UPDATE_SETTINGS', { settings: { theme: currentThemePref } }).catch(
        () => undefined,
      );
    })();
  });

  document.getElementById('popup-open-workspace-btn')?.addEventListener('click', () => {
    void openPersistentWorkspace();
  });

  document.getElementById('popup-quick-grid')?.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest('button[data-quick-tool]');
    if (!btn) {
      return;
    }
    const tool = btn.getAttribute('data-quick-tool') as ToolId | null;
    if (tool) {
      void openPersistentWorkspace(tool, true);
    }
  });

  document.getElementById('popup-toggle-dock-btn')?.addEventListener('click', () => {
    void (async () => {
      const api = getChromeApi();
      const statusMsg = document.getElementById('popup-status-msg');
      const dockBtn = document.getElementById('popup-toggle-dock-btn');
      if (activeTabId === null || !activeTabInspectable || !api.tabs?.sendMessage) {
        if (statusMsg) {
          statusMsg.textContent = 'Switch to an active HTTP/HTTPS page to toggle the on-page dock.';
        }
        return;
      }
      try {
        const ctx = await api.tabs.sendMessage(activeTabId, {
          schemaVersion: 1,
          requestId: `pop-doc-${Date.now()}`,
          operation: 'GET_DOCUMENT_CONTEXT',
          tabId: activeTabId,
          payload: {},
        });
        if (!ctx.ok) {
          throw new Error(ctx.error.message);
        }
        const documentId = (ctx.data as { documentId: string }).documentId;
        onPageDockActive = !onPageDockActive;
        const res = await api.tabs.sendMessage(activeTabId, {
          schemaVersion: 1,
          requestId: `pop-dock-${Date.now()}`,
          operation: onPageDockActive ? 'ACTIVATE_TOOL' : 'DEACTIVATE_TOOLS',
          tabId: activeTabId,
          documentId,
          payload: onPageDockActive ? { tool: 'inspect' } : {},
        });
        if (!res.ok) {
          throw new Error(res.error.message);
        }
        if (dockBtn) {
          dockBtn.textContent = onPageDockActive
            ? 'Hide On-Page Inspector Dock'
            : 'Show On-Page Inspector Dock';
        }
        if (statusMsg) {
          statusMsg.textContent = onPageDockActive
            ? 'On-page dock activated. Press Escape on the page to dismiss.'
            : 'On-page dock dismissed.';
        }
      } catch (err: unknown) {
        if (statusMsg) {
          statusMsg.textContent =
            err instanceof Error ? err.message : 'Unable to reach page content script.';
        }
      }
    })();
  });
}

if (typeof document !== 'undefined') {
  initPopup();
}
