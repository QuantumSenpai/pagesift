import 'fake-indexeddb/auto';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  buildNvidiaEgressPreview,
  invokeNvidiaChatCompletion,
} from '../../src/extension/ai/nvidia-client.js';
import { BackgroundCoordinator } from '../../src/extension/background/service-worker.js';
import { ContentScriptRuntime } from '../../src/extension/content/content-script.js';
import {
  fetchSingleAssetBinary,
  prefetchAssetsBatch,
} from '../../src/extension/engines/asset-fetcher.js';
import { buildPdfDocumentFromCapture } from '../../src/extension/engines/capture-engine.js';
import { exportStaticPageClone } from '../../src/extension/engines/clone-page-engine.js';
import {
  validateMessageEnvelope,
  verifyDocumentBinding,
} from '../../src/extension/protocol/messages.js';
import { LocalExtensionStorage } from '../../src/extension/storage/idb-storage.js';
import {
  ExtensionSettingsStore,
  InMemoryKeyValueArea,
} from '../../src/extension/storage/settings-storage.js';

function createMinimalJpegDataUrl(width: number, height: number): string {
  const bytes = new Uint8Array(20);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xc0;
  bytes[4] = 0x00;
  bytes[5] = 0x0b;
  bytes[6] = 0x08;
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height, false);
  view.setUint16(9, width, false);
  bytes[18] = 0xff;
  bytes[19] = 0xd9;
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
}

