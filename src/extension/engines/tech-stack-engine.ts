export type TechCategory =
  | 'framework'
  | 'css_library'
  | 'ui_kit'
  | 'build_tool'
  | 'cms_or_platform'
  | 'analytics_or_monitoring';

export interface TechStackDetectionEntry {
  technology: string;
  category: TechCategory;
  evidence: string[];
  confidence: 'high' | 'medium' | 'low';
  uncertaintyNote: string;
}

export interface TechStackReport {
  detections: TechStackDetectionEntry[];
  methodologyDisclosure: string;
}

interface DetectorRule {
  technology: string;
  category: TechCategory;
  uncertaintyNote: string;
  evaluate: (ctx: {
    doc: Document;
    scriptUrls: string[];
    stylesheetUrls: string[];
    metaGenerator: string;
    classSample: string;
  }) => string[];
}

const DETECTOR_RULES: DetectorRule[] = [
  {
    technology: 'Next.js',
    category: 'framework',
    uncertaintyNote: 'App Router pages without #__next are detected via /_next/ asset paths.',
    evaluate: ({ doc, scriptUrls, stylesheetUrls }) => {
      const ev: string[] = [];
      if (doc.getElementById('__next')) {
        ev.push('DOM root element #__next present');
      }
      if (doc.querySelector('script#__NEXT_DATA__')) {
        ev.push('Inline script#__NEXT_DATA__ payload present');
      }
      if (
        scriptUrls.some((u) => u.includes('/_next/')) ||
        stylesheetUrls.some((u) => u.includes('/_next/'))
      ) {
        ev.push('Asset URLs served from /_next/ path prefix');
      }
      return ev;
    },
  },
  {
    technology: 'React',
    category: 'framework',
    uncertaintyNote: 'Production builds without data-reactroot may bundle React silently.',
    evaluate: ({ doc, scriptUrls }) => {
      const ev: string[] = [];
      if (doc.querySelector('[data-reactroot], [data-reactid]')) {
        ev.push('DOM attribute data-reactroot / data-reactid present');
      }
      if (doc.getElementById('__next')) {
        ev.push('Next.js root container implies React runtime');
      }
      if (scriptUrls.some((u) => /react(\.production\.min|-dom)?\.js/i.test(u))) {
        ev.push('Script URL references react / react-dom bundle');
      }
      return ev;
    },
  },
  {
    technology: 'Vue.js',
    category: 'framework',
    uncertaintyNote:
      'Unscoped Vue templates without data-v-* attributes may not expose DOM markers.',
    evaluate: ({ doc, scriptUrls }) => {
      const ev: string[] = [];
      const all = Array.from(doc.querySelectorAll('*')).slice(0, 300);
      const hasScopedAttr = all.some((el) =>
        Array.from(el.attributes).some((a) => /^data-v-[a-f0-9]+$/i.test(a.name)),
      );
      if (hasScopedAttr) {
        ev.push('Vue scoped CSS data-v-* attributes present on DOM elements');
      }
      if (doc.getElementById('__nuxt')) {
        ev.push('DOM root #__nuxt container present');
      }
      if (scriptUrls.some((u) => /vue(\.runtime|\.global)?(\.prod)?\.js/i.test(u))) {
        ev.push('Script URL references Vue runtime bundle');
      }
      return ev;
    },
  },
  {
    technology: 'Nuxt',
    category: 'framework',
    uncertaintyNote:
      'Static Nuxt exports without #__nuxt or /_nuxt/ paths may appear as plain Vue.',
    evaluate: ({ doc, scriptUrls }) => {
      const ev: string[] = [];
      if (doc.getElementById('__nuxt')) {
        ev.push('DOM root element #__nuxt present');
      }
      if (scriptUrls.some((u) => u.includes('/_nuxt/'))) {
        ev.push('Script URLs served from /_nuxt/ directory');
      }
      return ev;
    },
  },
  {
    technology: 'Svelte',
    category: 'framework',
    uncertaintyNote: 'Compiled Svelte components without scoped styles may omit svelte-* classes.',
    evaluate: ({ classSample }) => {
      const ev: string[] = [];
      if (/\bsvelte-[a-z0-9]{5,}\b/i.test(classSample)) {
        ev.push('Svelte compiler-generated svelte-<hash> class names present');
      }
      return ev;
    },
  },
  {
    technology: 'Astro',
    category: 'framework',
    uncertaintyNote: 'Zero-JS Astro pages without islands may omit <astro-island> elements.',
    evaluate: ({ doc, metaGenerator }) => {
      const ev: string[] = [];
      if (doc.querySelector('astro-island')) {
        ev.push('Custom element <astro-island> hydration boundary present');
      }
      if (metaGenerator.toLowerCase().includes('astro')) {
        ev.push(`<meta name="generator"> declares "${metaGenerator}"`);
      }
      return ev;
    },
  },
  {
    technology: 'Tailwind CSS',
    category: 'css_library',
    uncertaintyNote:
      'Custom-prefixed or CSS-module-compiled Tailwind utilities may not match standard utility names.',
    evaluate: ({ doc, classSample }) => {
      const ev: string[] = [];
      const tailwindUtilityHits = [
        /\bflex\b/,
        /\bgrid-cols-\d+\b/,
        /\bjustify-between\b/,
        /\bitems-center\b/,
        /\bpx-\d+\b/,
        /\bpy-\d+\b/,
        /\brounded-(?:sm|md|lg|xl|2xl|full)\b/,
        /\btext-(?:xs|sm|base|lg|xl|2xl|slate|gray|zinc|blue)-\d*\b/,
      ].filter((rx) => rx.test(classSample));

      if (tailwindUtilityHits.length >= 3) {
        ev.push(
          `Matched ${tailwindUtilityHits.length} characteristic Tailwind utility class patterns in DOM`,
        );
      }

      for (const sheet of Array.from(doc.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules).slice(0, 80)) {
            if (rule.cssText.includes('--tw-')) {
              ev.push('Accessible stylesheet defines --tw-* CSS custom properties');
              break;
            }
          }
        } catch {
          continue;
        }
      }
      return ev;
    },
  },
  {
    technology: 'Bootstrap',
    category: 'css_library',
    uncertaintyNote: 'Subsetted Bootstrap builds may only include grid classes.',
    evaluate: ({ stylesheetUrls, classSample }) => {
      const ev: string[] = [];
      if (stylesheetUrls.some((u) => /bootstrap(\.min)?\.css/i.test(u))) {
        ev.push('Stylesheet URL references bootstrap.css');
      }
      if (
        /\bcontainer(-fluid)?\b/.test(classSample) &&
        /\bcol-(?:sm|md|lg|xl)-\d+\b/.test(classSample)
      ) {
        ev.push('Bootstrap grid classes (.container / .col-md-*) detected');
      }
      return ev;
    },
  },
  {
    technology: 'Radix UI / shadcn',
    category: 'ui_kit',
    uncertaintyNote:
      'Detection relies on data-radix-* or radix state attributes on rendered primitives.',
    evaluate: ({ doc }) => {
      const ev: string[] = [];
      if (
        doc.querySelector(
          '[data-radix-collection-item], [data-radix-popper-content-wrapper], [data-radix-scroll-area-viewport]',
        )
      ) {
        ev.push('DOM contains data-radix-* primitive attributes');
      }
      return ev;
    },
  },
  {
    technology: 'WordPress',
    category: 'cms_or_platform',
    uncertaintyNote: 'Headless WordPress frontends do not expose /wp-content/ paths.',
    evaluate: ({ scriptUrls, stylesheetUrls, metaGenerator }) => {
      const ev: string[] = [];
      if (metaGenerator.toLowerCase().includes('wordpress')) {
        ev.push(`<meta name="generator"> declares "${metaGenerator}"`);
      }
      if (
        scriptUrls.some((u) => u.includes('/wp-content/') || u.includes('/wp-includes/')) ||
        stylesheetUrls.some((u) => u.includes('/wp-content/'))
      ) {
        ev.push('Asset URLs reference /wp-content/ or /wp-includes/');
      }
      return ev;
    },
  },
  {
    technology: 'Shopify',
    category: 'cms_or_platform',
    uncertaintyNote: 'Custom Hydrogen storefronts may omit cdn.shopify.com script paths.',
    evaluate: ({ scriptUrls, stylesheetUrls }) => {
      const ev: string[] = [];
      if (
        scriptUrls.some((u) => u.includes('cdn.shopify.com')) ||
        stylesheetUrls.some((u) => u.includes('cdn.shopify.com'))
      ) {
        ev.push('Assets loaded from cdn.shopify.com');
      }
      return ev;
    },
  },
  {
    technology: 'Webflow',
    category: 'cms_or_platform',
    uncertaintyNote: 'Exported Webflow static HTML may have data-wf-site stripped manually.',
    evaluate: ({ doc }) => {
      const ev: string[] = [];
      if (
        doc.documentElement.hasAttribute('data-wf-site') ||
        doc.documentElement.hasAttribute('data-wf-page')
      ) {
        ev.push('<html> element carries data-wf-site / data-wf-page attributes');
      }
      return ev;
    },
  },
];

