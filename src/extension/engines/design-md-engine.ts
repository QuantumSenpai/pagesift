import { extractPageAssets, type AssetKind } from './assets-engine.js';
import {
  extractPageColors,
  formatRgbaToHex,
  parseCssColorToRgba,
  type ColorExtractionReport,
} from './colors-engine.js';
import {
  buildShortSelector,
  collectDocumentElements,
  isPageSiftElement,
  parsePixelValue,
} from './dom-utils.js';
import { extractPageFonts, type FontExtractionReport } from './fonts-engine.js';
import {
  extractStyleAdaptationReport,
  type StyleAdaptationReport,
} from './style-adaptation-engine.js';
import { detectPageTechStack } from './tech-stack-engine.js';
import { summarizeMotionSpecCounts, type MotionSpec } from './motion-spec.js';

export interface DesignSiteOverview {
  metaDescription?: string;
  language?: string;
  viewportWidth: number;
  viewportHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  rootFontSizePx: string;
  bodyFontSizePx: string;
  themeMode: 'light' | 'dark';
  canvasBackgroundHex: string;
  surfaceBackgroundHex?: string;
  primaryTextHex: string;
  mutedTextHex?: string;
  primaryAccentHex?: string;
  primaryBorderHex?: string;
  techStackOneLiner: string;
  detectedTechnologies: Array<{ technology: string; category: string }>;
  backgroundImages: string[];
}

export interface DesignCssVariableEntry {
  name: string;
  value: string;
  normalizedHex: string | null;
}

export interface DesignTypographyRoleEntry {
  role: string;
  selector: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
  textTransform: string;
  colorHex: string;
  sampleText: string;
}

export interface DesignNavItemSpec {
  label: string;
  tag: string;
  hrefPath: string;
  isDropdownTrigger: boolean;
}

export interface DesignGlobalChromeSpec {
  header: {
    selector: string;
    position: string;
    heightPx: number;
    widthPx: number;
    backgroundColor: string;
    borderBottom: string;
    backdropFilter: string;
    zIndex: string;
    navItems: DesignNavItemSpec[];
  } | null;
  footer: {
    selector: string;
    heightPx: number;
    backgroundColor: string;
    textColor: string;
    linkCount: number;
    linksSample: string[];
    copyrightText: string;
  } | null;
  floatingChrome: Array<{
    selector: string;
    position: string;
    dimensions: string;
    label: string;
  }>;
}

export interface DesignPageSectionSpec {
  index: number;
  selector: string;
  tag: string;
  widthPx: number;
  heightPx: number;
  position: string;
  display: string;
  gridColumns?: string;
  flexDirection?: string;
  gap?: string;
  padding: string;
  backgroundColor: string;
  backgroundImage?: string;
  textColor: string;
  headingTag?: string;
  headingText?: string;
  subHeadings: string[];
  leadParagraphs: string[];
  ctaLabels: string[];
  counts: {
    imgs: number;
    svgs: number;
    videos: number;
    canvases: number;
    forms: number;
  };
}

export interface DesignButtonSpec {
  variant: string;
  selector: string;
  sampleLabels: string[];
  background: string;
  color: string;
  border: string;
  borderRadius: string;
  padding: string;
  fontSize: string;
  fontWeight: string;
  boxShadow: string;
  transition: string;
}

export interface DesignInputSpec {
  selector: string;
  type: string;
  placeholder: string;
  background: string;
  color: string;
  border: string;
  borderRadius: string;
  padding: string;
  height: string;
  fontSize: string;
}

export interface DesignCardSpec {
  selector: string;
  display: string;
  background: string;
  border: string;
  borderRadius: string;
  padding: string;
  boxShadow: string;
  dimensions: string;
}

export interface DesignAssetsAndMotionSpec {
  totalDiscovered: number;
  byKind: Partial<Record<AssetKind, number>>;
  liveDomCounts: {
    imgs: number;
    inlineSvgs: number;
    videos: number;
    canvases: number;
    iframes: number;
  };
  notableMedia: Array<{ kind: string; descriptor: string; dimensions: string }>;
  transitions: string[];
  keyframes: string[];
  animationsInUse: string[];
  interactionClues: string[];
}

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
  borderSignatures?: string[];
  containerWidthsPx?: number[];
  mediaQueries?: string[];
  allCssVariables?: DesignCssVariableEntry[];
  siteOverview?: DesignSiteOverview;
  typographyScale?: DesignTypographyRoleEntry[];
  globalChrome?: DesignGlobalChromeSpec;
  pageSections?: DesignPageSectionSpec[];
  componentSpecs?: {
    buttons: DesignButtonSpec[];
    inputs: DesignInputSpec[];
    cards: DesignCardSpec[];
    navLinksSummary?: {
      background: string;
      color: string;
      fontSize: string;
      fontWeight: string;
      transition: string;
      count: number;
    };
  };
  assetsAndMotion?: DesignAssetsAndMotionSpec;
  styleAdaptation?: StyleAdaptationReport;
  motionSpec?: MotionSpec;
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

function sanitizeInlineText(raw: string | null | undefined, maxLen = 160): string {
  if (!raw) {
    return '';
  }
  return raw.replace(/\s+/g, ' ').replace(/\|/g, '/').trim().slice(0, maxLen);
}

function sanitizeHrefTarget(rawHref: string | null | undefined, baseOrigin: string): string {
  if (!rawHref) {
    return '';
  }
  const trimmed = rawHref.trim();
  if (!trimmed || trimmed.startsWith('javascript:')) {
    return '';
  }
  if (trimmed.startsWith('#')) {
    return trimmed.slice(0, 64);
  }
  try {
    const parsed = new URL(trimmed, baseOrigin || 'https://localhost/');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    if (parsed.origin === baseOrigin) {
      return `${parsed.pathname}${parsed.hash ? parsed.hash.slice(0, 32) : ''}` || '/';
    }
    return `${parsed.origin}${parsed.pathname}`.slice(0, 100);
  } catch {
    return trimmed.slice(0, 80);
  }
}

function normalizeColorHexOrRaw(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const rgba = parseCssColorToRgba(raw);
  return rgba ? formatRgbaToHex(rgba) : null;
}

function computeLuminanceFromHex(hex: string): number {
  const rgba = parseCssColorToRgba(hex);
  if (!rgba) {
    return 1;
  }
  const channels = [rgba.r / 255, rgba.g / 255, rgba.b / 255].map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * (channels[0] ?? 1) + 0.7152 * (channels[1] ?? 1) + 0.0722 * (channels[2] ?? 1);
}

function isOpaqueColorValue(raw: string | null | undefined): boolean {
  if (!raw) {
    return false;
  }
  const rgba = parseCssColorToRgba(raw);
  return Boolean(rgba && rgba.a >= 0.15);
}

function measureRect(el: Element): { width: number; height: number; top: number } {
  if (typeof el.getBoundingClientRect !== 'function') {
    return { width: 0, height: 0, top: 0 };
  }
  const rect = el.getBoundingClientRect();
  return {
    width: Math.round(rect.width || 0),
    height: Math.round(rect.height || 0),
    top: Math.round(rect.top || 0),
  };
}

function extractBackgroundUrls(rawBgImage: string, baseHref: string): string[] {
  if (!rawBgImage || rawBgImage === 'none') {
    return [];
  }
  const urls: string[] = [];
  const regex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let match = regex.exec(rawBgImage);
  while (match) {
    const raw = match[2]?.trim() ?? '';
    if (raw && !raw.startsWith('data:')) {
      const cleaned = sanitizeHrefTarget(raw, safeOrigin(baseHref));
      if (cleaned) {
        urls.push(cleaned);
      }
    }
    match = regex.exec(rawBgImage);
  }
  return urls;
}

function safeOrigin(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return 'https://localhost';
  }
}

