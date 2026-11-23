import { z } from 'zod';

export const MOTION_SPEC_SCHEMA_VERSION = 1;

export const MOTION_CAPTURE_DEFAULTS = {
  maxDurationMs: 15000,
  defaultDurationMs: 3000,
  maxTargets: 24,
  maxSamplesPerTarget: 600,
  maxOutputBytes: 2 * 1024 * 1024,
  maxKeyframesPerTrack: 48,
} as const;

export const motionEvidenceClassSchema = z.enum([
  'declared',
  'observed',
  'inferred',
  'unavailable',
]);

export type MotionEvidenceClass = z.infer<typeof motionEvidenceClassSchema>;

export const motionCategorySchema = z.enum([
  'css_animation',
  'css_transition',
  'waapi',
  'js_driven',
  'scroll_driven',
  'canvas_gpu',
  'imported',
]);

export type MotionCategory = z.infer<typeof motionCategorySchema>;

export const motionTriggerTypeSchema = z.enum([
  'load',
  'hover',
  'leave',
  'click',
  'scroll',
  'focus',
  'pointer_move',
  'drag',
  'loop',
  'manual',
  'imported',
]);

export type MotionTriggerType = z.infer<typeof motionTriggerTypeSchema>;

export const motionTimelineDomainSchema = z.enum([
  'time_ms',
  'scroll_progress_percent',
  'view_progress_percent',
  'frame_index',
  'unknown',
]);

export type MotionTimelineDomain = z.infer<typeof motionTimelineDomainSchema>;

export const motionCapabilityStatusSchema = z.enum(['supported', 'partial', 'unavailable']);

export type MotionCapabilityStatus = z.infer<typeof motionCapabilityStatusSchema>;

export interface MotionCapabilityEntry {
  category: MotionCategory;
  label: string;
  status: MotionCapabilityStatus;
  evidenceClass: MotionEvidenceClass;
  whatIsCaptured: string;
  limitations: string;
}

export const MOTION_CAPABILITY_MATRIX: readonly MotionCapabilityEntry[] = [
  {
    category: 'css_animation',
    label: 'CSS Animations (@keyframes)',
    status: 'supported',
    evidenceClass: 'declared',
    whatIsCaptured:
      'Animation name, timing, delay, iterations, direction, fill mode, keyframes, and live playback state via getAnimations() and accessible stylesheets.',
    limitations:
      'Cross-origin stylesheet @keyframes rules and animations that already finished and disconnected before attachment may be unavailable.',
  },
  {
    category: 'css_transition',
    label: 'CSS Transitions',
    status: 'supported',
    evidenceClass: 'declared',
    whatIsCaptured:
      'Declared transition properties, durations, delays, timing functions, lifecycle events (transitionrun/start/end/cancel), and newly spawned transitions during observation.',
    limitations:
      'Interrupted or reversed transitions rely on live observation samples to capture exact reversal coordinates.',
  },
  {
    category: 'waapi',
    label: 'Web Animations API (WAAPI)',
    status: 'supported',
    evidenceClass: 'declared',
    whatIsCaptured:
      'KeyframeEffect keyframes, computed timing, composite behavior, playbackRate, and timeline association for Element.animate() and Animation instances.',
    limitations:
      'Custom procedural JS callbacks scheduling sequential WAAPI calls outside the observation window are only captured while active.',
  },
  {
    category: 'js_driven',
    label: 'JavaScript-Driven DOM Motion',
    status: 'partial',
    evidenceClass: 'inferred',
    whatIsCaptured:
      'Measured rAF transform matrix, opacity, clip-path, and bounding-box samples with timestamps; estimated delay, duration, overshoot, settle time, and candidate cubic-bezier curves.',
    limitations:
      'Original JS source expressions (GSAP timelines, Framer Motion spring configs, custom physics loops) are not directly readable; easing and spring parameters are non-unique estimates.',
  },
  {
    category: 'scroll_driven',
    label: 'Scroll-Driven Motion',
    status: 'partial',
    evidenceClass: 'observed',
    whatIsCaptured:
      'ScrollTimeline/ViewTimeline percentage progress (CSSUnitValue), rangeStart/rangeEnd when exposed, and scrollX/scrollY correlated property samples.',
    limitations:
      'Smooth-scroll libraries (e.g. Lenis) and nested scroll containers appear as JS-driven or container-scroll samples rather than document scroll ranges.',
  },
  {
    category: 'canvas_gpu',
    label: 'Canvas 2D / WebGL / WebGPU Motion',
    status: 'unavailable',
    evidenceClass: 'unavailable',
    whatIsCaptured:
      'Canvas presence, dimensions, CSS bounds, and optional browser-native visual frame/video evidence when opted in.',
    limitations:
      'Live extension attachment after page load cannot retroactively intercept pre-existing WebGL/WebGPU contexts, shaders, or uniform buffers. Use the optional Reanimate CLI handoff for deterministic --clock virtual --gl traces.',
  },
  {
    category: 'imported',
    label: 'Imported Capture Evidence (Reanimate / Media)',
    status: 'supported',
    evidenceClass: 'observed',
    whatIsCaptured:
      'Validated Reanimate inspect.json, track.json, capture.json, frames.json, and inert gl/gl.json channel metadata or supported browser media.',
    limitations:
      'Imported scripts, shaders, and HTML remain inert evidence only; unsupported codecs or oversized archives are rejected explicitly.',
  },
] as const;

