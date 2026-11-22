export type ThemePreference = 'system' | 'light' | 'dark';

const THEME_CACHE_KEY = 'pagesift_ui_theme_v1';

export function readCachedTheme(): ThemePreference {
  try {
    const val = window.localStorage.getItem(THEME_CACHE_KEY);
    if (val === 'light' || val === 'dark' || val === 'system') {
      return val;
    }
  } catch {
    return 'dark';
  }
  return 'dark';
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
  user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  sun: [
    'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    'M12 2v2',
    'M12 20v2',
    'M4.93 4.93l1.41 1.41',
    'M17.66 17.66l1.41 1.41',
    'M2 12h2',
    'M20 12h2',
    'M6.34 17.66l-1.41 1.41',
    'M19.07 4.93l-1.41 1.41',
  ],
  moon: ['M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z'],
  grid: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M14 14h7v7h-7z', 'M3 14h7v7H3z'],
  rotate: ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6'],
  smartphone: [
    'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z',
    'M12 18h.01',
  ],
  tablet: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M12 17h.01'],
  monitor: [
    'M3 4h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
    'M8 21h8',
    'M12 17v4',
  ],
  close: ['M18 6L6 18', 'M6 6l12 12'],
  minus: ['M5 12h14'],
  external: [
    'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
    'M15 3h6v6',
    'M10 14L21 3',
  ],
};

