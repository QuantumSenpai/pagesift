import type { MotionSpec, MotionTrack } from './motion-spec.js';
import { summarizeMotionSpecCounts } from './motion-spec.js';

export interface MotionCaptureSetup {
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  cropRect: { x: number; y: number; width: number; height: number } | null;
  trigger: string;
  durationMs: number;
  timelineDomain: string;
  fps?: number | null;
}

export interface MotionCompatibilityResult {
  compatible: boolean;
  mismatches: string[];
  warnings: string[];
}

export interface MotionRgbaFrame {
  tMs: number;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export interface MotionFrameActivityPoint {
  tMs: number;
  activity: number;
  mismatchPct: number;
  blurredMismatchPct: number;
}

export interface MotionWindowSummary {
  startMs: number | null;
  peakMs: number | null;
  endMs: number | null;
  durationMs: number;
}

export interface MotionVisualDiffResult {
  frameCountCompared: number;
  rawMeanMismatchPct: number;
  rawPeakMismatchPct: number;
  blurredMeanMismatchPct: number;
  alignedOffsetMs: number;
  alignedMeanMismatchPct: number;
  referenceWindow: MotionWindowSummary;
  candidateWindow: MotionWindowSummary;
  startErrorMs: number | null;
  peakErrorMs: number | null;
  endErrorMs: number | null;
  durationErrorMs: number | null;
  perFrame: MotionFrameActivityPoint[];
}

export interface MotionTrackComparison {
  trackId: string;
  property: string;
  selector: string;
  matched: boolean;
  startErrorMs: number | null;
  durationErrorMs: number | null;
  valueRmse: number | null;
  residualNote: string;
}

export interface MotionComparisonThresholds {
  timingToleranceMs: number;
  valueTolerance: number;
  pixelMismatchTolerancePct: number;
  blurredMismatchTolerancePct: number;
  noiseFloorMismatchPct: number;
}

export const DEFAULT_COMPARISON_THRESHOLDS: MotionComparisonThresholds = {
  timingToleranceMs: 60,
  valueTolerance: 2.5,
  pixelMismatchTolerancePct: 3.5,
  blurredMismatchTolerancePct: 1.5,
  noiseFloorMismatchPct: 0,
};

export type MotionComparisonVerdict =
  | 'not_compared'
  | 'matched'
  | 'close_with_offset'
  | 'diverged'
  | 'incompatible_setup';

export interface MotionComparisonReport {
  status: MotionComparisonVerdict;
  compatible: boolean;
  compatibilityMismatches: string[];
  compatibilityWarnings: string[];
  thresholds: MotionComparisonThresholds;
  trackComparisons: MotionTrackComparison[];
  maxTimingErrorMs: number | null;
  maxValueRmse: number | null;
  visualDiff: MotionVisualDiffResult | null;
  notes: string[];
}

export function extractSetupFromMotionSpec(spec: MotionSpec): MotionCaptureSetup {
  const firstTrack = spec.tracks[0];
  return {
    viewport: {
      width: spec.environment.viewport.width,
      height: spec.environment.viewport.height,
    },
    devicePixelRatio: spec.environment.devicePixelRatio,
    cropRect: spec.environment.cropRect,
    trigger: firstTrack ? firstTrack.trigger : 'manual',
    durationMs: spec.session.observedDurationMs,
    timelineDomain: firstTrack ? firstTrack.timelineDomain : 'time_ms',
    fps: spec.session.measuredMeanFps,
  };
}

export function checkMotionCaptureCompatibility(
  reference: MotionCaptureSetup,
  candidate: MotionCaptureSetup,
): MotionCompatibilityResult {
  const mismatches: string[] = [];
  const warnings: string[] = [];

  if (
    reference.viewport.width !== candidate.viewport.width ||
    reference.viewport.height !== candidate.viewport.height
  ) {
    mismatches.push(
      `Viewport mismatch: reference ${reference.viewport.width}x${reference.viewport.height} vs candidate ${candidate.viewport.width}x${candidate.viewport.height}.`,
    );
  }

  if (Math.abs(reference.devicePixelRatio - candidate.devicePixelRatio) > 0.05) {
    mismatches.push(
      `Device pixel ratio mismatch: reference ${reference.devicePixelRatio}x vs candidate ${candidate.devicePixelRatio}x.`,
    );
  }

  if ((reference.cropRect === null) !== (candidate.cropRect === null)) {
    mismatches.push(
      'Crop configuration mismatch: one capture is cropped and the other is full-frame.',
    );
  } else if (reference.cropRect && candidate.cropRect) {
    const dx = Math.abs(reference.cropRect.x - candidate.cropRect.x);
    const dy = Math.abs(reference.cropRect.y - candidate.cropRect.y);
    const dw = Math.abs(reference.cropRect.width - candidate.cropRect.width);
    const dh = Math.abs(reference.cropRect.height - candidate.cropRect.height);
    if (dx > 2 || dy > 2 || dw > 2 || dh > 2) {
      mismatches.push(
        `Crop rectangle mismatch: reference (${reference.cropRect.x},${reference.cropRect.y},${reference.cropRect.width}x${reference.cropRect.height}) vs candidate (${candidate.cropRect.x},${candidate.cropRect.y},${candidate.cropRect.width}x${candidate.cropRect.height}).`,
      );
    }
  }

  if (reference.trigger !== candidate.trigger) {
    mismatches.push(
      `Trigger mismatch: reference "${reference.trigger}" vs candidate "${candidate.trigger}".`,
    );
  }

  if (reference.timelineDomain !== candidate.timelineDomain) {
    mismatches.push(
      `Timeline domain mismatch: reference "${reference.timelineDomain}" vs candidate "${candidate.timelineDomain}".`,
    );
  }

  const maxAllowedDurationDiff = Math.max(200, reference.durationMs * 0.25);
  if (
    reference.durationMs > 0 &&
    candidate.durationMs > 0 &&
    Math.abs(reference.durationMs - candidate.durationMs) > maxAllowedDurationDiff
  ) {
    warnings.push(
      `Observation duration differs significantly: reference ${Math.round(reference.durationMs)} ms vs candidate ${Math.round(candidate.durationMs)} ms.`,
    );
  }

  if (
    typeof reference.fps === 'number' &&
    typeof candidate.fps === 'number' &&
    reference.fps > 0 &&
    candidate.fps > 0
  ) {
    const relFpsDiff = Math.abs(reference.fps - candidate.fps) / reference.fps;
    if (relFpsDiff > 0.25) {
      warnings.push(
        `Sample cadence differs: reference ${reference.fps.toFixed(1)} fps vs candidate ${candidate.fps.toFixed(1)} fps.`,
      );
    }
  }

  return {
    compatible: mismatches.length === 0,
    mismatches,
    warnings,
  };
}

function boxBlur3x3(rgba: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let ky = -1; ky <= 1; ky += 1) {
        const ny = y + ky;
        if (ny < 0 || ny >= height) continue;
        for (let kx = -1; kx <= 1; kx += 1) {
          const nx = x + kx;
          if (nx < 0 || nx >= width) continue;
          const idx = (ny * width + nx) * 4;
          r += rgba[idx] ?? 0;
          g += rgba[idx + 1] ?? 0;
          b += rgba[idx + 2] ?? 0;
          count += 1;
        }
      }
      const dst = (y * width + x) * 4;
      out[dst] = Math.round(r / Math.max(1, count));
      out[dst + 1] = Math.round(g / Math.max(1, count));
      out[dst + 2] = Math.round(b / Math.max(1, count));
      out[dst + 3] = rgba[dst + 3] ?? 255;
    }
  }
  return out;
}