export const motionTargetIdentitySchema = z.strictObject({
  targetId: z.string().min(1).max(128),
  selector: z.string().min(1).max(512),
  tagName: z.string().min(1).max(64),
  role: z.string().max(64).nullable(),
  accessibleName: z.string().max(160).nullable(),
  insideOpenShadowRoot: z.boolean().default(false),
  initialBox: z.strictObject({
    x: z.number(),
    y: z.number(),
    width: z.number().min(0),
    height: z.number().min(0),
  }),
  transformOrigin: z.string().max(128).default('50% 50% 0px'),
  clippingAncestors: z
    .array(
      z.strictObject({
        selector: z.string().max(256),
        overflowX: z.string().max(32),
        overflowY: z.string().max(32),
      }),
    )
    .max(12)
    .default([]),
  nestedTransformAncestors: z
    .array(
      z.strictObject({
        selector: z.string().max(256),
        transform: z.string().max(256),
      }),
    )
    .max(12)
    .default([]),
});

export type MotionTargetIdentity = z.infer<typeof motionTargetIdentitySchema>;

export const motionKeyframeEntrySchema = z.strictObject({
  offset: z.number().min(0).max(1).nullable(),
  computedOffset: z.number().min(0).max(1),
  easing: z.string().max(160).optional(),
  composite: z.string().max(32).optional(),
  value: z.union([z.string().max(512), z.number()]),
});

export type MotionKeyframeEntry = z.infer<typeof motionKeyframeEntrySchema>;

export const motionSamplePointSchema = z.strictObject({
  tMs: z.number(),
  progressPct: z.number().min(0).max(100).nullable().optional(),
  scrollX: z.number(),
  scrollY: z.number(),
  value: z.union([z.number(), z.string().max(512)]),
  layoutDeltaX: z.number().optional(),
  layoutDeltaY: z.number().optional(),
});

export type MotionSamplePoint = z.infer<typeof motionSamplePointSchema>;

export const motionEasingCandidateSchema = z.strictObject({
  name: z.string().max(120),
  cssEasing: z.string().max(160),
  rmse: z.number().min(0),
  fittedDurationMs: z.number().min(0),
  confidence: z.enum(['high', 'medium', 'low']),
});

export type MotionEasingCandidate = z.infer<typeof motionEasingCandidateSchema>;

