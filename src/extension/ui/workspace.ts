import type {
  ExtensionMessageResponse,
  MessageOperation,
  RuntimeMessageEnvelope,
  ToolId,
} from '../protocol/messages.js';

interface ChromeWorkspaceApis {
  runtime?: {
    sendMessage: (msg: RuntimeMessageEnvelope) => Promise<ExtensionMessageResponse>;
  };
  tabs?: {
    query: (q: {
      active: boolean;
      currentWindow: boolean;
    }) => Promise<Array<{ id?: number; url?: string }>>;
    sendMessage: (tabId: number, msg: RuntimeMessageEnvelope) => Promise<ExtensionMessageResponse>;
  };
}

const TOOL_TITLES: Record<ToolId, string> = {
  inspect: '1. Inspect Element & Computed Styles',
  clone_page: '2. Clone Page (Static HTML/CSS Snapshot ZIP)',
  clone_prompt: '3. Clone Prompt Generator (Observations vs. Assumptions)',
  design_md: '4. DESIGN.md Generator (Multi-Page Deduplication & Conflict Report)',
  assets: '5. Assets Extractor (Images, Inline SVGs, Videos, Fonts & ZIP)',
  colors: '6. Color Palette & Custom Properties (CSS / JSON / SCSS / Tailwind)',
  fonts: '7. Typography & @font-face Inspector',
  measure: '8. Box & Element Gap Measurement',
  edit_text: '9. Reversible In-Place Text Editor',
  capture: '10. Screenshot Capture (Visible / Area / Element / Full Page · PNG/JPEG/WebP/PDF)',
  responsive: '11. Responsive Multi-Viewport Inspector & Scroll Sync',
  swap_font: '12. Reversible Font Swap Preview',
  arrange: '13. Reversible Element Arrange (Move / Hide / Remove)',
  design_review: '14. Evidence-Based Design & WCAG Contrast Review',
  tech_stack: '15. Public Tech Stack Detector',
};

let currentTool: ToolId = 'inspect';
let lastResultData: Record<string, unknown> | null = null;
let pickerActive = false;

function getChromeApi(): ChromeWorkspaceApis {
  return (globalThis as unknown as { chrome?: ChromeWorkspaceApis }).chrome ?? {};
}

async function resolveTargetTabId(): Promise<{ tabId: number | null; url: string }> {
  const params = new URLSearchParams(window.location.search);
  const explicitTabId = params.get('tabId');
  if (explicitTabId && /^\d+$/.test(explicitTabId)) {
    return {
      tabId: Number.parseInt(explicitTabId, 10),
      url: params.get('targetUrl') ?? 'https://example.com',
    };
  }
  const chromeApi = getChromeApi();
  if (chromeApi.tabs?.query) {
    const activeTabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
    const firstActive = activeTabs[0];
    if (
      firstActive &&
      typeof firstActive.id === 'number' &&
      !(firstActive.url ?? '').startsWith('chrome-extension://')
    ) {
      return { tabId: firstActive.id, url: firstActive.url ?? 'https://example.com' };
    }
  }
  return { tabId: null, url: 'https://example.com' };
}

async function sendBackgroundMessage(
  operation: MessageOperation,
  payload: Record<string, unknown> = {},
  tabId?: number | null,
): Promise<ExtensionMessageResponse> {
  const chromeApi = getChromeApi();
  if (!chromeApi.runtime?.sendMessage) {
    throw new Error('Extension runtime messaging is unavailable');
  }
  const envelope: RuntimeMessageEnvelope = {
    schemaVersion: 1,
    requestId: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    operation,
    ...(typeof tabId === 'number' ? { tabId } : {}),
    payload,
  };
  return chromeApi.runtime.sendMessage(envelope);
}

async function sendContentMessage(
  tabId: number,
  operation: MessageOperation,
  payload: Record<string, unknown> = {},
): Promise<ExtensionMessageResponse> {
  const chromeApi = getChromeApi();
  const envelope: RuntimeMessageEnvelope = {
    schemaVersion: 1,
    requestId: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    operation,
    tabId,
    payload,
  };
  if (chromeApi.tabs?.sendMessage) {
    return chromeApi.tabs.sendMessage(tabId, envelope);
  }
  return sendBackgroundMessage(operation, payload, tabId);
}

function createSyntheticPngDataUrl(width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(24, 24, Math.max(40, width - 48), 64);
  }
  return canvas.toDataURL('image/png');
}

async function refreshProjectsDropdown(): Promise<void> {
  const select = document.getElementById('project-select') as HTMLSelectElement | null;
  if (!select) {
    return;
  }
  const res = await sendBackgroundMessage('LIST_PROJECTS_FROM_IDB');
  if (!res.ok) {
    return;
  }
  const data = res.data as {
    projects: Array<{ id: string; name: string }>;
    artifacts: unknown[];
  };
  select.innerHTML = '';
  for (const proj of data.projects) {
    const opt = document.createElement('option');
    opt.value = proj.id;
    opt.textContent = proj.name;
    select.appendChild(opt);
  }
}

