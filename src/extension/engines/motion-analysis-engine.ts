import {
  classifyDeclaredCategory,
  type DeclaredAnimationEntry,
  type MotionObservationRawResult,
  type ObservedTargetSeries,
} from './motion-observation-engine.js';
import {
  MOTION_SPEC_SCHEMA_VERSION,
  type MotionEasingCandidate,
  type MotionSamplePoint,
  type MotionSpec,
  type MotionTrack,
} from './motion-spec.js';

export interface DecomposedTransform {
  translateX: number;
  translateY: number;
  scaleX: number;
  scaleY: number;
  rotateDeg: number;
}

export function decomposeCssTransform(transform: string): DecomposedTransform {
  if (!transform || transform === 'none') {
    return { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotateDeg: 0 };
  }
  const match = transform.match(/matrix(3d)?\(([^)]+)\)/);
  if (!match || !match[2]) {
    return { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotateDeg: 0 };
  }
  const nums = match[2].split(',').map((n) => Number.parseFloat(n.trim()));
  if (nums.some((n) => !Number.isFinite(n))) {
    return { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotateDeg: 0 };
  }
  if (match[1] === '3d' && nums.length >= 16) {
    const a = nums[0] ?? 1;
    const b = nums[1] ?? 0;
    const c = nums[4] ?? 0;
    const d = nums[5] ?? 1;
    const tx = nums[12] ?? 0;
    const ty = nums[13] ?? 0;
    return {
      translateX: tx,
      translateY: ty,
      scaleX: Math.hypot(a, b),
      scaleY: Math.hypot(c, d),
      rotateDeg: (Math.atan2(b, a) * 180) / Math.PI,
    };
  }
  if (nums.length >= 6) {
    const a = nums[0] ?? 1;
    const b = nums[1] ?? 0;
    const c = nums[2] ?? 0;
    const d = nums[3] ?? 1;
    const tx = nums[4] ?? 0;
    const ty = nums[5] ?? 0;
    return {
      translateX: tx,
      translateY: ty,
      scaleX: Math.hypot(a, b),
      scaleY: Math.hypot(c, d),
      rotateDeg: (Math.atan2(b, a) * 180) / Math.PI,
    };
  }
  return { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotateDeg: 0 };
}

function solveCubicBezierY(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  return (t: number): number => {
    const clamped = Math.max(0, Math.min(1, t));
    let lo = 0;
    let hi = 1;
    let u = clamped;
    for (let i = 0; i < 24; i += 1) {
      u = (lo + hi) / 2;
      const x = 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u ** 2 * x2 + u ** 3;
      if (x < clamped) {
        lo = u;
      } else {
        hi = u;
      }
    }
    return 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u ** 2 * y2 + u ** 3;
  };
}

