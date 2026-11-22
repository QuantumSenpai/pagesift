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
  actualScrollX: number;
  actualScrollY: number;
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
export const MAX_CAPTURE_CANVAS_DIM_PX = 32768;
export const MAX_WEBP_DIMENSION_PX = 16383;
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
  const maxCssHeightForCanvas = Math.floor(MAX_CAPTURE_CANVAS_DIM_PX / dpr);
  const cappedHeight = Math.min(
    MAX_CAPTURE_HEIGHT_CSS_PX,
    maxCssHeightForCanvas,
    vh * MAX_CAPTURE_TILES,
    rawDocHeight,
  );
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
  nestedScrollDetected: boolean;
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
  let nestedScrollDetected = false;

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

      const actualScrollX = win.scrollX;
      const actualScrollY = win.scrollY;
      const previousTile = capturedTiles[capturedTiles.length - 1];
      if (
        tileSpec.tileIndex > 0 &&
        previousTile &&
        actualScrollY <= previousTile.actualScrollY &&
        tileSpec.scrollY > previousTile.scrollY
      ) {
        nestedScrollDetected = true;
        break;
      }

      const elapsed = Date.now() - lastCaptureTime;
      if (lastCaptureTime > 0 && elapsed < minIntervalMs) {
        await new Promise((r) => setTimeout(r, minIntervalMs - elapsed));
      }

      if (signal?.aborted) {
        throw new Error('Capture cancelled by user');
      }

      const dataUrl = await captureViewportTab();
      if (!dataUrl || !dataUrl.startsWith('data:image/')) {
        throw new Error('Tab capture returned empty or invalid image data');
      }
      lastCaptureTime = Date.now();

      capturedTiles.push({
        tileIndex: tileSpec.tileIndex,
        scrollX: tileSpec.scrollX,
        scrollY: tileSpec.scrollY,
        actualScrollX,
        actualScrollY,
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
    nestedScrollDetected,
  };
}

export function decodeBase64ToBytes(base64: string): Uint8Array {
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

export function encodeBytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength));
    let part = '';
    for (let j = 0; j < slice.byteLength; j += 1) {
      part += String.fromCharCode(slice[j] ?? 0);
    }
    binary += part;
  }
  return btoa(binary);
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1 || !dataUrl.startsWith('data:')) {
    throw new Error('Invalid data URL');
  }
  const header = dataUrl.slice(5, commaIdx);
  const mime = header.split(';')[0] || 'application/octet-stream';
  const bytes = decodeBase64ToBytes(dataUrl.slice(commaIdx + 1));
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return Promise.resolve(new Blob([copy], { type: mime }));
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  return `data:${blob.type || 'application/octet-stream'};base64,${encodeBytesToBase64(bytes)}`;
}