export const motionTrackSchema = z.strictObject({
  trackId: z.string().min(1).max(128),
  targetId: z.string().min(1).max(128),
  selector: z.string().min(1).max(512),
  property: z.string().min(1).max(128),
  category: motionCategorySchema,
  evidenceClass: motionEvidenceClassSchema,
  trigger: motionTriggerTypeSchema,
  timelineDomain: motionTimelineDomainSchema,
  animationName: z.string().max(160).nullable().default(null),
  playState: z.string().max(32).nullable().default(null),
  composite: z.string().max(32).nullable().default(null),
  startMs: z.number().nullable(),
  endMs: z.number().nullable(),
  delayMs: z.number().nullable(),
  durationMs: z.number().nullable(),
  endDelayMs: z.number().nullable().default(null),
  iterations: z
    .union([z.number().min(0), z.literal('infinite')])
    .nullable()
    .default(1),
  direction: z.string().max(32).nullable().default(null),
  fillMode: z.string().max(32).nullable().default(null),
  progressStartPct: z.number().nullable().default(null),
  progressEndPct: z.number().nullable().default(null),
  fromValue: z.union([z.number(), z.string().max(512), z.null()]),
  toValue: z.union([z.number(), z.string().max(512), z.null()]),
  unit: z.string().max(32).default(''),
  directionHint: z
    .enum(['forward', 'reverse', 'oscillating', 'static', 'unknown'])
    .default('unknown'),
  normalizedTravel: z.number().nullable().default(null),
  overshootPct: z.number().min(0).nullable().default(null),
  settleTimeMs: z.number().min(0).nullable().default(null),
  staggerFromPrevMs: z.number().nullable().default(null),
  declaredEasing: z.string().max(160).nullable().default(null),
  inferredEasings: z.array(motionEasingCandidateSchema).max(5).default([]),
  residualError: z.number().min(0).nullable().default(null),
  inferenceConfidence: z.enum(['high', 'medium', 'low']).nullable().default(null),
  keyframes: z.array(motionKeyframeEntrySchema).max(48).default([]),
  samples: z.array(motionSamplePointSchema).max(600).default([]),
  hasMotion: z.boolean().default(true),
  isConstant: z.boolean().default(false),
  replaySupported: z.boolean().default(true),
  unsupportedReason: z.string().max(240).nullable().default(null),
  notes: z.array(z.string().max(300)).max(12).default([]),
});

export type MotionTrack = z.infer<typeof motionTrackSchema>;

export const motionEnvironmentContextSchema = z.strictObject({
  pageUrl: z.string().max(2048),
  pageTitle: z.string().max(300),
  viewport: z.strictObject({
    width: z.number().int().min(1).max(16384),
    height: z.number().int().min(1).max(16384),
  }),
  devicePixelRatio: z.number().min(0.1).max(16),
  scrollPosition: z.strictObject({
    x: z.number(),
    y: z.number(),
  }),
  reducedMotionPreference: z.enum(['no-preference', 'reduce', 'unknown']).default('unknown'),
  cropRect: z
    .strictObject({
      x: z.number(),
      y: z.number(),
      width: z.number().min(0),
      height: z.number().min(0),
    })
    .nullable()
    .default(null),
  coordinateSpace: z
    .enum(['viewport_css_px', 'page_css_px', 'local_transform'])
    .default('viewport_css_px'),
});

export type MotionEnvironmentContext = z.infer<typeof motionEnvironmentContextSchema>;

export const motionUnavailableItemSchema = z.strictObject({
  category: z.string().max(64),
  target: z.string().max(256),
  reason: z.string().max(400),
});

export type MotionUnavailableItem = z.infer<typeof motionUnavailableItemSchema>;

export const motionSessionMetaSchema = z.strictObject({
  sessionId: z.string().min(1).max(128),
  state: z.enum([
    'idle',
    'armed',
    'recording',
    'completed',
    'partial',
    'cancelled',
    'failed',
    'imported',
  ]),
  startedAtIso: z.iso.datetime(),
  completedAtIso: z.iso.datetime().nullable(),
  observedDurationMs: z.number().min(0),
  sampleCount: z.number().int().min(0),
  droppedSamplesEstimate: z.number().int().min(0).default(0),
  measuredMeanFps: z.number().min(0).nullable().default(null),
  interruptionReason: z.string().max(300).nullable().default(null),
  visualRecordingStatus: z
    .enum(['none', 'recorded', 'permission_denied', 'unsupported', 'cancelled', 'failed'])
    .default('none'),
  visualMediaId: z.string().max(128).nullable().default(null),
  visualFrameCount: z.number().int().min(0).default(0),
});