function extractStylesheetMetadata(
  doc: Document,
  baseHref: string,
): {
  cssVariables: DesignCssVariableEntry[];
  mediaQueries: string[];
  keyframes: string[];
  bgImageUrls: string[];
} {
  const varMap = new Map<string, DesignCssVariableEntry>();
  const mediaSet = new Set<string>();
  const keyframeSet = new Set<string>();
  const bgUrlSet = new Set<string>();

  const visitRule = (rule: CSSRule): void => {
    const cssTextHead = rule.cssText.trim().slice(0, 32).toLowerCase();
    if ('conditionText' in rule && typeof (rule as CSSMediaRule).conditionText === 'string') {
      const cond = sanitizeInlineText((rule as CSSMediaRule).conditionText, 120);
      if (cond) {
        mediaSet.add(`@media ${cond}`);
      }
    }
    if (cssTextHead.startsWith('@keyframes') && 'name' in rule) {
      const kfName = sanitizeInlineText((rule as CSSKeyframesRule).name, 80);
      if (kfName) {
        keyframeSet.add(kfName);
      }
    }
    if ('style' in rule && rule.style instanceof Object) {
      const styleDecl = (rule as CSSStyleRule).style;
      for (let i = 0; i < styleDecl.length; i += 1) {
        const propName = styleDecl.item(i);
        if (propName.startsWith('--') && !/[<>|]/.test(propName) && varMap.size < 90) {
          const rawVal = sanitizeInlineText(styleDecl.getPropertyValue(propName), 160);
          if (rawVal) {
            varMap.set(propName, {
              name: propName,
              value: rawVal,
              normalizedHex: normalizeColorHexOrRaw(rawVal),
            });
            for (const u of extractBackgroundUrls(rawVal, baseHref)) {
              if (bgUrlSet.size < 12) {
                bgUrlSet.add(u);
              }
            }
          }
        }
      }
      const bgImg = styleDecl.getPropertyValue('background-image');
      for (const u of extractBackgroundUrls(bgImg, baseHref)) {
        if (bgUrlSet.size < 12) {
          bgUrlSet.add(u);
        }
      }
    }
    if ('cssRules' in rule) {
      try {
        const nested = (rule as CSSGroupingRule).cssRules;
        for (const child of Array.from(nested)) {
          visitRule(child);
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
    cssVariables: Array.from(varMap.values()),
    mediaQueries: Array.from(mediaSet),
    keyframes: Array.from(keyframeSet),
    bgImageUrls: Array.from(bgUrlSet),
  };
}

function isLikelyHidden(style: CSSStyleDeclaration): boolean {
  return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
}

function isInteractiveStyledElement(el: Element, style: CSSStyleDeclaration): boolean {
  const tag = el.tagName.toLowerCase();
  const role = (el.getAttribute('role') ?? '').toLowerCase();
  if (tag === 'button' || role === 'button') {
    return true;
  }
  if (tag === 'a') {
    const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
    const hasBg = isOpaqueColorValue(style.backgroundColor);
    const hasBorder = parsePixelValue(style.borderTopWidth) > 0;
    return (
      hasBg || hasBorder || cls.includes('btn') || cls.includes('cta') || cls.includes('button')
    );
  }
  return false;
}

function resolveCanvasBackgroundHex(
  doc: Document,
  win: Window,
  colorsReport: ColorExtractionReport,
  cssVars: DesignCssVariableEntry[],
): { canvasHex: string; surfaceHex?: string } {
  const candidates: Element[] = [];
  const bodyEl = doc.body as HTMLElement | null;
  const rootEl = doc.documentElement as HTMLElement | null;
  if (bodyEl) {
    candidates.push(bodyEl);
  }
  if (rootEl) {
    candidates.push(rootEl);
  }
  const mainEl = doc.querySelector('main, .main-wrap, .main-inner, #__next, #root, #app');
  if (mainEl && !isPageSiftElement(mainEl)) {
    candidates.push(mainEl);
  }

  let canvasHex: string | null = null;
  for (const el of candidates) {
    const bg = win.getComputedStyle(el).backgroundColor;
    const hex = normalizeColorHexOrRaw(bg);
    if (hex && isOpaqueColorValue(bg)) {
      canvasHex = hex;
      break;
    }
  }

  const nonHairlineBgColors = colorsReport.colors.filter((c) => {
    if (!c.properties.includes('background-color')) {
      return false;
    }
    return !c.sampleSelectors.every(
      (s) => s.includes('.line') || s.includes('divider') || s.includes('border'),
    );
  });
  const bgPool =
    nonHairlineBgColors.length > 0
      ? nonHairlineBgColors
      : colorsReport.colors.filter((c) => c.properties.includes('background-color'));

  if (!canvasHex) {
    const varCanvas = cssVars.find(
      (v) =>
        v.normalizedHex &&
        (v.name.includes('canvas') || v.name.includes('surface-bg') || v.name === '--bg'),
    );
    if (varCanvas?.normalizedHex) {
      canvasHex = varCanvas.normalizedHex;
    } else if (
      bgPool[0] &&
      bgPool[0].usageCount >= 2 &&
      computeLuminanceFromHex(bgPool[0].hex) > 0.75
    ) {
      canvasHex = bgPool[0].hex;
    }
  }
  const resolvedCanvas = canvasHex ?? '#ffffff';
  const surfaceCandidate = bgPool.find((c) => c.hex !== resolvedCanvas)?.hex;
  return {
    canvasHex: resolvedCanvas,
    ...(surfaceCandidate ? { surfaceHex: surfaceCandidate } : {}),
  };
}

function pickPrimaryAccentHex(
  colorsReport: ColorExtractionReport,
  cssVars: DesignCssVariableEntry[],
  canvasHex: string,
  textHex: string,
): string | undefined {
  const brandVar = cssVars.find(
    (v) =>
      v.normalizedHex &&
      (v.name.includes('brand') || v.name.includes('accent') || v.name.includes('primary-cta')),
  );
  if (brandVar?.normalizedHex) {
    return brandVar.normalizedHex;
  }
  for (const c of colorsReport.colors) {
    if (c.hex === canvasHex || c.hex === textHex) {
      continue;
    }
    const maxC = Math.max(c.rgba.r, c.rgba.g, c.rgba.b);
    const minC = Math.min(c.rgba.r, c.rgba.g, c.rgba.b);
    const saturationDelta = maxC - minC;
    if (saturationDelta >= 35 && c.hex !== '#0000ee') {
      return c.hex;
    }
  }
  return undefined;
}

function extractTypographyRoles(
  doc: Document,
  win: Window,
  entries: Array<{ element: Element }>,
): DesignTypographyRoleEntry[] {
  const roles: DesignTypographyRoleEntry[] = [];
  const seenKeys = new Set<string>();

  const recordRole = (
    role: string,
    el: Element | null,
    fallbackSample: string,
    useFallbackOnly = false,
  ): void => {
    if (!el || isPageSiftElement(el)) {
      return;
    }
    const style = win.getComputedStyle(el);
    if (style.display === 'none') {
      return;
    }
    const sig = `${role}|${style.fontSize}|${style.fontWeight}|${style.fontFamily}`;
    if (seenKeys.has(sig)) {
      return;
    }
    seenKeys.add(sig);
    roles.push({
      role,
      selector: buildShortSelector(el),
      fontFamily: sanitizeInlineText(style.fontFamily, 90),
      fontSize: style.fontSize || '16px',
      fontWeight: style.fontWeight || '400',
      lineHeight: style.lineHeight || 'normal',
      letterSpacing: style.letterSpacing || 'normal',
      textTransform: style.textTransform || 'none',
      colorHex: normalizeColorHexOrRaw(style.color) ?? '#000000',
      sampleText: useFallbackOnly
        ? fallbackSample
        : sanitizeInlineText(el.textContent || fallbackSample, 70) || fallbackSample,
    });
  };

  const rootEl = doc.documentElement as HTMLElement | null;
  const bodyEl = doc.body as HTMLElement | null;
  if (rootEl) {
    recordRole('Root (html)', rootEl, 'Root typography baseline', true);
  }
  if (bodyEl) {
    recordRole('Body (body)', bodyEl, 'Default body copy', true);
  }

  const pickFirstMatching = (predicate: (el: Element) => boolean): Element | null => {
    for (const { element } of entries) {
      if (predicate(element)) {
        return element;
      }
    }
    return null;
  };

  recordRole(
    'Display H1',
    pickFirstMatching((e) => e.tagName.toLowerCase() === 'h1'),
    'Main Hero Heading',
  );
  recordRole(
    'Heading H2',
    pickFirstMatching((e) => e.tagName.toLowerCase() === 'h2'),
    'Section Heading',
  );
  recordRole(
    'Heading H3',
    pickFirstMatching((e) => e.tagName.toLowerCase() === 'h3'),
    'Subsection Heading',
  );
  recordRole(
    'Heading H4',
    pickFirstMatching((e) => e.tagName.toLowerCase() === 'h4'),
    'Card Heading',
  );
  recordRole(
    'Body Paragraph (p)',
    pickFirstMatching(
      (e) => e.tagName.toLowerCase() === 'p' && sanitizeInlineText(e.textContent, 20).length > 10,
    ),
    'Paragraph copy',
  );
  recordRole(
    'Nav Link',
    pickFirstMatching((e) => {
      const t = e.tagName.toLowerCase();
      return (
        (t === 'a' || t === 'button') &&
        Boolean(e.closest('header, nav')) &&
        sanitizeInlineText(e.textContent, 30).length > 0
      );
    }),
    'Navigation Item',
  );
  recordRole(
    'Button / CTA',
    pickFirstMatching((e) => {
      const t = e.tagName.toLowerCase();
      return t === 'button' || e.getAttribute('role') === 'button';
    }),
    'Action Button',
  );
  recordRole(
    'Mono / Code',
    pickFirstMatching((e) => {
      const t = e.tagName.toLowerCase();
      return t === 'code' || t === 'pre' || t === 'kbd';
    }),
    'const token = value',
  );
  recordRole(
    'Footer / Caption',
    pickFirstMatching((e) => {
      const t = e.tagName.toLowerCase();
      return t === 'small' || t === 'figcaption' || Boolean(e.closest('footer'));
    }),
    'Footer / metadata copy',
  );

  return roles;
}

function extractGlobalChromeSpec(
  doc: Document,
  win: Window,
  entries: Array<{ element: Element }>,
  baseOrigin: string,
): DesignGlobalChromeSpec {
  const headerEl = Array.from(doc.querySelectorAll('header, nav')).find(
    (el) => !isPageSiftElement(el) && !el.closest('footer'),
  );
  let headerSpec: DesignGlobalChromeSpec['header'] = null;
  if (headerEl) {
    const cs = win.getComputedStyle(headerEl);
    const rect = measureRect(headerEl);
    const navSeen = new Set<string>();
    const navItems: DesignNavItemSpec[] = [];
    for (const item of Array.from(headerEl.querySelectorAll('a, button'))) {
      if (isPageSiftElement(item)) {
        continue;
      }
      const label = sanitizeInlineText(
        item.textContent || item.getAttribute('aria-label') || '',
        60,
      );
      if (!label) {
        continue;
      }
      const tag = item.tagName.toLowerCase();
      const hrefPath = tag === 'a' ? sanitizeHrefTarget(item.getAttribute('href'), baseOrigin) : '';
      const key = `${label}|${hrefPath}`;
      if (navSeen.has(key) || navItems.length >= 24) {
        continue;
      }
      navSeen.add(key);
      const isDropdownTrigger =
        item.getAttribute('aria-haspopup') === 'true' ||
        item.getAttribute('aria-expanded') !== null ||
        Boolean(item.closest('[class*="dropdown"]')) ||
        tag === 'button';
      navItems.push({ label, tag, hrefPath, isDropdownTrigger });
    }
    headerSpec = {
      selector: buildShortSelector(headerEl),
      position: cs.position || 'static',
      heightPx: rect.height,
      widthPx: rect.width,
      backgroundColor: normalizeColorHexOrRaw(cs.backgroundColor) ?? cs.backgroundColor,
      borderBottom: cs.borderBottom || 'none',
      backdropFilter: cs.getPropertyValue('backdrop-filter') || 'none',
      zIndex: cs.zIndex || 'auto',
      navItems,
    };
  }

  const footerEl = Array.from(doc.querySelectorAll('footer')).find((el) => !isPageSiftElement(el));
  let footerSpec: DesignGlobalChromeSpec['footer'] = null;
  if (footerEl) {
    const cs = win.getComputedStyle(footerEl);
    const rect = measureRect(footerEl);
    const linkLabels: string[] = [];
    const footerLinks = Array.from(footerEl.querySelectorAll('a, button')).filter(
      (a) => !isPageSiftElement(a),
    );
    for (const a of footerLinks) {
      const label = sanitizeInlineText(a.textContent || a.getAttribute('aria-label') || '', 48);
      if (label && !linkLabels.includes(label) && linkLabels.length < 18) {
        linkLabels.push(label);
      }
    }
    const textAll = sanitizeInlineText(footerEl.textContent, 300);
    const copyMatch = /(©|copyright)[^|\n]{0,120}/i.exec(textAll);
    footerSpec = {
      selector: buildShortSelector(footerEl),
      heightPx: rect.height,
      backgroundColor: normalizeColorHexOrRaw(cs.backgroundColor) ?? cs.backgroundColor,
      textColor: normalizeColorHexOrRaw(cs.color) ?? cs.color,
      linkCount: footerLinks.length,
      linksSample: linkLabels,
      copyrightText: copyMatch ? copyMatch[0].trim() : textAll.slice(0, 140),
    };
  }

  const floatingChrome: DesignGlobalChromeSpec['floatingChrome'] = [];
  const seenFloat = new Set<string>();
  for (const { element } of entries) {
    const tag = element.tagName.toLowerCase();
    if (
      tag === 'header' ||
      tag === 'nav' ||
      tag === 'footer' ||
      element.closest('header, nav, footer')
    ) {
      continue;
    }
    const cs = win.getComputedStyle(element);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') {
      continue;
    }
    const rect = measureRect(element);
    if (rect.width === 0 && rect.height === 0) {
      continue;
    }
    const selector = buildShortSelector(element);
    if (seenFloat.has(selector) || floatingChrome.length >= 8) {
      continue;
    }
    seenFloat.add(selector);
    floatingChrome.push({
      selector,
      position: cs.position,
      dimensions: `${rect.width}x${rect.height}px`,
      label:
        sanitizeInlineText(element.getAttribute('aria-label') || element.textContent, 60) ||
        selector,
    });
  }

  return {
    header: headerSpec,
    footer: footerSpec,
    floatingChrome,
  };
}

function extractSectionsBlueprint(
  doc: Document,
  win: Window,
  baseHref: string,
): DesignPageSectionSpec[] {
  const candidates: Element[] = [];
  const mainEl = doc.querySelector('main');
  if (mainEl && !isPageSiftElement(mainEl)) {
    for (const child of Array.from(mainEl.children)) {
      if (!isPageSiftElement(child)) {
        candidates.push(child);
      }
    }
  }
  for (const sec of Array.from(doc.querySelectorAll('section, article'))) {
    if (!isPageSiftElement(sec) && !candidates.includes(sec)) {
      candidates.push(sec);
    }
  }
  const footerEl = doc.querySelector('footer');
  if (footerEl && !isPageSiftElement(footerEl) && !candidates.includes(footerEl)) {
    candidates.push(footerEl);
  }

  const filtered = candidates.filter((el) => {
    const descendantSections = Array.from(el.querySelectorAll('section')).filter(
      (inner) => inner !== el && !isPageSiftElement(inner),
    );
    if (descendantSections.length >= 2) {
      return false;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') {
      return false;
    }
    return true;
  });

  const sections: DesignPageSectionSpec[] = [];
  const seenSelectors = new Set<string>();

  for (const el of filtered) {
    const cs = win.getComputedStyle(el);
    if (cs.display === 'none' || cs.display === 'contents') {
      continue;
    }
    if (cs.position === 'fixed' && !el.matches('section, footer')) {
      continue;
    }
    const rect = measureRect(el);
    const selector = buildShortSelector(el);
    const uniqueKey = `${selector}|${rect.top}|${rect.height}`;
    if (seenSelectors.has(uniqueKey) || sections.length >= 24) {
      continue;
    }
    seenSelectors.add(uniqueKey);

    const hPrimary = el.querySelector('h1, h2, h3');
    const headingText = hPrimary ? sanitizeInlineText(hPrimary.textContent, 140) : '';
    const subHeadings: string[] = [];
    for (const h of Array.from(el.querySelectorAll('h2, h3, h4'))) {
      if (h === hPrimary || isPageSiftElement(h)) {
        continue;
      }
      const txt = sanitizeInlineText(h.textContent, 90);
      if (txt && !subHeadings.includes(txt) && subHeadings.length < 8) {
        subHeadings.push(txt);
      }
    }

    const leadParagraphs: string[] = [];
    for (const p of Array.from(
      el.querySelectorAll(
        'p, [class*="desc"], [class*="subtitle"], [class*="copy"], [class*="body"]',
      ),
    )) {
      if (isPageSiftElement(p) || p.children.length > 4) {
        continue;
      }
      const txt = sanitizeInlineText(p.textContent, 180);
      if (
        txt.length >= 12 &&
        txt !== headingText &&
        !leadParagraphs.includes(txt) &&
        leadParagraphs.length < 3
      ) {
        leadParagraphs.push(txt);
      }
    }

    const ctaLabels: string[] = [];
    for (const btn of Array.from(el.querySelectorAll('button, a'))) {
      if (isPageSiftElement(btn)) {
        continue;
      }
      const txt = sanitizeInlineText(btn.textContent || btn.getAttribute('aria-label') || '', 50);
      if (txt && !ctaLabels.includes(txt) && ctaLabels.length < 8) {
        ctaLabels.push(txt);
      }
    }

    const bgUrls = extractBackgroundUrls(cs.backgroundImage, baseHref);
    const bgImageLabel =
      bgUrls.length > 0
        ? bgUrls[0]
        : cs.backgroundImage && cs.backgroundImage !== 'none'
          ? sanitizeInlineText(cs.backgroundImage, 100)
          : undefined;

    sections.push({
      index: sections.length + 1,
      selector,
      tag: el.tagName.toLowerCase(),
      widthPx: rect.width,
      heightPx: rect.height,
      position: cs.position || 'static',
      display: cs.display || 'block',
      ...(cs.display.includes('grid') && cs.gridTemplateColumns
        ? { gridColumns: cs.gridTemplateColumns }
        : {}),
      ...(cs.display.includes('flex') && cs.flexDirection
        ? { flexDirection: cs.flexDirection }
        : {}),
      ...(cs.gap && cs.gap !== 'normal' && cs.gap !== '0px' ? { gap: cs.gap } : {}),
      padding: cs.padding || '0px',
      backgroundColor: normalizeColorHexOrRaw(cs.backgroundColor) ?? 'transparent',
      ...(bgImageLabel ? { backgroundImage: bgImageLabel } : {}),
      textColor: normalizeColorHexOrRaw(cs.color) ?? cs.color,
      ...(hPrimary ? { headingTag: hPrimary.tagName.toLowerCase() } : {}),
      ...(headingText ? { headingText } : {}),
      subHeadings,
      leadParagraphs,
      ctaLabels,
      counts: {
        imgs: el.querySelectorAll('img').length,
        svgs: el.querySelectorAll('svg').length,
        videos: el.querySelectorAll('video').length,
        canvases: el.querySelectorAll('canvas').length,
        forms: el.querySelectorAll('form').length,
      },
    });
  }

  return sections;
}

export function extractPageDesignSnapshot(doc: Document, win: Window): PageDesignSnapshotInput {
  const pageUrl = doc.location.href || 'https://localhost/';
  const baseOrigin = safeOrigin(pageUrl);
  const colorsReport = extractPageColors(doc, win);
  const fontsReport = extractPageFonts(doc, win);
  const assetsReport = extractPageAssets(doc, win);
  const techReport = detectPageTechStack(doc, win);
  const { entries } = collectDocumentElements(doc, 1200);
  const stylesMeta = extractStylesheetMetadata(doc, pageUrl);

  const spacingSet = new Set<number>();
  const radiusSet = new Set<string>();
  const shadowSet = new Set<string>();
  const borderSigSet = new Set<string>();
  const containerWidthSet = new Set<number>();
  const layoutPatternSet = new Set<string>();
  const componentSet = new Set<string>();
  const transitionSet = new Set<string>();
  const animationSet = new Set<string>();

  const buttonVariantMap = new Map<string, DesignButtonSpec>();
  const inputSpecs: DesignInputSpec[] = [];
  const cardVariantMap = new Map<string, DesignCardSpec>();
  let navLinkStyleSummary:
    | {
        background: string;
        color: string;
        fontSize: string;
        fontWeight: string;
        transition: string;
        count: number;
      }
    | undefined;

  let imgDomCount = 0;
  let svgDomCount = 0;
  let videoDomCount = 0;
  let canvasDomCount = 0;
  let iframeDomCount = 0;

  for (const { element } of entries) {
    const tag = element.tagName.toLowerCase();
    if (tag === 'img') imgDomCount += 1;
    else if (tag === 'svg') svgDomCount += 1;
    else if (tag === 'video') videoDomCount += 1;
    else if (tag === 'canvas') canvasDomCount += 1;
    else if (tag === 'iframe') iframeDomCount += 1;

    const style = win.getComputedStyle(element);
    const selector = buildShortSelector(element);

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

    const borderTopWidth = parsePixelValue(style.borderTopWidth);
    const borderBottomWidth = parsePixelValue(style.borderBottomWidth);
    if (borderTopWidth > 0 && style.borderTopStyle !== 'none') {
      const borderColor = normalizeColorHexOrRaw(style.borderTopColor) ?? style.borderTopColor;
      if (borderSigSet.size < 16) {
        borderSigSet.add(`${style.borderTopWidth} ${style.borderTopStyle} ${borderColor}`);
      }
    } else if (borderBottomWidth > 0 && style.borderBottomStyle !== 'none') {
      const borderColor =
        normalizeColorHexOrRaw(style.borderBottomColor) ?? style.borderBottomColor;
      if (borderSigSet.size < 16) {
        borderSigSet.add(`${style.borderBottomWidth} ${style.borderBottomStyle} ${borderColor}`);
      }
    }

    const maxW = parsePixelValue(style.maxWidth);
    if (maxW >= 320 && maxW <= 1920) {
      containerWidthSet.add(Math.round(maxW));
    }

    const tr = sanitizeInlineText(style.transition, 80);
    if (tr && tr !== 'all 0s ease 0s' && tr !== 'all' && tr !== 'none' && transitionSet.size < 16) {
      transitionSet.add(tr);
    }
    const anim = sanitizeInlineText(style.animationName, 80);
    if (anim && anim !== 'none' && animationSet.size < 12) {
      animationSet.add(anim);
    }

    if (style.display === 'grid' || style.display === 'inline-grid') {
      layoutPatternSet.add(
        `CSS Grid on \`${selector}\` (columns: \`${style.gridTemplateColumns || 'auto'}\`, gap: \`${style.gap || '0px'}\`)`,
      );
    } else if (style.display === 'flex' || style.display === 'inline-flex') {
      layoutPatternSet.add(
        `Flexbox on \`${selector}\` (direction: \`${style.flexDirection || 'row'}\`, justify: \`${style.justifyContent || 'normal'}\`, align: \`${style.alignItems || 'normal'}\`)`,
      );
    }

    if (style.position === 'sticky' || style.position === 'fixed') {
      layoutPatternSet.add(
        `${style.position.toUpperCase()} positioned landmark on \`${selector}\``,
      );
    }

    if (tag === 'nav' || element.getAttribute('role') === 'navigation') {
      componentSet.add(`Navigation bar (\`${selector}\`)`);
    } else if (tag === 'header') {
      componentSet.add(`Page header (\`${selector}\`)`);
    } else if (tag === 'button' || element.getAttribute('role') === 'button') {
      componentSet.add(
        `Interactive button (\`${selector}\`, bg: \`${style.backgroundColor}\`, radius: \`${style.borderRadius || '0px'}\`)`,
      );
    } else if (tag === 'form') {
      componentSet.add(`Form container (\`${selector}\`)`);
    } else if (tag === 'table') {
      componentSet.add(`Data table (\`${selector}\`)`);
    } else if (tag === 'footer') {
      componentSet.add(`Page footer (\`${selector}\`)`);
    }

    if (!isLikelyHidden(style) && isInteractiveStyledElement(element, style)) {
      const bgHex = normalizeColorHexOrRaw(style.backgroundColor) ?? 'transparent';
      const fgHex = normalizeColorHexOrRaw(style.color) ?? style.color;
      const bWidth = parsePixelValue(style.borderTopWidth);
      const bHex = normalizeColorHexOrRaw(style.borderTopColor) ?? '';
      const borderLabel =
        bWidth > 0 ? `${style.borderTopWidth} ${style.borderTopStyle} ${bHex}` : 'none';
      const sig = `${bgHex}|${fgHex}|${style.borderRadius || '0px'}|${borderLabel}|${style.fontSize}`;
      const label = sanitizeInlineText(
        element.textContent || element.getAttribute('aria-label') || '',
        48,
      );
      const existing = buttonVariantMap.get(sig);
      if (existing) {
        if (label && !existing.sampleLabels.includes(label) && existing.sampleLabels.length < 4) {
          existing.sampleLabels.push(label);
        }
      } else if (buttonVariantMap.size < 8) {
        const variant =
          bgHex !== 'transparent'
            ? 'Filled Button / CTA'
            : borderLabel !== 'none'
              ? 'Outlined / Ghost CTA'
              : 'Text / Minimal Action';
        buttonVariantMap.set(sig, {
          variant,
          selector,
          sampleLabels: label ? [label] : [],
          background: bgHex,
          color: fgHex,
          border: borderLabel,
          borderRadius: style.borderRadius || '0px',
          padding: style.padding || '0px',
          fontSize: style.fontSize || '14px',
          fontWeight: style.fontWeight || '500',
          boxShadow: style.boxShadow && style.boxShadow !== 'none' ? style.boxShadow : 'none',
          transition: tr || 'none',
        });
      }
    }

    if (tag === 'a' && element.closest('header, nav') && !isLikelyHidden(style)) {
      const fgHex = normalizeColorHexOrRaw(style.color) ?? style.color;
      if (!navLinkStyleSummary) {
        navLinkStyleSummary = {
          background: normalizeColorHexOrRaw(style.backgroundColor) ?? 'transparent',
          color: fgHex,
          fontSize: style.fontSize || '14px',
          fontWeight: style.fontWeight || '500',
          transition: tr || 'none',
          count: 1,
        };
      } else {
        navLinkStyleSummary.count += 1;
      }
    }

    if (
      (tag === 'input' && (element.getAttribute('type') ?? 'text').toLowerCase() !== 'hidden') ||
      tag === 'textarea' ||
      tag === 'select'
    ) {
      if (inputSpecs.length < 6) {
        const rect = measureRect(element);
        inputSpecs.push({
          selector,
          type: tag === 'input' ? (element.getAttribute('type') ?? 'text').toLowerCase() : tag,
          placeholder: sanitizeInlineText(element.getAttribute('placeholder'), 60) || '(none)',
          background: normalizeColorHexOrRaw(style.backgroundColor) ?? 'transparent',
          color: normalizeColorHexOrRaw(style.color) ?? style.color,
          border:
            parsePixelValue(style.borderTopWidth) > 0
              ? `${style.borderTopWidth} ${style.borderTopStyle} ${normalizeColorHexOrRaw(style.borderTopColor) ?? style.borderTopColor}`
              : 'none',
          borderRadius: style.borderRadius || '0px',
          padding: style.padding || '0px',
          height: rect.height > 0 ? `${rect.height}px` : style.height || 'auto',
          fontSize: style.fontSize || '14px',
        });
      }
    }

    const clsLower = (typeof element.className === 'string' ? element.className : '').toLowerCase();
    const isCardLike =
      tag === 'article' ||
      clsLower.includes('card') ||
      clsLower.includes('panel') ||
      clsLower.includes('tile') ||
      clsLower.includes('pricing');
    if (
      isCardLike &&
      (isOpaqueColorValue(style.backgroundColor) ||
        parsePixelValue(style.borderTopWidth) > 0 ||
        (style.boxShadow && style.boxShadow !== 'none'))
    ) {
      const bgHex = normalizeColorHexOrRaw(style.backgroundColor) ?? 'transparent';
      const bLabel =
        parsePixelValue(style.borderTopWidth) > 0
          ? `${style.borderTopWidth} ${style.borderTopStyle} ${normalizeColorHexOrRaw(style.borderTopColor) ?? style.borderTopColor}`
          : 'none';
      const sig = `${bgHex}|${bLabel}|${style.borderRadius}|${style.padding}`;
      if (!cardVariantMap.has(sig) && cardVariantMap.size < 6) {
        const rect = measureRect(element);
        cardVariantMap.set(sig, {
          selector,
          display: style.display || 'block',
          background: bgHex,
          border: bLabel,
          borderRadius: style.borderRadius || '0px',
          padding: style.padding || '0px',
          boxShadow: style.boxShadow && style.boxShadow !== 'none' ? style.boxShadow : 'none',
          dimensions: `${rect.width}x${rect.height}px`,
        });
      }
    }
  }

  const { canvasHex, surfaceHex } = resolveCanvasBackgroundHex(
    doc,
    win,
    colorsReport,
    stylesMeta.cssVariables,
  );
  const bodyEl = doc.body as HTMLElement | null;
  const rootEl = doc.documentElement as HTMLElement | null;
  const bodyCs = bodyEl ? win.getComputedStyle(bodyEl) : null;
  const htmlCs = rootEl ? win.getComputedStyle(rootEl) : null;
  const primaryTextHex =
    normalizeColorHexOrRaw(bodyCs?.color) ??
    colorsReport.colors.find((c) => c.properties.includes('color') && c.hex !== '#0000ee')?.hex ??
    '#111827';
  const mutedTextHex = colorsReport.colors.find(
    (c) =>
      c.properties.includes('color') &&
      c.hex !== primaryTextHex &&
      c.hex !== '#0000ee' &&
      c.hex !== canvasHex,
  )?.hex;
  const primaryAccentHex = pickPrimaryAccentHex(
    colorsReport,
    stylesMeta.cssVariables,
    canvasHex,
    primaryTextHex,
  );
  const borderSigHex = Array.from(borderSigSet)
    .map((sig) => normalizeColorHexOrRaw(sig.split(/\s+/).pop() ?? ''))
    .find((hex): hex is string => Boolean(hex));
  const borderVarHex = stylesMeta.cssVariables.find(
    (v) => v.normalizedHex && v.name.includes('border'),
  )?.normalizedHex;
  const primaryBorderHex =
    borderSigHex ??
    borderVarHex ??
    colorsReport.colors.find((c) => c.properties.includes('border-color'))?.hex;

  const metaDesc = sanitizeInlineText(
    doc
      .querySelector('meta[name="description"], meta[property="og:description"]')
      ?.getAttribute('content'),
    240,
  );
  const themeMode: 'light' | 'dark' = computeLuminanceFromHex(canvasHex) < 0.38 ? 'dark' : 'light';

  const byKind: Partial<Record<AssetKind, number>> = {};
  for (const asset of assetsReport.assets) {
    byKind[asset.kind] = (byKind[asset.kind] ?? 0) + 1;
  }
  const notableMedia = assetsReport.assets.slice(0, 12).map((a) => ({
    kind: a.kind,
    descriptor:
      a.altText || a.safeFilename || sanitizeHrefTarget(a.url, baseOrigin) || a.mimeTypeHint,
    dimensions: a.width && a.height ? `${a.width}x${a.height}px` : 'unspecified',
  }));

  const interactionClues: string[] = [];
  if (doc.querySelector('.lenis')) interactionClues.push('Lenis smooth scroll container (.lenis)');
  if (doc.querySelector('[data-w-id]'))
    interactionClues.push('Webflow IX interactive triggers ([data-w-id])');
  if (doc.querySelector('[data-framer-appear-id]'))
    interactionClues.push('Framer Motion scroll/appear animations');
  if (videoDomCount > 0)
    interactionClues.push(`${videoDomCount} embedded HTML5 <video> element(s)`);
  if (canvasDomCount > 0) interactionClues.push(`${canvasDomCount} WebGL / 2D <canvas> surface(s)`);

  const typographyScale = extractTypographyRoles(doc, win, entries);
  const globalChrome = extractGlobalChromeSpec(doc, win, entries, baseOrigin);
  const pageSections = extractSectionsBlueprint(doc, win, pageUrl);
  const buttons = Array.from(buttonVariantMap.values());
  const cards = Array.from(cardVariantMap.values());
  const h1Role = typographyScale.find((t) => t.role === 'Display H1');
  const primaryBtn = buttons.find((b) => b.background !== 'transparent') ?? buttons[0];
  const topFont = fontsReport.families[0];
  const breakpoints = stylesMeta.mediaQueries.slice(0, 20);

  const styleAdaptation = extractStyleAdaptationReport(
    doc,
    win,
    {
      canvasHex,
      ...(surfaceHex ? { surfaceHex } : {}),
      primaryTextHex,
      ...(mutedTextHex ? { mutedTextHex } : {}),
      ...(primaryAccentHex ? { accentHex: primaryAccentHex } : {}),
      ...(primaryBorderHex ? { borderHex: primaryBorderHex } : {}),
      rootFontSizePx: htmlCs?.fontSize || '16px',
      primaryFontStack: topFont?.declaredStack || bodyCs?.fontFamily || 'system-ui, sans-serif',
      primaryFontName: topFont?.primaryFamily || 'system-ui',
      ...(primaryBtn?.borderRadius ? { buttonRadius: primaryBtn.borderRadius } : {}),
      ...(cards[0]?.borderRadius ? { cardRadius: cards[0].borderRadius } : {}),
      ...(primaryBtn?.background ? { buttonBg: primaryBtn.background } : {}),
      ...(primaryBtn?.color ? { buttonText: primaryBtn.color } : {}),
      ...(primaryBtn?.padding ? { buttonPadding: primaryBtn.padding } : {}),
      ...(globalChrome.header?.heightPx ? { headerHeightPx: globalChrome.header.heightPx } : {}),
      ...(h1Role?.fontSize ? { h1FontSize: h1Role.fontSize } : {}),
      ...(h1Role?.colorHex ? { h1ColorHex: h1Role.colorHex } : {}),
      breakpoints,
    },
    colorsReport,
    fontsReport,
  );

  return {
    pageUrl,
    pageTitle: sanitizeInlineText(doc.title, 180) || 'Untitled Page',
    colorsReport,
    fontsReport,
    spacingTokensPx: Array.from(spacingSet).sort((a, b) => a - b),
    borderRadii: Array.from(radiusSet).sort(),
    boxShadows: Array.from(shadowSet).sort(),
    layoutPatterns: Array.from(layoutPatternSet).slice(0, 24),
    componentObservations: Array.from(componentSet).slice(0, 24),
    borderSignatures: Array.from(borderSigSet).slice(0, 16),
    containerWidthsPx: Array.from(containerWidthSet).sort((a, b) => a - b),
    mediaQueries: breakpoints,
    allCssVariables: stylesMeta.cssVariables,
    siteOverview: {
      ...(metaDesc ? { metaDescription: metaDesc } : {}),
      ...(rootEl?.lang ? { language: rootEl.lang } : {}),
      viewportWidth: win.innerWidth || 0,
      viewportHeight: win.innerHeight || 0,
      scrollWidth: rootEl?.scrollWidth ?? 0,
      scrollHeight: rootEl?.scrollHeight ?? 0,
      rootFontSizePx: htmlCs?.fontSize || '16px',
      bodyFontSizePx: bodyCs?.fontSize || '16px',
      themeMode,
      canvasBackgroundHex: canvasHex,
      ...(surfaceHex ? { surfaceBackgroundHex: surfaceHex } : {}),
      primaryTextHex,
      ...(mutedTextHex ? { mutedTextHex } : {}),
      ...(primaryAccentHex ? { primaryAccentHex } : {}),
      ...(primaryBorderHex ? { primaryBorderHex } : {}),
      techStackOneLiner: techReport.organizedSummary.oneLiner,
      detectedTechnologies: techReport.detections.map((d) => ({
        technology: d.technology,
        category: d.category,
      })),
      backgroundImages: stylesMeta.bgImageUrls,
    },
    typographyScale,
    globalChrome,
    pageSections,
    componentSpecs: {
      buttons,
      inputs: inputSpecs,
      cards,
      ...(navLinkStyleSummary ? { navLinksSummary: navLinkStyleSummary } : {}),
    },
    assetsAndMotion: {
      totalDiscovered: assetsReport.summary.totalDiscovered,
      byKind,
      liveDomCounts: {
        imgs: imgDomCount,
        inlineSvgs: svgDomCount,
        videos: videoDomCount,
        canvases: canvasDomCount,
        iframes: iframeDomCount,
      },
      notableMedia,
      transitions: Array.from(transitionSet),
      keyframes: stylesMeta.keyframes.slice(0, 20),
      animationsInUse: Array.from(animationSet),
      interactionClues,
    },
    styleAdaptation,
  };
}

function appendSemanticColorsSection(
  lines: string[],
  pages: PageDesignSnapshotInput[],
  deduplicatedColors: Array<{
    hex: string;
    rgbString: string;
    hslString: string;
    totalUsage: number;
    properties: Set<string>;
    selectors: Set<string>;
  }>,
  allCssVariables: DesignCssVariableEntry[],
): void {
  const primaryOverview = pages[0]?.siteOverview;
  if (primaryOverview) {
    lines.push('### Semantic Color Roles');
    lines.push('| Semantic Role | Value | Notes |');
    lines.push('| --- | --- | --- |');
    lines.push(
      `| Theme Polarity | \`${primaryOverview.themeMode}\` | Detected from computed canvas luminance |`,
    );
    lines.push(
      `| Canvas Background | \`${primaryOverview.canvasBackgroundHex}\` | Primary body/root backdrop |`,
    );
    if (primaryOverview.surfaceBackgroundHex) {
      lines.push(
        `| Secondary Surface | \`${primaryOverview.surfaceBackgroundHex}\` | Cards / elevated bands |`,
      );
    }
    lines.push(
      `| Primary Text Ink | \`${primaryOverview.primaryTextHex}\` | Computed body text foreground |`,
    );
    if (primaryOverview.mutedTextHex) {
      lines.push(
        `| Secondary / Muted Text | \`${primaryOverview.mutedTextHex}\` | Subtitles / secondary labels |`,
      );
    }
    if (primaryOverview.primaryAccentHex) {
      lines.push(
        `| Brand / Accent | \`${primaryOverview.primaryAccentHex}\` | Primary CTA / brand highlight |`,
      );
    }
    if (primaryOverview.primaryBorderHex) {
      lines.push(
        `| Border / Hairline | \`${primaryOverview.primaryBorderHex}\` | Strokes and section dividers |`,
      );
    }
    lines.push('');
  }

  lines.push('### Extracted Computed Color Palette');
  if (deduplicatedColors.length === 0) {
    lines.push('- No computed colors extracted.');
  } else {
    lines.push('| Hex | RGB / HSL | Usage | CSS Properties | Sample Selectors |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const c of deduplicatedColors.slice(0, 28)) {
      const props = Array.from(c.properties).sort().join(', ');
      const sels = Array.from(c.selectors).slice(0, 3).join(', ') || 'document';
      lines.push(
        `| \`${c.hex}\` | \`${c.rgbString}\` / \`${c.hslString}\` | ${c.totalUsage}x | \`${props}\` | \`${sels}\` |`,
      );
    }
  }
  lines.push('');

  if (allCssVariables.length > 0) {
    lines.push('### Stylesheet CSS Custom Properties (`--*`)');
    lines.push('| Variable Name | Declared Value | Normalized Color |');
    lines.push('| --- | --- | --- |');
    for (const v of allCssVariables.slice(0, 50)) {
      lines.push(
        `| \`${v.name}\` | \`${v.value}\` | ${v.normalizedHex ? `\`${v.normalizedHex}\`` : 'non-color'} |`,
      );
    }
    lines.push('');
  }

  const gradients = pages.flatMap((p) => p.colorsReport.gradients).slice(0, 8);
  const bgUrls = Array.from(
    new Set(pages.flatMap((p) => p.siteOverview?.backgroundImages ?? [])),
  ).slice(0, 8);
  if (gradients.length > 0 || bgUrls.length > 0) {
    lines.push('### Gradients & Background Textures');
    for (const g of gradients) {
      lines.push(
        `- Gradient (${g.usageCount}x on \`${g.sampleSelectors.slice(0, 2).join(', ')}\`): \`${sanitizeInlineText(g.value, 140)}\``,
      );
    }
    for (const u of bgUrls) {
      lines.push(`- Background image asset: \`${u}\``);
    }
    lines.push('');
  }
}

function appendTypographySection(
  lines: string[],
  pages: PageDesignSnapshotInput[],
  deduplicatedFonts: Array<{
    primaryFamily: string;
    declaredStack: string;
    totalUsage: number;
    sizes: Set<string>;
    weights: Set<string>;
    lineHeights: Set<string>;
    letterSpacings: Set<string>;
  }>,
): void {
  const scaleEntries = pages[0]?.typographyScale ?? [];
  if (scaleEntries.length > 0) {
    lines.push('### Computed Type Scale & Hierarchy');
    lines.push(
      '| Role | Selector | Font Family | Size | Weight | Line Height | Tracking | Transform | Color | Sample |',
    );
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const t of scaleEntries) {
      lines.push(
        `| ${t.role} | \`${t.selector}\` | \`${t.fontFamily}\` | \`${t.fontSize}\` | ${t.fontWeight} | \`${t.lineHeight}\` | \`${t.letterSpacing}\` | \`${t.textTransform}\` | \`${t.colorHex}\` | "${t.sampleText}" |`,
      );
    }
    lines.push('');
  }

  lines.push('### Font Families & Webfont Sources');
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
      const trackings = Array.from(f.letterSpacings).filter((x) => x && x !== 'normal');
      if (trackings.length > 0) {
        lines.push(`  - Letter Spacing: \`${trackings.sort().join(', ')}\``);
      }
    }
  }

  const fontFaces = pages.flatMap((p) => p.fontsReport.fontFaceDeclarations).slice(0, 12);
  if (fontFaces.length > 0) {
    lines.push('');
    lines.push('### Declared `@font-face` Rules');
    for (const ff of fontFaces) {
      const urls = ff.urls.slice(0, 2).join(', ') || 'local / inline';
      lines.push(
        `- \`${ff.fontFamily}\` (weight: \`${ff.fontWeight}\`, style: \`${ff.fontStyle}\`, display: \`${ff.fontDisplay}\`) -> \`${urls}\``,
      );
    }
  }
  lines.push('');
}