function computeFramePairMismatchPct(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  pixelCount: number,
  channelThreshold: number,
): number {
  if (pixelCount <= 0) return 0;
  let changed = 0;
  for (let i = 0; i < pixelCount; i += 1) {
    const off = i * 4;
    const dr = Math.abs((a[off] ?? 0) - (b[off] ?? 0));
    const dg = Math.abs((a[off + 1] ?? 0) - (b[off + 1] ?? 0));
    const db = Math.abs((a[off + 2] ?? 0) - (b[off + 2] ?? 0));
    if (dr > channelThreshold || dg > channelThreshold || db > channelThreshold) {
      changed += 1;
    }
  }
  return (changed / pixelCount) * 100;
}

function computeActivityWindow(
  points: Array<{ tMs: number; activity: number }>,
): MotionWindowSummary {
  if (points.length === 0) {
    return { startMs: null, peakMs: null, endMs: null, durationMs: 0 };
  }
  let maxActivity = 0;
  let peakMs = points[0]?.tMs ?? null;
  for (const pt of points) {
    if (pt.activity > maxActivity) {
      maxActivity = pt.activity;
      peakMs = pt.tMs;
    }
  }
  if (maxActivity <= 0.002) {
    return { startMs: null, peakMs: null, endMs: null, durationMs: 0 };
  }
  const threshold = maxActivity * 0.1;
  let startMs: number | null = null;
  let endMs: number | null = null;
  for (const pt of points) {
    if (pt.activity >= threshold) {
      if (startMs === null) startMs = pt.tMs;
      endMs = pt.tMs;
    }
  }
  return {
    startMs,
    peakMs,
    endMs,
    durationMs: startMs !== null && endMs !== null ? Math.max(0, endMs - startMs) : 0,
  };
}

