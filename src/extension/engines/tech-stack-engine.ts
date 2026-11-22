export type TechCategory =
  | 'framework'
  | 'css_library'
  | 'ui_kit'
  | 'build_tool'
  | 'cms_or_platform'
  | 'analytics_or_monitoring'
  | 'web_standards';

export interface TechStackDetectionEntry {
  technology: string;
  category: TechCategory;
  shortReason: string;
  evidence: string[];
  confidence: 'high' | 'medium' | 'low';
  uncertaintyNote: string;
}

export interface TechStackOrganizedGroup {
  category: TechCategory;
  label: string;
  items: Array<{
    technology: string;
    confidence: 'high' | 'medium' | 'low';
    shortReason: string;
  }>;
}

export interface TechStackOrganizedSummary {
  totalDetected: number;
  oneLiner: string;
  groups: TechStackOrganizedGroup[];
}

export interface TechStackReport {
  detections: TechStackDetectionEntry[];
  organizedSummary: TechStackOrganizedSummary;
  methodologyDisclosure: string;
}

interface DetectorContext {
  doc: Document;
  win?: Window | undefined;
  scriptUrls: string[];
  stylesheetUrls: string[];
  modulepreloadUrls: string[];
  allResourceUrls: string[];
  performanceProtocols: string[];
  inlineScriptSample: string;
  cssCustomPropNames: string[];
  metaGenerator: string;
  htmlAttrNames: string[];
  classSample: string;
  winGlobals: Set<string>;
}

interface DetectorRule {
  technology: string;
  category: TechCategory;
  shortReason: string;
  uncertaintyNote: string;
  implies?: string[];
  evaluate: (ctx: DetectorContext) => string[];
}

const CATEGORY_ORDER: Array<{ category: TechCategory; label: string }> = [
  { category: 'framework', label: 'Frameworks & Runtimes' },
  { category: 'css_library', label: 'Styling & CSS' },
  { category: 'ui_kit', label: 'UI Libraries & Motion' },
  { category: 'cms_or_platform', label: 'Platform, CMS & Commerce' },
  { category: 'build_tool', label: 'Build & Bundlers' },
  { category: 'analytics_or_monitoring', label: 'Analytics, Payments & Infra' },
  { category: 'web_standards', label: 'Web Standards, SEO & Protocols' },
];

