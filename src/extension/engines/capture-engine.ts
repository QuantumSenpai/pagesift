import { PAGESIFT_ROOT_ATTR } from './dom-utils.js';

export type CaptureMode = 'visible' | 'area' | 'element' | 'full_page';
export type CaptureExportMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf';

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureAnnotation {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  color: string;
}

export interface CaptureTile {
  tileIndex: number;
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  dataUrl: string;
}

export interface CapturePlan {
  mode: CaptureMode;
  devicePixelRatio: number;
  totalWidthCssPx: number;
  totalHeightCssPx: number;
  truncatedToMaxHeight: boolean;
  cropRectCssPx: CaptureRect;
  tiles: Array<{ scrollX: number; scrollY: number; tileIndex: number }>;
}

export const MAX_CAPTURE_HEIGHT_CSS_PX = 16384;
export const MAX_CAPTURE_TILES = 20;
export const MIN_CAPTURE_INTERVAL_MS = 550;

export function buildCapturePlan(params: {
  mode: CaptureMode;
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
  currentScrollX: number;
  currentScrollY: number;
  devicePixelRatio: number;
  targetRect?: CaptureRect;
}): CapturePlan {
  const vw = Math.max(1, Math.round(params.viewportWidth));
  const vh = Math.max(1, Math.round(params.viewportHeight));
  const dpr = Math.max(1, params.devicePixelRatio || 1);

  if (params.mode === 'visible') {
    return {
      mode: 'visible',
      devicePixelRatio: dpr,
      totalWidthCssPx: vw,
      totalHeightCssPx: vh,
      truncatedToMaxHeight: false,
      cropRectCssPx: { x: 0, y: 0, width: vw, height: vh },
      tiles: [{ scrollX: params.currentScrollX, scrollY: params.currentScrollY, tileIndex: 0 }],
    };
  }

  if (params.mode === 'area' || params.mode === 'element') {
    const raw = params.targetRect ?? { x: 0, y: 0, width: vw, height: vh };
    const x = Math.max(0, Math.min(vw - 1, Math.round(raw.x)));
    const y = Math.max(0, Math.min(vh - 1, Math.round(raw.y)));
    const width = Math.max(1, Math.min(vw - x, Math.round(raw.width)));
    const height = Math.max(1, Math.min(vh - y, Math.round(raw.height)));
    return {
      mode: params.mode,
      devicePixelRatio: dpr,
      totalWidthCssPx: width,
      totalHeightCssPx: height,
      truncatedToMaxHeight: false,
      cropRectCssPx: { x, y, width, height },
      tiles: [{ scrollX: params.currentScrollX, scrollY: params.currentScrollY, tileIndex: 0 }],
    };
  }

  const rawDocHeight = Math.max(vh, Math.round(params.documentHeight));
  const cappedHeight = Math.min(MAX_CAPTURE_HEIGHT_CSS_PX, vh * MAX_CAPTURE_TILES, rawDocHeight);
  const truncatedToMaxHeight = rawDocHeight > cappedHeight;

  const tiles: Array<{ scrollX: number; scrollY: number; tileIndex: number }> = [];
  let offsetY = 0;
  let tileIndex = 0;
  while (offsetY < cappedHeight && tileIndex < MAX_CAPTURE_TILES) {
    const scrollY = Math.min(offsetY, Math.max(0, cappedHeight - vh));
    if (tiles.length === 0 || tiles[tiles.length - 1]?.scrollY !== scrollY) {
      tiles.push({ scrollX: 0, scrollY, tileIndex });
      tileIndex += 1;
    }
    offsetY += vh;
  }

  return {
    mode: 'full_page',
    devicePixelRatio: dpr,
    totalWidthCssPx: vw,
    totalHeightCssPx: cappedHeight,
    truncatedToMaxHeight,
    cropRectCssPx: { x: 0, y: 0, width: vw, height: cappedHeight },
    tiles,
  };
}

