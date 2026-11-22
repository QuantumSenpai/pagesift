import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium } from 'playwright';

const ROOT_DIR = process.cwd();
const EXTENSION_DIR = path.join(ROOT_DIR, 'dist', 'extension');

function resolveChromiumExecutablePath(): string | undefined {
  const candidates = [
    path.join(
      os.homedir(),
      'Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
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

function generateLargeBenchmarkHtml(cardCount: number): string {
  const cards = Array.from(
    { length: cardCount },
    (_, i) =>
      `<article class="bench-card flex items-center justify-between px-4 py-2 rounded-lg" id="card-${i}">
        <h3>Card Heading ${i}</h3>
        <p>Performance evaluation description block ${i} with tokens and layout metrics.</p>
        <button type="button">Action ${i}</button>
      </article>`,
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>PageSift 2000-Node Benchmark Fixture</title>
    <style>
      :root { --brand-primary: #2563eb; --tw-ring: #3b82f6; }
      body { font-family: system-ui, sans-serif; color: #0f172a; background: #ffffff; margin: 0; }
      .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; padding: 24px; }
      .bench-card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; background: #f8fafc; }
    </style>
  </head>
  <body>
    <header style="position: sticky; top: 0; padding: 16px; background: #0f172a; color: #fff;">
      <h1 id="bench-title">PageSift Benchmark Suite</h1>
    </header>
    <main class="grid">${cards}</main>
  </body>
</html>`;
}

async function main(): Promise<void> {
  const html = generateLargeBenchmarkHtml(500);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  let fixtureUrl = '';
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        fixtureUrl = `http://127.0.0.1:${addr.port}/benchmark`;
      }
      resolve();
    });
  });

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagesift-ext-bench-'));
  const executablePath = resolveChromiumExecutablePath();
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(executablePath ? { executablePath } : { channel: 'chromium' }),
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      '--no-sandbox',
    ],
  });

  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    }
    const extensionId = sw.url().split('/')[2] ?? '';

    const page = await context.newPage();
    await page.goto(fixtureUrl, { waitUntil: 'networkidle' });
    const domNodeCount = await page.evaluate(() => document.querySelectorAll('*').length);
    const browserVersion = await page.evaluate(() => navigator.userAgent);

    const wsPage = await context.newPage();
    await wsPage.goto(`chrome-extension://${extensionId}/workspace.html`, {
      waitUntil: 'domcontentloaded',
    });

    const targetContext = await wsPage.evaluate(async () => {
      const chromeApi = (
        globalThis as unknown as {
          chrome: {
            tabs: {
              query: (q: object) => Promise<Array<{ id?: number }>>;
              sendMessage: (
                id: number,
                m: unknown,
              ) => Promise<{ ok?: boolean; data?: { documentId?: string } }>;
            };
          };
        }
      ).chrome;
      const tabs = await chromeApi.tabs.query({});
      for (const t of tabs) {
        if (typeof t.id !== 'number') {
          continue;
        }
        try {
          const r = await chromeApi.tabs.sendMessage(t.id, {
            schemaVersion: 1,
            requestId: 'bench-find',
            operation: 'GET_DOCUMENT_CONTEXT',
            payload: {},
          });
          if (r.ok && r.data?.documentId) {
            return { tabId: t.id, documentId: r.data.documentId };
          }
        } catch {
          continue;
        }
      }
      return { tabId: 0, documentId: '' };
    });

    const measureOpMs = async (operation: string, payload: Record<string, unknown> = {}) => {
      const t0 = performance.now();
      const res = await wsPage.evaluate(
        async ({ tId, docId, op, pl }) => {
          const chromeTabs = (
            globalThis as unknown as {
              chrome: {
                tabs: { sendMessage: (id: number, m: unknown) => Promise<{ ok: boolean }> };
              };
            }
          ).chrome.tabs;
          return chromeTabs.sendMessage(tId, {
            schemaVersion: 1,
            requestId: `bench-${op}-${Date.now()}`,
            operation: op,
            tabId: tId,
            documentId: docId,
            payload: pl,
          });
        },
        { tId: targetContext.tabId, docId: targetContext.documentId, op: operation, pl: payload },
      );
      if (!res.ok) {
        throw new Error(`Benchmark operation ${operation} failed`);
      }
      return Number((performance.now() - t0).toFixed(2));
    };

    const measureBgOpMs = async (operation: string, payload: Record<string, unknown> = {}) => {
      const t0 = performance.now();
      const res = await wsPage.evaluate(
        async ({ tId, docId, op, pl }) => {
          const chromeRuntime = (
            globalThis as unknown as {
              chrome: {
                runtime: { sendMessage: (m: unknown) => Promise<{ ok: boolean }> };
              };
            }
          ).chrome.runtime;
          return chromeRuntime.sendMessage({
            schemaVersion: 1,
            requestId: `bench-bg-${op}-${Date.now()}`,
            operation: op,
            tabId: tId,
            documentId: docId,
            payload: pl,
          });
        },
        { tId: targetContext.tabId, docId: targetContext.documentId, op: operation, pl: payload },
      );
      if (!res.ok) {
        throw new Error(`Benchmark background operation ${operation} failed`);
      }
      return Number((performance.now() - t0).toFixed(2));
    };

    const inspectMs = await measureOpMs('RUN_INSPECT_ELEMENT', { selector: '#card-250' });
    const colorsMs = await measureOpMs('RUN_COLORS_EXTRACT');
    const fontsMs = await measureOpMs('RUN_FONTS_EXTRACT');
    const assetsMs = await measureBgOpMs('RUN_ASSETS_EXTRACT', { includeZip: true });
    const designMdMs = await measureOpMs('RUN_DESIGN_MD');
    const clonePromptMs = await measureOpMs('RUN_CLONE_PROMPT');
    const clonePageMs = await measureBgOpMs('RUN_CLONE_PAGE');
    const captureVisibleMs = await measureBgOpMs('RUN_CAPTURE', {
      mode: 'visible',
      exportMime: 'image/png',
    });
    const designReviewMs = await measureOpMs('RUN_DESIGN_REVIEW');
    const techStackMs = await measureOpMs('RUN_TECH_STACK');

    const memUsage = process.memoryUsage();

    const report = {
      event: 'extension_benchmark_completed',
      environment: {
        platform: `${os.platform()} ${os.arch()} (${os.release()})`,
        cpuModel: os.cpus()[0]?.model ?? 'unknown',
        cpuCores: os.cpus().length,
        totalMemoryGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
        browserUserAgent: browserVersion,
      },
      fixture: {
        cardCount: 500,
        totalDomElements: domNodeCount,
      },
      provisionalBudgetsMs: {
        inspectSingleElementMaxMs: 50,
        colorsExtractionMaxMs: 250,
        fontsExtractionMaxMs: 250,
        assetsZipMaxMs: 500,
        designMdMaxMs: 400,
        clonePromptMaxMs: 400,
        clonePageSnapshotZipMaxMs: 1200,
        captureVisiblePngMaxMs: 1500,
        designReviewMaxMs: 350,
        techStackMaxMs: 150,
      },
      measuredTimingsMs: {
        inspectSingleElementMs: inspectMs,
        colorsExtractionMs: colorsMs,
        fontsExtractionMs: fontsMs,
        assetsZipMs: assetsMs,
        designMdMs,
        clonePromptMs,
        clonePageSnapshotZipMs: clonePageMs,
        captureVisiblePngMs: captureVisibleMs,
        designReviewMs,
        techStackMs,
      },
      harnessMemoryMiB: {
        rssMiB: Number((memUsage.rss / 1024 ** 2).toFixed(1)),
        heapUsedMiB: Number((memUsage.heapUsed / 1024 ** 2).toFixed(1)),
      },
    };

    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    await new Promise<void>((r) => {
      server.close(() => {
        r();
      });
    });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    JSON.stringify({
      event: 'extension_benchmark_failed',
      message: err instanceof Error ? err.message : 'Unknown error',
    }) + '\n',
  );
  process.exit(1);
});