const CANDIDATE_EASINGS: ReadonlyArray<{
  name: string;
  cssEasing: string;
  fn: (t: number) => number;
}> = [
  { name: 'linear', cssEasing: 'linear', fn: (t) => t },
  {
    name: 'ease',
    cssEasing: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
    fn: solveCubicBezierY(0.25, 0.1, 0.25, 1),
  },
  {
    name: 'ease-in',
    cssEasing: 'cubic-bezier(0.42, 0, 1, 1)',
    fn: solveCubicBezierY(0.42, 0, 1, 1),
  },
  {
    name: 'ease-out',
    cssEasing: 'cubic-bezier(0, 0, 0.58, 1)',
    fn: solveCubicBezierY(0, 0, 0.58, 1),
  },
  {
    name: 'ease-in-out',
    cssEasing: 'cubic-bezier(0.42, 0, 0.58, 1)',
    fn: solveCubicBezierY(0.42, 0, 0.58, 1),
  },
  {
    name: 'material-standard',
    cssEasing: 'cubic-bezier(0.4, 0, 0.2, 1)',
    fn: solveCubicBezierY(0.4, 0, 0.2, 1),
  },
  {
    name: 'material-emphasized',
    cssEasing: 'cubic-bezier(0.2, 0, 0, 1)',
    fn: solveCubicBezierY(0.2, 0, 0, 1),
  },
  {
    name: 'easeOutExpo',
    cssEasing: 'cubic-bezier(0.16, 1, 0.3, 1)',
    fn: solveCubicBezierY(0.16, 1, 0.3, 1),
  },
  {
    name: 'easeOutQuint',
    cssEasing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    fn: solveCubicBezierY(0.22, 1, 0.36, 1),
  },
  {
    name: 'easeOutCubic',
    cssEasing: 'cubic-bezier(0.33, 1, 0.68, 1)',
    fn: solveCubicBezierY(0.33, 1, 0.68, 1),
  },
  {
    name: 'easeOutQuart',
    cssEasing: 'cubic-bezier(0.25, 1, 0.5, 1)',
    fn: solveCubicBezierY(0.25, 1, 0.5, 1),
  },
  {
    name: 'easeOutQuad',
    cssEasing: 'cubic-bezier(0.5, 1, 0.89, 1)',
    fn: solveCubicBezierY(0.5, 1, 0.89, 1),
  },
  {
    name: 'easeInOutCubic',
    cssEasing: 'cubic-bezier(0.65, 0, 0.35, 1)',
    fn: solveCubicBezierY(0.65, 0, 0.35, 1),
  },
  {
    name: 'easeInOutQuint',
    cssEasing: 'cubic-bezier(0.83, 0, 0.17, 1)',
    fn: solveCubicBezierY(0.83, 0, 0.17, 1),
  },
  {
    name: 'easeInOutExpo',
    cssEasing: 'cubic-bezier(0.87, 0, 0.13, 1)',
    fn: solveCubicBezierY(0.87, 0, 0.13, 1),
  },
  {
    name: 'easeInCubic',
    cssEasing: 'cubic-bezier(0.32, 0, 0.67, 0)',
    fn: solveCubicBezierY(0.32, 0, 0.67, 0),
  },
  {
    name: 'easeOutBack',
    cssEasing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    fn: solveCubicBezierY(0.34, 1.56, 0.64, 1),
  },
  {
    name: 'easeInOutBack',
    cssEasing: 'cubic-bezier(0.68, -0.6, 0.32, 1.6)',
    fn: solveCubicBezierY(0.68, -0.6, 0.32, 1.6),
  },
];

export interface NumericSeriesAnalysis {
  hasMotion: boolean;
  isConstant: boolean;
  startValue: number;
  endValue: number;
  travel: number;
  delayMs: number;
  visibleDurationMs: number;
  startMs: number;
  endMs: number;
  overshootPct: number;
  settleTimeMs: number;
  directionHint: 'forward' | 'reverse' | 'oscillating' | 'static' | 'unknown';
  inferredEasings: MotionEasingCandidate[];
  residualError: number | null;
  confidence: 'high' | 'medium' | 'low' | null;
  notes: string[];
}