function appendLayoutArchitectureSection(lines: string[], pages: PageDesignSnapshotInput[]): void {
  const primary = pages[0];
  const chrome = primary?.globalChrome;
  if (chrome?.header) {
    const h = chrome.header;
    lines.push('### Global Header & Top Navigation');
    lines.push(
      `- **Container**: \`${h.selector}\` (\`position: ${h.position}\`, \`${h.widthPx}x${h.heightPx}px\`, bg: \`${h.backgroundColor}\`, border-bottom: \`${h.borderBottom}\`, backdrop-filter: \`${h.backdropFilter}\`, z-index: \`${h.zIndex}\`)`,
    );
    if (h.navItems.length > 0) {
      lines.push('- **Navigation Links & Triggers**:');
      for (const item of h.navItems) {
        const meta = [item.tag, item.isDropdownTrigger ? 'dropdown/menu' : 'link'];
        if (item.hrefPath) {
          meta.push(`target: \`${item.hrefPath}\``);
        }
        lines.push(`  - **${item.label}** (${meta.join(', ')})`);
      }
    }
    lines.push('');
  }

  if (chrome && chrome.floatingChrome.length > 0) {
    lines.push('### Floating / Fixed Page Chrome');
    for (const f of chrome.floatingChrome) {
      lines.push(`- \`${f.selector}\` (${f.position}, ${f.dimensions}) - "${f.label}"`);
    }
    lines.push('');
  }

  const sections = primary?.pageSections ?? [];
  if (sections.length > 0) {
    lines.push('### Section-by-Section DOM Blueprint (Top to Bottom)');
    for (const sec of sections) {
      const layoutParts = [sec.display];
      if (sec.gridColumns) layoutParts.push(`cols: \`${sec.gridColumns}\``);
      if (sec.flexDirection) layoutParts.push(`dir: \`${sec.flexDirection}\``);
      if (sec.gap) layoutParts.push(`gap: \`${sec.gap}\``);
      lines.push(
        `#### Section ${sec.index}: \`${sec.selector}\` (\`${sec.widthPx}x${sec.heightPx}px\`, ${layoutParts.join(', ')})`,
      );
      lines.push(
        `- **Surface & Spacing**: bg \`${sec.backgroundColor}\`, ink \`${sec.textColor}\`, padding \`${sec.padding}\`, position \`${sec.position}\`${sec.backgroundImage ? `, bg-image \`${sec.backgroundImage}\`` : ''}`,
      );
      if (sec.headingText) {
        lines.push(
          `- **Primary Heading (${(sec.headingTag ?? 'h2').toUpperCase()})**: "${sec.headingText}"`,
        );
      }
      if (sec.subHeadings.length > 0) {
        lines.push(`- **Subheadings**: ${sec.subHeadings.map((s) => `"${s}"`).join(' | ')}`);
      }
      for (const p of sec.leadParagraphs) {
        lines.push(`- **Copy Snippet**: "${p}"`);
      }
      if (sec.ctaLabels.length > 0) {
        lines.push(`- **Actions / CTAs**: ${sec.ctaLabels.map((c) => `\`${c}\``).join(', ')}`);
      }
      lines.push(
        `- **Embedded Media**: ${sec.counts.imgs} img, ${sec.counts.svgs} inline svg, ${sec.counts.videos} video, ${sec.counts.canvases} canvas, ${sec.counts.forms} form`,
      );
      lines.push('');
    }
  }

  if (chrome?.footer) {
    const f = chrome.footer;
    lines.push('### Global Footer');
    lines.push(
      `- **Container**: \`${f.selector}\` (${f.heightPx}px high, bg: \`${f.backgroundColor}\`, color: \`${f.textColor}\`, ${f.linkCount} link(s))`,
    );
    if (f.linksSample.length > 0) {
      lines.push(`- **Footer Links**: ${f.linksSample.join(', ')}`);
    }
    if (f.copyrightText) {
      lines.push(`- **Attribution / Copyright**: "${f.copyrightText}"`);
    }
    lines.push('');
  }
}

