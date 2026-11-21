import { strToU8, zipSync } from 'fflate';
import {
  collectDocumentElements,
  inspectFramesAndStylesheets,
  isPageSiftElement,
} from './dom-utils.js';

export type AssetKind = 'image' | 'svg' | 'icon' | 'background' | 'video' | 'poster' | 'font';

export type AssetAvailabilityStatus =
  | 'inline_available'
  | 'http_reference'
  | 'streaming_or_blob_unavailable'
  | 'protected_or_invalid';

export interface DiscoveredAssetEntry {
  id: string;
  kind: AssetKind;
  url: string;
  safeFilename: string;
  mimeTypeHint: string;
  width: number | null;
  height: number | null;
  altText: string | null;
  availabilityStatus: AssetAvailabilityStatus;
  statusNote: string;
  safeSvgPreview: string | null;
}

export interface AssetExtractionReport {
  assets: DiscoveredAssetEntry[];
  summary: {
    totalDiscovered: number;
    inlineAvailableCount: number;
    httpReferenceCount: number;
    unavailableOrProtectedCount: number;
  };
  diagnostics: {
    inaccessibleStylesheets: string[];
  };
}

export interface AssetBinaryFetchResult {
  ok: boolean;
  bytes?: Uint8Array;
  mimeType?: string;
  reason?: string;
}

export type AssetBinaryFetcher = (url: string) => Promise<AssetBinaryFetchResult>;

export function sanitizeArchiveFilename(
  rawInput: string,
  fallbackBase: string,
  defaultExt: string,
  usedNames: Set<string>,
): string {
  let candidateBase = rawInput.trim();
  try {
    if (candidateBase.startsWith('http://') || candidateBase.startsWith('https://')) {
      const parsed = new URL(candidateBase);
      const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
      candidateBase = segments[segments.length - 1] ?? fallbackBase;
    }
  } catch {
    candidateBase = fallbackBase;
  }

  candidateBase = Array.from(candidateBase)
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join('')
    .replace(/\.\./g, '')
    .replace(/[/\\?%*:|"<>#]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!candidateBase || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(candidateBase)) {
    candidateBase = fallbackBase;
  }

  let ext = defaultExt;
  let stem = candidateBase;
  const dotIdx = candidateBase.lastIndexOf('.');
  if (dotIdx > 0 && dotIdx < candidateBase.length - 1) {
    const potentialExt = candidateBase.slice(dotIdx + 1).toLowerCase();
    if (/^[a-z0-9]{2,6}$/.test(potentialExt)) {
      ext = potentialExt;
      stem = candidateBase.slice(0, dotIdx);
    }
  }

  stem = stem.slice(0, 64) || fallbackBase;
  let finalName = `${stem}.${ext}`;
  let counter = 1;
  while (usedNames.has(finalName.toLowerCase())) {
    finalName = `${stem}-${counter}.${ext}`;
    counter += 1;
  }
  usedNames.add(finalName.toLowerCase());
  return finalName;
}

export function sanitizeInlineSvgMarkup(svgEl: Element): string {
  const clone = svgEl.cloneNode(true) as Element;
  const dangerous = clone.querySelectorAll('script, foreignObject, iframe, object, embed');
  for (const node of Array.from(dangerous)) {
    node.remove();
  }

  const allNodes = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (const node of allNodes) {
    for (const attr of Array.from(node.attributes)) {
      const nameLower = attr.name.toLowerCase();
      const valLower = attr.value.trim().toLowerCase();
      if (nameLower.startsWith('on')) {
        node.removeAttribute(attr.name);
      } else if (
        (nameLower === 'href' || nameLower === 'xlink:href' || nameLower === 'src') &&
        (valLower.startsWith('javascript:') ||
          valLower.startsWith('vbscript:') ||
          valLower.startsWith('data:text/html'))
      ) {
        node.removeAttribute(attr.name);
      }
    }
  }

  if (!clone.hasAttribute('xmlns')) {
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }
  return clone.outerHTML;
}

function classifyUrlReference(
  rawUrl: string,
  baseHref: string,
): {
  resolvedUrl: string;
  availabilityStatus: AssetAvailabilityStatus;
  statusNote: string;
} {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return {
      resolvedUrl: '',
      availabilityStatus: 'protected_or_invalid',
      statusNote: 'Empty asset URL',
    };
  }
  if (
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('mediasource:') ||
    trimmed.endsWith('.m3u8') ||
    trimmed.endsWith('.mpd')
  ) {
    return {
      resolvedUrl: trimmed,
      availabilityStatus: 'streaming_or_blob_unavailable',
      statusNote: 'Streaming or browser-bound blob URL cannot be downloaded as a static file',
    };
  }
  if (trimmed.startsWith('data:image/svg+xml')) {
    return {
      resolvedUrl: trimmed,
      availabilityStatus: 'inline_available',
      statusNote: 'Inline data URI SVG',
    };
  }
  if (trimmed.startsWith('data:')) {
    return {
      resolvedUrl: trimmed.slice(0, 128),
      availabilityStatus: 'inline_available',
      statusNote: 'Inline data URI asset',
    };
  }
  try {
    const resolved = new URL(trimmed, baseHref);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return {
        resolvedUrl: resolved.toString(),
        availabilityStatus: 'protected_or_invalid',
        statusNote: `Unsupported URL protocol ${resolved.protocol}`,
      };
    }
    return {
      resolvedUrl: resolved.toString(),
      availabilityStatus: 'http_reference',
      statusNote: 'Discovered HTTP(S) reference; byte access depends on CORS/auth policy',
    };
  } catch {
    return {
      resolvedUrl: trimmed,
      availabilityStatus: 'protected_or_invalid',
      statusNote: 'Malformed URL reference',
    };
  }
}