function computeFrameSequenceActivity(
  frames: readonly MotionRgbaFrame[],
  channelThreshold: number,
): Array<{ tMs: number; activity: number }> {
  const result: Array<{ tMs: number; activity: number }> = [];
  for (let i = 0; i < frames.length; i += 1) {
    const curr = frames[i];
    if (!curr) continue;
    if (i === 0) {
      result.push({ tMs: curr.tMs, activity: 0 });
      continue;
    }
    const prev = frames[i - 1];
    if (!prev || prev.width !== curr.width || prev.height !== curr.height) {
      result.push({ tMs: curr.tMs, activity: 0 });
      continue;
    }
    const pct = computeFramePairMismatchPct(
      prev.rgba,
      curr.rgba,
      curr.width * curr.height,
      channelThreshold,
    );
    result.push({ tMs: curr.tMs, activity: pct / 100 });
  }
  return result;
}

function findNearestFrame(
  frames: readonly MotionRgbaFrame[],
  targetMs: number,
): MotionRgbaFrame | null {
  if (frames.length === 0) return null;
  let best = frames[0] ?? null;
  let bestDist = best ? Math.abs(best.tMs - targetMs) : Infinity;
  for (let i = 1; i < frames.length; i += 1) {
    const f = frames[i];
    if (!f) continue;
    const dist = Math.abs(f.tMs - targetMs);
    if (dist < bestDist) {
      bestDist = dist;
      best = f;
    }
  }
  return best;
}