const DETECTOR_RULES: DetectorRule[] = [
  {
    technology: 'Next.js',
    category: 'framework',
    shortReason: 'App / Pages router runtime markers',
    uncertaintyNote: 'App Router pages without #__next are detected via /_next/ asset paths.',
    implies: ['React'],
    evaluate: ({ doc, allResourceUrls, inlineScriptSample, winGlobals }) => {
      const ev: string[] = [];
      if (doc.getElementById('__next')) {
        ev.push('DOM root #__next present');
      }
      if (doc.querySelector('script#__NEXT_DATA__') || winGlobals.has('__NEXT_DATA__')) {
        ev.push('__NEXT_DATA__ hydration state present');
      }
      if (allResourceUrls.some((u) => u.includes('/_next/'))) {
        ev.push('Assets served from /_next/ prefix');
      }
      if (inlineScriptSample.includes('__next_f')) {
        ev.push('React Server Component flight payload (__next_f)');
      }
      return ev;
    },
  },
  {
    technology: 'React',
    category: 'framework',
    shortReason: 'React runtime / ESM chunk or root markers',
    uncertaintyNote: 'Production bundles with mangled module names rely on framework implications.',
    evaluate: ({ doc, allResourceUrls, inlineScriptSample, winGlobals }) => {
      const ev: string[] = [];
      if (doc.querySelector('[data-reactroot], [data-reactid]')) {
        ev.push('data-reactroot / data-reactid attribute present');
      }
      if (doc.getElementById('__next') || doc.getElementById('___gatsby')) {
        ev.push('React framework mount container detected');
      }
      const reactRes = allResourceUrls.find((u) =>
        /(?:^|\/)react(?:[-.](?:dom|production|development))?(?:\.[a-z0-9_-]+)?\.(?:m?js|cjs)(?:$|\?)/i.test(
          u,
        ),
      );
      if (reactRes) {
        ev.push(`Module/script bundle references React (${reactRes.split('/').pop() ?? 'react'})`);
      }
      if (
        inlineScriptSample.includes('__reactContainer') ||
        inlineScriptSample.includes('__NEXT_DATA__') ||
        winGlobals.has('React')
      ) {
        ev.push('React runtime initialization signature');
      }
      return ev;
    },
  },
  {
    technology: 'Remix / React Router',
    category: 'framework',
    shortReason: 'Remix hydration / build path',
    uncertaintyNote:
      'Bundled Remix apps without window.__remixContext may resemble React SPA builds.',
    implies: ['React'],
    evaluate: ({ inlineScriptSample, allResourceUrls, winGlobals }) => {
      const ev: string[] = [];
      if (
        inlineScriptSample.includes('__remixContext') ||
        inlineScriptSample.includes('__remixManifest') ||
        winGlobals.has('__remixContext')
      ) {
        ev.push('Remix client hydration context detected');
      }
      if (allResourceUrls.some((u) => /\/build\/_shared\/|\/assets\/root-/i.test(u))) {
        ev.push('Remix asset path signature');
      }
      return ev;
    },
  },
  {
    technology: 'Gatsby',
    category: 'framework',
    shortReason: 'Gatsby mount container or generator',
    uncertaintyNote: 'Removed ___gatsby IDs hide static Gatsby output.',
    implies: ['React'],
    evaluate: ({ doc, metaGenerator }) => {
      const ev: string[] = [];
      if (doc.getElementById('___gatsby')) {
        ev.push('DOM mount #___gatsby present');
      }
      if (metaGenerator.toLowerCase().includes('gatsby')) {
        ev.push(`<meta name="generator"> declares "${metaGenerator}"`);
      }
      return ev;
    },
  },
  {
    technology: 'Vue.js',
    category: 'framework',
    shortReason: 'Scoped data-v-* attributes or Vue bundle',
    uncertaintyNote: 'Unscoped Vue templates without data-v-* attributes may omit DOM markers.',
    evaluate: ({ doc, scriptUrls }) => {
      const ev: string[] = [];
      const all = Array.from(doc.querySelectorAll('*')).slice(0, 300);
      const hasScopedAttr = all.some((el) =>
        Array.from(el.attributes).some((a) => /^data-v-[a-f0-9]+$/i.test(a.name)),
      );
      if (hasScopedAttr) {
        ev.push('Vue scoped CSS data-v-* attributes present');
      }
      if (doc.getElementById('__nuxt')) {
        ev.push('Nuxt mount container (#__nuxt) implies Vue');
      }
      if (scriptUrls.some((u) => /vue(?:\.runtime|\.global)?(?:\.prod)?\.js/i.test(u))) {
        ev.push('Script references Vue runtime');
      }
      return ev;
    },
  },
  {
    technology: 'Nuxt',
    category: 'framework',
    shortReason: '#__nuxt root or /_nuxt/ bundles',
    uncertaintyNote: 'Static Nuxt exports without #__nuxt or /_nuxt/ may appear as plain Vue.',
    evaluate: ({ doc, allResourceUrls, inlineScriptSample }) => {
      const ev: string[] = [];
      if (doc.getElementById('__nuxt') || doc.getElementById('__NUXT_DATA__')) {
        ev.push('DOM root #__nuxt / #__NUXT_DATA__ present');
      }
      if (allResourceUrls.some((u) => u.includes('/_nuxt/'))) {
        ev.push('Resources served from /_nuxt/');
      }
      if (inlineScriptSample.includes('__NUXT__')) {
        ev.push('Nuxt hydration payload (__NUXT__)');
      }
      return ev;
    },
  },
  {
    technology: 'Angular',
    category: 'framework',
    shortReason: 'ng-version or _ngcontent attributes',
    uncertaintyNote: 'Production Angular apps without ng-version may omit host attributes.',
    evaluate: ({ doc, scriptUrls }) => {
      const ev: string[] = [];
      const versioned = doc.querySelector('[ng-version]');
      if (versioned) {
        ev.push(`ng-version="${versioned.getAttribute('ng-version') ?? 'present'}" attribute`);
      }
      const all = Array.from(doc.querySelectorAll('*')).slice(0, 200);
      if (
        all.some((el) => Array.from(el.attributes).some((a) => /^_ng(host|content)-/i.test(a.name)))
      ) {
        ev.push('Angular emulated encapsulation _nghost/_ngcontent attributes');
      }
      if (scriptUrls.some((u) => /angular|@angular\/core/i.test(u))) {
        ev.push('Angular script bundle URL');
      }
      return ev;
    },
  },
  {
    technology: 'Svelte / SvelteKit',
    category: 'framework',
    shortReason: 'svelte-* scoped classes or _app/immutable',
    uncertaintyNote: 'Unscoped compiled Svelte components may omit svelte-* hashes.',
    evaluate: ({ classSample, allResourceUrls, inlineScriptSample }) => {
      const ev: string[] = [];
      if (/\bsvelte-[a-z0-9]{5,}\b/i.test(classSample)) {
        ev.push('Compiler svelte-<hash> class names present');
      }
      if (allResourceUrls.some((u) => u.includes('/_app/immutable/'))) {
        ev.push('SvelteKit /_app/immutable/ asset prefix');
      }
      if (inlineScriptSample.includes('__sveltekit_')) {
        ev.push('SvelteKit boot signature (__sveltekit_)');
      }
      return ev;
    },
  },
  {
    technology: 'Astro',
    category: 'framework',
    shortReason: 'Astro islands, _astro paths, or meta generator',
    uncertaintyNote: 'Zero-JS Astro pages without islands may omit <astro-island> elements.',
    evaluate: ({ doc, allResourceUrls, metaGenerator }) => {
      const ev: string[] = [];
      if (doc.querySelector('astro-island, astro-slot')) {
        ev.push('<astro-island> hydration boundary present');
      }
      if (allResourceUrls.some((u) => u.includes('/_astro/'))) {
        ev.push('Assets served from /_astro/ directory');
      }
      if (metaGenerator.toLowerCase().includes('astro')) {
        ev.push(`meta generator "${metaGenerator}"`);
      }
      return ev;
    },
  },
  {
    technology: 'SolidJS / SolidStart',
    category: 'framework',
    shortReason: '_$hk hydration key markers',
    uncertaintyNote: 'Client-only Solid bundles strip SSR hydration keys.',
    evaluate: ({ doc, inlineScriptSample }) => {
      const ev: string[] = [];
      if (doc.querySelector('[data-hk]')) {
        ev.push('Solid SSR hydration attributes (data-hk)');
      }
      if (inlineScriptSample.includes('_$HY')) {
        ev.push('Solid hydration runtime (_$HY)');
      }
      return ev;
    },
  },
  {
    technology: 'Qwik',
    category: 'framework',
    shortReason: 'q:container / q:version resumability attributes',
    uncertaintyNote: 'Static fragments outside q:container omit Qwik attributes.',
    evaluate: ({ doc, scriptUrls }) => {
      const ev: string[] = [];
      if (doc.querySelector('[q\\:container], [q\\:version], [q\\:id]')) {
        ev.push('Qwik resumability attributes (q:container / q:id)');
      }
      if (scriptUrls.some((u) => /qwikloader/i.test(u))) {
        ev.push('qwikloader script detected');
      }
      return ev;
    },
  },
  {
    technology: 'Alpine.js',
    category: 'framework',
    shortReason: 'x-data / x-bind / x-show reactive directives',
    uncertaintyNote: 'Only active DOM nodes carrying x-data / x-on directives can be detected.',
    evaluate: ({ doc, scriptUrls }) => {
      const ev: string[] = [];
      if (doc.querySelector('[x-data]')) {
        ev.push('Alpine.js x-data directive attributes present');
      }
      if (scriptUrls.some((u) => /alpinejs|alpine(\.min)?\.js/i.test(u))) {
        ev.push('Alpine.js script URL');
      }
      return ev;
    },
  },
  {
    technology: 'htmx',
    category: 'framework',
    shortReason: 'hx-get / hx-post / hx-swap attributes',
    uncertaintyNote: 'Pages without active hx-* attributes will not trigger detection.',
    evaluate: ({ doc, scriptUrls }) => {
      const ev: string[] = [];
      if (doc.querySelector('[hx-get], [hx-post], [hx-trigger], [hx-swap]')) {
        ev.push('DOM carries htmx hx-* attributes');
      }
      if (scriptUrls.some((u) => /htmx(?:\.min)?\.js/i.test(u))) {
        ev.push('htmx script reference');
      }
      return ev;
    },
  },
  {
    technology: 'jQuery',
    category: 'framework',
    shortReason: 'jQuery script asset reference',
    uncertaintyNote: 'Bundled private jQuery chunks may not include jquery in script URLs.',
    evaluate: ({ scriptUrls }) => {
      const ev: string[] = [];
      if (scriptUrls.some((u) => /jquery(?:-\d[\d.]*)?(?:\.min)?\.js/i.test(u))) {
        ev.push('Script URL references jquery');
      }
      return ev;
    },
  },
  {
    technology: 'Tailwind CSS',
    category: 'css_library',
    shortReason: 'Utility class patterns & --tw-* variables',
    uncertaintyNote: 'Custom-prefixed Tailwind builds may not match default utility names.',
    evaluate: ({ classSample, cssCustomPropNames }) => {
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
        ev.push(`${tailwindUtilityHits.length} Tailwind utility patterns matched in DOM`);
      }
      if (cssCustomPropNames.some((n) => n.startsWith('--tw-'))) {
        ev.push('--tw-* CSS custom properties defined');
      }
      return ev;
    },
  },
  {
    technology: 'Bootstrap',
    category: 'css_library',
    shortReason: 'Bootstrap stylesheet or grid / --bs-* tokens',
    uncertaintyNote: 'Subsetted Bootstrap builds may only include grid classes.',
    evaluate: ({ stylesheetUrls, classSample, cssCustomPropNames }) => {
      const ev: string[] = [];
      if (stylesheetUrls.some((u) => /bootstrap(?:\.min)?\.css/i.test(u))) {
        ev.push('Stylesheet URL references bootstrap.css');
      }
      if (
        /\bcontainer(?:-fluid)?\b/.test(classSample) &&
        /\bcol-(?:sm|md|lg|xl)-\d+\b/.test(classSample)
      ) {
        ev.push('Bootstrap .container / .col-* grid classes');
      }
      if (cssCustomPropNames.some((n) => n.startsWith('--bs-'))) {
        ev.push('--bs-* Bootstrap 5 CSS custom properties');
      }
      return ev;
    },
  },
  {
    technology: 'UnoCSS',
    category: 'css_library',
    shortReason: '--un-* CSS variables or unocss markers',
    uncertaintyNote: 'Preset-only UnoCSS without --un-* vars can resemble plain utility CSS.',
    evaluate: ({ cssCustomPropNames }) => {
      const ev: string[] = [];
      if (cssCustomPropNames.some((n) => n.startsWith('--un-'))) {
        ev.push('--un-* UnoCSS custom properties defined');
      }
      return ev;
    },
  },
  {
    technology: 'Emotion / Styled Components',
    category: 'css_library',
    shortReason: 'CSS-in-JS style injection attributes',
    uncertaintyNote: 'Zero-runtime extracted builds omit data-emotion / data-styled tags.',
    evaluate: ({ doc, classSample }) => {
      const ev: string[] = [];
      if (doc.querySelector('style[data-emotion]')) {
        ev.push('style[data-emotion] CSS-in-JS tag');
      }
      if (doc.querySelector('style[data-styled], style[data-styled-version]')) {
        ev.push('style[data-styled] Styled Components sheet');
      }
      if (/\bcss-[a-z0-9]{6,}\b/.test(classSample)) {
        ev.push('Hashed css-<hash> Emotion class pattern');
      }
      return ev;
    },
  },
  {
    technology: 'Radix UI / shadcn',
    category: 'ui_kit',
    shortReason: 'data-radix-* headless primitive markers',
    uncertaintyNote: 'Pages with no open Radix primitives may omit portal/collection attributes.',
    evaluate: ({ doc }) => {
      const ev: string[] = [];
      if (
        doc.querySelector(
          '[data-radix-collection-item], [data-radix-popper-content-wrapper], [data-radix-scroll-area-viewport], [data-slot]',
        )
      ) {
        ev.push('DOM contains data-radix-* / data-slot primitive attributes');
      }
      return ev;
    },
  },
  {
    technology: 'Material UI (MUI)',
    category: 'ui_kit',
    shortReason: 'Mui* class prefixes & --mui-* tokens',
    uncertaintyNote: 'Custom styled themes overriding Mui prefixes reduce visibility.',
    evaluate: ({ classSample, cssCustomPropNames }) => {
      const ev: string[] = [];
      if (/\bMui[A-Z][A-Za-z0-9-]+\b/.test(classSample)) {
        ev.push('Material UI .Mui* component classes present');
      }
      if (cssCustomPropNames.some((n) => n.startsWith('--mui-'))) {
        ev.push('--mui-* CSS variables present');
      }
      return ev;
    },
  },
  {
    technology: 'Chakra UI',
    category: 'ui_kit',
    shortReason: 'chakra-* class names & --chakra-* tokens',
    uncertaintyNote: 'v3 Panda/Ark-based Chakra builds may not emit chakra-* class prefixes.',
    evaluate: ({ classSample, cssCustomPropNames }) => {
      const ev: string[] = [];
      if (/\bchakra-[a-z0-9-]+\b/.test(classSample)) {
        ev.push('Chakra UI .chakra-* class names present');
      }
      if (cssCustomPropNames.some((n) => n.startsWith('--chakra-'))) {
        ev.push('--chakra-* CSS custom properties');
      }
      return ev;
    },
  },
  {
    technology: 'Mantine',
    category: 'ui_kit',
    shortReason: 'mantine-* classes & --mantine-* CSS vars',
    uncertaintyNote: 'Custom class prefix configs alter .mantine-* identifiers.',
    evaluate: ({ classSample, cssCustomPropNames }) => {
      const ev: string[] = [];
      if (/\bmantine-[A-Za-z0-9-]+\b/.test(classSample)) {
        ev.push('Mantine .mantine-* class names present');
      }
      if (cssCustomPropNames.some((n) => n.startsWith('--mantine-'))) {
        ev.push('--mantine-* CSS custom properties');
      }
      return ev;
    },
  },
  {
    technology: 'Ant Design',
    category: 'ui_kit',
    shortReason: 'ant-* component classes',
    uncertaintyNote: 'Custom ConfigProvider prefixCls renames .ant-* selectors.',
    evaluate: ({ classSample }) => {
      const ev: string[] = [];
      if (/\bant-(?:btn|card|layout|menu|input|table|row|col)\b/.test(classSample)) {
        ev.push('Ant Design .ant-* component classes detected');
      }
      return ev;
    },
  },
  {
    technology: 'Framer Motion / Motion',
    category: 'ui_kit',
    shortReason: 'Motion ESM modules or projection attributes',
    uncertaintyNote: 'Static motion elements without module hints look like standard DOM.',
    evaluate: ({ doc, allResourceUrls }) => {
      const ev: string[] = [];
      if (doc.querySelector('[data-projection-id], [data-framer-appear-animation]')) {
        ev.push('Motion DOM attributes ([data-projection-id] / appear animation)');
      }
      const motionRes = allResourceUrls.find((u) =>
        /(?:^|\/)(?:framer-)?motion(?:\.[a-z0-9_-]+)?\.(?:m?js|js)(?:$|\?)/i.test(u),
      );
      if (motionRes) {
        ev.push(`Motion ESM bundle loaded (${motionRes.split('/').pop() ?? 'motion'})`);
      }
      return ev;
    },
  },
  {
    technology: 'Lucide Icons',
    category: 'ui_kit',
    shortReason: 'Lucide SVG icon class or package reference',
    uncertaintyNote: 'Inlined Lucide paths without class="lucide" are generic SVGs.',
    evaluate: ({ doc, allResourceUrls }) => {
      const ev: string[] = [];
      if (doc.querySelector('svg.lucide, [class*="lucide-"]')) {
        ev.push('DOM contains svg.lucide icon elements');
      }
      if (allResourceUrls.some((u) => /lucide(?:-react|-vue)?/i.test(u))) {
        ev.push('Lucide script/CDN asset referenced');
      }
      return ev;
    },
  },
  {
    technology: 'GSAP',
    category: 'ui_kit',
    shortReason: 'GSAP script bundle reference',
    uncertaintyNote: 'Private bundled GSAP imports may not expose script URL names.',
    evaluate: ({ allResourceUrls }) => {
      const ev: string[] = [];
      if (
        allResourceUrls.some((u) => /\bgsap(?:\.min)?\.m?js|ScrollTrigger(?:\.min)?\.m?js/i.test(u))
      ) {
        ev.push('GSAP / ScrollTrigger script URL present');
      }
      return ev;
    },
  },
  {
    technology: 'Framer',
    category: 'cms_or_platform',
    shortReason: 'Framer Sites meta generator, CDN & hydration markers',
    uncertaintyNote: 'Custom proxied Framer builds may mask framerusercontent URLs.',
    implies: ['React', 'Framer Motion / Motion'],
    evaluate: ({ doc, allResourceUrls, metaGenerator, classSample }) => {
      const ev: string[] = [];
      if (metaGenerator.toLowerCase().includes('framer')) {
        ev.push(`meta generator declares "${metaGenerator}"`);
      }
      if (
        allResourceUrls.some(
          (u) => u.includes('framerusercontent.com') || u.includes('events.framer.com'),
        )
      ) {
        ev.push('Resources loaded from framerusercontent.com / framer.com');
      }
      if (doc.querySelector('[data-framer-hydrate-v2], [data-framer-name]')) {
        ev.push('Framer hydration attributes ([data-framer-name] / hydrate-v2)');
      }
      if (/\bframer-[A-Za-z0-9]{4,}\b/.test(classSample)) {
        ev.push('Framer-generated .framer-* layout classes');
      }
      return ev;
    },
  },
  {
    technology: 'Webflow',
    category: 'cms_or_platform',
    shortReason: 'data-wf-site / webflow CDN signatures',
    uncertaintyNote: 'Exported Webflow static HTML may have data-wf-site stripped manually.',
    evaluate: ({ doc, allResourceUrls, metaGenerator }) => {
      const ev: string[] = [];
      if (
        doc.documentElement.hasAttribute('data-wf-site') ||
        doc.documentElement.hasAttribute('data-wf-page')
      ) {
        ev.push('<html> carries data-wf-site / data-wf-page');
      }
      if (
        allResourceUrls.some((u) => u.includes('website-files.com') || u.includes('webflow.js'))
      ) {
        ev.push('Webflow CDN asset / script references');
      }
      if (metaGenerator.toLowerCase().includes('webflow')) {
        ev.push(`meta generator declares "${metaGenerator}"`);
      }
      return ev;
    },
  },
  {
    technology: 'WordPress',
    category: 'cms_or_platform',
    shortReason: '/wp-content/ paths or WP generator',
    uncertaintyNote: 'Headless WordPress frontends do not expose /wp-content/ paths.',
    evaluate: ({ allResourceUrls, metaGenerator }) => {
      const ev: string[] = [];
      if (metaGenerator.toLowerCase().includes('wordpress')) {
        ev.push(`meta generator "${metaGenerator}"`);
      }
      if (allResourceUrls.some((u) => u.includes('/wp-content/') || u.includes('/wp-includes/'))) {
        ev.push('Assets loaded from /wp-content/ or /wp-includes/');
      }
      return ev;
    },
  },
  {
    technology: 'Shopify',
    category: 'cms_or_platform',
    shortReason: 'cdn.shopify.com assets or Shopify boot',
    uncertaintyNote: 'Custom Hydrogen storefronts may omit cdn.shopify.com script paths.',
    evaluate: ({ allResourceUrls, inlineScriptSample }) => {
      const ev: string[] = [];
      if (
        allResourceUrls.some((u) => u.includes('cdn.shopify.com') || u.includes('shopifycdn.net'))
      ) {
        ev.push('Assets loaded from Shopify CDN');
      }
      if (
        inlineScriptSample.includes('Shopify.theme') ||
        inlineScriptSample.includes('Shopify.shop')
      ) {
        ev.push('Inline Shopify storefront configuration detected');
      }
      return ev;
    },
  },
  {
    technology: 'Wix',
    category: 'cms_or_platform',
    shortReason: 'wixstatic.com CDN or Wix generator',
    uncertaintyNote: 'Custom CDN mirrors omit wixstatic.com asset hosts.',
    evaluate: ({ allResourceUrls, metaGenerator }) => {
      const ev: string[] = [];
      if (metaGenerator.toLowerCase().includes('wix')) {
        ev.push(`meta generator "${metaGenerator}"`);
      }
      if (
        allResourceUrls.some((u) => u.includes('wixstatic.com') || u.includes('parastorage.com'))
      ) {
        ev.push('Wix static asset CDN detected');
      }
      return ev;
    },
  },
  {
    technology: 'Squarespace',
    category: 'cms_or_platform',
    shortReason: 'squarespace-cdn assets or Static.SQUARESPACE_CONTEXT',
    uncertaintyNote: 'Self-hosted static exports lack Squarespace context scripts.',
    evaluate: ({ allResourceUrls, inlineScriptSample }) => {
      const ev: string[] = [];
      if (
        allResourceUrls.some(
          (u) => u.includes('squarespace.com') || u.includes('squarespace-cdn.com'),
        )
      ) {
        ev.push('Squarespace CDN resources');
      }
      if (inlineScriptSample.includes('SQUARESPACE_CONTEXT')) {
        ev.push('SQUARESPACE_CONTEXT script configuration');
      }
      return ev;
    },
  },
  {
    technology: 'Ghost',
    category: 'cms_or_platform',
    shortReason: 'Ghost generator meta or /ghost/ paths',
    uncertaintyNote: 'Headless Ghost API sites omit front-end Ghost meta tags.',
    evaluate: ({ metaGenerator, allResourceUrls }) => {
      const ev: string[] = [];
      if (metaGenerator.toLowerCase().includes('ghost')) {
        ev.push(`meta generator "${metaGenerator}"`);
      }
      if (allResourceUrls.some((u) => u.includes('ghost.io') || u.includes('/assets/built/'))) {
        ev.push('Ghost theme / CDN URL pattern');
      }
      return ev;
    },
  },
  {
    technology: 'Hugo / Jekyll',
    category: 'cms_or_platform',
    shortReason: 'Static site generator meta tag',
    uncertaintyNote: 'Only detectable when generator meta tag is kept in output HTML.',
    evaluate: ({ metaGenerator }) => {
      const ev: string[] = [];
      const low = metaGenerator.toLowerCase();
      if (low.includes('hugo') || low.includes('jekyll')) {
        ev.push(`meta generator "${metaGenerator}"`);
      }
      return ev;
    },
  },
  {
    technology: 'Rolldown',
    category: 'build_tool',
    shortReason: 'Rolldown ESM runtime bundle',
    uncertaintyNote: 'Only visible when rolldown runtime chunk filenames are retained.',
    evaluate: ({ allResourceUrls }) => {
      const ev: string[] = [];
      const hit = allResourceUrls.find((u) => /rolldown[-_.]/i.test(u));
      if (hit) {
        ev.push(`Rolldown bundler runtime chunk (${hit.split('/').pop() ?? 'rolldown'})`);
      }
      return ev;
    },
  },
  {
    technology: 'Vite',
    category: 'build_tool',
    shortReason: '/@vite/client or /assets/index-[hash] module pattern',
    uncertaintyNote: 'Custom Rollup output paths hide standard Vite filenames.',
    evaluate: ({ allResourceUrls, doc }) => {
      const ev: string[] = [];
      if (allResourceUrls.some((u) => u.includes('/@vite/client') || u.includes('/assets/'))) {
        if (doc.querySelector('script[type="module"][src*="/assets/"]')) {
          ev.push('Vite module bundle pattern (/assets/*.js)');
        } else if (allResourceUrls.some((u) => u.includes('/@vite/client'))) {
          ev.push('Vite dev client script');
        }
      }
      return ev;
    },
  },
  {
    technology: 'Webpack',
    category: 'build_tool',
    shortReason: 'webpackChunk runtime signature',
    uncertaintyNote: 'Renamed JSONP globals prevent detection.',
    evaluate: ({ inlineScriptSample, allResourceUrls }) => {
      const ev: string[] = [];
      if (
        inlineScriptSample.includes('webpackChunk') ||
        inlineScriptSample.includes('__webpack_require__')
      ) {
        ev.push('Webpack chunk loader runtime reference');
      }
      if (allResourceUrls.some((u) => /webpack[-.]runtime/i.test(u))) {
        ev.push('Webpack runtime asset filename');
      }
      return ev;
    },
  },
  {
    technology: 'Google Fonts',
    category: 'css_library',
    shortReason: 'fonts.googleapis.com / fonts.gstatic.com stylesheet or font',
    uncertaintyNote: 'Self-hosted variable fonts from Google Fonts omit googleapis.com hosts.',
    evaluate: ({ allResourceUrls }) => {
      const ev: string[] = [];
      if (
        allResourceUrls.some(
          (u) => u.includes('fonts.googleapis.com') || u.includes('fonts.gstatic.com'),
        )
      ) {
        ev.push('Font assets loaded from Google Fonts CDN');
      }
      return ev;
    },
  },
  {
    technology: 'Open Graph',
    category: 'web_standards',
    shortReason: 'Open Graph social metadata tags (og:*)',
    uncertaintyNote: 'Only pages declaring meta[property^="og:"] emit Open Graph metadata.',
    evaluate: ({ doc }) => {
      const tags = Array.from(doc.querySelectorAll('meta[property^="og:" i]'));
      if (tags.length === 0) {
        return [];
      }
      const props = tags
        .slice(0, 4)
        .map((t) => t.getAttribute('property') ?? '')
        .filter(Boolean)
        .join(', ');
      return [`Open Graph meta tags present (${props})`];
    },
  },
  {
    technology: 'Twitter Cards',
    category: 'web_standards',
    shortReason: 'Twitter Card meta tags (twitter:*)',
    uncertaintyNote: 'Relies on <meta name="twitter:*"> tags in document head.',
    evaluate: ({ doc }) => {
      const card = doc.querySelector('meta[name^="twitter:" i]');
      if (!card) {
        return [];
      }
      return [`Twitter card meta tag (${card.getAttribute('name') ?? 'twitter:card'})`];
    },
  },
  {
    technology: 'Schema.org / JSON-LD',
    category: 'web_standards',
    shortReason: 'Structured data script[type="application/ld+json"]',
    uncertaintyNote: 'Microdata-only pages without JSON-LD blocks are not counted.',
    evaluate: ({ doc }) => {
      const count = doc.querySelectorAll('script[type="application/ld+json" i]').length;
      return count > 0 ? [`${count} JSON-LD structured data block(s) in DOM`] : [];
    },
  },
  {
    technology: 'Priority Hints',
    category: 'web_standards',
    shortReason: 'Resource fetchpriority hint attributes',
    uncertaintyNote: 'Only visible when elements set fetchpriority="high|low|auto".',
    evaluate: ({ doc }) => {
      const hints = doc.querySelectorAll('[fetchpriority]');
      return hints.length > 0
        ? [`${hints.length} element(s) declare fetchpriority loading hints`]
        : [];
    },
  },
  {
    technology: 'PWA / Web App Manifest',
    category: 'web_standards',
    shortReason: 'link[rel="manifest"] web application manifest',
    uncertaintyNote: 'Manifest presence does not confirm active Service Worker caching.',
    evaluate: ({ doc }) => {
      const manifest = doc.querySelector('link[rel="manifest" i][href]');
      return manifest
        ? [`Web App Manifest linked (${manifest.getAttribute('href') ?? 'manifest.json'})`]
        : [];
    },
  },
  {
    technology: 'HTTP/3',
    category: 'web_standards',
    shortReason: 'Negotiated QUIC / h3 browser transport protocol',
    uncertaintyNote: 'Requires browser PerformanceNavigationTiming / resource timing access.',
    evaluate: ({ performanceProtocols }) => {
      const h3Count = performanceProtocols.filter((p) => /^h3/i.test(p)).length;
      return h3Count > 0
        ? [`Browser negotiated HTTP/3 (nextHopProtocol="h3") on ${h3Count} resource(s)`]
        : [];
    },
  },
  {
    technology: 'HTTP/2',
    category: 'web_standards',
    shortReason: 'Negotiated h2 multiplexed transport protocol',
    uncertaintyNote: 'Superseded when HTTP/3 is negotiated on the primary session.',
    evaluate: ({ performanceProtocols }) => {
      const hasH3 = performanceProtocols.some((p) => /^h3/i.test(p));
      const h2Count = performanceProtocols.filter((p) => p.toLowerCase() === 'h2').length;
      return !hasH3 && h2Count > 0
        ? [`Browser negotiated HTTP/2 (nextHopProtocol="h2") on ${h2Count} resource(s)`]
        : [];
    },
  },
  {
    technology: 'Google Tag Manager / GA4',
    category: 'analytics_or_monitoring',
    shortReason: 'googletagmanager.com / google-analytics.com scripts',
    uncertaintyNote: 'Server-side proxy analytics hide Google domain script URLs.',
    evaluate: ({ allResourceUrls, inlineScriptSample }) => {
      const ev: string[] = [];
      if (
        allResourceUrls.some(
          (u) => u.includes('googletagmanager.com') || u.includes('google-analytics.com'),
        )
      ) {
        ev.push('Google Tag Manager / Analytics script loaded');
      }
      if (inlineScriptSample.includes('gtag(') || inlineScriptSample.includes('dataLayer')) {
        ev.push('Inline gtag / dataLayer initialization');
      }
      return ev;
    },
  },
  {
    technology: 'PostHog',
    category: 'analytics_or_monitoring',
    shortReason: 'posthog.com script or init call',
    uncertaintyNote: 'Custom reverse-proxy ingestion domains mask PostHog scripts.',
    evaluate: ({ allResourceUrls, inlineScriptSample }) => {
      const ev: string[] = [];
      if (allResourceUrls.some((u) => u.includes('posthog.com'))) {
        ev.push('PostHog CDN / ingestion script URL');
      }
      if (inlineScriptSample.includes('posthog.init')) {
        ev.push('Inline posthog.init signature');
      }
      return ev;
    },
  },
  {
    technology: 'Plausible Analytics',
    category: 'analytics_or_monitoring',
    shortReason: 'plausible.io script with data-domain',
    uncertaintyNote: 'Proxied Plausible endpoints use custom script domains.',
    evaluate: ({ doc, scriptUrls }) => {
      const ev: string[] = [];
      if (
        doc.querySelector('script[data-domain]') &&
        scriptUrls.some((u) => u.includes('plausible'))
      ) {
        ev.push('Plausible Analytics script with data-domain');
      }
      return ev;
    },
  },
  {
    technology: 'Sentry',
    category: 'analytics_or_monitoring',
    shortReason: 'sentry-cdn / Sentry browser SDK script',
    uncertaintyNote:
      'Bundled Sentry SDKs without CDN script tags cannot be distinguished externally.',
    evaluate: ({ allResourceUrls }) => {
      const ev: string[] = [];
      if (
        allResourceUrls.some((u) => u.includes('sentry-cdn.com') || u.includes('browser.sentry'))
      ) {
        ev.push('Sentry Browser SDK script reference');
      }
      return ev;
    },
  },
  {
    technology: 'Cloudflare',
    category: 'analytics_or_monitoring',
    shortReason: 'Cloudflare Insights, Turnstile, or /cdn-cgi/',
    uncertaintyNote:
      'Origin-only Cloudflare proxy without /cdn-cgi/ scripts requires HTTP headers.',
    evaluate: ({ allResourceUrls }) => {
      const ev: string[] = [];
      if (
        allResourceUrls.some(
          (u) =>
            u.includes('static.cloudflareinsights.com') ||
            u.includes('challenges.cloudflare.com') ||
            u.includes('/cdn-cgi/'),
        )
      ) {
        ev.push('Cloudflare CDN / Turnstile / Insights endpoint');
      }
      return ev;
    },
  },
  {
    technology: 'Stripe',
    category: 'analytics_or_monitoring',
    shortReason: 'js.stripe.com payment SDK',
    uncertaintyNote: 'Pages without checkout initialization omit Stripe scripts.',
    evaluate: ({ allResourceUrls }) => {
      const ev: string[] = [];
      if (allResourceUrls.some((u) => u.includes('js.stripe.com'))) {
        ev.push('Stripe.js loaded from js.stripe.com');
      }
      return ev;
    },
  },
  {
    technology: 'Intercom / Crisp / Zendesk',
    category: 'analytics_or_monitoring',
    shortReason: 'Customer chat widget script / root',
    uncertaintyNote: 'Lazy-loaded support widgets appear only after trigger interaction.',
    evaluate: ({ allResourceUrls, doc }) => {
      const ev: string[] = [];
      if (
        allResourceUrls.some((u) => u.includes('widget.intercom.io')) ||
        doc.getElementById('intercom-container')
      ) {
        ev.push('Intercom widget signature');
      }
      if (allResourceUrls.some((u) => u.includes('client.crisp.chat'))) {
        ev.push('Crisp chat widget signature');
      }
      if (allResourceUrls.some((u) => u.includes('zdassets.com'))) {
        ev.push('Zendesk widget asset URL');
      }
      return ev;
    },
  },
  {
    technology: 'Clerk / Auth0',
    category: 'analytics_or_monitoring',
    shortReason: 'Hosted auth script or clerk-* component',
    uncertaintyNote: 'Server-only auth flows do not render client auth scripts.',
    evaluate: ({ allResourceUrls, classSample }) => {
      const ev: string[] = [];
      if (
        allResourceUrls.some((u) => u.includes('clerk.accounts') || u.includes('clerk.browser'))
      ) {
        ev.push('Clerk frontend SDK');
      }
      if (
        /\bcl-[a-z0-9-]+\b/.test(classSample) &&
        allResourceUrls.some((u) => u.includes('clerk'))
      ) {
        ev.push('Clerk UI component markers');
      }
      if (allResourceUrls.some((u) => u.includes('cdn.auth0.com'))) {
        ev.push('Auth0 frontend SDK');
      }
      return ev;
    },
  },
  {
    technology: 'Vercel Platform / Analytics',
    category: 'analytics_or_monitoring',
    shortReason: '/_vercel/insights or Speed Insights script',
    uncertaintyNote:
      'Sites hosted on Vercel without /_vercel/ scripts need response header inspection.',
    evaluate: ({ allResourceUrls }) => {
      const ev: string[] = [];
      if (
        allResourceUrls.some(
          (u) => u.includes('/_vercel/insights') || u.includes('va.vercel-scripts.com'),
        )
      ) {
        ev.push('Vercel Analytics / Speed Insights endpoint');
      }
      return ev;
    },
  },
];