export async function executeDomCaptureCoordinator(params: {
  doc: Document;
  win: Window;
  mode: CaptureMode;
  targetRect?: CaptureRect;
  captureViewportTab: () => Promise<string>;
  minIntervalMs?: number;
  lazyWaitMs?: number;
  signal?: AbortSignal;
}): Promise<{
  plan: CapturePlan;
  tiles: CaptureTile[];
  restoredScroll: { scrollX: number; scrollY: number };
  restoredFixedElementsCount: number;
}> {
  const { doc, win, mode, targetRect, captureViewportTab, signal } = params;
  const minIntervalMs = params.minIntervalMs ?? MIN_CAPTURE_INTERVAL_MS;
  const lazyWaitMs = Math.min(400, Math.max(0, params.lazyWaitMs ?? 50));

  const originalScrollX = win.scrollX;
  const originalScrollY = win.scrollY;

  const pageSiftNodes = Array.from(
    doc.querySelectorAll<HTMLElement>(`[${PAGESIFT_ROOT_ATTR}], #pagesift-root-host`),
  );
  const savedPageSiftVisibility = pageSiftNodes.map((el) => ({
    el,
    visibility: el.style.getPropertyValue('visibility'),
    priority: el.style.getPropertyPriority('visibility'),
  }));

  const fixedOrStickySaved: Array<{
    el: HTMLElement;
    visibility: string;
    priority: string;
  }> = [];

  const plan = buildCapturePlan({
    mode,
    viewportWidth: win.innerWidth || 1280,
    viewportHeight: win.innerHeight || 800,
    documentWidth: Math.max(
      doc.documentElement.scrollWidth || 0,
      doc.body.scrollWidth || 0,
      win.innerWidth || 1280,
    ),
    documentHeight: Math.max(
      doc.documentElement.scrollHeight || 0,
      doc.body.scrollHeight || 0,
      win.innerHeight || 800,
    ),
    currentScrollX: originalScrollX,
    currentScrollY: originalScrollY,
    devicePixelRatio: win.devicePixelRatio || 1,
    ...(targetRect ? { targetRect } : {}),
  });

  const capturedTiles: CaptureTile[] = [];
  let lastCaptureTime = 0;

  try {
    for (const item of savedPageSiftVisibility) {
      item.el.style.setProperty('visibility', 'hidden', 'important');
    }

    if (plan.tiles.length > 1) {
      const allElements = Array.from(doc.querySelectorAll('*'));
      for (const node of allElements) {
        if (!('style' in node) || node.hasAttribute(PAGESIFT_ROOT_ATTR)) {
          continue;
        }
        const htmlNode = node as HTMLElement;
        const pos = win.getComputedStyle(htmlNode).position;
        if (pos === 'fixed' || pos === 'sticky') {
          fixedOrStickySaved.push({
            el: htmlNode,
            visibility: htmlNode.style.getPropertyValue('visibility'),
            priority: htmlNode.style.getPropertyPriority('visibility'),
          });
        }
      }
    }

    for (const tileSpec of plan.tiles) {
      if (signal?.aborted) {
        throw new Error('Capture cancelled by user');
      }

      if (plan.tiles.length > 1) {
        win.scrollTo(tileSpec.scrollX, tileSpec.scrollY);
      }

      if (tileSpec.tileIndex > 0) {
        for (const fixedItem of fixedOrStickySaved) {
          fixedItem.el.style.setProperty('visibility', 'hidden', 'important');
        }
      }

      if (lazyWaitMs > 0) {
        await new Promise((r) => setTimeout(r, lazyWaitMs));
      }

      const elapsed = Date.now() - lastCaptureTime;
      if (lastCaptureTime > 0 && elapsed < minIntervalMs) {
        await new Promise((r) => setTimeout(r, minIntervalMs - elapsed));
      }

      if (signal?.aborted) {
        throw new Error('Capture cancelled by user');
      }

      const dataUrl = await captureViewportTab();
      lastCaptureTime = Date.now();

      capturedTiles.push({
        tileIndex: tileSpec.tileIndex,
        scrollX: tileSpec.scrollX,
        scrollY: tileSpec.scrollY,
        viewportWidth: win.innerWidth || 1280,
        viewportHeight: win.innerHeight || 800,
        devicePixelRatio: plan.devicePixelRatio,
        dataUrl,
      });
    }
  } finally {
    for (const fixedItem of fixedOrStickySaved) {
      if (fixedItem.visibility) {
        fixedItem.el.style.setProperty('visibility', fixedItem.visibility, fixedItem.priority);
      } else {
        fixedItem.el.style.removeProperty('visibility');
      }
    }

    for (const item of savedPageSiftVisibility) {
      if (item.visibility) {
        item.el.style.setProperty('visibility', item.visibility, item.priority);
      } else {
        item.el.style.removeProperty('visibility');
      }
    }

    win.scrollTo(originalScrollX, originalScrollY);
  }

  return {
    plan,
    tiles: capturedTiles,
    restoredScroll: { scrollX: win.scrollX, scrollY: win.scrollY },
    restoredFixedElementsCount: fixedOrStickySaved.length,
  };
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodeBytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

export function verifyCaptureBinaryAndDimensions(dataUrl: string): {
  valid: boolean;
  mimeType: CaptureExportMime;
  width: number;
  height: number;
  byteLength: number;
} {
  const match =
    /^data:(image\/png|image\/jpeg|image\/webp|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(
      dataUrl.trim(),
    );
  if (!match) {
    throw new Error('Data URL does not match a valid base64 PNG, JPEG, WebP, or PDF format');
  }

  const declaredMime = match[1] as CaptureExportMime;
  const bytes = decodeBase64ToBytes(match[2] ?? '');

  if (declaredMime === 'image/png') {
    if (
      bytes.byteLength < 24 ||
      bytes[0] !== 0x89 ||
      bytes[1] !== 0x50 ||
      bytes[2] !== 0x4e ||
      bytes[3] !== 0x47
    ) {
      throw new Error('Invalid PNG binary signature');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    return { valid: true, mimeType: 'image/png', width, height, byteLength: bytes.byteLength };
  }

  if (declaredMime === 'image/jpeg') {
    if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      throw new Error('Invalid JPEG binary signature');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2;
    while (offset + 8 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        const height = view.getUint16(offset + 5, false);
        const width = view.getUint16(offset + 7, false);
        return {
          valid: true,
          mimeType: 'image/jpeg',
          width,
          height,
          byteLength: bytes.byteLength,
        };
      }
      const segLength = view.getUint16(offset + 2, false);
      if (segLength < 2) {
        break;
      }
      offset += 2 + segLength;
    }
    throw new Error('Unable to locate SOF dimensions in JPEG stream');
  }

  if (declaredMime === 'image/webp') {
    if (
      bytes.byteLength < 30 ||
      bytes[0] !== 0x52 ||
      bytes[1] !== 0x49 ||
      bytes[2] !== 0x46 ||
      bytes[3] !== 0x46 ||
      bytes[8] !== 0x57 ||
      bytes[9] !== 0x45 ||
      bytes[10] !== 0x42 ||
      bytes[11] !== 0x50
    ) {
      throw new Error('Invalid WebP RIFF/WEBP signature');
    }
    const chunkTag = String.fromCharCode(
      bytes[12] ?? 0,
      bytes[13] ?? 0,
      bytes[14] ?? 0,
      bytes[15] ?? 0,
    );
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (chunkTag === 'VP8 ') {
      const width = view.getUint16(26, true) & 0x3fff;
      const height = view.getUint16(28, true) & 0x3fff;
      return { valid: true, mimeType: 'image/webp', width, height, byteLength: bytes.byteLength };
    }
    if (chunkTag === 'VP8L') {
      const bits = view.getUint32(21, true);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { valid: true, mimeType: 'image/webp', width, height, byteLength: bytes.byteLength };
    }
    if (chunkTag === 'VP8X') {
      const width = 1 + ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16));
      const height = 1 + ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16));
      return { valid: true, mimeType: 'image/webp', width, height, byteLength: bytes.byteLength };
    }
    throw new Error(`Unsupported WebP chunk format: ${chunkTag}`);
  }

  const pdfText = new TextDecoder('latin1').decode(bytes);
  if (!pdfText.startsWith('%PDF-1.4') || !pdfText.includes('%%EOF')) {
    throw new Error('Invalid PDF 1.4 binary structure');
  }
  const mediaBoxMatch = /\/MediaBox\s*\[\s*0\s+0\s+(\d+)\s+(\d+)\s*\]/.exec(pdfText);
  const width = Number.parseInt(mediaBoxMatch?.[1] ?? '0', 10);
  const height = Number.parseInt(mediaBoxMatch?.[2] ?? '0', 10);
  if (width <= 0 || height <= 0) {
    throw new Error('PDF is missing valid /MediaBox dimensions');
  }
  return { valid: true, mimeType: 'application/pdf', width, height, byteLength: bytes.byteLength };
}

export function buildPdfDocumentFromCapture(params: {
  width: number;
  height: number;
  title: string;
  pageUrl: string;
  jpegDataUrl?: string;
}): string {
  const width = Math.max(1, Math.round(params.width));
  const height = Math.max(1, Math.round(params.height));
  const safeTitle = params.title.replace(/[()\\]/g, '');

  const objects: string[] = [];
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj');
  objects.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj');

  const contentStream = `q\n${width} 0 0 ${height} 0 0 cm\nQ\nBT\n/F1 12 Tf\n24 ${Math.max(24, height - 36)} Td\n(PageSift Capture: ${safeTitle}) Tj\nET`;
  objects.push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj`,
  );
  objects.push(
    `4 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream\nendobj`,
  );
  objects.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj');

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += `${obj}\n`;
  }

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i += 1) {
    const off = String(offsets[i] ?? 0).padStart(10, '0');
    pdf += `${off} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  const bytes = new TextEncoder().encode(pdf);
  return `data:application/pdf;base64,${encodeBytesToBase64(bytes)}`;
}
