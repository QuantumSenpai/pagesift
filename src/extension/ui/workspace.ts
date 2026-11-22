import {
  buildPdfDocumentFromCapture,
  decodeBase64ToBytes,
  encodeBytesToBase64,
  verifyCaptureBinaryAndDimensions,
  type CaptureAnnotation,
  type CaptureExportMime,
  type CaptureMode,
  type CaptureRect,
} from '../engines/capture-engine.js';
import {
  DEFAULT_RESPONSIVE_PRESETS,
  type ResponsiveViewportPreset,
} from '../engines/responsive-engine.js';
import type {
  ExtensionMessageResponse,
  MessageOperation,
  RuntimeMessageEnvelope,
  ToolId,
} from '../protocol/messages.js';
import type { LocalArtifactKind } from '../storage/idb-storage.js';

interface ChromeWorkspaceApis {
  runtime?: {
    getURL?: (path: string) => string;
    sendMessage: (msg: RuntimeMessageEnvelope) => Promise<ExtensionMessageResponse>;
  };
  tabs?: {
    query: (q: {
      active: boolean;
      currentWindow: boolean;
    }) => Promise<Array<{ id?: number; url?: string }>>;
    create?: (props: { url: string }) => Promise<unknown>;
    sendMessage: (tabId: number, msg: RuntimeMessageEnvelope) => Promise<ExtensionMessageResponse>;
  };
  permissions?: {
    contains: (perms: { origins: string[] }) => Promise<boolean>;
    request: (perms: { origins: string[] }) => Promise<boolean>;
  };
}

interface DownloadableArtifact {
  filename: string;
  mimeType: string;
  bytes?: Uint8Array;
  textContent?: string;
}