export function triggerTapFeedback(target: EventTarget | null): void {
  const ownerWin = (
    target as { ownerDocument?: { defaultView?: { HTMLElement?: typeof HTMLElement } } } | null
  )?.ownerDocument?.defaultView;
  const HtmlElCtor =
    ownerWin?.HTMLElement ?? (typeof HTMLElement !== 'undefined' ? HTMLElement : null);
  if (!HtmlElCtor || !(target instanceof HtmlElCtor)) {
    return;
  }
  const btn = target.closest('button, .btn-link');
  if (!btn || !(btn instanceof HtmlElCtor) || (btn as HTMLButtonElement).disabled) {
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

const TECH_GLYPH_PATHS: Record<string, { paths: string[]; color: string }> = {
  nextjs: { paths: ['M6 18V6l12 12', 'M18 6v7'], color: 'currentColor' },
  react: {
    paths: [
      'M12 12m-1.8 0a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0 -3.6 0',
      'M3.5 12c0-2.5 3.8-4.5 8.5-4.5s8.5 2 8.5 4.5-3.8 4.5-8.5 4.5-8.5-2-8.5-4.5z',
      'M7.8 4.6c2.2-1.2 5.6 1.1 7.9 5.2s2.4 8.3.2 9.6-5.6-1.1-7.9-5.2-2.4-8.3-.2-9.6z',
    ],
    color: '#38BDF8',
  },
  vue: { paths: ['M3 5l9 15L21 5', 'M7.5 5L12 12.5 16.5 5'], color: '#10B981' },
  nuxt: { paths: ['M3 18l6-11 6 11H3z', 'M11 18l5-8 5 8H11z'], color: '#10B981' },
  angular: {
    paths: ['M12 3l8 3.5-1.4 10L12 21l-6.6-4.5L4 6.5 12 3z', 'M9 15l3-7 3 7'],
    color: '#EF4444',
  },
  svelte: {
    paths: [
      'M15 5c2.2 1 3 3.4 1.8 5.2L9.5 16.5c-1.8 1.2-4 .2-4-2',
      'M9 19c-2.2-1-3-3.4-1.8-5.2l7.3-6.3',
    ],
    color: '#F97316',
  },
  astro: {
    paths: ['M7 18l5-13 5 13', 'M9.5 13h5', 'M12 18c-1.5 1.8-1 3 0 3s1.5-1.2 0-3z'],
    color: '#A855F7',
  },
  tailwind: {
    paths: [
      'M6 10c1.3-2.7 3.3-4 6-4 4 0 4.5 3 6.5 3.5 1.3.3 2.5-.2 3.5-1.5-1.3 2.7-3.3 4-6 4-4 0-4.5-3-6.5-3.5C8.2 8.2 7 8.7 6 10z',
      'M3 16c1.3-2.7 3.3-4 6-4 4 0 4.5 3 6.5 3.5 1.3.3 2.5-.2 3.5-1.5-1.3 2.7-3.3 4-6 4-4 0-4.5-3-6.5-3.5C5.2 14.2 4 14.7 3 16z',
    ],
    color: '#0EA5E9',
  },
  vite: { paths: ['M4 5l8 15L20 5l-8 3-8-3z', 'M11 9l2 4 3-3'], color: '#EAB308' },
  webpack: {
    paths: ['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z', 'M12 3v18', 'M4 7.5l8 4.5 8-4.5'],
    color: '#60A5FA',
  },
  bootstrap: {
    paths: ['M6 5h7a3 3 0 0 1 0 6H6V5z', 'M6 11h8a3 3 0 0 1 0 6H6v-6z'],
    color: '#8B5CF6',
  },
  cloudflare: {
    paths: ['M6.5 17H18a3.5 3.5 0 0 0 .5-7A5 5 0 0 0 8.5 8.5 4 4 0 0 0 6.5 17z'],
    color: '#F97316',
  },
  vercel: { paths: ['M12 4l9 16H3L12 4z'], color: 'currentColor' },
  netlify: { paths: ['M12 3l9 9-9 9-9-9 9-9z', 'M8 12h8'], color: '#14B8A6' },
  stripe: {
    paths: [
      'M16.5 8.5c-1.2-.8-2.8-1.2-4.3-1.2-2.2 0-3.7 1-3.7 2.6 0 3 7.5 1.7 7.5 5 0 1.8-1.7 3-4.3 3-1.8 0-3.6-.5-4.7-1.3',
    ],
    color: '#6366F1',
  },
  shopify: { paths: ['M6 8l1-4h10l1 4v12H6V8z', 'M9 8V6a3 3 0 0 1 6 0v2'], color: '#22C55E' },
  wordpress: {
    paths: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M7 9l3.2 9 2.3-6.5L15 18l2.5-8'],
    color: '#38BDF8',
  },
  google: {
    paths: ['M4 19h4v-7H4v7z', 'M10 19h4V9h-4v10z', 'M16 19h4V5h-4v14z'],
    color: '#F59E0B',
  },
  sentry: { paths: ['M12 4a8 8 0 0 1 8 8v5h-3v-5a5 5 0 0 0-5-5V4z', 'M6 17h6'], color: '#EC4899' },
  typescript: {
    paths: [
      'M4 4h16v16H4V4z',
      'M7 10h6',
      'M10 10v7',
      'M15 17c1.8 0 2.5-.8 2.5-2s-2.5-1.5-2.5-3 1-2 2.5-2',
    ],
    color: '#3B82F6',
  },
  framer: { paths: ['M6 4h12v6h-6l6 6H6v-6h6L6 4z', 'M6 16h6v5l-6-5z'], color: '#0EA5E9' },
  rolldown: { paths: ['M4 7h12', 'M4 12h16l-4 5', 'M4 17h8'], color: '#F97316' },
  opengraph: {
    paths: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M2 12h20', 'M12 2a15 15 0 0 1 0 20'],
    color: '#38BDF8',
  },
  priorityhints: { paths: ['M13 2L4 14h7l-1 8 9-12h-7l1-8z'], color: '#F59E0B' },
  http3: {
    paths: ['M4 8l8-4 8 4v8l-8 4-8-4V8z', 'M9 12h6', 'M12 9v6'],
    color: '#10B981',
  },
  schema: { paths: ['M7 8l-4 4 4 4', 'M17 8l4 4-4 4', 'M14 5l-4 14'], color: '#A855F7' },
  pwa: {
    paths: ['M3 16l4-10 4 10', 'M5 13h4', 'M13 6l2.5 10L18 6l2.5 10L22 6'],
    color: '#6366F1',
  },
  lucide: {
    paths: ['M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3z'],
    color: '#F43F5E',
  },
  gsap: { paths: ['M12 4a8 8 0 1 0 8 8h-8'], color: '#22C55E' },
};

const CATEGORY_ICON_MAP: Record<string, string> = {
  framework: 'tech_stack',
  css_library: 'colors',
  ui_kit: 'grid',
  cms_or_platform: 'folder',
  build_tool: 'settings',
  analytics_or_monitoring: 'sparkles',
  web_standards: 'tools',
};

function resolveTechGlyphKey(technology: string): string | null {
  const norm = technology.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (norm.includes('nextjs')) return 'nextjs';
  if (norm.includes('react')) return 'react';
  if (norm.includes('nuxt')) return 'nuxt';
  if (norm.includes('vue')) return 'vue';
  if (norm.includes('angular')) return 'angular';
  if (norm.includes('svelte')) return 'svelte';
  if (norm.includes('astro')) return 'astro';
  if (norm.includes('tailwind')) return 'tailwind';
  if (norm.includes('rolldown')) return 'rolldown';
  if (norm.includes('vite')) return 'vite';
  if (norm.includes('webpack')) return 'webpack';
  if (norm.includes('bootstrap')) return 'bootstrap';
  if (norm.includes('cloudflare')) return 'cloudflare';
  if (norm.includes('vercel')) return 'vercel';
  if (norm.includes('netlify')) return 'netlify';
  if (norm.includes('stripe')) return 'stripe';
  if (norm.includes('shopify')) return 'shopify';
  if (norm.includes('wordpress')) return 'wordpress';
  if (norm.includes('framer')) return 'framer';
  if (norm.includes('opengraph')) return 'opengraph';
  if (norm.includes('priorityhints')) return 'priorityhints';
  if (norm.includes('http3') || norm.includes('http2')) return 'http3';
  if (norm.includes('schema') || norm.includes('jsonld') || norm.includes('twitter'))
    return 'schema';
  if (norm.includes('pwa') || norm.includes('manifest')) return 'pwa';
  if (norm.includes('lucide')) return 'lucide';
  if (norm.includes('gsap')) return 'gsap';
  if (norm.includes('google')) return 'google';
  if (norm.includes('sentry') || norm.includes('posthog') || norm.includes('plausible'))
    return 'sentry';
  if (norm.includes('typescript')) return 'typescript';
  return null;
}

export function createTechCategoryIcon(
  category: string,
  ownerDocument: Document | undefined = typeof document !== 'undefined' ? document : undefined,
): SVGSVGElement {
  const iconName = CATEGORY_ICON_MAP[category] ?? 'tech_stack';
  return createSvgIcon(iconName, 'tech-cat-icon', ownerDocument);
}

export function createTechIconElement(
  technology: string,
  ownerDocument: Document | undefined = typeof document !== 'undefined' ? document : undefined,
): HTMLElement {
  if (!ownerDocument) {
    throw new Error('No document available to create tech badge');
  }
  const box = ownerDocument.createElement('span');
  box.className = 'tech-badge-icon';
  box.setAttribute('aria-hidden', 'true');
  const glyphKey = resolveTechGlyphKey(technology);
  if (glyphKey && TECH_GLYPH_PATHS[glyphKey]) {
    const def = TECH_GLYPH_PATHS[glyphKey];
    const svg = ownerDocument.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', def.color);
    svg.setAttribute('stroke-width', '1.9');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.style.width = '14px';
    svg.style.height = '14px';
    for (const d of def.paths) {
      const p = ownerDocument.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    box.appendChild(svg);
    return box;
  }

  const words = technology
    .trim()
    .split(/[\s./-]+/)
    .filter(Boolean);
  const letters =
    words.length >= 2
      ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase()
      : technology.slice(0, 2).toUpperCase();
  const mono = ownerDocument.createElement('span');
  mono.textContent = letters || 'JS';
  mono.style.fontSize = '10px';
  mono.style.fontWeight = '700';
  mono.style.letterSpacing = '0.02em';
  mono.style.fontFamily = 'var(--font-mono, ui-monospace, monospace)';
  box.appendChild(mono);
  return box;
}