export function compareFrameSequences(
  referenceFrames: readonly MotionRgbaFrame[],
  candidateFrames: readonly MotionRgbaFrame[],
  options?: { channelThreshold?: number; maxAlignOffsetSteps?: number },
): MotionVisualDiffResult {
  const channelThreshold = options?.channelThreshold ?? 16;
  const maxSteps = options?.maxAlignOffsetSteps ?? 8;

  if (referenceFrames.length === 0 || candidateFrames.length === 0) {
    return {
      frameCountCompared: 0,
      rawMeanMismatchPct: 0,
      rawPeakMismatchPct: 0,
      blurredMeanMismatchPct: 0,
      alignedOffsetMs: 0,
      alignedMeanMismatchPct: 0,
      referenceWindow: { startMs: null, peakMs: null, endMs: null, durationMs: 0 },
      candidateWindow: { startMs: null, peakMs: null, endMs: null, durationMs: 0 },
      startErrorMs: null,
      peakErrorMs: null,
      endErrorMs: null,
      durationErrorMs: null,
      perFrame: [],
    };
  }

  const refActivity = computeFrameSequenceActivity(referenceFrames, channelThreshold);
  const candActivity = computeFrameSequenceActivity(candidateFrames, channelThreshold);
  const referenceWindow = computeActivityWindow(refActivity);
  const candidateWindow = computeActivityWindow(candActivity);

  const perFrame: MotionFrameActivityPoint[] = [];
  let sumMismatch = 0;
  let sumBlurredMismatch = 0;
  let peakMismatch = 0;

  for (let i = 0; i < referenceFrames.length; i += 1) {
    const refFrame = referenceFrames[i];
    if (!refFrame) continue;
    const candFrame = findNearestFrame(candidateFrames, refFrame.tMs);
    if (!candFrame || candFrame.width !== refFrame.width || candFrame.height !== refFrame.height) {
      continue;
    }
    const pixelCount = refFrame.width * refFrame.height;
    const mismatchPct = computeFramePairMismatchPct(
      refFrame.rgba,
      candFrame.rgba,
      pixelCount,
      channelThreshold,
    );
    const refBlur = boxBlur3x3(refFrame.rgba, refFrame.width, refFrame.height);
    const candBlur = boxBlur3x3(candFrame.rgba, candFrame.width, candFrame.height);
    const blurredMismatchPct = computeFramePairMismatchPct(
      refBlur,
      candBlur,
      pixelCount,
      channelThreshold,
    );

    sumMismatch += mismatchPct;
    sumBlurredMismatch += blurredMismatchPct;
    if (mismatchPct > peakMismatch) peakMismatch = mismatchPct;

    perFrame.push({
      tMs: refFrame.tMs,
      activity: refActivity[i]?.activity ?? 0,
      mismatchPct,
      blurredMismatchPct,
    });
  }

  const compared = perFrame.length;
  const rawMeanMismatchPct = compared > 0 ? sumMismatch / compared : 0;
  const blurredMeanMismatchPct = compared > 0 ? sumBlurredMismatch / compared : 0;

  const avgStepMs =
    referenceFrames.length > 1
      ? Math.max(
          16,
          ((referenceFrames[referenceFrames.length - 1]?.tMs ?? 0) -
            (referenceFrames[0]?.tMs ?? 0)) /
            (referenceFrames.length - 1),
        )
      : 16;

  let bestOffsetMs = 0;
  let bestAlignedMean = rawMeanMismatchPct;
  for (let step = -maxSteps; step <= maxSteps; step += 1) {
    if (step === 0) continue;
    const offsetMs = Math.round(step * avgStepMs);
    let stepSum = 0;
    let stepCount = 0;
    for (const refFrame of referenceFrames) {
      const shifted = findNearestFrame(candidateFrames, refFrame.tMs + offsetMs);
      if (!shifted || shifted.width !== refFrame.width || shifted.height !== refFrame.height) {
        continue;
      }
      stepSum += computeFramePairMismatchPct(
        refFrame.rgba,
        shifted.rgba,
        refFrame.width * refFrame.height,
        channelThreshold,
      );
      stepCount += 1;
    }
    if (stepCount > 0) {
      const candidateMean = stepSum / stepCount;
      if (candidateMean < bestAlignedMean) {
        bestAlignedMean = candidateMean;
        bestOffsetMs = offsetMs;
      }
    }
  }

  const startErrorMs =
    referenceWindow.startMs !== null && candidateWindow.startMs !== null
      ? candidateWindow.startMs - referenceWindow.startMs
      : null;
  const peakErrorMs =
    referenceWindow.peakMs !== null && candidateWindow.peakMs !== null
      ? candidateWindow.peakMs - referenceWindow.peakMs
      : null;
  const endErrorMs =
    referenceWindow.endMs !== null && candidateWindow.endMs !== null
      ? candidateWindow.endMs - referenceWindow.endMs
      : null;
  const durationErrorMs =
    referenceWindow.startMs !== null && candidateWindow.startMs !== null
      ? candidateWindow.durationMs - referenceWindow.durationMs
      : null;

  return {
    frameCountCompared: compared,
    rawMeanMismatchPct,
    rawPeakMismatchPct: peakMismatch,
    blurredMeanMismatchPct,
    alignedOffsetMs: bestOffsetMs,
    alignedMeanMismatchPct: bestAlignedMean,
    referenceWindow,
    candidateWindow,
    startErrorMs,
    peakErrorMs,
    endErrorMs,
    durationErrorMs,
    perFrame,
  };
}

export function estimateRepeatCaptureNoiseFloor(
  captureA: readonly MotionRgbaFrame[],
  captureB: readonly MotionRgbaFrame[],
): { meanMismatchPct: number; peakMismatchPct: number } {
  const diff = compareFrameSequences(captureA, captureB, { maxAlignOffsetSteps: 2 });
  return {
    meanMismatchPct: diff.rawMeanMismatchPct,
    peakMismatchPct: diff.rawPeakMismatchPct,
  };
}

