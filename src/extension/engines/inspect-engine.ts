import { parseCssColorToRgba } from './colors-engine.js';
import { computeWcagContrastRatio } from './design-review-engine.js';
import {
  buildShortSelector,
  inspectFramesAndStylesheets,
  isPageSiftElement,
  isShadowRootNode,
  parsePixelValue,
  sanitizeElementHtml,
} from './dom-utils.js';

export interface BoxSides {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface InspectElementReport {
  connected: boolean;
  tagName: string;
  id: string | null;
  classList: string[];
  selector: string;
  insideOpenShadowRoot: boolean;
  safeHtml: string;
  attributes: Record<string, string>;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    right: number;
    bottom: number;
    left: number;
    pageX: number;
    pageY: number;
    zoomFactor: number;
  };
  layout: {
    display: string;
    position: string;
    boxSizing: string;
    flexDirection: string;
    justifyContent: string;
    alignItems: string;
    gap: string;
    gridTemplateColumns: string;
    gridTemplateRows: string;
    overflowX: string;
    overflowY: string;
    zIndex: string;
  };
  typography: {
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    lineHeight: string;
    letterSpacing: string;
    textAlign: string;
    textTransform: string;
    color: string;
  };
  colors: {
    textColor: string;
    backgroundColor: string;
    borderColor: string;
    outlineColor: string;
    contrastRatio?: number;
    contrastGrade?: 'AAA' | 'AA' | 'AA Large' | 'Fail';
  };
  spacing: {
    margin: BoxSides;
    padding: BoxSides;
  };
  bordersAndEffects: {
    borderRadius: string;
    borderWidth: BoxSides;
    borderStyle: string;
    boxShadow: string;
    opacity: string;
    filter: string;
  };
  accessibility: {
    role: string | null;
    accessibleName: string | null;
    ariaLabel: string | null;
    ariaDescribedBy: string | null;
    tabIndex: number | null;
  };
  diagnostics: {
    computedStyleNotice: string;
    inaccessibleCrossOriginFrames: string[];
    inaccessibleStylesheets: string[];
    closedShadowRootHint: string;
  };
}

function computeAccessibleName(el: Element, doc: Document): string | null {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim().length > 0) {
    return ariaLabel.trim();
  }
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => {
        const refEl = doc.getElementById(id);
        return refEl ? refEl.textContent.trim() : '';
      })
      .filter((t) => t.length > 0);
    if (parts.length > 0) {
      return parts.join(' ');
    }
  }
  const alt = el.getAttribute('alt');
  if (alt && alt.trim().length > 0) {
    return alt.trim();
  }
  const title = el.getAttribute('title');
  if (title && title.trim().length > 0) {
    return title.trim();
  }
  const text = el.textContent.trim();
  if (text.length > 0) {
    return text.slice(0, 140);
  }
  return null;
}

function inferImplicitRole(el: Element): string | null {
  const explicit = el.getAttribute('role');
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim();
  }
  const tag = el.tagName.toLowerCase();
  const roleMap: Record<string, string> = {
    a: el.hasAttribute('href') ? 'link' : 'generic',
    button: 'button',
    nav: 'navigation',
    main: 'main',
    header: 'banner',
    footer: 'contentinfo',
    aside: 'complementary',
    section: 'region',
    form: 'form',
    img: 'img',
    ul: 'list',
    ol: 'list',
    li: 'listitem',
    table: 'table',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    h5: 'heading',
    h6: 'heading',
  };
  return roleMap[tag] ?? null;
}

