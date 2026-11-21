import { strToU8, zipSync } from 'fflate';
import {
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
  context: 'image' | 'stylesheet' | 'css_url' | 'frame';
  reason: string;
}

export interface ClonePageManifest {
  schemaVersion: 1;
  exportedAt: string;
  sourceTitle: string;
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

export interface ClonePageSnapshotResult {
  zipBytes: Uint8Array;
  htmlContent: string;
  cssContent: string;
  manifest: ClonePageManifest;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Clone page snapshot cancelled by user');
  }
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
      if (
        !trimmed ||
        trimmed.startsWith('data:') ||
        trimmed.startsWith('#') ||
        trimmed.toLowerCase().startsWith('javascript:')
      ) {
        return trimmed.toLowerCase().startsWith('javascript:') ? 'url("")' : fullMatch;
      }

      let resolved: string;
      try {
        resolved = new URL(trimmed, baseHref).toString();
      } catch {
        return fullMatch;
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

export async function exportStaticPageClone(
  doc: Document,
  win: Window,
  options: ClonePageOptions = {},
): Promise<ClonePageSnapshotResult> {
  const maxAssetCount = options.maxAssetCount ?? 100;
  const maxSingleAssetBytes = options.maxSingleAssetBytes ?? 5 * 1024 * 1024;
  const maxTotalArchiveBytes = options.maxTotalArchiveBytes ?? 25 * 1024 * 1024;
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
      reason: 'Cross-origin iframe content cannot be accessed due to browser Same-Origin Policy',
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

  const stripSelectors = [
    'script',
    'noscript',
    'object',
    'embed',
    'applet',
    'base',
    'meta[http-equiv="refresh" i]',
    'meta[http-equiv="content-security-policy" i]',
    'link[rel="preload" i]',
    'link[rel="modulepreload" i]',
    'link[rel="prefetch" i]',
    '[data-pagesift-root]',
    '#pagesift-root-host',
  ];
  for (const node of Array.from(rootClone.querySelectorAll(stripSelectors.join(', ')))) {
    node.remove();
  }

  for (const svg of Array.from(rootClone.querySelectorAll('svg'))) {
    const cleanSvgMarkup = sanitizeInlineSvgMarkup(svg);
    const wrapper = doc.createElement('div');
    wrapper.innerHTML = cleanSvgMarkup;
    const replacement = wrapper.firstElementChild;
    if (replacement) {
      svg.replaceWith(replacement);
    }
  }

  const candidateAssetUrls = new Map<string, { elements: Element[]; attr: string }>();
  const registerAssetUrl = (rawUrl: string, el: Element, attr: string): string | null => {
    const trimmed = rawUrl.trim();
    if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) {
      return null;
    }
    try {
      const resolved = new URL(trimmed, baseHref);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
        return null;
      }
      const urlStr = resolved.toString();
      const existing = candidateAssetUrls.get(urlStr);
      if (existing) {
        existing.elements.push(el);
      } else {
        candidateAssetUrls.set(urlStr, { elements: [el], attr });
      }
      return urlStr;
    } catch {
      return null;
    }
  };

  const allNodes = [rootClone, ...Array.from(rootClone.querySelectorAll('*'))];
  for (const node of allNodes) {
    for (const attr of Array.from(node.attributes)) {
      const nameLower = attr.name.toLowerCase();
      const valTrimmed = attr.value.trim();
      const valLower = valTrimmed.toLowerCase();

      if (nameLower.startsWith('on')) {
        node.removeAttribute(attr.name);
        continue;
      }

      if (
        nameLower === 'href' ||
        nameLower === 'src' ||
        nameLower === 'action' ||
        nameLower === 'formaction' ||
        nameLower === 'poster' ||
        nameLower === 'xlink:href'
      ) {
        if (
          valLower.startsWith('javascript:') ||
          valLower.startsWith('vbscript:') ||
          valLower.startsWith('data:text/html')
        ) {
          node.removeAttribute(attr.name);
          continue;
        }
      }
    }

    const tag = node.tagName.toLowerCase();
    if (tag === 'input') {
      const inputType = (node.getAttribute('type') ?? 'text').toLowerCase();
      const autoComplete = (node.getAttribute('autocomplete') ?? '').toLowerCase();
      if (
        inputType === 'password' ||
        inputType === 'hidden' ||
        inputType === 'email' ||
        inputType === 'tel' ||
        inputType === 'text' ||
        inputType === 'search' ||
        inputType === 'number' ||
        autoComplete.includes('cc-') ||
        autoComplete.includes('password')
      ) {
        node.removeAttribute('value');
        (node as HTMLInputElement).value = '';
      }
    } else if (tag === 'textarea') {
      node.textContent = '';
      (node as HTMLTextAreaElement).value = '';
    } else if (tag === 'form') {
      node.removeAttribute('action');
    } else if (tag === 'img') {
      node.removeAttribute('srcset');
      const src = node.getAttribute('src') ?? node.getAttribute('data-src');
      if (src) {
        const resolved = registerAssetUrl(src, node, 'src');
        if (resolved) {
          node.setAttribute('src', resolved);
        }
      }
    } else if (tag === 'a') {
      const href = node.getAttribute('href');
      if (
        href &&
        !href.startsWith('#') &&
        !href.startsWith('mailto:') &&
        !href.startsWith('tel:')
      ) {
        try {
          node.setAttribute('href', new URL(href, baseHref).toString());
        } catch {
          node.removeAttribute('href');
        }
      }
    } else if (tag === 'link') {
      const rel = (node.getAttribute('rel') ?? '').toLowerCase();
      if (rel === 'stylesheet') {
        node.remove();
      }
    }
  }

