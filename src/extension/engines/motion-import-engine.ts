import { unzipSync } from 'fflate';
import { z } from 'zod';
import {
  MOTION_CAPTURE_DEFAULTS,
  MOTION_SPEC_SCHEMA_VERSION,
  motionSpecSchema,
  type MotionSpec,
  type MotionTrack,
  type MotionTargetIdentity,
  type MotionUnavailableItem,
} from './motion-spec.js';

export const MOTION_IMPORT_LIMITS = {
  maxArchiveBytes: 25 * 1024 * 1024,
  maxFileCount: 128,
  maxJsonBytes: 4 * 1024 * 1024,
  maxMediaBytes: 20 * 1024 * 1024,
  maxDimensionPx: 8192,
  maxJsonDepth: 16,
  maxMediaDurationSec: 60,
} as const;

const DISALLOWED_EXECUTABLE_EXTENSIONS = [
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.html',
  '.htm',
  '.svg',
  '.sh',
  '.bat',
  '.cmd',
  '.ps1',
  '.exe',
  '.dll',
  '.dylib',
  '.so',
];

const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const ALLOWED_VIDEO_MIME = new Set(['video/webm']);

const reanimateCaptureSchema = z.object({
  url: z.string().max(2048).optional(),
  viewport: z
    .object({
      width: z.number().int().min(1).max(MOTION_IMPORT_LIMITS.maxDimensionPx),
      height: z.number().int().min(1).max(MOTION_IMPORT_LIMITS.maxDimensionPx),
    })
    .optional(),
  deviceScaleFactor: z.number().min(0.1).max(16).optional(),
  durationMs: z.number().min(0).max(300000).optional(),
  fps: z.number().min(1).max(240).optional(),
  trigger: z.string().max(64).optional(),
  clockMode: z.string().max(32).optional(),
  glEnabled: z.boolean().optional(),
  crop: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number().min(0),
      height: z.number().min(0),
    })
    .optional(),
});