interface CaptureWorkState {
  basePngDataUrl: string;
  currentDataUrl: string;
  mimeType: CaptureExportMime;
  width: number;
  height: number;
  mode: CaptureMode;
  pageTitle: string;
  pageUrl: string;
  annotations: CaptureAnnotation[];
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

const TOOL_TO_ARTIFACT_KIND: Record<ToolId, LocalArtifactKind> = {
  inspect: 'inspect_report',
  clone_page: 'clone_snapshot',
  clone_prompt: 'clone_prompt',
  design_md: 'design_md',
  assets: 'asset_manifest',
  colors: 'color_palette',
  fonts: 'font_report',
  measure: 'inspect_report',
  edit_text: 'inspect_report',
  capture: 'capture_image',
  responsive: 'inspect_report',
  swap_font: 'font_report',
  arrange: 'inspect_report',
  design_review: 'design_review',
  tech_stack: 'tech_stack',
};

let currentTool: ToolId = 'inspect';
let lastResultTool: ToolId | null = null;
let lastResultData: Record<string, unknown> | null = null;
let lastTargetPageUrl = 'https://example.com';
let lastTargetPageTitle = 'pagesift';
let lastDownloadable: DownloadableArtifact | null = null;
let lastCopyableText: string | null = null;
let lastCaptureState: CaptureWorkState | null = null;
let confirmedNvidiaDigest: string | null = null;
let confirmedNvidiaTaskType: 'enhance_clone_prompt' | 'interpret_design_review' | null = null;
let activeJobRequestId: string | null = null;
let pickerActive = false;
const activeObjectUrls = new Set<string>();

function getChromeApi(): ChromeWorkspaceApis {
  return (globalThis as unknown as { chrome?: ChromeWorkspaceApis }).chrome ?? {};
}

function makeSlug(rawTitle: string): string {
  const cleaned = rawTitle
    .normalize('NFC')
    .replace(/[/\\?%*:|"<>#]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return cleaned || 'pagesift';
}

function setStatus(message: string, variant: 'neutral' | 'error' | 'success' = 'neutral'): void {
  const statusEl = document.getElementById('status-message');
  if (!statusEl) {
    return;
  }
  statusEl.textContent = message;
  statusEl.classList.remove('error', 'success');
  if (variant !== 'neutral') {
    statusEl.classList.add(variant);
  }
}

function clearNvidiaConfirmation(): void {
  confirmedNvidiaDigest = null;
  confirmedNvidiaTaskType = null;
  const runBtn = document.getElementById('run-nvidia-btn') as HTMLButtonElement | null;
  if (runBtn) {
    runBtn.disabled = true;
  }
}

function setActiveJobState(requestId: string | null): void {
  activeJobRequestId = requestId;
  const cancelBtn = document.getElementById('cancel-job-btn') as HTMLButtonElement | null;
  const runBtn = document.getElementById('run-tool-btn') as HTMLButtonElement | null;
  if (cancelBtn) {
    cancelBtn.disabled = requestId === null;
  }
  if (runBtn) {
    runBtn.disabled = requestId !== null;
  }
}

function updateSubPanelsForTool(tool: ToolId): void {
  const capturePanel = document.getElementById('capture-controls');
  const responsivePanel = document.getElementById('responsive-controls');
  const colorsPanel = document.getElementById('colors-controls');
  capturePanel?.classList.toggle('visible', tool === 'capture');
  responsivePanel?.classList.toggle('visible', tool === 'responsive');
  colorsPanel?.classList.toggle('visible', tool === 'colors');
}

function updateActionButtons(): void {
  const dlBtn = document.getElementById('download-result-btn') as HTMLButtonElement | null;
  const copyBtn = document.getElementById('copy-result-btn') as HTMLButtonElement | null;
  const metaEl = document.getElementById('download-meta');
  if (dlBtn) {
    dlBtn.disabled = lastDownloadable === null;
    dlBtn.textContent = lastDownloadable
      ? `Download ${lastDownloadable.filename}`
      : 'Download File';
  }
  if (copyBtn) {
    copyBtn.disabled = lastCopyableText === null;
  }
  if (metaEl) {
    if (lastDownloadable) {
      const sizeBytes = lastDownloadable.bytes
        ? lastDownloadable.bytes.byteLength
        : new TextEncoder().encode(lastDownloadable.textContent ?? '').byteLength;
      metaEl.textContent = `Ready: ${lastDownloadable.filename} (${lastDownloadable.mimeType}, ${sizeBytes.toLocaleString()} bytes)`;
    } else {
      metaEl.textContent = 'Run a tool to generate downloadable or copyable output.';
    }
  }
}

function updateCapturePreviewUi(): void {
  const wrap = document.getElementById('capture-preview-wrap');
  const img = document.getElementById('capture-preview-img') as HTMLImageElement | null;
  const meta = document.getElementById('capture-meta');
  const cropBtn = document.getElementById('apply-crop-btn') as HTMLButtonElement | null;
  const annBtn = document.getElementById('add-annotation-btn') as HTMLButtonElement | null;

  if (!lastCaptureState) {
    wrap?.classList.remove('visible');
    if (cropBtn) {
      cropBtn.disabled = true;
    }
    if (annBtn) {
      annBtn.disabled = true;
    }
    return;
  }

  wrap?.classList.add('visible');
  if (img) {
    img.src =
      lastCaptureState.mimeType === 'application/pdf'
        ? lastCaptureState.basePngDataUrl
        : lastCaptureState.currentDataUrl;
  }
  if (meta) {
    meta.textContent = `Captured ${lastCaptureState.width}×${lastCaptureState.height}px (${lastCaptureState.mimeType}) · Annotations: ${lastCaptureState.annotations.length}`;
  }
  if (cropBtn) {
    cropBtn.disabled = false;
  }
  if (annBtn) {
    annBtn.disabled = false;
  }
}

function buildDownloadableForTool(
  tool: ToolId,
  data: Record<string, unknown>,
  slug: string,
): { downloadable: DownloadableArtifact | null; copyableText: string | null } {
  if (tool === 'clone_page' && typeof data['zipBase64'] === 'string') {
    const bytes = decodeBase64ToBytes(data['zipBase64']);
    return {
      downloadable: {
        filename: `pagesift-clone-${slug}.zip`,
        mimeType: 'application/zip',
        bytes,
      },
      copyableText: JSON.stringify(data['manifest'] ?? data, null, 2),
    };
  }

  if (tool === 'assets' && typeof data['zipBase64'] === 'string') {
    const bytes = decodeBase64ToBytes(data['zipBase64']);
    return {
      downloadable: {
        filename: `pagesift-assets-${slug}.zip`,
        mimeType: 'application/zip',
        bytes,
      },
      copyableText: JSON.stringify(data['report'] ?? data, null, 2),
    };
  }

  if (tool === 'design_md') {
    const resObj = data['result'] as { markdown?: string } | undefined;
    const markdown =
      typeof resObj?.markdown === 'string' ? resObj.markdown : JSON.stringify(data, null, 2);
    return {
      downloadable: {
        filename: `DESIGN-${slug}.md`,
        mimeType: 'text/markdown;charset=utf-8',
        textContent: markdown,
      },
      copyableText: markdown,
    };
  }

  if (tool === 'clone_prompt') {
    const rep = data['report'] as { prompt?: string } | undefined;
    const promptText = typeof rep?.prompt === 'string' ? rep.prompt : JSON.stringify(data, null, 2);
    return {
      downloadable: {
        filename: `pagesift-clone-prompt-${slug}.md`,
        mimeType: 'text/markdown;charset=utf-8',
        textContent: promptText,
      },
      copyableText: promptText,
    };
  }

  if (tool === 'colors') {
    const rep = data['report'] as { exports?: Record<string, string> } | undefined;
    const formatSel = document.getElementById('colors-export-format') as HTMLSelectElement | null;
    const selected = formatSel?.value ?? 'cssVariables';
    const extMap: Record<string, { ext: string; mime: string }> = {
      cssVariables: { ext: 'css', mime: 'text/css;charset=utf-8' },
      tailwindV4: { ext: 'css', mime: 'text/css;charset=utf-8' },
      tailwindV3: { ext: 'js', mime: 'text/javascript;charset=utf-8' },
      scss: { ext: 'scss', mime: 'text/plain;charset=utf-8' },
      json: { ext: 'json', mime: 'application/json;charset=utf-8' },
    };
    const meta = extMap[selected] ?? { ext: 'css', mime: 'text/css;charset=utf-8' };
    const text = rep?.exports?.[selected] ?? JSON.stringify(data, null, 2);
    return {
      downloadable: {
        filename: `pagesift-colors-${slug}.${meta.ext}`,
        mimeType: meta.mime,
        textContent: text,
      },
      copyableText: text,
    };
  }

  if (tool === 'design_review') {
    const rep = data['report'] as { remediationPrompt?: string } | undefined;
    const md =
      typeof rep?.remediationPrompt === 'string'
        ? rep.remediationPrompt
        : JSON.stringify(data, null, 2);
    return {
      downloadable: {
        filename: `pagesift-design-review-${slug}.md`,
        mimeType: 'text/markdown;charset=utf-8',
        textContent: md,
      },
      copyableText: md,
    };
  }

  if (tool === 'capture' && typeof data['dataUrl'] === 'string') {
    const dataUrl = data['dataUrl'];
    const commaIdx = dataUrl.indexOf(',');
    const header = dataUrl.slice(5, commaIdx);
    const mimeType = (header.split(';')[0] || 'image/png') as CaptureExportMime;
    const extByMime: Record<CaptureExportMime, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'application/pdf': 'pdf',
    };
    const bytes = decodeBase64ToBytes(dataUrl.slice(commaIdx + 1));
    return {
      downloadable: {
        filename: `pagesift-capture-${slug}.${extByMime[mimeType]}`,
        mimeType,
        bytes,
      },
      copyableText: null,
    };
  }

  const jsonText = JSON.stringify(data, null, 2);
  return {
    downloadable: {
      filename: `pagesift-${tool}-${slug}.json`,
      mimeType: 'application/json;charset=utf-8',
      textContent: jsonText,
    },
    copyableText: jsonText,
  };
}

function triggerFileDownload(artifact: DownloadableArtifact): void {
  const blobParts: BlobPart[] = [];
  if (artifact.bytes) {
    const copy = new Uint8Array(artifact.bytes.byteLength);
    copy.set(artifact.bytes);
    blobParts.push(copy);
  } else {
    blobParts.push(artifact.textContent ?? '');
  }
  const blob = new Blob(blobParts, { type: artifact.mimeType });
  const objectUrl = URL.createObjectURL(blob);
  activeObjectUrls.add(objectUrl);

  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = artifact.filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
    activeObjectUrls.delete(objectUrl);
  }, 30000);
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

async function ensureOptionalOriginPermissionIfNeeded(targetUrl: string): Promise<boolean> {
  const chromeApi = getChromeApi();
  if (!chromeApi.permissions) {
    return true;
  }
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const originPattern = `${parsed.origin}/*`;
    const alreadyGranted = await chromeApi.permissions.contains({ origins: [originPattern] });
    if (alreadyGranted) {
      return true;
    }
    return await chromeApi.permissions.request({ origins: [originPattern] });
  } catch {
    return false;
  }
}

