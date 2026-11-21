export const PAGESIFT_ROOT_ATTR = 'data-pagesift-root';

export interface TraversableNodeEntry {
  element: Element;
  insideOpenShadowRoot: boolean;
}

export interface FrameAndStylesheetReport {
  sameOriginFramesCount: number;
  inaccessibleCrossOriginFrames: string[];
  accessibleStylesheetsCount: number;
  inaccessibleStylesheets: string[];
  openShadowRootsCount: number;
}

export function isShadowRootNode(node: Node): node is ShadowRoot {
  return node.nodeType === 11 && 'host' in node;
}

export function isPageSiftElement(node: Node | null): boolean {
  let current: Node | null = node;
  while (current) {
    if (current.nodeType === 1) {
      const el = current as Element;
      if (el.hasAttribute(PAGESIFT_ROOT_ATTR) || el.id === 'pagesift-root-host') {
        return true;
      }
    }
    if (
      isShadowRootNode(current) &&
      (current.host.hasAttribute(PAGESIFT_ROOT_ATTR) || current.host.id === 'pagesift-root-host')
    ) {
      return true;
    }
    current = current.parentNode ?? (isShadowRootNode(current) ? current.host : null);
  }
  return false;
}

export function collectDocumentElements(
  rootDoc: Document,
  maxElements = 2500,
): {
  entries: TraversableNodeEntry[];
  openShadowRootsCount: number;
  truncated: boolean;
} {
  const entries: TraversableNodeEntry[] = [];
  let openShadowRootsCount = 0;
  let truncated = false;

  const visitRoot = (root: Document | ShadowRoot | Element, inShadow: boolean): void => {
    const walker = rootDoc.createTreeWalker(root, 1);
    let current = walker.nextNode() as Element | null;
    while (current) {
      if (!isPageSiftElement(current)) {
        if (entries.length >= maxElements) {
          truncated = true;
          return;
        }
        entries.push({ element: current, insideOpenShadowRoot: inShadow });
        if (current.shadowRoot) {
          openShadowRootsCount += 1;
          visitRoot(current.shadowRoot, true);
          if (truncated) {
            return;
          }
        }
      }
      current = walker.nextNode() as Element | null;
    }
  };

  const rootEl = rootDoc.documentElement as Element | null;
  if (rootEl) {
    entries.push({ element: rootEl, insideOpenShadowRoot: false });
    visitRoot(rootEl, false);
  }

  return { entries, openShadowRootsCount, truncated };
}

export function inspectFramesAndStylesheets(doc: Document): FrameAndStylesheetReport {
  let sameOriginFramesCount = 0;
  const inaccessibleCrossOriginFrames: string[] = [];

  const iframes = Array.from(doc.querySelectorAll('iframe'));
  for (const frame of iframes) {
    if (isPageSiftElement(frame)) {
      continue;
    }
    const src = frame.getAttribute('src') ?? 'about:blank';
    try {
      const contentDoc = frame.contentDocument;
      if (contentDoc && contentDoc.location.href.length >= 0) {
        sameOriginFramesCount += 1;
      } else {
        inaccessibleCrossOriginFrames.push(src);
      }
    } catch {
      inaccessibleCrossOriginFrames.push(src);
    }
  }

  let accessibleStylesheetsCount = 0;
  const inaccessibleStylesheets: string[] = [];

  const sheets = Array.from(doc.styleSheets);
  for (const sheet of sheets) {
    try {
      if (sheet.cssRules.length >= 0) {
        accessibleStylesheetsCount += 1;
      }
    } catch {
      inaccessibleStylesheets.push(sheet.href ?? 'inline-or-opaque-stylesheet');
    }
  }

  const { openShadowRootsCount } = collectDocumentElements(doc, 500);

  return {
    sameOriginFramesCount,
    inaccessibleCrossOriginFrames,
    accessibleStylesheetsCount,
    inaccessibleStylesheets,
    openShadowRootsCount,
  };
}

export function buildShortSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(el.id)) {
    return `${tag}#${el.id}`;
  }
  const classes = Array.from(el.classList)
    .filter((c) => /^[A-Za-z0-9_-]+$/.test(c))
    .slice(0, 2);
  if (classes.length > 0) {
    return `${tag}.${classes.join('.')}`;
  }
  return tag;
}

export function sanitizeElementHtml(el: Element, maxLength = 8000): string {
  const clone = el.cloneNode(true) as Element;

  const removeNodes = clone.querySelectorAll(
    'script, noscript, object, embed, applet, [data-pagesift-root]',
  );
  for (const node of Array.from(removeNodes)) {
    node.remove();
  }

  const allElements = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (const node of allElements) {
    const attrs = Array.from(node.attributes);
    for (const attr of attrs) {
      const nameLower = attr.name.toLowerCase();
      const valTrimmed = attr.value.trim().toLowerCase();
      if (nameLower.startsWith('on')) {
        node.removeAttribute(attr.name);
        continue;
      }
      if (
        (nameLower === 'href' ||
          nameLower === 'src' ||
          nameLower === 'action' ||
          nameLower === 'formaction' ||
          nameLower === 'xlink:href') &&
        (valTrimmed.startsWith('javascript:') ||
          valTrimmed.startsWith('vbscript:') ||
          valTrimmed.startsWith('data:text/html'))
      ) {
        node.removeAttribute(attr.name);
        continue;
      }
    }

    const tagLower = node.tagName.toLowerCase();
    if (tagLower === 'input') {
      const inputType = (node.getAttribute('type') ?? 'text').toLowerCase();
      if (
        inputType === 'password' ||
        inputType === 'hidden' ||
        inputType === 'email' ||
        inputType === 'tel' ||
        inputType === 'text' ||
        inputType === 'search' ||
        inputType === 'number'
      ) {
        node.removeAttribute('value');
        (node as HTMLInputElement).value = '';
      }
    } else if (tagLower === 'textarea') {
      node.textContent = '';
      (node as HTMLTextAreaElement).value = '';
    }
  }

  const serialized = clone.outerHTML;
  return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}...` : serialized;
}

export function parsePixelValue(cssValue: string): number {
  const parsed = Number.parseFloat(cssValue);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
}