export function detectPageTechStack(doc: Document): TechStackReport {
  const scriptUrls = Array.from(doc.querySelectorAll('script[src]'))
    .map((s) => s.getAttribute('src') ?? '')
    .filter((u) => u.length > 0);
  const stylesheetUrls = Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'))
    .map((l) => l.getAttribute('href') ?? '')
    .filter((u) => u.length > 0);
  const metaGenerator =
    doc.querySelector('meta[name="generator" i]')?.getAttribute('content')?.trim() ?? '';

  const classListSample: string[] = [];
  for (const el of Array.from(doc.querySelectorAll('[class]')).slice(0, 400)) {
    const cls = el.getAttribute('class');
    if (cls) {
      classListSample.push(cls);
    }
  }
  const classSample = classListSample.join(' ');

  const detections: TechStackDetectionEntry[] = [];
  for (const rule of DETECTOR_RULES) {
    const evidence = rule.evaluate({
      doc,
      scriptUrls,
      stylesheetUrls,
      metaGenerator,
      classSample,
    });
    if (evidence.length > 0) {
      detections.push({
        technology: rule.technology,
        category: rule.category,
        evidence,
        confidence: evidence.length >= 2 ? 'high' : 'medium',
        uncertaintyNote: rule.uncertaintyNote,
      });
    }
  }

  return {
    detections,
    methodologyDisclosure:
      'Tech stack detection inspects public client-side DOM markers, script/stylesheet URLs, and meta tags only. Server-side runtimes, private headers, and stripped build markers cannot be observed; absence of a marker does not prove absence of a technology.',
  };
}
