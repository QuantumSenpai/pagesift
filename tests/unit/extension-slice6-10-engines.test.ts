import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  buildNvidiaEgressPreview,
  invokeNvidiaChatCompletion,
} from '../../src/extension/ai/nvidia-client.js';
import {
  buildCapturePlan,
  buildPdfDocumentFromCapture,
  executeDomCaptureCoordinator,
  MAX_CAPTURE_HEIGHT_CSS_PX,
  verifyCaptureBinaryAndDimensions,
} from '../../src/extension/engines/capture-engine.js';
import {
  computeWcagContrastRatio,
  runLocalDesignReview,
} from '../../src/extension/engines/design-review-engine.js';
import { PageEditController } from '../../src/extension/engines/edit-engine.js';
import {
  createResponsiveInspectionPlan,
  ResponsiveScrollSynchronizer,
} from '../../src/extension/engines/responsive-engine.js';
import { detectPageTechStack } from '../../src/extension/engines/tech-stack-engine.js';

function createValidPngDataUrl(width: number, height: number): string {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes[24] = 8;
  bytes[25] = 6;
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
}

function createValidJpegDataUrl(width: number, height: number): string {
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

function createValidWebpVp8xDataUrl(width: number, height: number): string {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50], 0);
  bytes.set([0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00], 12);
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;
  bytes[24] = wMinus1 & 0xff;
  bytes[25] = (wMinus1 >> 8) & 0xff;
  bytes[26] = (wMinus1 >> 16) & 0xff;
  bytes[27] = hMinus1 & 0xff;
  bytes[28] = (hMinus1 >> 8) & 0xff;
  bytes[29] = (hMinus1 >> 16) & 0xff;
  return `data:image/webp;base64,${Buffer.from(bytes).toString('base64')}`;
}

describe('Slice 6 Engine: Capture planning, sticky/fixed suppression, scroll restoration, and binary verification', () => {
  it('caps infinite full-page heights and restores scroll and fixed elements after capture or cancellation', async () => {
    const plan = buildCapturePlan({
      mode: 'full_page',
      viewportWidth: 1280,
      viewportHeight: 1000,
      documentWidth: 1280,
      documentHeight: 99000,
      currentScrollX: 0,
      currentScrollY: 250,
      devicePixelRatio: 2,
    });
    expect(plan.truncatedToMaxHeight).toBe(true);
    expect(plan.totalHeightCssPx).toBe(MAX_CAPTURE_HEIGHT_CSS_PX);

    const dom = new JSDOM(
      `<!DOCTYPE html>
      <html>
        <head>
          <style>
            #sticky-nav { position: fixed; top: 0; }
          </style>
        </head>
        <body>
          <header id="sticky-nav">Fixed Header</header>
          <main style="height: 2400px;">Long Content</main>
          <div id="pagesift-root-host" data-pagesift-root="true">Overlay</div>
        </body>
      </html>`,
    );

    const { document, window } = dom.window;
    let currentX = 15;
    let currentY = 320;
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    Object.defineProperty(window, 'scrollX', { get: () => currentX, configurable: true });
    Object.defineProperty(window, 'scrollY', { get: () => currentY, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 2000,
      configurable: true,
    });
    window.scrollTo = ((x: number | ScrollToOptions, y?: number) => {
      if (typeof x === 'number') {
        currentX = x;
        currentY = y ?? 0;
      }
    }) as typeof window.scrollTo;

    const stickyNav = document.querySelector('#sticky-nav') as HTMLElement;
    const overlay = document.querySelector('#pagesift-root-host') as HTMLElement;
    const navVisibilityPerTile: string[] = [];
    const overlayVisibilityPerTile: string[] = [];

    const result = await executeDomCaptureCoordinator({
      doc: document,
      win: window as unknown as Window,
      mode: 'full_page',
      minIntervalMs: 5,
      lazyWaitMs: 5,
      captureViewportTab: () => {
        navVisibilityPerTile.push(stickyNav.style.visibility);
        overlayVisibilityPerTile.push(overlay.style.visibility);
        return Promise.resolve(createValidPngDataUrl(1200, 800));
      },
    });

    expect(result.tiles.length).toBe(3);
    expect(navVisibilityPerTile[0]).toBe('');
    expect(navVisibilityPerTile[1]).toBe('hidden');
    expect(navVisibilityPerTile[2]).toBe('hidden');
    expect(overlayVisibilityPerTile.every((v) => v === 'hidden')).toBe(true);
    expect(stickyNav.style.visibility).toBe('');
    expect(overlay.style.visibility).toBe('');
    expect(result.restoredScroll).toEqual({ scrollX: 15, scrollY: 320 });
  });

  it('verifies PNG, JPEG, WebP, and PDF binary signatures and exact dimensions', () => {
    const pngInfo = verifyCaptureBinaryAndDimensions(createValidPngDataUrl(1440, 900));
    expect(pngInfo).toMatchObject({ mimeType: 'image/png', width: 1440, height: 900 });

    const jpegInfo = verifyCaptureBinaryAndDimensions(createValidJpegDataUrl(1280, 720));
    expect(jpegInfo).toMatchObject({ mimeType: 'image/jpeg', width: 1280, height: 720 });

    const webpInfo = verifyCaptureBinaryAndDimensions(createValidWebpVp8xDataUrl(800, 600));
    expect(webpInfo).toMatchObject({ mimeType: 'image/webp', width: 800, height: 600 });

    const pdfUrl = buildPdfDocumentFromCapture({
      width: 1024,
      height: 768,
      title: 'Home Page Capture',
      pageUrl: 'https://example.com',
    });
    const pdfInfo = verifyCaptureBinaryAndDimensions(pdfUrl);
    expect(pdfInfo).toMatchObject({ mimeType: 'application/pdf', width: 1024, height: 768 });
  });
});

