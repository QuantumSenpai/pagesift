import {
  formatRgbaToHex,
  parseCssColorToRgba,
  type ColorExtractionReport,
} from './colors-engine.js';
import {
  buildShortSelector,
  collectDocumentElements,
  inspectFramesAndStylesheets,
  parsePixelValue,
} from './dom-utils.js';
import type { FontExtractionReport } from './fonts-engine.js';

export interface StyleEvidenceCompleteness {
  coverageStatus: 'complete' | 'partial';
  accessibleStylesheetsCount: number;
  inaccessibleStylesheets: string[];
  sameOriginFramesCount: number;
  inaccessibleCrossOriginFrames: string[];
  openShadowRootsCount: number;
  scannedElementsCount: number;
  domTruncated: boolean;
  omissionReasons: string[];
}

export interface WcagContrastAuditEntry {
  pairLabel: string;
  foregroundHex: string;
  backgroundHex: string;
  contrastRatio: number;
  grade: 'AAA' | 'AA' | 'AA Large' | 'Fail';
}

export interface PseudoStateRuleEntry {
  state: ':hover' | ':focus' | ':focus-visible' | ':active' | ':disabled' | 'aria-state';
  selector: string;
  declarations: string;
}

export interface PseudoElementStyleEntry {
  selector: string;
  pseudo: '::before' | '::after';
  source: 'computed' | 'stylesheet';
  summary: string;
}

export interface FluidExpressionEntry {
  selectorOrRule: string;
  property: string;
  expression: string;
}

export interface StackingLayerEntry {
  selector: string;
  position: string;
  zIndex: string;
  roleHint: string;
}

export interface AccessibilityStateEntry {
  category: 'landmark' | 'disclosure' | 'dialog' | 'tablist' | 'control';
  selector: string;
  role: string;
  label: string;
  states: string[];
}

export interface StyleAdaptationInputs {
  canvasHex: string;
  surfaceHex?: string;
  primaryTextHex: string;
  mutedTextHex?: string;
  accentHex?: string;
  borderHex?: string;
  rootFontSizePx: string;
  primaryFontStack: string;
  primaryFontName: string;
  monoFontStack?: string;
  buttonRadius?: string;
  cardRadius?: string;
  buttonBg?: string;
  buttonText?: string;
  buttonPadding?: string;
  headerHeightPx?: number;
  h1FontSize?: string;
  h1ColorHex?: string;
  breakpoints?: string[];
}

export interface StyleAdaptationReport {
  completeness: StyleEvidenceCompleteness;
  wcagContrastPairs: WcagContrastAuditEntry[];
  pseudoStateRules: PseudoStateRuleEntry[];
  pseudoElementStyles: PseudoElementStyleEntry[];
  fluidExpressions: FluidExpressionEntry[];
  themeVariantRules: string[];
  stackingLayers: StackingLayerEntry[];
  accessibilityContract: AccessibilityStateEntry[];
  adaptedCssThemeBlock: string;
  adaptedTailwindThemeBlock: string;
  adaptedTailwindUtilities: Array<{ role: string; classes: string }>;
  reconstructionAssertions: string[];
}

function cleanText(raw: string | null | undefined, maxLen = 140): string {
  if (!raw) {
    return '';
  }
  return raw.replace(/\s+/g, ' ').replace(/\|/g, '/').trim().slice(0, maxLen);
}

