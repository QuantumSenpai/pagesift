import createDOMPurify from 'dompurify';
import { strToU8, zipSync } from 'fflate';
import {
  parseSrcsetUrls,
  sanitizeArchiveFilename,
  sanitizeInlineSvgMarkup,
  type AssetBinaryFetcher,
} from './assets-engine.js';
import {
  buildShortSelector,
  collectDocumentElements,
  inspectFramesAndStylesheets,
} from './dom-utils.js';

export interface ClonePageProgressUpdate {
  phase: 'sanitizing_dom' | 'collecting_css' | 'downloading_assets' | 'packaging_zip';
  percent: number;
  message: string;
}

export interface ClonePageOptions {
  fetcher?: AssetBinaryFetcher;
  maxAssetCount?: number;
  maxSingleAssetBytes?: number;
  maxTotalArchiveBytes?: number;
  signal?: AbortSignal;
  onProgress?: (update: ClonePageProgressUpdate) => void;
}

export interface ClonePageMissingResource {
  url: string;
  context: 'image' | 'stylesheet' | 'css_url' | 'frame' | 'font' | 'poster' | 'active_container';
  reason: string;
}

export interface ClonePageManifest {
  schemaVersion: 1;
  exportedAt: string;
  sourceTitle: string;
  isSelfContained: boolean;
  residualRemoteResources: string[];
  sanitizationPolicy: {
    sanitizer: string;
    strippedActiveElements: string[];
    defensiveCspApplied: boolean;
    externalLinksPolicy: string;
  };
  cssFidelity: {
    accessibleStylesheetRulesCount: number;
    inaccessibleStylesheetsCount: number;
    usedComputedStyleFallback: boolean;
    fidelityNote: string;
  };
  files: string[];
  rewrittenAssets: Array<{ originalUrl: string; archivePath: string; byteLength: number }>;
  missingResources: ClonePageMissingResource[];
  scopeDisclaimer: string;
}

export interface ClonePagePreparedPayload {
  baseHref: string;
  sourceTitle: string;
  sanitizedHtmlTemplate: string;
  cssBlocks: Array<{ baseHref: string; cssText: string }>;
  candidateAssetUrls: Array<{
    url: string;
    context: 'image' | 'css_url' | 'font' | 'poster';
  }>;
  missingResources: ClonePageMissingResource[];
  cssFidelity: ClonePageManifest['cssFidelity'];
}

export interface ClonePageSnapshotResult {
  zipBytes: Uint8Array;
  htmlContent: string;
  cssContent: string;
  manifest: ClonePageManifest;
}

const SNAPSHOT_DEFENSIVE_CSP =
  "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline';";

const FORBIDDEN_SNAPSHOT_TAGS = [
  'script',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
  'meta',
  'link',
  'foreignobject',
  'animate',
  'animatemotion',
  'animatetransform',
  'set',
  'template',
  'selectedcontent',
  'portal',
];

const FORBIDDEN_SNAPSHOT_ATTRS = [
  'srcdoc',
  'action',
  'formaction',
  'xlink:actuate',
  'autofocus',
  'ping',
  'imagesrcset',
  'patchsrc',
];

const SAFE_DATA_IMAGE_REGEX = /^data:image\/(png|jpeg|jpg|webp|gif|avif);base64,[a-z0-9+/=\s]+$/i;

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Clone page snapshot cancelled by user');
  }
}

function normalizeUrlSchemeCheck(raw: string): string {
  return Array.from(raw)
    .filter((ch) => ch.charCodeAt(0) > 32)
    .join('')
    .toLowerCase();
}

function isDangerousUri(rawUrl: string): boolean {
  const normalized = normalizeUrlSchemeCheck(rawUrl);
  if (
    normalized.startsWith('javascript:') ||
    normalized.startsWith('vbscript:') ||
    normalized.startsWith('file:') ||
    normalized.startsWith('chrome:') ||
    normalized.startsWith('chrome-extension:')
  ) {
    return true;
  }
  if (normalized.startsWith('data:')) {
    return !SAFE_DATA_IMAGE_REGEX.test(rawUrl.trim());
  }
  return false;
}