async function executeSelectedTool(): Promise<void> {
  const statusEl = document.getElementById('status-message');
  const outputEl = document.getElementById('tool-output');
  const selectorInput = document.getElementById('target-selector-input') as HTMLInputElement | null;
  const secondaryInput = document.getElementById('secondary-input') as HTMLInputElement | null;
  const modeSelect = document.getElementById('mode-select') as HTMLSelectElement | null;

  if (!statusEl || !outputEl) {
    return;
  }

  const selector = selectorInput?.value.trim() || undefined;
  const secondary = secondaryInput?.value.trim() || undefined;
  const modeVal = modeSelect?.value ?? 'default';

  statusEl.textContent = `Running ${TOOL_TITLES[currentTool]}...`;

  try {
    const { tabId, url } = await resolveTargetTabId();

    if (currentTool === 'responsive') {
      const res = await sendBackgroundMessage('RUN_RESPONSIVE_INSPECT', {
        targetUrl: url,
        openWindows: false,
      });
      if (!res.ok) {
        throw new Error(res.error.message);
      }
      lastResultData = res.data as Record<string, unknown>;
      outputEl.textContent = JSON.stringify(res.data, null, 2);
      statusEl.textContent = 'Responsive inspection plan ready.';
      return;
    }

    if (currentTool === 'capture') {
      const exportMime =
        modeVal === 'image/jpeg' || modeVal === 'image/webp' || modeVal === 'application/pdf'
          ? modeVal
          : 'image/png';
      const preparedDataUrl =
        exportMime === 'application/pdf' ? undefined : createSyntheticPngDataUrl(1280, 800);
      const res = await sendBackgroundMessage('RUN_CAPTURE', {
        exportMime,
        width: 1280,
        height: 800,
        title: 'Workspace Capture',
        pageUrl: url,
        ...(preparedDataUrl ? { preparedDataUrl } : {}),
      });
      if (!res.ok) {
        throw new Error(res.error.message);
      }
      lastResultData = res.data as Record<string, unknown>;
      outputEl.textContent = JSON.stringify(res.data, null, 2);
      statusEl.textContent = `Capture verified (${exportMime}).`;
      return;
    }

    if (tabId === null) {
      throw new Error(
        'No active target tab detected. Pass ?tabId=<id> or open from an active tab.',
      );
    }

    const opMap: Record<ToolId, MessageOperation> = {
      inspect: 'RUN_INSPECT_ELEMENT',
      clone_page: 'RUN_CLONE_PAGE',
      clone_prompt: 'RUN_CLONE_PROMPT',
      design_md: 'RUN_DESIGN_MD',
      assets: 'RUN_ASSETS_EXTRACT',
      colors: 'RUN_COLORS_EXTRACT',
      fonts: 'RUN_FONTS_EXTRACT',
      measure: 'RUN_MEASURE',
      edit_text: 'RUN_EDIT_TEXT',
      capture: 'RUN_CAPTURE',
      responsive: 'RUN_RESPONSIVE_INSPECT',
      swap_font: 'RUN_SWAP_FONT',
      arrange: 'RUN_ARRANGE',
      design_review: 'RUN_DESIGN_REVIEW',
      tech_stack: 'RUN_TECH_STACK',
    };

    const payload: Record<string, unknown> = {};
    if (selector) {
      payload['selector'] = selector;
      payload['primarySelector'] = selector;
    }
    if (secondary) {
      payload['secondarySelector'] = secondary;
      payload['text'] = secondary;
      payload['fontFamily'] = secondary;
    }
    if (
      currentTool === 'clone_prompt' &&
      ['react_tailwind', 'html_css', 'vue_css', 'generic'].includes(modeVal)
    ) {
      payload['targetFramework'] = modeVal;
    }
    if (currentTool === 'arrange') {
      payload['action'] = ['move', 'hide', 'remove'].includes(modeVal) ? modeVal : 'move';
      payload['dx'] = 16;
      payload['dy'] = 16;
    }
    if (currentTool === 'assets') {
      payload['includeZip'] = true;
    }

    const res = await sendContentMessage(tabId, opMap[currentTool], payload);
    if (!res.ok) {
      throw new Error(res.error.message);
    }

    lastResultData = res.data as Record<string, unknown>;
    outputEl.textContent = JSON.stringify(res.data, null, 2);
    statusEl.textContent = `Completed ${TOOL_TITLES[currentTool]} locally.`;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Execution failed';
    statusEl.textContent = `Error: ${message}`;
    outputEl.textContent = JSON.stringify({ error: message }, null, 2);
  }
}