function interpolateSampleValue(track: MotionTrack, tMs: number): number | null {
  const numericSamples = track.samples.filter(
    (s): s is typeof s & { value: number } => typeof s.value === 'number',
  );
  if (numericSamples.length === 0) return null;
  const first = numericSamples[0];
  const last = numericSamples[numericSamples.length - 1];
  if (!first || !last) return null;
  if (tMs <= first.tMs) return first.value;
  if (tMs >= last.tMs) return last.value;
  for (let i = 1; i < numericSamples.length; i += 1) {
    const prev = numericSamples[i - 1];
    const curr = numericSamples[i];
    if (!prev || !curr) continue;
    if (tMs <= curr.tMs) {
      const span = Math.max(0.001, curr.tMs - prev.tMs);
      const alpha = (tMs - prev.tMs) / span;
      return prev.value + (curr.value - prev.value) * alpha;
    }
  }
  return last.value;
}

function computeTrackValueRmse(refTrack: MotionTrack, candTrack: MotionTrack): number | null {
  const numericRef = refTrack.samples.filter(
    (s): s is typeof s & { value: number } => typeof s.value === 'number',
  );
  const numericCand = candTrack.samples.filter(
    (s): s is typeof s & { value: number } => typeof s.value === 'number',
  );
  if (numericRef.length >= 2 && numericCand.length >= 2) {
    let sumSq = 0;
    let count = 0;
    for (const s of numericRef) {
      const candVal = interpolateSampleValue(candTrack, s.tMs);
      if (candVal === null) continue;
      const d = s.value - candVal;
      sumSq += d * d;
      count += 1;
    }
    if (count > 0) {
      return Math.sqrt(sumSq / count);
    }
  }

  if (typeof refTrack.fromValue === 'number' && typeof candTrack.fromValue === 'number') {
    const d1 = refTrack.fromValue - candTrack.fromValue;
    const d2 =
      typeof refTrack.toValue === 'number' && typeof candTrack.toValue === 'number'
        ? refTrack.toValue - candTrack.toValue
        : 0;
    return Math.sqrt((d1 * d1 + d2 * d2) / 2);
  }
  return null;
}

function findMatchingCandidateTrack(
  refTrack: MotionTrack,
  candidateTracks: readonly MotionTrack[],
  usedIds: Set<string>,
): MotionTrack | null {
  const exact = candidateTracks.find(
    (c) =>
      !usedIds.has(c.trackId) &&
      c.property === refTrack.property &&
      c.selector === refTrack.selector,
  );
  if (exact) return exact;
  const byProperty = candidateTracks.find(
    (c) => !usedIds.has(c.trackId) && c.property === refTrack.property,
  );
  return byProperty ?? null;
}

