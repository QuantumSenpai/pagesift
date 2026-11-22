import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { BackgroundCoordinator } from '../../src/extension/background/service-worker.js';
import { ContentScriptRuntime } from '../../src/extension/content/content-script.js';
import {
  buildPdfDocumentFromCapture,
  type CaptureTile,
} from '../../src/extension/engines/capture-engine.js';
import type {
  MessageOperation,
  RuntimeMessageEnvelope,
} from '../../src/extension/protocol/messages.js';
import { LocalExtensionStorage } from '../../src/extension/storage/idb-storage.js';
import {
  ExtensionSettingsStore,
  InMemoryKeyValueArea,
} from '../../src/extension/storage/settings-storage.js';

const TEST_EXT_ID = 'cccccccccccccccccccccccccccccccc';

function buildRichControlledFixtureDom(): JSDOM {
  const largeGridItems = Array.from(
    { length: 300 },
    (_, idx) =>
      `<article class="card flex items-center justify-between px-4 py-2 rounded-lg" data-idx="${idx}">
        <h3>Card ${idx} — 日本語・العربية・🚀・Ñandú</h3>
        <p>Nested description ${idx}</p>
      </article>`,
  ).join('\n');

  return new JSDOM(
    `<!DOCTYPE html>
    <html lang="en" data-wf-site="wf-fixture">
      <head>
        <meta charset="UTF-8" />
        <title>PageSift Controlled Fixture — 日本語・🚀</title>
        <meta name="generator" content="Astro v4.15" />
        <link rel="icon" href="https://fixture.example.com/favicon.ico" />
        <script src="https://fixture.example.com/_next/static/chunks/app.js"></script>
        <style>
          :root {
            --brand-primary: #2563eb;
            --brand-surface: #0f172a;
            --tw-ring-color: #3b82f6;
          }
          @font-face {
            font-family: "InterVar";
            src: url("https://fixture.example.com/fonts/inter.woff2") format("woff2");
            font-weight: 600;
          }
          body {
            font-family: "InterVar", sans-serif;
            font-size: 16px;
            color: rgb(15, 23, 42);
            background-color: rgb(255, 255, 255);
          }
          header.sticky-bar {
            position: sticky;
            top: 0;
            display: flex;
            justify-content: space-between;
            padding: 16px 24px;
            background-color: rgb(15, 23, 42);
            color: rgb(255, 255, 255);
          }
          .hero-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 24px;
            padding: 32px;
            border-radius: 12px;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
            background-image: linear-gradient(135deg, rgb(37, 99, 235), rgb(124, 58, 237));
          }
          .low-contrast-note {
            color: rgb(209, 213, 219);
            background-color: rgb(255, 255, 255);
            padding: 7px 13px 19px;
            filter: blur(2px);
          }
        </style>
      </head>
      <body>
        <div id="__next">
          <header class="sticky-bar" role="banner">
            <nav aria-label="Main Navigation"><a href="/features">Features</a></nav>
            <button id="cta-btn" type="button">Launch Workspace</button>
          </header>
          <main>
            <section id="hero" class="hero-grid" onclick="maliciousInlineHandler()">
              <h1 id="main-heading">Design Intelligence <span>v1</span></h1>
              <p class="low-contrast-note">Subtle low-contrast caption</p>
              <img src="/assets/hero-preview.png" srcset="/assets/hero-preview-2x.png 2x" loading="lazy" alt="Hero Preview" width="640" height="360" />
              <video src="blob:https://fixture.example.com/999" poster="/assets/video-poster.jpg"></video>
              <svg id="hero-svg" width="64" height="64" onload="evilSvgLoad()">
                <script>window.xss = 1;</script>
                <rect width="64" height="64" rx="12" fill="#2563eb" />
              </svg>
              <form action="https://fixture.example.com/login">
                <input type="text" name="username" value="private_user_handle" />
                <input type="password" name="password" value="ultra_secret_password_value" />
              </form>
            </section>
            <div id="open-shadow-mount"></div>
            <div id="nested-scroll" style="overflow-y: auto; max-height: 300px;">
              ${largeGridItems}
            </div>
            <iframe src="https://cross-origin.example.org/embed"></iframe>
          </main>
          <footer>PageSift Footer</footer>
        </div>
      </body>
    </html>`,
    { url: 'https://fixture.example.com/product?session_token=secret123' },
  );
}