function relativeLuminance(rgba: { r: number; g: number; b: number }): number {
  const [r, g, b] = [rgba.r / 255, rgba.g / 255, rgba.b / 255].map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

export function computeWcagContrastRatio(fgRaw: string, bgRaw: string): number | null {
  const fg = parseCssColorToRgba(fgRaw);
  const bg = parseCssColorToRgba(bgRaw);
  if (!fg || !bg) {
    return null;
  }
  const effectiveFg =
    fg.a < 1
      ? {
          r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
          g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
          b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
        }
      : fg;
  const l1 = relativeLuminance(effectiveFg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

function classifyContrastGrade(ratio: number): WcagContrastAuditEntry['grade'] {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA Large';
  return 'Fail';
}

const PSEUDO_TRACKED_PROPERTIES = [
  'color',
  'background-color',
  'border-color',
  'opacity',
  'transform',
  'box-shadow',
  'outline',
  'text-decoration',
];

function classifySelectorPseudoState(selectorText: string): PseudoStateRuleEntry['state'] | null {
  if (selectorText.includes(':focus-visible')) return ':focus-visible';
  if (selectorText.includes(':focus')) return ':focus';
  if (selectorText.includes(':hover')) return ':hover';
  if (selectorText.includes(':active')) return ':active';
  if (selectorText.includes(':disabled')) return ':disabled';
  if (selectorText.includes('[aria-expanded') || selectorText.includes('[data-state=')) {
    return 'aria-state';
  }
  return null;
}

function scanStylesheetAdaptationRules(doc: Document): {
  pseudoStateRules: PseudoStateRuleEntry[];
  stylesheetPseudoElements: PseudoElementStyleEntry[];
  fluidExpressions: FluidExpressionEntry[];
  themeVariantRules: string[];
} {
  const pseudoStateRules: PseudoStateRuleEntry[] = [];
  const stylesheetPseudoElements: PseudoElementStyleEntry[] = [];
  const fluidExpressions: FluidExpressionEntry[] = [];
  const themeVariantSet = new Set<string>();
  const seenStates = new Set<string>();
  const seenFluid = new Set<string>();

  const visitRule = (rule: CSSRule, activeCondition = ''): void => {
    if ('conditionText' in rule && typeof (rule as CSSMediaRule).conditionText === 'string') {
      const cond = cleanText((rule as CSSMediaRule).conditionText, 100);
      if (cond.includes('prefers-color-scheme') || cond.includes('prefers-contrast')) {
        themeVariantSet.add(`@media ${cond}`);
      }
      if ('cssRules' in rule) {
        try {
          for (const child of Array.from((rule as unknown as CSSGroupingRule).cssRules)) {
            visitRule(child, cond);
          }
        } catch {
          return;
        }
      }
      return;
    }

    if ('selectorText' in rule && 'style' in rule && rule.style instanceof Object) {
      const styleRule = rule as CSSStyleRule;
      const selectorText = cleanText(styleRule.selectorText, 120);
      const styleDecl = styleRule.style;

      if (
        selectorText.includes('.dark') ||
        selectorText.includes('[data-theme') ||
        selectorText.includes('prefers-color-scheme')
      ) {
        if (themeVariantSet.size < 16) {
          themeVariantSet.add(`Selector override \`${selectorText}\``);
        }
      }

      const pseudoKind = classifySelectorPseudoState(selectorText);
      if (pseudoKind && pseudoStateRules.length < 28) {
        const declParts: string[] = [];
        for (const prop of PSEUDO_TRACKED_PROPERTIES) {
          const val = cleanText(styleDecl.getPropertyValue(prop), 60);
          if (val) {
            declParts.push(`${prop}: ${val}`);
          }
        }
        if (declParts.length > 0) {
          const declStr = declParts.join('; ');
          const dedupeKey = `${pseudoKind}|${declStr}`;
          if (!seenStates.has(dedupeKey)) {
            seenStates.add(dedupeKey);
            pseudoStateRules.push({
              state: pseudoKind,
              selector: activeCondition ? `[${activeCondition}] ${selectorText}` : selectorText,
              declarations: declStr,
            });
          }
        }
      }

      if (
        (selectorText.includes('::before') || selectorText.includes('::after')) &&
        stylesheetPseudoElements.length < 16
      ) {
        const pseudo: '::before' | '::after' = selectorText.includes('::before')
          ? '::before'
          : '::after';
        const content = cleanText(styleDecl.getPropertyValue('content'), 40);
        const bg = cleanText(styleDecl.getPropertyValue('background-color'), 40);
        const border = cleanText(styleDecl.getPropertyValue('border'), 40);
        if (content || bg || border) {
          const parts: string[] = [];
          if (content) parts.push(`content: ${content}`);
          if (bg) parts.push(`bg: ${bg}`);
          if (border) parts.push(`border: ${border}`);
          stylesheetPseudoElements.push({
            selector: selectorText,
            pseudo,
            source: 'stylesheet',
            summary: parts.join(', '),
          });
        }
      }

      if (fluidExpressions.length < 24) {
        for (let i = 0; i < styleDecl.length; i += 1) {
          const prop = styleDecl.item(i);
          const rawVal = cleanText(styleDecl.getPropertyValue(prop), 100);
          if (
            rawVal &&
            (rawVal.includes('clamp(') ||
              rawVal.includes('calc(') ||
              rawVal.includes('min(') ||
              rawVal.includes('max('))
          ) {
            const fKey = `${prop}|${rawVal}`;
            if (!seenFluid.has(fKey)) {
              seenFluid.add(fKey);
              fluidExpressions.push({
                selectorOrRule: selectorText,
                property: prop,
                expression: rawVal,
              });
            }
          }
        }
      }
    }

    if ('cssRules' in rule) {
      try {
        for (const child of Array.from((rule as unknown as CSSGroupingRule).cssRules)) {
          visitRule(child, activeCondition);
        }
      } catch {
        return;
      }
    }
  };

  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      visitRule(rule);
    }
  }

  return {
    pseudoStateRules,
    stylesheetPseudoElements,
    fluidExpressions,
    themeVariantRules: Array.from(themeVariantSet),
  };
}

function extractComputedPseudoElements(
  win: Window,
  elements: Element[],
): PseudoElementStyleEntry[] {
  const results: PseudoElementStyleEntry[] = [];
  const seen = new Set<string>();
  const sampleTargets = elements
    .filter((el) => {
      const tag = el.tagName.toLowerCase();
      return (
        tag === 'header' ||
        tag === 'nav' ||
        tag === 'section' ||
        tag === 'button' ||
        tag === 'a' ||
        tag === 'h1' ||
        tag === 'h2'
      );
    })
    .slice(0, 35);

  for (const el of sampleTargets) {
    for (const pseudo of ['::before', '::after'] as const) {
      let cs: CSSStyleDeclaration;
      try {
        cs = win.getComputedStyle(el, pseudo);
      } catch {
        continue;
      }
      const content = cleanText(cs.content, 40);
      if (!content || content === 'none' || content === 'normal') {
        continue;
      }
      const bg = cs.backgroundColor;
      const borderW = parsePixelValue(cs.borderTopWidth);
      const w = cleanText(cs.width, 20);
      const h = cleanText(cs.height, 20);
      const summaryParts = [`content: ${content}`];
      if (w && h && w !== 'auto' && h !== 'auto') summaryParts.push(`size: ${w}x${h}`);
      const bgHex = bg ? parseCssColorToRgba(bg) : null;
      if (bgHex && bgHex.a > 0) summaryParts.push(`bg: ${formatRgbaToHex(bgHex)}`);
      if (borderW > 0) summaryParts.push(`border: ${cs.borderTopWidth} ${cs.borderTopStyle}`);

      const selector = buildShortSelector(el);
      const dedupeKey = `${selector}|${pseudo}|${summaryParts.join('|')}`;
      if (!seen.has(dedupeKey) && results.length < 16) {
        seen.add(dedupeKey);
        results.push({
          selector,
          pseudo,
          source: 'computed',
          summary: summaryParts.join(', '),
        });
      }
    }
  }
  return results;
}

function extractStackingAndA11y(
  doc: Document,
  win: Window,
  elements: Element[],
): {
  stackingLayers: StackingLayerEntry[];
  accessibilityContract: AccessibilityStateEntry[];
} {
  const stackingLayers: StackingLayerEntry[] = [];
  const seenStack = new Set<string>();
  const accessibilityContract: AccessibilityStateEntry[] = [];
  const seenA11y = new Set<string>();

  for (const el of elements) {
    const cs = win.getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    const selector = buildShortSelector(el);

    if (
      (cs.position === 'fixed' || cs.position === 'sticky' || cs.position === 'absolute') &&
      cs.zIndex &&
      cs.zIndex !== 'auto' &&
      cs.zIndex !== '0'
    ) {
      const zKey = `${selector}|${cs.zIndex}`;
      if (!seenStack.has(zKey) && stackingLayers.length < 16) {
        seenStack.add(zKey);
        const roleHint =
          tag === 'header' || el.closest('header')
            ? 'Navigation chrome'
            : selector.includes('modal') ||
                selector.includes('dialog') ||
                selector.includes('cookie')
              ? 'Overlay / banner'
              : selector.includes('cursor')
                ? 'Custom cursor layer'
                : 'Positioned visual layer';
        stackingLayers.push({
          selector,
          position: cs.position,
          zIndex: cs.zIndex,
          roleHint,
        });
      }
    }

    const explicitRole = (el.getAttribute('role') ?? '').toLowerCase();
    const implicitRole =
      tag === 'header'
        ? 'banner'
        : tag === 'nav'
          ? 'navigation'
          : tag === 'main'
            ? 'main'
            : tag === 'footer'
              ? 'contentinfo'
              : tag === 'aside'
                ? 'complementary'
                : tag === 'dialog'
                  ? 'dialog'
                  : tag === 'details'
                    ? 'disclosure'
                    : explicitRole;
    const ariaExpanded = el.getAttribute('aria-expanded');
    const ariaHasPopup = el.getAttribute('aria-haspopup');
    const ariaControls = el.getAttribute('aria-controls');
    const tabIndex = el.getAttribute('tabindex');
    const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';

    if (implicitRole || ariaExpanded !== null || ariaHasPopup !== null) {
      const category: AccessibilityStateEntry['category'] =
        implicitRole === 'dialog' || implicitRole === 'alertdialog'
          ? 'dialog'
          : implicitRole === 'tablist' || implicitRole === 'tab'
            ? 'tablist'
            : ariaExpanded !== null || implicitRole === 'disclosure' || ariaHasPopup !== null
              ? 'disclosure'
              : implicitRole === 'banner' ||
                  implicitRole === 'navigation' ||
                  implicitRole === 'main' ||
                  implicitRole === 'contentinfo' ||
                  implicitRole === 'complementary'
                ? 'landmark'
                : 'control';
      const states: string[] = [];
      if (ariaExpanded !== null) states.push(`aria-expanded=${ariaExpanded}`);
      if (ariaHasPopup !== null) states.push(`aria-haspopup=${ariaHasPopup}`);
      if (ariaControls) states.push(`aria-controls=${ariaControls}`);
      if (tabIndex !== null) states.push(`tabindex=${tabIndex}`);
      if (disabled) states.push('disabled');

      const label = cleanText(el.getAttribute('aria-label') || el.textContent, 50) || selector;
      const aKey = `${category}|${selector}|${states.join(',')}`;
      if (!seenA11y.has(aKey) && accessibilityContract.length < 24) {
        seenA11y.add(aKey);
        accessibilityContract.push({
          category,
          selector,
          role: implicitRole || tag,
          label,
          states,
        });
      }
    }
  }

  stackingLayers.sort((a, b) => Number.parseInt(b.zIndex, 10) - Number.parseInt(a.zIndex, 10));
  if (accessibilityContract.length === 0) {
    accessibilityContract.push({
      category: 'landmark',
      selector: 'body',
      role: 'document',
      label: 'Document root',
      states: [],
    });
  }
  return { stackingLayers, accessibilityContract };
}

function buildAdaptedOutputs(
  inputs: StyleAdaptationInputs,
  pseudoRules: PseudoStateRuleEntry[],
): {
  adaptedCssThemeBlock: string;
  adaptedTailwindThemeBlock: string;
  adaptedTailwindUtilities: Array<{ role: string; classes: string }>;
  reconstructionAssertions: string[];
} {
  const accent = inputs.accentHex ?? inputs.primaryTextHex;
  const surface = inputs.surfaceHex ?? inputs.canvasHex;
  const muted = inputs.mutedTextHex ?? inputs.primaryTextHex;
  const border = inputs.borderHex ?? '#d4d4d8';
  const hasFilledButtonBg = Boolean(inputs.buttonBg && inputs.buttonBg !== 'transparent');
  const btnBg = hasFilledButtonBg ? (inputs.buttonBg ?? accent) : accent;
  const rawBtnFg = hasFilledButtonBg ? (inputs.buttonText ?? '#ffffff') : '#ffffff';
  const rawContrast = computeWcagContrastRatio(rawBtnFg, btnBg);
  const btnFg =
    rawContrast !== null && rawContrast < 3
      ? (computeWcagContrastRatio('#ffffff', btnBg) ?? 0) >=
        (computeWcagContrastRatio('#111827', btnBg) ?? 0)
        ? '#ffffff'
        : '#111827'
      : rawBtnFg;
  const btnRad = inputs.buttonRadius ?? '4px';
  const btnPad =
    inputs.buttonPadding && inputs.buttonPadding !== '0px' ? inputs.buttonPadding : '10px 18px';
  const cardRad = inputs.cardRadius ?? '8px';

  const hoverRule =
    pseudoRules.find(
      (r) =>
        r.state === ':hover' &&
        (r.declarations.includes('background-color') ||
          r.declarations.includes('color') ||
          r.declarations.includes('border-color') ||
          r.declarations.includes('transform') ||
          r.declarations.includes('box-shadow')),
    )?.declarations ??
    pseudoRules.find((r) => r.state === ':hover' && r.declarations !== 'outline: 0px')
      ?.declarations;
  const focusRule = pseudoRules.find(
    (r) =>
      (r.state === ':focus-visible' || r.state === ':focus') &&
      r.declarations !== 'outline: none' &&
      r.declarations !== 'outline: 0px' &&
      !r.declarations.endsWith('outline: 0px'),
  )?.declarations;

  const cssLines = [
    ':root {',
    `  --sa-canvas: ${inputs.canvasHex};`,
    `  --sa-surface: ${surface};`,
    `  --sa-ink-primary: ${inputs.primaryTextHex};`,
    `  --sa-ink-muted: ${muted};`,
    `  --sa-accent: ${accent};`,
    `  --sa-border: ${border};`,
    `  --sa-font-sans: ${inputs.primaryFontStack};`,
    ...(inputs.monoFontStack ? [`  --sa-font-mono: ${inputs.monoFontStack};`] : []),
    `  --sa-root-size: ${inputs.rootFontSizePx};`,
    `  --sa-radius-btn: ${btnRad};`,
    `  --sa-radius-card: ${cardRad};`,
    '}',
    '.sa-page {',
    '  background-color: var(--sa-canvas);',
    '  color: var(--sa-ink-primary);',
    '  font-family: var(--sa-font-sans);',
    '}',
    '.sa-btn-primary {',
    `  background-color: ${btnBg};`,
    `  color: ${btnFg};`,
    '  border-radius: var(--sa-radius-btn);',
    `  padding: ${btnPad};`,
    '  transition: color 0.25s ease, background-color 0.25s ease, transform 0.25s ease;',
    '}',
    ...(hoverRule ? [`.sa-btn-primary:hover { ${hoverRule}; }`] : []),
    ...(focusRule
      ? [`.sa-btn-primary:focus-visible { ${focusRule}; }`]
      : [
          `.sa-btn-primary:focus-visible { outline: 2px solid var(--sa-accent); outline-offset: 2px; }`,
        ]),
    '.sa-card {',
    '  background-color: var(--sa-surface);',
    '  border: 1px solid var(--sa-border);',
    '  border-radius: var(--sa-radius-card);',
    '}',
  ];

  const tailwindThemeLines = [
    '@import "tailwindcss";',
    '@theme {',
    `  --color-canvas: ${inputs.canvasHex};`,
    `  --color-surface: ${surface};`,
    `  --color-ink: ${inputs.primaryTextHex};`,
    `  --color-ink-muted: ${muted};`,
    `  --color-brand: ${accent};`,
    `  --color-line: ${border};`,
    `  --font-sans: ${inputs.primaryFontStack};`,
    ...(inputs.monoFontStack ? [`  --font-mono: ${inputs.monoFontStack};`] : []),
    `  --radius-btn: ${btnRad};`,
    `  --radius-card: ${cardRad};`,
    '}',
  ];

  const adaptedTailwindUtilities: Array<{ role: string; classes: string }> = [
    {
      role: 'Page Root',
      classes: `min-h-screen bg-[${inputs.canvasHex}] text-[${inputs.primaryTextHex}] antialiased`,
    },
    {
      role: 'Display H1',
      classes: `${inputs.h1FontSize ? `text-[${inputs.h1FontSize}]` : 'text-4xl'} font-bold leading-none text-[${inputs.h1ColorHex ?? inputs.primaryTextHex}]`,
    },
    {
      role: 'Primary CTA',
      classes: `inline-flex items-center justify-center bg-[${btnBg}] text-[${btnFg}] rounded-[${btnRad}] font-medium transition-colors duration-300`,
    },
    {
      role: 'Surface Card',
      classes: `bg-[${surface}] border border-[${border}] rounded-[${cardRad}]`,
    },
  ];

  const reconstructionAssertions: string[] = [
    `Root canvas computed background stays near ${inputs.canvasHex} (${inputs.primaryTextHex} foreground text).`,
    `Primary typography family resolves to "${inputs.primaryFontName}" with root html size ${inputs.rootFontSizePx}.`,
    ...(inputs.headerHeightPx
      ? [`Top header landmark height measures ~${inputs.headerHeightPx}px at desktop viewport.`]
      : []),
    ...(inputs.h1FontSize
      ? [
          `Primary H1 headline renders at ${inputs.h1FontSize} in ${inputs.h1ColorHex ?? inputs.primaryTextHex}.`,
        ]
      : []),
    ...(inputs.breakpoints && inputs.breakpoints.length > 0
      ? [
          `Responsive layout adapts across observed breakpoints: ${inputs.breakpoints.slice(0, 4).join(', ')}.`,
        ]
      : []),
  ];

  return {
    adaptedCssThemeBlock: cssLines.join('\n'),
    adaptedTailwindThemeBlock: tailwindThemeLines.join('\n'),
    adaptedTailwindUtilities,
    reconstructionAssertions,
  };
}

export function extractStyleAdaptationReport(
  doc: Document,
  win: Window,
  inputs: StyleAdaptationInputs,
  existingColorsReport?: ColorExtractionReport,
  existingFontsReport?: FontExtractionReport,
): StyleAdaptationReport {
  const { entries, openShadowRootsCount, truncated } = collectDocumentElements(doc, 1200);
  const frameAndSheet = inspectFramesAndStylesheets(doc, openShadowRootsCount);

  const omissionReasons: string[] = [];
  if (frameAndSheet.inaccessibleStylesheets.length > 0) {
    omissionReasons.push(
      `${frameAndSheet.inaccessibleStylesheets.length} cross-origin stylesheet(s) omitted cssRules due to CORS`,
    );
  }
  if (frameAndSheet.inaccessibleCrossOriginFrames.length > 0) {
    omissionReasons.push(
      `${frameAndSheet.inaccessibleCrossOriginFrames.length} cross-origin iframe(s) excluded from DOM inspection`,
    );
  }
  if (truncated) {
    omissionReasons.push('DOM traversal hit 1200-element budget; deep tail nodes omitted');
  }

  const completeness: StyleEvidenceCompleteness = {
    coverageStatus: omissionReasons.length === 0 ? 'complete' : 'partial',
    accessibleStylesheetsCount: frameAndSheet.accessibleStylesheetsCount,
    inaccessibleStylesheets: frameAndSheet.inaccessibleStylesheets,
    sameOriginFramesCount: frameAndSheet.sameOriginFramesCount,
    inaccessibleCrossOriginFrames: frameAndSheet.inaccessibleCrossOriginFrames,
    openShadowRootsCount: frameAndSheet.openShadowRootsCount,
    scannedElementsCount: entries.length,
    domTruncated: truncated,
    omissionReasons,
  };

  const wcagContrastPairs: WcagContrastAuditEntry[] = [];
  const addContrastPair = (
    pairLabel: string,
    fg: string | undefined,
    bg: string | undefined,
  ): void => {
    if (!fg || !bg) return;
    const ratio = computeWcagContrastRatio(fg, bg);
    if (ratio === null) return;
    wcagContrastPairs.push({
      pairLabel,
      foregroundHex: fg,
      backgroundHex: bg,
      contrastRatio: ratio,
      grade: classifyContrastGrade(ratio),
    });
  };

  addContrastPair('Canvas vs Body Text', inputs.primaryTextHex, inputs.canvasHex);
  if (inputs.h1ColorHex && inputs.h1ColorHex !== inputs.primaryTextHex) {
    addContrastPair('Canvas vs H1 Headline', inputs.h1ColorHex, inputs.canvasHex);
  }
  if (inputs.mutedTextHex) {
    addContrastPair('Canvas vs Muted Ink', inputs.mutedTextHex, inputs.canvasHex);
  }
  if (inputs.buttonBg && inputs.buttonBg !== 'transparent' && inputs.buttonText) {
    addContrastPair('Primary Button Text', inputs.buttonText, inputs.buttonBg);
  } else if (inputs.accentHex) {
    addContrastPair('Accent on Canvas', inputs.accentHex, inputs.canvasHex);
  }

  const sheetMeta = scanStylesheetAdaptationRules(doc);
  const livePseudos = extractComputedPseudoElements(
    win,
    entries.map((e) => e.element),
  );
  const pseudoElementStyles = [...livePseudos, ...sheetMeta.stylesheetPseudoElements].slice(0, 20);
  const { stackingLayers, accessibilityContract } = extractStackingAndA11y(
    doc,
    win,
    entries.map((e) => e.element),
  );

  const monoStack = existingFontsReport?.families.find(
    (f) =>
      f.primaryFamily.toLowerCase().includes('mono') ||
      f.declaredStack.toLowerCase().includes('monospace'),
  )?.declaredStack;

  const fallbackAccent =
    inputs.accentHex ??
    existingColorsReport?.colors.find(
      (c) =>
        c.hex !== inputs.canvasHex &&
        c.hex !== inputs.primaryTextHex &&
        c.hex !== '#0000ee' &&
        Math.max(c.rgba.r, c.rgba.g, c.rgba.b) - Math.min(c.rgba.r, c.rgba.g, c.rgba.b) >= 35,
    )?.hex;

  const adapted = buildAdaptedOutputs(
    {
      ...inputs,
      ...(fallbackAccent ? { accentHex: fallbackAccent } : {}),
      ...(monoStack ? { monoFontStack: monoStack } : {}),
    },
    sheetMeta.pseudoStateRules,
  );

  return {
    completeness,
    wcagContrastPairs,
    pseudoStateRules: sheetMeta.pseudoStateRules,
    pseudoElementStyles,
    fluidExpressions: sheetMeta.fluidExpressions,
    themeVariantRules: sheetMeta.themeVariantRules,
    stackingLayers,
    accessibilityContract,
    ...adapted,
  };
}
