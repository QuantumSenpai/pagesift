import { strFromU8, strToU8, unzipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  buildAssetsZipArchive,
  extractPageAssets,
  sanitizeArchiveFilename,
} from '../../src/extension/engines/assets-engine.js';
import { exportStaticPageClone } from '../../src/extension/engines/clone-page-engine.js';
import { generateLocalClonePrompt } from '../../src/extension/engines/clone-prompt-engine.js';
import {
  extractPageDesignSnapshot,
  generateDesignMdFromPages,
} from '../../src/extension/engines/design-md-engine.js';

describe('Slice 4 & 5 Engines: Assets, Design MD, Clone Prompt, and Static Clone Page Snapshot', () => {
  it('discovers page assets, sanitizes inline SVG previews, handles filename collisions, and packages a ZIP archive', async () => {
    const usedNames = new Set<string>();
    const name1 = sanitizeArchiveFilename('../../etc/passwd', 'fallback', 'png', usedNames);
    const name2 = sanitizeArchiveFilename(
      'https://cdn.example.com/passwd.png',
      'fallback',
      'png',
      usedNames,
    );
    expect(name1).not.toContain('..');
    expect(name1).not.toContain('/');
    expect(name1).toBe('etc-passwd.png');
    expect(name2).toBe('passwd.png');
    const name3 = sanitizeArchiveFilename(
      'https://cdn.example.com/sub/passwd.png',
      'fallback',
      'png',
      usedNames,
    );
    expect(name3).toBe('passwd-1.png');

    const dom = new JSDOM(
      `<!DOCTYPE html>
      <html>
        <head>
          <link rel="icon" href="/favicon.ico" />
        </head>
        <body>
          <img src="/images/hero.png" srcset="/images/hero-2x.png 2x" alt="Hero Banner" width="600" height="400" />
          <video src="blob:https://example.com/1234" poster="/images/poster.jpg"></video>
          <svg id="brand-mark" width="48" height="48" onclick="evilSvg()">
            <script>alert('svg-xss')</script>
            <circle cx="24" cy="24" r="20" fill="#3b82f6" />
          </svg>
        </body>
      </html>`,
      { url: 'https://example.com/product' },
    );

    const report = extractPageAssets(dom.window.document, dom.window as unknown as Window);
    expect(report.summary.totalDiscovered).toBeGreaterThanOrEqual(5);

    const svgAsset = report.assets.find((a) => a.kind === 'svg');
    expect(svgAsset?.availabilityStatus).toBe('inline_available');
    expect(svgAsset?.safeSvgPreview).toContain('<circle');
    expect(svgAsset?.safeSvgPreview).not.toContain('<script');
    expect(svgAsset?.safeSvgPreview).not.toContain('onclick');

    const videoAsset = report.assets.find((a) => a.kind === 'video');
    expect(videoAsset?.availabilityStatus).toBe('streaming_or_blob_unavailable');

    const zipResult = await buildAssetsZipArchive(report, (url) => {
      if (url.endsWith('hero.png')) {
        return Promise.resolve({ ok: true, bytes: strToU8('FAKE_PNG_BYTES') });
      }
      return Promise.resolve({ ok: false, reason: 'HTTP 403 Forbidden' });
    });

    expect(zipResult.packagedFilesCount).toBe(2);
    const unzipped = unzipSync(zipResult.zipBytes);
    expect(Object.keys(unzipped)).toContain('assets-manifest.json');
  });

  it('combines multiple saved page snapshots into a deterministic DESIGN.md and reports cross-page token conflicts', () => {
    const dom1 = new JSDOM(
      `<!DOCTYPE html>
      <html>
        <head>
          <title>Marketing Home</title>
          <style>
            :root { --brand-accent: #3b82f6; }
            body { font-family: "Inter", sans-serif; color: #0f172a; background-color: #ffffff; }
            .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding: 32px; border-radius: 12px; }
          </style>
        </head>
        <body>
          <nav>Nav</nav>
          <div class="grid"><button>Get Started</button></div>
        </body>
      </html>`,
      { url: 'https://example.com/' },
    );

    const dom2 = new JSDOM(
      `<!DOCTYPE html>
      <html>
        <head>
          <title>Docs Portal</title>
          <style>
            :root { --brand-accent: #ef4444; }
            body { font-family: "JetBrains Mono", monospace; color: #0f172a; background-color: #f8fafc; }
            .content { display: flex; gap: 16px; padding: 24px; border-radius: 8px; }
          </style>
        </head>
        <body>
          <header>Docs Header</header>
          <div class="content"><footer>Footer</footer></div>
        </body>
      </html>`,
      { url: 'https://example.com/docs' },
    );

    const snap1 = extractPageDesignSnapshot(dom1.window.document, dom1.window as unknown as Window);
    const snap2 = extractPageDesignSnapshot(dom2.window.document, dom2.window as unknown as Window);

    const combined = generateDesignMdFromPages([snap1, snap2]);
    expect(combined.combinedPageCount).toBe(2);
    expect(combined.markdown).toContain('https://example.com/');
    expect(combined.markdown).toContain('https://example.com/docs');
    expect(combined.conflicts.some((c) => c.tokenOrKey === '--brand-accent')).toBe(true);
    expect(combined.conflicts.some((c) => c.category === 'primary_font')).toBe(true);
    expect(combined.markdown).toContain('## 8. Cross-Page Token Conflicts');
    expect(combined.markdown).toContain('### Semantic Color Roles');
    expect(combined.markdown).toContain('### Computed Type Scale & Hierarchy');
    expect(combined.markdown).toContain(
      '## 9. Copy-Pasteable :root Tokens & AI Implementation Guide',
    );

    const richDom = new JSDOM(
      `<!DOCTYPE html>
      <html lang="en">
        <head>
          <title>Editorial AI Product</title>
          <meta name="description" content="Precision design agent running inside your CAD workflow." />
          <style>
            :root { --brand-accent: #fa3600; --size-pad: 24px; }
            @media screen and (max-width: 767px) { body { font-size: 14px; } }
            @keyframes fadeSlide { from { opacity: 0; } to { opacity: 1; } }
            body { font-family: "BT Grotesk", sans-serif; color: #282828; background-color: #e0e0da; font-size: 16px; }
            header { position: fixed; height: 56px; border-bottom: 1px solid #b3b3af; }
            .btn-cta { background-color: #fa3600; color: #ffffff; border-radius: 4px; padding: 10px 16px; transition: color 0.3s ease; }
            .card { background-color: #ffffff; border: 1px solid #b3b3af; border-radius: 6px; padding: 20px; }
          </style>
        </head>
        <body>
          <header><nav><a href="/product">Product</a><a href="/pricing">Pricing</a></nav></header>
          <main>
            <section class="hero">
              <h1>An AI agent for your design tools</h1>
              <p>Automate repetitive geometry cleanup directly inside your model.</p>
              <a class="btn-cta" href="/start">Discover more</a>
            </section>
            <section class="features">
              <h2>Built for teams</h2>
              <div class="card"><input type="email" placeholder="Work email" /></div>
            </section>
          </main>
          <footer><p>©2026 Heron AI Studio</p></footer>
        </body>
      </html>`,
      { url: 'https://heron.example.com/' },
    );
    const richSnap = extractPageDesignSnapshot(
      richDom.window.document,
      richDom.window as unknown as Window,
    );
    const richResult = generateDesignMdFromPages([richSnap]);
    expect(richResult.markdown).toContain('Editorial AI Product');
    expect(richResult.markdown).toContain('### Global Header & Top Navigation');
    expect(richResult.markdown).toContain('**Product**');
    expect(richResult.markdown).toContain('### Section-by-Section DOM Blueprint');
    expect(richResult.markdown).toContain('An AI agent for your design tools');
    expect(richResult.markdown).toContain('Built for teams');
    expect(richResult.markdown).toContain('### Global Footer');
    expect(richResult.markdown).toContain('©2026 Heron AI Studio');
    expect(richResult.markdown).toContain('--size-pad');
    expect(richResult.markdown).toContain('@media screen and (max-width: 767px)');
    expect(richResult.markdown).toContain('`fadeSlide`');
    expect(richResult.markdown).toContain('### Button & CTA Variants');
    expect(richResult.markdown).toContain('### Form Controls & Inputs');
    expect(richResult.markdown).toContain('### Cards & Surface Containers');
    expect(richResult.markdown).toContain('--site-canvas-bg: #e0e0da;');
    expect(richResult.markdown).toContain('### Visual Anti-Patterns (Do Not Violate)');
  });

  it('generates a local rebuild prompt separating verified observations from structural assumptions without any AI key', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html>
      <html>
        <head><title>SaaS Dashboard</title></head>
        <body>
          <nav>Top Nav</nav>
          <main style="display: grid; gap: 16px; padding: 24px;"><button>Deploy</button></main>
        </body>
      </html>`,
      { url: 'https://example.com/app' },
    );

    const promptReport = generateLocalClonePrompt(
      dom.window.document,
      dom.window as unknown as Window,
      'react_tailwind',
    );
    expect(promptReport.prompt).toContain('## Verified Page Observations');
    expect(promptReport.prompt).toContain('## Structural & Responsive Assumptions');
    expect(promptReport.observations.length).toBeGreaterThan(3);
    expect(promptReport.assumptions.length).toBeGreaterThan(1);
  });

  it('exports a static HTML/CSS snapshot ZIP rewriting asset URLs, removing scripts/handlers/passwords, and reporting missing resources', async () => {
    const dom = new JSDOM(
      `<!DOCTYPE html>
      <html>
        <head>
          <title>Checkout Demo</title>
          <style>
            .banner {
              background-image: url("/assets/bg-pattern.png");
              color: #0f172a;
              padding: 20px;
            }
          </style>
        </head>
        <body>
          <div class="banner" onmouseover="stealCookies()">
            <h1>Static Snapshot</h1>
            <img src="/assets/logo.png" alt="Logo" />
            <img src="/assets/missing.png" alt="Missing" />
            <form action="https://example.com/submit">
              <input type="text" name="user" value="alice_sensitive_username" />
              <input type="password" name="pw" value="top_secret_password_999" />
              <textarea>Sensitive customer note</textarea>
            </form>
            <a href="javascript:evil()">Malicious Anchor</a>
            <a href="/pricing">Relative Pricing Link</a>
          </div>
          <script>window.backdoor = true;</script>
          <div data-pagesift-root="true">PageSift Internal Overlay</div>
        </body>
      </html>`,
      { url: 'https://example.com/checkout' },
    );

    const progressEvents: number[] = [];
    const snapshot = await exportStaticPageClone(
      dom.window.document,
      dom.window as unknown as Window,
      {
        onProgress: (p) => progressEvents.push(p.percent),
        fetcher: (url) => {
          if (url.endsWith('logo.png') || url.endsWith('bg-pattern.png')) {
            return Promise.resolve({
              ok: true,
              bytes: strToU8(`BINARY_CONTENT_FOR_${url}`),
            });
          }
          return Promise.resolve({
            ok: false,
            reason: 'HTTP 404 Not Found',
          });
        },
      },
    );

    expect(progressEvents).toContain(100);
    expect(snapshot.htmlContent).not.toContain('window.backdoor');
    expect(snapshot.htmlContent).not.toContain('stealCookies');
    expect(snapshot.htmlContent).not.toContain('javascript:evil');
    expect(snapshot.htmlContent).not.toContain('top_secret_password_999');
    expect(snapshot.htmlContent).not.toContain('alice_sensitive_username');
    expect(snapshot.htmlContent).not.toContain('Sensitive customer note');
    expect(snapshot.htmlContent).not.toContain('PageSift Internal Overlay');
    expect(snapshot.htmlContent).toContain('https://example.com/pricing');
    expect(snapshot.htmlContent).toContain('assets/logo.png');
    expect(snapshot.cssContent).toContain('url("../assets/bg-pattern.png")');
    expect(
      snapshot.manifest.missingResources.some((m) =>
        m.url.includes('https://example.com/assets/missing.png'),
      ),
    ).toBe(true);

    const archiveEntries = unzipSync(snapshot.zipBytes);
    expect(Object.keys(archiveEntries)).toEqual(
      expect.arrayContaining([
        'index.html',
        'styles/snapshot.css',
        'assets/logo.png',
        'assets/bg-pattern.png',
        'manifest.json',
      ]),
    );
    const archivedHtml = strFromU8(archiveEntries['index.html'] ?? new Uint8Array());
    expect(archivedHtml).toContain('styles/snapshot.css');
  });
});