export function analyzeNumericSampleSeries(
  points: ReadonlyArray<{ tMs: number; value: number }>,
  options: { tolerance?: number } = {},
): NumericSeriesAnalysis {
  if (points.length === 0) {
    return {
      hasMotion: false,
      isConstant: true,
      startValue: 0,
      endValue: 0,
      travel: 0,
      delayMs: 0,
      visibleDurationMs: 0,
      startMs: 0,
      endMs: 0,
      overshootPct: 0,
      settleTimeMs: 0,
      directionHint: 'static',
      inferredEasings: [],
      residualError: null,
      confidence: null,
      notes: ['No samples available for analysis.'],
    };
  }

  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) {
    return {
      hasMotion: false,
      isConstant: true,
      startValue: 0,
      endValue: 0,
      travel: 0,
      delayMs: 0,
      visibleDurationMs: 0,
      startMs: 0,
      endMs: 0,
      overshootPct: 0,
      settleTimeMs: 0,
      directionHint: 'static',
      inferredEasings: [],
      residualError: null,
      confidence: null,
      notes: ['Insufficient samples.'],
    };
  }

  let minV = first.value;
  let maxV = first.value;
  for (const pt of points) {
    if (pt.value < minV) minV = pt.value;
    if (pt.value > maxV) maxV = pt.value;
  }

  const startValue = first.value;
  const endValue = last.value;
  const netRange = endValue - startValue;
  const totalSpan = maxV - minV;
  const tol = options.tolerance ?? 0.005;

  if (totalSpan <= tol) {
    return {
      hasMotion: false,
      isConstant: true,
      startValue: Number(startValue.toFixed(4)),
      endValue: Number(endValue.toFixed(4)),
      travel: 0,
      delayMs: 0,
      visibleDurationMs: 0,
      startMs: first.tMs,
      endMs: last.tMs,
      overshootPct: 0,
      settleTimeMs: 0,
      directionHint: 'static',
      inferredEasings: [],
      residualError: null,
      confidence: null,
      notes: ['Constant or near-constant track within noise floor.'],
    };
  }

  const changeEps = Math.max(totalSpan * 0.01, tol);
  let firstChangeIdx = points.findIndex((p) => Math.abs(p.value - startValue) > changeEps);
  if (firstChangeIdx < 1) firstChangeIdx = 1;
  let lastChangeIdx = points.length - 1;
  for (let i = points.length - 1; i > 0; i -= 1) {
    const pt = points[i];
    if (pt && Math.abs(pt.value - endValue) > changeEps) {
      lastChangeIdx = Math.min(points.length - 1, i + 1);
      break;
    }
  }

  const startAnchor = points[firstChangeIdx - 1] ?? first;
  const endAnchor = points[lastChangeIdx] ?? last;
  const delayMs = Math.max(0, startAnchor.tMs - first.tMs);
  const visibleDurationMs = Math.max(0, endAnchor.tMs - startAnchor.tMs);
  const settleTimeMs = Math.max(0, endAnchor.tMs - first.tMs);

  let turns = 0;
  let prevSign = 0;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    if (!prev || !curr) continue;
    const diff = curr.value - prev.value;
    if (Math.abs(diff) <= changeEps * 0.25) continue;
    const sign = Math.sign(diff);
    if (prevSign !== 0 && sign !== prevSign) {
      turns += 1;
    }
    prevSign = sign;
  }

  let directionHint: NumericSeriesAnalysis['directionHint'] = 'forward';
  if (turns >= 2 || (Math.abs(netRange) < totalSpan * 0.2 && totalSpan > tol)) {
    directionHint = 'oscillating';
  } else if (netRange < 0) {
    directionHint = 'reverse';
  }

  let overshootPct = 0;
  if (Math.abs(netRange) > tol) {
    const sign = Math.sign(netRange);
    let maxExcursion = 0;
    for (const pt of points) {
      const proj = (pt.value - startValue) * sign;
      if (proj > maxExcursion) {
        maxExcursion = proj;
      }
    }
    overshootPct = Math.max(0, ((maxExcursion - Math.abs(netRange)) / Math.abs(netRange)) * 100);
  }

  const notes: string[] = [];
  const inferredEasings: MotionEasingCandidate[] = [];

  if (
    Math.abs(netRange) > tol &&
    visibleDurationMs > 0 &&
    points.length >= 4 &&
    directionHint !== 'oscillating'
  ) {
    const baseT = startAnchor.tMs;
    const normalized = points
      .slice(firstChangeIdx - 1)
      .map((p) => ({ t: p.tMs - baseT, y: (p.value - startValue) / netRange }));

    for (const candidate of CANDIDATE_EASINGS) {
      let bestRmse = Infinity;
      let bestDur = visibleDurationMs;
      for (let mult = 1.0; mult <= 2.001; mult += 0.05) {
        const d = visibleDurationMs * mult;
        const subset = normalized.filter((p) => p.t <= d * 1.05);
        if (subset.length < 3) continue;
        let sqSum = 0;
        for (const p of subset) {
          const pred = candidate.fn(Math.min(1, Math.max(0, p.t / d)));
          sqSum += (pred - p.y) ** 2;
        }
        const rmse = Math.sqrt(sqSum / subset.length);
        if (rmse < bestRmse) {
          bestRmse = rmse;
          bestDur = Math.round(d);
        }
      }
      if (Number.isFinite(bestRmse)) {
        const confidence: MotionEasingCandidate['confidence'] =
          bestRmse < 0.03 ? 'high' : bestRmse < 0.08 ? 'medium' : 'low';
        inferredEasings.push({
          name: candidate.name,
          cssEasing: candidate.cssEasing,
          rmse: Number(bestRmse.toFixed(4)),
          fittedDurationMs: bestDur,
          confidence,
        });
      }
    }
    inferredEasings.sort((a, b) => a.rmse - b.rmse);
    if (overshootPct > 2) {
      notes.push(
        `Detected ${overshootPct.toFixed(1)}% overshoot; behavior resembles a spring or back-easing curve (exact spring parameters cannot be uniquely identified from position samples alone).`,
      );
    }
  } else if (directionHint === 'oscillating') {
    notes.push(
      'Oscillating or reversed track (returns near start or reverses mid-flight); single monotonic cubic-bezier fit is omitted.',
    );
  } else {
    notes.push('Insufficient travel or samples for curve estimation.');
  }

  const topFit = inferredEasings[0];
  return {
    hasMotion: true,
    isConstant: false,
    startValue: Number(startValue.toFixed(4)),
    endValue: Number(endValue.toFixed(4)),
    travel: Number(netRange.toFixed(4)),
    delayMs: Number(delayMs.toFixed(1)),
    visibleDurationMs: Number(visibleDurationMs.toFixed(1)),
    startMs: Number(startAnchor.tMs.toFixed(1)),
    endMs: Number(endAnchor.tMs.toFixed(1)),
    overshootPct: Number(overshootPct.toFixed(2)),
    settleTimeMs: Number(settleTimeMs.toFixed(1)),
    directionHint,
    inferredEasings: inferredEasings.slice(0, 5),
    residualError: topFit ? topFit.rmse : null,
    confidence: topFit ? topFit.confidence : null,
    notes,
  };
}