describe('Slice 7 Engine: Reversible Edit Text, Swap Font, and Arrange with Undo/Redo/Reset', () => {
  it('edits text preserving nested markup, swaps fonts, and arranges elements with full undo/redo/reset', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html>
      <html>
        <head></head>
        <body>
          <h2 id="headline">Original <strong>BoldBadge</strong></h2>
          <p class="copy">First paragraph</p>
          <p class="copy">Second paragraph</p>
          <div id="movable-card">Card Content</div>
          <input id="secret-input" type="password" value="do-not-touch" />
        </body>
      </html>`,
    );

    const { document } = dom.window;
    const controller = new PageEditController(document);
    const headline = document.querySelector('#headline') as HTMLElement;
    const firstCopy = document.querySelector('.copy') as HTMLElement;
    const card = document.querySelector('#movable-card') as HTMLElement;
    const secretInput = document.querySelector('#secret-input') as HTMLElement;

    expect(() => controller.applyTextEdit(secretInput, 'hacked')).toThrow(
      /form or script controls/,
    );

    controller.applyTextEdit(headline, 'Updated Headline ');
    expect(headline.innerHTML).toContain('Updated Headline ');
    expect(headline.querySelector('strong')?.textContent).toBe('BoldBadge');

    expect(() =>
      controller.applyFontSwap({
        target: firstCopy,
        scope: 'similar',
        fontFamily: 'Playfair Display',
        remoteFontCssUrl: 'https://fonts.googleapis.com/css2?family=Playfair+Display',
        allowRemoteFontLoad: false,
      }),
    ).toThrow(/explicit user opt-in/);

    controller.applyFontSwap({
      target: firstCopy,
      scope: 'similar',
      fontFamily: 'Playfair Display',
      remoteFontCssUrl: 'https://fonts.googleapis.com/css2?family=Playfair+Display',
      allowRemoteFontLoad: true,
    });
    expect(firstCopy.style.fontFamily).toBe('Playfair Display');
    expect(document.querySelectorAll('link[data-pagesift-remote-font]').length).toBe(1);

    controller.applyArrangeMutation({
      target: card,
      action: 'move',
      dx: 24,
      dy: -12,
    });
    expect(card.style.transform).toBe('translate(24px, -12px)');

    controller.undo();
    expect(card.style.transform).toBe('');

    controller.redo();
    expect(card.style.transform).toBe('translate(24px, -12px)');

    controller.resetAll();
    expect(card.style.transform).toBe('');
    expect(firstCopy.style.fontFamily).toBe('');
    expect(document.querySelectorAll('link[data-pagesift-remote-font]').length).toBe(0);
    expect(headline.innerHTML).toBe('Original <strong>BoldBadge</strong>');
  });
});

describe('Slice 8, 9, and 10 Engines: Responsive, Design Review, Tech Stack, and Optional NVIDIA AI', () => {
  it('plans responsive viewports and prevents scroll synchronization feedback loops', () => {
    const plan = createResponsiveInspectionPlan('https://example.com/landing');
    expect(plan.viewports.length).toBe(4);
    expect(plan.strategy).toBe('controlled_popup_windows');

    const sync = new ResponsiveScrollSynchronizer(200);
    sync.registerManagedTabs([101, 102, 103]);

    const firstBroadcast = sync.computeBroadcastTargets({
      sourceTabId: 101,
      scrollXRatio: 0,
      scrollYRatio: 0.5,
      nowMs: 1000,
    });
    expect(firstBroadcast.shouldBroadcast).toBe(true);
    expect(firstBroadcast.targetTabIds).toEqual([102, 103]);

    const echoFromTarget = sync.computeBroadcastTargets({
      sourceTabId: 102,
      scrollXRatio: 0,
      scrollYRatio: 0.5,
      nowMs: 1050,
    });
    expect(echoFromTarget.shouldBroadcast).toBe(false);
  });

  it('audits design quality and WCAG contrast and detects public tech stack evidence with honest disclaimers', () => {
    expect(computeWcagContrastRatio({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 })).toBe(21);

    const dom = new JSDOM(
      `<!DOCTYPE html>
      <html data-wf-site="wf-123">
        <head>
          <meta name="generator" content="Astro v4.15" />
          <script src="https://example.com/_next/static/chunks/main.js"></script>
          <style>
            :root { --tw-ring-color: #3b82f6; }
            body { background-color: #ffffff; font-size: 16px; }
            .low-contrast { color: #d1d5db; background-color: #ffffff; padding: 7px 13px 19px 23px; filter: blur(4px); }
          </style>
        </head>
        <body>
          <div id="__next">
            <astro-island>
              <p class="low-contrast flex items-center justify-between px-4 py-2 rounded-lg">Hard to read text</p>
            </astro-island>
          </div>
        </body>
      </html>`,
    );

    const designReview = runLocalDesignReview(dom.window.document, dom.window as unknown as Window);
    expect(designReview.findings.some((f) => f.category === 'weak_hierarchy')).toBe(true);
    expect(designReview.findings.some((f) => f.category === 'contrast_failure')).toBe(true);
    expect(designReview.findings.some((f) => f.category === 'inconsistent_spacing')).toBe(true);
    expect(designReview.findings.some((f) => f.category === 'excessive_effects')).toBe(true);
    expect(designReview.methodologyDisclaimer).toContain('does not prove AI authorship');

    const techStack = detectPageTechStack(dom.window.document);
    const detectedNames = techStack.detections.map((d) => d.technology);
    expect(detectedNames).toEqual(
      expect.arrayContaining(['Next.js', 'React', 'Astro', 'Tailwind CSS', 'Webflow']),
    );
    expect(techStack.methodologyDisclosure).toContain('absence of a marker does not prove absence');
  });

  it('enforces NVIDIA endpoint allowlist, strips sensitive fields, and handles completion, retries, and errors', async () => {
    expect(() =>
      buildNvidiaEgressPreview({
        modelId: 'meta/llama-3.1-70b-instruct',
        endpoint: 'https://untrusted.example.com/v1/chat/completions',
        taskType: 'enhance_clone_prompt',
        sanitizedContext: { pageTitle: 'Test' },
      }),
    ).toThrow(/not in the verified NVIDIA endpoint allowlist/);

    expect(() =>
      buildNvidiaEgressPreview({
        modelId: '',
        taskType: 'enhance_clone_prompt',
        sanitizedContext: { pageTitle: 'Test' },
      }),
    ).toThrow(/valid NVIDIA catalog model ID/);

    const preview = buildNvidiaEgressPreview({
      modelId: 'meta/llama-3.1-70b-instruct',
      taskType: 'enhance_clone_prompt',
      sanitizedContext: {
        pageTitle: 'Checkout',
        sourceUrl: 'https://example.com/checkout?token=secret_session_token_999#frag',
        password: 'should-be-dropped',
        formValues: { card: '4111' },
        topColors: ['#0f172a'],
      },
    });
    expect(preview.serializedPayloadPreview).not.toContain('secret_session_token_999');
    expect(preview.serializedPayloadPreview).not.toContain('should-be-dropped');
    expect(preview.serializedPayloadPreview).not.toContain('4111');
    expect(preview.serializedPayloadPreview).toContain('https://example.com/checkout');

    let callCount = 0;
    const successAfterRetry = await invokeNvidiaChatCompletion({
      apiKey: 'nvapi-controlled-test-key-0000',
      modelId: 'meta/llama-3.1-70b-instruct',
      taskType: 'enhance_clone_prompt',
      sanitizedContext: { pageTitle: 'Retry Test', topColors: ['#3b82f6'] },
      maxRetries: 1,
      fetchImpl: () => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.resolve(new Response('Service Unavailable', { status: 503 }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                { message: { content: '## Enhanced Rebuild Specification\n- Use semantic grid.' } },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    });
    expect(callCount).toBe(2);
    expect(successAfterRetry.outputText).toContain('Enhanced Rebuild Specification');

    await expect(
      invokeNvidiaChatCompletion({
        apiKey: 'nvapi-bad-key-0000',
        modelId: 'meta/llama-3.1-70b-instruct',
        taskType: 'interpret_design_review',
        sanitizedContext: { findingsCount: 2 },
        fetchImpl: () => Promise.resolve(new Response('Unauthorized', { status: 401 })),
      }),
    ).rejects.toThrow(/NVIDIA authentication failed \(HTTP 401\)/);
  });
});
