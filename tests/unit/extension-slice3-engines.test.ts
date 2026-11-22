import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { extractPageAssets } from '../../src/extension/engines/assets-engine.js';
import {
  extractPageColors,
  parseCssColorToRgba,
} from '../../src/extension/engines/colors-engine.js';
import { extractPageFonts } from '../../src/extension/engines/fonts-engine.js';
import { inspectElement } from '../../src/extension/engines/inspect-engine.js';
import { measureElements } from '../../src/extension/engines/measure-engine.js';

describe('Slice 3 Engines: Inspect, Colors, Fonts, and Measure', () => {
  it('inspects elements, traverses open shadow roots, strips scripts and passwords, and excludes PageSift UI', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html>
      <html>
        <head>
          <style>
            .card {
              display: flex;
              padding: 16px 24px;
              margin: 12px;
              color: rgb(15, 23, 42);
              background-color: rgb(255, 255, 255);
              border-radius: 8px;
              font-family: "Inter", sans-serif;
              font-size: 18px;
              font-weight: 600;
            }
          </style>
        </head>
        <body>
          <section id="main-card" class="card" aria-label="Pricing Summary" onclick="evil()">
            <h2>Pro Plan</h2>
            <script>alert('xss')</script>
            <input type="password" value="super-secret-password-123" />
            <a href="javascript:alert(1)">Bad Link</a>
          </section>
          <div id="shadow-host"></div>
          <div id="pagesift-root-host" data-pagesift-root="true">PageSift Dock</div>
        </body>
      </html>`,
      { url: 'https://example.com/pricing' },
    );

    const { document, window } = dom.window;
    const card = document.querySelector('#main-card');
    if (!card) {
      throw new Error('Missing main-card');
    }

    const report = inspectElement(card, window as unknown as Window);
    expect(report.tagName).toBe('section');
    expect(report.id).toBe('main-card');
    expect(report.accessibility.role).toBe('region');
    expect(report.accessibility.accessibleName).toBe('Pricing Summary');
    expect(report.spacing.padding).toEqual({ top: 16, right: 24, bottom: 16, left: 24 });
    expect(report.spacing.margin).toEqual({ top: 12, right: 12, bottom: 12, left: 12 });
    expect(report.safeHtml).not.toContain('<script>');
    expect(report.safeHtml).not.toContain('onclick');
    expect(report.safeHtml).not.toContain('javascript:alert');
    expect(report.safeHtml).not.toContain('super-secret-password-123');
    expect(report.diagnostics.computedStyleNotice).toContain('do not reveal original source');

    const shadowHost = document.querySelector('#shadow-host');
    if (!shadowHost) {
      throw new Error('Missing shadow-host');
    }
    const shadowRoot = shadowHost.attachShadow({ mode: 'open' });
    const shadowButton = document.createElement('button');
    shadowButton.textContent = 'Shadow CTA';
    shadowRoot.appendChild(shadowButton);

    const shadowReport = inspectElement(shadowButton, window as unknown as Window);
    expect(shadowReport.insideOpenShadowRoot).toBe(true);
    expect(shadowReport.accessibility.role).toBe('button');

    const pageSiftUi = document.querySelector('#pagesift-root-host');
    if (!pageSiftUi) {
      throw new Error('Missing pagesift-root-host');
    }
    expect(() => inspectElement(pageSiftUi, window as unknown as Window)).toThrow(
      /PageSift internal UI/,
    );
  });

  it('normalizes colors, transparency, gradients, and CSS custom properties and exports CSS/JSON/SCSS/Tailwind', () => {
    expect(parseCssColorToRgba('#3b82f6')).toEqual({ r: 59, g: 130, b: 246, a: 1 });
    expect(parseCssColorToRgba('rgba(15, 23, 42, 0.5)')).toEqual({
      r: 15,
      g: 23,
      b: 42,
      a: 0.5,
    });

    const dom = new JSDOM(
      `<!DOCTYPE html>
      <html>
        <head>
          <style>
            :root {
              --brand-primary: #3b82f6;
              --brand-surface: rgba(15, 23, 42, 0.8);
            }
            .hero {
              color: rgb(255, 255, 255);
              background-color: rgb(59, 130, 246);
              background-image: linear-gradient(90deg, rgb(59, 130, 246), rgb(147, 51, 234));
            }
          </style>
        </head>
        <body>
          <div class="hero">Welcome</div>
        </body>
      </html>`,
    );

    const report = extractPageColors(dom.window.document, dom.window as unknown as Window);
    expect(report.colors.length).toBeGreaterThanOrEqual(2);
    expect(report.colors.map((c) => c.hex)).toContain('#3b82f6');
    expect(report.gradients).toHaveLength(1);
    expect(report.customProperties.map((p) => p.name)).toContain('--brand-primary');
    expect(report.exports.cssVariables).toContain('--pagesift-color-1');
    expect(report.exports.scss).toContain('$pagesift-color-1');
    expect(report.exports.tailwindV3Config).toContain('"colors"');
    expect(report.exports.tailwindV4Theme).toContain('@theme');
  });

  it('extracts font stacks, combinations, and @font-face rules with rendered-font disclosure', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html>
      <html>
        <head>
          <style>
            @font-face {
              font-family: "Geist";
              src: url("https://example.com/fonts/geist.woff2") format("woff2");
              font-weight: 700;
              font-style: normal;
            }
            h1 {
              font-family: "Geist", sans-serif;
              font-size: 36px;
              font-weight: 700;
              line-height: 44px;
            }
          </style>
        </head>
        <body>
          <h1>Headline Typography</h1>
        </body>
      </html>`,
      { url: 'https://example.com/' },
    );

    const report = extractPageFonts(dom.window.document, dom.window as unknown as Window);
    expect(report.families.some((f) => f.primaryFamily === 'Geist')).toBe(true);
    expect(report.fontFaceDeclarations).toHaveLength(1);
    expect(report.fontFaceDeclarations[0]?.urls).toContain('https://example.com/fonts/geist.woff2');
    expect(report.diagnostics.renderedFontIdentityDisclosure).toContain('authored CSS font stack');
  });

  it('measures element boxes, padding, margins, and element-to-element gaps', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html>
      <html>
        <body>
          <div id="box-a" style="padding: 10px; margin: 8px;">Box A</div>
          <div id="box-b" style="padding: 12px; margin: 4px;">Box B</div>
        </body>
      </html>`,
    );

    const { document, window } = dom.window;
    const boxA = document.querySelector('#box-a');
    const boxB = document.querySelector('#box-b');
    if (!boxA || !boxB) {
      throw new Error('Missing boxes');
    }

    boxA.getBoundingClientRect = () => ({
      x: 20,
      y: 30,
      top: 30,
      left: 20,
      right: 120,
      bottom: 80,
      width: 100,
      height: 50,
      toJSON: () => ({}),
    });

    boxB.getBoundingClientRect = () => ({
      x: 160,
      y: 110,
      top: 110,
      left: 160,
      right: 260,
      bottom: 170,
      width: 100,
      height: 60,
      toJSON: () => ({}),
    });

    const measured = measureElements(boxA, boxB, window as unknown as Window);
    expect(measured.primary.width).toBe(100);
    expect(measured.primary.padding.top).toBe(10);
    expect(measured.distance?.horizontalGap).toBe(40);
    expect(measured.distance?.verticalGap).toBe(30);
    expect(measured.distance?.isOverlapping).toBe(false);
  });

  it('extracts meta og:image, preload fonts, mask-icon, audio, lazy srcset, and resource-timing assets while ignoring tracking pixels', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html>
      <html>
        <head>
          <meta property="og:image" content="https://cdn.example.com/social-card.png" />
          <link rel="mask-icon" href="https://cdn.example.com/safari-pinned.svg" color="#000" />
          <link rel="preload" as="font" href="https://cdn.example.com/fonts/preload.woff2" />
        </head>
        <body>
          <img data-lazy-srcset="https://cdn.example.com/lazy-1x.webp 1x, https://cdn.example.com/lazy-2x.webp 2x" alt="Lazy" />
          <audio src="https://cdn.example.com/chime.mp3"></audio>
          <svg width="24" height="24"><circle cx="12" cy="12" r="8"></circle></svg>
        </body>
      </html>`,
      { url: 'https://example.com/' },
    );

    const { document, window } = dom.window;
    Object.defineProperty(window, 'performance', {
      configurable: true,
      value: {
        getEntriesByType: (entryType: string) =>
          entryType === 'resource'
            ? [
                { name: 'https://cdn.example.com/cors-hidden/inter.woff2', initiatorType: 'css' },
                { name: 'https://framerusercontent.com/images/heroBanner', initiatorType: 'img' },
                {
                  name: 'https://www.google-analytics.com/g/collect?v=2',
                  initiatorType: 'img',
                },
              ]
            : [],
      },
    });

    const report = extractPageAssets(document, window as unknown as Window);
    const urls = new Set(report.assets.map((a) => a.url));
    expect(urls.has('https://cdn.example.com/social-card.png')).toBe(true);
    expect(urls.has('https://cdn.example.com/safari-pinned.svg')).toBe(true);
    expect(urls.has('https://cdn.example.com/fonts/preload.woff2')).toBe(true);
    expect(urls.has('https://cdn.example.com/lazy-2x.webp')).toBe(true);
    expect(urls.has('https://cdn.example.com/chime.mp3')).toBe(true);
    expect(urls.has('https://cdn.example.com/cors-hidden/inter.woff2')).toBe(true);
    expect(urls.has('https://framerusercontent.com/images/heroBanner')).toBe(true);
    expect(urls.has('https://www.google-analytics.com/g/collect?v=2')).toBe(false);
    expect(
      report.assets.some((a) => a.kind === 'svg' && a.availabilityStatus === 'inline_available'),
    ).toBe(true);
  });
});