function buildTracksFromDeclared(
  entries: DeclaredAnimationEntry[],
  targets: MotionSpec['targets'],
  trigger: MotionObservationRawResult['trigger'],
): MotionTrack[] {
  const selectorToTargetId = new Map<string, string>();
  for (const t of targets) {
    if (!selectorToTargetId.has(t.selector)) {
      selectorToTargetId.set(t.selector, t.targetId);
    }
  }

  const tracks: MotionTrack[] = [];
  entries.forEach((entry, idx) => {
    const targetId = selectorToTargetId.get(entry.selector) ?? targets[0]?.targetId ?? 't-0';
    const isScrollDomain =
      entry.timelineDomain === 'scroll_progress_percent' ||
      entry.timelineDomain === 'view_progress_percent';
    const category = classifyDeclaredCategory(entry.kind, entry.timelineDomain);
    const delayMs = isScrollDomain ? null : entry.delayMs;
    const durationMs = isScrollDomain ? null : entry.durationMs;
    const startMs = delayMs !== null ? delayMs : null;
    const endMs =
      startMs !== null && durationMs !== null && entry.iterations !== 'infinite'
        ? startMs + durationMs * (typeof entry.iterations === 'number' ? entry.iterations : 1)
        : null;

    const firstKf = entry.keyframes[0];
    const lastKf = entry.keyframes[entry.keyframes.length - 1];

    tracks.push({
      trackId: `decl-${idx}-${entry.animationId}`.slice(0, 128),
      targetId,
      selector: entry.selector,
      property: entry.propertyHint || 'composite',
      category,
      evidenceClass: 'declared',
      trigger: isScrollDomain ? 'scroll' : trigger,
      timelineDomain: entry.timelineDomain,
      animationName: entry.name,
      playState: entry.playState,
      composite: entry.composite,
      startMs,
      endMs,
      delayMs,
      durationMs,
      endDelayMs: entry.endDelayMs,
      iterations: entry.iterations,
      direction: entry.direction,
      fillMode: entry.fillMode,
      progressStartPct: isScrollDomain ? 0 : null,
      progressEndPct: isScrollDomain ? 100 : null,
      fromValue: firstKf ? firstKf.value : null,
      toValue: lastKf ? lastKf.value : null,
      unit: '',
      directionHint: entry.direction.includes('reverse') ? 'reverse' : 'forward',
      normalizedTravel: null,
      overshootPct: null,
      settleTimeMs: null,
      staggerFromPrevMs: null,
      declaredEasing: entry.easing,
      inferredEasings: [],
      residualError: null,
      inferenceConfidence: null,
      keyframes: entry.keyframes,
      samples: [],
      hasMotion: true,
      isConstant: false,
      replaySupported: entry.keyframes.length >= 2 || isScrollDomain,
      unsupportedReason:
        entry.keyframes.length < 2 && !isScrollDomain
          ? 'No keyframes exposed by browser for replay.'
          : null,
      notes: [
        isScrollDomain
          ? `Scroll-driven timeline (${entry.timelineDomain}); progress is percentage-based rather than fixed milliseconds.`
          : `Exact declared ${entry.kind} metadata read from Web Animations API.`,
      ],
    });
  });
  return tracks;
}