export function rewriteCssAssetUrls(
  cssText: string,
  baseHref: string,
  urlToLocalPath: Map<string, string>,
  discoveredCssUrls: Set<string>,
): string {
  return cssText.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (fullMatch, _quote, rawUrl: string) => {
      const trimmed = rawUrl.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        return fullMatch;
      }
      if (isDangerousUri(trimmed)) {
        return 'url("")';
      }
      if (trimmed.startsWith('data:')) {
        return fullMatch;
      }

      let resolved: string;
      try {
        const parsed = new URL(trimmed, baseHref);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return 'url("")';
        }
        resolved = parsed.toString();
      } catch {
        return 'url("")';
      }

      discoveredCssUrls.add(resolved);
      const mapped = urlToLocalPath.get(resolved);
      if (mapped) {
        return `url("../${mapped}")`;
      }
      return `url("${resolved}")`;
    },
  );
}

function buildComputedStyleFallbackCss(doc: Document, win: Window): string {
  const { entries } = collectDocumentElements(doc, 400);
  const rulesBySelector = new Map<string, string>();
  const keyProperties = [
    'display',
    'position',
    'box-sizing',
    'flex-direction',
    'justify-content',
    'align-items',
    'gap',
    'grid-template-columns',
    'color',
    'background-color',
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'padding',
    'margin',
    'border-radius',
    'box-shadow',
  ];

  for (const { element } of entries) {
    const selector = buildShortSelector(element);
    if (rulesBySelector.has(selector)) {
      continue;
    }
    const computed = win.getComputedStyle(element);
    const declarations: string[] = [];
    for (const prop of keyProperties) {
      const val = computed.getPropertyValue(prop).trim();
      if (val && val !== 'none' && val !== 'normal' && val !== '0px' && val !== 'auto') {
        declarations.push(`  ${prop}: ${val};`);
      }
    }
    if (declarations.length > 0) {
      rulesBySelector.set(selector, `${selector} {\n${declarations.join('\n')}\n}`);
    }
  }

  return Array.from(rulesBySelector.values()).join('\n\n');
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function prepareStaticPageClone(
  doc: Document,
  win: Window,
  options: { signal?: AbortSignal; onProgress?: (update: ClonePageProgressUpdate) => void } = {},
): ClonePagePreparedPayload {
  const baseHref = doc.location.href || 'https://localhost/';

  checkAborted(options.signal);
  options.onProgress?.({
    phase: 'sanitizing_dom',
    percent: 10,
    message: 'Cloning and sanitizing DOM tree',
  });

  const frameAndSheetReport = inspectFramesAndStylesheets(doc);
  const missingResources: ClonePageMissingResource[] = [];

  for (const frameUrl of frameAndSheetReport.inaccessibleCrossOriginFrames) {
    missingResources.push({
      url: frameUrl,
      context: 'frame',
      reason: 'Cross-origin iframe removed by static snapshot safety policy',
    });
  }
  for (const sheetUrl of frameAndSheetReport.inaccessibleStylesheets) {
    missingResources.push({
      url: sheetUrl,
      context: 'stylesheet',
      reason: 'Cross-origin stylesheet rules blocked by CORS; computed-style fallback included',
    });
  }

  const rootClone = doc.documentElement.cloneNode(true) as HTMLElement;

  for (const node of Array.from(
    rootClone.querySelectorAll('[data-pagesift-root], #pagesift-root-host'),
  )) {
    node.remove();
  }

  for (const activeContainer of Array.from(
    rootClone.querySelectorAll('iframe, frame, frameset, object, embed, applet'),
  )) {
    const srcAttr =
      activeContainer.getAttribute('src') ??
      activeContainer.getAttribute('data') ??
      (activeContainer.hasAttribute('srcdoc') ? 'inline:srcdoc' : 'inline:active-container');
    if (!missingResources.some((m) => m.url === srcAttr)) {
      missingResources.push({
        url: srcAttr,
        context: 'active_container',
        reason: `Removed active <${activeContainer.tagName.toLowerCase()}> container from static snapshot`,
      });
    }
    activeContainer.remove();
  }

  for (const formControl of Array.from(rootClone.querySelectorAll('input, textarea, select'))) {
    const tag = formControl.tagName.toLowerCase();
    if (tag === 'input') {
      formControl.removeAttribute('value');
      (formControl as HTMLInputElement).value = '';
      formControl.removeAttribute('checked');
      (formControl as HTMLInputElement).checked = false;
    } else if (tag === 'textarea') {
      formControl.textContent = '';
      (formControl as HTMLTextAreaElement).value = '';
    }
  }

  const purify = createDOMPurify(win as unknown as Window & typeof globalThis);
  const sanitizedDoc = purify.sanitize(rootClone.outerHTML, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    FORBID_TAGS: FORBIDDEN_SNAPSHOT_TAGS,
    FORBID_ATTR: FORBIDDEN_SNAPSHOT_ATTRS,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|mailto|tel):|data:image\/(?:png|jpeg|jpg|webp|gif|avif);base64,|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
    SANITIZE_DOM: true,
    SAFE_FOR_XML: true,
  }) as unknown as HTMLElement;

  for (const svg of Array.from(sanitizedDoc.querySelectorAll('svg'))) {
    const cleanSvgMarkup = sanitizeInlineSvgMarkup(svg);
    const wrapper = doc.createElement('div');
    wrapper.innerHTML = cleanSvgMarkup;
    const replacement = wrapper.firstElementChild;
    if (replacement) {
      svg.replaceWith(replacement);
    } else {
      svg.remove();
    }
  }

  const candidateAssets = new Map<string, 'image' | 'css_url' | 'font' | 'poster'>();
  const registerAssetUrl = (
    rawUrl: string,
    context: 'image' | 'css_url' | 'font' | 'poster',
    resolveBase: string = baseHref,
  ): string | null => {
    const trimmed = rawUrl.trim();
    if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) {
      return null;
    }
    if (isDangerousUri(trimmed)) {
      return null;
    }
    try {
      const resolved = new URL(trimmed, resolveBase);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
        return null;
      }
      const urlStr = resolved.toString();
      if (!candidateAssets.has(urlStr)) {
        candidateAssets.set(urlStr, context);
      }
      return urlStr;
    } catch {
      return null;
    }
  };

  const allNodes = [sanitizedDoc, ...Array.from(sanitizedDoc.querySelectorAll('*'))];
  for (const node of allNodes) {
    for (const attr of Array.from(node.attributes)) {
      const nameLower = attr.name.toLowerCase();
      if (
        nameLower.startsWith('on') ||
        nameLower === 'srcdoc' ||
        nameLower === 'action' ||
        nameLower === 'formaction'
      ) {
        node.removeAttribute(attr.name);
        continue;
      }

      if (
        nameLower === 'href' ||
        nameLower === 'src' ||
        nameLower === 'poster' ||
        nameLower === 'xlink:href' ||
        nameLower === 'data'
      ) {
        if (isDangerousUri(attr.value)) {
          node.removeAttribute(attr.name);
          continue;
        }
      }
    }

    const tag = node.tagName.toLowerCase();
    if (tag === 'input') {
      node.removeAttribute('value');
      (node as HTMLInputElement).value = '';
    } else if (tag === 'textarea') {
      node.textContent = '';
      (node as HTMLTextAreaElement).value = '';
    } else if (tag === 'form') {
      node.removeAttribute('action');
      node.removeAttribute('method');
      node.removeAttribute('target');
    } else if (tag === 'img') {
      const rawSrcset = node.getAttribute('srcset') ?? node.getAttribute('data-srcset');
      if (rawSrcset) {
        for (const candidate of parseSrcsetUrls(rawSrcset)) {
          registerAssetUrl(candidate, 'image');
        }
      }
      node.removeAttribute('srcset');
      const src = node.getAttribute('src') ?? node.getAttribute('data-src');
      if (src) {
        const resolved = registerAssetUrl(src, 'image');
        if (resolved) {
          node.setAttribute('src', resolved);
        } else if (isDangerousUri(src)) {
          node.removeAttribute('src');
        }
      }
    } else if (tag === 'source') {
      const rawSrcset = node.getAttribute('srcset');
      if (rawSrcset) {
        const firstCandidate = parseSrcsetUrls(rawSrcset)[0];
        if (firstCandidate) {
          const resolved = registerAssetUrl(firstCandidate, 'image');
          if (resolved) {
            node.setAttribute('srcset', resolved);
          } else {
            node.removeAttribute('srcset');
          }
        }
      }
    } else if (tag === 'video') {
      const poster = node.getAttribute('poster');
      if (poster) {
        const resolved = registerAssetUrl(poster, 'poster');
        if (resolved) {
          node.setAttribute('poster', resolved);
        } else if (isDangerousUri(poster)) {
          node.removeAttribute('poster');
        }
      }
    } else if (tag === 'a') {
      const href = node.getAttribute('href');
      if (href) {
        if (isDangerousUri(href)) {
          node.removeAttribute('href');
        } else if (
          !href.startsWith('#') &&
          !href.toLowerCase().startsWith('mailto:') &&
          !href.toLowerCase().startsWith('tel:')
        ) {
          try {
            const resolved = new URL(href, baseHref);
            if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
              node.setAttribute('href', resolved.toString());
              node.setAttribute('rel', 'noopener noreferrer');
            } else {
              node.removeAttribute('href');
            }
          } catch {
            node.removeAttribute('href');
          }
        }
      }
    } else if (tag === 'style') {
      const inlineCss = node.textContent;
      const discovered = new Set<string>();
      const cleaned = rewriteCssAssetUrls(inlineCss, baseHref, new Map(), discovered);
      for (const u of discovered) {
        registerAssetUrl(u, 'css_url');
      }
      node.textContent = cleaned;
    }

    const inlineStyle = node.getAttribute('style');
    if (inlineStyle && inlineStyle.includes('url(')) {
      const discovered = new Set<string>();
      const cleanedInlineStyle = rewriteCssAssetUrls(inlineStyle, baseHref, new Map(), discovered);
      for (const u of discovered) {
        registerAssetUrl(u, 'css_url');
      }
      node.setAttribute('style', cleanedInlineStyle);
    }
  }

  checkAborted(options.signal);
  options.onProgress?.({
    phase: 'collecting_css',
    percent: 40,
    message: 'Extracting accessible CSS rules and computed fallbacks',
  });

  const cssBlocks: Array<{ baseHref: string; cssText: string }> = [];
  let accessibleRulesCount = 0;

  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    const sheetBase = sheet.href || baseHref;
    const sheetChunks: string[] = [];
    for (const rule of Array.from(rules)) {
      accessibleRulesCount += 1;
      sheetChunks.push(rule.cssText);
    }
    if (sheetChunks.length > 0) {
      const rawCss = sheetChunks.join('\n');
      const discoveredCssUrls = new Set<string>();
      rewriteCssAssetUrls(rawCss, sheetBase, new Map(), discoveredCssUrls);
      for (const cssUrl of discoveredCssUrls) {
        const withoutQuery = cssUrl.toLowerCase().split('?')[0] || '';
        const ctx: 'font' | 'css_url' =
          withoutQuery.endsWith('.woff2') ||
          withoutQuery.endsWith('.woff') ||
          withoutQuery.endsWith('.ttf') ||
          withoutQuery.endsWith('.otf')
            ? 'font'
            : 'css_url';
        registerAssetUrl(cssUrl, ctx, sheetBase);
      }
      cssBlocks.push({ baseHref: sheetBase, cssText: rawCss });
    }
  }

  const usedComputedFallback =
    accessibleRulesCount === 0 || frameAndSheetReport.inaccessibleStylesheets.length > 0;
  if (usedComputedFallback) {
    const fallbackCss = buildComputedStyleFallbackCss(doc, win);
    if (fallbackCss) {
      cssBlocks.push({ baseHref, cssText: fallbackCss });
    }
  }

  const sourceTitle = doc.title.trim() || 'Snapshot';
  let headEl = sanitizedDoc.querySelector('head');
  if (!headEl) {
    headEl = doc.createElement('head');
    sanitizedDoc.insertBefore(headEl, sanitizedDoc.firstChild);
  }
  const existingTitle = headEl.querySelector('title');
  if (existingTitle) {
    existingTitle.remove();
  }

  const headPrefix =
    `<meta charset="UTF-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${SNAPSHOT_DEFENSIVE_CSP}">` +
    `<title>${escapeHtmlText(sourceTitle)}</title>` +
    `<link rel="stylesheet" href="styles/snapshot.css">`;

  const bodyEl = sanitizedDoc.querySelector('body');
  const bodyAttrs = bodyEl
    ? Array.from(bodyEl.attributes)
        .map((a) => ` ${a.name}="${escapeHtmlText(a.value)}"`)
        .join('')
    : '';
  const bodyHtml = bodyEl ? bodyEl.innerHTML : sanitizedDoc.innerHTML;
  const htmlLang = sanitizedDoc.getAttribute('lang');
  const htmlOpenTag = htmlLang ? `<html lang="${escapeHtmlText(htmlLang)}">` : '<html>';
  const remainingHeadHtml = headEl.innerHTML;

  const sanitizedHtmlTemplate = `<!DOCTYPE html>\n${htmlOpenTag}<head>${headPrefix}${remainingHeadHtml}</head><body${bodyAttrs}>${bodyHtml}</body></html>\n`;

  return {
    baseHref,
    sourceTitle,
    sanitizedHtmlTemplate,
    cssBlocks,
    candidateAssetUrls: Array.from(candidateAssets.entries()).map(([url, context]) => ({
      url,
      context,
    })),
    missingResources,
    cssFidelity: {
      accessibleStylesheetRulesCount: accessibleRulesCount,
      inaccessibleStylesheetsCount: frameAndSheetReport.inaccessibleStylesheets.length,
      usedComputedStyleFallback: usedComputedFallback,
      fidelityNote: usedComputedFallback
        ? 'Includes viewport-specific computed-style fallback rules where original cross-origin stylesheets were inaccessible.'
        : 'All stylesheet rules were extracted directly from accessible CSSOM stylesheets.',
    },
  };
}

