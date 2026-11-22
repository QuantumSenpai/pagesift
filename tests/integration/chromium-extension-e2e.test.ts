import { deflateSync, strFromU8, unzipSync } from 'fflate';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium, type BrowserContext, type Download, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyCaptureBinaryAndDimensions } from '../../src/extension/engines/capture-engine.js';
import type { ExtensionMessageResponse } from '../../src/extension/protocol/messages.js';

const ROOT_DIR = process.cwd();
const EXTENSION_DIR = path.join(ROOT_DIR, 'dist', 'extension');

function resolveChromiumExecutablePath(): string | undefined {
  const candidates = [
    path.join(
      os.homedir(),
      'Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ),
    path.join(
      os.homedir(),
      'Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ),
    path.join(
      os.homedir(),
      'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ),
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.byteLength; i += 1) {
    c ^= buf[i] ?? 0;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.byteLength, false);
  for (let i = 0; i < 4; i += 1) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(out.subarray(4, 8 + data.byteLength)), false);
  return out;
}

function buildTestPngBytes(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rowStride = width * 4 + 1;
  const raw = new Uint8Array(rowStride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowStride;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const px = rowStart + 1 + x * 4;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = 255;
    }
  }
  const compressed = deflateSync(raw, { level: 6 });
  let s1 = 1;
  let s2 = 0;
  for (let i = 0; i < raw.byteLength; i += 1) {
    s1 = (s1 + (raw[i] ?? 0)) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  const adler = new Uint8Array(4);
  new DataView(adler.buffer).setUint32(0, ((s2 << 16) | s1) >>> 0, false);
  const idatPayload = new Uint8Array(2 + compressed.byteLength + 4);
  idatPayload.set([0x78, 0x9c], 0);
  idatPayload.set(compressed, 2);
  idatPayload.set(adler, 2 + compressed.byteLength);
  const c1 = makePngChunk('IHDR', ihdr);
  const c2 = makePngChunk('IDAT', idatPayload);
  const c3 = makePngChunk('IEND', new Uint8Array(0));
  const out = new Uint8Array(sig.byteLength + c1.byteLength + c2.byteLength + c3.byteLength);
  let off = 0;
  for (const part of [sig, c1, c2, c3]) {
    out.set(part, off);
    off += part.byteLength;
  }
  return out;
}

const HERO_IMG_BYTES = buildTestPngBytes(80, 60, 220, 38, 38);
const DUPLICATE_IMG_BYTES = buildTestPngBytes(60, 40, 22, 163, 74);
const FONT_STUB_BYTES = new Uint8Array([
  0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00, 0x50, 0x53,
]);

const EXTERNAL_THEME_CSS = `
@font-face {
  font-family: "FixtureFont";
  src: url("../fonts/fixture.woff2") format("woff2");
}
body {
  margin: 0;
  font-family: "FixtureFont", -apple-system, BlinkMacSystemFont, sans-serif;
  background-color: #ffffff;
  color: #0f172a;
}
header#sticky-header {
  position: sticky;
  top: 0;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  background-color: #1e293b;
  color: #ffffff;
  z-index: 10;
}
#top-red-band {
  height: 220px;
  background-color: #ef4444;
  color: #ffffff;
  padding: 24px;
}
#green-box {
  width: 240px;
  height: 160px;
  margin: 24px;
  background-color: #22c55e;
  color: #052e16;
  padding: 16px;
}
#middle-blue-spacer {
  height: 900px;
  background-color: #2563eb;
  color: #ffffff;
  padding: 24px;
}
#bottom-yellow-band {
  height: 360px;
  background-color: #eab308;
  color: #111827;
  padding: 24px;
}
`;

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en" data-wf-site="wf-e2e-live">
  <head>
    <meta charset="UTF-8" />
    <title>PageSift Acceptance Fixture — 日本語・🚀</title>
    <meta name="generator" content="Astro v4.15" />
    <link rel="stylesheet" href="/styles/theme.css" />
  </head>
  <body>
    <div id="__next">
      <header id="sticky-header">
        <nav aria-label="Primary"><a id="nav-link" href="/docs">Documentation</a></nav>
        <button id="primary-cta" type="button">Get Started</button>
      </header>
      <main>
        <section id="top-red-band">
          <h1 id="hero-title">Visual Design Extraction <strong>Pro</strong></h1>
          <img id="hero-img" src="/img/a/banner.png" alt="Red Hero Asset" width="80" height="60" />
          <img id="dup-img" src="/img/b/banner.png" alt="Green Duplicate Name Asset" width="60" height="40" />
          <img id="missing-img" src="/img/missing-404.png" alt="Missing Asset" />
        </section>
        <section id="green-box">
          <h2>Green Capture Box</h2>
          <svg id="inline-logo" width="48" height="48" viewBox="0 0 48 48" onload="window.__SVG_XSS=true">
            <script>window.__SVG_SCRIPT=true;</script>
            <circle cx="24" cy="24" r="20" fill="#38bdf8" />
          </svg>
        </section>
        <iframe id="evil-srcdoc" srcdoc="<script>window.__SRCDOC_RAN=true;parent.__SRCDOC_RAN=true;</script><img src=x onerror='window.__SRCDOC_ERR=true'>"></iframe>
        <a id="evil-link" href="  java&#x09;script:window.__OBF_RAN=true">Obfuscated Link</a>
        <form id="sensitive-form" action="/steal-login">
          <input type="text" name="email" value="private_customer@example.com" />
          <input type="password" name="secret_pw" value="NEVER_EXPORT_THIS_PASSWORD_999" />
          <input type="hidden" name="csrf" value="SECRET_HIDDEN_CSRF_999" />
          <button formaction="javascript:window.__FORMACTION_RAN=true" type="submit">Send</button>
        </form>
        <section id="middle-blue-spacer">
          <p id="hero-copy">Tall blue section pushing content well beyond a single viewport.</p>
          <div id="shadow-mount"></div>
        </section>
        <section id="bottom-yellow-band">
          <h2 id="bottom-heading">Bottom Yellow Region Beyond First Viewport</h2>
        </section>
      </main>
    </div>
    <script>
      window.__LIVE_SCRIPT_RAN = true;
      const host = document.getElementById('shadow-mount');
      if (host) {
        const root = host.attachShadow({ mode: 'open' });
        const span = document.createElement('span');
        span.id = 'open-shadow-chip';
        span.textContent = 'Shadow Token Chip';
        root.appendChild(span);
      }
    </script>
  </body>
</html>`;

async function readDownloadedBytes(download: Download): Promise<Uint8Array> {
  const filePath = await download.path();
  if (!filePath) {
    throw new Error(`Download ${download.suggestedFilename()} did not produce a local path`);
  }
  return new Uint8Array(fs.readFileSync(filePath));
}

async function sampleImagePixelsInPage(
  page: Page,
  mimeType: string,
  bytes: Uint8Array,
  samplePoints: Array<{ xRatio: number; yRatio: number }>,
): Promise<{ width: number; height: number; pixels: Array<[number, number, number, number]> }> {
  const b64 = Buffer.from(bytes).toString('base64');
  return page.evaluate(
    async ({ mime, base64, points }) => {
      const dataUrl = `data:${mime};base64,${base64}`;
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => {
          resolve(el);
        };
        el.onerror = () => {
          reject(new Error(`Browser failed to decode ${mime}`));
        };
        el.src = dataUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('2D context unavailable');
      }
      ctx.drawImage(img, 0, 0);
      const pixels: Array<[number, number, number, number]> = points.map((pt) => {
        const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(pt.xRatio * canvas.width)));
        const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(pt.yRatio * canvas.height)));
        const data = ctx.getImageData(x, y, 1, 1).data;
        return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0];
      });
      return { width: img.naturalWidth, height: img.naturalHeight, pixels };
    },
    { mime: mimeType, base64: b64, points: samplePoints },
  );
}

function extractJpegStreamFromPdf(pdfBytes: Uint8Array): Uint8Array {
  const startMarker = new Uint8Array([0xff, 0xd8]);
  let startIdx = -1;
  for (let i = 0; i < pdfBytes.byteLength - 1; i += 1) {
    if (pdfBytes[i] === startMarker[0] && pdfBytes[i + 1] === startMarker[1]) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) {
    throw new Error('No JPEG SOI marker (FF D8) found in PDF');
  }
  let endIdx = -1;
  for (let i = pdfBytes.byteLength - 2; i > startIdx; i -= 1) {
    if (pdfBytes[i] === 0xff && pdfBytes[i + 1] === 0xd9) {
      endIdx = i + 2;
      break;
    }
  }
  if (endIdx === -1) {
    throw new Error('No JPEG EOI marker (FF D9) found in PDF');
  }
  return pdfBytes.subarray(startIdx, endIdx);
}

async function waitForWorkspaceStatus(
  page: Page,
  expectedSubstring: string,
  timeoutMs = 15000,
): Promise<string> {
  const handle = await page.waitForFunction(
    (expected: string) => {
      const text = document.getElementById('status-message')?.textContent ?? '';
      if (text.includes(expected)) {
        return { done: true, error: false, text };
      }
      if (text.startsWith('Error:')) {
        return {
          done: true,
          error: true,
          text,
          output: document.getElementById('tool-output')?.textContent ?? '',
        };
      }
      return null;
    },
    expectedSubstring,
    { polling: 100, timeout: timeoutMs },
  );
  const result = (await handle.jsonValue()) as {
    done: boolean;
    error: boolean;
    text: string;
    output?: string;
  };
  if (result.error) {
    throw new Error(
      `Workspace reported error while waiting for "${expectedSubstring}": ${result.text}\n${result.output ?? ''}`,
    );
  }
  return result.text;
}

describe('Real Chromium Manifest V3 Extension Acceptance Suite (Slices 1-6)', () => {
  let server: http.Server;
  let fixtureUrl = '';
  let userDataDir = '';
  let context: BrowserContext | null = null;
  let extensionId = '';
  const runtimeErrors: string[] = [];

  beforeAll(async () => {
    if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) {
      throw new Error('dist/extension/manifest.json missing; run npm run build:extension first');
    }

    server = http.createServer((req, res) => {
      const pathname = (req.url ?? '/').split('?')[0];
      if (pathname === '/fixture') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(FIXTURE_HTML);
        return;
      }
      if (pathname === '/styles/theme.css') {
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
        res.end(EXTERNAL_THEME_CSS);
        return;
      }
      if (pathname === '/img/a/banner.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(HERO_IMG_BYTES);
        return;
      }
      if (pathname === '/img/b/banner.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(DUPLICATE_IMG_BYTES);
        return;
      }
      if (pathname === '/fonts/fixture.woff2') {
        res.writeHead(200, { 'content-type': 'font/woff2' });
        res.end(FONT_STUB_BYTES);
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          fixtureUrl = `http://127.0.0.1:${addr.port}/fixture`;
          resolve();
        } else {
          reject(new Error('Failed to bind E2E fixture server'));
        }
      });
    });

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagesift-chromium-e2e-'));
    const executablePath = resolveChromiumExecutablePath();

    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      acceptDownloads: true,
      viewport: { width: 1024, height: 700 },
      ...(executablePath ? { executablePath } : { channel: 'chromium' }),
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
        '--no-sandbox',
      ],
    });

    context.on('weberror', (webError) => {
      runtimeErrors.push(`weberror: ${webError.error().message}`);
    });

    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    }
    serviceWorker.on('console', (msg) => {
      if (msg.type() === 'error') {
        runtimeErrors.push(`service-worker: ${msg.text()}`);
      }
    });

    extensionId = serviceWorker.url().split('/')[2] ?? '';
  });

  afterAll(async () => {
    if (context) {
      await context.close();
    }
    if (userDataDir) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it('verifies real capture (PNG/JPEG/WebP/PDF, full-page, crop, annotation), safe offline clone & asset downloads, responsive windows & scroll sync, and storage persistence in Chromium', async () => {
    if (!context) {
      throw new Error('BrowserContext not initialized');
    }
    expect(extensionId.length).toBe(32);

    const fixturePage = await context.newPage();
    fixturePage.on('pageerror', (err) => {
      runtimeErrors.push(`fixture-page: ${err.message}`);
    });
    await fixturePage.goto(fixtureUrl, { waitUntil: 'networkidle' });

    const workspacePage = await context.newPage();
    workspacePage.on('pageerror', (err) => {
      runtimeErrors.push(`workspace-page: ${err.message}`);
    });
    await workspacePage.goto(`chrome-extension://${extensionId}/workspace.html`, {
      waitUntil: 'domcontentloaded',
    });

    const fixtureTabId = await workspacePage.evaluate(async () => {
      const chromeApi = (
        globalThis as unknown as {
          chrome: {
            tabs: {
              query: (q: object) => Promise<Array<{ id?: number }>>;
              sendMessage: (
                id: number,
                msg: unknown,
              ) => Promise<{ ok?: boolean; data?: { pageUrl?: string } }>;
            };
          };
        }
      ).chrome;
      const tabs = await chromeApi.tabs.query({});
      for (const tab of tabs) {
        if (typeof tab.id !== 'number') {
          continue;
        }
        try {
          const res = await chromeApi.tabs.sendMessage(tab.id, {
            schemaVersion: 1,
            requestId: 'find-fixture-tab',
            operation: 'GET_DOCUMENT_CONTEXT',
            payload: {},
          });
          if (res.ok && res.data?.pageUrl?.includes('/fixture')) {
            return tab.id;
          }
        } catch {
          continue;
        }
      }
      return null;
    });

    expect(typeof fixtureTabId).toBe('number');
    const tabId = fixtureTabId as number;

    await workspacePage.goto(
      `chrome-extension://${extensionId}/workspace.html?tabId=${tabId}&targetUrl=${encodeURIComponent(fixtureUrl)}`,
      { waitUntil: 'domcontentloaded' },
    );

    const decoderPage = await context.newPage();
    await decoderPage.setContent('<!DOCTYPE html><html><body></body></html>');

    await workspacePage.click('button[data-tool="capture"]');
    await workspacePage.selectOption('#capture-mode-select', 'visible');
    await workspacePage.selectOption('#capture-format-select', 'image/png');
    await workspacePage.click('#run-tool-btn');
    await waitForWorkspaceStatus(workspacePage, 'Captured ', 15000);

    const [pngDownload] = await Promise.all([
      workspacePage.waitForEvent('download'),
      workspacePage.click('#download-result-btn'),
    ]);
    expect(pngDownload.suggestedFilename()).toMatch(/\.png$/);
    const visiblePngBytes = await readDownloadedBytes(pngDownload);
    const visiblePngMeta = verifyCaptureBinaryAndDimensions(
      `data:image/png;base64,${Buffer.from(visiblePngBytes).toString('base64')}`,
    );
    expect(visiblePngMeta.mimeType).toBe('image/png');
    expect(visiblePngMeta.width).toBeGreaterThan(200);
    expect(visiblePngMeta.height).toBeGreaterThan(200);

    const visibleSample = await sampleImagePixelsInPage(decoderPage, 'image/png', visiblePngBytes, [
      { xRatio: 0.75, yRatio: 0.2 },
    ]);
    const topBandRgb = visibleSample.pixels[0] ?? [0, 0, 0, 0];
    expect(topBandRgb[0]).toBeGreaterThan(180);
    expect(topBandRgb[1]).toBeLessThan(110);

    await workspacePage.selectOption('#capture-mode-select', 'element');
    await workspacePage.selectOption('#capture-format-select', 'image/webp');
    await workspacePage.fill('#target-selector-input', '#green-box');
    await workspacePage.click('#run-tool-btn');
    await waitForWorkspaceStatus(workspacePage, 'image/webp', 15000);
    const [webpDownload] = await Promise.all([
      workspacePage.waitForEvent('download'),
      workspacePage.click('#download-result-btn'),
    ]);
    expect(webpDownload.suggestedFilename()).toMatch(/\.webp$/);
    const webpBytes = await readDownloadedBytes(webpDownload);
    const webpMeta = verifyCaptureBinaryAndDimensions(
      `data:image/webp;base64,${Buffer.from(webpBytes).toString('base64')}`,
    );
    expect(webpMeta.mimeType).toBe('image/webp');
    const greenSample = await sampleImagePixelsInPage(decoderPage, 'image/webp', webpBytes, [
      { xRatio: 0.8, yRatio: 0.8 },
    ]);
    const greenRgb = greenSample.pixels[0] ?? [0, 0, 0, 0];
    expect(greenRgb[1]).toBeGreaterThan(150);
    expect(greenRgb[0]).toBeLessThan(100);

    await workspacePage.selectOption('#capture-format-select', 'image/jpeg');
    await workspacePage.fill('#ann-label', 'Callout');
    await workspacePage.click('#add-annotation-btn');
    await waitForWorkspaceStatus(workspacePage, 'image/jpeg', 10000);
    const [jpegDownload] = await Promise.all([
      workspacePage.waitForEvent('download'),
      workspacePage.click('#download-result-btn'),
    ]);
    expect(jpegDownload.suggestedFilename()).toMatch(/\.jpg$/);
    const jpegBytes = await readDownloadedBytes(jpegDownload);
    const jpegMeta = verifyCaptureBinaryAndDimensions(
      `data:image/jpeg;base64,${Buffer.from(jpegBytes).toString('base64')}`,
    );
    expect(jpegMeta.mimeType).toBe('image/jpeg');

    await workspacePage.selectOption('#capture-mode-select', 'full_page');
    await workspacePage.selectOption('#capture-format-select', 'image/png');
    await workspacePage.fill('#target-selector-input', '');
    await fixturePage.evaluate(() => {
      window.scrollTo(0, 120);
    });
    await workspacePage.click('#run-tool-btn');
    await waitForWorkspaceStatus(workspacePage, 'Captured ', 25000);
    const fullOutputText = (await workspacePage.locator('#tool-output').textContent()) ?? '';
    expect(fullOutputText).toContain('"full_page"');
    const [fullPngDownload] = await Promise.all([
      workspacePage.waitForEvent('download'),
      workspacePage.click('#download-result-btn'),
    ]);
    const fullPngBytes = await readDownloadedBytes(fullPngDownload);
    const fullSample = await sampleImagePixelsInPage(decoderPage, 'image/png', fullPngBytes, [
      { xRatio: 0.75, yRatio: 0.94 },
    ]);
    expect(fullSample.height).toBeGreaterThan(visibleSample.height);
    const bottomRgb = fullSample.pixels[0] ?? [0, 0, 0, 0];
    expect(bottomRgb[0]).toBeGreaterThan(190);
    expect(bottomRgb[1]).toBeGreaterThan(140);
    expect(bottomRgb[2]).toBeLessThan(80);

    const restoredScrollY = await fixturePage.evaluate(() => window.scrollY);
    expect(restoredScrollY).toBe(120);
    const restoredHeaderVis = await fixturePage.evaluate(
      () => document.getElementById('sticky-header')?.style.visibility ?? '',
    );
    expect(restoredHeaderVis).toBe('');

    await workspacePage.selectOption('#capture-mode-select', 'visible');
    await workspacePage.selectOption('#capture-format-select', 'application/pdf');
    await workspacePage.click('#run-tool-btn');
    await waitForWorkspaceStatus(workspacePage, 'application/pdf', 15000);
    const [pdfDownload] = await Promise.all([
      workspacePage.waitForEvent('download'),
      workspacePage.click('#download-result-btn'),
    ]);
    expect(pdfDownload.suggestedFilename()).toMatch(/\.pdf$/);
    const pdfBytes = await readDownloadedBytes(pdfDownload);
    const pdfMeta = verifyCaptureBinaryAndDimensions(
      `data:application/pdf;base64,${Buffer.from(pdfBytes).toString('base64')}`,
    );
    expect(pdfMeta.mimeType).toBe('application/pdf');
    const embeddedJpeg = extractJpegStreamFromPdf(pdfBytes);
    const embeddedSample = await sampleImagePixelsInPage(decoderPage, 'image/jpeg', embeddedJpeg, [
      { xRatio: 0.75, yRatio: 0.12 },
    ]);
    expect(embeddedSample.width).toBeGreaterThan(200);
    expect(embeddedSample.pixels[0]?.[0] ?? 0).toBeGreaterThan(170);

    await workspacePage.click('button[data-tool="assets"]');
    await workspacePage.click('#run-tool-btn');
    await waitForWorkspaceStatus(workspacePage, 'Assets ZIP ready', 15000);
    const [assetsZipDownload] = await Promise.all([
      workspacePage.waitForEvent('download'),
      workspacePage.click('#download-result-btn'),
    ]);
    expect(assetsZipDownload.suggestedFilename()).toMatch(/\.zip$/);
    const assetsZipBytes = await readDownloadedBytes(assetsZipDownload);
    const unzippedAssets = unzipSync(assetsZipBytes);
    expect(unzippedAssets['assets/banner.png']).toEqual(HERO_IMG_BYTES);
    expect(unzippedAssets['assets/banner-1.png']).toEqual(DUPLICATE_IMG_BYTES);
    expect(unzippedAssets['assets/fixture.woff2']).toEqual(FONT_STUB_BYTES);
    const assetsManifestText = strFromU8(
      unzippedAssets['assets-manifest.json'] ?? new Uint8Array(),
    );
    expect(assetsManifestText).toContain('missing-404.png');

    await workspacePage.click('button[data-tool="clone_page"]');
    await workspacePage.click('#run-tool-btn');
    await waitForWorkspaceStatus(workspacePage, 'Static HTML/CSS snapshot ZIP ready', 15000);
    const [cloneZipDownload] = await Promise.all([
      workspacePage.waitForEvent('download'),
      workspacePage.click('#download-result-btn'),
    ]);
    expect(cloneZipDownload.suggestedFilename()).toMatch(/\.zip$/);
    const cloneZipBytes = await readDownloadedBytes(cloneZipDownload);
    const unzippedClone = unzipSync(cloneZipBytes);
    const exportedHtml = strFromU8(unzippedClone['index.html'] ?? new Uint8Array());
    const exportedCss = strFromU8(unzippedClone['styles/snapshot.css'] ?? new Uint8Array());
    const exportedManifest = JSON.parse(
      strFromU8(unzippedClone['manifest.json'] ?? new Uint8Array()),
    ) as { isSelfContained: boolean; missingResources: Array<{ url: string }> };

    expect(exportedHtml).not.toContain('NEVER_EXPORT_THIS_PASSWORD_999');
    expect(exportedHtml).not.toContain('SECRET_HIDDEN_CSRF_999');
    expect(exportedHtml).not.toContain('srcdoc');
    expect(exportedHtml).not.toContain('<iframe');
    expect(exportedHtml).not.toContain('<script');
    expect(exportedHtml).not.toContain('__SRCDOC_RAN');
    expect(exportedHtml).not.toContain('__OBF_RAN');
    expect(exportedHtml).not.toContain('__FORMACTION_RAN');
    expect(exportedHtml).toContain('Content-Security-Policy');
    expect(exportedHtml).toContain('assets/banner.png');
    expect(exportedHtml).toContain('assets/banner-1.png');
    expect(exportedCss).toContain('url("../assets/fixture.woff2")');
    expect(exportedManifest.isSelfContained).toBe(false);
    expect(exportedManifest.missingResources.some((m) => m.url.includes('missing-404.png'))).toBe(
      true,
    );

    const offlineExtractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagesift-offline-snap-'));
    try {
      for (const [relPath, fileBytes] of Object.entries(unzippedClone)) {
        const destPath = path.join(offlineExtractDir, relPath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, fileBytes);
      }

      const offlinePage = await context.newPage();
      await offlinePage.route('**/*', (route) => {
        if (route.request().url().startsWith('file://')) {
          return route.continue();
        }
        return route.abort();
      });
      await offlinePage.goto(`file://${path.join(offlineExtractDir, 'index.html')}`, {
        waitUntil: 'load',
      });
      const offlineCheck = await offlinePage.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const heroImg = document.getElementById('hero-img') as HTMLImageElement | null;
        const heading = document.getElementById('hero-title')?.textContent ?? '';
        return {
          srcdocRan: w['__SRCDOC_RAN'] === true,
          liveScriptRan: w['__LIVE_SCRIPT_RAN'] === true,
          svgScriptRan: w['__SVG_SCRIPT'] === true,
          heading,
          heroNaturalWidth: heroImg?.naturalWidth ?? 0,
        };
      });
      expect(offlineCheck.srcdocRan).toBe(false);
      expect(offlineCheck.liveScriptRan).toBe(false);
      expect(offlineCheck.svgScriptRan).toBe(false);
      expect(offlineCheck.heading).toContain('Visual Design Extraction');
      expect(offlineCheck.heroNaturalWidth).toBe(80);
      await offlinePage.close();
    } finally {
      fs.rmSync(offlineExtractDir, { recursive: true, force: true });
    }

    await workspacePage.click('button[data-tool="responsive"]');
    const pagesBeforeResponsive = context.pages().length;
    await workspacePage.click('#open-responsive-btn');
    await waitForWorkspaceStatus(workspacePage, 'Responsive preview windows opened', 20000);

    const allPages = context.pages();
    const responsivePages = allPages.filter(
      (p) =>
        p !== fixturePage && p !== workspacePage && p !== decoderPage && p.url() === fixtureUrl,
    );
    expect(responsivePages.length).toBeGreaterThanOrEqual(2);
    expect(allPages.length).toBeGreaterThanOrEqual(pagesBeforeResponsive + 2);

    const respStatusText =
      (await workspacePage.locator('#responsive-session-status').textContent()) ?? '';
    expect(respStatusText).toContain('actual ');

    const firstRespPage = responsivePages[0];
    const secondRespPage = responsivePages[1];
    if (firstRespPage && secondRespPage) {
      await firstRespPage.evaluate(() => {
        window.scrollTo(0, 600);
        window.dispatchEvent(new Event('scroll'));
      });
      await secondRespPage.waitForFunction(() => window.scrollY > 100, undefined, {
        polling: 100,
        timeout: 5000,
      });
      const syncedY1 = await secondRespPage.evaluate(() => window.scrollY);
      expect(syncedY1).toBeGreaterThan(100);
      await new Promise((r) => setTimeout(r, 400));
      const syncedY2 = await secondRespPage.evaluate(() => window.scrollY);
      expect(Math.abs(syncedY2 - syncedY1)).toBeLessThan(20);
    }

    await workspacePage.click('#close-responsive-btn');
    await waitForWorkspaceStatus(workspacePage, 'Closed ', 10000);
    expect(fixturePage.isClosed()).toBe(false);
    expect(workspacePage.isClosed()).toBe(false);

    await workspacePage.click('button[data-tool="design_md"]');
    await workspacePage.click('#run-tool-btn');
    await waitForWorkspaceStatus(workspacePage, 'Completed ', 10000);
    await workspacePage.click('#save-artifact-btn');
    await waitForWorkspaceStatus(workspacePage, 'Saved tool result to local IndexedDB', 10000);

    const optionsPage = await context.newPage();
    optionsPage.on('pageerror', (err) => {
      runtimeErrors.push(`options-page: ${err.message}`);
    });
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, {
      waitUntil: 'domcontentloaded',
    });
    await optionsPage.fill('#nvidia-api-key-input', 'nvapi-session-only-secret-000000');
    await optionsPage.click('#set-nvidia-key-btn');
    await optionsPage.waitForFunction(
      () =>
        (document.getElementById('nvidia-key-status')?.textContent ?? '').includes(
          'Active in session',
        ),
      undefined,
      { polling: 100, timeout: 10000 },
    );

    const [backupDownload] = await Promise.all([
      optionsPage.waitForEvent('download'),
      optionsPage.click('#download-backup-btn'),
    ]);
    expect(backupDownload.suggestedFilename()).toMatch(/^pagesift-backup-.*\.json$/);
    const backupText = strFromU8(await readDownloadedBytes(backupDownload));
    expect(backupText).not.toContain('nvapi-session-only-secret-000000');
    expect(backupText).toContain('Design MD');
    expect(backupText).toContain('"schemaVersion": 2');
    expect(backupText).toContain('"activities"');

    const freshWorkspacePage = await context.newPage();
    await freshWorkspacePage.goto(`chrome-extension://${extensionId}/workspace.html`, {
      waitUntil: 'domcontentloaded',
    });
    const persistedCheck = await freshWorkspacePage.evaluate(async () => {
      const chromeRuntime = (
        globalThis as unknown as {
          chrome: {
            runtime: {
              sendMessage: (msg: unknown) => Promise<ExtensionMessageResponse>;
            };
          };
        }
      ).chrome.runtime;
      return chromeRuntime.sendMessage({
        schemaVersion: 1,
        requestId: 'verify-persisted-usage',
        operation: 'GET_STORAGE_USAGE',
        payload: {},
      });
    });
    expect(persistedCheck.ok).toBe(true);
    if (persistedCheck.ok) {
      const usage = (persistedCheck.data as { usage: { artifactCount: number } }).usage;
      expect(usage.artifactCount).toBeGreaterThanOrEqual(1);
    }

    const hostStorageCount = await fixturePage.evaluate(
      () => window.localStorage.length + window.sessionStorage.length,
    );
    expect(hostStorageCount).toBe(0);
    expect(runtimeErrors).toEqual([]);

    await freshWorkspacePage.close();
    await optionsPage.close();
    await decoderPage.close();
    await workspacePage.close();
    await fixturePage.close();

    await context.close();
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      acceptDownloads: true,
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
        '--no-sandbox',
      ],
    });
    let restartedWorker = context.serviceWorkers()[0];
    if (!restartedWorker) {
      restartedWorker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    }
    const restartedExtId = restartedWorker.url().split('/')[2] ?? extensionId;
    extensionId = restartedExtId;
    const afterRestartPage = await context.newPage();
    await afterRestartPage.goto(`chrome-extension://${restartedExtId}/workspace.html`, {
      waitUntil: 'domcontentloaded',
    });
    const afterRestartCheck = await afterRestartPage.evaluate(async () => {
      const chromeRuntime = (
        globalThis as unknown as {
          chrome: {
            runtime: {
              sendMessage: (msg: unknown) => Promise<ExtensionMessageResponse>;
            };
          };
        }
      ).chrome.runtime;
      const usageRes = await chromeRuntime.sendMessage({
        schemaVersion: 1,
        requestId: 'verify-after-restart-usage',
        operation: 'GET_STORAGE_USAGE',
        payload: {},
      });
      const keyRes = await chromeRuntime.sendMessage({
        schemaVersion: 1,
        requestId: 'verify-after-restart-key',
        operation: 'GET_NVIDIA_KEY_STATUS',
        payload: {},
      });
      return { usageRes, keyRes };
    });
    expect(afterRestartCheck.usageRes.ok).toBe(true);
    if (afterRestartCheck.usageRes.ok) {
      const usage = (
        afterRestartCheck.usageRes.data as {
          usage: { artifactCount: number; activityCount: number };
        }
      ).usage;
      expect(usage.artifactCount).toBeGreaterThanOrEqual(1);
      expect(usage.activityCount).toBeGreaterThanOrEqual(1);
    }
    expect(afterRestartCheck.keyRes.ok).toBe(true);
    if (afterRestartCheck.keyRes.ok) {
      const status = (afterRestartCheck.keyRes.data as { status: { hasSessionKey: boolean } })
        .status;
      expect(status.hasSessionKey).toBe(false);
    }
    await afterRestartPage.close();
  }, 120000);

  it('recovers interrupted running jobs and preserves responsive session & saved data after real MV3 service-worker stop and message wake', async () => {
    if (!context) {
      throw new Error('BrowserContext not initialized');
    }

    const adminPage = await context.newPage();
    adminPage.on('pageerror', (err) => {
      runtimeErrors.push(`sw-recovery-page: ${err.message}`);
    });
    await adminPage.goto(`chrome-extension://${extensionId}/workspace.html`, {
      waitUntil: 'domcontentloaded',
    });

    await adminPage.evaluate(
      async ({ targetUrl }: { targetUrl: string }) => {
        const chromeRuntime = (
          globalThis as unknown as {
            chrome: {
              runtime: {
                sendMessage: (msg: unknown) => Promise<ExtensionMessageResponse>;
              };
            };
          }
        ).chrome.runtime;

        await chromeRuntime.sendMessage({
          schemaVersion: 1,
          requestId: 'sw-seed-artifact-1',
          operation: 'SAVE_ARTIFACT_TO_IDB',
          payload: {
            projectId: 'proj-default',
            kind: 'inspect_report',
            title: 'Pre-Stop Survival Artifact',
            artifactPayload: { kept: true },
          },
        });

        await chromeRuntime.sendMessage({
          schemaVersion: 1,
          requestId: 'sw-seed-responsive-1',
          operation: 'RUN_RESPONSIVE_INSPECT',
          payload: {
            targetUrl,
            openWindows: true,
            syncEnabled: true,
            customViewports: [
              { id: 'mobile-sm', label: 'Mobile', width: 375, height: 700, category: 'mobile' },
            ],
          },
        });

        await new Promise<void>((resolve, reject) => {
          const openReq = indexedDB.open('pagesift_local_db', 3);
          openReq.onerror = () => {
            reject(new Error('Failed to open pagesift_local_db'));
          };
          openReq.onsuccess = () => {
            const db = openReq.result;
            const tx = db.transaction(['jobs', 'activities'], 'readwrite');
            const nowIso = new Date().toISOString();
            tx.objectStore('jobs').put({
              id: 'job-running-before-sw-stop',
              tool: 'clone_page',
              tabId: 1,
              documentId: 'doc-pre-stop',
              status: 'running',
              progressPercent: 45,
              statusMessage: 'In flight before worker stop',
              createdAt: nowIso,
              updatedAt: nowIso,
            });
            tx.objectStore('activities').put({
              id: 'act-running-before-sw-stop',
              sessionId: `rsess-${nowIso.slice(0, 10)}-127.0.0.1`,
              tool: 'clone_page',
              actionLabel: 'Clone Page',
              sourceUrl: 'http://127.0.0.1/fixture',
              sourceOrigin: 'http://127.0.0.1',
              sourceDomain: '127.0.0.1',
              pageTitle: 'Fixture',
              startedAt: nowIso,
              completedAt: null,
              durationMs: null,
              status: 'running',
              optionsSummary: {},
              resultSummary: 'In flight before worker stop',
              linkedArtifactId: null,
              linkedCaptureId: null,
              errorCategory: null,
            });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => {
              db.close();
              reject(new Error('Failed to seed running job and activity'));
            };
          };
        });
      },
      { targetUrl: fixtureUrl },
    );

    const cdp = await context.newCDPSession(adminPage);
    const waitForCdp = <T>(
      eventName: string,
      predicate: (params: Record<string, unknown>) => T | undefined,
    ): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for CDP event ${eventName}`));
        }, 12000);
        const handler = (params: Record<string, unknown>): void => {
          const val = predicate(params);
          if (val !== undefined) {
            clearTimeout(timer);
            cdp.off(eventName as never, handler as never);
            resolve(val);
          }
        };
        cdp.on(eventName as never, handler as never);
      });

    const versionPromise = waitForCdp('ServiceWorker.workerVersionUpdated', (params) => {
      const versions = params['versions'] as
        | Array<{ versionId?: string; scriptURL?: string; runningStatus?: string }>
        | undefined;
      const match = versions?.find(
        (v) =>
          (v.scriptURL ?? '').includes(extensionId) &&
          typeof v.versionId === 'string' &&
          v.runningStatus === 'running',
      );
      return match?.versionId;
    });
    await cdp.send('ServiceWorker.enable');
    const versionId = await versionPromise;

    const stoppedPromise = waitForCdp('ServiceWorker.workerVersionUpdated', (params) => {
      const versions = params['versions'] as
        | Array<{ versionId?: string; runningStatus?: string }>
        | undefined;
      const match = versions?.find(
        (v) => v.versionId === versionId && v.runningStatus === 'stopped',
      );
      return match ? true : undefined;
    });
    await cdp.send('ServiceWorker.stopWorker', { versionId });
    await stoppedPromise;

    const wakeResult = await adminPage.evaluate(async () => {
      const chromeRuntime = (
        globalThis as unknown as {
          chrome: {
            runtime: {
              sendMessage: (msg: unknown) => Promise<ExtensionMessageResponse>;
            };
          };
        }
      ).chrome.runtime;

      const jobRes = await chromeRuntime.sendMessage({
        schemaVersion: 1,
        requestId: 'wake-check-job-status',
        operation: 'GET_JOB_STATUS',
        payload: { jobId: 'job-running-before-sw-stop' },
      });
      const actRes = await chromeRuntime.sendMessage({
        schemaVersion: 1,
        requestId: 'wake-check-activity-status',
        operation: 'QUERY_ACTIVITY_HISTORY',
        payload: { status: 'interrupted', limit: 20, offset: 0 },
      });
      const respRes = await chromeRuntime.sendMessage({
        schemaVersion: 1,
        requestId: 'wake-check-responsive',
        operation: 'GET_RESPONSIVE_SESSION',
        payload: {},
      });
      const usageRes = await chromeRuntime.sendMessage({
        schemaVersion: 1,
        requestId: 'wake-check-usage',
        operation: 'GET_STORAGE_USAGE',
        payload: {},
      });
      const closeRes = await chromeRuntime.sendMessage({
        schemaVersion: 1,
        requestId: 'wake-close-responsive',
        operation: 'CLOSE_RESPONSIVE_SESSION',
        payload: {},
      });
      return { jobRes, actRes, respRes, usageRes, closeRes };
    });

    expect(wakeResult.jobRes.ok).toBe(true);
    if (wakeResult.jobRes.ok) {
      const job = (wakeResult.jobRes.data as { job: { status: string } | null }).job;
      expect(job?.status).toBe('interrupted');
    }
    expect(wakeResult.actRes.ok).toBe(true);
    if (wakeResult.actRes.ok) {
      const items = (wakeResult.actRes.data as { items: Array<{ id: string; status: string }> })
        .items;
      expect(
        items.some((a) => a.id === 'act-running-before-sw-stop' && a.status === 'interrupted'),
      ).toBe(true);
    }
    expect(wakeResult.respRes.ok).toBe(true);
    if (wakeResult.respRes.ok) {
      const session = (
        wakeResult.respRes.data as { session: { windows: Array<{ windowId: number }> } | null }
      ).session;
      expect(session).not.toBeNull();
      expect(session?.windows.length).toBeGreaterThanOrEqual(1);
    }
    expect(wakeResult.usageRes.ok).toBe(true);
    if (wakeResult.usageRes.ok) {
      const usage = (wakeResult.usageRes.data as { usage: { artifactCount: number } }).usage;
      expect(usage.artifactCount).toBeGreaterThanOrEqual(1);
    }
    expect(wakeResult.closeRes.ok).toBe(true);
    expect(runtimeErrors).toEqual([]);

    await cdp.detach();
    await adminPage.close();
  }, 60000);

  it('verifies on-page overlay dashboard, picker auto-minimize/restore, activity history timeline, sidebar collapse, theme persistence, dialog accessibility, responsive layouts, and genuine 200% browser zoom', async () => {
    if (!context) {
      throw new Error('BrowserContext not initialized');
    }

    const fixturePage = await context.newPage();
    fixturePage.on('pageerror', (err) => {
      runtimeErrors.push(`overlay-fixture-page: ${err.message}`);
    });
    await fixturePage.goto(`${fixtureUrl}?secret_token=NEVER_STORE_IN_HISTORY#private-hash`, {
      waitUntil: 'networkidle',
    });

    const probePage = await context.newPage();
    await probePage.goto(`chrome-extension://${extensionId}/workspace.html`, {
      waitUntil: 'domcontentloaded',
    });
    const tabId = await probePage.evaluate(async () => {
      const chromeTabs = (
        globalThis as unknown as {
          chrome: {
            tabs: {
              query: (q: object) => Promise<Array<{ id?: number }>>;
              sendMessage: (
                id: number,
                msg: unknown,
              ) => Promise<{ ok?: boolean; data?: { pageUrl?: string } }>;
            };
          };
        }
      ).chrome.tabs;
      const tabs = await chromeTabs.query({});
      for (const tab of tabs) {
        if (typeof tab.id !== 'number') continue;
        try {
          const r = await chromeTabs.sendMessage(tab.id, {
            schemaVersion: 1,
            requestId: 'find-ui-fixture',
            operation: 'GET_DOCUMENT_CONTEXT',
            payload: {},
          });
          if (r.ok && r.data?.pageUrl?.includes('/fixture')) return tab.id;
        } catch {
          continue;
        }
      }
      return null;
    });
    expect(typeof tabId).toBe('number');
    const targetTabId = tabId as number;

    await probePage.evaluate(async (tid: number) => {
      const chromeTabs = (
        globalThis as unknown as {
          chrome: {
            tabs: { sendMessage: (id: number, msg: unknown) => Promise<unknown> };
          };
        }
      ).chrome.tabs;
      await chromeTabs.sendMessage(tid, {
        schemaVersion: 1,
        requestId: 'open-overlay-dashboard-1',
        operation: 'TOGGLE_OVERLAY_DASHBOARD',
        tabId: tid,
        payload: { mode: 'open' },
      });
    }, targetTabId);

    await fixturePage.waitForFunction(
      () => {
        const host = document.getElementById('pagesift-root-host');
        return Boolean(
          host &&
          host.getAttribute('data-pagesift-root') === 'true' &&
          host.shadowRoot?.querySelector('.ps-panel'),
        );
      },
      undefined,
      { polling: 100, timeout: 10000 },
    );

    const overlayState1 = await fixturePage.evaluate(() => {
      const host = document.getElementById('pagesift-root-host');
      const sr = host?.shadowRoot;
      const panel = sr?.querySelector<HTMLElement>('.ps-panel');
      const styleText = sr?.querySelector('style')?.textContent ?? '';
      const anchor = sr?.querySelector<HTMLElement>('.ps-anchor');
      const dockRect = panel?.getBoundingClientRect();
      const computed = panel ? getComputedStyle(panel) : null;
      const anchorComputed = anchor ? getComputedStyle(anchor) : null;
      const matrix =
        computed && computed.transform !== 'none' ? new DOMMatrix(computed.transform) : null;
      return {
        defaultTheme: anchor?.getAttribute('data-theme') ?? '',
        dockToolsCount: sr?.querySelectorAll('button[data-overlay-bar-tool]').length ?? 0,
        betaBadgePresent: Boolean(
          sr?.querySelector('button[data-overlay-bar-tool="design_review"] .ps-beta-badge'),
        ),
        panelVisible: Boolean(panel && computed?.display !== 'none'),
        bottomCenterAligned: Boolean(
          dockRect &&
          Math.abs((dockRect.left + dockRect.right) / 2 - window.innerWidth / 2) < 30 &&
          dockRect.bottom > window.innerHeight - 60,
        ),
        noTransformCollision:
          anchorComputed?.transform === 'none' && (!matrix || Math.abs(matrix.m41) < 0.5),
        hasDropShadow: Boolean(computed?.boxShadow && computed.boxShadow !== 'none'),
        noPillsOrGradientsOrDashes:
          !styleText.includes('999px') &&
          !styleText.includes('gradient(') &&
          !/[\u2013\u2014]/.test(sr?.textContent ?? ''),
      };
    });
    expect(overlayState1.defaultTheme).toBe('dark');
    expect(overlayState1.dockToolsCount).toBe(15);
    expect(overlayState1.betaBadgePresent).toBe(true);
    expect(overlayState1.panelVisible).toBe(true);
    expect(overlayState1.bottomCenterAligned).toBe(true);
    expect(overlayState1.noTransformCollision).toBe(true);
    expect(overlayState1.hasDropShadow).toBe(true);
    expect(overlayState1.noPillsOrGradientsOrDashes).toBe(true);

    await probePage.evaluate(async (tid: number) => {
      const chromeTabs = (
        globalThis as unknown as {
          chrome: { tabs: { sendMessage: (id: number, msg: unknown) => Promise<unknown> } };
        }
      ).chrome.tabs;
      await chromeTabs.sendMessage(tid, {
        schemaVersion: 1,
        requestId: 'open-overlay-second-click-pip',
        operation: 'TOGGLE_OVERLAY_DASHBOARD',
        tabId: tid,
        payload: { mode: 'action_click' },
      });
    }, targetTabId);

    const pipMenuState = await fixturePage.evaluate(() => {
      const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
      const pip = sr?.querySelector<HTMLElement>('.ps-pip-menu.open');
      const iconImg = pip?.querySelector<HTMLImageElement>('.ps-pip-brand img');
      return {
        open: Boolean(pip),
        iconLoaded: Boolean(iconImg && iconImg.complete && iconImg.naturalWidth > 0),
        hasSettingsBtn: Boolean(pip?.querySelector('button[data-ps-action="open-settings"]')),
      };
    });
    expect(pipMenuState.open).toBe(true);
    expect(pipMenuState.iconLoaded).toBe(true);
    expect(pipMenuState.hasSettingsBtn).toBe(true);

    const [pipOpenedOptions] = await Promise.all([
      context.waitForEvent('page'),
      fixturePage.evaluate(() => {
        const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
        sr?.querySelector<HTMLButtonElement>('button[data-ps-action="open-settings"]')?.click();
      }),
    ]);
    await pipOpenedOptions.waitForLoadState('domcontentloaded');
    expect(pipOpenedOptions.url()).toContain('/options.html');
    await pipOpenedOptions.close();

    await fixturePage.bringToFront();
    await fixturePage.evaluate(() => {
      const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
      sr?.querySelector<HTMLButtonElement>('button[data-ps-action="toggle-theme"]')?.click();
    });
    expect(
      await fixturePage.evaluate(() =>
        document
          .getElementById('pagesift-root-host')
          ?.shadowRoot?.querySelector('.ps-anchor')
          ?.getAttribute('data-theme'),
      ),
    ).toBe('light');
    await fixturePage.evaluate(() => {
      const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
      sr?.querySelector<HTMLButtonElement>('button[data-ps-action="toggle-theme"]')?.click();
    });
    expect(
      await fixturePage.evaluate(() =>
        document
          .getElementById('pagesift-root-host')
          ?.shadowRoot?.querySelector('.ps-anchor')
          ?.getAttribute('data-theme'),
      ),
    ).toBe('dark');

    await fixturePage.evaluate(() => {
      const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
      sr?.querySelector<HTMLButtonElement>('button[data-ps-action="toggle-tools"]')?.click();
    });
    const drawerToolsState = await fixturePage.evaluate(() => {
      const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
      const drawer = sr?.querySelector<HTMLElement>('.ps-drawer');
      const dock = sr?.querySelector<HTMLElement>('.ps-panel');
      const dRect = drawer?.getBoundingClientRect();
      const pRect = dock?.getBoundingClientRect();
      return {
        open: Boolean(drawer?.classList.contains('open')),
        toolsCount: sr?.querySelectorAll('button[data-overlay-tool-drawer]').length ?? 0,
        unfoldsUpward: Boolean(dRect && pRect && dRect.bottom <= pRect.top + 4),
      };
    });
    expect(drawerToolsState.open).toBe(true);
    expect(drawerToolsState.toolsCount).toBe(15);
    expect(drawerToolsState.unfoldsUpward).toBe(true);

    await fixturePage.evaluate(() => {
      const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
      const minBtn = sr?.querySelector<HTMLButtonElement>('button[data-ps-action="minimize"]');
      minBtn?.click();
    });
    const minimizedCheck = await fixturePage.evaluate(() => {
      const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
      const bar = sr?.querySelector<HTMLElement>('.ps-minbar');
      return Boolean(bar && getComputedStyle(bar).display !== 'none');
    });
    expect(minimizedCheck).toBe(true);

    await fixturePage.evaluate(() => {
      const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
      const expandBtn = sr?.querySelector<HTMLButtonElement>('button[data-ps-action="expand"]');
      expandBtn?.click();
    });

    await fixturePage.evaluate(() => {
      const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
      sr?.querySelector<HTMLButtonElement>('button[data-overlay-bar-tool="responsive"]')?.click();
    });
    const directRespState = await fixturePage.evaluate(() => {
      const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
      const wide = sr?.querySelector<HTMLElement>('.ps-drawer.ps-drawer-wide.open');
      const frame = wide?.querySelector<HTMLIFrameElement>(
        'iframe[name="pagesift-responsive-frame"]',
      );
      sr?.querySelector<HTMLButtonElement>('button[data-ps-resp-mode="grid"]')?.click();
      const gridFrames =
        sr?.querySelectorAll('iframe[name="pagesift-responsive-frame"]').length ?? 0;
      sr?.querySelector<HTMLButtonElement>('button[data-ps-resp-rotate="true"]')?.click();
      const rotatedW =
        sr?.querySelector<HTMLInputElement>('input[data-ps-resp-width]')?.value ?? '';
      return {
        wideOpen: Boolean(wide),
        firstFrameStyleW: frame?.style.width ?? '',
        gridFrames,
        rotatedW,
      };
    });
    expect(directRespState.wideOpen).toBe(true);
    expect(directRespState.firstFrameStyleW).toBe('375px');
    expect(directRespState.gridFrames).toBe(2);
    expect(directRespState.rotatedW).toBe('812');

    await fixturePage.evaluate(() => {
      const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
      sr?.querySelector<HTMLButtonElement>('button[data-overlay-bar-tool="capture"]')?.click();
    });
    await fixturePage.waitForFunction(
      () => {
        const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
        const img = sr?.querySelector<HTMLImageElement>('img.ps-capture-preview');
        return Boolean(img && img.src.startsWith('data:image/png'));
      },
      undefined,
      { polling: 100, timeout: 10000 },
    );

    await fixturePage.evaluate(() => {
      const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
      const colorsBtn = sr?.querySelector<HTMLButtonElement>(
        'button[data-overlay-bar-tool="colors"]',
      );
      colorsBtn?.click();
    });
    await fixturePage.waitForFunction(
      () => {
        const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
        return (sr?.querySelector('.ps-drawer-content')?.textContent ?? '').includes(
          'Color Palette',
        );
      },
      undefined,
      { polling: 100, timeout: 10000 },
    );

    await fixturePage.evaluate(() => {
      const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
      sr?.querySelector<HTMLButtonElement>('button[data-overlay-bar-tool="tech_stack"]')?.click();
    });
    await fixturePage.waitForFunction(
      () => {
        const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
        const text = sr?.querySelector('.ps-drawer-content')?.textContent ?? '';
        return text.includes('Tech Stack');
      },
      undefined,
      { polling: 100, timeout: 10000 },
    );

    await fixturePage.evaluate(() => {
      const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
      sr?.querySelector<HTMLButtonElement>('button[data-ps-action="pip-menu"]')?.click();
      sr?.querySelector<HTMLButtonElement>('button[data-ps-action="customize"]')?.click();
    });
    const customDockMoved = await fixturePage.evaluate(() => {
      const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
      const sel = sr?.querySelector<HTMLSelectElement>('.ps-drawer select.ps-field');
      if (!sel) return false;
      sel.value = 'bottom-right';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const dock = sr?.querySelector<HTMLElement>('.ps-panel');
      const movedRight = Boolean(
        dock && dock.getBoundingClientRect().right > window.innerWidth - 40,
      );
      sel.value = 'bottom-center';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return movedRight;
    });
    expect(customDockMoved).toBe(true);

    await fixturePage.evaluate(() => {
      const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
      const inspectBtn = sr?.querySelector<HTMLButtonElement>(
        'button[data-overlay-bar-tool="inspect"]',
      );
      inspectBtn?.click();
    });
    const minimizedForPick = await fixturePage.evaluate(() => {
      const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
      const bar = sr?.querySelector<HTMLElement>('.ps-minbar');
      return Boolean(bar && getComputedStyle(bar).display !== 'none');
    });
    expect(minimizedForPick).toBe(true);

    await fixturePage.locator('#hero-title').click();
    await fixturePage.waitForFunction(
      () => {
        const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
        const panel = sr?.querySelector<HTMLElement>('.ps-panel');
        const resText = sr?.querySelector('.ps-drawer-content')?.textContent ?? '';
        return (
          Boolean(panel && getComputedStyle(panel).display !== 'none') &&
          resText.includes('hero-title')
        );
      },
      undefined,
      { polling: 100, timeout: 10000 },
    );

    const [handedOffWorkspace] = await Promise.all([
      context.waitForEvent('page'),
      fixturePage.evaluate(() => {
        const sr = document.getElementById('pagesift-root-host')?.shadowRoot;
        sr?.querySelector<HTMLButtonElement>('button[data-ps-action="pip-menu"]')?.click();
        const openBtn = sr?.querySelector<HTMLButtonElement>(
          'button[data-ps-action="open-dashboard"]',
        );
        openBtn?.click();
      }),
    ]);
    await probePage.close();
    await handedOffWorkspace.waitForLoadState('domcontentloaded');

    await handedOffWorkspace.click('button[data-tool="colors"]');
    await handedOffWorkspace.click('#run-tool-btn');
    await waitForWorkspaceStatus(handedOffWorkspace, 'Completed ', 15000);
    expect(await handedOffWorkspace.locator('.swatch-card').count()).toBeGreaterThan(0);

    await handedOffWorkspace.selectOption('#colors-export-format', 'tailwindV4');
    const twPreview =
      (await handedOffWorkspace
        .locator('#structured-result-container pre.code-box')
        .textContent()) ?? '';
    expect(twPreview).toContain('@theme');

    await handedOffWorkspace.click('button[data-tool="inspect"]');
    await handedOffWorkspace.fill('#target-selector-input', '#hero-title');
    await handedOffWorkspace.click('#run-tool-btn');
    await waitForWorkspaceStatus(handedOffWorkspace, 'Completed ', 10000);
    expect(await handedOffWorkspace.locator('.box-model').count()).toBe(1);

    await handedOffWorkspace.click('#nav-history-btn');
    await handedOffWorkspace.waitForFunction(
      () => document.querySelectorAll('.timeline-row').length >= 2,
      undefined,
      { polling: 100, timeout: 10000 },
    );

    const historyText =
      (await handedOffWorkspace.locator('#history-timeline-list').textContent()) ?? '';
    expect(historyText).toContain('Action duration:');
    expect(historyText).not.toContain('NEVER_STORE_IN_HISTORY');
    expect(historyText).not.toContain('private-hash');

    await handedOffWorkspace.selectOption('#history-group-mode', 'session');
    expect(
      await handedOffWorkspace.locator('.timeline-group-header button').count(),
    ).toBeGreaterThan(0);
    await handedOffWorkspace.selectOption('#history-group-mode', 'day');

    const countBeforePause = await handedOffWorkspace.locator('.timeline-row').count();
    await handedOffWorkspace.uncheck('#history-recording-toggle');
    await handedOffWorkspace.click('button[data-tool="fonts"]');
    await handedOffWorkspace.click('#run-tool-btn');
    await waitForWorkspaceStatus(handedOffWorkspace, 'Completed ', 10000);
    await handedOffWorkspace.click('#nav-history-btn');
    await handedOffWorkspace.waitForTimeout(250);
    const countAfterPause = await handedOffWorkspace.locator('.timeline-row').count();
    expect(countAfterPause).toBe(countBeforePause);
    await handedOffWorkspace.check('#history-recording-toggle');

    await handedOffWorkspace.click('#history-clear-btn');
    expect(
      await handedOffWorkspace.evaluate(
        () => document.getElementById('clear-history-modal')?.classList.contains('open') === true,
      ),
    ).toBe(true);
    await handedOffWorkspace.keyboard.press('Escape');
    const clearModalClosed = await handedOffWorkspace.evaluate(() => ({
      closed: document.getElementById('clear-history-modal')?.classList.contains('open') === false,
      focusedId: document.activeElement?.id ?? '',
    }));
    expect(clearModalClosed.closed).toBe(true);
    expect(clearModalClosed.focusedId).toBe('history-clear-btn');

    await handedOffWorkspace.click('#nav-tools-btn');
    await handedOffWorkspace.click('#toggle-sidebar-btn');
    expect(
      await handedOffWorkspace.evaluate(
        () =>
          document.getElementById('workspace-body')?.classList.contains('rail-collapsed') === true,
      ),
    ).toBe(true);
    await handedOffWorkspace.reload({ waitUntil: 'domcontentloaded' });
    await handedOffWorkspace.waitForFunction(
      () =>
        document.getElementById('workspace-body')?.classList.contains('rail-collapsed') === true,
      undefined,
      { polling: 100, timeout: 10000 },
    );
    await handedOffWorkspace.click('#toggle-sidebar-btn');

    await fixturePage.bringToFront();
    await fixturePage.keyboard.press('Escape');
    const overlayDismissed = await fixturePage.evaluate(
      () => document.getElementById('pagesift-root-host') === null,
    );
    expect(overlayDismissed).toBe(true);

    const mockAiRequests: Array<{ auth: string; body: string }> = [];
    const mockAiServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        mockAiRequests.push({
          auth: req.headers['authorization'] ?? '',
          body,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-custom-local',
            model: 'custom-tech-explainer',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'CUSTOM_AI_TECH_SUMMARY: Organized architecture stack verified.',
                },
                finish_reason: 'stop',
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      mockAiServer.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const mockAiAddr = mockAiServer.address();
    const mockAiPort = typeof mockAiAddr === 'object' && mockAiAddr ? mockAiAddr.port : 0;

    try {
      const optionsPage = await context.newPage();
      await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, {
        waitUntil: 'domcontentloaded',
      });
      await optionsPage.selectOption('#opt-ai-provider', 'custom');
      await optionsPage.fill('#opt-ai-endpoint', 'http://169.254.169.254/v1/chat/completions');
      await optionsPage.click('#save-ai-config-btn');
      await optionsPage.waitForFunction(
        () =>
          (document.getElementById('options-status-banner')?.textContent ?? '').includes(
            'Save failed',
          ),
        undefined,
        { polling: 100, timeout: 10000 },
      );

      await optionsPage.fill(
        '#opt-ai-endpoint',
        `http://127.0.0.1:${mockAiPort}/v1/chat/completions`,
      );
      await optionsPage.fill('#opt-nvidia-model', 'custom-tech-explainer');
      await optionsPage.click('#save-ai-config-btn');
      await optionsPage.waitForFunction(
        () =>
          (document.getElementById('options-status-banner')?.textContent ?? '').includes('saved'),
        undefined,
        { polling: 100, timeout: 10000 },
      );
      await optionsPage.fill('#nvidia-api-key-input', 'sk-any-custom-key-9876543210');
      await optionsPage.click('#set-nvidia-key-btn');
      await optionsPage.waitForFunction(
        () =>
          (document.getElementById('nvidia-key-status')?.textContent ?? '').includes(
            'Active in session',
          ),
        undefined,
        { polling: 100, timeout: 10000 },
      );

      const activityStat = (await optionsPage.locator('#stat-activities').textContent()) ?? '0';
      expect(Number.parseInt(activityStat, 10)).toBeGreaterThanOrEqual(1);
      await optionsPage.click('#clear-all-data-btn');
      expect(
        await optionsPage.evaluate(
          () => document.getElementById('confirm-clear-modal')?.classList.contains('open') === true,
        ),
      ).toBe(true);
      await optionsPage.keyboard.press('Escape');
      expect(
        await optionsPage.evaluate(
          () =>
            document.getElementById('confirm-clear-modal')?.classList.contains('open') === false,
        ),
      ).toBe(true);
      await optionsPage.close();

      await handedOffWorkspace.bringToFront();
      await handedOffWorkspace.click('button[data-tool="tech_stack"]');
      const tapClassTriggered = await handedOffWorkspace.evaluate(
        () =>
          document
            .querySelector('button[data-tool="tech_stack"]')
            ?.classList.contains('tap-confirm') ?? false,
      );
      expect(tapClassTriggered).toBe(true);
      await handedOffWorkspace.click('#run-tool-btn');
      await waitForWorkspaceStatus(handedOffWorkspace, 'Completed ', 10000);
      await handedOffWorkspace.click('#preview-nvidia-btn');
      await handedOffWorkspace.waitForFunction(
        () => document.getElementById('nvidia-preview-modal')?.classList.contains('open') === true,
        undefined,
        { polling: 100, timeout: 10000 },
      );
      const modalFocusInDialog = await handedOffWorkspace.evaluate(
        () => document.activeElement?.id === 'nvidia-modal-close-btn',
      );
      expect(modalFocusInDialog).toBe(true);
      await handedOffWorkspace.click('#nvidia-modal-confirm-btn');
      await waitForWorkspaceStatus(handedOffWorkspace, 'Optional AI enhancement completed.', 15000);
      expect(mockAiRequests.length).toBe(1);
      expect(mockAiRequests[0]?.auth).toBe('Bearer sk-any-custom-key-9876543210');

      await handedOffWorkspace.click('#preview-nvidia-btn');
      await handedOffWorkspace.waitForFunction(
        () => document.getElementById('nvidia-preview-modal')?.classList.contains('open') === true,
        undefined,
        { polling: 100, timeout: 10000 },
      );
      await handedOffWorkspace.keyboard.press('Escape');
      const modalClosedAndRestored = await handedOffWorkspace.evaluate(() => ({
        closed:
          document.getElementById('nvidia-preview-modal')?.classList.contains('open') === false,
        focusedId: document.activeElement?.id ?? '',
      }));
      expect(modalClosedAndRestored.closed).toBe(true);
      expect(modalClosedAndRestored.focusedId).toBe('preview-nvidia-btn');
    } finally {
      await new Promise<void>((resolve) => {
        mockAiServer.close(() => {
          resolve();
        });
      });
    }

    const beforeTheme = await handedOffWorkspace.evaluate(
      () => document.documentElement.getAttribute('data-theme-pref') ?? 'system',
    );
    await handedOffWorkspace.click('#theme-toggle-btn');
    const toggledTheme = await handedOffWorkspace.evaluate(
      () => document.documentElement.getAttribute('data-theme-pref') ?? 'system',
    );
    expect(toggledTheme).not.toBe(beforeTheme);
    await handedOffWorkspace.reload({ waitUntil: 'domcontentloaded' });
    await handedOffWorkspace.waitForFunction(
      (expected: string) => document.documentElement.getAttribute('data-theme-pref') === expected,
      toggledTheme,
      { polling: 100, timeout: 10000 },
    );

    const viewports = [
      { width: 360, height: 740 },
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
      { width: 1280, height: 800 },
      { width: 1440, height: 900 },
    ];
    for (const vp of viewports) {
      await handedOffWorkspace.setViewportSize(vp);
      const layoutMetrics = await handedOffWorkspace.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        menuVisible:
          getComputedStyle(document.getElementById('mobile-menu-btn') as HTMLElement).display !==
          'none',
      }));
      expect(layoutMetrics.scrollWidth).toBeLessThanOrEqual(layoutMetrics.innerWidth + 1);
      if (vp.width < 900) {
        expect(layoutMetrics.menuVisible).toBe(true);
      }
    }

    await handedOffWorkspace.setViewportSize({ width: 1280, height: 800 });
    const zoomMetrics = await handedOffWorkspace.evaluate(async () => {
      const chromeTabs = (
        globalThis as unknown as {
          chrome: {
            tabs: {
              getCurrent: () => Promise<{ id?: number } | undefined>;
              setZoom: (tabId: number, zoomFactor: number) => Promise<void>;
              getZoom: (tabId: number) => Promise<number>;
            };
          };
        }
      ).chrome.tabs;
      const current = await chromeTabs.getCurrent();
      if (!current || typeof current.id !== 'number') {
        throw new Error('Could not resolve current workspace tab for 200% browser zoom check');
      }
      await chromeTabs.setZoom(current.id, 2.0);
      await new Promise((r) => setTimeout(r, 150));
      const actualZoom = await chromeTabs.getZoom(current.id);
      const scrollWidth = document.documentElement.scrollWidth;
      const innerWidth = window.innerWidth;
      const menuVisible =
        getComputedStyle(document.getElementById('mobile-menu-btn') as HTMLElement).display !==
        'none';
      await chromeTabs.setZoom(current.id, 1.0);
      return { actualZoom, scrollWidth, innerWidth, menuVisible };
    });
    expect(zoomMetrics.actualZoom).toBeCloseTo(2.0, 1);
    expect(zoomMetrics.innerWidth).toBeLessThanOrEqual(700);
    expect(zoomMetrics.scrollWidth).toBeLessThanOrEqual(zoomMetrics.innerWidth + 2);
    expect(zoomMetrics.menuVisible).toBe(true);

    await handedOffWorkspace.setViewportSize({ width: 360, height: 740 });
    await handedOffWorkspace.click('#mobile-menu-btn');
    expect(
      await handedOffWorkspace.evaluate(
        () => document.getElementById('tool-dock')?.classList.contains('open') === true,
      ),
    ).toBe(true);
    await handedOffWorkspace.keyboard.press('Escape');
    expect(
      await handedOffWorkspace.evaluate(
        () => document.getElementById('tool-dock')?.classList.contains('open') === false,
      ),
    ).toBe(true);

    expect(runtimeErrors).toEqual([]);
    await handedOffWorkspace.close();
    await fixturePage.close();
  }, 90000);
});