const reanimateTrackSchema = z.object({
  durationMs: z.number().min(0).max(300000).optional(),
  samples: z
    .array(
      z.object({
        t: z.number(),
        selector: z.string().max(512).optional(),
        property: z.string().max(128).optional(),
        value: z.union([z.number(), z.string().max(512)]).optional(),
        box: z
          .object({
            x: z.number(),
            y: z.number(),
            width: z.number().min(0),
            height: z.number().min(0),
          })
          .optional(),
        opacity: z.number().optional(),
        transform: z.string().max(512).optional(),
      }),
    )
    .max(5000)
    .optional(),
  targets: z
    .array(
      z.object({
        selector: z.string().max(512),
        tag: z.string().max(64).optional(),
        box: z
          .object({
            x: z.number(),
            y: z.number(),
            width: z.number().min(0),
            height: z.number().min(0),
          })
          .optional(),
        startMs: z.number().optional(),
        endMs: z.number().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .max(64)
    .optional(),
});

const reanimateInspectSchema = z.object({
  url: z.string().max(2048).optional(),
  title: z.string().max(300).optional(),
  animations: z
    .array(
      z.object({
        name: z.string().max(160).optional(),
        target: z.string().max(512).optional(),
        type: z.string().max(64).optional(),
        duration: z.union([z.number(), z.string()]).optional(),
        delay: z.union([z.number(), z.string()]).optional(),
        easing: z.string().max(160).optional(),
        iterations: z.union([z.number(), z.string()]).optional(),
        keyframes: z.array(z.record(z.string(), z.unknown())).max(64).optional(),
      }),
    )
    .max(256)
    .optional(),
  inaccessibleStylesheets: z.number().int().min(0).optional(),
});

const reanimateGlSchema = z.object({
  contexts: z
    .array(
      z.object({
        id: z.string().max(128).optional(),
        kind: z.string().max(64).optional(),
        width: z.number().int().min(0).max(MOTION_IMPORT_LIMITS.maxDimensionPx).optional(),
        height: z.number().int().min(0).max(MOTION_IMPORT_LIMITS.maxDimensionPx).optional(),
        programCount: z.number().int().min(0).optional(),
        drawCallCount: z.number().int().min(0).optional(),
      }),
    )
    .max(32)
    .optional(),
  uniformChannels: z.array(z.string().max(160)).max(128).optional(),
});

export interface ImportedMediaAsset {
  filename: string;
  mimeType: string;
  byteLength: number;
  bytes: Uint8Array;
}

export interface MotionImportResult {
  spec: MotionSpec;
  mediaAssets: ImportedMediaAsset[];
  warnings: string[];
  rejectedEntries: string[];
}

export interface ImportedMediaValidationInput {
  filename: string;
  mimeType: string;
  byteLength: number;
  width?: number;
  height?: number;
  durationSec?: number;
}

export function validateImportedMediaDescriptor(input: ImportedMediaValidationInput): {
  valid: boolean;
  reason?: string;
} {
  const isImage = ALLOWED_IMAGE_MIME.has(input.mimeType);
  const isVideo = ALLOWED_VIDEO_MIME.has(input.mimeType);
  if (!isImage && !isVideo) {
    return {
      valid: false,
      reason: `Unsupported media format "${input.mimeType}" for "${input.filename}". Supported formats: PNG, JPEG, WebP, WebM.`,
    };
  }
  if (input.byteLength <= 0) {
    return { valid: false, reason: `Media "${input.filename}" is empty.` };
  }
  if (input.byteLength > MOTION_IMPORT_LIMITS.maxMediaBytes) {
    return {
      valid: false,
      reason: `Media "${input.filename}" exceeds the ${Math.round(MOTION_IMPORT_LIMITS.maxMediaBytes / (1024 * 1024))} MB limit.`,
    };
  }
  if (
    typeof input.width === 'number' &&
    (input.width <= 0 || input.width > MOTION_IMPORT_LIMITS.maxDimensionPx)
  ) {
    return {
      valid: false,
      reason: `Media "${input.filename}" width (${input.width}px) exceeds bounds (1..${MOTION_IMPORT_LIMITS.maxDimensionPx}px).`,
    };
  }
  if (
    typeof input.height === 'number' &&
    (input.height <= 0 || input.height > MOTION_IMPORT_LIMITS.maxDimensionPx)
  ) {
    return {
      valid: false,
      reason: `Media "${input.filename}" height (${input.height}px) exceeds bounds (1..${MOTION_IMPORT_LIMITS.maxDimensionPx}px).`,
    };
  }
  if (
    typeof input.durationSec === 'number' &&
    (input.durationSec < 0 || input.durationSec > MOTION_IMPORT_LIMITS.maxMediaDurationSec)
  ) {
    return {
      valid: false,
      reason: `Video "${input.filename}" duration (${input.durationSec.toFixed(1)}s) exceeds the ${MOTION_IMPORT_LIMITS.maxMediaDurationSec}s limit.`,
    };
  }
  return { valid: true };
}

function isSafeArchivePath(entryName: string): boolean {
  if (!entryName || entryName.length > 260) return false;
  if (entryName.startsWith('/') || entryName.startsWith('\\')) return false;
  if (entryName.includes('..') || entryName.includes('\0') || entryName.includes('\\')) {
    return false;
  }
  const lower = entryName.toLowerCase();
  for (const ext of DISALLOWED_EXECUTABLE_EXTENSIONS) {
    if (lower.endsWith(ext)) return false;
  }
  return true;
}

function measureJsonDepth(value: unknown, currentDepth = 0): number {
  if (currentDepth > MOTION_IMPORT_LIMITS.maxJsonDepth) return currentDepth;
  if (value === null || typeof value !== 'object') return currentDepth;
  if (Array.isArray(value)) {
    let maxD = currentDepth;
    for (const item of value) {
      maxD = Math.max(maxD, measureJsonDepth(item, currentDepth + 1));
      if (maxD > MOTION_IMPORT_LIMITS.maxJsonDepth) return maxD;
    }
    return maxD;
  }
  let maxD = currentDepth;
  for (const child of Object.values(value as Record<string, unknown>)) {
    maxD = Math.max(maxD, measureJsonDepth(child, currentDepth + 1));
    if (maxD > MOTION_IMPORT_LIMITS.maxJsonDepth) return maxD;
  }
  return maxD;
}

function safeParseJsonBytes(bytes: Uint8Array, label: string): unknown {
  if (bytes.byteLength > MOTION_IMPORT_LIMITS.maxJsonBytes) {
    throw new Error(
      `${label} exceeds maximum JSON size (${MOTION_IMPORT_LIMITS.maxJsonBytes} bytes).`,
    );
  }
  const text = new TextDecoder().decode(bytes);
  const parsed: unknown = JSON.parse(text);
  const depth = measureJsonDepth(parsed, 0);
  if (depth > MOTION_IMPORT_LIMITS.maxJsonDepth) {
    throw new Error(
      `${label} exceeds maximum JSON nesting depth (${MOTION_IMPORT_LIMITS.maxJsonDepth}).`,
    );
  }
  return parsed;
}

function parseReanimateDataToSpec(files: Map<string, Uint8Array>): {
  spec: MotionSpec;
  warnings: string[];
} {
  const warnings: string[] = [];
  const motionSpecEntry = files.get('motion-spec.json');
  if (motionSpecEntry) {
    const parsed = safeParseJsonBytes(motionSpecEntry, 'motion-spec.json');
    const validated = motionSpecSchema.parse(parsed);
    return { spec: validated, warnings };
  }

  let captureData: z.infer<typeof reanimateCaptureSchema> | null = null;
  let inspectData: z.infer<typeof reanimateInspectSchema> | null = null;
  let trackData: z.infer<typeof reanimateTrackSchema> | null = null;
  let glData: z.infer<typeof reanimateGlSchema> | null = null;

  for (const [name, bytes] of files.entries()) {
    const base = name.split('/').pop()?.toLowerCase() ?? '';
    const parsedUnknown = safeParseJsonBytes(bytes, name);
    const obj =
      parsedUnknown && typeof parsedUnknown === 'object' && !Array.isArray(parsedUnknown)
        ? (parsedUnknown as Record<string, unknown>)
        : null;
    if (obj && 'schemaVersion' in obj && 'tracks' in obj) {
      return { spec: motionSpecSchema.parse(parsedUnknown), warnings };
    }
    if (base === 'capture.json' || (obj && ('viewport' in obj || 'deviceScaleFactor' in obj))) {
      captureData = reanimateCaptureSchema.parse(parsedUnknown);
    } else if (base === 'inspect.json' || (obj && 'animations' in obj)) {
      inspectData = reanimateInspectSchema.parse(parsedUnknown);
    } else if (base === 'track.json' || (obj && ('targets' in obj || 'samples' in obj))) {
      trackData = reanimateTrackSchema.parse(parsedUnknown);
    } else if (base === 'gl.json' || base === 'gl-track.json' || (obj && 'contexts' in obj)) {
      glData = reanimateGlSchema.parse(parsedUnknown);
    }
  }

  if (!captureData && !inspectData && !trackData && !glData) {
    throw new Error(
      'No supported MotionSpec or Reanimate artifact JSON (capture.json, inspect.json, track.json, gl.json) found.',
    );
  }

  const targets: MotionTargetIdentity[] = [];
  const tracks: MotionTrack[] = [];
  const unavailableItems: MotionUnavailableItem[] = [];
  const targetIdMap = new Map<string, string>();

  const ensureTarget = (
    selector: string,
    tagName = 'div',
    box = { x: 0, y: 0, width: 100, height: 100 },
  ): string => {
    const existing = targetIdMap.get(selector);
    if (existing) return existing;
    if (targets.length >= MOTION_CAPTURE_DEFAULTS.maxTargets) {
      return targets[0]?.targetId ?? 't1';
    }
    const targetId = `imp-target-${targets.length + 1}`;
    targetIdMap.set(selector, targetId);
    targets.push({
      targetId,
      selector: selector.slice(0, 512),
      tagName: tagName.slice(0, 64),
      role: null,
      accessibleName: null,
      insideOpenShadowRoot: false,
      initialBox: box,
      transformOrigin: '50% 50% 0px',
      clippingAncestors: [],
      nestedTransformAncestors: [],
    });
    return targetId;
  };

  if (inspectData?.animations) {
    for (let i = 0; i < inspectData.animations.length; i += 1) {
      if (tracks.length >= 120) break;
      const anim = inspectData.animations[i];
      if (!anim) continue;
      const selector = anim.target ?? 'body';
      const targetId = ensureTarget(selector);
      const durationMs = typeof anim.duration === 'number' ? anim.duration : null;
      const delayMs = typeof anim.delay === 'number' ? anim.delay : 0;
      const kind = (anim.type ?? '').toLowerCase();
      const category = kind.includes('transition')
        ? 'css_transition'
        : kind.includes('waapi')
          ? 'waapi'
          : 'imported';

      tracks.push({
        trackId: `imp-inspect-${i + 1}`,
        targetId,
        selector,
        property: 'transform',
        category,
        evidenceClass: category === 'imported' ? 'observed' : 'declared',
        trigger: 'imported',
        timelineDomain: 'time_ms',
        animationName: anim.name ?? null,
        playState: 'finished',
        composite: null,
        startMs: delayMs,
        endMs: durationMs !== null ? delayMs + durationMs : null,
        delayMs,
        durationMs,
        endDelayMs: 0,
        iterations: typeof anim.iterations === 'number' ? anim.iterations : 1,
        direction: null,
        fillMode: null,
        progressStartPct: null,
        progressEndPct: null,
        fromValue: null,
        toValue: null,
        unit: '',
        directionHint: 'unknown',
        normalizedTravel: null,
        overshootPct: null,
        settleTimeMs: null,
        staggerFromPrevMs: null,
        declaredEasing: anim.easing ?? null,
        inferredEasings: [],
        residualError: null,
        inferenceConfidence: null,
        keyframes: [],
        samples: [],
        hasMotion: true,
        isConstant: false,
        replaySupported: false,
        unsupportedReason:
          'Imported inspect.json declaration; check timing/keyframes before replay.',
        notes: ['Imported from Reanimate inspect.json as inert evidence.'],
      });
    }
  }

  if (trackData?.targets) {
    for (let i = 0; i < trackData.targets.length; i += 1) {
      if (tracks.length >= 120) break;
      const item = trackData.targets[i];
      if (!item) continue;
      const targetId = ensureTarget(item.selector, item.tag ?? 'div', item.box);
      tracks.push({
        trackId: `imp-track-${i + 1}`,
        targetId,
        selector: item.selector,
        property: 'transform',
        category: 'imported',
        evidenceClass: 'observed',
        trigger: 'imported',
        timelineDomain: 'time_ms',
        animationName: null,
        playState: null,
        composite: null,
        startMs: item.startMs ?? 0,
        endMs: item.endMs ?? trackData.durationMs ?? null,
        delayMs: item.startMs ?? 0,
        durationMs:
          item.endMs !== undefined && item.startMs !== undefined
            ? Math.max(0, item.endMs - item.startMs)
            : (trackData.durationMs ?? null),
        endDelayMs: 0,
        iterations: 1,
        direction: null,
        fillMode: null,
        progressStartPct: null,
        progressEndPct: null,
        fromValue: null,
        toValue: null,
        unit: '',
        directionHint: 'unknown',
        normalizedTravel: null,
        overshootPct: null,
        settleTimeMs: null,
        staggerFromPrevMs: null,
        declaredEasing: null,
        inferredEasings: [],
        residualError: null,
        inferenceConfidence: null,
        keyframes: [],
        samples: [],
        hasMotion: true,
        isConstant: false,
        replaySupported: false,
        unsupportedReason: 'Imported summary track without numeric sample series.',
        notes: ['Imported from Reanimate track.json.'],
      });
    }
  }

  if (trackData?.samples && trackData.samples.length > 0) {
    const grouped = new Map<string, Array<{ tMs: number; value: number | string }>>();
    for (const sample of trackData.samples.slice(0, MOTION_CAPTURE_DEFAULTS.maxSamplesPerTarget)) {
      const sel = sample.selector ?? 'body';
      const prop = sample.property ?? (sample.opacity !== undefined ? 'opacity' : 'transform');
      const key = `${sel}::${prop}`;
      const list = grouped.get(key) ?? [];
      const val =
        sample.value ?? sample.opacity ?? sample.transform ?? (sample.box ? sample.box.x : 0);
      list.push({ tMs: sample.t, value: val });
      grouped.set(key, list);
    }

    let idx = 0;
    for (const [key, series] of grouped.entries()) {
      if (tracks.length >= 120) break;
      idx += 1;
      const [selector = 'body', property = 'transform'] = key.split('::');
      const targetId = ensureTarget(selector);
      const first = series[0];
      const last = series[series.length - 1];
      tracks.push({
        trackId: `imp-samples-${idx}`,
        targetId,
        selector,
        property,
        category: 'imported',
        evidenceClass: 'observed',
        trigger: 'imported',
        timelineDomain: 'time_ms',
        animationName: null,
        playState: null,
        composite: null,
        startMs: first ? first.tMs : 0,
        endMs: last ? last.tMs : null,
        delayMs: first ? first.tMs : 0,
        durationMs: first && last ? Math.max(0, last.tMs - first.tMs) : null,
        endDelayMs: 0,
        iterations: 1,
        direction: null,
        fillMode: null,
        progressStartPct: null,
        progressEndPct: null,
        fromValue: first ? first.value : null,
        toValue: last ? last.value : null,
        unit: '',
        directionHint: 'unknown',
        normalizedTravel: null,
        overshootPct: null,
        settleTimeMs: null,
        staggerFromPrevMs: null,
        declaredEasing: null,
        inferredEasings: [],
        residualError: null,
        inferenceConfidence: null,
        keyframes: [],
        samples: series.map((pt) => ({
          tMs: pt.tMs,
          scrollX: 0,
          scrollY: 0,
          value: pt.value,
        })),
        hasMotion: series.length > 1,
        isConstant: false,
        replaySupported: property === 'opacity' && typeof first?.value === 'number',
        unsupportedReason:
          property === 'opacity'
            ? null
            : 'Imported raw sample series kept as evidence; inspect before synthesis.',
        notes: ['Imported from Reanimate track.json samples.'],
      });
    }
  }

  if (inspectData?.inaccessibleStylesheets && inspectData.inaccessibleStylesheets > 0) {
    unavailableItems.push({
      category: 'css_animation',
      target: 'document',
      reason: `Reanimate inspect reported ${inspectData.inaccessibleStylesheets} inaccessible cross-origin stylesheet(s).`,
    });
  }

  if (glData?.contexts && glData.contexts.length > 0) {
    unavailableItems.push({
      category: 'canvas_gpu',
      target: glData.contexts[0]?.id ?? 'webgl',
      reason: `Imported Reanimate GL metadata (${glData.contexts.length} context(s), ${glData.uniformChannels?.length ?? 0} uniform channels) as read-only evidence.`,
    });
  }

  const nowIso = new Date().toISOString();
  const durationMs =
    captureData?.durationMs ??
    trackData?.durationMs ??
    Math.max(0, ...tracks.map((t) => t.endMs ?? 0));

  const spec: MotionSpec = motionSpecSchema.parse({
    schemaVersion: MOTION_SPEC_SCHEMA_VERSION,
    specId: `import-${Date.now().toString(36)}`,
    sourceKind: 'reanimate_import',
    environment: {
      pageUrl: captureData?.url ?? inspectData?.url ?? 'about:blank',
      pageTitle: inspectData?.title ?? 'Imported Reanimate Capture',
      viewport: captureData?.viewport ?? { width: 1280, height: 800 },
      devicePixelRatio: captureData?.deviceScaleFactor ?? 1,
      scrollPosition: { x: 0, y: 0 },
      reducedMotionPreference: 'unknown',
      cropRect: captureData?.crop ?? null,
      coordinateSpace: 'viewport_css_px',
    },
    session: {
      sessionId: `import-session-${Date.now().toString(36)}`,
      state: 'imported',
      startedAtIso: nowIso,
      completedAtIso: nowIso,
      observedDurationMs: durationMs,
      sampleCount: tracks.reduce((acc, t) => acc + t.samples.length, 0),
      droppedSamplesEstimate: 0,
      measuredMeanFps: captureData?.fps ?? null,
      interruptionReason: null,
      visualRecordingStatus: 'none',
      visualMediaId: null,
      visualFrameCount: 0,
    },
    rootSelector: targets[0]?.selector ?? 'body',
    targets,
    tracks,
    detectedEngines: ['reanimate-import'],
    canvasesDetected: (glData?.contexts ?? []).map((c, idx) => ({
      selector: c.id ?? `canvas-${idx + 1}`,
      width: c.width ?? 0,
      height: c.height ?? 0,
      contextHint: c.kind ?? 'webgl',
    })),
    unavailableItems,
    warnings,
  });

  return { spec, warnings };
}

export function importReanimateZipBytes(zipBytes: Uint8Array): MotionImportResult {
  if (zipBytes.byteLength === 0) {
    throw new Error('Imported archive is empty.');
  }
  if (zipBytes.byteLength > MOTION_IMPORT_LIMITS.maxArchiveBytes) {
    throw new Error(
      `Imported archive (${zipBytes.byteLength} bytes) exceeds ${Math.round(MOTION_IMPORT_LIMITS.maxArchiveBytes / (1024 * 1024))} MB maximum.`,
    );
  }

  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(zipBytes);
  } catch (err) {
    throw new Error(`Invalid ZIP archive: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }

  const entries = Object.entries(unzipped);
  if (entries.length > MOTION_IMPORT_LIMITS.maxFileCount) {
    throw new Error(
      `Imported archive contains ${entries.length} entries, exceeding the ${MOTION_IMPORT_LIMITS.maxFileCount}-file limit.`,
    );
  }

  const jsonFiles = new Map<string, Uint8Array>();
  const mediaAssets: ImportedMediaAsset[] = [];
  const warnings: string[] = [];
  const rejectedEntries: string[] = [];

  for (const [entryName, bytes] of entries) {
    if (entryName.endsWith('/')) continue;
    if (!isSafeArchivePath(entryName)) {
      rejectedEntries.push(entryName);
      warnings.push(`Rejected unsafe or executable entry "${entryName}".`);
      continue;
    }

    const lower = entryName.toLowerCase();
    if (lower.endsWith('.json')) {
      jsonFiles.set(entryName, bytes);
    } else if (
      lower.endsWith('.png') ||
      lower.endsWith('.jpg') ||
      lower.endsWith('.jpeg') ||
      lower.endsWith('.webp') ||
      lower.endsWith('.webm')
    ) {
      const mimeType = lower.endsWith('.png')
        ? 'image/png'
        : lower.endsWith('.webp')
          ? 'image/webp'
          : lower.endsWith('.webm')
            ? 'video/webm'
            : 'image/jpeg';
      const check = validateImportedMediaDescriptor({
        filename: entryName,
        mimeType,
        byteLength: bytes.byteLength,
      });
      if (!check.valid) {
        rejectedEntries.push(entryName);
        warnings.push(check.reason ?? `Rejected media entry "${entryName}".`);
        continue;
      }
      mediaAssets.push({
        filename: entryName,
        mimeType,
        byteLength: bytes.byteLength,
        bytes,
      });
    } else {
      rejectedEntries.push(entryName);
      warnings.push(`Ignored unsupported archive entry "${entryName}".`);
    }
  }

  const { spec, warnings: specWarnings } = parseReanimateDataToSpec(jsonFiles);
  return {
    spec,
    mediaAssets,
    warnings: [...warnings, ...specWarnings],
    rejectedEntries,
  };
}

export function importReanimateJsonText(
  jsonText: string,
  filename = 'motion-spec.json',
): MotionImportResult {
  const bytes = new TextEncoder().encode(jsonText);
  const files = new Map<string, Uint8Array>([[filename, bytes]]);
  const { spec, warnings } = parseReanimateDataToSpec(files);
  return {
    spec,
    mediaAssets: [],
    warnings,
    rejectedEntries: [],
  };
}

export function buildReanimateHandoffRecipe(spec: MotionSpec): {
  cliCommand: string;
  captureConfigJson: string;
  explanation: string;
} {
  const durationMs = Math.max(1000, Math.round(spec.session.observedDurationMs || 3000));
  const width = spec.environment.viewport.width;
  const height = spec.environment.viewport.height;
  const hasCanvas = spec.canvasesDetected.length > 0;
  const url = spec.environment.pageUrl || 'https://example.com';

  const captureConfig = {
    url,
    viewport: { width, height },
    deviceScaleFactor: spec.environment.devicePixelRatio,
    durationMs,
    fps: Math.round(spec.session.measuredMeanFps ?? 60),
    selector: spec.rootSelector,
    clock: 'virtual',
    gl: hasCanvas,
    crop: spec.environment.cropRect,
  };

  const flags = [
    `--url ${JSON.stringify(url)}`,
    `--out ./reanimate-capture`,
    `--viewport ${width}x${height}`,
    `--duration ${durationMs}`,
    `--clock virtual`,
  ];
  if (hasCanvas) {
    flags.push('--gl');
  }
  if (spec.environment.cropRect) {
    const c = spec.environment.cropRect;
    flags.push(
      `--crop ${Math.round(c.x)},${Math.round(c.y)},${Math.round(c.width)},${Math.round(c.height)}`,
    );
  }

  return {
    cliCommand: `bun run scripts/capture.ts ${flags.join(' ')}`,
    captureConfigJson: JSON.stringify(captureConfig, null, 2),
    explanation: hasCanvas
      ? 'Canvas/WebGL/WebGPU targets were detected. Live Chrome MV3 extensions attach after initial page execution and cannot recover shaders/uniforms already compiled or use deterministic virtual clock hooks globally. Run Reanimate outside the extension via Playwright (--clock virtual --gl), then import the resulting ZIP/JSON back into PageSift Motion Lab.'
      : 'Use this recipe with Reanimate (Playwright external runner) if you want deterministic --clock virtual multi-pass frame capture, then import capture.json/track.json/frames back into Motion Lab for comparison.',
  };
}