function appendComponentsMediaMotionSection(
  lines: string[],
  pages: PageDesignSnapshotInput[],
  componentSet: Set<string>,
): void {
  const primary = pages[0];
  const specs = primary?.componentSpecs;
  if (specs?.buttons && specs.buttons.length > 0) {
    lines.push('### Button & CTA Variants');
    lines.push(
      '| Variant | Sample Labels | Bg | Text | Border | Radius | Padding | Typography | Shadow | Transition |',
    );
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const b of specs.buttons) {
      const labels = b.sampleLabels.join(', ') || b.selector;
      lines.push(
        `| ${b.variant} | ${labels} | \`${b.background}\` | \`${b.color}\` | \`${b.border}\` | \`${b.borderRadius}\` | \`${b.padding}\` | \`${b.fontSize}\` / ${b.fontWeight} | \`${b.boxShadow}\` | \`${b.transition}\` |`,
      );
    }
    lines.push('');
  }

  if (specs?.navLinksSummary) {
    const nl = specs.navLinksSummary;
    lines.push('### Navigation Link Token');
    lines.push(
      `- ${nl.count} nav link(s): color \`${nl.color}\`, bg \`${nl.background}\`, size \`${nl.fontSize}\`, weight \`${nl.fontWeight}\`, transition \`${nl.transition}\``,
    );
    lines.push('');
  }

  if (specs?.inputs && specs.inputs.length > 0) {
    lines.push('### Form Controls & Inputs');
    for (const inp of specs.inputs) {
      lines.push(
        `- \`${inp.selector}\` (type: \`${inp.type}\`, placeholder: "${inp.placeholder}") - height \`${inp.height}\`, bg \`${inp.background}\`, color \`${inp.color}\`, border \`${inp.border}\`, radius \`${inp.borderRadius}\`, padding \`${inp.padding}\`, font \`${inp.fontSize}\``,
      );
    }
    lines.push('');
  }

  if (specs?.cards && specs.cards.length > 0) {
    lines.push('### Cards & Surface Containers');
    for (const card of specs.cards) {
      lines.push(
        `- \`${card.selector}\` (${card.dimensions}, display \`${card.display}\`) - bg \`${card.background}\`, border \`${card.border}\`, radius \`${card.borderRadius}\`, padding \`${card.padding}\`, shadow \`${card.boxShadow}\``,
      );
    }
    lines.push('');
  }

  const assetsMotion = primary?.assetsAndMotion;
  if (assetsMotion) {
    lines.push('### Media, Icons, Video & Canvas Inventory');
    lines.push(
      `- **Live DOM Elements**: ${assetsMotion.liveDomCounts.imgs} \`<img>\`, ${assetsMotion.liveDomCounts.inlineSvgs} inline \`<svg>\`, ${assetsMotion.liveDomCounts.videos} \`<video>\`, ${assetsMotion.liveDomCounts.canvases} \`<canvas>\`, ${assetsMotion.liveDomCounts.iframes} \`<iframe>\``,
    );
    const kindSummary = Object.entries(assetsMotion.byKind)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    if (kindSummary) {
      lines.push(`- **Discovered Assets (${assetsMotion.totalDiscovered} total)**: ${kindSummary}`);
    }
    if (assetsMotion.notableMedia.length > 0) {
      for (const m of assetsMotion.notableMedia.slice(0, 8)) {
        lines.push(`  - [${m.kind}] \`${m.descriptor}\` (${m.dimensions})`);
      }
    }
    lines.push('');

    lines.push('### Motion, Transitions & Interactivity');
    if (assetsMotion.transitions.length > 0) {
      lines.push(
        `- **Observed CSS Transitions**: ${assetsMotion.transitions.map((t) => `\`${t}\``).join(', ')}`,
      );
    }
    if (assetsMotion.keyframes.length > 0) {
      lines.push(
        `- **Declared \`@keyframes\`**: ${assetsMotion.keyframes.map((k) => `\`${k}\``).join(', ')}`,
      );
    }
    if (assetsMotion.animationsInUse.length > 0) {
      lines.push(
        `- **Active CSS Animations**: ${assetsMotion.animationsInUse.map((a) => `\`${a}\``).join(', ')}`,
      );
    }
    if (assetsMotion.interactionClues.length > 0) {
      lines.push(`- **Interactive & Scroll Engines**: ${assetsMotion.interactionClues.join('; ')}`);
    }
    if (
      assetsMotion.transitions.length === 0 &&
      assetsMotion.keyframes.length === 0 &&
      assetsMotion.interactionClues.length === 0
    ) {
      lines.push('- No non-default CSS transitions or keyframes extracted in initial state.');
    }
    lines.push('');
  }

  const styleAdapt = primary?.styleAdaptation;
  if (styleAdapt) {
    if (styleAdapt.pseudoStateRules.length > 0) {
      lines.push('### Interactive Pseudo-States (`:hover`, `:focus-visible`, ARIA)');
      for (const r of styleAdapt.pseudoStateRules.slice(0, 16)) {
        lines.push(`- **${r.state}** on \`${r.selector}\` -> \`${r.declarations}\``);
      }
      lines.push('');
    }
    if (styleAdapt.pseudoElementStyles.length > 0) {
      lines.push('### Decorative Pseudo-Elements (`::before` / `::after`)');
      for (const pe of styleAdapt.pseudoElementStyles.slice(0, 12)) {
        lines.push(`- \`${pe.selector}\` (${pe.source}): \`${pe.summary}\``);
      }
      lines.push('');
    }
    if (styleAdapt.stackingLayers.length > 0) {
      lines.push('### Z-Index Layering & Stacking Contexts');
      for (const layer of styleAdapt.stackingLayers.slice(0, 10)) {
        lines.push(
          `- \`${layer.selector}\` (\`position: ${layer.position}\`, \`z-index: ${layer.zIndex}\`) - ${layer.roleHint}`,
        );
      }
      lines.push('');
    }
    if (styleAdapt.accessibilityContract.length > 0) {
      lines.push('### Accessibility Landmarks & Interactive State Contract');
      for (const a of styleAdapt.accessibilityContract.slice(0, 14)) {
        const stateText = a.states.length > 0 ? ` [${a.states.join(', ')}]` : '';
        lines.push(`- **${a.role}** (\`${a.selector}\`): "${a.label}"${stateText}`);
      }
      lines.push('');
    }
  }

  lines.push('### Additional Semantic Component Observations');
  if (componentSet.size === 0) {
    lines.push('- Generic semantic containers.');
  } else {
    for (const comp of Array.from(componentSet).sort()) {
      lines.push(`- ${comp}`);
    }
  }
  lines.push('');
}

