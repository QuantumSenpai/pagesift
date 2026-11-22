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
  scriptUrls: string[];
  stylesheetUrls: string[];
  allResourceUrls: string[];
  inlineScriptSample: string;
  cssCustomPropNames: string[];
  metaGenerator: string;
  htmlAttrNames: string[];
  classSample: string;
}

interface DetectorRule {
  technology: string;
  category: TechCategory;
  shortReason: string;
  uncertaintyNote: string;
  evaluate: (ctx: DetectorContext) => string[];
}

const CATEGORY_ORDER: Array<{ category: TechCategory; label: string }> = [
  { category: 'framework', label: 'Frameworks & Runtimes' },
  { category: 'css_library', label: 'Styling & CSS' },
  { category: 'ui_kit', label: 'UI Libraries & Motion' },
  { category: 'cms_or_platform', label: 'Platform, CMS & Commerce' },
  { category: 'build_tool', label: 'Build & Bundlers' },
  { category: 'analytics_or_monitoring', label: 'Analytics, Payments & Infra' },
];

const DETECTOR_RULES: DetectorRule[] = [
  {
    technology: 'Next.js',
    category: 'framework',
    shortReason: 'App / Pages router runtime markers',
    uncertaintyNote: 'App Router pages without #__next are detected via /_next/ asset paths.',
    evaluate: ({ doc, allResourceUrls, inlineScriptSample }) => {
      const ev: string[] = [];
      if (doc.getElementById('__next')) {
        ev.push('DOM root #__next present');
      }
      if (doc.querySelector('script#__NEXT_DATA__')) {
        ev.push('script#__NEXT_DATA__ hydration state present');
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
    shortReason: 'React component / root markers',
    uncertaintyNote: 'Production builds without data-reactroot may bundle React silently.',
    evaluate: ({ doc, scriptUrls, inlineScriptSample }) => {
      const ev: string[] = [];
      if (doc.querySelector('[data-reactroot], [data-reactid]')) {
        ev.push('data-reactroot / data-reactid attribute present');
      }
      if (doc.getElementById('__next') || doc.getElementById('___gatsby')) {
        ev.push('React framework mount container detected');
      }
      if (scriptUrls.some((u) => /react(?:\.production\.min|-dom)?\.js/i.test(u))) {
        ev.push('Script references react / react-dom');
      }
      if (
        inlineScriptSample.includes('__reactContainer') ||
        inlineScriptSample.includes('__NEXT_DATA__')
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
    evaluate: ({ inlineScriptSample, scriptUrls }) => {
      const ev: string[] = [];
      if (
        inlineScriptSample.includes('__remixContext') ||
        inlineScriptSample.includes('__remixManifest')
      ) {
        ev.push('Remix client hydration context detected');
      }
      if (scriptUrls.some((u) => /\/build\/_shared\/|\/assets\/root-/i.test(u))) {
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
    shortReason: 'Motion projection / inline transform style signatures',
    uncertaintyNote: 'Static motion elements without projection attributes look like standard DOM.',
    evaluate: ({ doc }) => {
      const ev: string[] = [];
      if (doc.querySelector('[data-projection-id]')) {
        ev.push('Framer Motion data-projection-id attributes present');
      }
      return ev;
    },
  },
  {
    technology: 'GSAP',
    category: 'ui_kit',
    shortReason: 'GSAP script bundle reference',
    uncertaintyNote: 'Private bundled GSAP imports may not expose script URL names.',
    evaluate: ({ scriptUrls }) => {
      const ev: string[] = [];
      if (scriptUrls.some((u) => /\bgsap(?:\.min)?\.js|ScrollTrigger(?:\.min)?\.js/i.test(u))) {
        ev.push('GSAP / ScrollTrigger script URL present');
      }
      return ev;
    },
  },
  {
    technology: 'Framer',
    category: 'cms_or_platform',
    shortReason: 'framer-* classes & framerusercontent CDN',
    uncertaintyNote: 'Custom proxied Framer builds may mask framerusercontent URLs.',
    evaluate: ({ allResourceUrls, metaGenerator, classSample }) => {
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
    technology: 'Vite',
    category: 'build_tool',
    shortReason: '/@vite/client or /assets/index-[hash] module pattern',
    uncertaintyNote: 'Custom Rollup output paths hide standard Vite filenames.',
    evaluate: ({ scriptUrls, doc }) => {
      const ev: string[] = [];
      if (scriptUrls.some((u) => u.includes('/@vite/client') || u.includes('/assets/'))) {
        if (doc.querySelector('script[type="module"][src*="/assets/"]')) {
          ev.push('Vite module bundle pattern (/assets/*.js)');
        } else if (scriptUrls.some((u) => u.includes('/@vite/client'))) {
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
    evaluate: ({ inlineScriptSample }) => {
      const ev: string[] = [];
      if (
        inlineScriptSample.includes('webpackChunk') ||
        inlineScriptSample.includes('__webpack_require__')
      ) {
        ev.push('Webpack chunk loader runtime reference');
      }
      return ev;
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

export function detectPageTechStack(doc: Document): TechStackReport {
  const scriptUrls = Array.from(doc.querySelectorAll('script[src]'))
    .map((s) => s.getAttribute('src') ?? '')
    .filter((u) => u.length > 0);
  const stylesheetUrls = Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'))
    .map((l) => l.getAttribute('href') ?? '')
    .filter((u) => u.length > 0);
  const linkHints = Array.from(doc.querySelectorAll('link[href]'))
    .map((l) => l.getAttribute('href') ?? '')
    .filter((u) => u.length > 0);
  const allResourceUrls = Array.from(new Set([...scriptUrls, ...stylesheetUrls, ...linkHints]));

  const inlineScriptSample = Array.from(doc.querySelectorAll('script:not([src])'))
    .slice(0, 25)
    .map((s) => s.textContent.slice(0, 2500))
    .join('\n');

  const cssCustomPropNames = collectCssCustomPropertyNames(doc);
  const metaGenerator =
    doc.querySelector('meta[name="generator" i]')?.getAttribute('content')?.trim() ?? '';
  const htmlAttrNames = Array.from(doc.documentElement.attributes).map((a) => a.name);

  const classListSample: string[] = [];
  for (const el of Array.from(doc.querySelectorAll('[class]')).slice(0, 450)) {
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
      allResourceUrls,
      inlineScriptSample,
      cssCustomPropNames,
      metaGenerator,
      htmlAttrNames,
      classSample,
    });
    if (evidence.length > 0) {
      detections.push({
        technology: rule.technology,
        category: rule.category,
        shortReason: rule.shortReason,
        evidence,
        confidence: evidence.length >= 2 ? 'high' : 'medium',
        uncertaintyNote: rule.uncertaintyNote,
      });
    }
  }

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
      'Tech stack detection inspects public client-side DOM markers, script/stylesheet/link URLs, CSS custom properties, and meta tags only. Server-side runtimes, private headers, and stripped build markers cannot be observed; absence of a marker does not prove absence of a technology.',
  };
}