export type MotionSessionMeta = z.infer<typeof motionSessionMetaSchema>;

export const motionSpecSchema = z.strictObject({
  schemaVersion: z.literal(MOTION_SPEC_SCHEMA_VERSION),
  specId: z.string().min(1).max(128),
  sourceKind: z.enum(['live_observation', 'reanimate_import', 'media_import']),
  environment: motionEnvironmentContextSchema,
  session: motionSessionMetaSchema,
  rootSelector: z.string().max(512),
  targets: z.array(motionTargetIdentitySchema).max(24),
  tracks: z.array(motionTrackSchema).max(128),
  detectedEngines: z.array(z.string().max(120)).max(24).default([]),
  canvasesDetected: z
    .array(
      z.strictObject({
        selector: z.string().max(256),
        width: z.number().int().min(0),
        height: z.number().int().min(0),
        contextHint: z.string().max(64),
      }),
    )
    .max(24)
    .default([]),
  unavailableItems: z.array(motionUnavailableItemSchema).max(64).default([]),
  warnings: z.array(z.string().max(400)).max(32).default([]),
});

export type MotionSpec = z.infer<typeof motionSpecSchema>;

export function summarizeMotionSpecCounts(spec: MotionSpec): {
  declaredCount: number;
  observedCount: number;
  inferredCount: number;
  unavailableCount: number;
  replayableCount: number;
  categories: Record<MotionCategory, number>;
} {
  let declaredCount = 0;
  let observedCount = 0;
  let inferredCount = 0;
  let replayableCount = 0;
  const categories: Record<MotionCategory, number> = {
    css_animation: 0,
    css_transition: 0,
    waapi: 0,
    js_driven: 0,
    scroll_driven: 0,
    canvas_gpu: 0,
    imported: 0,
  };

  for (const track of spec.tracks) {
    categories[track.category] += 1;
    if (track.evidenceClass === 'declared') declaredCount += 1;
    else if (track.evidenceClass === 'observed') observedCount += 1;
    else if (track.evidenceClass === 'inferred') inferredCount += 1;
    if (track.replaySupported) replayableCount += 1;
  }

  return {
    declaredCount,
    observedCount,
    inferredCount,
    unavailableCount:
      spec.tracks.filter((t) => t.evidenceClass === 'unavailable').length +
      spec.unavailableItems.length,
    replayableCount,
    categories,
  };
}