function parseSrcsetUrls(srcsetValue: string): string[] {
  return srcsetValue
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0] ?? '')
    .filter((u) => u.length > 0);
}

function inferMimeTypeHint(url: string, kind: AssetKind): string {
  const lower = url.toLowerCase();
  if (kind === 'svg' || lower.endsWith('.svg')) {
    return 'image/svg+xml';
  }
  if (lower.endsWith('.png')) {
    return 'image/png';
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp';
  }
  if (lower.endsWith('.gif')) {
    return 'image/gif';
  }
  if (lower.endsWith('.avif')) {
    return 'image/avif';
  }
  if (lower.endsWith('.ico')) {
    return 'image/x-icon';
  }
  if (lower.endsWith('.woff2')) {
    return 'font/woff2';
  }
  if (lower.endsWith('.woff')) {
    return 'font/woff';
  }
  if (lower.endsWith('.ttf')) {
    return 'font/ttf';
  }
  if (lower.endsWith('.mp4')) {
    return 'video/mp4';
  }
  if (lower.endsWith('.webm')) {
    return 'video/webm';
  }
  if (kind === 'font') {
    return 'font/woff2';
  }
  if (kind === 'video') {
    return 'video/mp4';
  }
  return 'image/png';
}

function defaultExtForKind(kind: AssetKind, url: string): string {
  const mime = inferMimeTypeHint(url, kind);
  const map: Record<string, string> = {
    'image/svg+xml': 'svg',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'image/x-icon': 'ico',
    'font/woff2': 'woff2',
    'font/woff': 'woff',
    'font/ttf': 'ttf',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
  };
  return map[mime] ?? 'bin';
}