function appendTokensAndGuidelinesSection(
  lines: string[],
  pages: PageDesignSnapshotInput[],
  allCssVariables: DesignCssVariableEntry[],
  sortedRadii: string[],
  sortedShadows: string[],
): void {
  const ov = pages[0]?.siteOverview;
  const topFont = pages[0]?.fontsReport.families[0];
  lines.push('## 9. Copy-Pasteable :root Tokens & AI Implementation Guide');
  lines.push('');
  lines.push('### Ready-to-Use `:root` CSS Variables');
  lines.push('```css');
  lines.push(':root {');
  if (ov) {
    lines.push(`  --site-canvas-bg: ${ov.canvasBackgroundHex};`);
    if (ov.surfaceBackgroundHex) {
      lines.push(`  --site-surface-bg: ${ov.surfaceBackgroundHex};`);
    }
    lines.push(`  --site-text-primary: ${ov.primaryTextHex};`);
    if (ov.mutedTextHex) {
      lines.push(`  --site-text-muted: ${ov.mutedTextHex};`);
    }
    if (ov.primaryAccentHex) {
      lines.push(`  --site-accent: ${ov.primaryAccentHex};`);
    }
    if (ov.primaryBorderHex) {
      lines.push(`  --site-border: ${ov.primaryBorderHex};`);
    }
    lines.push(`  --site-root-font-size: ${ov.rootFontSizePx};`);
  }
  if (topFont) {
    lines.push(`  --site-font-primary: ${topFont.declaredStack};`);
  }
  if (sortedRadii[0]) {
    lines.push(`  --site-radius-base: ${sortedRadii[0]};`);
  }
  for (const v of allCssVariables.slice(0, 35)) {
    lines.push(`  ${v.name}: ${v.value};`);
  }
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('### AI Coding Agent Recreation Checklist');
  if (ov) {
    lines.push(
      `1. **Canvas & Polarity**: Lock the root theme to \`${ov.themeMode}\` mode with \`${ov.canvasBackgroundHex}\` canvas background and \`${ov.primaryTextHex}\` primary ink.${ov.primaryAccentHex ? ` Reserve \`${ov.primaryAccentHex}\` strictly for primary brand highlights and CTA accents.` : ''}`,
    );
  }
  if (topFont) {
    lines.push(
      `2. **Typography & Scale**: Load \`${topFont.primaryFamily}\` (\`${topFont.declaredStack}\`) and preserve the exact root font size (\`${ov?.rootFontSizePx ?? '16px'}\`) and uppercase/tracking ratios listed in Section 3.`,
    );
  }
  lines.push(
    `3. **Sections & Landmarks**: Follow Section 6 top-to-bottom (${pages[0]?.pageSections?.length ?? 0} documented section block(s)), matching header positioning, section heights/aspect rhythm, and footer structure.`,
  );
  lines.push(
    `4. **Components & Motion**: Apply the exact button, input, and card border/radius/padding tokens from Section 7, plus the extracted CSS transition curves and media aspect ratios.`,
  );
  lines.push('');
  lines.push('### Visual Anti-Patterns (Do Not Violate)');
  if (ov?.themeMode === 'light') {
    lines.push('- Do NOT swap the page onto a generic dark theme or cold slate background.');
  } else if (ov?.themeMode === 'dark') {
    lines.push('- Do NOT wash the dark canvas out into default browser white cards.');
  }
  if (pages.every((p) => p.colorsReport.gradients.length === 0)) {
    lines.push(
      '- Do NOT introduce decorative multi-stop CSS gradients; no computed gradients were detected on this site.',
    );
  }
  if (sortedRadii.length === 0 || sortedRadii.every((r) => parsePixelValue(r) <= 4)) {
    lines.push(
      '- Preserve crisp architectural geometry; avoid oversized pill/bubble rounding on structural containers.',
    );
  }
  if (sortedShadows.length === 0) {
    lines.push(
      '- Use 1px hairline borders instead of heavy drop shadows for hierarchy; no heavy box-shadows were detected.',
    );
  }
  lines.push(
    '- Do NOT substitute system Inter/Roboto when custom `@font-face` stacks are specified above without declaring fallback rules explicitly.',
  );
  lines.push('');
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
      selectors: Set<string>;
    }
  >();

  const customPropValuesByPage = new Map<string, Array<{ pageUrl: string; value: string }>>();
  const allCssVarsMap = new Map<string, DesignCssVariableEntry>();
  const fontUsageByFamily = new Map<
    string,
    {
      primaryFamily: string;
      declaredStack: string;
      totalUsage: number;
      sizes: Set<string>;
      weights: Set<string>;
      lineHeights: Set<string>;
      letterSpacings: Set<string>;
    }
  >();

  const primaryFontByPage: Array<{ pageUrl: string; primaryFamily: string }> = [];
  const spacingSet = new Set<number>();
  const radiusSet = new Set<string>();
  const shadowSet = new Set<string>();
  const borderSigSet = new Set<string>();
  const containerWidthSet = new Set<number>();
  const mediaQuerySet = new Set<string>();
  const layoutPatternSet = new Set<string>();
  const componentSet = new Set<string>();

  for (const page of pages) {
    for (const c of page.colorsReport.colors) {
      const existing = colorUsageByHex.get(c.hex);
      if (existing) {
        existing.totalUsage += c.usageCount;
        c.properties.forEach((p) => existing.properties.add(p));
        c.sampleSelectors.forEach((s) => existing.selectors.add(s));
      } else {
        colorUsageByHex.set(c.hex, {
          hex: c.hex,
          rgbString: c.rgbString,
          hslString: c.hslString,
          totalUsage: c.usageCount,
          properties: new Set(c.properties),
          selectors: new Set(c.sampleSelectors),
        });
      }
    }

    for (const prop of page.colorsReport.customProperties) {
      const list = customPropValuesByPage.get(prop.name) ?? [];
      list.push({ pageUrl: page.pageUrl, value: prop.normalizedHex ?? prop.rawValue });
      customPropValuesByPage.set(prop.name, list);
      if (!allCssVarsMap.has(prop.name)) {
        allCssVarsMap.set(prop.name, {
          name: prop.name,
          value: prop.rawValue,
          normalizedHex: prop.normalizedHex,
        });
      }
    }
    for (const v of page.allCssVariables ?? []) {
      allCssVarsMap.set(v.name, v);
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
      const letterSpacings = fam.combinations.map((c) => c.letterSpacing);
      if (existing) {
        existing.totalUsage += fam.totalUsageCount;
        sizes.forEach((s) => existing.sizes.add(s));
        weights.forEach((w) => existing.weights.add(w));
        lineHeights.forEach((lh) => existing.lineHeights.add(lh));
        letterSpacings.forEach((ls) => existing.letterSpacings.add(ls));
      } else {
        fontUsageByFamily.set(fam.primaryFamily, {
          primaryFamily: fam.primaryFamily,
          declaredStack: fam.declaredStack,
          totalUsage: fam.totalUsageCount,
          sizes: new Set(sizes),
          weights: new Set(weights),
          lineHeights: new Set(lineHeights),
          letterSpacings: new Set(letterSpacings),
        });
      }
    }

    page.spacingTokensPx.forEach((s) => spacingSet.add(s));
    page.borderRadii.forEach((r) => radiusSet.add(r));
    page.boxShadows.forEach((sh) => shadowSet.add(sh));
    (page.borderSignatures ?? []).forEach((b) => borderSigSet.add(b));
    (page.containerWidthsPx ?? []).forEach((w) => containerWidthSet.add(w));
    (page.mediaQueries ?? []).forEach((mq) => mediaQuerySet.add(mq));
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
  const allCssVariables = Array.from(allCssVarsMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const lines: string[] = [];
  const primaryTitle =
    pages.length === 1
      ? (pages[0]?.pageTitle ?? 'Design System')
      : `Combined Design System (${pages.length} Pages)`;
  lines.push(`# DESIGN.md - ${primaryTitle}`);
  lines.push('');

  const ov = pages[0]?.siteOverview;
  if (ov) {
    lines.push('```yaml');
    lines.push(`theme_mode: ${ov.themeMode}`);
    lines.push(`canvas: "${ov.canvasBackgroundHex}"`);
    if (ov.surfaceBackgroundHex) lines.push(`surface: "${ov.surfaceBackgroundHex}"`);
    lines.push(`text_primary: "${ov.primaryTextHex}"`);
    if (ov.mutedTextHex) lines.push(`text_muted: "${ov.mutedTextHex}"`);
    if (ov.primaryAccentHex) lines.push(`accent: "${ov.primaryAccentHex}"`);
    if (ov.primaryBorderHex) lines.push(`border: "${ov.primaryBorderHex}"`);
    if (deduplicatedFonts[0]) lines.push(`primary_font: "${deduplicatedFonts[0].primaryFamily}"`);
    lines.push(`root_font_size: "${ov.rootFontSizePx}"`);
    lines.push(`viewport: "${ov.viewportWidth}x${ov.viewportHeight}"`);
    lines.push(`document_height_px: ${ov.scrollHeight}`);
    if (ov.techStackOneLiner) lines.push(`tech_stack: "${ov.techStackOneLiner}"`);
    lines.push('```');
    lines.push('');
  }

  lines.push('## 1. Source References');
  for (const page of pages) {
    lines.push(`- **${page.pageTitle}**: ${page.pageUrl}`);
    if (page.siteOverview?.metaDescription) {
      lines.push(`  - Meta Description: ${page.siteOverview.metaDescription}`);
    }
    if (page.siteOverview) {
      const sOv = page.siteOverview;
      lines.push(
        `  - Viewport & Document: \`${sOv.viewportWidth}x${sOv.viewportHeight}\` (full document: \`${sOv.scrollWidth}x${sOv.scrollHeight}px\`, lang: \`${sOv.language || 'unspecified'}\`)`,
      );
      if (sOv.techStackOneLiner) {
        lines.push(`  - Detected Stack: ${sOv.techStackOneLiner}`);
      }
    }
  }
  lines.push('');

  lines.push('## 2. Color Palette & Semantic Tokens');
  appendSemanticColorsSection(lines, pages, deduplicatedColors, allCssVariables);

  lines.push('## 3. Typography & Type Scale');
  appendTypographySection(lines, pages, deduplicatedFonts);

  lines.push('## 4. Spacing Scale & Responsive Breakpoints');
  if (containerWidthSet.size > 0) {
    lines.push(
      `- **Container Max-Widths (px)**: ${Array.from(containerWidthSet)
        .sort((a, b) => a - b)
        .map((w) => `\`${w}px\``)
        .join(', ')}`,
    );
  }
  if (sortedSpacing.length === 0) {
    lines.push('- Default browser spacing.');
  } else {
    lines.push(
      `- **Extracted Spacing Steps (px)**: ${sortedSpacing.map((px) => `\`${px}px\``).join(', ')}`,
    );
  }
  if (mediaQuerySet.size > 0) {
    lines.push('- **Responsive `@media` Breakpoints**:');
    for (const mq of Array.from(mediaQuerySet)) {
      lines.push(`  - \`${mq}\``);
    }
  }
  lines.push('');

  lines.push('## 5. Border Radius, Borders & Shadows');
  lines.push(
    `- **Border Radii**: ${sortedRadii.length > 0 ? sortedRadii.map((r) => `\`${r}\``).join(', ') : 'None (`0px`)'}`,
  );
  if (borderSigSet.size > 0) {
    lines.push(
      `- **Border Strokes**: ${Array.from(borderSigSet)
        .map((b) => `\`${b}\``)
        .join(', ')}`,
    );
  }
  lines.push(
    `- **Box Shadows**: ${sortedShadows.length > 0 ? sortedShadows.map((s) => `\`${s}\``).join('; ') : 'None'}`,
  );
  lines.push('');

  lines.push('## 6. Layout Patterns & Page Architecture');
  appendLayoutArchitectureSection(lines, pages);
  lines.push('### Layout Grid, Flex & Sticky Landmarks');
  if (layoutPatternSet.size === 0) {
    lines.push('- Standard block flow.');
  } else {
    for (const pattern of Array.from(layoutPatternSet).sort()) {
      lines.push(`- ${pattern}`);
    }
  }
  lines.push('');

  lines.push('## 7. Component Observations, Media & Motion');
  appendComponentsMediaMotionSection(lines, pages, componentSet);

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
  lines.push('');

  appendTokensAndGuidelinesSection(lines, pages, allCssVariables, sortedRadii, sortedShadows);

  const adapt = pages[0]?.styleAdaptation;
  if (adapt) {
    lines.push('## 10. REA Style Adaptation & Evidence Completeness');
    lines.push('');
    lines.push('### Extraction Completeness & Evidence Boundaries');
    lines.push(
      `- **Coverage Status**: \`${adapt.completeness.coverageStatus}\` (${adapt.completeness.scannedElementsCount} DOM elements scanned, ${adapt.completeness.accessibleStylesheetsCount} accessible stylesheet(s), ${adapt.completeness.openShadowRootsCount} open shadow root(s), DOM budget truncated: \`${adapt.completeness.domTruncated}\`)`,
    );
    if (adapt.completeness.omissionReasons.length > 0) {
      lines.push('- **Explicit Omissions / Unknown Scopes (Never Treated as Absence)**:');
      for (const reason of adapt.completeness.omissionReasons) {
        lines.push(`  - ${reason}`);
      }
    }
    if (adapt.completeness.inaccessibleStylesheets.length > 0) {
      lines.push(
        `- **CORS-Protected Stylesheets**: ${adapt.completeness.inaccessibleStylesheets
          .slice(0, 6)
          .map((u) => `\`${u}\``)
          .join(', ')}`,
      );
    }
    lines.push('');

    if (adapt.wcagContrastPairs.length > 0) {
      lines.push('### WCAG 2.1 Measured Contrast Verification');
      lines.push('| Pair | Foreground | Background | Ratio | Grade |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const cp of adapt.wcagContrastPairs) {
        lines.push(
          `| ${cp.pairLabel} | \`${cp.foregroundHex}\` | \`${cp.backgroundHex}\` | **${cp.contrastRatio}:1** | ${cp.grade} |`,
        );
      }
      lines.push('');
    }

    if (adapt.fluidExpressions.length > 0 || adapt.themeVariantRules.length > 0) {
      lines.push('### Fluid CSS Scaling & Theme Variant Rules');
      for (const fl of adapt.fluidExpressions.slice(0, 12)) {
        lines.push(`- \`${fl.selectorOrRule}\` \`${fl.property}\`: \`${fl.expression}\``);
      }
      for (const tv of adapt.themeVariantRules.slice(0, 8)) {
        lines.push(`- Theme rule: ${tv}`);
      }
      lines.push('');
    }

    lines.push('### Adapted Semantic CSS Component Theme');
    lines.push('```css');
    lines.push(adapt.adaptedCssThemeBlock);
    lines.push('```');
    lines.push('');

    lines.push('### Adapted Tailwind CSS v4 `@theme` & Utility Equivalents');
    lines.push('```css');
    lines.push(adapt.adaptedTailwindThemeBlock);
    lines.push('```');
    for (const util of adapt.adaptedTailwindUtilities) {
      lines.push(`- **${util.role}**: \`${util.classes}\``);
    }
    lines.push('');

    lines.push('### Post-Rebuild Fidelity Verification Targets');
    for (const assertion of adapt.reconstructionAssertions) {
      lines.push(`- ${assertion}`);
    }
    lines.push('');
  }

  const motionSpecs = pages
    .map((p) => p.motionSpec)
    .filter((m): m is MotionSpec => m !== undefined);
  if (motionSpecs.length > 0) {
    lines.push('## 11. Motion Lab Temporal & Interaction Specification');
    lines.push('');
    for (const ms of motionSpecs) {
      const counts = summarizeMotionSpecCounts(ms);
      lines.push(
        `- **Scope**: \`${ms.rootSelector}\` (${ms.session.state}, ${Math.round(ms.session.observedDurationMs)} ms, ${ms.session.sampleCount} samples · ${counts.declaredCount} declared, ${counts.observedCount} observed, ${counts.inferredCount} inferred, ${counts.unavailableCount} unavailable)`,
      );
      for (const track of ms.tracks.slice(0, 12)) {
        const timing =
          track.timelineDomain === 'scroll_progress_percent' ||
          track.timelineDomain === 'view_progress_percent'
            ? `scroll ${track.progressStartPct ?? 0}%–${track.progressEndPct ?? 100}%`
            : `${Math.round(track.durationMs ?? 0)}ms / delay ${Math.round(track.delayMs ?? 0)}ms`;
        const easing = track.declaredEasing ?? track.inferredEasings[0]?.cssEasing ?? 'linear';
        lines.push(
          `  - \`${track.selector}\` \`${track.property}\` [${track.evidenceClass} · ${track.category} · ${track.trigger}]: ${timing}, easing \`${easing}\`${track.staggerFromPrevMs ? `, stagger +${Math.round(track.staggerFromPrevMs)}ms` : ''}`,
        );
      }
      if (ms.unavailableItems.length > 0) {
        for (const item of ms.unavailableItems.slice(0, 6)) {
          lines.push(`  - Unavailable (${item.category} on \`${item.target}\`): ${item.reason}`);
        }
      }
    }
    lines.push('');
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