function collectCssCustomPropertyNames(doc: Document): string[] {
  const names = new Set<string>();
  for (const sheet of Array.from(doc.styleSheets).slice(0, 20)) {
    try {
      for (const rule of Array.from(sheet.cssRules).slice(0, 120)) {
        const text = rule.cssText;
        const matches = text.match(/--[a-z0-9_-]{2,}/gi);
        if (matches) {
          for (const m of matches.slice(0, 40)) {
            names.add(m);
          }
        }
      }
    } catch {
      continue;
    }
  }
  return Array.from(names);
}

function collectPerformanceSnapshot(win?: Window): {
  resourceUrls: string[];
  protocols: string[];
} {
  const perfApi = (win as { performance?: Performance } | undefined)?.performance;
  if (!perfApi || typeof perfApi.getEntriesByType !== 'function') {
    return { resourceUrls: [], protocols: [] };
  }
  const urls: string[] = [];
  const protocols = new Set<string>();
  try {
    const navEntries = perfApi.getEntriesByType('navigation') as Array<
      PerformanceEntry & { nextHopProtocol?: string }
    >;
    for (const entry of navEntries.slice(0, 4)) {
      if (typeof entry.nextHopProtocol === 'string' && entry.nextHopProtocol.length > 0) {
        protocols.add(entry.nextHopProtocol);
      }
    }
    const resEntries = perfApi.getEntriesByType('resource') as Array<
      PerformanceEntry & { nextHopProtocol?: string }
    >;
    for (const entry of resEntries.slice(0, 220)) {
      if (typeof entry.name === 'string' && entry.name.length > 0) {
        urls.push(entry.name);
      }
      if (typeof entry.nextHopProtocol === 'string' && entry.nextHopProtocol.length > 0) {
        protocols.add(entry.nextHopProtocol);
      }
    }
  } catch {
    return { resourceUrls: urls, protocols: Array.from(protocols) };
  }
  return { resourceUrls: urls, protocols: Array.from(protocols) };
}

