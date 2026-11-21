import { extractPageColors, type ColorExtractionReport } from './colors-engine.js';
import { buildShortSelector, collectDocumentElements, parsePixelValue } from './dom-utils.js';
import { extractPageFonts, type FontExtractionReport } from './fonts-engine.js';

export interface PageDesignSnapshotInput {
  pageUrl: string;
  pageTitle: string;
  capturedAt?: string;
  colorsReport: ColorExtractionReport;
  fontsReport: FontExtractionReport;
  spacingTokensPx: number[];
  borderRadii: string[];
  boxShadows: string[];
  layoutPatterns: string[];
  componentObservations: string[];
}

export interface DesignTokenConflict {
  category: 'custom_property' | 'primary_font' | 'background_palette';
  tokenOrKey: string;
  valuesByPage: Array<{ pageUrl: string; value: string }>;
}

export interface DesignMdGenerationResult {
  markdown: string;
  combinedPageCount: number;
  deduplicatedColorsCount: number;
  deduplicatedFontFamiliesCount: number;
  deduplicatedSpacingTokensPx: number[];
  conflicts: DesignTokenConflict[];
}

export function extractPageDesignSnapshot(doc: Document, win: Window): PageDesignSnapshotInput {
  const colorsReport = extractPageColors(doc, win);
  const fontsReport = extractPageFonts(doc, win);
  const { entries } = collectDocumentElements(doc, 1200);

  const spacingSet = new Set<number>();
  const radiusSet = new Set<string>();
  const shadowSet = new Set<string>();
  const layoutPatternSet = new Set<string>();
  const componentSet = new Set<string>();

  for (const { element } of entries) {
    const tag = element.tagName.toLowerCase();
    const style = win.getComputedStyle(element);

    const spacingCandidates = [
      parsePixelValue(style.paddingTop),
      parsePixelValue(style.paddingRight),
      parsePixelValue(style.paddingBottom),
      parsePixelValue(style.paddingLeft),
      parsePixelValue(style.marginTop),
      parsePixelValue(style.marginBottom),
      parsePixelValue(style.gap),
    ];
    for (const val of spacingCandidates) {
      if (val > 0 && val <= 256) {
        spacingSet.add(Math.round(val));
      }
    }

    const radius = style.borderRadius.trim();
    if (radius && radius !== '0px' && radius !== '0%') {
      radiusSet.add(radius);
    }

    const shadow = style.boxShadow.trim();
    if (shadow && shadow !== 'none') {
      shadowSet.add(shadow);
    }

    if (style.display === 'grid' || style.display === 'inline-grid') {
      layoutPatternSet.add(
        `CSS Grid on \`${buildShortSelector(element)}\` (columns: \`${style.gridTemplateColumns || 'auto'}\`, gap: \`${style.gap || '0px'}\`)`,
      );
    } else if (style.display === 'flex' || style.display === 'inline-flex') {
      layoutPatternSet.add(
        `Flexbox on \`${buildShortSelector(element)}\` (direction: \`${style.flexDirection || 'row'}\`, justify: \`${style.justifyContent || 'normal'}\`, align: \`${style.alignItems || 'normal'}\`)`,
      );
    }

    if (style.position === 'sticky' || style.position === 'fixed') {
      layoutPatternSet.add(
        `${style.position.toUpperCase()} positioned landmark on \`${buildShortSelector(element)}\``,
      );
    }

    if (tag === 'nav' || element.getAttribute('role') === 'navigation') {
      componentSet.add(`Navigation bar (\`${buildShortSelector(element)}\`)`);
    } else if (tag === 'header') {
      componentSet.add(`Page header (\`${buildShortSelector(element)}\`)`);
    } else if (tag === 'button' || element.getAttribute('role') === 'button') {
      componentSet.add(
        `Interactive button (\`${buildShortSelector(element)}\`, bg: \`${style.backgroundColor}\`, radius: \`${style.borderRadius || '0px'}\`)`,
      );
    } else if (tag === 'form') {
      componentSet.add(`Form container (\`${buildShortSelector(element)}\`)`);
    } else if (tag === 'table') {
      componentSet.add(`Data table (\`${buildShortSelector(element)}\`)`);
    } else if (tag === 'footer') {
      componentSet.add(`Page footer (\`${buildShortSelector(element)}\`)`);
    }
  }

  return {
    pageUrl: doc.location.href || 'https://localhost/',
    pageTitle: doc.title.trim() || 'Untitled Page',
    colorsReport,
    fontsReport,
    spacingTokensPx: Array.from(spacingSet).sort((a, b) => a - b),
    borderRadii: Array.from(radiusSet).sort(),
    boxShadows: Array.from(shadowSet).sort(),
    layoutPatterns: Array.from(layoutPatternSet).slice(0, 20),
    componentObservations: Array.from(componentSet).slice(0, 20),
  };
}