export function inspectElement(target: Element, win: Window): InspectElementReport {
  if (isPageSiftElement(target)) {
    throw new Error('Cannot inspect PageSift internal UI element');
  }
  if (!target.isConnected) {
    throw new Error('Target element is detached from the active document');
  }

  const doc = target.ownerDocument;
  const computed = win.getComputedStyle(target);
  const rect = target.getBoundingClientRect();
  const rawZoom = Number.parseFloat(computed.getPropertyValue('zoom') || '1');
  const zoomFactor = Number.isFinite(rawZoom) && rawZoom > 0 ? rawZoom : 1;

  const safeAttributes: Record<string, string> = {};
  for (const attr of Array.from(target.attributes)) {
    const nameLower = attr.name.toLowerCase();
    if (nameLower.startsWith('on') || nameLower === 'value' || nameLower === 'style') {
      continue;
    }
    safeAttributes[attr.name] = attr.value.slice(0, 300);
  }

  const rootNode = target.getRootNode();
  const insideOpenShadowRoot = isShadowRootNode(rootNode);

  const frameAndSheetReport = inspectFramesAndStylesheets(doc);

  let contrastRatio: number | undefined;
  let contrastGrade: 'AAA' | 'AA' | 'AA Large' | 'Fail' | undefined;
  const fgRgba = parseCssColorToRgba(computed.color);
  if (fgRgba && fgRgba.a > 0) {
    let bgCursor: Element | null = target;
    let resolvedBg = { r: 255, g: 255, b: 255, a: 1 };
    while (bgCursor) {
      const parsedBg = parseCssColorToRgba(win.getComputedStyle(bgCursor).backgroundColor);
      if (parsedBg && parsedBg.a >= 0.85) {
        resolvedBg = parsedBg;
        break;
      }
      bgCursor = bgCursor.parentElement;
    }
    contrastRatio = computeWcagContrastRatio(fgRgba, resolvedBg);
    contrastGrade =
      contrastRatio >= 7
        ? 'AAA'
        : contrastRatio >= 4.5
          ? 'AA'
          : contrastRatio >= 3
            ? 'AA Large'
            : 'Fail';
  }

  return {
    connected: target.isConnected,
    tagName: target.tagName.toLowerCase(),
    id: target.id || null,
    classList: Array.from(target.classList),
    selector: buildShortSelector(target),
    insideOpenShadowRoot,
    safeHtml: sanitizeElementHtml(target),
    attributes: safeAttributes,
    boundingBox: {
      x: Number(rect.x.toFixed(2)),
      y: Number(rect.y.toFixed(2)),
      width: Number(rect.width.toFixed(2)),
      height: Number(rect.height.toFixed(2)),
      top: Number(rect.top.toFixed(2)),
      right: Number(rect.right.toFixed(2)),
      bottom: Number(rect.bottom.toFixed(2)),
      left: Number(rect.left.toFixed(2)),
      pageX: Number((rect.left + win.scrollX).toFixed(2)),
      pageY: Number((rect.top + win.scrollY).toFixed(2)),
      zoomFactor,
    },
    layout: {
      display: computed.display,
      position: computed.position,
      boxSizing: computed.boxSizing,
      flexDirection: computed.flexDirection,
      justifyContent: computed.justifyContent,
      alignItems: computed.alignItems,
      gap: computed.gap,
      gridTemplateColumns: computed.gridTemplateColumns,
      gridTemplateRows: computed.gridTemplateRows,
      overflowX: computed.overflowX,
      overflowY: computed.overflowY,
      zIndex: computed.zIndex,
    },
    typography: {
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize,
      fontWeight: computed.fontWeight,
      lineHeight: computed.lineHeight,
      letterSpacing: computed.letterSpacing,
      textAlign: computed.textAlign,
      textTransform: computed.textTransform,
      color: computed.color,
    },
    colors: {
      textColor: computed.color,
      backgroundColor: computed.backgroundColor,
      borderColor: computed.borderTopColor,
      outlineColor: computed.outlineColor,
      ...(contrastRatio !== undefined ? { contrastRatio } : {}),
      ...(contrastGrade !== undefined ? { contrastGrade } : {}),
    },
    spacing: {
      margin: {
        top: parsePixelValue(computed.marginTop),
        right: parsePixelValue(computed.marginRight),
        bottom: parsePixelValue(computed.marginBottom),
        left: parsePixelValue(computed.marginLeft),
      },
      padding: {
        top: parsePixelValue(computed.paddingTop),
        right: parsePixelValue(computed.paddingRight),
        bottom: parsePixelValue(computed.paddingBottom),
        left: parsePixelValue(computed.paddingLeft),
      },
    },
    bordersAndEffects: {
      borderRadius: computed.borderRadius,
      borderWidth: {
        top: parsePixelValue(computed.borderTopWidth),
        right: parsePixelValue(computed.borderRightWidth),
        bottom: parsePixelValue(computed.borderBottomWidth),
        left: parsePixelValue(computed.borderLeftWidth),
      },
      borderStyle: computed.borderTopStyle,
      boxShadow: computed.boxShadow,
      opacity: computed.opacity,
      filter: computed.filter,
    },
    accessibility: {
      role: inferImplicitRole(target),
      accessibleName: computeAccessibleName(target, doc),
      ariaLabel: target.getAttribute('aria-label'),
      ariaDescribedBy: target.getAttribute('aria-describedby'),
      tabIndex:
        'tabIndex' in target &&
        typeof (target as HTMLElement).tabIndex === 'number' &&
        Number.isFinite((target as HTMLElement).tabIndex)
          ? (target as HTMLElement).tabIndex
          : null,
    },
    diagnostics: {
      computedStyleNotice:
        'Computed styles represent resolved cascade values at the current viewport and do not reveal original source CSS selectors.',
      inaccessibleCrossOriginFrames: frameAndSheetReport.inaccessibleCrossOriginFrames,
      inaccessibleStylesheets: frameAndSheetReport.inaccessibleStylesheets,
      closedShadowRootHint:
        'Open shadow roots are traversed; browser-enforced closed shadow roots cannot be inspected by content scripts.',
    },
  };
}
