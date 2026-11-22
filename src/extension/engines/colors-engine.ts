import {
  buildShortSelector,
  collectDocumentElements,
  inspectFramesAndStylesheets,
} from './dom-utils.js';

export interface NormalizedColorToken {
  id: string;
  hex: string;
  rgbString: string;
  hslString: string;
  rgba: { r: number; g: number; b: number; a: number };
  hasTransparency: boolean;
  usageCount: number;
  properties: string[];
  sampleSelectors: string[];
}

export interface GradientEntry {
  value: string;
  usageCount: number;
  sampleSelectors: string[];
}

export interface CssCustomPropertyColor {
  name: string;
  rawValue: string;
  normalizedHex: string | null;
}

export interface ColorExtractionReport {
  colors: NormalizedColorToken[];
  gradients: GradientEntry[];
  customProperties: CssCustomPropertyColor[];
  exports: {
    cssVariables: string;
    json: string;
    scss: string;
    tailwindV3Config: string;
    tailwindV4Theme: string;
  };
  diagnostics: {
    scannedElementsCount: number;
    inaccessibleStylesheets: string[];
  };
}

function clampChannel(val: number): number {
  return Math.max(0, Math.min(255, Math.round(val)));
}

function toTwoHex(val: number): string {
  return clampChannel(val).toString(16).padStart(2, '0');
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      case bn:
        h = (rn - gn) / d + 4;
        break;
    }
    h /= 6;
  }

  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

export function parseCssColorToRgba(
  raw: string,
): { r: number; g: number; b: number; a: number } | null {
  const trimmed = raw.trim().toLowerCase();
  if (
    !trimmed ||
    trimmed === 'transparent' ||
    trimmed === 'none' ||
    trimmed === 'inherit' ||
    trimmed === 'initial' ||
    trimmed === 'currentcolor'
  ) {
    return null;
  }

  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length === 3) {
      const r = Number.parseInt((hex[0] ?? '0') + (hex[0] ?? '0'), 16);
      const g = Number.parseInt((hex[1] ?? '0') + (hex[1] ?? '0'), 16);
      const b = Number.parseInt((hex[2] ?? '0') + (hex[2] ?? '0'), 16);
      return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : { r, g, b, a: 1 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      const a =
        hex.length === 8 ? Number((Number.parseInt(hex.slice(6, 8), 16) / 255).toFixed(3)) : 1;
      return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) || Number.isNaN(a)
        ? null
        : { r, g, b, a };
    }
    return null;
  }

  const rgbMatch =
    /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)(?:\s*[,/]\s*([\d.%]+))?\s*\)$/.exec(
      trimmed,
    );
  if (rgbMatch) {
    const r = clampChannel(Number.parseFloat(rgbMatch[1] ?? '0'));
    const g = clampChannel(Number.parseFloat(rgbMatch[2] ?? '0'));
    const b = clampChannel(Number.parseFloat(rgbMatch[3] ?? '0'));
    let a = 1;
    if (rgbMatch[4] !== undefined) {
      const alphaRaw = rgbMatch[4];
      a = alphaRaw.endsWith('%') ? Number.parseFloat(alphaRaw) / 100 : Number.parseFloat(alphaRaw);
      a = Number(Math.max(0, Math.min(1, a)).toFixed(3));
    }
    if (a === 0) {
      return null;
    }
    return { r, g, b, a };
  }

  const hslMatch =
    /^hsla?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%(?:\s*[,/]\s*([\d.%]+))?\s*\)$/.exec(
      trimmed,
    );
  if (hslMatch) {
    const h = ((Number.parseFloat(hslMatch[1] ?? '0') % 360) + 360) % 360;
    const s = Math.max(0, Math.min(100, Number.parseFloat(hslMatch[2] ?? '0'))) / 100;
    const l = Math.max(0, Math.min(100, Number.parseFloat(hslMatch[3] ?? '0'))) / 100;
    let a = 1;
    if (hslMatch[4] !== undefined) {
      const alphaRaw = hslMatch[4];
      a = alphaRaw.endsWith('%') ? Number.parseFloat(alphaRaw) / 100 : Number.parseFloat(alphaRaw);
      a = Number(Math.max(0, Math.min(1, a)).toFixed(3));
    }
    if (a === 0) {
      return null;
    }
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r1 = 0;
    let g1 = 0;
    let b1 = 0;
    if (h < 60) {
      r1 = c;
      g1 = x;
    } else if (h < 120) {
      r1 = x;
      g1 = c;
    } else if (h < 180) {
      g1 = c;
      b1 = x;
    } else if (h < 240) {
      g1 = x;
      b1 = c;
    } else if (h < 300) {
      r1 = x;
      b1 = c;
    } else {
      r1 = c;
      b1 = x;
    }
    return {
      r: clampChannel((r1 + m) * 255),
      g: clampChannel((g1 + m) * 255),
      b: clampChannel((b1 + m) * 255),
      a,
    };
  }

  return null;
}

export function formatRgbaToHex(rgba: { r: number; g: number; b: number; a: number }): string {
  const base = `#${toTwoHex(rgba.r)}${toTwoHex(rgba.g)}${toTwoHex(rgba.b)}`;
  if (rgba.a < 1) {
    return `${base}${toTwoHex(Math.round(rgba.a * 255))}`;
  }
  return base;
}

