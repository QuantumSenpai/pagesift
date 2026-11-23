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
  motion_lab: ['M2 12h3l2-5 4 10 3-8 2 3h6'],
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

interface TechSvgNode {
  tag: 'path' | 'circle' | 'rect' | 'polygon' | 'ellipse' | 'line';
  attrs: Record<string, string>;
}

interface TechBrandLogoDef {
  viewBox?: string;
  nodes: TechSvgNode[];
}

const TECH_GLYPH_PATHS: Record<string, TechBrandLogoDef> = {
  nextjs: {
    nodes: [
      {
        tag: 'circle',
        attrs: {
          cx: '12',
          cy: '12',
          r: '10',
          fill: '#111827',
          stroke: '#4B5563',
          'stroke-width': '1',
        },
      },
      {
        tag: 'path',
        attrs: {
          d: 'M8.5 16.5V7.5L17 18.8',
          stroke: '#F9FAFB',
          'stroke-width': '1.8',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        },
      },
      {
        tag: 'line',
        attrs: {
          x1: '15.5',
          y1: '7.5',
          x2: '15.5',
          y2: '13.2',
          stroke: '#F9FAFB',
          'stroke-width': '1.8',
          'stroke-linecap': 'round',
        },
      },
    ],
  },
  react: {
    nodes: [
      { tag: 'circle', attrs: { cx: '12', cy: '12', r: '2.1', fill: '#61DAFB' } },
      {
        tag: 'ellipse',
        attrs: {
          cx: '12',
          cy: '12',
          rx: '10',
          ry: '4',
          fill: 'none',
          stroke: '#61DAFB',
          'stroke-width': '1.45',
        },
      },
      {
        tag: 'ellipse',
        attrs: {
          cx: '12',
          cy: '12',
          rx: '10',
          ry: '4',
          fill: 'none',
          stroke: '#61DAFB',
          'stroke-width': '1.45',
          transform: 'rotate(60 12 12)',
        },
      },
      {
        tag: 'ellipse',
        attrs: {
          cx: '12',
          cy: '12',
          rx: '10',
          ry: '4',
          fill: 'none',
          stroke: '#61DAFB',
          'stroke-width': '1.45',
          transform: 'rotate(120 12 12)',
        },
      },
    ],
  },
  vue: {
    nodes: [
      { tag: 'polygon', attrs: { points: '2,4 12,21 22,4 18,4 12,14.2 6,4', fill: '#41B883' } },
      {
        tag: 'polygon',
        attrs: { points: '6,4 12,14.2 18,4 14.5,4 12,8.4 9.5,4', fill: '#35495E' },
      },
    ],
  },
  nuxt: {
    nodes: [
      {
        tag: 'path',
        attrs: { d: 'M2.5 18.5L9.2 6.8a1.2 1.2 0 0 1 2.1 0L18 18.5H2.5z', fill: '#00DC82' },
      },
      {
        tag: 'path',
        attrs: { d: 'M10.5 18.5L15.4 10a1.1 1.1 0 0 1 1.9 0l4.7 8.5h-11.5z', fill: '#009E5E' },
      },
    ],
  },
  angular: {
    nodes: [
      {
        tag: 'polygon',
        attrs: { points: '12,2 21,5.2 19.6,17 12,21.5 4.4,17 3,5.2', fill: '#DD0031' },
      },
      { tag: 'polygon', attrs: { points: '12,2 21,5.2 19.6,17 12,21.5', fill: '#C3002F' } },
      {
        tag: 'path',
        attrs: {
          d: 'M12 6.2L7.2 16.5h1.9l1-2.3h3.8l1 2.3h1.9L12 6.2zm1.2 6.3h-2.4L12 9.4l1.2 3.1z',
          fill: '#FFFFFF',
        },
      },
    ],
  },
  svelte: {
    nodes: [
      {
        tag: 'path',
        attrs: {
          d: 'M18.6 4.8C16.8 2.3 13.3 1.7 10.7 3.3L6.2 6.1A5.2 5.2 0 0 0 4 12.1a5.4 5.4 0 0 0 .3 4.6c1.8 2.5 5.3 3.1 7.9 1.5l4.5-2.8a5.2 5.2 0 0 0 2.2-6 5.4 5.4 0 0 0-.3-4.6z',
          fill: '#FF3E00',
        },
      },
      {
        tag: 'path',
        attrs: {
          d: 'M10.5 15.8c-1.4.8-3.1.2-3.7-1.1a2.7 2.7 0 0 1 .9-3.3l4.2-2.6c1.4-.8 3.1-.2 3.7 1.1',
          fill: 'none',
          stroke: '#FFFFFF',
          'stroke-width': '1.8',
          'stroke-linecap': 'round',
        },
      },
    ],
  },
  astro: {
    nodes: [
      {
        tag: 'path',
        attrs: {
          d: 'M8.5 3.5h7l3.5 11.2c-2-.9-4.1-1.3-7-1.3s-5 .4-7 1.3L8.5 3.5zm3.5 4l-1.5 4.4h3L12 7.5z',
          fill: '#FFFFFF',
        },
      },
      {
        tag: 'path',
        attrs: { d: 'M12 14.5c2 2.2 1.8 5.2 0 6.8-1.8-1.6-2-4.6 0-6.8z', fill: '#FF5D01' },
      },
    ],
  },
  tailwind: {
    nodes: [
      {
        tag: 'path',
        attrs: {
          d: 'M12 6C8.8 6 6.8 7.6 6 10.8c1.2-1.6 2.6-2.2 4.2-1.8.9.2 1.6.9 2.3 1.6 1.2 1.2 2.5 2.6 5.5 2.6 3.2 0 5.2-1.6 6-4.8-1.2 1.6-2.6 2.2-4.2 1.8-.9-.2-1.6-.9-2.3-1.6C16.3 7.4 15 6 12 6zM6 13.2C2.8 13.2.8 14.8 0 18c1.2-1.6 2.6-2.2 4.2-1.8.9.2 1.6.9 2.3 1.6 1.2 1.2 2.5 2.6 5.5 2.6 3.2 0 5.2-1.6 6-4.8-1.2 1.6-2.6 2.2-4.2 1.8-.9-.2-1.6-.9-2.3-1.6-1.2-1.2-2.5-2.6-5.5-2.6z',
          fill: '#38BDF8',
        },
      },
    ],
  },
  vite: {
    nodes: [
      { tag: 'polygon', attrs: { points: '21.5,4.2 12.2,21 2.5,4.2 12,6.2', fill: '#41D1FF' } },
      {
        tag: 'polygon',
        attrs: {
          points: '16.5,2.5 10.2,3.8 9.2,12.2 12.5,11.3 11.4,17.2 17.5,7.2 13.6,8.1',
          fill: '#FFD028',
        },
      },
    ],
  },
  webpack: {
    nodes: [
      {
        tag: 'polygon',
        attrs: { points: '12,2.2 20.5,7.1 20.5,16.9 12,21.8 3.5,16.9 3.5,7.1', fill: '#8DD6F9' },
      },
      {
        tag: 'polygon',
        attrs: { points: '12,6.5 16.8,9.2 16.8,14.8 12,17.5 7.2,14.8 7.2,9.2', fill: '#1C78C0' },
      },
      {
        tag: 'path',
        attrs: {
          d: 'M12 2.2V6.5M12 17.5V21.8M3.5 7.1L7.2 9.2M16.8 14.8l3.7 2.1M20.5 7.1L16.8 9.2M7.2 14.8l-3.7 2.1',
          stroke: '#FFFFFF',
          'stroke-width': '1.1',
        },
      },
    ],
  },
  bootstrap: {
    nodes: [
      {
        tag: 'rect',
        attrs: { x: '2.5', y: '3.5', width: '19', height: '17', rx: '4', fill: '#7952B3' },
      },
      {
        tag: 'path',
        attrs: {
          d: 'M9 7h4.2c1.8 0 3 .9 3 2.4 0 1-.6 1.8-1.6 2.1 1.2.3 2 1.2 2 2.4 0 1.7-1.3 2.7-3.4 2.7H9V7zm2 4h2c.9 0 1.4-.4 1.4-1.2s-.5-1.2-1.4-1.2h-2V11zm0 4h2.2c1 0 1.6-.4 1.6-1.3 0-.8-.6-1.3-1.6-1.3H11V15z',
          fill: '#FFFFFF',
        },
      },
    ],
  },
  cloudflare: {
    nodes: [
      {
        tag: 'path',
        attrs: {
          d: 'M16.9 16.5H6.4a3.2 3.2 0 0 1-.4-6.3 4.8 4.8 0 0 1 9.1-1.3 3.4 3.4 0 0 1 1.8 7.6z',
          fill: '#F38020',
        },
      },
      {
        tag: 'path',
        attrs: {
          d: 'M18.2 16.5h2.2a2.1 2.1 0 0 0 0-4.2h-.6a3 3 0 0 0-3-2.5c-.6 0-1.1.2-1.5.5',
          fill: '#FAAE40',
        },
      },
    ],
  },
  vercel: {
    nodes: [{ tag: 'polygon', attrs: { points: '12,3.5 21.5,19.5 2.5,19.5', fill: '#F9FAFB' } }],
  },
  netlify: {
    nodes: [
      { tag: 'polygon', attrs: { points: '12,2.2 21.8,12 12,21.8 2.2,12', fill: '#00C7B7' } },
      {
        tag: 'path',
        attrs: {
          d: 'M7.5 12h9M12 7.5v9M8.8 8.8l6.4 6.4',
          stroke: '#0F172A',
          'stroke-width': '1.6',
          'stroke-linecap': 'round',
        },
      },
    ],
  },
  stripe: {
    nodes: [
      {
        tag: 'rect',
        attrs: { x: '3', y: '3', width: '18', height: '18', rx: '4', fill: '#635BFF' },
      },
      {
        tag: 'path',
        attrs: {
          d: 'M15.4 9.1c-1-.5-2-.7-3-.7-1.8 0-3.1.8-3.1 2.3 0 2.5 5.4 1.6 5.4 3.8 0 .9-.8 1.4-2 1.4-1.3 0-2.6-.5-3.6-1.1v2.2c1 .5 2.3.8 3.6.8 2.3 0 3.9-1 3.9-2.8 0-2.7-5.4-1.8-5.4-3.8 0-.7.7-1.1 1.7-1.1 1.1 0 2.2.3 3.1.8V9.1h-.6z',
          fill: '#FFFFFF',
        },
      },
    ],
  },
  shopify: {
    nodes: [
      { tag: 'polygon', attrs: { points: '6.5,7.2 17.5,7.2 19,20.5 5,20.5', fill: '#95BF47' } },
      {
        tag: 'path',
        attrs: {
          d: 'M9.2 7.2V5.8a2.8 2.8 0 0 1 5.6 0v1.4',
          fill: 'none',
          stroke: '#95BF47',
          'stroke-width': '1.8',
        },
      },
      {
        tag: 'path',
        attrs: {
          d: 'M13.8 11.4c-.5-.2-1-.3-1.6-.3-1 0-1.6.5-1.6 1.2 0 1.4 3 1 3 2.5 0 .9-.8 1.5-2 1.5-.8 0-1.5-.2-2-.5',
          fill: 'none',
          stroke: '#FFFFFF',
          'stroke-width': '1.6',
          'stroke-linecap': 'round',
        },
      },
    ],
  },
  wordpress: {
    nodes: [
      { tag: 'circle', attrs: { cx: '12', cy: '12', r: '9.5', fill: '#21759B' } },
      {
        tag: 'path',
        attrs: {
          d: 'M6.2 8.2l3.4 9.2 2.4-6.4 2.4 6.4 3.4-9.2',
          fill: 'none',
          stroke: '#FFFFFF',
          'stroke-width': '1.7',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        },
      },
    ],
  },
  googleTagManager: {
    nodes: [
      { tag: 'polygon', attrs: { points: '12,2.5 15.2,5.7 5.7,15.2 2.5,12', fill: '#8AB4F8' } },
      { tag: 'polygon', attrs: { points: '12,2.5 21.5,12 18.3,15.2 8.8,5.7', fill: '#4285F4' } },
      { tag: 'polygon', attrs: { points: '18.3,8.8 21.5,12 12,21.5 8.8,18.3', fill: '#246FDB' } },
      { tag: 'circle', attrs: { cx: '12', cy: '18.3', r: '2.1', fill: '#8AB4F8' } },
    ],
  },
  googleAnalytics: {
    nodes: [
      {
        tag: 'rect',
        attrs: { x: '15.5', y: '3.5', width: '4.5', height: '17', rx: '2.2', fill: '#E37400' },
      },
      {
        tag: 'rect',
        attrs: { x: '9.8', y: '9.5', width: '4.4', height: '11', rx: '2.2', fill: '#F9AB00' },
      },
      { tag: 'circle', attrs: { cx: '6.2', cy: '18.2', r: '2.3', fill: '#F9AB00' } },
    ],
  },
  googleFonts: {
    nodes: [
      { tag: 'path', attrs: { d: 'M12.5 5h6v3h-6z', fill: '#EA4335' } },
      {
        tag: 'path',
        attrs: { d: 'M10.2 5L4.5 19h3.4l2.1-5.4h5.5v-3H11.2l1.6-4.2L10.2 5z', fill: '#4285F4' },
      },
      { tag: 'circle', attrs: { cx: '17.2', cy: '16.8', r: '2.5', fill: '#34A853' } },
    ],
  },
  sentry: {
    nodes: [
      {
        tag: 'path',
        attrs: {
          d: 'M13.5 4.2a1.7 1.7 0 0 0-3 0L3.3 16.8a1.7 1.7 0 0 0 1.5 2.5h3.5v-2.1H6.2l5.8-10.1 2.2 3.8a5.8 5.8 0 0 1 .9 6.3h2.4a8 8 0 0 0-1.3-7.6L13.5 4.2z',
          fill: '#FB4226',
        },
      },
    ],
  },
  typescript: {
    nodes: [
      {
        tag: 'rect',
        attrs: { x: '2.5', y: '2.5', width: '19', height: '19', rx: '3.2', fill: '#3178C6' },
      },
      {
        tag: 'path',
        attrs: {
          d: 'M6 11h6M9 11v7.5M14.2 17.5c.8.5 1.8.8 2.8.8 1.5 0 2.5-.8 2.5-2 0-1.3-.9-1.8-2.3-2.3-1-.4-1.5-.7-1.5-1.3s.5-1 1.4-1c.7 0 1.4.2 2 .5',
          fill: 'none',
          stroke: '#FFFFFF',
          'stroke-width': '1.8',
          'stroke-linecap': 'round',
        },
      },
    ],
  },
  framer: {
    nodes: [
      { tag: 'polygon', attrs: { points: '5,3 19,3 19,9.5 12,9.5', fill: '#00AAFF' } },
      { tag: 'polygon', attrs: { points: '5,9.5 12,9.5 19,16 5,16', fill: '#0055FF' } },
      { tag: 'polygon', attrs: { points: '5,16 12,16 12,21.5', fill: '#0033CC' } },
    ],
  },
  framerMotion: {
    nodes: [
      { tag: 'polygon', attrs: { points: '3.5,4.5 9.5,11 3.5,18.5', fill: '#FFF312' } },
      { tag: 'polygon', attrs: { points: '12,12 18,4.5 18,18.5', fill: '#FF0088' } },
      { tag: 'polygon', attrs: { points: '9.5,11 12,14 14.5,11 12,8', fill: '#0099FF' } },
    ],
  },
  rolldown: {
    nodes: [
      {
        tag: 'path',
        attrs: {
          d: 'M5 6h14l-3 3.5H8.5A1.5 1.5 0 0 0 8.5 12.5H16l-3 3.5H7.5a3 3 0 0 1 0-6H5V6z',
          fill: '#FF5500',
        },
      },
      { tag: 'polygon', attrs: { points: '12,16 19,16 14.5,20.5', fill: '#FB923C' } },
    ],
  },
  opengraph: {
    nodes: [
      {
        tag: 'circle',
        attrs: {
          cx: '12',
          cy: '12',
          r: '9.2',
          fill: '#1E3A8A',
          stroke: '#38BDF8',
          'stroke-width': '1.6',
        },
      },
      {
        tag: 'ellipse',
        attrs: {
          cx: '12',
          cy: '12',
          rx: '4.2',
          ry: '9.2',
          fill: 'none',
          stroke: '#7DD3FC',
          'stroke-width': '1.4',
        },
      },
      {
        tag: 'line',
        attrs: {
          x1: '3.2',
          y1: '12',
          x2: '20.8',
          y2: '12',
          stroke: '#7DD3FC',
          'stroke-width': '1.4',
        },
      },
    ],
  },
  priorityhints: {
    nodes: [
      {
        tag: 'polygon',
        attrs: { points: '13.5,2 4.5,13.5 11.2,13.5 10,22 19.5,10 12.8,10', fill: '#F59E0B' },
      },
    ],
  },
  http3: {
    nodes: [
      {
        tag: 'polygon',
        attrs: { points: '12,2.5 20.5,7.2 20.5,16.8 12,21.5 3.5,16.8 3.5,7.2', fill: '#059669' },
      },
      { tag: 'path', attrs: { d: 'M8 9.2h8v2.1H13.1v4.5H11v-4.5H8V9.2z', fill: '#ECFDF5' } },
    ],
  },
  schema: {
    nodes: [
      {
        tag: 'rect',
        attrs: { x: '2.5', y: '3.5', width: '19', height: '17', rx: '3.5', fill: '#6D28D9' },
      },
      {
        tag: 'path',
        attrs: {
          d: 'M8.5 8.5L5.2 12l3.3 3.5M15.5 8.5l3.3 3.5-3.3 3.5M13.2 7.5l-2.4 9',
          fill: 'none',
          stroke: '#F3E8FF',
          'stroke-width': '1.8',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        },
      },
    ],
  },
  pwa: {
    nodes: [
      {
        tag: 'rect',
        attrs: { x: '2', y: '5', width: '20', height: '14', rx: '3', fill: '#4F46E5' },
      },
      {
        tag: 'path',
        attrs: {
          d: 'M5.5 15V9h2.2a1.8 1.8 0 0 1 0 3.6H5.5M11.5 9l1.2 6 1.3-4.5L15.3 15l1.2-6',
          fill: 'none',
          stroke: '#FFFFFF',
          'stroke-width': '1.6',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        },
      },
    ],
  },
  lucide: {
    nodes: [
      { tag: 'circle', attrs: { cx: '12', cy: '12', r: '9.2', fill: '#F43F5E' } },
      {
        tag: 'polygon',
        attrs: {
          points: '12,5.5 13.8,10.2 18.5,12 13.8,13.8 12,18.5 10.2,13.8 5.5,12 10.2,10.2',
          fill: '#FFFFFF',
        },
      },
    ],
  },
  gsap: {
    nodes: [
      { tag: 'circle', attrs: { cx: '12', cy: '12', r: '9.2', fill: '#15803D' } },
      {
        tag: 'path',
        attrs: {
          d: 'M15.8 9.2A5 5 0 1 0 16.5 14h-4.5v-1.8h6.4v2.6',
          fill: 'none',
          stroke: '#88CE02',
          'stroke-width': '2',
          'stroke-linecap': 'round',
        },
      },
    ],
  },
  webflow: {
    nodes: [
      {
        tag: 'rect',
        attrs: { x: '2.5', y: '3.5', width: '19', height: '17', rx: '3.5', fill: '#146EF5' },
      },
      {
        tag: 'path',
        attrs: {
          d: 'M17.5 8.5l-2.6 7-1.9-4.5-2.6 4.5H7.2l2.1-7h2.4l-1.1 3.9 2.3-3.9h2.2l1.2 4 1.3-4h1.9z',
          fill: '#FFFFFF',
        },
      },
    ],
  },
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
  if (norm.includes('webflow')) return 'webflow';
  if (norm.includes('framermotion')) return 'framerMotion';
  if (norm.includes('framer')) return 'framer';
  if (norm.includes('googletagmanager') || norm.includes('tagmanager')) return 'googleTagManager';
  if (norm.includes('googleanalytics') || norm.includes('ga4')) return 'googleAnalytics';
  if (norm.includes('googlefonts')) return 'googleFonts';
  if (norm.includes('opengraph')) return 'opengraph';
  if (norm.includes('priorityhints')) return 'priorityhints';
  if (norm.includes('http3') || norm.includes('http2')) return 'http3';
  if (norm.includes('schema') || norm.includes('jsonld') || norm.includes('twitter'))
    return 'schema';
  if (norm.includes('pwa') || norm.includes('manifest')) return 'pwa';
  if (norm.includes('lucide')) return 'lucide';
  if (norm.includes('gsap')) return 'gsap';
  if (norm.includes('google')) return 'googleAnalytics';
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
    svg.setAttribute('viewBox', def.viewBox ?? '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.style.width = '16px';
    svg.style.height = '16px';
    for (const nodeSpec of def.nodes) {
      const node = ownerDocument.createElementNS(SVG_NS, nodeSpec.tag);
      for (const [attr, val] of Object.entries(nodeSpec.attrs)) {
        node.setAttribute(attr, val);
      }
      svg.appendChild(node);
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
