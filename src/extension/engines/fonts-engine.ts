import { collectDocumentElements, inspectFramesAndStylesheets } from './dom-utils.js';

export interface FontStyleCombination {
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
  usageCount: number;
  sampleTags: string[];
  sampleText: string;
}

export interface FontFamilyReportEntry {
  declaredStack: string;
  primaryFamily: string;
  totalUsageCount: number;
  verifiedLoadedInFontFaceSet: boolean | 'unsupported';
  combinations: FontStyleCombination[];
}

export interface FontFaceDeclarationEntry {
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  fontDisplay: string;
  urls: string[];
}

export interface FontExtractionReport {
  families: FontFamilyReportEntry[];
  fontFaceDeclarations: FontFaceDeclarationEntry[];
  diagnostics: {
    scannedElementsCount: number;
    inaccessibleStylesheets: string[];
    renderedFontIdentityDisclosure: string;
  };
}

function cleanPrimaryFontFamily(fontFamilyStack: string): string {
  const first = fontFamilyStack.split(',')[0] ?? fontFamilyStack;
  return first.trim().replace(/^['"]|['"]$/g, '');
}

function extractUrlsFromCssSrc(srcValue: string, baseHref: string): string[] {
  const urls: string[] = [];
  const regex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let match = regex.exec(srcValue);
  while (match) {
    const raw = match[2]?.trim() ?? '';
    if (raw && !raw.startsWith('data:')) {
      try {
        urls.push(new URL(raw, baseHref).toString());
      } catch {
        urls.push(raw);
      }
    }
    match = regex.exec(srcValue);
  }
  return urls;
}

export function extractPageFonts(doc: Document, win: Window): FontExtractionReport {
  const { entries } = collectDocumentElements(doc, 1500);
  const frameAndSheetReport = inspectFramesAndStylesheets(doc);

  const familyMap = new Map<
    string,
    {
      primaryFamily: string;
      totalUsageCount: number;
      combos: Map<
        string,
        {
          fontSize: string;
          fontWeight: string;
          lineHeight: string;
          letterSpacing: string;
          usageCount: number;
          sampleTags: Set<string>;
          sampleText: string;
        }
      >;
    }
  >();

  for (const { element } of entries) {
    const tag = element.tagName.toLowerCase();
    if (
      tag === 'html' ||
      tag === 'head' ||
      tag === 'style' ||
      tag === 'script' ||
      tag === 'title' ||
      tag === 'meta' ||
      tag === 'link'
    ) {
      continue;
    }
    const style = win.getComputedStyle(element);
    const stack = (style.getPropertyValue('font-family') || style.fontFamily || '').trim();
    if (!stack) {
      continue;
    }

    const primary = cleanPrimaryFontFamily(stack);
    const fontSize = style.getPropertyValue('font-size') || style.fontSize;
    const fontWeight = style.getPropertyValue('font-weight') || style.fontWeight;
    const lineHeight = style.getPropertyValue('line-height') || style.lineHeight;
    const letterSpacing = style.getPropertyValue('letter-spacing') || style.letterSpacing;
    const comboKey = `${fontSize}|${fontWeight}|${lineHeight}|${letterSpacing}`;
    const directText = element.textContent.trim().slice(0, 80);

    let famEntry = familyMap.get(stack);
    if (!famEntry) {
      famEntry = {
        primaryFamily: primary,
        totalUsageCount: 0,
        combos: new Map(),
      };
      familyMap.set(stack, famEntry);
    }
    famEntry.totalUsageCount += 1;

    const existingCombo = famEntry.combos.get(comboKey);
    if (existingCombo) {
      existingCombo.usageCount += 1;
      if (existingCombo.sampleTags.size < 5) {
        existingCombo.sampleTags.add(tag);
      }
      if (!existingCombo.sampleText && directText.length > 0) {
        existingCombo.sampleText = directText;
      }
    } else {
      famEntry.combos.set(comboKey, {
        fontSize,
        fontWeight,
        lineHeight,
        letterSpacing,
        usageCount: 1,
        sampleTags: new Set([tag]),
        sampleText: directText,
      });
    }
  }

  const fontFaceDeclarations: FontFaceDeclarationEntry[] = [];
  const baseHref = doc.location.href || 'https://localhost/';

  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (rule.cssText.trim().toLowerCase().startsWith('@font-face') && 'style' in rule) {
        const fontRule = rule as CSSFontFaceRule;
        const family = fontRule.style
          .getPropertyValue('font-family')
          .trim()
          .replace(/^['"]|['"]$/g, '');
        const src = fontRule.style.getPropertyValue('src');
        const weight = fontRule.style.getPropertyValue('font-weight') || 'normal';
        const fontStyle = fontRule.style.getPropertyValue('font-style') || 'normal';
        const fontDisplay = fontRule.style.getPropertyValue('font-display') || 'auto';
        if (family) {
          fontFaceDeclarations.push({
            fontFamily: family,
            fontWeight: weight.trim(),
            fontStyle: fontStyle.trim(),
            fontDisplay: fontDisplay.trim(),
            urls: extractUrlsFromCssSrc(src, sheet.href ?? baseHref),
          });
        }
      }
    }
  }

  const fontsCandidate = (doc as unknown as { fonts?: { check?: (font: string) => boolean } })
    .fonts;
  const checkFn = fontsCandidate?.check;

  const families: FontFamilyReportEntry[] = Array.from(familyMap.entries())
    .sort((a, b) => b[1].totalUsageCount - a[1].totalUsageCount)
    .map(([declaredStack, info]) => {
      let verifiedLoaded: boolean | 'unsupported' = 'unsupported';
      if (typeof checkFn === 'function') {
        try {
          verifiedLoaded = checkFn.call(fontsCandidate, `16px "${info.primaryFamily}"`);
        } catch {
          verifiedLoaded = 'unsupported';
        }
      }

      const combinations: FontStyleCombination[] = Array.from(info.combos.values())
        .sort((a, b) => b.usageCount - a.usageCount)
        .map((c) => ({
          fontSize: c.fontSize,
          fontWeight: c.fontWeight,
          lineHeight: c.lineHeight,
          letterSpacing: c.letterSpacing,
          usageCount: c.usageCount,
          sampleTags: Array.from(c.sampleTags),
          sampleText: c.sampleText,
        }));

      return {
        declaredStack,
        primaryFamily: info.primaryFamily,
        totalUsageCount: info.totalUsageCount,
        verifiedLoadedInFontFaceSet: verifiedLoaded,
        combinations,
      };
    });

  return {
    families,
    fontFaceDeclarations,
    diagnostics: {
      scannedElementsCount: entries.length,
      inaccessibleStylesheets: frameAndSheetReport.inaccessibleStylesheets,
      renderedFontIdentityDisclosure:
        'getComputedStyle().fontFamily reports the authored CSS font stack. Verified webfont loading is checked via document.fonts.check() where supported; OS-level fallback glyph substitution is not exposed to DOM scripts.',
    },
  };
}