export function extractPageColors(doc: Document, win: Window): ColorExtractionReport {
  const { entries, openShadowRootsCount } = collectDocumentElements(doc, 1500);
  const frameAndSheetReport = inspectFramesAndStylesheets(doc, openShadowRootsCount);

  const colorMap = new Map<
    string,
    {
      rgba: { r: number; g: number; b: number; a: number };
      usageCount: number;
      properties: Set<string>;
      sampleSelectors: Set<string>;
    }
  >();

  const gradientMap = new Map<string, { usageCount: number; sampleSelectors: Set<string> }>();
  const colorProperties = [
    'color',
    'background-color',
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
    'outline-color',
  ];

  for (const { element } of entries) {
    const style = win.getComputedStyle(element);
    const selector = buildShortSelector(element);

    for (const prop of colorProperties) {
      const val = style.getPropertyValue(prop);
      const parsed = parseCssColorToRgba(val);
      if (parsed) {
        const hex = formatRgbaToHex(parsed);
        const existing = colorMap.get(hex);
        const normalizedProp = prop.startsWith('border-') ? 'border-color' : prop;
        if (existing) {
          existing.usageCount += 1;
          existing.properties.add(normalizedProp);
          if (existing.sampleSelectors.size < 5) {
            existing.sampleSelectors.add(selector);
          }
        } else {
          colorMap.set(hex, {
            rgba: parsed,
            usageCount: 1,
            properties: new Set([normalizedProp]),
            sampleSelectors: new Set([selector]),
          });
        }
      }
    }

    const bgImage = style.getPropertyValue('background-image');
    if (bgImage && bgImage !== 'none' && bgImage.includes('gradient(')) {
      const existingGrad = gradientMap.get(bgImage);
      if (existingGrad) {
        existingGrad.usageCount += 1;
        if (existingGrad.sampleSelectors.size < 5) {
          existingGrad.sampleSelectors.add(selector);
        }
      } else {
        gradientMap.set(bgImage, {
          usageCount: 1,
          sampleSelectors: new Set([selector]),
        });
      }
    }
  }

  const customPropertiesMap = new Map<string, CssCustomPropertyColor>();
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if ('style' in rule && rule.style instanceof Object) {
        const styleDecl = (rule as CSSStyleRule).style;
        for (let i = 0; i < styleDecl.length; i += 1) {
          const propName = styleDecl.item(i);
          if (propName.startsWith('--')) {
            const rawVal = styleDecl.getPropertyValue(propName).trim();
            const parsed = parseCssColorToRgba(rawVal);
            if (parsed || rawVal.includes('gradient(')) {
              customPropertiesMap.set(propName, {
                name: propName,
                rawValue: rawVal,
                normalizedHex: parsed ? formatRgbaToHex(parsed) : null,
              });
            }
          }
        }
      }
    }
  }

  const sortedColors: NormalizedColorToken[] = Array.from(colorMap.entries())
    .sort((a, b) => b[1].usageCount - a[1].usageCount)
    .map(([hex, entry], idx) => {
      const { r, g, b, a } = entry.rgba;
      const hsl = rgbToHsl(r, g, b);
      const rgbString = a < 1 ? `rgba(${r}, ${g}, ${b}, ${a})` : `rgb(${r}, ${g}, ${b})`;
      const hslString =
        a < 1
          ? `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, ${a})`
          : `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`;
      return {
        id: `color-${idx + 1}`,
        hex,
        rgbString,
        hslString,
        rgba: entry.rgba,
        hasTransparency: a < 1,
        usageCount: entry.usageCount,
        properties: Array.from(entry.properties),
        sampleSelectors: Array.from(entry.sampleSelectors),
      };
    });

  const gradients: GradientEntry[] = Array.from(gradientMap.entries())
    .sort((a, b) => b[1].usageCount - a[1].usageCount)
    .map(([value, info]) => ({
      value,
      usageCount: info.usageCount,
      sampleSelectors: Array.from(info.sampleSelectors),
    }));

  const customProperties = Array.from(customPropertiesMap.values());

  const cssVarsLines = sortedColors.map((c) => `  --pagesift-${c.id}: ${c.hex};`);
  const cssVariables = `:root {\n${cssVarsLines.join('\n')}\n}`;

  const scssLines = sortedColors.map((c) => `$pagesift-${c.id}: ${c.hex};`);
  const scss = scssLines.join('\n');

  const tailwindColorsRecord: Record<string, string> = {};
  for (const c of sortedColors) {
    tailwindColorsRecord[`pagesift-${c.id}`] = c.hex;
  }
  const tailwindV3Config = JSON.stringify(
    {
      theme: {
        extend: {
          colors: tailwindColorsRecord,
        },
      },
    },
    null,
    2,
  );

  const tailwindV4Lines = sortedColors.map((c) => `  --color-pagesift-${c.id}: ${c.hex};`);
  const tailwindV4Theme = `@theme {\n${tailwindV4Lines.join('\n')}\n}`;

  const json = JSON.stringify(
    {
      colors: sortedColors,
      gradients,
      customProperties,
    },
    null,
    2,
  );

  return {
    colors: sortedColors,
    gradients,
    customProperties,
    exports: {
      cssVariables,
      json,
      scss,
      tailwindV3Config,
      tailwindV4Theme,
    },
    diagnostics: {
      scannedElementsCount: entries.length,
      inaccessibleStylesheets: frameAndSheetReport.inaccessibleStylesheets,
    },
  };
}
