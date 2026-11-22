import { extractPageAssets } from './assets-engine.js';
import { extractPageDesignSnapshot, type PageDesignSnapshotInput } from './design-md-engine.js';

export type PromptTargetFramework = 'generic' | 'react_tailwind' | 'html_css' | 'vue_css';

export interface ClonePromptReport {
  prompt: string;
  targetFramework: PromptTargetFramework;
  observations: string[];
  assumptions: string[];
  sanitizedAiContext: {
    pageTitle: string;
    targetFramework: PromptTargetFramework;
    topColors: string[];
    fontFamilies: string[];
    spacingScalePx: number[];
    layoutPatterns: string[];
    components: string[];
    assetCount: number;
  };
}

const FRAMEWORK_INSTRUCTIONS: Record<PromptTargetFramework, string> = {
  generic:
    'Implement clean, modular, accessible components using semantic HTML5 and modern CSS variables.',
  react_tailwind:
    'Implement using React functional components with TypeScript and Tailwind CSS utility classes mapped to the extracted design tokens.',
  html_css:
    'Implement using semantic HTML5 and modern vanilla CSS (custom properties, CSS Grid, Flexbox) with zero external runtime dependencies.',
  vue_css:
    'Implement using Vue 3 Single-File Components (`<script setup lang="ts">`) with scoped CSS custom properties.',
};

export function generateLocalClonePrompt(
  doc: Document,
  win: Window,
  targetFramework: PromptTargetFramework = 'react_tailwind',
): ClonePromptReport {
  const snapshot: PageDesignSnapshotInput = extractPageDesignSnapshot(doc, win);
  const assetsReport = extractPageAssets(doc, win);

  const topColors = snapshot.colorsReport.colors
    .slice(0, 10)
    .map((c) => `${c.hex} (${c.properties.join('/')})`);
  const fontFamilies = snapshot.fontsReport.families.map(
    (f) =>
      `${f.primaryFamily} (sizes: ${f.combinations
        .map((c) => c.fontSize)
        .slice(0, 5)
        .join(', ')})`,
  );

  const observations: string[] = [
    `Page title: "${snapshot.pageTitle}"`,
    `Primary color palette (${topColors.length} core tokens): ${topColors.join(', ') || 'browser defaults'}`,
    `Typography stacks (${fontFamilies.length}): ${fontFamilies.join('; ') || 'system sans-serif'}`,
    `Spacing scale (px): ${snapshot.spacingTokensPx.map((s) => `${s}px`).join(', ') || 'default flow'}`,
    `Border radii: ${snapshot.borderRadii.join(', ') || '0px'}`,
    `Discovered media assets: ${assetsReport.summary.totalDiscovered} (${assetsReport.summary.inlineAvailableCount} inline SVGs, ${assetsReport.summary.httpReferenceCount} HTTP references)`,
    ...snapshot.layoutPatterns.map((p) => `Layout observation: ${p}`),
    ...snapshot.componentObservations.map((c) => `Component observation: ${c}`),
    ...(snapshot.styleAdaptation?.pseudoStateRules
      .slice(0, 6)
      .map((r) => `Interactive state (${r.state} on ${r.selector}): ${r.declarations}`) ?? []),
    ...(snapshot.styleAdaptation?.wcagContrastPairs
      .slice(0, 4)
      .map((c) => `Contrast (${c.pairLabel}): ${c.contrastRatio}:1 (${c.grade})`) ?? []),
    ...(snapshot.styleAdaptation
      ? [
          `Extraction completeness: ${snapshot.styleAdaptation.completeness.coverageStatus} (${snapshot.styleAdaptation.completeness.accessibleStylesheetsCount} accessible CSS sheet(s), ${snapshot.styleAdaptation.completeness.inaccessibleStylesheets.length} CORS-omitted)`,
        ]
      : []),
  ];

  const assumptions: string[] = [
    'Computed styles were captured at a single viewport state; responsive breakpoints at 640px, 768px, 1024px, and 1280px are inferred to collapse multi-column grids into single-column stacks on mobile.',
    'Interactive states (:hover, :focus-visible, :active) not explicitly observed in accessible stylesheets are inferred to use subtle luminance shifts and accessible focus rings.',
    ...(snapshot.styleAdaptation?.completeness.omissionReasons ?? []),
    'Dynamic data, authenticated API responses, and server-side form handlers are out of scope and should be represented with clean static props or mock fixtures.',
  ];

  const adaptedTargetSnippet = snapshot.styleAdaptation
    ? targetFramework === 'react_tailwind'
      ? [
          '',
          '## Adapted Tailwind CSS v4 Theme & Utility Mapping',
          '```css',
          snapshot.styleAdaptation.adaptedTailwindThemeBlock,
          '```',
          ...snapshot.styleAdaptation.adaptedTailwindUtilities.map(
            (u) => `- **${u.role}**: \`${u.classes}\``,
          ),
        ]
      : [
          '',
          '## Adapted Semantic CSS Theme & Component Classes',
          '```css',
          snapshot.styleAdaptation.adaptedCssThemeBlock,
          '```',
        ]
    : [];

  const promptLines: string[] = [
    `# Rebuild Prompt: ${snapshot.pageTitle}`,
    '',
    '## Target Stack Instruction',
    FRAMEWORK_INSTRUCTIONS[targetFramework],
    '',
    '## Verified Page Observations (Measured from DOM & Computed Styles)',
    ...observations.map((obs) => `- ${obs}`),
    '',
    '## Structural & Responsive Assumptions (Inferred, Not Directly Observed)',
    ...assumptions.map((asm) => `- ${asm}`),
    ...adaptedTargetSnippet,
    '',
    '## Implementation & Verification Checklist',
    '1. Define CSS custom properties / theme tokens for the observed colors, font families, spacing steps, and border radii.',
    '2. Build the outer landmark structure (header/navigation, main content sections, footer) matching the observed Flexbox, CSS Grid, and z-index stacking layers.',
    '3. Implement each observed component with accessible ARIA roles, extracted :hover/:focus-visible states, and responsive collapse across observed breakpoints.',
    '4. Replace external media assets with semantic placeholders or inline SVGs matching the discovered dimensions.',
    ...(snapshot.styleAdaptation?.reconstructionAssertions.map(
      (a, i) => `${i + 5}. Verify: ${a}`,
    ) ?? []),
  ];

  return {
    prompt: promptLines.join('\n') + '\n',
    targetFramework,
    observations,
    assumptions,
    sanitizedAiContext: {
      pageTitle: snapshot.pageTitle.slice(0, 160),
      targetFramework,
      topColors: snapshot.colorsReport.colors.slice(0, 12).map((c) => c.hex),
      fontFamilies: snapshot.fontsReport.families.slice(0, 6).map((f) => f.primaryFamily),
      spacingScalePx: snapshot.spacingTokensPx.slice(0, 16),
      layoutPatterns: snapshot.layoutPatterns.slice(0, 12),
      components: snapshot.componentObservations.slice(0, 12),
      assetCount: assetsReport.summary.totalDiscovered,
    },
  };
}