export async function finalizeStaticPageClone(
  prepared: ClonePagePreparedPayload,
  options: ClonePageOptions = {},
): Promise<ClonePageSnapshotResult> {
  const maxAssetCount = options.maxAssetCount ?? 100;
  const maxSingleAssetBytes = options.maxSingleAssetBytes ?? 5 * 1024 * 1024;
  const maxTotalArchiveBytes = options.maxTotalArchiveBytes ?? 25 * 1024 * 1024;

  checkAborted(options.signal);
  options.onProgress?.({
    phase: 'downloading_assets',
    percent: 65,
    message: 'Fetching accessible static assets',
  });

  const zipFiles: Record<string, Uint8Array> = {};
  const usedFilenames = new Set<string>();
  const urlToLocalPath = new Map<string, string>();
  const rewrittenAssets: Array<{ originalUrl: string; archivePath: string; byteLength: number }> =
    [];
  const missingResources: ClonePageMissingResource[] = [...prepared.missingResources];
  const residualRemoteResources = new Set<string>();
  let totalBytes = 0;

  const assetEntries = prepared.candidateAssetUrls.slice(0, maxAssetCount);
  for (const asset of assetEntries) {
    checkAborted(options.signal);
    if (!options.fetcher) {
      missingResources.push({
        url: asset.url,
        context: asset.context,
        reason: 'Static offline mode without asset fetcher; resource not bundled',
      });
      residualRemoteResources.add(asset.url);
      continue;
    }

    const fetched = await options.fetcher(asset.url);
    if (!fetched.ok || !fetched.bytes) {
      missingResources.push({
        url: asset.url,
        context: asset.context,
        reason: fetched.reason ?? 'Asset fetch failed or blocked by status/CORS',
      });
      residualRemoteResources.add(asset.url);
      continue;
    }

    if (fetched.bytes.byteLength > maxSingleAssetBytes) {
      missingResources.push({
        url: asset.url,
        context: asset.context,
        reason: `Asset size (${fetched.bytes.byteLength} bytes) exceeds per-asset limit (${maxSingleAssetBytes} bytes)`,
      });
      residualRemoteResources.add(asset.url);
      continue;
    }

    if (totalBytes + fetched.bytes.byteLength > maxTotalArchiveBytes) {
      missingResources.push({
        url: asset.url,
        context: asset.context,
        reason: `Archive total byte limit (${maxTotalArchiveBytes} bytes) reached`,
      });
      residualRemoteResources.add(asset.url);
      continue;
    }

    const safeName = sanitizeArchiveFilename(
      asset.url,
      'asset',
      'bin',
      usedFilenames,
      fetched.mimeType,
    );
    const archivePath = `assets/${safeName}`;
    zipFiles[archivePath] = fetched.bytes;
    totalBytes += fetched.bytes.byteLength;
    urlToLocalPath.set(asset.url, archivePath);
    rewrittenAssets.push({
      originalUrl: asset.url,
      archivePath,
      byteLength: fetched.bytes.byteLength,
    });
  }

  let htmlContent = prepared.sanitizedHtmlTemplate;
  for (const [originalUrl, archivePath] of urlToLocalPath.entries()) {
    const escapedUrl = originalUrl.replace(/&/g, '&amp;');
    htmlContent = htmlContent.replace(new RegExp(escapeRegExp(escapedUrl), 'g'), archivePath);
    htmlContent = htmlContent.replace(new RegExp(escapeRegExp(originalUrl), 'g'), archivePath);
  }

  const finalCss = prepared.cssBlocks
    .map((block) => rewriteCssAssetUrls(block.cssText, block.baseHref, urlToLocalPath, new Set()))
    .join('\n');

  checkAborted(options.signal);
  options.onProgress?.({
    phase: 'packaging_zip',
    percent: 90,
    message: 'Packaging static HTML/CSS snapshot archive',
  });

  zipFiles['index.html'] = strToU8(htmlContent);
  zipFiles['styles/snapshot.css'] = strToU8(finalCss);

  const residualList = Array.from(residualRemoteResources);
  const isSelfContained = residualList.length === 0 && missingResources.length === 0;

  const manifest: ClonePageManifest = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    sourceTitle: prepared.sourceTitle,
    isSelfContained,
    residualRemoteResources: residualList,
    sanitizationPolicy: {
      sanitizer: 'DOMPurify',
      strippedActiveElements: FORBIDDEN_SNAPSHOT_TAGS,
      defensiveCspApplied: true,
      externalLinksPolicy:
        'External http(s) anchor links are preserved with rel="noopener noreferrer"; scripts, iframes, srcdoc, form actions, and executable URI schemes are removed.',
    },
    cssFidelity: prepared.cssFidelity,
    files: [
      'index.html',
      'styles/snapshot.css',
      ...Object.keys(zipFiles).filter((k) => k.startsWith('assets/')),
      'manifest.json',
    ],
    rewrittenAssets,
    missingResources,
    scopeDisclaimer: isSelfContained
      ? 'Static client-side HTML/CSS snapshot only. Executable scripts, iframes, event handlers, sensitive form values, server backends, and private APIs are intentionally excluded.'
      : 'Static client-side HTML/CSS snapshot only (not fully self-contained; see missingResources and residualRemoteResources). Executable scripts, iframes, event handlers, sensitive form values, server backends, and private APIs are intentionally excluded.',
  };

  zipFiles['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  const zipBytes = zipSync(zipFiles, { level: 6 });

  options.onProgress?.({
    phase: 'packaging_zip',
    percent: 100,
    message: 'Snapshot archive ready',
  });

  return {
    zipBytes,
    htmlContent,
    cssContent: finalCss,
    manifest,
  };
}

export async function exportStaticPageClone(
  doc: Document,
  win: Window,
  options: ClonePageOptions = {},
): Promise<ClonePageSnapshotResult> {
  const prepared = prepareStaticPageClone(doc, win, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  return finalizeStaticPageClone(prepared, options);
}
