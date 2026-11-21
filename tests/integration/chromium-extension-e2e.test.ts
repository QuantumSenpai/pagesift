import { strFromU8, unzipSync } from 'fflate';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en" data-wf-site="wf-e2e-live">
  <head>
    <meta charset="UTF-8" />
    <title>PageSift Live Chromium E2E Fixture — 日本語・🚀</title>
    <meta name="generator" content="Astro v4.15" />
    <link rel="icon" href="/favicon.ico" />
    <style>
      :root {
        --brand-primary: #2563eb;
        --brand-accent: #7c3aed;
        --tw-ring-color: #3b82f6;
      }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 16px;
        color: #0f172a;
        background-color: #ffffff;
      }
      header#sticky-header {
        position: sticky;
        top: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 32px;
        background-color: #0f172a;
        color: #f8fafc;
      }
      section#hero-section {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 24px;
        padding: 40px 32px;
        margin: 16px;
        border-radius: 12px;
        background-image: linear-gradient(135deg, #2563eb, #7c3aed);
        box-shadow: 0 12px 24px rgba(15, 23, 42, 0.15);
      }
      .low-contrast {
        color: #d1d5db;
        background-color: #ffffff;
        padding: 7px 13px 19px;
      }
    </style>
  </head>
  <body>
    <div id="__next">
      <header id="sticky-header">
        <nav aria-label="Primary"><a id="nav-link" href="/docs">Documentation</a></nav>
        <button id="primary-cta" type="button" class="flex items-center justify-between px-4 py-2 rounded-lg">Get Started</button>
      </header>
      <main>
        <section id="hero-section">
          <div>
            <h1 id="hero-title">Visual Design Extraction <strong>Pro</strong></h1>
            <p id="hero-copy" class="low-contrast">Inspect styles, tokens, assets, and static snapshots locally.</p>
          </div>
          <div>
            <svg id="inline-logo" width="72" height="72" viewBox="0 0 72 72">
              <circle cx="36" cy="36" r="30" fill="#38bdf8" />
            </svg>
          </div>
        </section>
        <form id="sensitive-form" action="/login">
          <input type="text" name="email" value="private_customer@example.com" />
          <input type="password" name="secret_pw" value="NEVER_EXPORT_THIS_PASSWORD_999" />
        </form>
        <div id="shadow-mount"></div>
      </main>
      <footer id="page-footer">PageSift E2E Footer</footer>
    </div>
    <script>
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

