import { parseCssColorToRgba } from './colors-engine.js';
import { buildShortSelector, collectDocumentElements, parsePixelValue } from './dom-utils.js';

export type DesignIssueCategory =
  | 'weak_hierarchy'
  | 'repetitive_treatment'
  | 'excessive_effects'
  | 'inconsistent_spacing'
  | 'contrast_failure';

export interface DesignReviewFinding {
  id: string;
  category: DesignIssueCategory;
  severity: 'high' | 'medium' | 'low';
  title: string;
  evidence: string;
  affectedSelectors: string[];
  suggestion: string;
}

export interface DesignReviewReport {
  findings: DesignReviewFinding[];
  metrics: {
    h1Count: number;
    headingScaleRatio: number;
    distinctSpacingValuesCount: number;
    offGridSpacingValuesPx: number[];
    contrastFailuresCount: number;
    heavyEffectElementsCount: number;
  };
  localFixPrompt: string;
  methodologyDisclaimer: string;
}

function srgbChannelToLuminance(channel255: number): number {
  const c = channel255 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function computeRelativeLuminance(rgb: { r: number; g: number; b: number }): number {
  const r = srgbChannelToLuminance(rgb.r);
  const g = srgbChannelToLuminance(rgb.g);
  const b = srgbChannelToLuminance(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function computeWcagContrastRatio(
  fg: { r: number; g: number; b: number },
  bg: { r: number; g: number; b: number },
): number {
  const l1 = computeRelativeLuminance(fg);
  const l2 = computeRelativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

function resolveEffectiveBackgroundRgba(
  el: Element,
  win: Window,
): { r: number; g: number; b: number; a: number } {
  let current: Element | null = el;
  while (current) {
    const bg = win.getComputedStyle(current).backgroundColor;
    const parsed = parseCssColorToRgba(bg);
    if (parsed && parsed.a >= 0.85) {
      return parsed;
    }
    current = current.parentElement;
  }
  return { r: 255, g: 255, b: 255, a: 1 };
}

export function runLocalDesignReview(doc: Document, win: Window): DesignReviewReport {
  const { entries } = collectDocumentElements(doc, 1200);
  const findings: DesignReviewFinding[] = [];

  const h1Elements = entries.filter((e) => e.element.tagName.toLowerCase() === 'h1');
  const bodyFontSize = parsePixelValue(win.getComputedStyle(doc.body).fontSize) || 16;
  const maxHeadingSize = h1Elements.reduce((max, entry) => {
    const size = parsePixelValue(win.getComputedStyle(entry.element).fontSize);
    return Math.max(max, size);
  }, 0);
  const headingScaleRatio =
    maxHeadingSize > 0 ? Number((maxHeadingSize / bodyFontSize).toFixed(2)) : 1;

  if (h1Elements.length === 0) {
    findings.push({
      id: `finding-${findings.length + 1}`,
      category: 'weak_hierarchy',
      severity: 'medium',
      title: 'Missing primary <h1> heading landmark',
      evidence: '0 <h1> elements found in the active document.',
      affectedSelectors: ['body'],
      suggestion: 'Establish a clear primary <h1> heading with a distinct typographic scale.',
    });
  } else if (h1Elements.length > 2) {
    findings.push({
      id: `finding-${findings.length + 1}`,
      category: 'weak_hierarchy',
      severity: 'medium',
      title: 'Multiple competing <h1> headings dilute visual hierarchy',
      evidence: `${h1Elements.length} separate <h1> elements detected.`,
      affectedSelectors: h1Elements.slice(0, 5).map((e) => buildShortSelector(e.element)),
      suggestion:
        'Keep a single primary <h1> per page view and demote section titles to <h2>/<h3>.',
    });
  } else if (headingScaleRatio > 0 && headingScaleRatio < 1.25) {
    findings.push({
      id: `finding-${findings.length + 1}`,
      category: 'weak_hierarchy',
      severity: 'medium',
      title: 'Compressed heading-to-body font size ratio',
      evidence: `Primary <h1> font size (${maxHeadingSize}px) is only ${headingScaleRatio}x body size (${bodyFontSize}px).`,
      affectedSelectors: h1Elements.map((e) => buildShortSelector(e.element)),
      suggestion:
        'Increase primary heading scale to at least 1.75x - 2.5x body text size with tighter line-height.',
    });
  }

  const cardSignatureMap = new Map<string, string[]>();
  const heavyEffectSelectors: string[] = [];
  const spacingSteps = new Set<number>();
  const contrastFailures: Array<{ selector: string; ratio: number; required: number }> = [];

  for (const { element } of entries) {
    const style = win.getComputedStyle(element);
    const selector = buildShortSelector(element);

    const bgImage = style.backgroundImage;
    const shadow = style.boxShadow;
    const radius = style.borderRadius;
    if (
      (bgImage && bgImage !== 'none' && bgImage.includes('gradient(')) ||
      (shadow && shadow !== 'none' && radius && radius !== '0px')
    ) {
      const sig = `${bgImage}|${shadow}|${radius}`;
      const list = cardSignatureMap.get(sig) ?? [];
      list.push(selector);
      cardSignatureMap.set(sig, list);
    }

    const filter = style.filter;
    const backdropFilter = style.getPropertyValue('backdrop-filter');
    const shadowLayersCount = shadow && shadow !== 'none' ? shadow.split('),').length : 0;
    if (
      (filter && filter !== 'none' && filter.includes('blur(')) ||
      (backdropFilter && backdropFilter !== 'none' && backdropFilter.includes('blur(')) ||
      shadowLayersCount >= 3
    ) {
      heavyEffectSelectors.push(selector);
    }

    const paddingsAndGaps = [
      parsePixelValue(style.paddingTop),
      parsePixelValue(style.paddingBottom),
      parsePixelValue(style.paddingLeft),
      parsePixelValue(style.paddingRight),
      parsePixelValue(style.gap),
    ];
    for (const val of paddingsAndGaps) {
      if (val > 0 && val <= 160) {
        spacingSteps.add(Math.round(val));
      }
    }

    const directText = Array.from(element.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => (n.nodeValue ?? '').trim())
      .join('');
    if (directText.length >= 2) {
      const fg = parseCssColorToRgba(style.color);
      if (fg && fg.a >= 0.5) {
        const bg = resolveEffectiveBackgroundRgba(element, win);
        const ratio = computeWcagContrastRatio(fg, bg);
        const fontSizePx = parsePixelValue(style.fontSize) || 16;
        const fontWeightNum = Number.parseInt(style.fontWeight, 10) || 400;
        const isLargeText = fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeightNum >= 700);
        const requiredRatio = isLargeText ? 3.0 : 4.5;
        if (ratio < requiredRatio) {
          contrastFailures.push({ selector, ratio, required: requiredRatio });
        }
      }
    }
  }

  for (const [sig, selectors] of cardSignatureMap.entries()) {
    if (selectors.length >= 5) {
      findings.push({
        id: `finding-${findings.length + 1}`,
        category: 'repetitive_treatment',
        severity: 'low',
        title: 'Repetitive gradient/shadow card treatment across page sections',
        evidence: `${selectors.length} elements share identical effect signature (${sig.slice(0, 100)}).`,
        affectedSelectors: selectors.slice(0, 6),
        suggestion:
          'Differentiate primary focal cards from secondary containers using subtle borders or flat surface elevation instead of repeating identical gradients/shadows.',
      });
    }
  }

  if (heavyEffectSelectors.length > 0) {
    findings.push({
      id: `finding-${findings.length + 1}`,
      category: 'excessive_effects',
      severity: heavyEffectSelectors.length >= 4 ? 'medium' : 'low',
      title: 'Heavy blur or multi-layered drop shadows detected',
      evidence: `${heavyEffectSelectors.length} elements apply blur filters or 3+ stacked box-shadow layers.`,
      affectedSelectors: heavyEffectSelectors.slice(0, 6),
      suggestion:
        'Reduce stacked blur/shadow effects to improve rendering performance and visual crispness.',
    });
  }

  const sortedSpacing = Array.from(spacingSteps).sort((a, b) => a - b);
  const offGridSpacingValuesPx = sortedSpacing.filter((px) => px % 4 !== 0 && px !== 2);
  if (offGridSpacingValuesPx.length >= 3) {
    findings.push({
      id: `finding-${findings.length + 1}`,
      category: 'inconsistent_spacing',
      severity: 'medium',
      title: 'Inconsistent off-grid spacing values',
      evidence: `Found ${offGridSpacingValuesPx.length} spacing values outside a 4px/8px rhythm: ${offGridSpacingValuesPx.map((v) => `${v}px`).join(', ')}.`,
      affectedSelectors: ['body'],
      suggestion:
        'Consolidate padding and gap values onto a consistent 4px/8px scale (4, 8, 12, 16, 24, 32, 48, 64px).',
    });
  }

  if (contrastFailures.length > 0) {
    const worst = contrastFailures.sort((a, b) => a.ratio - b.ratio)[0];
    findings.push({
      id: `finding-${findings.length + 1}`,
      category: 'contrast_failure',
      severity: 'high',
      title: 'Text elements fail WCAG 2.1 AA contrast thresholds',
      evidence: `${contrastFailures.length} text elements fall below required contrast (lowest: ${worst?.ratio ?? 0}:1 vs. required ${worst?.required ?? 4.5}:1 on ${worst?.selector ?? 'element'}).`,
      affectedSelectors: Array.from(new Set(contrastFailures.map((c) => c.selector))).slice(0, 6),
      suggestion:
        'Darken foreground text or lighten surface backgrounds so body text meets >= 4.5:1 and large headings meet >= 3.0:1 contrast.',
    });
  }

  const fixPromptLines = [
    '# Design Quality Remediation Prompt',
    '',
    'Apply the following evidence-based design fixes while preserving semantic structure:',
    ...findings.map(
      (f, idx) =>
        `${idx + 1}. **[${f.category.toUpperCase()}] ${f.title}** (${f.evidence}) -> ${f.suggestion}`,
    ),
  ];

  return {
    findings,
    metrics: {
      h1Count: h1Elements.length,
      headingScaleRatio,
      distinctSpacingValuesCount: sortedSpacing.length,
      offGridSpacingValuesPx,
      contrastFailuresCount: contrastFailures.length,
      heavyEffectElementsCount: heavyEffectSelectors.length,
    },
    localFixPrompt:
      findings.length > 0
        ? fixPromptLines.join('\n') + '\n'
        : 'No major hierarchy, spacing, effect, or WCAG contrast issues were detected in the local audit.',
    methodologyDisclaimer:
      'Heuristic design review evaluates observable layout, typography, spacing, and WCAG contrast signals only. It does not prove AI authorship or provide scientifically reliable authorship probabilities.',
  };
}
