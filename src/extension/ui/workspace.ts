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
import {
  groupDateLabelForLocalDisplay,
  sanitizeActivitySourceUrl,
  type ActivityQueryItem,
  type ActivityQueryResult,
} from '../storage/activity-history.js';
import type { LocalArtifactKind } from '../storage/idb-storage.js';
import {
  applyThemePreference,
  bindGlobalTapFeedback,
  createSvgIcon,
  formatThemeLabel,
  nextThemePreference,
  readCachedTheme,
  type ThemePreference,
} from './theme.js';
import { renderStructuredToolResult } from './tool-renderers.js';

interface ChromeWorkspaceApis {
  runtime?: {
    getURL?: (path: string) => string;
    sendMessage: (msg: RuntimeMessageEnvelope) => Promise<ExtensionMessageResponse>;
  };
  tabs?: {
    query: (q: {
      active: boolean;
      currentWindow: boolean;
    }) => Promise<Array<{ id?: number; url?: string; title?: string }>>;
    create?: (props: { url: string }) => Promise<unknown>;
    sendMessage: (tabId: number, msg: RuntimeMessageEnvelope) => Promise<ExtensionMessageResponse>;
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

type DashboardSection = 'tools' | 'history' | 'saved';

const TOOL_TITLES: Record<ToolId, string> = {
  inspect: '1. Inspect Element & Computed Styles',
  clone_page: '2. Clone Page (Static HTML/CSS Snapshot ZIP)',
  clone_prompt: '3. Clone Prompt Generator (Observations vs. Assumptions)',
  design_md: '4. DESIGN.md Generator',
  assets: '5. Assets Extractor (Images, SVGs, Fonts & ZIP)',
  colors: '6. Color Palette & Design Tokens',
  fonts: '7. Typography & @font-face Inspector',
  measure: '8. Box & Element Gap Measurement',
  edit_text: '9. Reversible In-Place Text Editor',
  capture: '10. Screenshot Capture (PNG / JPEG / WebP / PDF)',
  responsive: '11. Responsive Multi-Viewport Inspector',
  swap_font: '12. Reversible Font Swap Preview',
  arrange: '13. Reversible Element Arrange',
  design_review: '14. Evidence-Based Design & Contrast Review',
  tech_stack: '15. Public Tech Stack Detector',
};

const TOOL_SHORT_LABELS: Record<ToolId, string> = {
  inspect: 'Inspect',
  clone_page: 'Clone Page',
  clone_prompt: 'Clone Prompt',
  design_md: 'Design MD',
  assets: 'Assets',
  colors: 'Colors',
  fonts: 'Fonts',
  measure: 'Measure',
  edit_text: 'Edit Text',
  capture: 'Capture',
  responsive: 'Responsive',
  swap_font: 'Swap Font',
  arrange: 'Arrange',
  design_review: 'Design Review',
  tech_stack: 'Tech Stack',
};

const TOOL_SUBTITLES: Record<ToolId, string> = {
  inspect: 'Examine dimensions, box model, computed styles, and accessibility attributes locally.',
  clone_page: 'Export a DOMPurify-sanitized static HTML/CSS snapshot with bundled local assets.',
  clone_prompt:
    'Build a structured local implementation brief distinguishing facts from assumptions.',
  design_md: 'Extract deduplicated colors, typography, spacing, and components into DESIGN.md.',
  assets:
    'Discover page images, SVGs, backgrounds, and fonts, then download individually or as ZIP.',
  colors: 'Inspect rendered swatches, custom properties, and export CSS, Tailwind, SCSS, or JSON.',
  fonts: 'Inspect declared stacks, size/weight hierarchy, @font-face rules, and loaded status.',
  measure: 'Measure element bounding boxes and horizontal/vertical gaps between two selectors.',
  edit_text: 'Preview copy changes locally in the active tab with full undo, redo, and reset.',
  capture:
    'Capture real visible, element, cropped area, or stitched full-page screenshots and PDFs.',
  responsive:
    'Open extension-managed viewport windows, measure actual inner size, and sync scroll.',
  swap_font: 'Preview alternative font families on a selected element without modifying the site.',
  arrange: 'Move, hide, or temporarily remove elements locally to test layout changes.',
  design_review: 'Audit typographic hierarchy, spacing scale, and WCAG contrast with evidence.',
  tech_stack:
    'Detect public frontend frameworks, CSS libraries, and platforms with confidence notes.',
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

const ARTIFACT_KIND_TO_TOOL: Record<string, ToolId> = {
  inspect_report: 'inspect',
  clone_snapshot: 'clone_page',
  clone_prompt: 'clone_prompt',
  design_md: 'design_md',
  asset_manifest: 'assets',
  color_palette: 'colors',
  font_report: 'fonts',
  capture_image: 'capture',
  design_review: 'design_review',
  tech_stack: 'tech_stack',
};

const TOOLS_WITH_SELECTOR = new Set<ToolId>([
  'inspect',
  'measure',
  'edit_text',
  'swap_font',
  'arrange',
  'capture',
]);
const TOOLS_WITH_SECONDARY = new Set<ToolId>(['measure', 'edit_text', 'swap_font']);
const TOOLS_WITH_MODE = new Set<ToolId>(['clone_prompt', 'arrange']);
const TOOLS_WITH_EDIT_HISTORY = new Set<ToolId>(['edit_text', 'swap_font', 'arrange']);
const TOOLS_WITH_AI_ENHANCE = new Set<ToolId>([
  'clone_prompt',
  'design_md',
  'design_review',
  'tech_stack',
]);

const HISTORY_PAGE_SIZE = 25;

let activeSection: DashboardSection = 'tools';
let currentTool: ToolId = 'inspect';
let lastResultTool: ToolId | null = null;
let lastResultData: Record<string, unknown> | null = null;
let lastActivityIdForResult: string | null = null;
let lastActivityMeta: {
  tool: ToolId;
  actionLabel: string;
  optionsSummary: Record<string, unknown>;
  resultSummary: string;
  durationMs: number | null;
} | null = null;
let lastTargetPageUrl = '';
let lastTargetPageTitle = 'pagesift';
let lastDownloadable: DownloadableArtifact | null = null;
let lastCopyableText: string | null = null;
let lastCaptureState: CaptureWorkState | null = null;
let confirmedNvidiaDigest: string | null = null;
let confirmedNvidiaTaskType:
  | 'enhance_clone_prompt'
  | 'interpret_design_review'
  | 'explain_tech_stack'
  | null = null;
let activeJobRequestId: string | null = null;
let pickerActive = false;
let currentThemePref: ThemePreference = readCachedTheme();
let sidebarCollapsed = false;
let lastFocusedBeforeModal: HTMLElement | null = null;
let historyItemsLoaded: ActivityQueryItem[] = [];
let historyTotalMatching = 0;
let historyHasMore = false;
let historyOffset = 0;
let historySearchTimer: ReturnType<typeof setTimeout> | null = null;
const activeObjectUrls = new Set<string>();

function getChromeApi(): ChromeWorkspaceApis {
  return (globalThis as unknown as { chrome?: ChromeWorkspaceApis }).chrome ?? {};
}

function makeSlug(rawTitle: string): string {
  const cleaned = rawTitle
    .normalize('NFC')
    .replace(/[/\\?%*:|"<>#\u2013\u2014]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return cleaned || 'pagesift';
}

function formatDurationMs(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs)) {
    return 'n/a';
  }
  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`;
  }
  return `${(durationMs / 1000).toFixed(2)} s`;
}

function formatLocalTime(utcIso: string): string {
  const date = new Date(utcIso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function summarizeToolResultShort(tool: ToolId, data: Record<string, unknown>): string {
  if (tool === 'inspect') {
    const rep = data['report'] as { tagName?: string; selector?: string } | undefined;
    if (rep?.selector) {
      return `Inspected ${rep.tagName ?? 'element'} (${rep.selector})`;
    }
  }
  if (tool === 'colors') {
    const rep = data['report'] as
      | { colors?: unknown[]; customProperties?: unknown[]; gradients?: unknown[] }
      | undefined;
    return `Extracted ${rep?.colors?.length ?? 0} colors and ${rep?.customProperties?.length ?? 0} CSS variables`;
  }
  if (tool === 'fonts') {
    const rep = data['report'] as
      | { families?: unknown[]; fontFaceDeclarations?: unknown[] }
      | undefined;
    return `Inspected ${rep?.families?.length ?? 0} font families and ${rep?.fontFaceDeclarations?.length ?? 0} @font-face rules`;
  }
  if (tool === 'measure') {
    const rep = data['report'] as
      | { primary?: { selector?: string }; distance?: unknown }
      | undefined;
    return rep?.distance
      ? `Measured spacing from ${rep.primary?.selector ?? 'element'}`
      : `Measured ${rep?.primary?.selector ?? 'element'} geometry`;
  }
  if (tool === 'design_md') {
    const res = data['result'] as { markdown?: string } | undefined;
    return `Generated DESIGN.md (${(res?.markdown?.length ?? 0).toLocaleString()} chars)`;
  }
  if (tool === 'clone_prompt') {
    const rep = data['report'] as { prompt?: string; targetFramework?: string } | undefined;
    return `Built ${rep?.targetFramework ?? 'default'} clone prompt (${(rep?.prompt?.length ?? 0).toLocaleString()} chars)`;
  }
  if (tool === 'design_review') {
    const rep = data['report'] as { findings?: unknown[] } | undefined;
    return `Completed audit with ${rep?.findings?.length ?? 0} findings`;
  }
  if (tool === 'tech_stack') {
    const rep = data['report'] as { detections?: unknown[] } | undefined;
    return `Detected ${rep?.detections?.length ?? 0} technology signals`;
  }
  if (tool === 'edit_text' || tool === 'swap_font' || tool === 'arrange') {
    return `Applied reversible ${TOOL_SHORT_LABELS[tool].toLowerCase()} preview`;
  }
  return `Completed ${TOOL_SHORT_LABELS[tool]} locally`;
}

function setStatus(
  message: string,
  variant: 'neutral' | 'error' | 'success' | 'warning' = 'neutral',
): void {
  const statusEl = document.getElementById('status-message');
  if (!statusEl) {
    return;
  }
  statusEl.textContent = message;
  statusEl.className = variant === 'neutral' ? 'status-line' : `status-line ${variant}`;
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
  const progressTrack = document.getElementById('job-progress-track');
  if (cancelBtn) {
    cancelBtn.disabled = requestId === null;
  }
  if (runBtn) {
    runBtn.disabled = requestId !== null;
  }
  progressTrack?.classList.toggle('active', requestId !== null);
}

function applySidebarCollapsedUi(): void {
  const body = document.getElementById('workspace-body');
  const toggleBtn = document.getElementById('toggle-sidebar-btn');
  body?.classList.toggle('rail-collapsed', sidebarCollapsed);
  toggleBtn?.setAttribute('aria-expanded', sidebarCollapsed ? 'false' : 'true');
  toggleBtn?.setAttribute(
    'title',
    sidebarCollapsed ? 'Expand navigation sidebar' : 'Collapse navigation sidebar',
  );
}

function switchSection(section: DashboardSection): void {
  activeSection = section;
  const panels: Array<[DashboardSection, string]> = [
    ['tools', 'view-tools'],
    ['history', 'view-history'],
    ['saved', 'view-saved'],
  ];
  for (const [key, id] of panels) {
    document.getElementById(id)?.classList.toggle('active', key === section);
  }
  document.querySelectorAll<HTMLButtonElement>('.rail-section-btn').forEach((btn) => {
    const isSelected = btn.getAttribute('data-section') === section;
    btn.classList.toggle('active', isSelected);
    btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
  });
  if (section === 'history') {
    void loadActivityHistory(true);
  } else if (section === 'saved') {
    void refreshProjectsDropdown();
  }
  closeMobileRail();
}

function updateSubPanelsForTool(tool: ToolId): void {
  const selectorRow = document.getElementById('selector-controls-row');
  const selectorInput = document.getElementById('target-selector-input') as HTMLInputElement | null;
  const secondaryInput = document.getElementById('secondary-input') as HTMLInputElement | null;
  const modeSelect = document.getElementById('mode-select') as HTMLSelectElement | null;

  const showSelector = TOOLS_WITH_SELECTOR.has(tool);
  const showSecondary = TOOLS_WITH_SECONDARY.has(tool);
  const showMode = TOOLS_WITH_MODE.has(tool);

  if (selectorInput) {
    selectorInput.style.display = showSelector ? '' : 'none';
    selectorInput.placeholder =
      tool === 'capture'
        ? 'Element selector for Element capture (e.g. #green-box)'
        : tool === 'measure'
          ? 'Primary CSS selector (e.g. #hero)'
          : 'Target CSS selector (optional, e.g. h1, #hero, .card)';
  }
  if (secondaryInput) {
    secondaryInput.style.display = showSecondary ? '' : 'none';
    secondaryInput.placeholder =
      tool === 'measure'
        ? 'Secondary CSS selector (for distance measurement)'
        : tool === 'edit_text'
          ? 'Replacement text (reversible local preview)'
          : 'Font family (e.g. Georgia, serif)';
  }
  if (modeSelect) {
    modeSelect.style.display = showMode ? '' : 'none';
    Array.from(modeSelect.options).forEach((opt) => {
      const val = opt.value;
      if (tool === 'clone_prompt') {
        opt.hidden = !['default', 'react_tailwind', 'html_css', 'vue_css', 'generic'].includes(val);
      } else if (tool === 'arrange') {
        opt.hidden = !['default', 'move', 'hide', 'remove'].includes(val);
      } else {
        opt.hidden = false;
      }
    });
  }
  const hasSelectorRow = showSelector || showSecondary || showMode;
  if (selectorRow) {
    selectorRow.style.display = hasSelectorRow ? 'flex' : 'none';
  }

  const showCapture = tool === 'capture';
  const showResponsive = tool === 'responsive';
  const showColors = tool === 'colors';
  const showEditHistory = TOOLS_WITH_EDIT_HISTORY.has(tool);
  const showAi = TOOLS_WITH_AI_ENHANCE.has(tool);

  const subPairs: Array<[string, boolean]> = [
    ['capture-controls', showCapture],
    ['responsive-controls', showResponsive],
    ['colors-controls', showColors],
    ['edit-history-controls', showEditHistory],
    ['ai-controls', showAi],
  ];
  for (const [id, visible] of subPairs) {
    const node = document.getElementById(id);
    node?.classList.toggle('visible', visible);
    node?.classList.toggle('with-divider', visible && hasSelectorRow);
  }

  const paramsCard = document.getElementById('tool-params-card');
  if (paramsCard) {
    const anyParamVisible =
      hasSelectorRow || showCapture || showResponsive || showColors || showEditHistory || showAi;
    paramsCard.style.display = anyParamVisible ? '' : 'none';
  }

  const pickerBtn = document.getElementById('toggle-picker-btn');
  if (pickerBtn) {
    pickerBtn.style.display = showSelector ? '' : 'none';
  }

  const titleEl = document.getElementById('active-tool-title');
  const subtitleEl = document.getElementById('active-tool-subtitle');
  if (titleEl) {
    titleEl.textContent = TOOL_TITLES[tool];
  }
  if (subtitleEl) {
    subtitleEl.textContent = TOOL_SUBTITLES[tool];
  }
}

function updateActionButtons(): void {
  const dlBtn = document.getElementById('download-result-btn') as HTMLButtonElement | null;
  const copyBtn = document.getElementById('copy-result-btn') as HTMLButtonElement | null;
  const metaEl = document.getElementById('download-meta');
  if (dlBtn) {
    dlBtn.disabled = lastDownloadable === null;
    if (lastDownloadable) {
      const dotIdx = lastDownloadable.filename.lastIndexOf('.');
      const extLabel =
        dotIdx !== -1 ? lastDownloadable.filename.slice(dotIdx).toUpperCase() : 'FILE';
      dlBtn.textContent = `Download ${extLabel}`;
      dlBtn.title = lastDownloadable.filename;
    } else {
      dlBtn.textContent = 'Download File';
      dlBtn.title = '';
    }
    dlBtn.prepend(createSvgIcon('download'));
  }
  if (copyBtn) {
    copyBtn.disabled = lastCopyableText === null;
    copyBtn.textContent = 'Copy Output';
    copyBtn.prepend(createSvgIcon('copy'));
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
    if (cropBtn) cropBtn.disabled = true;
    if (annBtn) annBtn.disabled = true;
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
    meta.textContent = `Captured ${lastCaptureState.width}×${lastCaptureState.height}px (${lastCaptureState.mimeType}) · Callouts: ${lastCaptureState.annotations.length}`;
  }
  if (cropBtn) cropBtn.disabled = false;
  if (annBtn) annBtn.disabled = false;
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

async function copyTextWithFeedback(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`Copied ${label} to clipboard.`, 'success');
  } catch (err: unknown) {
    setStatus(
      `Clipboard copy failed: ${err instanceof Error ? err.message : 'Permission denied'}`,
      'error',
    );
  }
}

function renderCurrentStructuredOutput(tool: ToolId, data: Record<string, unknown>): void {
  const container = document.getElementById('structured-result-container');
  if (!container) {
    return;
  }
  container.textContent = '';
  const view = renderStructuredToolResult(tool, data, {
    onCopyText: (text, label) => {
      void copyTextWithFeedback(text, label);
    },
    onDownloadSingleAsset: (filename, mimeType, bytes) => {
      triggerFileDownload({ filename, mimeType, bytes });
      setStatus(`Download started: ${filename}`, 'success');
    },
    getSelectedColorFormat: () => {
      const sel = document.getElementById('colors-export-format') as HTMLSelectElement | null;
      return sel?.value ?? 'cssVariables';
    },
  });
  container.appendChild(view);
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
    const exportKeyMap: Record<string, { key: string; ext: string; mime: string }> = {
      cssVariables: { key: 'cssVariables', ext: 'css', mime: 'text/css;charset=utf-8' },
      tailwindV4: { key: 'tailwindV4Theme', ext: 'css', mime: 'text/css;charset=utf-8' },
      tailwindV3: { key: 'tailwindV3Config', ext: 'js', mime: 'text/javascript;charset=utf-8' },
      scss: { key: 'scss', ext: 'scss', mime: 'text/plain;charset=utf-8' },
      json: { key: 'json', ext: 'json', mime: 'application/json;charset=utf-8' },
    };
    const meta = exportKeyMap[selected] ?? {
      key: 'cssVariables',
      ext: 'css',
      mime: 'text/css;charset=utf-8',
    };
    const text = rep?.exports?.[meta.key] ?? JSON.stringify(data, null, 2);
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
    const rep = data['report'] as { localFixPrompt?: string } | undefined;
    const md =
      typeof rep?.localFixPrompt === 'string' ? rep.localFixPrompt : JSON.stringify(data, null, 2);
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
  return { tabId: null, url: '' };
}

async function updateTargetPageIdentity(): Promise<void> {
  const labelEl = document.getElementById('target-page-label');
  const dotEl = document.getElementById('target-status-dot');
  const { tabId, url } = await resolveTargetTabId();
  if (!labelEl) {
    return;
  }
  if (tabId === null) {
    labelEl.textContent = 'No bound web tab (click toolbar icon on any web page)';
    if (dotEl) {
      dotEl.className = 'status-dot warning';
    }
    return;
  }
  if (dotEl) {
    dotEl.className = 'status-dot positive';
  }
  try {
    const parsed = new URL(url);
    lastTargetPageUrl = url;
    labelEl.textContent = `${parsed.host}${parsed.pathname}`;
  } catch {
    labelEl.textContent = url || `Tab #${tabId}`;
  }
  try {
    const ctx = await getBoundDocumentContext(tabId);
    lastTargetPageUrl = ctx.pageUrl || url;
    lastTargetPageTitle = ctx.pageTitle || 'pagesift';
    const host = new URL(lastTargetPageUrl).host;
    labelEl.textContent = `${ctx.pageTitle || host} · ${host}`;
  } catch {
    return;
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

async function openSavedArtifactById(artifactId: string): Promise<void> {
  const res = await sendBackgroundMessage('GET_ARTIFACT_FROM_IDB', { artifactId });
  if (!res.ok) {
    setStatus(`Unable to open saved artifact: ${res.error.message}`, 'error');
    return;
  }
  const artifact = (
    res.data as {
      artifact: {
        id: string;
        kind: string;
        title: string;
        sourceUrl: string | null;
        payload: Record<string, unknown>;
      } | null;
    }
  ).artifact;
  if (!artifact) {
    setStatus('This saved artifact was removed from local storage.', 'warning');
    if (activeSection === 'history') {
      void loadActivityHistory(true);
    }
    return;
  }
  const tool = ARTIFACT_KIND_TO_TOOL[artifact.kind] ?? 'inspect';
  switchSection('tools');
  selectActiveTool(tool);
  lastResultTool = tool;
  lastResultData = artifact.payload;
  lastTargetPageUrl = artifact.sourceUrl ?? lastTargetPageUrl;
  lastTargetPageTitle = artifact.title;
  const built = buildDownloadableForTool(tool, artifact.payload, makeSlug(artifact.title));
  lastDownloadable = built.downloadable;
  lastCopyableText = built.copyableText;
  updateActionButtons();
  renderCurrentStructuredOutput(tool, artifact.payload);
  const outputEl = document.getElementById('tool-output');
  if (outputEl) {
    outputEl.textContent = summarizeOutputForDisplay(tool, artifact.payload);
  }
  setStatus(`Loaded saved artifact: ${artifact.title}`, 'success');
}

function openExternalUrlInNewTab(url: string): void {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    setStatus('Cannot reopen restricted or non-HTTP URL.', 'warning');
    return;
  }
  const chromeApi = getChromeApi();
  if (chromeApi.tabs?.create) {
    void chromeApi.tabs.create({ url });
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

function buildDateRangeFilterBounds(rangeValue: string): {
  fromIso?: string;
  toIso?: string;
} {
  const now = new Date();
  if (rangeValue === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { fromIso: start.toISOString() };
  }
  if (rangeValue === '7d') {
    return { fromIso: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString() };
  }
  if (rangeValue === '30d') {
    return { fromIso: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString() };
  }
  return {};
}

function updateHistoryDomainOptions(domains: string[]): void {
  const domainSel = document.getElementById('history-domain-filter') as HTMLSelectElement | null;
  if (!domainSel) {
    return;
  }
  const prev = domainSel.value;
  domainSel.textContent = '';
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = 'All websites';
  domainSel.appendChild(allOpt);
  for (const domain of domains) {
    const opt = document.createElement('option');
    opt.value = domain;
    opt.textContent = domain;
    domainSel.appendChild(opt);
  }
  if (prev && domains.includes(prev)) {
    domainSel.value = prev;
  }
}

function createActivityRowElement(item: ActivityQueryItem): HTMLElement {
  const row = document.createElement('div');
  row.className = 'timeline-row';
  row.setAttribute('data-activity-id', item.id);

  const main = document.createElement('div');
  main.className = 'timeline-main';

  const titleLine = document.createElement('div');
  titleLine.className = 'timeline-title-line';

  const statusDot = document.createElement('span');
  statusDot.className =
    item.status === 'completed'
      ? 'status-dot positive'
      : item.status === 'failed'
        ? 'status-dot danger'
        : item.status === 'running'
          ? 'status-dot accent'
          : 'status-dot warning';
  statusDot.setAttribute('aria-hidden', 'true');

  const toolTag = document.createElement('span');
  toolTag.className = 'tag accent';
  toolTag.textContent = TOOL_SHORT_LABELS[item.tool];

  const title = document.createElement('strong');
  title.textContent = item.pageTitle || item.sourceDomain || 'Local page';

  const statusTag = document.createElement('span');
  statusTag.className =
    item.status === 'completed'
      ? 'tag positive'
      : item.status === 'failed'
        ? 'tag danger'
        : item.status === 'interrupted' || item.status === 'cancelled'
          ? 'tag warning'
          : 'tag';
  statusTag.textContent = item.status;

  titleLine.append(statusDot, toolTag, title, statusTag);

  const summary = document.createElement('div');
  summary.textContent = item.resultSummary || item.actionLabel;

  const meta = document.createElement('div');
  meta.className = 'timeline-meta';

  const urlSpan = document.createElement('span');
  urlSpan.className = 'mono truncate';
  urlSpan.style.maxWidth = '380px';
  urlSpan.textContent = item.sourceUrl;
  urlSpan.title = item.sourceUrl;

  const timeSpan = document.createElement('span');
  timeSpan.className = 'mono';
  timeSpan.textContent = `${formatLocalTime(item.startedAt)} · Action duration: ${formatDurationMs(item.durationMs)}`;

  meta.append(urlSpan, timeSpan);

  const optionEntries = Object.entries(item.optionsSummary);
  if (optionEntries.length > 0) {
    const optsSpan = document.createElement('span');
    optsSpan.className = 'mono';
    optsSpan.textContent = optionEntries.map(([k, v]) => `${k}=${String(v)}`).join(', ');
    meta.appendChild(optsSpan);
  }

  if (item.errorCategory) {
    const errTag = document.createElement('span');
    errTag.className = 'tag danger';
    errTag.textContent = item.errorCategory;
    meta.appendChild(errTag);
  }

  if (item.linkedResourceStatus === 'removed') {
    const removedTag = document.createElement('span');
    removedTag.className = 'tag warning';
    removedTag.textContent = 'Saved result removed';
    meta.appendChild(removedTag);
  }

  main.append(titleLine, summary, meta);

  const actions = document.createElement('div');
  actions.className = 'timeline-actions';

  if (item.linkedArtifactId && item.linkedResourceStatus === 'present') {
    const openResBtn = document.createElement('button');
    openResBtn.type = 'button';
    openResBtn.className = 'secondary sm';
    openResBtn.textContent = 'Open Result';
    openResBtn.addEventListener('click', () => {
      void openSavedArtifactById(item.linkedArtifactId as string);
    });
    actions.appendChild(openResBtn);
  } else if (item.linkedCaptureId && item.linkedResourceStatus === 'present') {
    const openSavedBtn = document.createElement('button');
    openSavedBtn.type = 'button';
    openSavedBtn.className = 'secondary sm';
    openSavedBtn.textContent = 'View Capture';
    openSavedBtn.addEventListener('click', () => {
      switchSection('saved');
    });
    actions.appendChild(openSavedBtn);
  }

  if (item.sourceUrl.startsWith('http://') || item.sourceUrl.startsWith('https://')) {
    const reopenBtn = document.createElement('button');
    reopenBtn.type = 'button';
    reopenBtn.className = 'ghost sm';
    reopenBtn.textContent = 'Reopen Site';
    reopenBtn.addEventListener('click', () => {
      openExternalUrlInNewTab(item.sourceUrl);
    });
    actions.appendChild(reopenBtn);
  }

  const rerunBtn = document.createElement('button');
  rerunBtn.type = 'button';
  rerunBtn.className = 'secondary sm';
  rerunBtn.textContent = 'Review & rerun';
  rerunBtn.addEventListener('click', () => {
    switchSection('tools');
    selectActiveTool(item.tool);
    const selInput = document.getElementById('target-selector-input') as HTMLInputElement | null;
    if (selInput && typeof item.optionsSummary['selector'] === 'string') {
      selInput.value = item.optionsSummary['selector'];
    }
    const modeSel = document.getElementById('mode-select') as HTMLSelectElement | null;
    if (modeSel && typeof item.optionsSummary['targetFramework'] === 'string') {
      modeSel.value = item.optionsSummary['targetFramework'];
    } else if (modeSel && typeof item.optionsSummary['action'] === 'string') {
      modeSel.value = item.optionsSummary['action'];
    }
    const status = document.getElementById('status-message');
    if (status) {
      status.textContent = `Review options and the target page above, then run ${TOOL_SHORT_LABELS[item.tool]}. Previously used on ${item.sourceDomain || 'an unavailable site'}.`;
    }
    document.getElementById('run-tool-btn')?.focus();
  });
  actions.appendChild(rerunBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'ghost sm';
  deleteBtn.textContent = 'Delete';
  deleteBtn.setAttribute('aria-label', `Delete ${TOOL_SHORT_LABELS[item.tool]} activity entry`);
  deleteBtn.addEventListener('click', () => {
    void sendBackgroundMessage('DELETE_ACTIVITY_ENTRY', { activityId: item.id }).then((res) => {
      if (res.ok) {
        void loadActivityHistory(true);
      }
    });
  });
  actions.appendChild(deleteBtn);

  row.append(main, actions);
  return row;
}

function renderActivityHistoryList(): void {
  const listEl = document.getElementById('history-timeline-list');
  const summaryEl = document.getElementById('history-summary-line');
  const loadMoreBtn = document.getElementById('history-load-more-btn') as HTMLButtonElement | null;
  const groupMode =
    (document.getElementById('history-group-mode') as HTMLSelectElement | null)?.value ?? 'day';

  if (summaryEl) {
    summaryEl.textContent =
      historyTotalMatching === 0
        ? 'No recorded PageSift tool actions match the current filters.'
        : `Showing ${historyItemsLoaded.length} of ${historyTotalMatching} recorded PageSift actions.`;
  }
  if (loadMoreBtn) {
    loadMoreBtn.style.display = historyHasMore ? '' : 'none';
  }
  if (!listEl) {
    return;
  }

  listEl.textContent = '';
  if (historyItemsLoaded.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const strong = document.createElement('strong');
    strong.textContent = 'No PageSift activity recorded yet';
    const sub = document.createElement('span');
    sub.textContent =
      'Run any of the 15 PageSift tools from the on-page overlay or dashboard to build your local research timeline.';
    empty.append(strong, sub);
    listEl.appendChild(empty);
    return;
  }

  const groups = new Map<
    string,
    { label: string; sessionId?: string; items: ActivityQueryItem[] }
  >();

  for (const item of historyItemsLoaded) {
    if (groupMode === 'session') {
      const existing = groups.get(item.sessionId);
      if (existing) {
        existing.items.push(item);
      } else {
        const dayLabel = groupDateLabelForLocalDisplay(item.startedAt);
        groups.set(item.sessionId, {
          label: `${item.sourceDomain || 'Local'} · ${dayLabel}`,
          sessionId: item.sessionId,
          items: [item],
        });
      }
    } else {
      const dayLabel = groupDateLabelForLocalDisplay(item.startedAt);
      const existing = groups.get(dayLabel);
      if (existing) {
        existing.items.push(item);
      } else {
        groups.set(dayLabel, { label: dayLabel, items: [item] });
      }
    }
  }

  for (const group of groups.values()) {
    const wrap = document.createElement('section');
    wrap.className = 'timeline-group';

    const header = document.createElement('div');
    header.className = 'timeline-group-header';

    const title = document.createElement('span');
    title.textContent = `${group.label} (${group.items.length})`;
    header.appendChild(title);

    if (group.sessionId) {
      const delSessBtn = document.createElement('button');
      delSessBtn.type = 'button';
      delSessBtn.className = 'ghost sm';
      delSessBtn.textContent = 'Delete Session';
      const sid = group.sessionId;
      delSessBtn.addEventListener('click', () => {
        void sendBackgroundMessage('DELETE_ACTIVITY_SESSION', { sessionId: sid }).then((res) => {
          if (res.ok) {
            void loadActivityHistory(true);
          }
        });
      });
      header.appendChild(delSessBtn);
    }

    wrap.appendChild(header);
    for (const item of group.items) {
      wrap.appendChild(createActivityRowElement(item));
    }
    listEl.appendChild(wrap);
  }
}

async function loadActivityHistory(reset: boolean): Promise<void> {
  if (reset) {
    historyOffset = 0;
    historyItemsLoaded = [];
  }

  const currentSiteOnly =
    (document.getElementById('history-current-site-only') as HTMLInputElement | null)?.checked ??
    false;
  const domain =
    (document.getElementById('history-domain-filter') as HTMLSelectElement | null)?.value || '';
  const tool =
    (document.getElementById('history-tool-filter') as HTMLSelectElement | null)?.value || '';
  const status =
    (document.getElementById('history-status-filter') as HTMLSelectElement | null)?.value || '';
  const dateRange =
    (document.getElementById('history-date-range') as HTMLSelectElement | null)?.value || 'all';
  const search =
    (document.getElementById('history-search-input') as HTMLInputElement | null)?.value.trim() ||
    '';

  const bounds = buildDateRangeFilterBounds(dateRange);
  const payload: Record<string, unknown> = {
    limit: HISTORY_PAGE_SIZE,
    offset: historyOffset,
    ...(bounds.fromIso ? { fromIso: bounds.fromIso } : {}),
    ...(bounds.toIso ? { toIso: bounds.toIso } : {}),
  };

  if (currentSiteOnly && lastTargetPageUrl) {
    const clean = sanitizeActivitySourceUrl(lastTargetPageUrl);
    if (clean.sourceOrigin) {
      payload['origin'] = clean.sourceOrigin;
    }
  } else if (domain) {
    payload['domain'] = domain;
  }
  if (tool) {
    payload['tool'] = tool;
  }
  if (status) {
    payload['status'] = status;
  }
  if (search) {
    payload['search'] = search;
  }

  const res = await sendBackgroundMessage('QUERY_ACTIVITY_HISTORY', payload);
  if (!res.ok) {
    const summaryEl = document.getElementById('history-summary-line');
    if (summaryEl) {
      summaryEl.textContent = `Could not load activity history: ${res.error.message}`;
    }
    return;
  }

  const result = res.data as ActivityQueryResult;
  updateHistoryDomainOptions(result.domains);
  if (reset) {
    historyItemsLoaded = result.items;
  } else {
    historyItemsLoaded = [...historyItemsLoaded, ...result.items];
  }
  historyTotalMatching = result.totalMatching;
  historyHasMore = result.hasMore;
  historyOffset = historyItemsLoaded.length;
  renderActivityHistoryList();
}

async function refreshProjectsDropdown(): Promise<void> {
  const select = document.getElementById('project-select') as HTMLSelectElement | null;
  const savedList = document.getElementById('saved-work-list');
  const selectedProjectId = select?.value || undefined;

  const [projRes, jobsRes] = await Promise.all([
    sendBackgroundMessage(
      'LIST_PROJECTS_FROM_IDB',
      selectedProjectId ? { projectId: selectedProjectId } : {},
    ),
    sendBackgroundMessage('LIST_JOBS'),
  ]);

  if (!projRes.ok) {
    return;
  }
  const data = projRes.data as {
    projects: Array<{ id: string; name: string }>;
    artifacts: Array<{ id: string; title: string; kind: string; createdAt: string }>;
    captures: Array<{
      id: string;
      pageTitle: string;
      mimeType: string;
      width: number;
      height: number;
      dataUrl: string;
    }>;
  };
  if (select) {
    const prev = select.value;
    select.textContent = '';
    for (const proj of data.projects) {
      const opt = document.createElement('option');
      opt.value = proj.id;
      opt.textContent = proj.name;
      select.appendChild(opt);
    }
    if (prev && data.projects.some((p) => p.id === prev)) {
      select.value = prev;
    }
  }

  if (savedList) {
    savedList.textContent = '';

    const artBlock = document.createElement('section');
    artBlock.className = 'timeline-group';
    const artHeader = document.createElement('div');
    artHeader.className = 'timeline-group-header';
    artHeader.textContent = `Saved Artifacts (${data.artifacts.length}) & Captures (${data.captures.length})`;
    artBlock.appendChild(artHeader);

    if (data.artifacts.length === 0 && data.captures.length === 0) {
      const emptyRow = document.createElement('div');
      emptyRow.className = 'timeline-row';
      const msg = document.createElement('span');
      msg.className = 'muted';
      msg.textContent = 'No saved items in this project yet. Run a tool and click Save Result.';
      emptyRow.appendChild(msg);
      artBlock.appendChild(emptyRow);
    } else {
      for (const art of data.artifacts) {
        const row = document.createElement('div');
        row.className = 'timeline-row';

        const main = document.createElement('div');
        main.className = 'timeline-main';
        const titleLine = document.createElement('div');
        titleLine.className = 'timeline-title-line';
        const lbl = document.createElement('strong');
        lbl.textContent = art.title;
        const kindTag = document.createElement('span');
        kindTag.className = 'tag';
        kindTag.textContent = art.kind;
        titleLine.append(lbl, kindTag);
        const meta = document.createElement('div');
        meta.className = 'timeline-meta mono';
        meta.textContent = `${groupDateLabelForLocalDisplay(art.createdAt)} · ${formatLocalTime(art.createdAt)}`;
        main.append(titleLine, meta);

        const actions = document.createElement('div');
        actions.className = 'timeline-actions';
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'secondary sm';
        openBtn.textContent = 'Open';
        openBtn.addEventListener('click', () => {
          void openSavedArtifactById(art.id);
        });
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'ghost sm';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => {
          void sendBackgroundMessage('DELETE_ARTIFACT_FROM_IDB', { artifactId: art.id }).then(
            () => {
              void refreshProjectsDropdown();
            },
          );
        });
        actions.append(openBtn, delBtn);

        row.append(main, actions);
        artBlock.appendChild(row);
      }

      for (const cap of data.captures) {
        const row = document.createElement('div');
        row.className = 'timeline-row';
        const main = document.createElement('div');
        main.className = 'timeline-main';
        const titleLine = document.createElement('div');
        titleLine.className = 'timeline-title-line';
        const lbl = document.createElement('strong');
        lbl.textContent = cap.pageTitle;
        const dimsTag = document.createElement('span');
        dimsTag.className = 'tag mono';
        dimsTag.textContent = `${cap.width}×${cap.height} · ${cap.mimeType}`;
        titleLine.append(lbl, dimsTag);
        main.appendChild(titleLine);

        const actions = document.createElement('div');
        actions.className = 'timeline-actions';
        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'secondary sm';
        dlBtn.textContent = 'Download';
        dlBtn.addEventListener('click', () => {
          const commaIdx = cap.dataUrl.indexOf(',');
          const bytes = decodeBase64ToBytes(cap.dataUrl.slice(commaIdx + 1));
          const ext =
            cap.mimeType === 'application/pdf' ? 'pdf' : (cap.mimeType.split('/')[1] ?? 'png');
          triggerFileDownload({
            filename: `${makeSlug(cap.pageTitle)}.${ext}`,
            mimeType: cap.mimeType,
            bytes,
          });
        });
        actions.appendChild(dlBtn);
        row.append(main, actions);
        artBlock.appendChild(row);
      }
    }
    savedList.appendChild(artBlock);

    if (jobsRes.ok) {
      const jobs = (
        jobsRes.data as {
          jobs: Array<{ id: string; tool: string; status: string; statusMessage: string }>;
        }
      ).jobs;
      const jobsBlock = document.createElement('section');
      jobsBlock.className = 'timeline-group';
      const jt = document.createElement('div');
      jt.className = 'timeline-group-header';
      jt.textContent = `Background Jobs (${jobs.length})`;
      jobsBlock.appendChild(jt);
      if (jobs.length === 0) {
        const emptyRow = document.createElement('div');
        emptyRow.className = 'timeline-row';
        const empty = document.createElement('span');
        empty.className = 'muted';
        empty.textContent = 'No persisted background jobs recorded yet.';
        emptyRow.appendChild(empty);
        jobsBlock.appendChild(emptyRow);
      } else {
        for (const job of jobs.slice(0, 12)) {
          const row = document.createElement('div');
          row.className = 'timeline-row';
          const lbl = document.createElement('span');
          lbl.className = 'truncate';
          lbl.textContent = `${job.tool}: ${job.statusMessage}`;
          const statusTag = document.createElement('span');
          statusTag.className =
            job.status === 'completed'
              ? 'tag positive'
              : job.status === 'interrupted' || job.status === 'failed'
                ? 'tag warning'
                : 'tag accent';
          statusTag.textContent = job.status;
          row.append(lbl, statusTag);
          jobsBlock.appendChild(row);
        }
      }
      savedList.appendChild(jobsBlock);
    }
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
  if (!url) {
    setStatus('No active target URL to preview in responsive windows.', 'error');
    return;
  }
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
    lastActivityIdForResult = null;
    lastActivityMeta = null;
    clearNvidiaConfirmation();
    renderResponsiveSessionStatus(data['session']);
    renderCurrentStructuredOutput('responsive', data);
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
  if (activeJobRequestId !== null) {
    return;
  }
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

  let localActivityId: string | null = null;
  let localStartMs = 0;
  let localOptionsSummary: Record<string, unknown> = {};

  try {
    const { tabId, url } = await resolveTargetTabId();
    if (tabId === null) {
      throw new Error(
        'No active target tab detected. Click the PageSift toolbar icon on a web page or pass ?tabId=<id>.',
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
      lastActivityIdForResult = `act-${requestId}`;
      lastActivityMeta = {
        tool: 'capture',
        actionLabel: `Capture (${mode})`,
        optionsSummary: { mode, exportMime },
        resultSummary: `Captured ${verified.width}×${verified.height}px (${verified.mimeType})`,
        durationMs: null,
      };
      const built = buildDownloadableForTool('capture', data, makeSlug(lastTargetPageTitle));
      lastDownloadable = built.downloadable;
      lastCopyableText = built.copyableText;
      updateActionButtons();
      renderCurrentStructuredOutput('capture', data);
      outputEl.textContent = summarizeOutputForDisplay('capture', data);
      setStatus(
        `Captured ${verified.width}×${verified.height}px (${verified.mimeType}, ${verified.byteLength.toLocaleString()} bytes).`,
        'success',
      );
      return;
    }

    if (currentTool === 'clone_page') {
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
      lastActivityIdForResult = `act-${requestId}`;
      lastActivityMeta = {
        tool: 'clone_page',
        actionLabel: 'Clone Page',
        optionsSummary: {},
        resultSummary: 'Generated static HTML/CSS snapshot ZIP',
        durationMs: null,
      };
      const built = buildDownloadableForTool('clone_page', data, makeSlug(lastTargetPageTitle));
      lastDownloadable = built.downloadable;
      lastCopyableText = built.copyableText;
      updateActionButtons();
      renderCurrentStructuredOutput('clone_page', data);
      outputEl.textContent = summarizeOutputForDisplay('clone_page', data);
      setStatus('Static HTML/CSS snapshot ZIP ready to download.', 'success');
      return;
    }

    if (currentTool === 'assets') {
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
      const packagedCount =
        typeof data['packagedFilesCount'] === 'number' ? data['packagedFilesCount'] : 0;
      lastActivityIdForResult = `act-${requestId}`;
      lastActivityMeta = {
        tool: 'assets',
        actionLabel: 'Assets Extract',
        optionsSummary: { includeZip: true },
        resultSummary: `Packaged ${packagedCount} asset files`,
        durationMs: null,
      };
      const built = buildDownloadableForTool('assets', data, makeSlug(lastTargetPageTitle));
      lastDownloadable = built.downloadable;
      lastCopyableText = built.copyableText;
      updateActionButtons();
      renderCurrentStructuredOutput('assets', data);
      outputEl.textContent = summarizeOutputForDisplay('assets', data);
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
      if (selector) payload['primarySelector'] = selector;
      if (secondary) payload['secondarySelector'] = secondary;
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

    localActivityId = `act-${requestId}`;
    localStartMs = performance.now();
    localOptionsSummary = {
      ...(selector && TOOLS_WITH_SELECTOR.has(currentTool) ? { selector } : {}),
      ...(payload['targetFramework'] ? { targetFramework: payload['targetFramework'] } : {}),
      ...(payload['action'] ? { action: payload['action'] } : {}),
      ...(payload['fontFamily'] ? { fontFamily: payload['fontFamily'] } : {}),
    };

    void sendBackgroundMessage('RECORD_LOCAL_ACTIVITY', {
      activityId: localActivityId,
      tool: currentTool,
      actionLabel: TOOL_SHORT_LABELS[currentTool],
      sourceUrl: lastTargetPageUrl,
      pageTitle: lastTargetPageTitle,
      status: 'running',
      optionsSummary: localOptionsSummary,
      resultSummary: `Running ${TOOL_SHORT_LABELS[currentTool]}...`,
    });

    const res = await sendContentMessage(tabId, opMap[currentTool], payload, docCtx.documentId);
    if (!res.ok) {
      throw new Error(res.error.message);
    }

    const durationMs = Math.max(0, Math.round(performance.now() - localStartMs));
    const data = res.data as Record<string, unknown>;
    const summaryText = summarizeToolResultShort(currentTool, data);

    void sendBackgroundMessage('RECORD_LOCAL_ACTIVITY', {
      activityId: localActivityId,
      tool: currentTool,
      actionLabel: TOOL_SHORT_LABELS[currentTool],
      sourceUrl: lastTargetPageUrl,
      pageTitle: lastTargetPageTitle,
      status: 'completed',
      durationMs,
      optionsSummary: localOptionsSummary,
      resultSummary: summaryText,
    });

    lastResultTool = currentTool;
    lastResultData = data;
    lastActivityIdForResult = localActivityId;
    lastActivityMeta = {
      tool: currentTool,
      actionLabel: TOOL_SHORT_LABELS[currentTool],
      optionsSummary: localOptionsSummary,
      resultSummary: summaryText,
      durationMs,
    };
    const built = buildDownloadableForTool(currentTool, data, makeSlug(lastTargetPageTitle));
    lastDownloadable = built.downloadable;
    lastCopyableText = built.copyableText;
    updateActionButtons();
    renderCurrentStructuredOutput(currentTool, data);
    outputEl.textContent = summarizeOutputForDisplay(currentTool, data);
    setStatus(`Completed ${TOOL_TITLES[currentTool]} locally (${durationMs} ms).`, 'success');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Execution failed';
    if (localActivityId) {
      const durationMs = Math.max(0, Math.round(performance.now() - localStartMs));
      void sendBackgroundMessage('RECORD_LOCAL_ACTIVITY', {
        activityId: localActivityId,
        tool: currentTool,
        actionLabel: TOOL_SHORT_LABELS[currentTool],
        sourceUrl: lastTargetPageUrl,
        pageTitle: lastTargetPageTitle,
        status: 'failed',
        durationMs,
        optionsSummary: localOptionsSummary,
        resultSummary: message,
        errorCategory: 'TOOL_EXECUTION_ERROR',
      });
    }
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
    renderCurrentStructuredOutput('capture', updatedData);
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

function closeMobileRail(): void {
  const rail = document.getElementById('tool-dock');
  const backdrop = document.getElementById('rail-backdrop');
  const menuBtn = document.getElementById('mobile-menu-btn');
  rail?.classList.remove('open');
  backdrop?.classList.remove('open');
  menuBtn?.setAttribute('aria-expanded', 'false');
}

function openNvidiaModal(digest: string, previewText: string): void {
  const modal = document.getElementById('nvidia-preview-modal');
  const digestEl = document.getElementById('nvidia-modal-digest');
  const payloadEl = document.getElementById('nvidia-modal-payload');
  const closeBtn = document.getElementById('nvidia-modal-close-btn');
  lastFocusedBeforeModal =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (digestEl) {
    digestEl.textContent = `Payload Digest: ${digest.slice(0, 24)}...`;
  }
  if (payloadEl) {
    payloadEl.textContent = previewText;
  }
  modal?.classList.add('open');
  closeBtn?.focus();
}

function closeNvidiaModal(): void {
  const modal = document.getElementById('nvidia-preview-modal');
  modal?.classList.remove('open');
  lastFocusedBeforeModal?.focus();
  lastFocusedBeforeModal = null;
}

function openClearHistoryModal(): void {
  const modal = document.getElementById('clear-history-modal');
  const cancelBtn = document.getElementById('clear-history-cancel-btn');
  lastFocusedBeforeModal =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal?.classList.add('open');
  cancelBtn?.focus();
}

function closeClearHistoryModal(): void {
  const modal = document.getElementById('clear-history-modal');
  modal?.classList.remove('open');
  lastFocusedBeforeModal?.focus();
  lastFocusedBeforeModal = null;
}

function selectActiveTool(tool: ToolId): void {
  currentTool = tool;
  const dock = document.getElementById('tool-dock');
  dock?.querySelectorAll('button[data-tool]').forEach((b) => {
    const isSelected = b.getAttribute('data-tool') === tool;
    b.classList.toggle('active', isSelected);
    b.setAttribute('aria-current', isSelected ? 'page' : 'false');
  });
  updateSubPanelsForTool(tool);
  if (tool !== 'capture') {
    document.getElementById('capture-preview-wrap')?.classList.remove('visible');
  } else if (lastCaptureState) {
    updateCapturePreviewUi();
  }
  if (activeSection !== 'tools') {
    switchSection('tools');
  } else {
    closeMobileRail();
  }
}

function filterSidebarTools(query: string): void {
  const normalized = query.trim().toLowerCase();
  const groups = document.querySelectorAll<HTMLElement>('#tool-dock .rail-group');
  groups.forEach((group) => {
    let visibleCount = 0;
    group.querySelectorAll<HTMLButtonElement>('button[data-tool]').forEach((btn) => {
      const toolId = btn.getAttribute('data-tool') ?? '';
      const text = `${btn.textContent} ${toolId}`.toLowerCase();
      const match = !normalized || text.includes(normalized);
      btn.style.display = match ? '' : 'none';
      if (match) {
        visibleCount += 1;
      }
    });
    group.style.display = visibleCount > 0 ? '' : 'none';
  });
}

function attachNavIcons(): void {
  document.querySelectorAll<HTMLButtonElement>('#tool-dock button[data-tool]').forEach((btn) => {
    const tool = btn.getAttribute('data-tool');
    if (tool) {
      btn.prepend(createSvgIcon(tool));
      btn.title = tool in TOOL_SHORT_LABELS ? TOOL_SHORT_LABELS[tool as ToolId] : tool;
    }
  });
  document.getElementById('nav-tools-btn')?.prepend(createSvgIcon('tools'));
  document.getElementById('nav-history-btn')?.prepend(createSvgIcon('history'));
  document.getElementById('nav-saved-btn')?.prepend(createSvgIcon('folder'));
  document.getElementById('mobile-menu-btn')?.prepend(createSvgIcon('menu'));
  const sidebarBtn = document.getElementById('toggle-sidebar-btn');
  if (sidebarBtn) {
    sidebarBtn.textContent = '';
    sidebarBtn.appendChild(createSvgIcon('sidebar'));
  }
}

function updateThemeButton(): void {
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    btn.textContent = formatThemeLabel(currentThemePref);
  }
}

async function syncSettingsIntoWorkspace(): Promise<void> {
  applyThemePreference(currentThemePref);
  updateThemeButton();
  try {
    const res = await sendBackgroundMessage('GET_SETTINGS');
    if (res.ok) {
      const s = (
        res.data as {
          settings?: {
            theme?: ThemePreference;
            sidebarCollapsed?: boolean;
            recordActivityHistory?: boolean;
            activityFirstUseNoticeDismissed?: boolean;
          };
        }
      ).settings;
      if (s?.theme === 'system' || s?.theme === 'light' || s?.theme === 'dark') {
        currentThemePref = s.theme;
        applyThemePreference(currentThemePref);
        updateThemeButton();
      }
      if (typeof s?.sidebarCollapsed === 'boolean') {
        sidebarCollapsed = s.sidebarCollapsed;
        applySidebarCollapsedUi();
      }
      const recordToggle = document.getElementById(
        'history-recording-toggle',
      ) as HTMLInputElement | null;
      if (recordToggle && typeof s?.recordActivityHistory === 'boolean') {
        recordToggle.checked = s.recordActivityHistory;
      }
      const notice = document.getElementById('history-first-use-notice');
      if (notice) {
        notice.style.display = s?.activityFirstUseNoticeDismissed ? 'none' : '';
      }
    }
  } catch {
    return;
  }
}

function initWorkspaceUi(): void {
  bindGlobalTapFeedback(document);
  attachNavIcons();
  void syncSettingsIntoWorkspace();
  void updateTargetPageIdentity();

  const dock = document.getElementById('tool-dock');
  const outputEl = document.getElementById('tool-output');

  window.addEventListener('pagehide', () => {
    for (const url of activeObjectUrls) {
      URL.revokeObjectURL(url);
    }
    activeObjectUrls.clear();
  });

  document.getElementById('toggle-sidebar-btn')?.addEventListener('click', () => {
    sidebarCollapsed = !sidebarCollapsed;
    applySidebarCollapsedUi();
    void sendBackgroundMessage('UPDATE_SETTINGS', {
      settings: { sidebarCollapsed },
    }).catch(() => undefined);
  });

  document.getElementById('mobile-menu-btn')?.addEventListener('click', () => {
    const rail = document.getElementById('tool-dock');
    const backdrop = document.getElementById('rail-backdrop');
    const menuBtn = document.getElementById('mobile-menu-btn');
    const nextOpen = !rail?.classList.contains('open');
    rail?.classList.toggle('open', nextOpen);
    backdrop?.classList.toggle('open', nextOpen);
    menuBtn?.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    if (nextOpen) {
      rail?.querySelector<HTMLButtonElement>('button[data-tool].active')?.focus();
    }
  });

  document.getElementById('rail-backdrop')?.addEventListener('click', () => {
    closeMobileRail();
  });

  document.querySelectorAll<HTMLButtonElement>('.rail-section-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sec = btn.getAttribute('data-section') as DashboardSection | null;
      if (sec) {
        switchSection(sec);
      }
    });
  });

  document.getElementById('tool-search-input')?.addEventListener('input', (event) => {
    filterSidebarTools((event.target as HTMLInputElement).value);
  });

  document.getElementById('theme-toggle-btn')?.addEventListener('click', () => {
    void (async () => {
      currentThemePref = nextThemePreference(currentThemePref);
      applyThemePreference(currentThemePref);
      updateThemeButton();
      await sendBackgroundMessage('UPDATE_SETTINGS', {
        settings: { theme: currentThemePref },
      }).catch(() => undefined);
    })();
  });

  document.getElementById('refresh-projects-btn')?.addEventListener('click', () => {
    void refreshProjectsDropdown();
  });

  document.getElementById('project-select')?.addEventListener('change', () => {
    void refreshProjectsDropdown();
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
    selectActiveTool(tool);
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
    if (!lastCopyableText) {
      setStatus('No text output available to copy.', 'error');
      return;
    }
    void copyTextWithFeedback(lastCopyableText, 'output text');
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
      renderCurrentStructuredOutput('colors', lastResultData);
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
      (document.getElementById('ann-color') as HTMLInputElement | null)?.value || '#0057ff';
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
        renderCurrentStructuredOutput('responsive', d);
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
        renderCurrentStructuredOutput('responsive', { session: null });
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
        setStatus('No bound web tab for on-page picker.', 'warning');
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
            ? `On-page picker active for ${TOOL_SHORT_LABELS[currentTool]} (press Escape on page to dismiss).`
            : 'On-page picker deactivated.',
          'success',
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
        if (res.ok) {
          renderCurrentStructuredOutput(currentTool, res.data as Record<string, unknown>);
          setStatus(`Applied ${op.replace('EDIT_', '').toLowerCase()} locally.`, 'success');
        }
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
        if (res.ok && lastActivityIdForResult && lastActivityMeta) {
          const savedCap = (res.data as { capture?: { id?: string } }).capture;
          if (savedCap?.id) {
            void sendBackgroundMessage('RECORD_LOCAL_ACTIVITY', {
              activityId: lastActivityIdForResult,
              tool: lastActivityMeta.tool,
              actionLabel: lastActivityMeta.actionLabel,
              sourceUrl: lastCaptureState.pageUrl,
              pageTitle: lastCaptureState.pageTitle,
              status: 'completed',
              durationMs: lastActivityMeta.durationMs,
              optionsSummary: lastActivityMeta.optionsSummary,
              resultSummary: lastActivityMeta.resultSummary,
              linkedCaptureId: savedCap.id,
            });
          }
        }
        setStatus(
          res.ok
            ? 'Saved screenshot capture to local IndexedDB.'
            : `Save error: ${res.error.message}`,
          res.ok ? 'success' : 'error',
        );
        void refreshProjectsDropdown();
        return;
      }

      const payloadToSave = { ...(lastResultData ?? { savedAt: new Date().toISOString() }) };
      delete payloadToSave['zipBase64'];
      const toolKey = lastResultTool ?? currentTool;
      const res = await sendBackgroundMessage('SAVE_ARTIFACT_TO_IDB', {
        projectId,
        kind: TOOL_TO_ARTIFACT_KIND[toolKey],
        title: `${TOOL_SHORT_LABELS[toolKey]} · ${lastTargetPageTitle}`,
        sourceUrl: lastTargetPageUrl || null,
        artifactPayload: payloadToSave,
      });
      if (res.ok && lastActivityIdForResult && lastActivityMeta) {
        const savedArt = (res.data as { artifact?: { id?: string } }).artifact;
        if (savedArt?.id) {
          void sendBackgroundMessage('RECORD_LOCAL_ACTIVITY', {
            activityId: lastActivityIdForResult,
            tool: lastActivityMeta.tool,
            actionLabel: lastActivityMeta.actionLabel,
            sourceUrl: lastTargetPageUrl,
            pageTitle: lastTargetPageTitle,
            status: 'completed',
            durationMs: lastActivityMeta.durationMs,
            optionsSummary: lastActivityMeta.optionsSummary,
            resultSummary: lastActivityMeta.resultSummary,
            linkedArtifactId: savedArt.id,
          });
        }
      }
      setStatus(
        res.ok ? 'Saved tool result to local IndexedDB.' : `Save error: ${res.error.message}`,
        res.ok ? 'success' : 'error',
      );
      void refreshProjectsDropdown();
    })();
  });

  document.getElementById('history-recording-toggle')?.addEventListener('change', (event) => {
    const enabled = (event.target as HTMLInputElement).checked;
    void sendBackgroundMessage('UPDATE_SETTINGS', {
      settings: { recordActivityHistory: enabled },
    }).then((res) => {
      if (res.ok) {
        setStatus(
          enabled
            ? 'Activity history recording enabled for explicit PageSift actions.'
            : 'Activity history recording paused. Existing entries remain intact.',
          'success',
        );
      }
    });
  });

  document.getElementById('dismiss-history-notice-btn')?.addEventListener('click', () => {
    const notice = document.getElementById('history-first-use-notice');
    if (notice) {
      notice.style.display = 'none';
    }
    void sendBackgroundMessage('UPDATE_SETTINGS', {
      settings: { activityFirstUseNoticeDismissed: true },
    });
  });

  document.getElementById('history-refresh-btn')?.addEventListener('click', () => {
    void loadActivityHistory(true);
  });

  document.getElementById('history-clear-btn')?.addEventListener('click', () => {
    openClearHistoryModal();
  });

  document.getElementById('clear-history-cancel-btn')?.addEventListener('click', () => {
    closeClearHistoryModal();
  });

  document.getElementById('clear-history-modal')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      closeClearHistoryModal();
    }
  });