export async function composeCaptureFromTiles(params: {
  tiles: CaptureTile[];
  plan: CapturePlan;
  exportMime: CaptureExportMime;
  cropRect?: CaptureRect;
  annotations?: CaptureAnnotation[];
  title: string;
  pageUrl: string;
  quality?: number;
}): Promise<{
  dataUrl: string;
  previewPngDataUrl?: string;
  width: number;
  height: number;
  mimeType: CaptureExportMime;
}> {
  const { tiles, plan, exportMime, cropRect, annotations, title, pageUrl } = params;
  if (tiles.length === 0) {
    throw new Error('No captured image tiles available to compose');
  }
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    throw new Error('OffscreenCanvas and createImageBitmap are required for image composition');
  }

  const bitmaps: Array<{ tile: CaptureTile; bitmap: ImageBitmap }> = [];
  try {
    for (const tile of tiles) {
      const blob = await dataUrlToBlob(tile.dataUrl);
      const bitmap = await createImageBitmap(blob);
      bitmaps.push({ tile, bitmap });
    }

    const first = bitmaps[0];
    if (!first) {
      throw new Error('Failed to decode first capture tile');
    }

    const scaleX = first.bitmap.width / Math.max(1, first.tile.viewportWidth);
    const scaleY = first.bitmap.height / Math.max(1, first.tile.viewportHeight);

    let fullCanvasWidthPx: number;
    let fullCanvasHeightPx: number;
    let stitchedCanvas: OffscreenCanvas;

    if (tiles.length === 1) {
      fullCanvasWidthPx = first.bitmap.width;
      fullCanvasHeightPx = first.bitmap.height;
      stitchedCanvas = new OffscreenCanvas(fullCanvasWidthPx, fullCanvasHeightPx);
      const ctx = stitchedCanvas.getContext('2d');
      if (!ctx) {
        throw new Error('Failed to acquire 2D context for capture composition');
      }
      ctx.drawImage(first.bitmap, 0, 0);
    } else {
      const last = bitmaps[bitmaps.length - 1];
      const measuredCssHeight = last
        ? Math.min(plan.totalHeightCssPx, last.tile.actualScrollY + last.tile.viewportHeight)
        : plan.totalHeightCssPx;
      fullCanvasWidthPx = Math.min(
        MAX_CAPTURE_CANVAS_DIM_PX,
        Math.max(1, Math.round(first.tile.viewportWidth * scaleX)),
      );
      fullCanvasHeightPx = Math.min(
        MAX_CAPTURE_CANVAS_DIM_PX,
        Math.max(1, Math.round(measuredCssHeight * scaleY)),
      );
      stitchedCanvas = new OffscreenCanvas(fullCanvasWidthPx, fullCanvasHeightPx);
      const ctx = stitchedCanvas.getContext('2d');
      if (!ctx) {
        throw new Error('Failed to acquire 2D context for full-page stitching');
      }

      let coveredBottomCss = 0;
      for (let i = 0; i < bitmaps.length; i += 1) {
        const current = bitmaps[i];
        if (!current) {
          continue;
        }
        const { tile, bitmap } = current;
        if (i === 0) {
          ctx.drawImage(bitmap, 0, 0);
          coveredBottomCss = tile.actualScrollY + tile.viewportHeight;
        } else {
          const overlapCss = Math.max(0, coveredBottomCss - tile.actualScrollY);
          const srcYPx = Math.min(bitmap.height - 1, Math.round(overlapCss * scaleY));
          const remainingSrcHeightPx = Math.max(1, bitmap.height - srcYPx);
          const destYPx = Math.round(coveredBottomCss * scaleY);
          const drawHeightPx = Math.min(remainingSrcHeightPx, fullCanvasHeightPx - destYPx);
          if (drawHeightPx > 0) {
            ctx.drawImage(
              bitmap,
              0,
              srcYPx,
              bitmap.width,
              drawHeightPx,
              0,
              destYPx,
              fullCanvasWidthPx,
              drawHeightPx,
            );
          }
          coveredBottomCss = Math.max(coveredBottomCss, tile.actualScrollY + tile.viewportHeight);
        }
      }
    }

    const activeCrop =
      cropRect ??
      (plan.mode === 'area' || plan.mode === 'element' ? plan.cropRectCssPx : undefined);

    let outputCanvas = stitchedCanvas;
    if (activeCrop) {
      const cropX = Math.max(0, Math.min(fullCanvasWidthPx - 1, Math.round(activeCrop.x * scaleX)));
      const cropY = Math.max(
        0,
        Math.min(fullCanvasHeightPx - 1, Math.round(activeCrop.y * scaleY)),
      );
      const cropW = Math.max(
        1,
        Math.min(fullCanvasWidthPx - cropX, Math.round(activeCrop.width * scaleX)),
      );
      const cropH = Math.max(
        1,
        Math.min(fullCanvasHeightPx - cropY, Math.round(activeCrop.height * scaleY)),
      );
      const cropped = new OffscreenCanvas(cropW, cropH);
      const cropCtx = cropped.getContext('2d');
      if (!cropCtx) {
        throw new Error('Failed to acquire 2D context for cropping');
      }
      cropCtx.drawImage(stitchedCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      outputCanvas = cropped;
    }

    if (annotations && annotations.length > 0) {
      const annCtx = outputCanvas.getContext('2d');
      if (annCtx) {
        for (const ann of annotations) {
          const ax = Math.round(ann.x * scaleX);
          const ay = Math.round(ann.y * scaleY);
          const aw = Math.max(2, Math.round(ann.width * scaleX));
          const ah = Math.max(2, Math.round(ann.height * scaleY));
          annCtx.strokeStyle = ann.color;
          annCtx.lineWidth = Math.max(2, Math.round(3 * scaleX));
          annCtx.strokeRect(ax, ay, aw, ah);
          if (ann.label.trim().length > 0) {
            const fontSize = Math.max(12, Math.round(13 * scaleX));
            annCtx.font = `bold ${fontSize}px sans-serif`;
            const textWidth = Math.ceil(annCtx.measureText(ann.label).width);
            const labelHeight = fontSize + Math.round(8 * scaleY);
            const labelY = Math.max(0, ay - labelHeight);
            annCtx.fillStyle = ann.color;
            annCtx.fillRect(ax, labelY, textWidth + Math.round(12 * scaleX), labelHeight);
            annCtx.fillStyle = '#ffffff';
            annCtx.fillText(ann.label, ax + Math.round(6 * scaleX), labelY + fontSize);
          }
        }
      }
    }

    const quality = params.quality ?? 0.92;

    if (
      exportMime === 'image/webp' &&
      (outputCanvas.width > MAX_WEBP_DIMENSION_PX || outputCanvas.height > MAX_WEBP_DIMENSION_PX)
    ) {
      throw new Error(
        `WebP format maximum dimension is ${MAX_WEBP_DIMENSION_PX}px (captured ${outputCanvas.width}×${outputCanvas.height}px); use PNG, JPEG, or PDF`,
      );
    }

    if (exportMime === 'application/pdf') {
      const jpegBlob = await outputCanvas.convertToBlob({ type: 'image/jpeg', quality });
      const jpegDataUrl = await blobToDataUrl(jpegBlob);
      const pngBlob = await outputCanvas.convertToBlob({ type: 'image/png' });
      const previewPngDataUrl = await blobToDataUrl(pngBlob);
      const pdfDataUrl = buildPdfDocumentFromCapture({
        width: outputCanvas.width,
        height: outputCanvas.height,
        title,
        pageUrl,
        jpegDataUrl,
      });
      return {
        dataUrl: pdfDataUrl,
        previewPngDataUrl,
        width: outputCanvas.width,
        height: outputCanvas.height,
        mimeType: 'application/pdf',
      };
    }

    const encodedBlob = await outputCanvas.convertToBlob({
      type: exportMime,
      ...(exportMime === 'image/jpeg' || exportMime === 'image/webp' ? { quality } : {}),
    });
    if (encodedBlob.type !== exportMime) {
      throw new Error(
        `Browser canvas encoder does not support requested format ${exportMime} (returned ${encodedBlob.type})`,
      );
    }
    const dataUrl = await blobToDataUrl(encodedBlob);
    return {
      dataUrl,
      width: outputCanvas.width,
      height: outputCanvas.height,
      mimeType: exportMime,
    };
  } finally {
    for (const item of bitmaps) {
      item.bitmap.close();
    }
  }
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
  if (!pdfText.includes('/Subtype /Image') || !pdfText.includes('/Filter /DCTDecode')) {
    throw new Error('PDF capture is missing embedded raster image stream');
  }
  const mediaBoxMatch = /\/MediaBox\s*\[\s*0\s+0\s+(\d+)\s+(\d+)\s*\]/.exec(pdfText);
  const width = Number.parseInt(mediaBoxMatch?.[1] ?? '0', 10);
  const height = Number.parseInt(mediaBoxMatch?.[2] ?? '0', 10);
  if (width <= 0 || height <= 0) {
    throw new Error('PDF is missing valid /MediaBox dimensions');
  }
  return { valid: true, mimeType: 'application/pdf', width, height, byteLength: bytes.byteLength };
}

function asciiToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i) & 0xff;
  }
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function buildPdfDocumentFromCapture(params: {
  width: number;
  height: number;
  title: string;
  pageUrl: string;
  jpegDataUrl?: string;
}): string {
  if (!params.jpegDataUrl || !params.jpegDataUrl.startsWith('data:image/jpeg;base64,')) {
    throw new Error(
      'PDF screenshot export requires valid captured JPEG image data; text-only PDFs are not allowed',
    );
  }

  const verifiedJpeg = verifyCaptureBinaryAndDimensions(params.jpegDataUrl);
  const jpegBase64 = params.jpegDataUrl.slice('data:image/jpeg;base64,'.length);
  const jpegBytes = decodeBase64ToBytes(jpegBase64);

  const imgWidth = Math.max(1, verifiedJpeg.width || Math.round(params.width));
  const imgHeight = Math.max(1, verifiedJpeg.height || Math.round(params.height));
  const pageWidth = Math.max(1, Math.round(params.width) || imgWidth);
  const pageHeight = Math.max(1, Math.round(params.height) || imgHeight);

  const headerBytes = asciiToBytes('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const obj1 = asciiToBytes('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  const obj2 = asciiToBytes('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  const obj3 = asciiToBytes(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>\nendobj\n`,
  );

  const contentStreamText = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ\n`;
  const obj4 = asciiToBytes(
    `4 0 obj\n<< /Length ${contentStreamText.length} >>\nstream\n${contentStreamText}endstream\nendobj\n`,
  );

  const obj5Prefix = asciiToBytes(
    `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgWidth} /Height ${imgHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.byteLength} >>\nstream\n`,
  );
  const obj5Suffix = asciiToBytes('\nendstream\nendobj\n');
  const obj5 = concatBytes([obj5Prefix, jpegBytes, obj5Suffix]);

  const objects = [obj1, obj2, obj3, obj4, obj5];
  const offsets: number[] = [0];
  let cursor = headerBytes.byteLength;
  for (const obj of objects) {
    offsets.push(cursor);
    cursor += obj.byteLength;
  }

  const xrefOffset = cursor;
  let xrefStr = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    xrefStr += `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  xrefStr += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  const pdfBytes = concatBytes([headerBytes, ...objects, asciiToBytes(xrefStr)]);
  return `data:application/pdf;base64,${encodeBytesToBase64(pdfBytes)}`;
}