describe('Extension Coordinator, Content Script Runtime, Controlled Fixtures, and Zero-AI Local Guarantee', () => {
  it('executes all 15 local tools across the rich controlled fixture with zero external AI network calls and within performance budget', async () => {
    const dom = buildRichControlledFixtureDom();
    const shadowMount = dom.window.document.querySelector('#open-shadow-mount');
    if (shadowMount) {
      const sr = shadowMount.attachShadow({ mode: 'open' });
      const badge = dom.window.document.createElement('span');
      badge.id = 'shadow-badge';
      badge.textContent = 'Open Shadow Component';
      sr.appendChild(badge);
    }

    const contentRuntime = new ContentScriptRuntime(
      dom.window.document,
      dom.window as unknown as Window,
    );
    contentRuntime.init();

    const dbName = `pagesift_coord_test_${Date.now()}`;
    const storage = new LocalExtensionStorage(dbName);
    const settingsStore = new ExtensionSettingsStore(
      new InMemoryKeyValueArea(),
      new InMemoryKeyValueArea(),
    );

    const fixtureJpegBytes = new Uint8Array(20);
    fixtureJpegBytes[0] = 0xff;
    fixtureJpegBytes[1] = 0xd8;
    fixtureJpegBytes[2] = 0xff;
    fixtureJpegBytes[3] = 0xc0;
    fixtureJpegBytes[4] = 0x00;
    fixtureJpegBytes[5] = 0x0b;
    fixtureJpegBytes[6] = 0x08;
    const jpegView = new DataView(fixtureJpegBytes.buffer);
    jpegView.setUint16(7, 800, false);
    jpegView.setUint16(9, 1280, false);
    fixtureJpegBytes[18] = 0xff;
    fixtureJpegBytes[19] = 0xd9;
    const fixtureJpegDataUrl = `data:image/jpeg;base64,${Buffer.from(fixtureJpegBytes).toString('base64')}`;

    const fixturePngBytes = new Uint8Array(33);
    fixturePngBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    fixturePngBytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
    const pngView = new DataView(fixturePngBytes.buffer);
    pngView.setUint32(16, 1280, false);
    pngView.setUint32(20, 800, false);
    fixturePngBytes[24] = 8;
    fixturePngBytes[25] = 6;
    const fixturePngDataUrl = `data:image/png;base64,${Buffer.from(fixturePngBytes).toString('base64')}`;

    let aiFetchCallCount = 0;
    const coordinator = new BackgroundCoordinator({
      extensionId: TEST_EXT_ID,
      storage,
      settingsStore,
      sendToTab: (_tabId, message) => contentRuntime.handleMessage(message),
      getTabInfo: (tabId) =>
        Promise.resolve({
          id: tabId,
          windowId: 1,
          url: 'https://fixture.example.com/product?session_token=secret123',
          active: true,
        }),
      captureVisibleTab: () => Promise.resolve(fixturePngDataUrl),
      composeCaptureImpl: ({ tiles, exportMime, title, pageUrl }) => {
        const first: CaptureTile | undefined = tiles[0];
        if (!first) {
          throw new Error('No tiles captured');
        }
        if (exportMime === 'application/pdf') {
          return Promise.resolve({
            dataUrl: buildPdfDocumentFromCapture({
              width: 1280,
              height: 800,
              title,
              pageUrl,
              jpegDataUrl: fixtureJpegDataUrl,
            }),
            width: 1280,
            height: 800,
            mimeType: 'application/pdf',
          });
        }
        return Promise.resolve({
          dataUrl: fixturePngDataUrl,
          width: 1280,
          height: 800,
          mimeType: 'image/png',
        });
      },
      captureMinIntervalMs: 1,
      openResponsiveWindow: (_url, width, height) =>
        Promise.resolve({ windowId: width, tabId: width + height }),
      fetchImpl: (input) => {
        const urlStr =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (urlStr.includes('integrate.api.nvidia.com')) {
          aiFetchCallCount += 1;
          return Promise.reject(new Error('Unexpected AI call during local tool operation'));
        }
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
      },
    });

    const trustedUiSender = {
      id: TEST_EXT_ID,
      url: `chrome-extension://${TEST_EXT_ID}/workspace.html`,
    };

    const sendOp = async (operation: MessageOperation, payload: Record<string, unknown> = {}) => {
      const msg: RuntimeMessageEnvelope = {
        schemaVersion: 1,
        requestId: `req-${operation}-${Date.now()}`,
        operation,
        tabId: 1,
        documentId: contentRuntime.documentId,
        payload,
      };
      return coordinator.handleRuntimeMessage(msg, trustedUiSender);
    };

    try {
      const startedAt = performance.now();

      const inspectRes = await sendOp('RUN_INSPECT_ELEMENT', { selector: '#hero' });
      expect(inspectRes.ok).toBe(true);

      const colorsRes = await sendOp('RUN_COLORS_EXTRACT');
      expect(colorsRes.ok).toBe(true);

      const fontsRes = await sendOp('RUN_FONTS_EXTRACT');
      expect(fontsRes.ok).toBe(true);

      const measureRes = await sendOp('RUN_MEASURE', {
        primarySelector: '#main-heading',
        secondarySelector: '#cta-btn',
      });
      expect(measureRes.ok).toBe(true);

      const assetsRes = await sendOp('RUN_ASSETS_EXTRACT', { includeZip: true });
      expect(assetsRes.ok).toBe(true);

      const designMdRes = await sendOp('RUN_DESIGN_MD');
      expect(designMdRes.ok).toBe(true);

      const clonePromptRes = await sendOp('RUN_CLONE_PROMPT', {
        targetFramework: 'react_tailwind',
      });
      expect(clonePromptRes.ok).toBe(true);

      const clonePageRes = await sendOp('RUN_CLONE_PAGE');
      expect(clonePageRes.ok).toBe(true);

      const editTextRes = await sendOp('RUN_EDIT_TEXT', {
        selector: '#main-heading',
        text: 'Local Preview Heading ',
      });
      expect(editTextRes.ok).toBe(true);

      const swapFontRes = await sendOp('RUN_SWAP_FONT', {
        selector: '#main-heading',
        scope: 'element',
        fontFamily: 'monospace',
      });
      expect(swapFontRes.ok).toBe(true);

      const arrangeRes = await sendOp('RUN_ARRANGE', {
        selector: '#cta-btn',
        action: 'move',
        dx: 12,
        dy: 8,
      });
      expect(arrangeRes.ok).toBe(true);

      const undoRes = await sendOp('EDIT_UNDO');
      expect(undoRes.ok).toBe(true);
      const redoRes = await sendOp('EDIT_REDO');
      expect(redoRes.ok).toBe(true);
      const resetRes = await sendOp('EDIT_RESET');
      expect(resetRes.ok).toBe(true);

      const capturePdfRes = await sendOp('RUN_CAPTURE', {
        mode: 'visible',
        exportMime: 'application/pdf',
        title: 'Fixture PDF',
      });
      expect(capturePdfRes.ok).toBe(true);

      const responsiveRes = await sendOp('RUN_RESPONSIVE_INSPECT', {
        targetUrl: 'https://fixture.example.com/product',
        openWindows: true,
      });
      expect(responsiveRes.ok).toBe(true);

      const designReviewRes = await sendOp('RUN_DESIGN_REVIEW');
      expect(designReviewRes.ok).toBe(true);

      const techStackRes = await sendOp('RUN_TECH_STACK');
      expect(techStackRes.ok).toBe(true);

      const totalElapsedMs = performance.now() - startedAt;
      expect(totalElapsedMs).toBeLessThan(2500);
      expect(aiFetchCallCount).toBe(0);

      expect(dom.window.localStorage.length).toBe(0);
      expect(dom.window.sessionStorage.length).toBe(0);
    } finally {
      contentRuntime.dispose();
      await storage.close();
    }
  });

  it('rejects stale documentId after navigation and recovers interrupted jobs on worker startup', async () => {
    const dom = buildRichControlledFixtureDom();
    const runtime = new ContentScriptRuntime(dom.window.document, dom.window as unknown as Window);

    const staleRes = await runtime.handleMessage({
      schemaVersion: 1,
      requestId: 'req-stale-1',
      operation: 'RUN_INSPECT_ELEMENT',
      documentId: 'doc-from-previous-navigation-000',
      payload: { selector: '#hero' },
    });
    expect(staleRes.ok).toBe(false);
    if (!staleRes.ok) {
      expect(staleRes.error.code).toBe('STALE_DOCUMENT');
    }

    const dbName = `pagesift_worker_recovery_${Date.now()}`;
    const storage = new LocalExtensionStorage(dbName);
    const settingsStore = new ExtensionSettingsStore(
      new InMemoryKeyValueArea(),
      new InMemoryKeyValueArea(),
    );

    try {
      await storage.StartToolJob({
        id: 'job-in-flight-99',
        tool: 'clone_page',
        tabId: 7,
        documentId: runtime.documentId,
      });

      const openedTabs: string[] = [];
      const openedWindows: Array<{ url: string; width: number; height: number }> = [];
      const coordinator = new BackgroundCoordinator({
        extensionId: TEST_EXT_ID,
        storage,
        settingsStore,
        sendToTab: (_tabId, msg) => runtime.handleMessage(msg),
        openDashboardTab: (relativeUrl) => {
          openedTabs.push(relativeUrl);
          return Promise.resolve();
        },
        openDashboardWindow: (relativeUrl, width, height) => {
          openedWindows.push({ url: relativeUrl, width, height });
          return Promise.resolve({ windowId: 77, tabId: 88 });
        },
      });
      const initResult = await coordinator.initialize();
      expect(initResult.recoveredJobsCount).toBe(1);

      const recoveredJob = await storage.getJob('job-in-flight-99');
      expect(recoveredJob?.status).toBe('interrupted');

      const click1 = await coordinator.handleActionClicked({
        id: 7,
        url: 'https://fixture.example.com/product',
      });
      expect(click1.opened).toBe('overlay');
      const click2 = await coordinator.handleActionClicked({
        id: 7,
        url: 'https://fixture.example.com/product',
      });
      expect(click2.opened).toBe('dashboard_double_click');
      expect(openedTabs.some((u) => u.startsWith('workspace.html?tabId=7'))).toBe(true);

      const pipRes = await coordinator.handleRuntimeMessage(
        {
          schemaVersion: 1,
          requestId: 'req-pip-dash-1',
          operation: 'OPEN_FULL_DASHBOARD',
          documentId: runtime.documentId,
          payload: { mode: 'pip', tool: 'clone_prompt', aiTask: 'extract_features' },
        },
        {
          id: TEST_EXT_ID,
          url: 'https://fixture.example.com/product',
          tab: { id: 7, url: 'https://fixture.example.com/product' },
        },
      );
      expect(pipRes.ok).toBe(true);
      expect(openedWindows.length).toBe(1);
      expect(openedWindows[0]?.url).toContain('pip=1');
      expect(openedWindows[0]?.url).toContain('aiTask=extract_features');
    } finally {
      runtime.dispose();
      await storage.close();
    }
  });
});