  document.getElementById('clear-history-confirm-btn')?.addEventListener('click', () => {
    void (async () => {
      closeClearHistoryModal();
      const res = await sendBackgroundMessage('CLEAR_ACTIVITY_HISTORY');
      if (res.ok) {
        void loadActivityHistory(true);
        setStatus(
          'Cleared local activity history. Saved projects and artifacts were kept.',
          'success',
        );
      }
    })();
  });

  for (const filterId of [
    'history-current-site-only',
    'history-domain-filter',
    'history-tool-filter',
    'history-status-filter',
    'history-date-range',
  ]) {
    document.getElementById(filterId)?.addEventListener('change', () => {
      void loadActivityHistory(true);
    });
  }

  document.getElementById('history-group-mode')?.addEventListener('change', () => {
    renderActivityHistoryList();
  });

  document.getElementById('history-search-input')?.addEventListener('input', () => {
    if (historySearchTimer !== null) {
      clearTimeout(historySearchTimer);
    }
    historySearchTimer = setTimeout(() => {
      historySearchTimer = null;
      void loadActivityHistory(true);
    }, 180);
  });

  document.getElementById('history-load-more-btn')?.addEventListener('click', () => {
    void loadActivityHistory(false);
  });

  const supportedNvidiaSourceTools = new Set([
    'clone_prompt',
    'design_review',
    'design_md',
    'colors',
    'fonts',
    'inspect',
    'tech_stack',
  ]);