function collectPublicWindowGlobals(win?: Window): Set<string> {
  const found = new Set<string>();
  if (!win) {
    return found;
  }
  const keys = [
    '__NEXT_DATA__',
    '__NUXT__',
    '__remixContext',
    'React',
    'Shopify',
    'dataLayer',
    'gtag',
    'posthog',
    'Stripe',
    'Sentry',
    'Alpine',
    'htmx',
  ];
  const record = win as unknown as Record<string, unknown>;
  for (const key of keys) {
    try {
      if (record[key] !== undefined && record[key] !== null) {
        found.add(key);
      }
    } catch {
      continue;
    }
  }
  return found;
}

export function detectPageTechStack(doc: Document, win?: Window): TechStackReport {
  const scriptUrls = Array.from(doc.querySelectorAll('script[src]'))
    .map((s) => s.getAttribute('src') ?? '')
    .filter((u) => u.length > 0);
  const stylesheetUrls = Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'))
    .map((l) => l.getAttribute('href') ?? '')
    .filter((u) => u.length > 0);
  const modulepreloadUrls = Array.from(
    doc.querySelectorAll('link[rel="modulepreload" i][href], script[type="module"][src]'),
  )
    .map((l) => l.getAttribute('href') ?? l.getAttribute('src') ?? '')
    .filter((u) => u.length > 0);
  const linkHints = Array.from(doc.querySelectorAll('link[href]'))
    .map((l) => l.getAttribute('href') ?? '')
    .filter((u) => u.length > 0);

  const perf = collectPerformanceSnapshot(win);
  const allResourceUrls = Array.from(
    new Set([
      ...scriptUrls,
      ...stylesheetUrls,
      ...modulepreloadUrls,
      ...linkHints,
      ...perf.resourceUrls,
    ]),
  );

  const inlineScriptSample = Array.from(doc.querySelectorAll('script:not([src])'))
    .slice(0, 25)
    .map((s) => s.textContent.slice(0, 2500))
    .join('\n');

  const cssCustomPropNames = collectCssCustomPropertyNames(doc);
  const metaGenerator =
    doc.querySelector('meta[name="generator" i]')?.getAttribute('content')?.trim() ?? '';
  const htmlAttrNames = Array.from(doc.documentElement.attributes).map((a) => a.name);
  const winGlobals = collectPublicWindowGlobals(win);

  const classListSample: string[] = [];
  for (const el of Array.from(doc.querySelectorAll('[class]')).slice(0, 450)) {
    const cls = el.getAttribute('class');
    if (cls) {
      classListSample.push(cls);
    }
  }
  const classSample = classListSample.join(' ');

  const detectedMap = new Map<string, TechStackDetectionEntry>();
  const ruleByTech = new Map(DETECTOR_RULES.map((r) => [r.technology, r]));

  for (const rule of DETECTOR_RULES) {
    const evidence = rule.evaluate({
      doc,
      win,
      scriptUrls,
      stylesheetUrls,
      modulepreloadUrls,
      allResourceUrls,
      performanceProtocols: perf.protocols,
      inlineScriptSample,
      cssCustomPropNames,
      metaGenerator,
      htmlAttrNames,
      classSample,
      winGlobals,
    });
    if (evidence.length > 0) {
      detectedMap.set(rule.technology, {
        technology: rule.technology,
        category: rule.category,
        shortReason: rule.shortReason,
        evidence,
        confidence: evidence.length >= 2 ? 'high' : 'medium',
        uncertaintyNote: rule.uncertaintyNote,
      });
    }
  }

  let addedImplication = true;
  for (let hop = 0; hop < 3 && addedImplication; hop += 1) {
    addedImplication = false;
    for (const [techName, entry] of Array.from(detectedMap.entries())) {
      const sourceRule = ruleByTech.get(techName);
      if (!sourceRule?.implies) {
        continue;
      }
      for (const impliedTech of sourceRule.implies) {
        const impliedNote = `Implied by ${entry.technology} platform runtime`;
        const existing = detectedMap.get(impliedTech);
        if (existing) {
          if (!existing.evidence.includes(impliedNote)) {
            existing.evidence.push(impliedNote);
            if (existing.evidence.length >= 2) {
              existing.confidence = 'high';
            }
          }
          continue;
        }
        const targetRule = ruleByTech.get(impliedTech);
        if (!targetRule) {
          continue;
        }
        detectedMap.set(impliedTech, {
          technology: targetRule.technology,
          category: targetRule.category,
          shortReason: targetRule.shortReason,
          evidence: [impliedNote],
          confidence: 'medium',
          uncertaintyNote: targetRule.uncertaintyNote,
        });
        addedImplication = true;
      }
    }
  }

  const detections = Array.from(detectedMap.values());

  const groups: TechStackOrganizedGroup[] = [];
  for (const catMeta of CATEGORY_ORDER) {
    const matches = detections.filter((d) => d.category === catMeta.category);
    if (matches.length === 0) {
      continue;
    }
    groups.push({
      category: catMeta.category,
      label: catMeta.label,
      items: matches.map((m) => ({
        technology: m.technology,
        confidence: m.confidence,
        shortReason: m.evidence[0] ?? m.shortReason,
      })),
    });
  }

  const oneLiner =
    detections.length > 0
      ? detections.map((d) => d.technology).join(', ')
      : 'No public frontend or platform markers detected';

  return {
    detections,
    organizedSummary: {
      totalDetected: detections.length,
      oneLiner,
      groups,
    },
    methodologyDisclosure:
      'Tech stack detection inspects public DOM nodes, script/stylesheet/modulepreload URLs, browser performance timing entries (HTTP/2 & HTTP/3 nextHopProtocol), meta tags, CSS variables, and documented platform implications. Server-only runtimes and private origin headers cannot be observed; absence of a marker does not prove absence of a technology.',
  };
}