export function generateDesignMdFromPages(
  pages: PageDesignSnapshotInput[],
): DesignMdGenerationResult {
  if (pages.length === 0) {
    throw new Error('At least one page snapshot is required to generate DESIGN.md');
  }

  const colorUsageByHex = new Map<
    string,
    {
      hex: string;
      rgbString: string;
      hslString: string;
      totalUsage: number;
      properties: Set<string>;
    }
  >();

  const customPropValuesByPage = new Map<string, Array<{ pageUrl: string; value: string }>>();
  const fontUsageByFamily = new Map<
    string,
    {
      primaryFamily: string;
      declaredStack: string;
      totalUsage: number;
      sizes: Set<string>;
      weights: Set<string>;
      lineHeights: Set<string>;
    }
  >();

  const primaryFontByPage: Array<{ pageUrl: string; primaryFamily: string }> = [];
  const spacingSet = new Set<number>();
  const radiusSet = new Set<string>();
  const shadowSet = new Set<string>();
  const layoutPatternSet = new Set<string>();
  const componentSet = new Set<string>();

  for (const page of pages) {
    for (const c of page.colorsReport.colors) {
      const existing = colorUsageByHex.get(c.hex);
      if (existing) {
        existing.totalUsage += c.usageCount;
        for (const p of c.properties) {
          existing.properties.add(p);
        }
      } else {
        colorUsageByHex.set(c.hex, {
          hex: c.hex,
          rgbString: c.rgbString,
          hslString: c.hslString,
          totalUsage: c.usageCount,
          properties: new Set(c.properties),
        });
      }
    }

    for (const prop of page.colorsReport.customProperties) {
      const list = customPropValuesByPage.get(prop.name) ?? [];
      list.push({ pageUrl: page.pageUrl, value: prop.normalizedHex ?? prop.rawValue });
      customPropValuesByPage.set(prop.name, list);
    }

    const topFont = page.fontsReport.families[0];
    if (topFont) {
      primaryFontByPage.push({
        pageUrl: page.pageUrl,
        primaryFamily: topFont.primaryFamily,
      });
    }

    for (const fam of page.fontsReport.families) {
      const existing = fontUsageByFamily.get(fam.primaryFamily);
      const sizes = fam.combinations.map((c) => c.fontSize);
      const weights = fam.combinations.map((c) => c.fontWeight);
      const lineHeights = fam.combinations.map((c) => c.lineHeight);
      if (existing) {
        existing.totalUsage += fam.totalUsageCount;
        sizes.forEach((s) => existing.sizes.add(s));
        weights.forEach((w) => existing.weights.add(w));
        lineHeights.forEach((lh) => existing.lineHeights.add(lh));
      } else {
        fontUsageByFamily.set(fam.primaryFamily, {
          primaryFamily: fam.primaryFamily,
          declaredStack: fam.declaredStack,
          totalUsage: fam.totalUsageCount,
          sizes: new Set(sizes),
          weights: new Set(weights),
          lineHeights: new Set(lineHeights),
        });
      }
    }

    page.spacingTokensPx.forEach((s) => spacingSet.add(s));
    page.borderRadii.forEach((r) => radiusSet.add(r));
    page.boxShadows.forEach((sh) => shadowSet.add(sh));
    page.layoutPatterns.forEach((lp) => layoutPatternSet.add(lp));
    page.componentObservations.forEach((co) => componentSet.add(co));
  }

  const conflicts: DesignTokenConflict[] = [];

  for (const [propName, entries] of Array.from(customPropValuesByPage.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const distinctValues = new Set(entries.map((e) => e.value));
    if (distinctValues.size > 1) {
      conflicts.push({
        category: 'custom_property',
        tokenOrKey: propName,
        valuesByPage: entries,
      });
    }
  }

  const distinctPrimaryFonts = new Set(primaryFontByPage.map((p) => p.primaryFamily));
  if (pages.length > 1 && distinctPrimaryFonts.size > 1) {
    conflicts.push({
      category: 'primary_font',
      tokenOrKey: 'primary-font-family',
      valuesByPage: primaryFontByPage.map((p) => ({
        pageUrl: p.pageUrl,
        value: p.primaryFamily,
      })),
    });
  }

  const deduplicatedColors = Array.from(colorUsageByHex.values()).sort(
    (a, b) => b.totalUsage - a.totalUsage || a.hex.localeCompare(b.hex),
  );
  const deduplicatedFonts = Array.from(fontUsageByFamily.values()).sort(
    (a, b) => b.totalUsage - a.totalUsage || a.primaryFamily.localeCompare(b.primaryFamily),
  );
  const sortedSpacing = Array.from(spacingSet).sort((a, b) => a - b);
  const sortedRadii = Array.from(radiusSet).sort();
  const sortedShadows = Array.from(shadowSet).sort();

  const lines: string[] = [];
  const primaryTitle =
    pages.length === 1
      ? (pages[0]?.pageTitle ?? 'Design System')
      : `Combined Design System (${pages.length} Pages)`;
  lines.push(`# DESIGN.md — ${primaryTitle}`);
  lines.push('');
  lines.push('## 1. Source References');
  for (const page of pages) {
    lines.push(`- **${page.pageTitle}**: ${page.pageUrl}`);
  }
  lines.push('');

  lines.push('## 2. Color Palette');
  if (deduplicatedColors.length === 0) {
    lines.push('- No computed colors extracted.');
  } else {
    for (const c of deduplicatedColors.slice(0, 24)) {
      lines.push(
        `- \`${c.hex}\` (\`${c.rgbString}\` / \`${c.hslString}\`) — used ${c.totalUsage}x across \`${Array.from(c.properties).sort().join(', ')}\``,
      );
    }
  }
  lines.push('');

  lines.push('## 3. Typography');
  if (deduplicatedFonts.length === 0) {
    lines.push('- No typography rules extracted.');
  } else {
    for (const f of deduplicatedFonts) {
      lines.push(
        `- **${f.primaryFamily}** (stack: \`${f.declaredStack}\`, usage: ${f.totalUsage}x)`,
      );
      lines.push(`  - Sizes: \`${Array.from(f.sizes).sort().join(', ')}\``);
      lines.push(`  - Weights: \`${Array.from(f.weights).sort().join(', ')}\``);
      lines.push(`  - Line Heights: \`${Array.from(f.lineHeights).sort().join(', ')}\``);
    }
  }
  lines.push('');

  lines.push('## 4. Spacing Scale');
  if (sortedSpacing.length === 0) {
    lines.push('- Default browser spacing.');
  } else {
    lines.push(
      `- Extracted spacing steps (px): ${sortedSpacing.map((px) => `\`${px}px\``).join(', ')}`,
    );
  }
  lines.push('');

  lines.push('## 5. Border Radius & Shadows');
  lines.push(
    `- **Border Radii**: ${sortedRadii.length > 0 ? sortedRadii.map((r) => `\`${r}\``).join(', ') : 'None (`0px`)'}`,
  );
  lines.push(
    `- **Box Shadows**: ${sortedShadows.length > 0 ? sortedShadows.map((s) => `\`${s}\``).join('; ') : 'None'}`,
  );
  lines.push('');

  lines.push('## 6. Layout Patterns');
  if (layoutPatternSet.size === 0) {
    lines.push('- Standard block flow.');
  } else {
    for (const pattern of Array.from(layoutPatternSet).sort()) {
      lines.push(`- ${pattern}`);
    }
  }
  lines.push('');

  lines.push('## 7. Component Observations');
  if (componentSet.size === 0) {
    lines.push('- Generic semantic containers.');
  } else {
    for (const comp of Array.from(componentSet).sort()) {
      lines.push(`- ${comp}`);
    }
  }
  lines.push('');

  lines.push('## 8. Cross-Page Token Conflicts');
  if (conflicts.length === 0) {
    lines.push('- No cross-page token conflicts detected.');
  } else {
    for (const conflict of conflicts) {
      const details = conflict.valuesByPage
        .map((v) => `\`${v.value}\` on ${v.pageUrl}`)
        .join(' vs. ');
      lines.push(`- **${conflict.category}** (\`${conflict.tokenOrKey}\`): ${details}`);
    }
  }

  return {
    markdown: lines.join('\n') + '\n',
    combinedPageCount: pages.length,
    deduplicatedColorsCount: deduplicatedColors.length,
    deduplicatedFontFamiliesCount: deduplicatedFonts.length,
    deduplicatedSpacingTokensPx: sortedSpacing,
    conflicts,
  };
}