function buildObservedAndInferredTracks(
  series: ObservedTargetSeries,
  raw: MotionObservationRawResult,
): MotionTrack[] {
  const tracks: MotionTrack[] = [];
  const samples = series.samples;
  if (samples.length < 2) {
    return tracks;
  }

  const baseSample = samples[0];
  if (!baseSample) return tracks;

  const baseDecomp = decomposeCssTransform(baseSample.transform);
  const propExtractors: Array<{
    prop: string;
    unit: string;
    tolerance: number;
    normDenom: number;
    getValue: (s: ObservedTargetSeries['samples'][number]) => number;
  }> = [
    {
      prop: 'opacity',
      unit: '',
      tolerance: 0.01,
      normDenom: 1,
      getValue: (s) => s.opacity,
    },
    {
      prop: 'translateX',
      unit: 'px',
      tolerance: 0.5,
      normDenom: Math.max(1, series.identity.initialBox.width),
      getValue: (s) => decomposeCssTransform(s.transform).translateX,
    },
    {
      prop: 'translateY',
      unit: 'px',
      tolerance: 0.5,
      normDenom: Math.max(1, series.identity.initialBox.height),
      getValue: (s) => decomposeCssTransform(s.transform).translateY,
    },
    {
      prop: 'scaleX',
      unit: '',
      tolerance: 0.008,
      normDenom: 1,
      getValue: (s) => decomposeCssTransform(s.transform).scaleX,
    },
    {
      prop: 'scaleY',
      unit: '',
      tolerance: 0.008,
      normDenom: 1,
      getValue: (s) => decomposeCssTransform(s.transform).scaleY,
    },
    {
      prop: 'rotate',
      unit: 'deg',
      tolerance: 0.5,
      normDenom: 360,
      getValue: (s) => decomposeCssTransform(s.transform).rotateDeg,
    },
    {
      prop: 'boxX',
      unit: 'px',
      tolerance: 1.0,
      normDenom: Math.max(1, series.identity.initialBox.width),
      getValue: (s) => s.box.x + s.scrollX,
    },
    {
      prop: 'boxY',
      unit: 'px',
      tolerance: 1.0,
      normDenom: Math.max(1, series.identity.initialBox.height),
      getValue: (s) => s.box.y + s.scrollY,
    },
  ];

  const txChanged = samples.some(
    (s) => Math.abs(decomposeCssTransform(s.transform).translateX - baseDecomp.translateX) > 0.5,
  );
  const tyChanged = samples.some(
    (s) => Math.abs(decomposeCssTransform(s.transform).translateY - baseDecomp.translateY) > 0.5,
  );

  for (const ext of propExtractors) {
    if (ext.prop === 'boxX' && txChanged) {
      continue;
    }
    if (ext.prop === 'boxY' && tyChanged) {
      continue;
    }

    const numericPoints = samples.map((s) => ({
      tMs: s.tMs,
      value: ext.getValue(s),
    }));
    const analysis = analyzeNumericSampleSeries(numericPoints, { tolerance: ext.tolerance });
    if (!analysis.hasMotion) {
      continue;
    }

    const isBoxFallback = ext.prop === 'boxX' || ext.prop === 'boxY';
    const scrollChanged = samples.some(
      (s) =>
        Math.abs(s.scrollX - baseSample.scrollX) > 2 ||
        Math.abs(s.scrollY - baseSample.scrollY) > 2,
    );
    const timelineDomain =
      raw.trigger === 'scroll' && scrollChanged ? 'scroll_progress_percent' : 'time_ms';

    const samplePoints: MotionSamplePoint[] = samples.map((s, idx) => ({
      tMs: s.tMs,
      progressPct: s.scrollProgressPct,
      scrollX: s.scrollX,
      scrollY: s.scrollY,
      value: Number((numericPoints[idx]?.value ?? 0).toFixed(4)),
    }));

    const notes = [...analysis.notes];
    if (isBoxFallback) {
      notes.push(
        'Measured via page-coordinate bounding box (scroll-compensated); may reflect layout reflow or parent transforms rather than element CSS transform.',
      );
    }
    if (series.identity.nestedTransformAncestors.length > 0) {
      notes.push(
        `Element sits under transformed ancestor(s): ${series.identity.nestedTransformAncestors.map((a) => a.selector).join(', ')}.`,
      );
    }

    const matchedDeclared = raw.dynamicAnimations.some(
      (a) =>
        a.selector === series.identity.selector &&
        (a.propertyHint === ext.prop ||
          a.propertyHint === 'transform' ||
          a.propertyHint === 'composite'),
    );

    const category = timelineDomain === 'scroll_progress_percent' ? 'scroll_driven' : 'js_driven';
    const evidenceClass = analysis.inferredEasings.length > 0 ? 'inferred' : 'observed';

    tracks.push({
      trackId: `obs-${series.identity.targetId}-${ext.prop}`,
      targetId: series.identity.targetId,
      selector: series.identity.selector,
      property: ext.prop,
      category,
      evidenceClass,
      trigger: raw.trigger,
      timelineDomain,
      animationName: matchedDeclared ? `${series.identity.selector}:${ext.prop}` : null,
      playState: null,
      composite: null,
      startMs: analysis.startMs,
      endMs: analysis.endMs,
      delayMs: analysis.delayMs,
      durationMs: analysis.visibleDurationMs,
      endDelayMs: null,
      iterations: 1,
      direction: null,
      fillMode: 'forwards',
      progressStartPct: samples[0]?.scrollProgressPct ?? null,
      progressEndPct: samples[samples.length - 1]?.scrollProgressPct ?? null,
      fromValue: `${analysis.startValue}${ext.unit}`,
      toValue: `${analysis.endValue}${ext.unit}`,
      unit: ext.unit,
      directionHint: analysis.directionHint,
      normalizedTravel: Number((Math.abs(analysis.travel) / ext.normDenom).toFixed(3)),
      overshootPct: analysis.overshootPct,
      settleTimeMs: analysis.settleTimeMs,
      staggerFromPrevMs: null,
      declaredEasing: null,
      inferredEasings: analysis.inferredEasings,
      residualError: analysis.residualError,
      inferenceConfidence: analysis.confidence,
      keyframes: [],
      samples: samplePoints,
      hasMotion: true,
      isConstant: false,
      replaySupported: !isBoxFallback && ext.prop !== 'boxX' && ext.prop !== 'boxY',
      unsupportedReason: isBoxFallback
        ? 'Layout-driven box movement cannot be safely replayed as an isolated transform without original layout context.'
        : null,
      notes,
    });
  }

  return tracks;
}