export function compareMotionSpecs(
  referenceSpec: MotionSpec,
  candidateSpec: MotionSpec | null | undefined,
  options?: {
    referenceFrames?: readonly MotionRgbaFrame[];
    candidateFrames?: readonly MotionRgbaFrame[];
    thresholds?: Partial<MotionComparisonThresholds>;
  },
): MotionComparisonReport {
  const thresholds: MotionComparisonThresholds = {
    ...DEFAULT_COMPARISON_THRESHOLDS,
    ...(options?.thresholds ?? {}),
  };

  if (!candidateSpec) {
    return {
      status: 'not_compared',
      compatible: false,
      compatibilityMismatches: [
        'No reconstruction capture or second MotionSpec provided; metrics were not compared.',
      ],
      compatibilityWarnings: [],
      thresholds,
      trackComparisons: [],
      maxTimingErrorMs: null,
      maxValueRmse: null,
      visualDiff: null,
      notes: [
        'Run the generated HTML demo or capture a reconstruction pass to enable quantitative Motion Lab comparison.',
      ],
    };
  }

  const refSetup = extractSetupFromMotionSpec(referenceSpec);
  const candSetup = extractSetupFromMotionSpec(candidateSpec);
  const compat = checkMotionCaptureCompatibility(refSetup, candSetup);

  const usedIds = new Set<string>();
  const trackComparisons: MotionTrackComparison[] = [];
  let maxTimingErrorMs: number | null = null;
  let maxValueRmse: number | null = null;

  for (const refTrack of referenceSpec.tracks) {
    if (!refTrack.hasMotion && refTrack.isConstant) continue;
    const candTrack = findMatchingCandidateTrack(refTrack, candidateSpec.tracks, usedIds);
    if (!candTrack) {
      trackComparisons.push({
        trackId: refTrack.trackId,
        property: refTrack.property,
        selector: refTrack.selector,
        matched: false,
        startErrorMs: null,
        durationErrorMs: null,
        valueRmse: null,
        residualNote: `Missing candidate track for property "${refTrack.property}".`,
      });
      continue;
    }

    usedIds.add(candTrack.trackId);
    const startErrorMs =
      refTrack.startMs !== null && candTrack.startMs !== null
        ? candTrack.startMs - refTrack.startMs
        : null;
    const durationErrorMs =
      refTrack.durationMs !== null && candTrack.durationMs !== null
        ? candTrack.durationMs - refTrack.durationMs
        : null;
    const valueRmse = computeTrackValueRmse(refTrack, candTrack);

    if (startErrorMs !== null) {
      const absErr = Math.abs(startErrorMs);
      maxTimingErrorMs = maxTimingErrorMs === null ? absErr : Math.max(maxTimingErrorMs, absErr);
    }
    if (durationErrorMs !== null) {
      const absErr = Math.abs(durationErrorMs);
      maxTimingErrorMs = maxTimingErrorMs === null ? absErr : Math.max(maxTimingErrorMs, absErr);
    }
    if (valueRmse !== null) {
      maxValueRmse = maxValueRmse === null ? valueRmse : Math.max(maxValueRmse, valueRmse);
    }

    trackComparisons.push({
      trackId: refTrack.trackId,
      property: refTrack.property,
      selector: refTrack.selector,
      matched: true,
      startErrorMs,
      durationErrorMs,
      valueRmse,
      residualNote:
        valueRmse !== null
          ? `RMSE ${valueRmse.toFixed(3)} ${refTrack.unit}`.trim()
          : 'Discrete/string property matched without numeric RMSE.',
    });
  }

  const visualDiff =
    options?.referenceFrames &&
    options.referenceFrames.length > 0 &&
    options.candidateFrames &&
    options.candidateFrames.length > 0
      ? compareFrameSequences(options.referenceFrames, options.candidateFrames)
      : null;

  const notes: string[] = [];
  const refCounts = summarizeMotionSpecCounts(referenceSpec);
  const candCounts = summarizeMotionSpecCounts(candidateSpec);
  notes.push(
    `Reference tracks: ${referenceSpec.tracks.length} (${refCounts.declaredCount} declared, ${refCounts.observedCount} observed, ${refCounts.inferredCount} inferred). Candidate tracks: ${candidateSpec.tracks.length} (${candCounts.declaredCount} declared, ${candCounts.observedCount} observed, ${candCounts.inferredCount} inferred).`,
  );

  if (!compat.compatible) {
    return {
      status: 'incompatible_setup',
      compatible: false,
      compatibilityMismatches: compat.mismatches,
      compatibilityWarnings: compat.warnings,
      thresholds,
      trackComparisons,
      maxTimingErrorMs,
      maxValueRmse,
      visualDiff,
      notes: [
        ...notes,
        'Comparison aborted accuracy badge because capture setups are incompatible.',
      ],
    };
  }

  const missingTrackCount = trackComparisons.filter((t) => !t.matched).length;
  const timingPass = maxTimingErrorMs === null || maxTimingErrorMs <= thresholds.timingToleranceMs;
  const valuePass = maxValueRmse === null || maxValueRmse <= thresholds.valueTolerance;
  const effectivePixelTolerance =
    thresholds.pixelMismatchTolerancePct + thresholds.noiseFloorMismatchPct;
  const rawVisualPass =
    visualDiff === null || visualDiff.rawMeanMismatchPct <= effectivePixelTolerance;
  const alignedVisualPass =
    visualDiff === null || visualDiff.alignedMeanMismatchPct <= effectivePixelTolerance;

  let status: MotionComparisonVerdict = 'diverged';
  if (missingTrackCount === 0 && timingPass && valuePass && rawVisualPass) {
    status = 'matched';
  } else if (
    missingTrackCount === 0 &&
    valuePass &&
    visualDiff !== null &&
    !rawVisualPass &&
    alignedVisualPass &&
    visualDiff.alignedOffsetMs !== 0
  ) {
    status = 'close_with_offset';
    notes.push(
      `Raw visual mismatch (${visualDiff.rawMeanMismatchPct.toFixed(2)}%) drops to ${visualDiff.alignedMeanMismatchPct.toFixed(2)}% when shifted by alignedOffsetMs=${visualDiff.alignedOffsetMs}ms.`,
    );
  } else if (missingTrackCount === 0 && valuePass && visualDiff === null && !timingPass) {
    status = 'close_with_offset';
    notes.push(
      `Property amplitudes match within tolerance (${maxValueRmse?.toFixed(2) ?? 'n/a'}), while timing differs by up to ${Math.round(maxTimingErrorMs ?? 0)} ms.`,
    );
  }

  if (visualDiff) {
    notes.push(
      `Visual mismatch: raw mean ${visualDiff.rawMeanMismatchPct.toFixed(2)}%, blurred mean ${visualDiff.blurredMeanMismatchPct.toFixed(2)}%, aligned mean ${visualDiff.alignedMeanMismatchPct.toFixed(2)}% at ${visualDiff.alignedOffsetMs} ms offset.`,
    );
  }

  return {
    status,
    compatible: true,
    compatibilityMismatches: [],
    compatibilityWarnings: compat.warnings,
    thresholds,
    trackComparisons,
    maxTimingErrorMs,
    maxValueRmse,
    visualDiff,
    notes,
  };
}