export function generateMotionMd(
  spec: MotionSpec,
  comparisonSummary?: {
    status: string;
    compatible: boolean;
    meanMismatchPct?: number | null;
    maxTimingErrorMs?: number | null;
    notes?: string[];
  },
): string {
  const counts = summarizeMotionSpecCounts(spec);
  const lines: string[] = [
    `# MOTION.md: ${spec.environment.pageTitle || spec.rootSelector}`,
    '',
    `- **Schema Version**: \`v${spec.schemaVersion}\``,
    `- **Source**: \`${spec.sourceKind}\` (${spec.environment.pageUrl})`,
    `- **Root Scope**: \`${spec.rootSelector}\``,
    `- **Viewport & DPR**: \`${spec.environment.viewport.width}x${spec.environment.viewport.height}\` @ \`${spec.environment.devicePixelRatio}x\``,
    `- **Session State**: \`${spec.session.state}\` (${Math.round(spec.session.observedDurationMs)} ms, ${spec.session.sampleCount} samples${spec.session.measuredMeanFps ? `, ~${spec.session.measuredMeanFps.toFixed(1)} fps` : ''})`,
    `- **Evidence Breakdown**: ${counts.declaredCount} declared · ${counts.observedCount} observed · ${counts.inferredCount} inferred · ${counts.unavailableCount} unavailable`,
    '',
    '> Evidence note: **Declared** values come directly from CSS/WAAPI; **Observed** values are measured during live sampling; **Inferred** values (curves, overshoot-based springs) are non-unique estimates from samples and are not exact original source code.',
    '',
  ];

  if (spec.session.interruptionReason) {
    lines.push(`> Session interruption: ${spec.session.interruptionReason}`, '');
  }

  lines.push('## Static Layout & Coordinate Context', '');
  if (spec.targets.length === 0) {
    lines.push('- No target elements captured.');
  } else {
    lines.push(
      '| Target | Box (x, y, w, h) | Transform Origin | Clipping Ancestors | Nested Transforms |',
    );
    lines.push('| --- | --- | --- | --- | --- |');
    for (const t of spec.targets) {
      const box = `${Math.round(t.initialBox.x)}, ${Math.round(t.initialBox.y)}, ${Math.round(t.initialBox.width)}, ${Math.round(t.initialBox.height)}`;
      const clips =
        t.clippingAncestors
          .map((c) => `${c.selector} (${c.overflowX}/${c.overflowY})`)
          .join(', ') || 'none';
      const nested = t.nestedTransformAncestors.map((n) => n.selector).join(', ') || 'none';
      lines.push(
        `| \`${t.selector}\` | \`${box}\` | \`${t.transformOrigin}\` | ${clips} | ${nested} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Motion Timeline & Tracks', '');
  if (spec.tracks.length === 0) {
    lines.push('- No animated tracks were detected during this session.');
  } else {
    lines.push(
      '| Selector | Property | Category | Evidence | Domain | Delay | Duration | From -> To | Easing / Estimate | Stagger |',
    );
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const tr of spec.tracks) {
      const easingLabel = tr.declaredEasing
        ? `Declared: \`${tr.declaredEasing}\``
        : tr.inferredEasings[0]
          ? `Inferred: \`${tr.inferredEasings[0].cssEasing}\` (RMSE ${tr.inferredEasings[0].rmse.toFixed(3)})`
          : 'n/a';
      const delayStr = tr.delayMs !== null ? `${Math.round(tr.delayMs)} ms` : 'n/a';
      const durStr =
        tr.timelineDomain === 'scroll_progress_percent' ||
        tr.timelineDomain === 'view_progress_percent'
          ? `${tr.progressStartPct ?? 0}% -> ${tr.progressEndPct ?? 100}%`
          : tr.durationMs !== null
            ? `${Math.round(tr.durationMs)} ms`
            : 'n/a';
      const valStr = `${String(tr.fromValue ?? 'n/a')} -> ${String(tr.toValue ?? 'n/a')}`;
      const staggerStr =
        tr.staggerFromPrevMs !== null ? `+${Math.round(tr.staggerFromPrevMs)} ms` : '-';
      lines.push(
        `| \`${tr.selector}\` | \`${tr.property}\` | ${tr.category} | **${tr.evidenceClass}** | ${tr.timelineDomain} | ${delayStr} | ${durStr} | \`${valStr}\` | ${easingLabel} | ${staggerStr} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Unavailable & Unsupported Signals', '');
  if (spec.unavailableItems.length === 0 && spec.warnings.length === 0) {
    lines.push('- None reported for the scoped target.');
  } else {
    for (const u of spec.unavailableItems) {
      lines.push(`- **${u.category}** (\`${u.target}\`): ${u.reason}`);
    }
    for (const w of spec.warnings) {
      lines.push(`- Warning: ${w}`);
    }
  }
  lines.push('');

  lines.push('## Reference vs Reconstruction Comparison', '');
  if (!comparisonSummary || comparisonSummary.status === 'not_compared') {
    lines.push('- Status: **Not compared** (no independent reconstruction capture supplied yet).');
  } else {
    lines.push(
      `- Status: **${comparisonSummary.status}** (Compatible setup: ${comparisonSummary.compatible ? 'Yes' : 'No'})`,
    );
    if (
      comparisonSummary.maxTimingErrorMs !== undefined &&
      comparisonSummary.maxTimingErrorMs !== null
    ) {
      lines.push(`- Max Timing Error: ${comparisonSummary.maxTimingErrorMs.toFixed(1)} ms`);
    }
    if (
      comparisonSummary.meanMismatchPct !== undefined &&
      comparisonSummary.meanMismatchPct !== null
    ) {
      lines.push(`- Mean Pixel Mismatch: ${comparisonSummary.meanMismatchPct.toFixed(2)}%`);
    }
    for (const note of comparisonSummary.notes ?? []) {
      lines.push(`- ${note}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