async function sendBackgroundMessage(
  operation: MessageOperation,
  payload: Record<string, unknown> = {},
  options: { tabId?: number | null; documentId?: string | undefined; requestId?: string } = {},
): Promise<ExtensionMessageResponse> {
  const chromeApi = getChromeApi();
  if (!chromeApi.runtime?.sendMessage) {
    throw new Error('Extension runtime messaging is unavailable');
  }
  const envelope: RuntimeMessageEnvelope = {
    schemaVersion: 1,
    requestId: options.requestId ?? `ui-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    operation,
    ...(typeof options.tabId === 'number' ? { tabId: options.tabId } : {}),
    ...(options.documentId ? { documentId: options.documentId } : {}),
    payload,
  };
  return chromeApi.runtime.sendMessage(envelope);
}

async function sendContentMessage(
  tabId: number,
  operation: MessageOperation,
  payload: Record<string, unknown> = {},
  documentId?: string,
): Promise<ExtensionMessageResponse> {
  const chromeApi = getChromeApi();
  const envelope: RuntimeMessageEnvelope = {
    schemaVersion: 1,
    requestId: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    operation,
    tabId,
    ...(documentId ? { documentId } : {}),
    payload,
  };
  if (chromeApi.tabs?.sendMessage) {
    return chromeApi.tabs.sendMessage(tabId, envelope);
  }
  return sendBackgroundMessage(operation, payload, { tabId, documentId });
}

async function getBoundDocumentContext(
  tabId: number,
): Promise<{ documentId: string; pageUrl: string; pageTitle: string }> {
  const res = await sendContentMessage(tabId, 'GET_DOCUMENT_CONTEXT', {});
  if (!res.ok) {
    throw new Error(res.error.message);
  }
  const data = res.data as { documentId: string; pageUrl?: string; pageTitle?: string };
  return {
    documentId: data.documentId,
    pageUrl: data.pageUrl ?? 'https://example.com',
    pageTitle: data.pageTitle ?? 'pagesift',
  };
}

async function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve(img);
    };
    img.onerror = () => {
      reject(new Error('Failed to decode captured image in workspace canvas'));
    };
    img.src = dataUrl;
  });
}

async function renderEditedCaptureInWorkspace(options: {
  sourceDataUrl: string;
  exportMime: CaptureExportMime;
  cropRect?: CaptureRect;
  annotations: CaptureAnnotation[];
  title: string;
  pageUrl: string;
}): Promise<{ dataUrl: string; basePngDataUrl: string; width: number; height: number }> {
  const img = await loadImageFromDataUrl(options.sourceDataUrl);
  const srcX = options.cropRect
    ? Math.max(0, Math.min(img.naturalWidth - 1, Math.round(options.cropRect.x)))
    : 0;
  const srcY = options.cropRect
    ? Math.max(0, Math.min(img.naturalHeight - 1, Math.round(options.cropRect.y)))
    : 0;
  const width = options.cropRect
    ? Math.max(1, Math.min(img.naturalWidth - srcX, Math.round(options.cropRect.width)))
    : img.naturalWidth;
  const height = options.cropRect
    ? Math.max(1, Math.min(img.naturalHeight - srcY, Math.round(options.cropRect.height)))
    : img.naturalHeight;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to acquire 2D canvas context');
  }
  ctx.drawImage(img, srcX, srcY, width, height, 0, 0, width, height);

  for (const ann of options.annotations) {
    ctx.strokeStyle = ann.color;
    ctx.lineWidth = 3;
    ctx.strokeRect(ann.x, ann.y, ann.width, ann.height);
    if (ann.label.trim().length > 0) {
      ctx.font = 'bold 13px sans-serif';
      const textWidth = Math.ceil(ctx.measureText(ann.label).width);
      const labelY = Math.max(0, ann.y - 22);
      ctx.fillStyle = ann.color;
      ctx.fillRect(ann.x, labelY, textWidth + 12, 22);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(ann.label, ann.x + 6, labelY + 15);
    }
  }

  const basePngDataUrl = canvas.toDataURL('image/png');
  if (options.exportMime === 'application/pdf') {
    const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const pdfDataUrl = buildPdfDocumentFromCapture({
      width,
      height,
      title: options.title,
      pageUrl: options.pageUrl,
      jpegDataUrl,
    });
    return { dataUrl: pdfDataUrl, basePngDataUrl, width, height };
  }

  const encoded = canvas.toDataURL(
    options.exportMime,
    options.exportMime === 'image/png' ? undefined : 0.92,
  );
  if (!encoded.startsWith(`data:${options.exportMime};base64,`)) {
    throw new Error(`Browser does not support encoding ${options.exportMime}`);
  }
  return { dataUrl: encoded, basePngDataUrl, width, height };
}

function summarizeOutputForDisplay(tool: ToolId, data: Record<string, unknown>): string {
  if (tool === 'capture') {
    const { dataUrl: _omitted, previewPngDataUrl: _omittedPreview, ...summary } = data;
    return JSON.stringify(summary, null, 2);
  }
  if (tool === 'clone_page' || tool === 'assets') {
    const { zipBase64: _omitted, ...summary } = data;
    return JSON.stringify(summary, null, 2);
  }
  if (tool === 'design_md') {
    const resObj = data['result'] as { markdown?: string } | undefined;
    if (typeof resObj?.markdown === 'string') {
      return resObj.markdown;
    }
  }
  if (tool === 'clone_prompt') {
    const rep = data['report'] as { prompt?: string } | undefined;
    if (typeof rep?.prompt === 'string') {
      return rep.prompt;
    }
  }
  return JSON.stringify(data, null, 2);
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
  };
  select.innerHTML = '';
  for (const proj of data.projects) {
    const opt = document.createElement('option');
    opt.value = proj.id;
    opt.textContent = proj.name;
    select.appendChild(opt);
  }
}

function renderResponsiveSessionStatus(session: unknown): void {
  const el = document.getElementById('responsive-session-status');
  if (!el) {
    return;
  }
  if (!session || typeof session !== 'object') {
    el.textContent = 'No active responsive preview session.';
    return;
  }
  const s = session as {
    syncEnabled?: boolean;
    windows?: Array<{
      label: string;
      requestedWidth: number;
      requestedHeight: number;
      actualInnerWidth: number | null;
      actualInnerHeight: number | null;
      sizeConstrainedByBrowser?: boolean;
    }>;
  };
  const wins = s.windows ?? [];
  if (wins.length === 0) {
    el.textContent = 'No active responsive preview windows.';
    return;
  }
  const details = wins
    .map((w) => {
      const actual =
        w.actualInnerWidth !== null && w.actualInnerHeight !== null
          ? `actual ${w.actualInnerWidth}×${w.actualInnerHeight}`
          : 'measuring...';
      return `${w.label} (${actual}${w.sizeConstrainedByBrowser ? ', browser-constrained' : ''})`;
    })
    .join(' | ');
  el.textContent = `Active windows (${wins.length}, sync ${s.syncEnabled ? 'ON' : 'OFF'}): ${details}`;
}

function collectSelectedResponsiveViewports(): ResponsiveViewportPreset[] {
  const checkboxes = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[name="resp-preset"]:checked'),
  );
  const selectedIds = new Set(checkboxes.map((cb) => cb.value));
  const presets = DEFAULT_RESPONSIVE_PRESETS.filter((p) => selectedIds.has(p.id));

  const customWInput = document.getElementById('resp-custom-w') as HTMLInputElement | null;
  const customHInput = document.getElementById('resp-custom-h') as HTMLInputElement | null;
  const cw = Number.parseInt(customWInput?.value ?? '', 10);
  const ch = Number.parseInt(customHInput?.value ?? '', 10);
  if (Number.isFinite(cw) && Number.isFinite(ch) && cw >= 240 && ch >= 320) {
    presets.push({
      id: `custom-${cw}x${ch}`,
      label: `Custom (${cw}×${ch})`,
      width: cw,
      height: ch,
      category: cw < 640 ? 'mobile' : cw < 1024 ? 'tablet' : 'desktop',
    });
  }

  return presets.length > 0 ? presets : DEFAULT_RESPONSIVE_PRESETS.slice(0, 2);
}

async function runResponsiveOpenAction(): Promise<void> {
  const outputEl = document.getElementById('tool-output');
  if (!outputEl) {
    return;
  }
  const { url } = await resolveTargetTabId();
  const syncToggle = document.getElementById('responsive-sync-toggle') as HTMLInputElement | null;
  const customViewports = collectSelectedResponsiveViewports();
  setStatus('Opening responsive preview windows and measuring actual viewports...');
  try {
    const res = await sendBackgroundMessage('RUN_RESPONSIVE_INSPECT', {
      targetUrl: url,
      openWindows: true,
      syncEnabled: syncToggle?.checked ?? true,
      customViewports,
    });
    if (!res.ok) {
      throw new Error(res.error.message);
    }
    const data = res.data as Record<string, unknown>;
    lastResultTool = 'responsive';
    lastResultData = data;
    clearNvidiaConfirmation();
    renderResponsiveSessionStatus(data['session']);
    outputEl.textContent = JSON.stringify(data, null, 2);
    const built = buildDownloadableForTool('responsive', data, makeSlug(lastTargetPageTitle));
    lastDownloadable = built.downloadable;
    lastCopyableText = built.copyableText;
    updateActionButtons();
    setStatus('Responsive preview windows opened with measured inner dimensions.', 'success');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Responsive inspection failed';
    setStatus(`Error: ${message}`, 'error');
    outputEl.textContent = JSON.stringify({ error: message }, null, 2);
  }
}

async function executeSelectedTool(): Promise<void> {
  const outputEl = document.getElementById('tool-output');
  const selectorInput = document.getElementById('target-selector-input') as HTMLInputElement | null;
  const secondaryInput = document.getElementById('secondary-input') as HTMLInputElement | null;
  const modeSelect = document.getElementById('mode-select') as HTMLSelectElement | null;

  if (!outputEl) {
    return;
  }

  if (currentTool === 'responsive') {
    await runResponsiveOpenAction();
    return;
  }

  const selector = selectorInput?.value.trim() || undefined;
  const secondary = secondaryInput?.value.trim() || undefined;
  const modeVal = modeSelect?.value ?? 'default';

  const requestId = `job-${currentTool}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  setActiveJobState(requestId);
  clearNvidiaConfirmation();
  setStatus(`Running ${TOOL_TITLES[currentTool]}...`);

  try {
    const { tabId, url } = await resolveTargetTabId();
    if (tabId === null) {
      throw new Error(
        'No active target tab detected. Open PageSift from a web tab or pass ?tabId=<id>.',
      );
    }

    const docCtx = await getBoundDocumentContext(tabId);
    lastTargetPageUrl = docCtx.pageUrl || url;
    lastTargetPageTitle = docCtx.pageTitle || 'pagesift';

    if (currentTool === 'capture') {
      const capModeSel = document.getElementById('capture-mode-select') as HTMLSelectElement | null;
      const capFmtSel = document.getElementById(
        'capture-format-select',
      ) as HTMLSelectElement | null;
      const mode = (capModeSel?.value as CaptureMode | undefined) ?? 'visible';
      const exportMime = (capFmtSel?.value as CaptureExportMime | undefined) ?? 'image/png';

      let rect: CaptureRect | undefined;
      if (mode === 'area') {
        const x = Number.parseInt(
          (document.getElementById('crop-x') as HTMLInputElement | null)?.value ?? '0',
          10,
        );
        const y = Number.parseInt(
          (document.getElementById('crop-y') as HTMLInputElement | null)?.value ?? '0',
          10,
        );
        const width = Number.parseInt(
          (document.getElementById('crop-w') as HTMLInputElement | null)?.value ?? '400',
          10,
        );
        const height = Number.parseInt(
          (document.getElementById('crop-h') as HTMLInputElement | null)?.value ?? '300',
          10,
        );
        rect = {
          x: Math.max(0, Number.isFinite(x) ? x : 0),
          y: Math.max(0, Number.isFinite(y) ? y : 0),
          width: Math.max(1, Number.isFinite(width) ? width : 400),
          height: Math.max(1, Number.isFinite(height) ? height : 300),
        };
      }

      const res = await sendBackgroundMessage(
        'RUN_CAPTURE',
        {
          mode,
          exportMime,
          ...(selector ? { selector } : {}),
          ...(rect ? { rect } : {}),
          title: lastTargetPageTitle,
          pageUrl: lastTargetPageUrl,
        },
        { tabId, documentId: docCtx.documentId, requestId },
      );
      if (!res.ok) {
        throw new Error(res.error.message);
      }

      const data = res.data as Record<string, unknown>;
      const dataUrl = typeof data['dataUrl'] === 'string' ? data['dataUrl'] : '';
      const verified = verifyCaptureBinaryAndDimensions(dataUrl);

      const basePngDataUrl =
        verified.mimeType === 'application/pdf'
          ? typeof data['previewPngDataUrl'] === 'string'
            ? data['previewPngDataUrl']
            : ''
          : dataUrl;

      lastCaptureState = {
        basePngDataUrl,
        currentDataUrl: dataUrl,
        mimeType: verified.mimeType,
        width: verified.width,
        height: verified.height,
        mode,
        pageTitle: lastTargetPageTitle,
        pageUrl: lastTargetPageUrl,
        annotations: [],
      };
      updateCapturePreviewUi();

      lastResultTool = 'capture';
      lastResultData = data;
      const built = buildDownloadableForTool('capture', data, makeSlug(lastTargetPageTitle));
      lastDownloadable = built.downloadable;
      lastCopyableText = built.copyableText;
      updateActionButtons();
      outputEl.textContent = summarizeOutputForDisplay('capture', data);
      setStatus(
        `Captured ${verified.width}×${verified.height}px (${verified.mimeType}, ${verified.byteLength.toLocaleString()} bytes).`,
        'success',
      );
      return;
    }

    if (currentTool === 'clone_page') {
      await ensureOptionalOriginPermissionIfNeeded(lastTargetPageUrl);
      const res = await sendBackgroundMessage(
        'RUN_CLONE_PAGE',
        {},
        { tabId, documentId: docCtx.documentId, requestId },
      );
      if (!res.ok) {
        throw new Error(res.error.message);
      }
      const data = res.data as Record<string, unknown>;
      lastResultTool = 'clone_page';
      lastResultData = data;
      const built = buildDownloadableForTool('clone_page', data, makeSlug(lastTargetPageTitle));
      lastDownloadable = built.downloadable;
      lastCopyableText = built.copyableText;
      updateActionButtons();
      outputEl.textContent = summarizeOutputForDisplay('clone_page', data);
      setStatus('Static HTML/CSS snapshot ZIP ready to download.', 'success');
      return;
    }

    if (currentTool === 'assets') {
      await ensureOptionalOriginPermissionIfNeeded(lastTargetPageUrl);
      const res = await sendBackgroundMessage(
        'RUN_ASSETS_EXTRACT',
        { includeZip: true },
        { tabId, documentId: docCtx.documentId, requestId },
      );
      if (!res.ok) {
        throw new Error(res.error.message);
      }
      const data = res.data as Record<string, unknown>;
      lastResultTool = 'assets';
      lastResultData = data;
      const built = buildDownloadableForTool('assets', data, makeSlug(lastTargetPageTitle));
      lastDownloadable = built.downloadable;
      lastCopyableText = built.copyableText;
      updateActionButtons();
      outputEl.textContent = summarizeOutputForDisplay('assets', data);
      const packagedCount =
        typeof data['packagedFilesCount'] === 'number' ? data['packagedFilesCount'] : 0;
      setStatus(`Assets ZIP ready (${packagedCount} bundled files).`, 'success');
      return;
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
    if (
      selector &&
      (currentTool === 'inspect' ||
        currentTool === 'edit_text' ||
        currentTool === 'swap_font' ||
        currentTool === 'arrange')
    ) {
      payload['selector'] = selector;
    }
    if (currentTool === 'measure') {
      if (selector) {
        payload['primarySelector'] = selector;
      }
      if (secondary) {
        payload['secondarySelector'] = secondary;
      }
    }
    if (currentTool === 'edit_text') {
      payload['text'] = secondary ?? 'Edited Preview Text';
    }
    if (currentTool === 'swap_font') {
      payload['fontFamily'] = secondary ?? 'Georgia, serif';
      payload['scope'] = 'element';
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

    const res = await sendContentMessage(tabId, opMap[currentTool], payload, docCtx.documentId);
    if (!res.ok) {
      throw new Error(res.error.message);
    }

    const data = res.data as Record<string, unknown>;
    lastResultTool = currentTool;
    lastResultData = data;
    const built = buildDownloadableForTool(currentTool, data, makeSlug(lastTargetPageTitle));
    lastDownloadable = built.downloadable;
    lastCopyableText = built.copyableText;
    updateActionButtons();
    outputEl.textContent = summarizeOutputForDisplay(currentTool, data);
    setStatus(`Completed ${TOOL_TITLES[currentTool]} locally.`, 'success');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Execution failed';
    setStatus(`Error: ${message}`, 'error');
    outputEl.textContent = JSON.stringify({ error: message }, null, 2);
  } finally {
    setActiveJobState(null);
  }
}

async function applyCaptureTransform(
  cropRect?: CaptureRect,
  addAnnotation?: CaptureAnnotation,
): Promise<void> {
  const outputEl = document.getElementById('tool-output');
  if (!lastCaptureState || !outputEl) {
    return;
  }
  const capFmtSel = document.getElementById('capture-format-select') as HTMLSelectElement | null;
  const exportMime =
    (capFmtSel?.value as CaptureExportMime | undefined) ?? lastCaptureState.mimeType;
  const nextAnnotations = addAnnotation
    ? [...lastCaptureState.annotations, addAnnotation]
    : [...lastCaptureState.annotations];

  try {
    const rendered = await renderEditedCaptureInWorkspace({
      sourceDataUrl: lastCaptureState.basePngDataUrl,
      exportMime,
      ...(cropRect ? { cropRect } : {}),
      annotations: nextAnnotations,
      title: lastCaptureState.pageTitle,
      pageUrl: lastCaptureState.pageUrl,
    });
    const verified = verifyCaptureBinaryAndDimensions(rendered.dataUrl);
    lastCaptureState = {
      ...lastCaptureState,
      basePngDataUrl: cropRect ? rendered.basePngDataUrl : lastCaptureState.basePngDataUrl,
      currentDataUrl: rendered.dataUrl,
      mimeType: verified.mimeType,
      width: verified.width,
      height: verified.height,
      annotations: cropRect ? [] : nextAnnotations,
    };
    const updatedData: Record<string, unknown> = {
      ...(lastResultData ?? {}),
      dataUrl: rendered.dataUrl,
      verified,
      annotationsCount: lastCaptureState.annotations.length,
    };
    lastResultTool = 'capture';
    lastResultData = updatedData;
    const built = buildDownloadableForTool(
      'capture',
      updatedData,
      makeSlug(lastCaptureState.pageTitle),
    );
    lastDownloadable = built.downloadable;
    lastCopyableText = null;
    updateCapturePreviewUi();
    updateActionButtons();
    outputEl.textContent = summarizeOutputForDisplay('capture', updatedData);
    setStatus(
      `Updated capture (${verified.width}×${verified.height}px, ${verified.mimeType}).`,
      'success',
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Capture edit failed';
    setStatus(`Error: ${message}`, 'error');
  }
}

function initWorkspaceUi(): void {
  const dock = document.getElementById('tool-dock');
  const titleEl = document.getElementById('active-tool-title');
  const outputEl = document.getElementById('tool-output');

  window.addEventListener('pagehide', () => {
    for (const url of activeObjectUrls) {
      URL.revokeObjectURL(url);
    }
    activeObjectUrls.clear();
  });

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
    clearNvidiaConfirmation();
    for (const b of Array.from(dock.querySelectorAll('button[data-tool]'))) {
      b.classList.toggle('active', b === btn);
    }
    if (titleEl) {
      titleEl.textContent = TOOL_TITLES[tool];
    }
    updateSubPanelsForTool(tool);
  });

  document.getElementById('run-tool-btn')?.addEventListener('click', () => {
    void executeSelectedTool();
  });

  document.getElementById('cancel-job-btn')?.addEventListener('click', () => {
    void (async () => {
      if (!activeJobRequestId) {
        return;
      }
      const { tabId } = await resolveTargetTabId();
      await sendBackgroundMessage('CANCEL_JOB', { jobId: activeJobRequestId }, { tabId });
      setStatus('Cancellation requested for active job.');
    })();
  });

  document.getElementById('open-tab-workspace-btn')?.addEventListener('click', () => {
    void (async () => {
      const chromeApi = getChromeApi();
      const { tabId, url } = await resolveTargetTabId();
      const base = chromeApi.runtime?.getURL
        ? chromeApi.runtime.getURL('workspace.html')
        : 'workspace.html';
      const target =
        tabId !== null ? `${base}?tabId=${tabId}&targetUrl=${encodeURIComponent(url)}` : base;
      if (chromeApi.tabs?.create) {
        await chromeApi.tabs.create({ url: target });
      } else {
        window.open(target, '_blank', 'noopener');
      }
    })();
  });

  document.getElementById('download-result-btn')?.addEventListener('click', () => {
    if (!lastDownloadable) {
      setStatus('No file available to download yet.', 'error');
      return;
    }
    try {
      triggerFileDownload(lastDownloadable);
      setStatus(`Download started: ${lastDownloadable.filename}`, 'success');
    } catch (err: unknown) {
      setStatus(
        `Download failed: ${err instanceof Error ? err.message : 'Unknown download error'}`,
        'error',
      );
    }
  });

  document.getElementById('copy-result-btn')?.addEventListener('click', () => {
    void (async () => {
      if (!lastCopyableText) {
        setStatus('No text output available to copy.', 'error');
        return;
      }
      try {
        await navigator.clipboard.writeText(lastCopyableText);
        setStatus('Copied output text to clipboard.', 'success');
      } catch (err: unknown) {
        setStatus(
          `Clipboard copy failed: ${err instanceof Error ? err.message : 'Permission denied'}`,
          'error',
        );
      }
    })();
  });

  document.getElementById('colors-export-format')?.addEventListener('change', () => {
    if (lastResultTool === 'colors' && lastResultData) {
      const built = buildDownloadableForTool(
        'colors',
        lastResultData,
        makeSlug(lastTargetPageTitle),
      );
      lastDownloadable = built.downloadable;
      lastCopyableText = built.copyableText;
      updateActionButtons();
    }
  });

  document.getElementById('apply-crop-btn')?.addEventListener('click', () => {
    const x = Number.parseInt(
      (document.getElementById('crop-x') as HTMLInputElement | null)?.value ?? '0',
      10,
    );
    const y = Number.parseInt(
      (document.getElementById('crop-y') as HTMLInputElement | null)?.value ?? '0',
      10,
    );
    const width = Number.parseInt(
      (document.getElementById('crop-w') as HTMLInputElement | null)?.value ?? '200',
      10,
    );
    const height = Number.parseInt(
      (document.getElementById('crop-h') as HTMLInputElement | null)?.value ?? '200',
      10,
    );
    void applyCaptureTransform({
      x: Math.max(0, Number.isFinite(x) ? x : 0),
      y: Math.max(0, Number.isFinite(y) ? y : 0),
      width: Math.max(1, Number.isFinite(width) ? width : 200),
      height: Math.max(1, Number.isFinite(height) ? height : 200),
    });
  });

  document.getElementById('add-annotation-btn')?.addEventListener('click', () => {
    const x = Number.parseInt(
      (document.getElementById('ann-x') as HTMLInputElement | null)?.value ?? '16',
      10,
    );
    const y = Number.parseInt(
      (document.getElementById('ann-y') as HTMLInputElement | null)?.value ?? '16',
      10,
    );
    const width = Number.parseInt(
      (document.getElementById('ann-w') as HTMLInputElement | null)?.value ?? '120',
      10,
    );
    const height = Number.parseInt(
      (document.getElementById('ann-h') as HTMLInputElement | null)?.value ?? '48',
      10,
    );
    const label =
      (document.getElementById('ann-label') as HTMLInputElement | null)?.value.trim() || 'Note';
    const color =
      (document.getElementById('ann-color') as HTMLInputElement | null)?.value || '#ef4444';
    void applyCaptureTransform(undefined, {
      x: Math.max(0, Number.isFinite(x) ? x : 16),
      y: Math.max(0, Number.isFinite(y) ? y : 16),
      width: Math.max(2, Number.isFinite(width) ? width : 120),
      height: Math.max(2, Number.isFinite(height) ? height : 48),
      label,
      color,
    });
  });

  document.getElementById('open-responsive-btn')?.addEventListener('click', () => {
    void runResponsiveOpenAction();
  });

  document.getElementById('responsive-sync-toggle')?.addEventListener('change', (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    void (async () => {
      const res = await sendBackgroundMessage('SET_RESPONSIVE_SYNC', { enabled });
      if (res.ok) {
        const d = res.data as { session?: unknown };
        renderResponsiveSessionStatus(d.session);
        setStatus(`Responsive scroll sync ${enabled ? 'enabled' : 'disabled'}.`, 'success');
      }
    })();
  });

  document.getElementById('close-responsive-btn')?.addEventListener('click', () => {
    void (async () => {
      const res = await sendBackgroundMessage('CLOSE_RESPONSIVE_SESSION');
      if (res.ok) {
        const d = res.data as { closedWindowIds: number[] };
        renderResponsiveSessionStatus(null);
        setStatus(
          `Closed ${d.closedWindowIds.length} extension-managed responsive preview window(s).`,
          'success',
        );
      }
    })();
  });

  document.getElementById('toggle-picker-btn')?.addEventListener('click', () => {
    void (async () => {
      const { tabId } = await resolveTargetTabId();
      if (tabId === null) {
        return;
      }
      const docCtx = await getBoundDocumentContext(tabId);
      pickerActive = !pickerActive;
      const res = await sendContentMessage(
        tabId,
        pickerActive ? 'ACTIVATE_TOOL' : 'DEACTIVATE_TOOLS',
        pickerActive ? { tool: currentTool } : {},
        docCtx.documentId,
      );
      if (res.ok) {
        setStatus(
          pickerActive
            ? `On-page picker active for ${currentTool} (press Escape on page to cancel).`
            : 'On-page picker deactivated.',
        );
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
        const docCtx = await getBoundDocumentContext(tabId);
        const res = await sendContentMessage(tabId, op, {}, docCtx.documentId);
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
        setStatus(`Created project "${name}" in IndexedDB.`, 'success');
      }
    })();
  });

  document.getElementById('save-artifact-btn')?.addEventListener('click', () => {
    void (async () => {
      const select = document.getElementById('project-select') as HTMLSelectElement | null;
      const projectId = select?.value || 'proj-default';
      if (lastResultTool === 'capture' && lastCaptureState) {
        const res = await sendBackgroundMessage('SAVE_CAPTURE_TO_IDB', {
          projectId,
          pageUrl: lastCaptureState.pageUrl,
          pageTitle: lastCaptureState.pageTitle,
          mode: lastCaptureState.mode,
          dataUrl: lastCaptureState.currentDataUrl,
          annotations: lastCaptureState.annotations,
        });
        setStatus(
          res.ok
            ? 'Saved screenshot capture to local IndexedDB.'
            : `Save error: ${res.error.message}`,
          res.ok ? 'success' : 'error',
        );
        return;
      }

      const payloadToSave = { ...(lastResultData ?? { savedAt: new Date().toISOString() }) };
      delete payloadToSave['zipBase64'];
      const toolKey = lastResultTool ?? currentTool;
      const res = await sendBackgroundMessage('SAVE_ARTIFACT_TO_IDB', {
        projectId,
        kind: TOOL_TO_ARTIFACT_KIND[toolKey],
        title: `${TOOL_TITLES[toolKey]} Output`,
        sourceUrl: lastTargetPageUrl,
        artifactPayload: payloadToSave,
      });
      setStatus(
        res.ok ? 'Saved tool result to local IndexedDB.' : `Save error: ${res.error.message}`,
        res.ok ? 'success' : 'error',
      );
    })();
  });

  const supportedNvidiaSourceTools = new Set([
    'clone_prompt',
    'design_review',
    'design_md',
    'colors',
    'fonts',
    'inspect',
  ]);

  document.getElementById('preview-nvidia-btn')?.addEventListener('click', () => {
    void (async () => {
      const sourceTool =
        lastResultTool && supportedNvidiaSourceTools.has(lastResultTool)
          ? lastResultTool
          : 'clone_prompt';
      const taskType =
        currentTool === 'design_review' || sourceTool === 'design_review'
          ? 'interpret_design_review'
          : 'enhance_clone_prompt';
      const res = await sendBackgroundMessage('RUN_NVIDIA_ENHANCEMENT', {
        previewOnly: true,
        taskType,
        sourceTool,
        toolOutput: lastResultData ?? { pageTitle: lastTargetPageTitle },
      });
      if (res.ok) {
        const data = res.data as { payloadDigest: string };
        confirmedNvidiaDigest = data.payloadDigest;
        confirmedNvidiaTaskType = taskType;
        const runBtn = document.getElementById('run-nvidia-btn') as HTMLButtonElement | null;
        if (runBtn) {
          runBtn.disabled = false;
        }
        setStatus(
          'Reviewed exact NVIDIA data egress payload. Click Confirm & Enhance to transmit.',
          'success',
        );
      } else {
        clearNvidiaConfirmation();
        setStatus(`NVIDIA preview error: ${res.error.message}`, 'error');
      }
      if (outputEl) {
        outputEl.textContent = JSON.stringify(res, null, 2);
      }
    })();
  });

  document.getElementById('run-nvidia-btn')?.addEventListener('click', () => {
    void (async () => {
      if (!confirmedNvidiaDigest || !confirmedNvidiaTaskType) {
        setStatus('Preview NVIDIA data egress first before transmitting.', 'error');
        return;
      }
      const sourceTool =
        lastResultTool && supportedNvidiaSourceTools.has(lastResultTool)
          ? lastResultTool
          : 'clone_prompt';
      const res = await sendBackgroundMessage('RUN_NVIDIA_ENHANCEMENT', {
        previewOnly: false,
        taskType: confirmedNvidiaTaskType,
        sourceTool,
        toolOutput: lastResultData ?? { pageTitle: lastTargetPageTitle },
        confirmedPayloadDigest: confirmedNvidiaDigest,
      });
      if (outputEl) {
        outputEl.textContent = JSON.stringify(res, null, 2);
      }
      setStatus(
        res.ok ? 'Optional NVIDIA AI enhancement completed.' : `NVIDIA error: ${res.error.message}`,
        res.ok ? 'success' : 'error',
      );
    })();
  });

  updateSubPanelsForTool(currentTool);
  updateActionButtons();
  void refreshProjectsDropdown();
  void sendBackgroundMessage('GET_RESPONSIVE_SESSION').then((res) => {
    if (res.ok) {
      const d = res.data as { session?: unknown };
      renderResponsiveSessionStatus(d.session);
    }
  });
}

if (typeof document !== 'undefined') {
  initWorkspaceUi();
}

export { encodeBytesToBase64 };
