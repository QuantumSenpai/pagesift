import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { generateLocalClonePrompt } from '../../src/extension/engines/clone-prompt-engine.js';
import {
  extractPageDesignSnapshot,
  generateDesignMdFromPages,
} from '../../src/extension/engines/design-md-engine.js';
import {
  computeWcagContrastRatio,
  extractStyleAdaptationReport,
} from '../../src/extension/engines/style-adaptation-engine.js';

describe('REA Style Adaptation & Evidence Engine', () => {
  it('computes accurate WCAG 2.1 contrast ratios for opaque and translucent colors', () => {
    const bw = computeWcagContrastRatio('#000000', '#ffffff');
    expect(bw).toBe(21);

    const heronBody = computeWcagContrastRatio('#282828b8', '#ffffff');
    expect(heronBody).not.toBeNull();
    expect(heronBody ?? 0).toBeGreaterThan(4.5);
    expect(heronBody ?? 99).toBeLessThan(7);

    const lowContrast = computeWcagContrastRatio('#b3b3af', '#ffffff');
    expect(lowContrast).not.toBeNull();
    expect(lowContrast ?? 99).toBeLessThan(3);
  });

  it('extracts pseudo-states, pseudo-elements, fluid expressions, z-index layers, a11y contracts, and framework adaptations', () => {
    const dom = new JSDOM(
      `<!doctype html>
      <html lang="en">
        <head>
          <title>Adapted Spec Fixture</title>
          <style>
            @media (prefers-color-scheme: dark) {
              body { background-color: #141413; color: #faf9f5; }
            }
            h1 { font-size: clamp(2rem, 4vw, 3.5rem); }
            .btn-cta { background-color: #fa3600; color: #ffffff; border-radius: 6px; padding: 10px 18px; }
            .btn-cta:hover { background-color: #d12d00; transform: translateY(-1px); }
            .btn-cta:focus-visible { outline: 2px solid #282828; }
            .btn-cta::after { content: "->"; }
            .card { background-color: #f5f5f4; border: 1px solid #b3b3af; border-radius: 8px; }
            header { position: fixed; z-index: 500; height: 60px; }
          </style>
        </head>
        <body>
          <header>
            <nav aria-label="Primary navigation">
              <button type="button" aria-expanded="false" aria-haspopup="true">Product</button>
              <a href="/pricing">Pricing</a>
            </nav>
          </header>
          <main>
            <section>
              <h1>Adaptive Design System</h1>
              <a class="btn-cta" href="/start">Launch</a>
              <div class="card">Card Body</div>
            </section>
          </main>
          <footer><small>Footer Note</small></footer>
        </body>
      </html>`,
      { url: 'https://fixture.example.com/' },
    );

    const doc = dom.window.document;
    const win = dom.window as unknown as Window;

    const snap = extractPageDesignSnapshot(doc, win);
    expect(snap.styleAdaptation).toBeDefined();
    expect(snap.styleAdaptation?.completeness.coverageStatus).toBe('complete');
    expect(snap.styleAdaptation?.pseudoStateRules.some((r) => r.state === ':hover')).toBe(true);
    expect(snap.styleAdaptation?.pseudoStateRules.some((r) => r.state === ':focus-visible')).toBe(
      true,
    );
    expect(snap.styleAdaptation?.pseudoElementStyles.some((pe) => pe.pseudo === '::after')).toBe(
      true,
    );
    expect(
      snap.styleAdaptation?.fluidExpressions.some((f) => f.expression.includes('clamp(')),
    ).toBe(true);
    expect(snap.styleAdaptation?.themeVariantRules.length).toBeGreaterThan(0);
    expect(snap.styleAdaptation?.stackingLayers[0]?.zIndex).toBe('500');
    expect(
      snap.styleAdaptation?.accessibilityContract.some((a) =>
        a.states.includes('aria-expanded=false'),
      ),
    ).toBe(true);
    expect(snap.styleAdaptation?.adaptedCssThemeBlock).toContain('.sa-btn-primary:hover');
    expect(snap.styleAdaptation?.adaptedTailwindThemeBlock).toContain('@theme {');

    const mdResult = generateDesignMdFromPages([snap]);
    expect(mdResult.markdown).toContain('## 10. REA Style Adaptation & Evidence Completeness');
    expect(mdResult.markdown).toContain('### Extraction Completeness & Evidence Boundaries');
    expect(mdResult.markdown).toContain('### WCAG 2.1 Measured Contrast Verification');
    expect(mdResult.markdown).toContain(
      '### Adapted Tailwind CSS v4 `@theme` & Utility Equivalents',
    );
    expect(mdResult.markdown).toContain('### Post-Rebuild Fidelity Verification Targets');

    const twPrompt = generateLocalClonePrompt(doc, win, 'react_tailwind');
    expect(twPrompt.prompt).toContain('## Adapted Tailwind CSS v4 Theme & Utility Mapping');
    expect(twPrompt.prompt).toContain('@theme {');

    const cssPrompt = generateLocalClonePrompt(doc, win, 'html_css');
    expect(cssPrompt.prompt).toContain('## Adapted Semantic CSS Theme & Component Classes');
    expect(cssPrompt.prompt).toContain('.sa-btn-primary');
  });

  it('reports partial completeness honestly when cross-origin stylesheets block cssRules access', () => {
    const dom = new JSDOM('<!doctype html><html><body><p>Scoped test</p></body></html>', {
      url: 'https://example.com/',
    });
    const doc = dom.window.document;
    const win = dom.window as unknown as Window;

    const fakeStyleSheets = [
      {
        href: 'https://cdn.third-party.example.com/theme.css',
        get cssRules(): CSSRuleList {
          throw new Error('SecurityError: Cannot access rules');
        },
      },
    ];
    Object.defineProperty(doc, 'styleSheets', {
      configurable: true,
      get: () => fakeStyleSheets,
    });

    const report = extractStyleAdaptationReport(doc, win, {
      canvasHex: '#ffffff',
      primaryTextHex: '#111827',
      rootFontSizePx: '16px',
      primaryFontStack: 'system-ui, sans-serif',
      primaryFontName: 'system-ui',
    });

    expect(report.completeness.coverageStatus).toBe('partial');
    expect(report.completeness.inaccessibleStylesheets).toContain(
      'https://cdn.third-party.example.com/theme.css',
    );
    expect(report.completeness.omissionReasons[0]).toContain('CORS');
  });
});