  checkAborted(options.signal);
  options.onProgress?.({
    phase: 'collecting_css',
    percent: 40,
    message: 'Extracting accessible CSS rules and computed fallbacks',
  });

  const rawCssChunks: string[] = [];
  let accessibleRulesCount = 0;

  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      accessibleRulesCount += 1;
      rawCssChunks.push(rule.cssText);
    }
  }

  const usedComputedFallback =
    accessibleRulesCount === 0 || frameAndSheetReport.inaccessibleStylesheets.length > 0;
  if (usedComputedFallback) {
    rawCssChunks.push(buildComputedStyleFallbackCss(doc, win));
  }

  const combinedRawCss = rawCssChunks.join('\n');
  const preliminaryCssUrls = new Set<string>();
  rewriteCssAssetUrls(combinedRawCss, baseHref, new Map(), preliminaryCssUrls);

  for (const cssUrl of preliminaryCssUrls) {
    if (!candidateAssetUrls.has(cssUrl)) {
      candidateAssetUrls.set(cssUrl, { elements: [], attr: 'css_url' });
    }
  }

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
  let totalBytes = 0;

  const assetEntries = Array.from(candidateAssetUrls.entries()).slice(0, maxAssetCount);
  for (const [assetUrl, info] of assetEntries) {
    checkAborted(options.signal);
    if (!options.fetcher) {
      missingResources.push({
        url: assetUrl,
        context: info.attr === 'css_url' ? 'css_url' : 'image',
        reason: 'Static offline mode without asset fetcher; preserved resolved absolute URL',
      });
      continue;
    }

    const fetched = await options.fetcher(assetUrl);
    if (!fetched.ok || !fetched.bytes) {
      missingResources.push({
        url: assetUrl,
        context: info.attr === 'css_url' ? 'css_url' : 'image',
        reason: fetched.reason ?? 'Asset fetch failed or blocked by status/CORS',
      });
      continue;
    }

    if (fetched.bytes.byteLength > maxSingleAssetBytes) {
      missingResources.push({
        url: assetUrl,
        context: info.attr === 'css_url' ? 'css_url' : 'image',
        reason: `Asset size (${fetched.bytes.byteLength} bytes) exceeds per-asset limit (${maxSingleAssetBytes} bytes)`,
      });
      continue;
    }

    if (totalBytes + fetched.bytes.byteLength > maxTotalArchiveBytes) {
      missingResources.push({
        url: assetUrl,
        context: info.attr === 'css_url' ? 'css_url' : 'image',
        reason: `Archive total byte limit (${maxTotalArchiveBytes} bytes) reached`,
      });
      continue;
    }

    const safeName = sanitizeArchiveFilename(assetUrl, 'asset', 'bin', usedFilenames);
    const archivePath = `assets/${safeName}`;
    zipFiles[archivePath] = fetched.bytes;
    totalBytes += fetched.bytes.byteLength;
    urlToLocalPath.set(assetUrl, archivePath);
    rewrittenAssets.push({
      originalUrl: assetUrl,
      archivePath,
      byteLength: fetched.bytes.byteLength,
    });

    for (const el of info.elements) {
      el.setAttribute(info.attr, archivePath);
    }
  }

  const finalCss = rewriteCssAssetUrls(combinedRawCss, baseHref, urlToLocalPath, new Set<string>());

  let headEl = rootClone.querySelector('head');
  if (!headEl) {
    headEl = doc.createElement('head');
    rootClone.insertBefore(headEl, rootClone.firstChild);
  }
  const styleLink = doc.createElement('link');
  styleLink.setAttribute('rel', 'stylesheet');
  styleLink.setAttribute('href', 'styles/snapshot.css');
  headEl.appendChild(styleLink);

  const htmlContent = `<!DOCTYPE html>\n${rootClone.outerHTML}\n`;

  checkAborted(options.signal);
  options.onProgress?.({
    phase: 'packaging_zip',
    percent: 90,
    message: 'Packaging static HTML/CSS snapshot archive',
  });

  zipFiles['index.html'] = strToU8(htmlContent);
  zipFiles['styles/snapshot.css'] = strToU8(finalCss);

  const manifest: ClonePageManifest = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    sourceTitle: doc.title.trim() || 'Snapshot',
    cssFidelity: {
      accessibleStylesheetRulesCount: accessibleRulesCount,
      inaccessibleStylesheetsCount: frameAndSheetReport.inaccessibleStylesheets.length,
      usedComputedStyleFallback: usedComputedFallback,
      fidelityNote: usedComputedFallback
        ? 'Includes viewport-specific computed-style fallback rules where original cross-origin stylesheets were inaccessible.'
        : 'All stylesheet rules were extracted directly from accessible CSSOM stylesheets.',
    },
    files: [
      'index.html',
      'styles/snapshot.css',
      ...Object.keys(zipFiles).filter((k) => k.startsWith('assets/')),
      'manifest.json',
    ],
    rewrittenAssets,
    missingResources,
    scopeDisclaimer:
      'Static client-side HTML/CSS snapshot only.Executable scripts, event handlers, sensitive form values, server backends, and private APIs are intentionally excluded.',
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