function escapeHtmlText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function buildLabeledContactSheetHtml(
  report: MotionComparisonReport,
  title: string,
  frameDataUrls?: ReadonlyArray<{ label: string; tMs: number; dataUrl: string }>,
): string {
  const safeTitle = escapeHtmlText(title);
  const tiles = (frameDataUrls ?? []).slice(0, 24).map((tile) => {
    const safeUrl = tile.dataUrl.startsWith('data:image/') ? tile.dataUrl : '';
    return `<div class="tile"><div class="meta">${escapeHtmlText(tile.label)} · ${Math.round(tile.tMs)}ms</div>${
      safeUrl
        ? `<img src="${escapeHtmlText(safeUrl)}" alt="${escapeHtmlText(tile.label)}" />`
        : '<div class="empty">No preview image</div>'
    }</div>`;
  });

  const trackRows = report.trackComparisons
    .map(
      (t) =>
        `<tr><td>${escapeHtmlText(t.property)}</td><td>${escapeHtmlText(t.selector)}</td><td>${t.matched ? 'Matched' : 'Missing'}</td><td>${t.startErrorMs !== null ? `${Math.round(t.startErrorMs)} ms` : 'n/a'}</td><td>${t.durationErrorMs !== null ? `${Math.round(t.durationErrorMs)} ms` : 'n/a'}</td><td>${t.valueRmse !== null ? t.valueRmse.toFixed(3) : 'n/a'}</td></tr>`,
    )
    .join('\n');

  const visualSection = report.visualDiff
    ? `<p>Raw mean mismatch: <strong>${report.visualDiff.rawMeanMismatchPct.toFixed(2)}%</strong> · Blurred mean: <strong>${report.visualDiff.blurredMeanMismatchPct.toFixed(2)}%</strong> · Auto-aligned mean: <strong>${report.visualDiff.alignedMeanMismatchPct.toFixed(2)}%</strong> (offset ${report.visualDiff.alignedOffsetMs} ms)</p>`
    : '<p>Visual pixel frames were not supplied; metric comparison relies on MotionSpec property/timing tracks only.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>PageSift Motion Lab Contact Sheet — ${safeTitle}</title>
  <style>
    body { margin: 0; padding: 24px; background: #0f1214; color: #e2e8f0; font-family: system-ui, -apple-system, sans-serif; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: #132a27; color: #5eead4; border: 1px solid #0d9488; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin: 16px 0; }
    .tile { background: #161b1e; border: 1px solid #262e33; border-radius: 8px; padding: 8px; }
    .tile .meta { font-size: 11px; color: #94a3b8; margin-bottom: 6px; }
    .tile img { width: 100%; height: auto; display: block; border-radius: 4px; background: #090b0c; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 12px; }
    th, td { border-bottom: 1px solid #262e33; padding: 8px; text-align: left; }
    th { color: #94a3b8; }
  </style>
</head>
<body>
  <h1>${safeTitle}</h1>
  <span class="badge">Status: ${escapeHtmlText(report.status)}</span>
  ${visualSection}
  ${tiles.length > 0 ? `<div class="grid">${tiles.join('\n')}</div>` : ''}
  <table>
    <thead><tr><th>Property</th><th>Selector</th><th>State</th><th>Start Error</th><th>Duration Error</th><th>Value RMSE</th></tr></thead>
    <tbody>${trackRows}</tbody>
  </table>
</body>
</html>
`;
}