export function extractPageAssets(doc: Document, win: Window): AssetExtractionReport {
  const baseHref = doc.location.href || 'https://localhost/';
  const { entries } = collectDocumentElements(doc, 1500);
  const frameAndSheetReport = inspectFramesAndStylesheets(doc);
  const usedFilenames = new Set<string>();
  const seenKeys = new Set<string>();
  const assets: DiscoveredAssetEntry[] = [];

  const addDiscoveredUrl = (params: {
    kind: AssetKind;
    rawUrl: string;
    width?: number | null;
    height?: number | null;
    altText?: string | null;
  }): void => {
    const classified = classifyUrlReference(params.rawUrl, baseHref);
    if (!classified.resolvedUrl) {
      return;
    }
    const dedupeKey = `${params.kind}|${classified.resolvedUrl}`;
    if (seenKeys.has(dedupeKey)) {
      return;
    }
    seenKeys.add(dedupeKey);

    const id = `asset-${assets.length + 1}`;
    const ext = defaultExtForKind(params.kind, classified.resolvedUrl);
    const safeFilename = sanitizeArchiveFilename(
      classified.resolvedUrl,
      `${params.kind}-${assets.length + 1}`,
      ext,
      usedFilenames,
    );

    assets.push({
      id,
      kind: params.kind,
      url: classified.resolvedUrl,
      safeFilename,
      mimeTypeHint: inferMimeTypeHint(classified.resolvedUrl, params.kind),
      width: params.width ?? null,
      height: params.height ?? null,
      altText: params.altText ?? null,
      availabilityStatus: classified.availabilityStatus,
      statusNote: classified.statusNote,
      safeSvgPreview: null,
    });
  };

  for (const link of Array.from(doc.querySelectorAll('link[rel]'))) {
    if (isPageSiftElement(link)) {
      continue;
    }
    const rel = (link.getAttribute('rel') ?? '').toLowerCase();
    const href = link.getAttribute('href');
    if (href && (rel.includes('icon') || rel.includes('apple-touch-icon'))) {
      addDiscoveredUrl({ kind: 'icon', rawUrl: href });
    }
  }

  let inlineSvgCounter = 0;
  for (const { element } of entries) {
    const tag = element.tagName.toLowerCase();

    if (tag === 'img') {
      const img = element as HTMLImageElement;
      const src =
        img.getAttribute('src') ??
        img.getAttribute('data-src') ??
        img.getAttribute('data-lazy-src');
      const width = img.naturalWidth || img.width || null;
      const height = img.naturalHeight || img.height || null;
      const alt = img.getAttribute('alt');
      if (src) {
        addDiscoveredUrl({
          kind: src.toLowerCase().endsWith('.svg') ? 'svg' : 'image',
          rawUrl: src,
          width,
          height,
          altText: alt,
        });
      }
      const srcset = img.getAttribute('srcset') ?? img.getAttribute('data-srcset');
      if (srcset) {
        for (const candidateUrl of parseSrcsetUrls(srcset)) {
          addDiscoveredUrl({ kind: 'image', rawUrl: candidateUrl, altText: alt });
        }
      }
    } else if (tag === 'source') {
      const parentTag = element.parentElement?.tagName.toLowerCase();
      const srcset = element.getAttribute('srcset');
      const src = element.getAttribute('src');
      if (srcset) {
        for (const candidateUrl of parseSrcsetUrls(srcset)) {
          addDiscoveredUrl({ kind: 'image', rawUrl: candidateUrl });
        }
      }
      if (src && parentTag === 'video') {
        addDiscoveredUrl({ kind: 'video', rawUrl: src });
      }
    } else if (tag === 'video') {
      const video = element as HTMLVideoElement;
      const src = video.getAttribute('src');
      const poster = video.getAttribute('poster');
      if (src) {
        addDiscoveredUrl({
          kind: 'video',
          rawUrl: src,
          width: video.videoWidth || null,
          height: video.videoHeight || null,
        });
      }
      if (poster) {
        addDiscoveredUrl({ kind: 'poster', rawUrl: poster });
      }
    } else if (tag === 'svg') {
      const parentSvg = element.parentElement?.closest('svg');
      if (!parentSvg) {
        inlineSvgCounter += 1;
        const safeSvg = sanitizeInlineSvgMarkup(element);
        const rect = element.getBoundingClientRect();
        const id = `asset-${assets.length + 1}`;
        const safeFilename = sanitizeArchiveFilename(
          element.id || `inline-svg-${inlineSvgCounter}`,
          `inline-svg-${inlineSvgCounter}`,
          'svg',
          usedFilenames,
        );
        assets.push({
          id,
          kind: 'svg',
          url: `inline://svg/${inlineSvgCounter}`,
          safeFilename,
          mimeTypeHint: 'image/svg+xml',
          width: rect.width > 0 ? Math.round(rect.width) : null,
          height: rect.height > 0 ? Math.round(rect.height) : null,
          altText: element.getAttribute('aria-label'),
          availabilityStatus: 'inline_available',
          statusNote: 'Inline DOM SVG element serialized and sanitized',
          safeSvgPreview: safeSvg,
        });
      }
    }

    const computed = win.getComputedStyle(element);
    const bgImage = computed.backgroundImage;
    if (bgImage && bgImage !== 'none') {
      const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
      let match = urlRegex.exec(bgImage);
      while (match) {
        const extractedUrl = match[2]?.trim() ?? '';
        if (extractedUrl && !extractedUrl.startsWith('data:')) {
          addDiscoveredUrl({ kind: 'background', rawUrl: extractedUrl });
        }
        match = urlRegex.exec(bgImage);
      }
    }
  }

  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (rule.cssText.trim().toLowerCase().startsWith('@font-face') && 'style' in rule) {
        const fontRule = rule as CSSFontFaceRule;
        const src = fontRule.style.getPropertyValue('src');
        const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
        let match = urlRegex.exec(src);
        while (match) {
          const fontUrl = match[2]?.trim() ?? '';
          if (fontUrl) {
            addDiscoveredUrl({ kind: 'font', rawUrl: fontUrl });
          }
          match = urlRegex.exec(src);
        }
      }
    }
  }

  const inlineAvailableCount = assets.filter(
    (a) => a.availabilityStatus === 'inline_available',
  ).length;
  const httpReferenceCount = assets.filter((a) => a.availabilityStatus === 'http_reference').length;
  const unavailableOrProtectedCount = assets.length - inlineAvailableCount - httpReferenceCount;

  return {
    assets,
    summary: {
      totalDiscovered: assets.length,
      inlineAvailableCount,
      httpReferenceCount,
      unavailableOrProtectedCount,
    },
    diagnostics: {
      inaccessibleStylesheets: frameAndSheetReport.inaccessibleStylesheets,
    },
  };
}