describe('Confirmed Problem Regressions (Slices 1-6 and Connected Paths)', () => {
  it('Regression 1: PDF capture embeds real JPEG XObject imagery and rejects text-only captures without image data', () => {
    expect(() =>
      buildPdfDocumentFromCapture({
        width: 640,
        height: 480,
        title: 'Missing Pixels PDF',
        pageUrl: 'https://example.com',
      }),
    ).toThrow(/image|jpeg/i);

    const jpegUrl = createMinimalJpegDataUrl(320, 240);
    const pdfDataUrl = buildPdfDocumentFromCapture({
      width: 320,
      height: 240,
      title: 'Real Pixel PDF',
      pageUrl: 'https://example.com',
      jpegDataUrl: jpegUrl,
    });
    const base64 = pdfDataUrl.slice('data:application/pdf;base64,'.length);
    const pdfText = Buffer.from(base64, 'base64').toString('latin1');
    expect(pdfText).toContain('/Subtype /Image');
    expect(pdfText).toContain('/Filter /DCTDecode');
    expect(pdfText).toContain('/Im0 Do');
  });

  it('Regression 1b: content script capture refuses production fallbackDataUrl bypass when no real capture provider is connected', async () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body><h1>Capture Target</h1></body></html>', {
      url: 'https://example.com/capture',
    });
    const runtime = new ContentScriptRuntime(dom.window.document, dom.window as unknown as Window);
    try {
      const res = await runtime.handleMessage({
        schemaVersion: 1,
        requestId: 'req-cap-fallback-1',
        operation: 'RUN_CAPTURE',
        documentId: runtime.documentId,
        payload: {
          mode: 'visible',
          fallbackDataUrl: 'data:image/png;base64,AAAA',
        },
      });
      expect(res.ok).toBe(false);
    } finally {
      runtime.dispose();
    }
  });

  it('Regression 2: snapshot export strips iframe srcdoc, obfuscated executable URLs, formaction, SVG executable elements, hidden inputs, and adds defensive CSP', async () => {
    const dom = new JSDOM(
      `<!DOCTYPE html>
      <html>
        <head>
          <title>Sanitization Fixture</title>
          <meta http-equiv="refresh" content="0;url=https://evil.example/redirect" />
        </head>
        <body>
          <h1>Safe Heading</h1>
          <iframe srcdoc="<script>window.__SRCDOC_RAN=1</script><img src=x onerror='window.__SRCDOC_ERR=1'>"></iframe>
          <iframe src="https://evil.example/frame"></iframe>
          <a id="obf-link" href="  java&#x09;script:window.__OBF_RAN=1">Bad Link</a>
          <form action="https://evil.example/steal">
            <input type="hidden" name="csrf" value="SECRET_HIDDEN_CSRF_999" />
            <button formaction="javascript:window.__FORMACTION_RAN=1">Submit</button>
          </form>
          <svg id="svg-evil" width="32" height="32">
            <a xlink:href="javascript:window.__SVG_RAN=1"><rect width="32" height="32" fill="#2563eb" /></a>
            <animate attributeName="href" values="javascript:window.__SVG_ANIM=1" />
          </svg>
        </body>
      </html>`,
      { url: 'https://example.com/sanitize' },
    );

    const snapshot = await exportStaticPageClone(
      dom.window.document,
      dom.window as unknown as Window,
    );

    expect(snapshot.htmlContent).not.toContain('srcdoc');
    expect(snapshot.htmlContent).not.toContain('<iframe');
    expect(snapshot.htmlContent).not.toContain('__SRCDOC_RAN');
    expect(snapshot.htmlContent).not.toContain('__SRCDOC_ERR');
    expect(snapshot.htmlContent).not.toContain('__OBF_RAN');
    expect(snapshot.htmlContent).not.toContain('__FORMACTION_RAN');
    expect(snapshot.htmlContent).not.toContain('__SVG_RAN');
    expect(snapshot.htmlContent).not.toContain('__SVG_ANIM');
    expect(snapshot.htmlContent).not.toContain('SECRET_HIDDEN_CSRF_999');
    expect(snapshot.htmlContent).toContain('Content-Security-Policy');
    expect(snapshot.htmlContent).toContain('Safe Heading');
  });

  it('Regression 3: NVIDIA sanitization recurses into arrays, handles mixed-case sensitive keys, strips URL credentials, and enforces bounds', () => {
    const preview = buildNvidiaEgressPreview({
      modelId: 'meta/llama-3.1-70b-instruct',
      taskType: 'enhance_clone_prompt',
      sanitizedContext: {
        pageTitle: 'Checkout Page',
        observations: [
          'Grid layout with 2 columns',
          {
            Password: 'SECRET_PASSWORD_IN_ARRAY',
            nestedItems: [
              {
                Access_Token: 'SECRET_TOKEN_DEEP_ARRAY',
                clientSecret: 'SECRET_CLIENT_DEEP',
                sourceUrl:
                  'https://alice:topsecretpass@shop.example.com/pay?session=SECRET_QS#hash',
                note: 'Clean card description',
              },
            ],
          },
        ],
      },
    });

    expect(preview.serializedPayloadPreview).not.toContain('SECRET_PASSWORD_IN_ARRAY');
    expect(preview.serializedPayloadPreview).not.toContain('SECRET_TOKEN_DEEP_ARRAY');
    expect(preview.serializedPayloadPreview).not.toContain('SECRET_CLIENT_DEEP');
    expect(preview.serializedPayloadPreview).not.toContain('topsecretpass');
    expect(preview.serializedPayloadPreview).not.toContain('SECRET_QS');
    expect(preview.serializedPayloadPreview).not.toContain('#hash');
    expect(preview.serializedPayloadPreview).toContain('Clean card description');
  });

  it('Regression 4: connected asset fetcher downloads accessible HTTP assets into Assets ZIP and Clone Page ZIP', async () => {
    const dom = new JSDOM(
      `<!DOCTYPE html>
      <html>
        <head><title>Asset Fetch Fixture</title></head>
        <body>
          <img src="/img/logo.png" alt="Logo" />
        </body>
      </html>`,
      { url: 'https://assets.example.com/page' },
    );

    const pngMarkerBytes = strToU8('PNG_ACTUAL_ASSET_BYTES_12345');
    const contentRuntime = new ContentScriptRuntime(
      dom.window.document,
      dom.window as unknown as Window,
      {
        fetchAssetBinary: (url) => {
          if (url === 'https://assets.example.com/img/logo.png') {
            return Promise.resolve({
              ok: true,
              bytes: pngMarkerBytes,
              mimeType: 'image/png',
            });
          }
          return Promise.resolve({ ok: false, reason: 'HTTP 404 Not Found' });
        },
      },
    );

    try {
      const assetsRes = await contentRuntime.handleMessage({
        schemaVersion: 1,
        requestId: 'req-assets-fetch-1',
        operation: 'RUN_ASSETS_EXTRACT',
        documentId: contentRuntime.documentId,
        payload: { includeZip: true },
      });
      expect(assetsRes.ok).toBe(true);
      if (assetsRes.ok) {
        const data = assetsRes.data as { zipBase64: string };
        const unzipped = unzipSync(new Uint8Array(Buffer.from(data.zipBase64, 'base64')));
        expect(strFromU8(unzipped['assets/logo.png'] ?? new Uint8Array())).toBe(
          'PNG_ACTUAL_ASSET_BYTES_12345',
        );
      }

      const cloneRes = await contentRuntime.handleMessage({
        schemaVersion: 1,
        requestId: 'req-clone-fetch-1',
        operation: 'RUN_CLONE_PAGE',
        documentId: contentRuntime.documentId,
        payload: {},
      });
      expect(cloneRes.ok).toBe(true);
      if (cloneRes.ok) {
        const data = cloneRes.data as { zipBase64: string };
        const unzipped = unzipSync(new Uint8Array(Buffer.from(data.zipBase64, 'base64')));
        expect(strFromU8(unzipped['assets/logo.png'] ?? new Uint8Array())).toBe(
          'PNG_ACTUAL_ASSET_BYTES_12345',
        );
        expect(strFromU8(unzipped['index.html'] ?? new Uint8Array())).toContain('assets/logo.png');
      }
    } finally {
      contentRuntime.dispose();
    }
  });

  it('Regression 5: content script emits throttled SYNC_SCROLL when enabled and suppresses echo on programmatic sync', async () => {
    const dom = new JSDOM(
      '<!DOCTYPE html><html><body style="height: 3000px;"><div style="height: 3000px;">Tall</div></body></html>',
      { url: 'https://example.com/responsive' },
    );
    const { document, window } = dom.window;
    let currentY = 0;
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 2600,
      configurable: true,
    });
    Object.defineProperty(window, 'scrollY', { get: () => currentY, configurable: true });
    window.scrollTo = ((_x: number | ScrollToOptions, y?: number) => {
      if (typeof y === 'number') {
        currentY = y;
      }
    }) as typeof window.scrollTo;

    const sentMessages: unknown[] = [];
    const runtime = new ContentScriptRuntime(document, window as unknown as Window, {
      sendBackgroundMessage: (message) => {
        sentMessages.push(message);
        return Promise.resolve({
          ok: true,
          schemaVersion: 1,
          requestId: 'sync-ack',
          operation: 'SYNC_SCROLL',
          data: {},
        });
      },
    });
    runtime.init();

    try {
      const enableRes = await runtime.handleMessage({
        schemaVersion: 1,
        requestId: 'req-enable-sync',
        operation: 'SET_RESPONSIVE_SYNC',
        documentId: runtime.documentId,
        payload: { enabled: true },
      });
      expect(enableRes.ok).toBe(true);

      currentY = 1000;
      window.dispatchEvent(new window.Event('scroll'));
      await new Promise((r) => setTimeout(r, 80));
      expect(sentMessages.length).toBeGreaterThanOrEqual(1);

      const countBeforeProgrammatic = sentMessages.length;
      await runtime.handleMessage({
        schemaVersion: 1,
        requestId: 'req-incoming-sync',
        operation: 'SYNC_SCROLL',
        documentId: runtime.documentId,
        payload: { scrollXRatio: 0, scrollYRatio: 0.75 },
      });
      window.dispatchEvent(new window.Event('scroll'));
      await new Promise((r) => setTimeout(r, 80));
      expect(sentMessages.length).toBe(countBeforeProgrammatic);
    } finally {
      runtime.dispose();
    }
  });

  it('Regression 6: document binding rejects omitted documentId when required and background persists job lifecycle records', async () => {
    expect(verifyDocumentBinding(undefined, 'doc-current-1', true)).toBe(false);

    const dbName = `pagesift_job_lifecycle_${Date.now()}`;
    const storage = new LocalExtensionStorage(dbName);
    const settingsStore = new ExtensionSettingsStore(
      new InMemoryKeyValueArea(),
      new InMemoryKeyValueArea(),
    );
    const dom = new JSDOM('<!DOCTYPE html><html><body><h1>Job Test</h1></body></html>', {
      url: 'https://example.com/job',
    });
    const contentRuntime = new ContentScriptRuntime(
      dom.window.document,
      dom.window as unknown as Window,
    );

    const coordinator = new BackgroundCoordinator({
      extensionId: 'dddddddddddddddddddddddddddddddd',
      storage,
      settingsStore,
      sendToTab: (_tabId, message) => contentRuntime.handleMessage(message),
    });

    try {
      const res = await coordinator.handleRuntimeMessage(
        {
          schemaVersion: 1,
          requestId: 'req-job-clone-1',
          operation: 'RUN_CLONE_PAGE',
          tabId: 1,
          documentId: contentRuntime.documentId,
          payload: {},
        },
        {
          id: 'dddddddddddddddddddddddddddddddd',
          url: 'chrome-extension://dddddddddddddddddddddddddddddddd/workspace.html',
        },
      );
      expect(res.ok).toBe(true);
      const job = await storage.getJob('req-job-clone-1');
      expect(job).toBeDefined();
      expect(job?.status).toBe('completed');
    } finally {
      contentRuntime.dispose();
      await storage.close();
    }
  });

  it('enforces streaming byte limits, scheme checks, and credentials:omit in privileged asset fetcher', async () => {
    const badScheme = await fetchSingleAssetBinary('file:///etc/passwd');
    expect(badScheme.ok).toBe(false);

    let receivedCredentials: RequestCredentials | undefined;
    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
        controller.close();
      },
    });
    const capped = await fetchSingleAssetBinary('https://cdn.example.com/big.png', {
      maxBytes: 1024,
      fetchImpl: (_input, init) => {
        receivedCredentials = init?.credentials;
        return Promise.resolve(
          new Response(oversizedStream, {
            status: 200,
            headers: { 'content-type': 'image/png' },
          }),
        );
      },
    });
    expect(receivedCredentials).toBe('omit');
    expect(capped.ok).toBe(false);
    expect(capped.reason).toContain('byte limit');

    const batch = await prefetchAssetsBatch(
      ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'],
      {
        maxTotalBytes: 1200,
        maxSingleAssetBytes: 1024,
        fetchImpl: () => Promise.resolve(new Response(new Uint8Array(800), { status: 200 })),
      },
    );
    const okCount = Array.from(batch.values()).filter((r) => r.ok).length;
    expect(okCount).toBe(1);
  });

  it('enforces NVIDIA depth/size bounds, preview-execution digest consistency, malformed JSON, timeout, cancellation, and rate limits', async () => {
    const deepObj: Record<string, unknown> = { level: 0 };
    let cursor = deepObj;
    for (let i = 1; i <= 10; i += 1) {
      const next: Record<string, unknown> = { level: i };
      cursor['child'] = next;
      cursor = next;
    }
    const deepPreview = buildNvidiaEgressPreview({
      modelId: 'meta/llama-3.1-70b-instruct',
      taskType: 'enhance_clone_prompt',
      sanitizedContext: deepObj,
    });
    expect(deepPreview.serializedPayloadPreview).toContain('[truncated-max-depth]');

    const hugeContext: Record<string, unknown> = {};
    for (let i = 0; i < 35; i += 1) {
      hugeContext[`field${i}`] = 'X'.repeat(900);
    }
    expect(() =>
      buildNvidiaEgressPreview({
        modelId: 'meta/llama-3.1-70b-instruct',
        taskType: 'enhance_clone_prompt',
        sanitizedContext: hugeContext,
      }),
    ).toThrow(/exceeds maximum limit/);

    const dbName = `pagesift_nvidia_boundary_${Date.now()}`;
    const storage = new LocalExtensionStorage(dbName);
    const settingsStore = new ExtensionSettingsStore(
      new InMemoryKeyValueArea(),
      new InMemoryKeyValueArea(),
    );
    await settingsStore.updateSettings({ nvidiaModelId: 'meta/llama-3.1-70b-instruct' });
    await settingsStore.setSessionNvidiaApiKey('nvapi-boundary-test-key-000000');

    let capturedBody = '';
    const coordinator = new BackgroundCoordinator({
      extensionId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      storage,
      settingsStore,
      fetchImpl: (_input, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '## Verified AI Output' } }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    });
    const sender = {
      id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      url: 'chrome-extension://eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee/workspace.html',
    };

    try {
      const unpreviewedRes = await coordinator.handleRuntimeMessage(
        {
          schemaVersion: 1,
          requestId: 'nv-unpreviewed',
          operation: 'RUN_NVIDIA_ENHANCEMENT',
          payload: {
            previewOnly: false,
            taskType: 'enhance_clone_prompt',
            sourceTool: 'clone_prompt',
            toolOutput: { pageTitle: 'Demo', rawHtml: '<secret-raw-html />' },
          },
        },
        sender,
      );
      expect(unpreviewedRes.ok).toBe(false);

      const previewRes = await coordinator.handleRuntimeMessage(
        {
          schemaVersion: 1,
          requestId: 'nv-preview',
          operation: 'RUN_NVIDIA_ENHANCEMENT',
          payload: {
            previewOnly: true,
            taskType: 'enhance_clone_prompt',
            sourceTool: 'clone_prompt',
            toolOutput: {
              pageTitle: 'Demo Store',
              rawHtml: 'NEVER_SEND_RAW_HTML',
              zipBase64: 'NEVER_SEND_ZIP',
              observations: [{ Password: 'NEVER_SEND_ARRAY_PW', layout: '2-column grid' }],
            },
          },
        },
        sender,
      );
      expect(previewRes.ok).toBe(true);
      const digest = previewRes.ok
        ? (previewRes.data as { payloadDigest: string }).payloadDigest
        : '';

      const mutatedRes = await coordinator.handleRuntimeMessage(
        {
          schemaVersion: 1,
          requestId: 'nv-mutated',
          operation: 'RUN_NVIDIA_ENHANCEMENT',
          payload: {
            previewOnly: false,
            taskType: 'enhance_clone_prompt',
            sourceTool: 'clone_prompt',
            toolOutput: { pageTitle: 'Changed After Preview' },
            confirmedPayloadDigest: digest,
          },
        },
        sender,
      );
      expect(mutatedRes.ok).toBe(false);

      const confirmedRes = await coordinator.handleRuntimeMessage(
        {
          schemaVersion: 1,
          requestId: 'nv-confirmed',
          operation: 'RUN_NVIDIA_ENHANCEMENT',
          payload: {
            previewOnly: false,
            taskType: 'enhance_clone_prompt',
            sourceTool: 'clone_prompt',
            toolOutput: {
              pageTitle: 'Demo Store',
              rawHtml: 'NEVER_SEND_RAW_HTML',
              zipBase64: 'NEVER_SEND_ZIP',
              observations: [{ Password: 'NEVER_SEND_ARRAY_PW', layout: '2-column grid' }],
            },
            confirmedPayloadDigest: digest,
          },
        },
        sender,
      );
      expect(confirmedRes.ok).toBe(true);
      expect(capturedBody).not.toContain('NEVER_SEND_RAW_HTML');
      expect(capturedBody).not.toContain('NEVER_SEND_ZIP');
      expect(capturedBody).not.toContain('NEVER_SEND_ARRAY_PW');
      expect(capturedBody).toContain('2-column grid');

      await expect(
        invokeNvidiaChatCompletion({
          apiKey: 'nvapi-boundary-test-key-000000',
          modelId: 'meta/llama-3.1-70b-instruct',
          taskType: 'enhance_clone_prompt',
          sanitizedContext: { pageTitle: 'Malformed' },
          fetchImpl: () => Promise.resolve(new Response('not-json', { status: 200 })),
        }),
      ).rejects.toThrow(/malformed JSON/);

      await expect(
        invokeNvidiaChatCompletion({
          apiKey: 'nvapi-boundary-test-key-000000',
          modelId: 'meta/llama-3.1-70b-instruct',
          taskType: 'enhance_clone_prompt',
          sanitizedContext: { pageTitle: 'Rate Limited' },
          fetchImpl: () =>
            Promise.resolve(
              new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '15' } }),
            ),
        }),
      ).rejects.toThrow(/HTTP 429.*15s/);

      const abortController = new AbortController();
      abortController.abort();
      await expect(
        invokeNvidiaChatCompletion({
          apiKey: 'nvapi-boundary-test-key-000000',
          modelId: 'meta/llama-3.1-70b-instruct',
          taskType: 'enhance_clone_prompt',
          sanitizedContext: { pageTitle: 'Cancelled' },
          signal: abortController.signal,
        }),
      ).rejects.toThrow(/cancelled/i);
    } finally {
      await storage.close();
    }
  });

  it('rejects invalid operation-specific payloads and preserves existing storage data on failed backup import', async () => {
    expect(
      validateMessageEnvelope({
        schemaVersion: 1,
        requestId: 'req-bad-tool',
        operation: 'ACTIVATE_TOOL',
        payload: { tool: 'nonexistent_tool' },
      }).valid,
    ).toBe(false);

    expect(
      validateMessageEnvelope({
        schemaVersion: 1,
        requestId: 'req-bad-mime',
        operation: 'RUN_CAPTURE',
        payload: { exportMime: 'image/gif' },
      }).valid,
    ).toBe(false);

    expect(
      validateMessageEnvelope({
        schemaVersion: 1,
        requestId: 'req-bad-dims',
        operation: 'RUN_RESPONSIVE_INSPECT',
        payload: {
          targetUrl: 'https://example.com',
          customViewports: [{ id: 'bad', label: 'Bad', width: 10, height: 10, category: 'mobile' }],
        },
      }).valid,
    ).toBe(false);

    const dbName = `pagesift_atomic_import_${Date.now()}`;
    const storage = new LocalExtensionStorage(dbName);
    const nowIso = new Date().toISOString();
    try {
      await storage.saveProject({
        id: 'proj-existing',
        name: 'Existing Project',
        description: 'Must survive failed import',
        sourceDomain: 'keep.example.com',
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      await expect(
        storage.importBackup({
          schemaVersion: 1,
          exportedAt: nowIso,
          projects: [
            {
              id: 'proj-valid',
              name: 'Valid',
              description: '',
              sourceDomain: null,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          ],
          artifacts: [
            {
              id: 'art-broken-ref',
              projectId: 'proj-missing',
              kind: 'design_md',
              title: 'Broken',
              sourceUrl: null,
              schemaVersion: 1,
              byteLength: 2,
              payload: {},
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          ],
          captures: [],
        }),
      ).rejects.toThrow(/integrity failure/);

      const remaining = await storage.listProjects();
      expect(remaining.map((p) => p.id)).toEqual(['proj-existing']);
    } finally {
      await storage.close();
    }
  });

  it('recovers previously running jobs on first wake message without explicit initialize(), deduplicates concurrent init, and reports structured init failures', async () => {
    const dbName = `pagesift_worker_wake_${Date.now()}`;
    const storage = new LocalExtensionStorage(dbName);
    const sessionArea = new InMemoryKeyValueArea();
    const settingsStore = new ExtensionSettingsStore(new InMemoryKeyValueArea(), sessionArea);
    const extId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const sender = { id: extId, url: `chrome-extension://${extId}/workspace.html` };

    try {
      await storage.StartToolJob({
        id: 'job-stuck-running-1',
        tool: 'clone_page',
        tabId: 42,
        documentId: 'doc-before-stop',
      });
      await sessionArea.set({
        pagesift_responsive_session_v1: {
          sessionId: 'resp-before-stop',
          targetUrl: 'https://example.com',
          syncEnabled: true,
          windows: [
            {
              presetId: 'mobile-sm',
              label: 'Mobile 375x812',
              windowId: 901,
              tabId: 801,
              requestedWidth: 375,
              requestedHeight: 812,
              actualInnerWidth: 375,
              actualInnerHeight: 812,
              chromeDeltaWidth: 0,
              chromeDeltaHeight: 0,
              sizeConstrainedByBrowser: false,
            },
          ],
          createdAt: new Date().toISOString(),
        },
      });

      let recoverCalls = 0;
      const originalRecover = storage.recoverInterruptedJobs.bind(storage);
      storage.recoverInterruptedJobs = async () => {
        recoverCalls += 1;
        await new Promise((r) => setTimeout(r, 25));
        return originalRecover();
      };

      const freshCoordinator = new BackgroundCoordinator({
        extensionId: extId,
        storage,
        settingsStore,
        sessionStateArea: sessionArea,
      });

      const [jobStatusRes, listJobsRes, respSessionRes] = await Promise.all([
        freshCoordinator.handleRuntimeMessage(
          {
            schemaVersion: 1,
            requestId: 'req-wake-job-status',
            operation: 'GET_JOB_STATUS',
            payload: { jobId: 'job-stuck-running-1' },
          },
          sender,
        ),
        freshCoordinator.handleRuntimeMessage(
          {
            schemaVersion: 1,
            requestId: 'req-wake-list-jobs',
            operation: 'LIST_JOBS',
            payload: {},
          },
          sender,
        ),
        freshCoordinator.handleRuntimeMessage(
          {
            schemaVersion: 1,
            requestId: 'req-wake-resp-session',
            operation: 'GET_RESPONSIVE_SESSION',
            payload: {},
          },
          sender,
        ),
      ]);

      expect(recoverCalls).toBe(1);
      expect(jobStatusRes.ok).toBe(true);
      if (jobStatusRes.ok) {
        const data = jobStatusRes.data as { job: { status: string } | null };
        expect(data.job?.status).toBe('interrupted');
      }
      expect(listJobsRes.ok).toBe(true);
      if (listJobsRes.ok) {
        const data = listJobsRes.data as { jobs: Array<{ id: string; status: string }> };
        expect(data.jobs.find((j) => j.id === 'job-stuck-running-1')?.status).toBe('interrupted');
      }
      expect(respSessionRes.ok).toBe(true);
      if (respSessionRes.ok) {
        const data = respSessionRes.data as { session: { sessionId: string } | null };
        expect(data.session?.sessionId).toBe('resp-before-stop');
      }

      let failOnce = true;
      const flakyStorage = new LocalExtensionStorage(`pagesift_worker_fail_${Date.now()}`);
      const baseRecover = flakyStorage.recoverInterruptedJobs.bind(flakyStorage);
      flakyStorage.recoverInterruptedJobs = async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error('Simulated IndexedDB open failure');
        }
        return baseRecover();
      };
      const flakyCoordinator = new BackgroundCoordinator({
        extensionId: extId,
        storage: flakyStorage,
        settingsStore,
      });
      try {
        const failedRes = await flakyCoordinator.handleRuntimeMessage(
          {
            schemaVersion: 1,
            requestId: 'req-init-fail-1',
            operation: 'LIST_JOBS',
            payload: {},
          },
          sender,
        );
        expect(failedRes.ok).toBe(false);
        if (!failedRes.ok) {
          expect(failedRes.error.code).toBe('STORAGE_ERROR');
          expect(failedRes.error.message).toContain('Simulated IndexedDB open failure');
        }

        const recoveredRetryRes = await flakyCoordinator.handleRuntimeMessage(
          {
            schemaVersion: 1,
            requestId: 'req-init-retry-2',
            operation: 'LIST_JOBS',
            payload: {},
          },
          sender,
        );
        expect(recoveredRetryRes.ok).toBe(true);
      } finally {
        await flakyStorage.close();
      }
    } finally {
      await storage.close();
    }
  });
});