describe('Real Chromium Manifest V3 Extension End-to-End Verification', () => {
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
      if (req.url?.startsWith('/fixture')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(FIXTURE_HTML);
        return;
      }
      res.writeHead(404);
      res.end();
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

    const swUrlParts = serviceWorker.url().split('/');
    extensionId = swUrlParts[2] ?? '';
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

  it('loads the MV3 service worker, injects the content script, runs all 15 tools in real Chromium, verifies exported snapshot HTML in an isolated tab, and preserves website storage privacy', async () => {
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

    const callContentViaExtension = async (
      operation: string,
      payload: Record<string, unknown> = {},
    ): Promise<ExtensionMessageResponse> => {
      return workspacePage.evaluate(
        async ({ tId, op, pl }) => {
          const chromeTabs = (
            globalThis as unknown as {
              chrome: {
                tabs: {
                  sendMessage: (id: number, msg: unknown) => Promise<ExtensionMessageResponse>;
                };
              };
            }
          ).chrome.tabs;
          return chromeTabs.sendMessage(tId, {
            schemaVersion: 1,
            requestId: `e2e-${op}-${Date.now()}`,
            operation: op,
            tabId: tId,
            payload: pl,
          });
        },
        { tId: tabId, op: operation, pl: payload },
      );
    };

    const callBackgroundViaExtension = async (
      operation: string,
      payload: Record<string, unknown> = {},
    ): Promise<ExtensionMessageResponse> => {
      return workspacePage.evaluate(
        async ({ op, pl, tId }) => {
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
            requestId: `e2e-bg-${op}-${Date.now()}`,
            operation: op,
            tabId: tId,
            payload: pl,
          });
        },
        { op: operation, pl: payload, tId: tabId },
      );
    };

    const pingRes = await callContentViaExtension('GET_DOCUMENT_CONTEXT');
    expect(pingRes.ok).toBe(true);

    const inspectRes = await callContentViaExtension('RUN_INSPECT_ELEMENT', {
      selector: '#hero-section',
    });
    expect(inspectRes.ok).toBe(true);

    const colorsRes = await callContentViaExtension('RUN_COLORS_EXTRACT');
    expect(colorsRes.ok).toBe(true);

    const fontsRes = await callContentViaExtension('RUN_FONTS_EXTRACT');
    expect(fontsRes.ok).toBe(true);

    const measureRes = await callContentViaExtension('RUN_MEASURE', {
      primarySelector: '#hero-title',
      secondarySelector: '#primary-cta',
    });
    expect(measureRes.ok).toBe(true);

    const assetsRes = await callContentViaExtension('RUN_ASSETS_EXTRACT', {
      includeZip: true,
    });
    expect(assetsRes.ok).toBe(true);

    const designMdRes = await callContentViaExtension('RUN_DESIGN_MD');
    expect(designMdRes.ok).toBe(true);

    const clonePromptRes = await callContentViaExtension('RUN_CLONE_PROMPT', {
      targetFramework: 'react_tailwind',
    });
    expect(clonePromptRes.ok).toBe(true);

    const clonePageRes = await callContentViaExtension('RUN_CLONE_PAGE');
    expect(clonePageRes.ok).toBe(true);
    if (clonePageRes.ok) {
      const data = clonePageRes.data as { zipBase64: string };
      const zipBytes = new Uint8Array(Buffer.from(data.zipBase64, 'base64'));
      const unzipped = unzipSync(zipBytes);
      const exportedHtml = strFromU8(unzipped['index.html'] ?? new Uint8Array());
      expect(exportedHtml).not.toContain('NEVER_EXPORT_THIS_PASSWORD_999');
      expect(exportedHtml).not.toContain('<script>');

      const snapshotViewerPage = await context.newPage();
      snapshotViewerPage.on('pageerror', (err) => {
        runtimeErrors.push(`snapshot-viewer: ${err.message}`);
      });
      await snapshotViewerPage.setContent(exportedHtml, { waitUntil: 'domcontentloaded' });
      const renderedHeading = await snapshotViewerPage.locator('#hero-title').textContent();
      expect(renderedHeading).toContain('Visual Design Extraction');
      await snapshotViewerPage.close();
    }

    const editTextRes = await callContentViaExtension('RUN_EDIT_TEXT', {
      selector: '#hero-title',
      text: 'Edited In Real Chromium ',
    });
    expect(editTextRes.ok).toBe(true);
    expect(await fixturePage.locator('#hero-title').innerHTML()).toContain(
      'Edited In Real Chromium ',
    );
    expect(await fixturePage.locator('#hero-title strong').textContent()).toBe('Pro');

    const swapFontRes = await callContentViaExtension('RUN_SWAP_FONT', {
      selector: '#hero-copy',
      scope: 'element',
      fontFamily: 'Courier New, monospace',
    });
    expect(swapFontRes.ok).toBe(true);

    const arrangeRes = await callContentViaExtension('RUN_ARRANGE', {
      selector: '#primary-cta',
      action: 'move',
      dx: 20,
      dy: 10,
    });
    expect(arrangeRes.ok).toBe(true);

    const resetRes = await callContentViaExtension('EDIT_RESET');
    expect(resetRes.ok).toBe(true);
    expect(await fixturePage.locator('#hero-title').textContent()).toBe(
      'Visual Design Extraction Pro',
    );

    const capturePdfRes = await callBackgroundViaExtension('RUN_CAPTURE', {
      exportMime: 'application/pdf',
      width: 1280,
      height: 800,
      title: 'Chromium E2E Capture',
      pageUrl: fixtureUrl,
    });
    expect(capturePdfRes.ok).toBe(true);

    const responsiveRes = await callBackgroundViaExtension('RUN_RESPONSIVE_INSPECT', {
      targetUrl: fixtureUrl,
      openWindows: false,
    });
    expect(responsiveRes.ok).toBe(true);

    const designReviewRes = await callContentViaExtension('RUN_DESIGN_REVIEW');
    expect(designReviewRes.ok).toBe(true);

    const techStackRes = await callContentViaExtension('RUN_TECH_STACK');
    expect(techStackRes.ok).toBe(true);

    await workspacePage.click('#run-tool-btn');
    await workspacePage.click('#save-artifact-btn');

    const optionsPage = await context.newPage();
    optionsPage.on('pageerror', (err) => {
      runtimeErrors.push(`options-page: ${err.message}`);
    });
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, {
      waitUntil: 'domcontentloaded',
    });

    const usageRes = await callBackgroundViaExtension('GET_STORAGE_USAGE');
    expect(usageRes.ok).toBe(true);
    if (usageRes.ok) {
      const usage = (usageRes.data as { usage: { artifactCount: number; usedBytes: number } })
        .usage;
      expect(usage.artifactCount).toBeGreaterThanOrEqual(1);
      expect(usage.usedBytes).toBeGreaterThan(50);
    }

    const hostStorageCount = await fixturePage.evaluate(() => {
      return window.localStorage.length + window.sessionStorage.length;
    });
    expect(hostStorageCount).toBe(0);
    expect(runtimeErrors).toEqual([]);

    await optionsPage.close();
    await workspacePage.close();
    await fixturePage.close();
  });
});