export async function buildAssetsZipArchive(
  report: AssetExtractionReport,
  fetcher?: AssetBinaryFetcher,
  options?: {
    maxTotalBytes?: number;
    maxAssetCount?: number;
  },
): Promise<{
  zipBytes: Uint8Array;
  packagedFilesCount: number;
  skippedOrUnavailable: Array<{ id: string; url: string; reason: string }>;
}> {
  const maxTotalBytes = options?.maxTotalBytes ?? 25 * 1024 * 1024;
  const maxAssetCount = options?.maxAssetCount ?? 150;
  const zipEntries: Record<string, Uint8Array> = {};
  const skippedOrUnavailable: Array<{ id: string; url: string; reason: string }> = [];
  let runningBytes = 0;
  let packagedFilesCount = 0;

  for (const asset of report.assets.slice(0, maxAssetCount)) {
    if (asset.safeSvgPreview) {
      const svgBytes = strToU8(asset.safeSvgPreview);
      if (runningBytes + svgBytes.byteLength <= maxTotalBytes) {
        zipEntries[`assets/${asset.safeFilename}`] = svgBytes;
        runningBytes += svgBytes.byteLength;
        packagedFilesCount += 1;
      } else {
        skippedOrUnavailable.push({
          id: asset.id,
          url: asset.url,
          reason: 'Archive byte limit reached',
        });
      }
      continue;
    }

    if (asset.availabilityStatus !== 'http_reference') {
      skippedOrUnavailable.push({
        id: asset.id,
        url: asset.url,
        reason: asset.statusNote,
      });
      continue;
    }

    if (!fetcher) {
      skippedOrUnavailable.push({
        id: asset.id,
        url: asset.url,
        reason: 'External HTTP reference recorded in manifest without binary fetcher',
      });
      continue;
    }

    const fetched = await fetcher(asset.url);
    if (!fetched.ok || !fetched.bytes) {
      skippedOrUnavailable.push({
        id: asset.id,
        url: asset.url,
        reason: fetched.reason ?? 'Resource unavailable or protected by CORS/authentication',
      });
      continue;
    }

    if (runningBytes + fetched.bytes.byteLength > maxTotalBytes) {
      skippedOrUnavailable.push({
        id: asset.id,
        url: asset.url,
        reason: 'Archive byte limit reached',
      });
      continue;
    }

    zipEntries[`assets/${asset.safeFilename}`] = fetched.bytes;
    runningBytes += fetched.bytes.byteLength;
    packagedFilesCount += 1;
  }

  const manifestDoc = {
    generatedAt: new Date().toISOString(),
    summary: report.summary,
    packagedFilesCount,
    assets: report.assets.map((a) => ({
      id: a.id,
      kind: a.kind,
      url: a.url,
      safeFilename: a.safeFilename,
      mimeTypeHint: a.mimeTypeHint,
      width: a.width,
      height: a.height,
      availabilityStatus: a.availabilityStatus,
      statusNote: a.statusNote,
    })),
    skippedOrUnavailable,
  };

  zipEntries['assets-manifest.json'] = strToU8(JSON.stringify(manifestDoc, null, 2));

  return {
    zipBytes: zipSync(zipEntries, { level: 6 }),
    packagedFilesCount,
    skippedOrUnavailable,
  };
}