export function buildMotionSpecFromObservation(raw: MotionObservationRawResult): MotionSpec {
  const combinedDeclared = new Map<string, DeclaredAnimationEntry>();
  for (const d of raw.inspection.declaredAnimations) {
    combinedDeclared.set(`${d.kind}|${d.selector}|${d.name}|${d.propertyHint}`, d);
  }
  for (const d of raw.dynamicAnimations) {
    combinedDeclared.set(`${d.kind}|${d.selector}|${d.name}|${d.propertyHint}`, d);
  }

  const declaredTracks = buildTracksFromDeclared(
    Array.from(combinedDeclared.values()),
    raw.inspection.targets,
    raw.trigger,
  );

  const observedTracks: MotionTrack[] = [];
  for (const series of Object.values(raw.seriesByTargetId)) {
    observedTracks.push(...buildObservedAndInferredTracks(series, raw));
  }

  const allTracks = [...declaredTracks, ...observedTracks];

  const sortedByStart = allTracks
    .filter((t) => t.startMs !== null)
    .sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
  let prevStart: number | null = null;
  let prevTargetId: string | null = null;
  for (const track of sortedByStart) {
    if (prevStart !== null && prevTargetId !== track.targetId && track.startMs !== null) {
      const gap = track.startMs - prevStart;
      if (gap >= 0) {
        track.staggerFromPrevMs = Number(gap.toFixed(1));
      }
    }
    prevStart = track.startMs;
    prevTargetId = track.targetId;
  }

  const totalSamples = Object.values(raw.seriesByTargetId).reduce(
    (sum, s) => sum + s.samples.length,
    0,
  );

  return {
    schemaVersion: MOTION_SPEC_SCHEMA_VERSION,
    specId: raw.sessionId,
    sourceKind: 'live_observation',
    environment: {
      pageUrl: raw.inspection.pageUrl,
      pageTitle: raw.inspection.pageTitle,
      viewport: raw.inspection.viewport,
      devicePixelRatio: raw.inspection.devicePixelRatio,
      scrollPosition: raw.inspection.scrollPosition,
      reducedMotionPreference: raw.inspection.reducedMotionPreference,
      cropRect: null,
      coordinateSpace: 'viewport_css_px',
    },
    session: {
      sessionId: raw.sessionId,
      state: raw.state,
      startedAtIso: raw.startedAtIso,
      completedAtIso: raw.completedAtIso,
      observedDurationMs: raw.observedDurationMs,
      sampleCount: totalSamples,
      droppedSamplesEstimate: raw.droppedSamplesEstimate,
      measuredMeanFps: raw.measuredMeanFps,
      interruptionReason: raw.interruptionReason,
      visualRecordingStatus: 'none',
      visualMediaId: null,
      visualFrameCount: 0,
    },
    rootSelector: raw.inspection.rootSelector,
    targets: raw.inspection.targets,
    tracks: allTracks.slice(0, 128),
    detectedEngines: raw.inspection.detectedEngines,
    canvasesDetected: raw.inspection.canvases,
    unavailableItems: raw.inspection.unavailableItems,
    warnings: raw.inspection.warnings,
  };
}
