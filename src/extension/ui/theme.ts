export type ThemePreference = 'system' | 'light' | 'dark';

const THEME_CACHE_KEY = 'pagesift_ui_theme_v1';

export function readCachedTheme(): ThemePreference {
  try {
    const val = window.localStorage.getItem(THEME_CACHE_KEY);
    if (val === 'light' || val === 'dark' || val === 'system') {
      return val;
    }
  } catch {
    return 'light';
  }
  return 'light';
}

export function writeCachedTheme(pref: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, pref);
  } catch {
    return;
  }
}

export function resolveEffectiveTheme(pref: ThemePreference): 'light' | 'dark' {
  if (pref === 'light' || pref === 'dark') {
    return pref;
  }
  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  ) {
    return 'dark';
  }
  return 'light';
}

export function applyThemePreference(pref: ThemePreference): 'light' | 'dark' {
  const effective = resolveEffectiveTheme(pref);
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', effective);
    document.documentElement.setAttribute('data-theme-pref', pref);
  }
  writeCachedTheme(pref);
  return effective;
}

export function nextThemePreference(current: ThemePreference): ThemePreference {
  if (current === 'system') {
    return 'dark';
  }
  if (current === 'dark') {
    return 'light';
  }
  return 'system';
}

export function formatThemeLabel(pref: ThemePreference): string {
  if (pref === 'dark') {
    return 'Dark';
  }
  if (pref === 'light') {
    return 'Light';
  }
  return 'System';
}

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_PATHS: Record<string, string[]> = {
  inspect: [
    'M4 4h6v2H6v4H4V4z',
    'M20 4h-6v2h4v4h2V4z',
    'M4 20h6v-2H6v-4H4v6z',
    'M20 20h-6v-2h4v-4h2v6z',
    'M12 9v6',
    'M9 12h6',
  ],
  clone_page: ['M8 4h10a2 2 0 0 1 2 2v10', 'M4 8h10a2 2 0 0 1 2 2v10H6a2 2 0 0 1-2-2V8z'],
  clone_prompt: ['M5 6h14', 'M5 10h10', 'M5 14h14', 'M5 18h8'],
  design_md: [
    'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5z',
    'M8 8h8',
    'M8 12h5',
    'M8 16h8',
  ],
  assets: [
    'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z',
    'M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    'M21 15l-5-5L5 20',
  ],
  colors: [
    'M12 3a9 9 0 1 0 0 18 2.5 2.5 0 0 0 2.5-2.5c0-.6-.2-1.1-.6-1.5-.4-.4-.6-.9-.6-1.5A2.5 2.5 0 0 1 15.8 13H18a3 3 0 0 0 3-3c0-3.9-4-7-9-7z',
  ],
  fonts: ['M4 6V4h16v2', 'M12 4v16', 'M9 20h6'],
  measure: ['M3 15l12-12 6 6-12 12H3v-6z', 'M11 7l2 2', 'M8 10l2 2'],
  edit_text: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z'],
  capture: [
    'M4 7h3l2-2h6l2 2h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z',
    'M12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  ],
  responsive: [
    'M3 5h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
    'M18 9h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-3',
  ],
  swap_font: ['M7 7h10l-3-3', 'M17 17H7l3 3', 'M10 12h4'],
  arrange: [
    'M5 9l-3 3 3 3',
    'M9 5l3-3 3 3',
    'M15 19l-3 3-3-3',
    'M19 9l3 3-3 3',
    'M2 12h20',
    'M12 2v20',
  ],
  design_review: ['M9 11l3 3L22 4', 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11'],
  tech_stack: ['M12 3l9 4.5-9 4.5-9-4.5L12 3z', 'M3 12l9 4.5 9-4.5', 'M3 16.5L12 21l9-4.5'],
  download: ['M12 3v12', 'M7 10l5 5 5-5', 'M4 20h16'],
  copy: ['M9 9h10v10H9z', 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  history: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5', 'M12 7v5l3 2'],
  folder: ['M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M4 12h2', 'M18 12h2', 'M12 4v2', 'M12 18v2'],
  sidebar: ['M4 4h16v16H4V4z', 'M9 4v16'],
  tools: ['M4 6h7', 'M4 12h16', 'M4 18h11'],
  sparkles: ['M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3z'],
};

export function triggerTapFeedback(target: EventTarget | null): void {
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const btn = target.closest('button, .btn-link');
  if (!(btn instanceof HTMLElement) || (btn as HTMLButtonElement).disabled) {
    return;
  }
  btn.classList.remove('tap-confirm');
  void btn.getBoundingClientRect();
  btn.classList.add('tap-confirm');
}

export function bindGlobalTapFeedback(root: Document | ShadowRoot = document): void {
  root.addEventListener(
    'click',
    (ev) => {
      triggerTapFeedback(ev.target);
    },
    true,
  );
}

export function createSvgIcon(
  name: string,
  className = 'icon',
  ownerDocument: Document | undefined = typeof document !== 'undefined' ? document : undefined,
): SVGSVGElement {
  if (!ownerDocument) {
    throw new Error('No document available to create SVG icon');
  }
  const svg = ownerDocument.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);

  const paths = ICON_PATHS[name] ?? ICON_PATHS['inspect'] ?? [];
  for (const d of paths) {
    const p = ownerDocument.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}