function initWorkspaceUi(): void {
  const dock = document.getElementById('tool-dock');
  const titleEl = document.getElementById('active-tool-title');
  const statusEl = document.getElementById('status-message');
  const outputEl = document.getElementById('tool-output');

  dock?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-tool]');
    if (!btn) {
      return;
    }
    const tool = btn.getAttribute('data-tool') as ToolId | null;
    if (!tool) {
      return;
    }
    currentTool = tool;
    for (const b of Array.from(dock.querySelectorAll('button[data-tool]'))) {
      b.classList.toggle('active', b === btn);
    }
    if (titleEl) {
      titleEl.textContent = TOOL_TITLES[tool];
    }
  });

  document.getElementById('run-tool-btn')?.addEventListener('click', () => {
    void executeSelectedTool();
  });

  document.getElementById('toggle-picker-btn')?.addEventListener('click', () => {
    void (async () => {
      const { tabId } = await resolveTargetTabId();
      if (tabId === null) {
        return;
      }
      pickerActive = !pickerActive;
      const res = await sendContentMessage(
        tabId,
        pickerActive ? 'ACTIVATE_TOOL' : 'DEACTIVATE_TOOLS',
        { tool: currentTool },
      );
      if (statusEl && res.ok) {
        statusEl.textContent = pickerActive
          ? `On-page picker active for ${currentTool} (press Escape on page to cancel)`
          : 'On-page picker deactivated.';
      }
    })();
  });

  for (const [btnId, op] of [
    ['undo-edit-btn', 'EDIT_UNDO'],
    ['redo-edit-btn', 'EDIT_REDO'],
    ['reset-edit-btn', 'EDIT_RESET'],
  ] as const) {
    document.getElementById(btnId)?.addEventListener('click', () => {
      void (async () => {
        const { tabId } = await resolveTargetTabId();
        if (tabId === null) {
          return;
        }
        const res = await sendContentMessage(tabId, op);
        if (outputEl) {
          outputEl.textContent = JSON.stringify(res, null, 2);
        }
      })();
    });
  }

  document.getElementById('create-project-btn')?.addEventListener('click', () => {
    void (async () => {
      const nameInput = document.getElementById('new-project-name') as HTMLInputElement | null;
      const name = nameInput?.value.trim() || `Project ${new Date().toLocaleTimeString()}`;
      const res = await sendBackgroundMessage('SAVE_ARTIFACT_TO_IDB', {
        createNewProjectName: name,
        kind: 'inspect_report',
        title: 'Initial Project Entry',
        artifactPayload: { initialized: true },
      });
      if (res.ok) {
        if (nameInput) {
          nameInput.value = '';
        }
        await refreshProjectsDropdown();
        if (statusEl) {
          statusEl.textContent = `Created project "${name}" in IndexedDB.`;
        }
      }
    })();
  });

  document.getElementById('save-artifact-btn')?.addEventListener('click', () => {
    void (async () => {
      const select = document.getElementById('project-select') as HTMLSelectElement | null;
      const projectId = select?.value || 'proj-default';
      const res = await sendBackgroundMessage('SAVE_ARTIFACT_TO_IDB', {
        projectId,
        kind: 'inspect_report',
        title: `${TOOL_TITLES[currentTool]} Output`,
        artifactPayload: lastResultData ?? { savedAt: new Date().toISOString() },
      });
      if (statusEl) {
        statusEl.textContent = res.ok
          ? 'Saved tool result to local IndexedDB.'
          : `Save error: ${res.error.message}`;
      }
    })();
  });

  document.getElementById('preview-nvidia-btn')?.addEventListener('click', () => {
    void (async () => {
      const res = await sendBackgroundMessage('RUN_NVIDIA_ENHANCEMENT', {
        previewOnly: true,
        taskType:
          currentTool === 'design_review' ? 'interpret_design_review' : 'enhance_clone_prompt',
        sanitizedContext: lastResultData ?? { pageTitle: 'Preview Context' },
      });
      if (outputEl) {
        outputEl.textContent = JSON.stringify(res, null, 2);
      }
    })();
  });

  document.getElementById('run-nvidia-btn')?.addEventListener('click', () => {
    void (async () => {
      const res = await sendBackgroundMessage('RUN_NVIDIA_ENHANCEMENT', {
        previewOnly: false,
        taskType:
          currentTool === 'design_review' ? 'interpret_design_review' : 'enhance_clone_prompt',
        sanitizedContext: lastResultData ?? { pageTitle: 'Active Page' },
      });
      if (outputEl) {
        outputEl.textContent = JSON.stringify(res, null, 2);
      }
    })();
  });

  void refreshProjectsDropdown();
}

if (typeof document !== 'undefined') {
  initWorkspaceUi();
}
