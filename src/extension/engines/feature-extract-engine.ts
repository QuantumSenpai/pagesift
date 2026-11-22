import { collectDocumentElements, isPageSiftElement } from './dom-utils.js';
import { extractPageColors } from './colors-engine.js';
import { extractPageFonts } from './fonts-engine.js';
import { detectPageTechStack } from './tech-stack-engine.js';

export interface ExtractedProductFeatureItem {
  title: string;
  detail: string;
  sectionTag: string;
}

export interface PageFeatureExtractionReport {
  pageTitle: string;
  sourceUrl: string;
  metaDescription: string | null;
  heroHeadline: string | null;
  primaryCtas: string[];
  navigationItems: string[];
  headingsOutline: Array<{ level: string; text: string }>;
  featureBlocks: ExtractedProductFeatureItem[];
  uiPatterns: {
    formsCount: number;
    searchInputsCount: number;
    buttonsCount: number;
    cardsEstimateCount: number;
    tablesCount: number;
    modalsOrDialogsCount: number;
    mediaEmbedsCount: number;
  };
  techStackSummary: string;
  topColors: string[];
  fontFamilies: string[];
  sanitizedAiContext: Record<string, unknown>;
}

function sanitizeFeatureText(raw: string, maxLen: number): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function sanitizeSourceUrl(rawHref: string): string {
  try {
    const u = new URL(rawHref);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return '';
    }
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}

export function extractPageFeaturesLocal(doc: Document, win: Window): PageFeatureExtractionReport {
  const pageTitle = sanitizeFeatureText(doc.title || '', 180);
  const sourceUrl = sanitizeSourceUrl(doc.location.href || '');
  const metaDescEl = doc.querySelector('meta[name="description"], meta[property="og:description"]');
  const metaDescription = metaDescEl
    ? sanitizeFeatureText(metaDescEl.getAttribute('content') ?? '', 300) || null
    : null;

  const h1El = Array.from(doc.querySelectorAll('h1')).find((el) => !isPageSiftElement(el));
  const heroHeadline = h1El ? sanitizeFeatureText(h1El.textContent, 220) || null : null;

  const { entries } = collectDocumentElements(doc, 1200);

  const ctaSet = new Set<string>();
  const navSet = new Set<string>();
  const headingsOutline: Array<{ level: string; text: string }> = [];
  const featureBlocks: ExtractedProductFeatureItem[] = [];
  const featureTitlesSeen = new Set<string>();

  let formsCount = 0;
  let searchInputsCount = 0;
  let buttonsCount = 0;
  let cardsEstimateCount = 0;
  let tablesCount = 0;
  let modalsOrDialogsCount = 0;
  let mediaEmbedsCount = 0;

  for (const { element } of entries) {
    const tag = element.tagName.toLowerCase();
    const role = (element.getAttribute('role') ?? '').toLowerCase();

    if (tag === 'form') formsCount += 1;
    if (
      tag === 'input' &&
      ((element.getAttribute('type') ?? '').toLowerCase() === 'search' ||
        (element.getAttribute('placeholder') ?? '').toLowerCase().includes('search'))
    ) {
      searchInputsCount += 1;
    }
    if (tag === 'table') tablesCount += 1;
    if (tag === 'dialog' || role === 'dialog' || role === 'alertdialog') modalsOrDialogsCount += 1;
    if (tag === 'video' || tag === 'audio' || tag === 'iframe') mediaEmbedsCount += 1;

    if (tag === 'button' || role === 'button') {
      buttonsCount += 1;
      const label = sanitizeFeatureText(
        element.textContent || element.getAttribute('aria-label') || '',
        64,
      );
      if (label.length >= 2 && ctaSet.size < 16) {
        ctaSet.add(label);
      }
    } else if (tag === 'a') {
      const text = sanitizeFeatureText(
        element.textContent || element.getAttribute('aria-label') || '',
        64,
      );
      if (!text) continue;
      if (element.closest('nav, header') && navSet.size < 20) {
        navSet.add(text);
      } else {
        const cls = (element.getAttribute('class') ?? '').toLowerCase();
        if (
          (cls.includes('btn') || cls.includes('cta') || cls.includes('button')) &&
          ctaSet.size < 16
        ) {
          ctaSet.add(text);
        }
      }
    } else if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
      const text = sanitizeFeatureText(element.textContent, 120);
      if (text.length >= 2 && headingsOutline.length < 24) {
        headingsOutline.push({ level: tag, text });
      }
      if ((tag === 'h2' || tag === 'h3') && featureBlocks.length < 18) {
        const normalized = text.toLowerCase();
        if (!featureTitlesSeen.has(normalized)) {
          featureTitlesSeen.add(normalized);
          const cardHost = element.closest('section, article, li, div');
          const descCandidate = cardHost?.querySelector('p');
          const detail = descCandidate ? sanitizeFeatureText(descCandidate.textContent, 220) : '';
          featureBlocks.push({
            title: text,
            detail,
            sectionTag: cardHost?.tagName.toLowerCase() ?? tag,
          });
        }
      }
    }

    if (tag === 'article' || tag === 'li') {
      const classText =
        typeof element.className === 'string' ? element.className.toLowerCase() : '';
      if (classText.includes('card') || classText.includes('feature') || tag === 'article') {
        cardsEstimateCount += 1;
      }
    }
  }

  const colors = extractPageColors(doc, win);
  const fonts = extractPageFonts(doc, win);
  const tech = detectPageTechStack(doc, win);

  const topColors = colors.colors.slice(0, 10).map((c) => c.hex);
  const fontFamilies = fonts.families.slice(0, 6).map((f) => f.primaryFamily);
  const techStackSummary = tech.organizedSummary.oneLiner;
  const primaryCtas = Array.from(ctaSet);
  const navigationItems = Array.from(navSet);

  const sanitizedAiContext: Record<string, unknown> = {
    pageTitle,
    sourceUrl,
    ...(metaDescription ? { metaDescription } : {}),
    ...(heroHeadline ? { heroHeadline } : {}),
    primaryCtas: primaryCtas.slice(0, 12),
    navigationItems: navigationItems.slice(0, 14),
    featureBlocks: featureBlocks
      .slice(0, 14)
      .map((f) => `${f.title}${f.detail ? `: ${f.detail}` : ''}`),
    uiPatterns: {
      formsCount,
      searchInputsCount,
      buttonsCount,
      cardsEstimateCount,
      tablesCount,
      modalsOrDialogsCount,
      mediaEmbedsCount,
    },
    techStackSummary,
    topColors,
    fontFamilies,
  };

  return {
    pageTitle,
    sourceUrl,
    metaDescription,
    heroHeadline,
    primaryCtas,
    navigationItems,
    headingsOutline,
    featureBlocks,
    uiPatterns: {
      formsCount,
      searchInputsCount,
      buttonsCount,
      cardsEstimateCount,
      tablesCount,
      modalsOrDialogsCount,
      mediaEmbedsCount,
    },
    techStackSummary,
    topColors,
    fontFamilies,
    sanitizedAiContext,
  };
}