  const executeConfirmedNvidiaSend = async (): Promise<void> => {
    if (!confirmedNvidiaDigest || !confirmedNvidiaTaskType) {
      setStatus('Preview data egress first before transmitting.', 'error');
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
      res.ok ? 'Optional AI enhancement completed.' : `AI error: ${res.error.message}`,
      res.ok ? 'success' : 'error',
    );
  };

  document.getElementById('preview-nvidia-btn')?.addEventListener('click', () => {
    void (async () => {
      const sourceTool =
        lastResultTool && supportedNvidiaSourceTools.has(lastResultTool)
          ? lastResultTool
          : currentTool === 'tech_stack'
            ? 'tech_stack'
            : 'clone_prompt';
      const taskType =
        currentTool === 'tech_stack' || sourceTool === 'tech_stack'
          ? 'explain_tech_stack'
          : currentTool === 'design_review' || sourceTool === 'design_review'
            ? 'interpret_design_review'
            : 'enhance_clone_prompt';
      const res = await sendBackgroundMessage('RUN_NVIDIA_ENHANCEMENT', {
        previewOnly: true,
        taskType,
        sourceTool,
        toolOutput: lastResultData ?? { pageTitle: lastTargetPageTitle },
      });
      if (res.ok) {
        const data = res.data as {
          payloadDigest: string;
          egressPreview?: { serializedPayloadPreview?: string };
        };
        confirmedNvidiaDigest = data.payloadDigest;
        confirmedNvidiaTaskType = taskType;
        const runBtn = document.getElementById('run-nvidia-btn') as HTMLButtonElement | null;
        if (runBtn) {
          runBtn.disabled = false;
        }
        const previewText =
          data.egressPreview?.serializedPayloadPreview ?? JSON.stringify(res.data, null, 2);
        openNvidiaModal(data.payloadDigest, previewText);
        setStatus(
          'Reviewed exact NVIDIA data egress payload. Confirm in dialog or click Confirm & Enhance.',
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
    void executeConfirmedNvidiaSend();
  });

  document.getElementById('nvidia-modal-confirm-btn')?.addEventListener('click', () => {
    closeNvidiaModal();
    void executeConfirmedNvidiaSend();
  });

  document.getElementById('nvidia-modal-close-btn')?.addEventListener('click', () => {
    closeNvidiaModal();
  });

  document.getElementById('nvidia-modal-cancel-btn')?.addEventListener('click', () => {
    closeNvidiaModal();
  });

  document.getElementById('nvidia-preview-modal')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      closeNvidiaModal();
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (document.getElementById('clear-history-modal')?.classList.contains('open')) {
        event.preventDefault();
        closeClearHistoryModal();
        return;
      }
      if (document.getElementById('nvidia-preview-modal')?.classList.contains('open')) {
        event.preventDefault();
        closeNvidiaModal();
        return;
      }
      if (document.getElementById('tool-dock')?.classList.contains('open')) {
        event.preventDefault();
        closeMobileRail();
        document.getElementById('mobile-menu-btn')?.focus();
      }
    }
  });

  const params = new URLSearchParams(window.location.search);
  const unsupportedUrl = params.get('unsupportedUrl');
  if (unsupportedUrl) {
    const noticeEl = document.getElementById('unsupported-page-notice');
    if (noticeEl) {
      noticeEl.style.display = '';
      noticeEl.textContent = `On-page overlay is restricted by Chrome on "${unsupportedUrl}". Use Activity History, Saved Work, or Settings here, or click the PageSift icon on any http:// or https:// website.`;
    }
  }

  const initialToolParam = params.get('tool') as ToolId | null;
  if (initialToolParam && initialToolParam in TOOL_TITLES) {
    selectActiveTool(initialToolParam);
  } else {
    selectActiveTool(currentTool);
  }

  const initialSection = params.get('section');
  if (initialSection === 'history' || initialSection === 'saved' || initialSection === 'tools') {
    switchSection(initialSection);
  } else if (unsupportedUrl) {
    switchSection('history');
  }

  updateActionButtons();
  void refreshProjectsDropdown();
  void sendBackgroundMessage('GET_RESPONSIVE_SESSION').then((res) => {
    if (res.ok) {
      const d = res.data as { session?: unknown };
      renderResponsiveSessionStatus(d.session);
      if (currentTool === 'responsive' && d.session) {
        renderCurrentStructuredOutput('responsive', d);
      }
    }
  });

  if (
    params.get('autorun') === '1' &&
    initialToolParam &&
    initialToolParam !== 'responsive' &&
    activeSection === 'tools'
  ) {
    setTimeout(() => {
      void executeSelectedTool();
    }, 120);
  }
}

if (typeof document !== 'undefined') {
  initWorkspaceUi();
}

export { encodeBytesToBase64 };
