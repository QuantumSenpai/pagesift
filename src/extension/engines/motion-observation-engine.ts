import { buildShortSelector, inspectFramesAndStylesheets, isPageSiftElement } from './dom-utils.js';
import {
  MOTION_CAPTURE_DEFAULTS,
  type MotionCategory,
  type MotionEvidenceClass,
  type MotionKeyframeEntry,
  type MotionSpec,
  type MotionTargetIdentity,
  type MotionTimelineDomain,
  type MotionTriggerType,
  type MotionUnavailableItem,
} from './motion-spec.js';

export interface DeclaredAnimationEntry {
  animationId: string;
  kind: 'css_animation' | 'css_transition' | 'waapi';
  name: string;
  selector: string;
  propertyHint: string;
  playState: string;
  timelineDomain: MotionTimelineDomain;
  currentTimeMs: number | null;
  progressPct: number | null;
  delayMs: number | null;
  endDelayMs: number | null;
  durationMs: number | null;
  iterations: number | 'infinite';
  direction: string;
  fillMode: string;
  easing: string;
  composite: string;
  keyframes: MotionKeyframeEntry[];
}

export interface MotionLifecycleEvent {
  tMs: number;
  type:
    | 'animationstart'
    | 'animationend'
    | 'animationcancel'
    | 'transitionrun'
    | 'transitionstart'
    | 'transitionend'
    | 'transitioncancel'
    | 'pointerenter'
    | 'pointerdown'
    | 'click'
    | 'focusin'
    | 'scroll';
  selector: string;
  detail: string;
}

export interface ObservedTargetSample {
  tMs: number;
  scrollX: number;
  scrollY: number;
  scrollProgressPct: number | null;
  box: { x: number; y: number; width: number; height: number };
  opacity: number;
  transform: string;
  translate: string;
  scale: string;
  rotate: string;
  clipPath: string;
}

export interface ObservedTargetSeries {
  identity: MotionTargetIdentity;
  samples: ObservedTargetSample[];
}

export interface MotionInspectionResult {
  rootSelector: string;
  pageUrl: string;
  pageTitle: string;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  scrollPosition: { x: number; y: number };
  reducedMotionPreference: 'no-preference' | 'reduce' | 'unknown';
  targets: MotionTargetIdentity[];
  declaredAnimations: DeclaredAnimationEntry[];
  declaredCssRules: Array<{
    selector: string;
    transition: string;
    animation: string;
    transformOrigin: string;
  }>;
  keyframeRules: Array<{ name: string; cssText: string }>;
  canvases: MotionSpec['canvasesDetected'];
  detectedEngines: string[];
  unavailableItems: MotionUnavailableItem[];
  warnings: string[];
}

export interface MotionObservationConfig {
  rootElement: Element;
  doc: Document;
  win: Window;
  trigger?: MotionTriggerType;
  maxDurationMs?: number;
  maxTargets?: number;
  maxSamplesPerTarget?: number;
  onProgress?: (progress: { elapsedMs: number; sampleCount: number; state: string }) => void;
  onComplete?: (raw: MotionObservationRawResult) => void;
}

export interface MotionObservationRawResult {
  sessionId: string;
  state: 'completed' | 'partial' | 'cancelled' | 'failed';
  interruptionReason: string | null;
  startedAtIso: string;
  completedAtIso: string;
  observedDurationMs: number;
  trigger: MotionTriggerType;
  triggerTimestampMs: number | null;
  inspection: MotionInspectionResult;
  seriesByTargetId: Record<string, ObservedTargetSeries>;
  lifecycleEvents: MotionLifecycleEvent[];
  dynamicAnimations: DeclaredAnimationEntry[];
  droppedSamplesEstimate: number;
  measuredMeanFps: number | null;
}

function readCssNumberish(val: unknown): { ms: number | null; pct: number | null } {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return { ms: val, pct: null };
  }
  if (val && typeof val === 'object') {
    const obj = val as { value?: unknown; unit?: unknown };
    if (typeof obj.value === 'number' && Number.isFinite(obj.value)) {
      if (obj.unit === 'percent') {
        return { ms: null, pct: obj.value };
      }
      if (obj.unit === 'ms') {
        return { ms: obj.value, pct: null };
      }
      if (obj.unit === 's') {
        return { ms: obj.value * 1000, pct: null };
      }
    }
  }
  return { ms: null, pct: null };
}

function resolveTimelineDomain(timeline: AnimationTimeline | null): MotionTimelineDomain {
  if (!timeline) {
    return 'unknown';
  }
  const ctorName = typeof timeline.constructor.name === 'string' ? timeline.constructor.name : '';
  if (ctorName === 'ViewTimeline') {
    return 'view_progress_percent';
  }
  if (ctorName === 'ScrollTimeline') {
    return 'scroll_progress_percent';
  }
  const dur = (timeline as { duration?: unknown }).duration;
  const parsed = readCssNumberish(dur);
  if (parsed.pct !== null) {
    return 'scroll_progress_percent';
  }
  return 'time_ms';
}

function detectCanvasContextHint(canvas: HTMLCanvasElement): string {
  const rec = (canvas as unknown as { __mcCtx?: unknown }).__mcCtx;
  if (typeof rec === 'string' && rec.length > 0) {
    return rec;
  }
  return 'preexisting_or_unprobed';
}

function extractTargetIdentity(el: Element, win: Window, targetId: string): MotionTargetIdentity {
  const rect = el.getBoundingClientRect();
  const cs = win.getComputedStyle(el);
  const clippingAncestors: MotionTargetIdentity['clippingAncestors'] = [];
  const nestedTransformAncestors: MotionTargetIdentity['nestedTransformAncestors'] = [];

  let cur: Element | null = el.parentElement;
  let depth = 0;
  while (cur && depth < 12) {
    if (!isPageSiftElement(cur)) {
      const pcs = win.getComputedStyle(cur);
      const ovX = pcs.overflowX || 'visible';
      const ovY = pcs.overflowY || 'visible';
      if (
        ovX === 'hidden' ||
        ovX === 'clip' ||
        ovX === 'scroll' ||
        ovX === 'auto' ||
        ovY === 'hidden' ||
        ovY === 'clip' ||
        ovY === 'scroll' ||
        ovY === 'auto'
      ) {
        clippingAncestors.push({
          selector: buildShortSelector(cur),
          overflowX: ovX,
          overflowY: ovY,
        });
      }
      if (
        pcs.transform &&
        pcs.transform !== 'none' &&
        pcs.transform !== 'matrix(1, 0, 0, 1, 0, 0)'
      ) {
        nestedTransformAncestors.push({
          selector: buildShortSelector(cur),
          transform: pcs.transform.slice(0, 200),
        });
      }
    }
    cur = cur.parentElement;
    depth += 1;
  }

  let insideOpenShadowRoot = false;
  let node: Node | null = el.parentNode;
  while (node) {
    if (node.nodeType === 11) {
      insideOpenShadowRoot = true;
      break;
    }
    node = node.parentNode;
  }

  const accessibleName =
    el.getAttribute('aria-label') ||
    (el.childElementCount === 0 ? (el.textContent || '').trim().slice(0, 80) : null) ||
    null;

  return {
    targetId,
    selector: buildShortSelector(el),
    tagName: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    accessibleName,
    insideOpenShadowRoot,
    initialBox: {
      x: Number(rect.x.toFixed(2)),
      y: Number(rect.y.toFixed(2)),
      width: Math.max(0, Number(rect.width.toFixed(2))),
      height: Math.max(0, Number(rect.height.toFixed(2))),
    },
    transformOrigin: cs.transformOrigin || '50% 50% 0px',
    clippingAncestors: clippingAncestors.slice(0, 12),
    nestedTransformAncestors: nestedTransformAncestors.slice(0, 12),
  };
}

function readAnimationRecord(an: Animation, index: number): DeclaredAnimationEntry | null {
  const eff = an.effect;
  const target = eff && 'target' in eff ? (eff as KeyframeEffect).target : null;
  if (target && isPageSiftElement(target)) {
    return null;
  }

  const ctorName = typeof an.constructor.name === 'string' ? an.constructor.name : '';
  const kind: DeclaredAnimationEntry['kind'] =
    ctorName === 'CSSTransition' || 'transitionProperty' in an
      ? 'css_transition'
      : ctorName === 'CSSAnimation' || 'animationName' in an
        ? 'css_animation'
        : 'waapi';

  const animName =
    (an as unknown as { animationName?: string }).animationName ||
    (an as unknown as { transitionProperty?: string }).transitionProperty ||
    an.id ||
    `${kind}-${index}`;

  const timing = eff ? eff.getTiming() : {};
  const computedTiming =
    eff && typeof eff.getComputedTiming === 'function' ? eff.getComputedTiming() : null;
  const rawDuration = timing.duration;
  const durationMs =
    typeof rawDuration === 'number' && Number.isFinite(rawDuration)
      ? rawDuration
      : typeof computedTiming?.duration === 'number' && Number.isFinite(computedTiming.duration)
        ? computedTiming.duration
        : null;
  const delayMs =
    typeof timing.delay === 'number' && Number.isFinite(timing.delay) ? timing.delay : 0;
  const endDelayMs =
    typeof timing.endDelay === 'number' && Number.isFinite(timing.endDelay) ? timing.endDelay : 0;

  const iterationsRaw = timing.iterations;
  const iterations: number | 'infinite' =
    iterationsRaw === Infinity
      ? 'infinite'
      : typeof iterationsRaw === 'number' && Number.isFinite(iterationsRaw)
        ? iterationsRaw
        : 1;

  const currentParsed = readCssNumberish(an.currentTime);
  const timelineDomain = resolveTimelineDomain(an.timeline);

  const keyframes: MotionKeyframeEntry[] = [];
  if (eff && typeof (eff as KeyframeEffect).getKeyframes === 'function') {
    try {
      const rawFrames = (eff as KeyframeEffect).getKeyframes().slice(0, 32);
      for (const kf of rawFrames) {
        const computedOffset = typeof kf.computedOffset === 'number' ? kf.computedOffset : 0;
        const offset = typeof kf.offset === 'number' ? kf.offset : null;
        const propEntries = Object.entries(kf).filter(
          ([k]) => k !== 'offset' && k !== 'computedOffset' && k !== 'easing' && k !== 'composite',
        );
        for (const [prop, val] of propEntries.slice(0, 6)) {
          if (typeof val === 'string' || typeof val === 'number') {
            keyframes.push({
              offset,
              computedOffset,
              ...(typeof kf.easing === 'string' ? { easing: kf.easing } : {}),
              ...(typeof kf.composite === 'string' ? { composite: kf.composite } : {}),
              value: `${prop}: ${String(val)}`.slice(0, 512),
            });
          }
        }
      }
    } catch {
      return null;
    }
  }

  return {
    animationId: an.id || `anim-${index}-${animName}`,
    kind,
    name: animName,
    selector: target ? buildShortSelector(target) : 'document',
    propertyHint:
      (an as unknown as { transitionProperty?: string }).transitionProperty ||
      (keyframes[0] ? (String(keyframes[0].value).split(':')[0] ?? 'composite') : 'composite'),
    playState: an.playState,
    timelineDomain,
    currentTimeMs: currentParsed.ms,
    progressPct: currentParsed.pct,
    delayMs,
    endDelayMs,
    durationMs,
    iterations,
    direction: timing.direction ?? 'normal',
    fillMode: timing.fill ?? 'none',
    easing: timing.easing ?? 'linear',
    composite: (timing as { composite?: string }).composite ?? 'replace',
    keyframes: keyframes.slice(0, MOTION_CAPTURE_DEFAULTS.maxKeyframesPerTrack),
  };
}

function collectBoundedSubtree(
  rootElement: Element,
  maxTargets: number,
): { elements: Element[]; truncated: boolean } {
  const elements: Element[] = [];
  if (isPageSiftElement(rootElement)) {
    return { elements, truncated: false };
  }
  elements.push(rootElement);
  const descendants = Array.from(rootElement.querySelectorAll('*'));
  let truncated = false;
  for (const el of descendants) {
    if (isPageSiftElement(el)) {
      continue;
    }
    if (elements.length >= maxTargets) {
      truncated = true;
      break;
    }
    elements.push(el);
  }
  return { elements, truncated };
}

function detectMotionLibraries(doc: Document, win: Window): string[] {
  const libs: string[] = [];
  const w = win as unknown as Record<string, unknown>;
  if (w['gsap']) libs.push('GSAP');
  if (w['ScrollTrigger']) libs.push('GSAP ScrollTrigger');
  if (w['Lenis'] || doc.documentElement.classList.contains('lenis')) libs.push('Lenis');
  if (doc.querySelector('[data-framer-appear-id], [data-projection-id]')) {
    libs.push('Framer Motion / Motion');
  }
  if (doc.querySelector('[data-w-id], [data-wf-page]')) libs.push('Webflow IX');
  if (w['lottie'] || doc.querySelector('lottie-player, dotlottie-player, [data-lottie]')) {
    libs.push('Lottie');
  }
  if (w['THREE'] || w['__THREE__']) libs.push('three.js');
  return libs;
}

export function inspectDeclaredMotion(
  rootElement: Element,
  doc: Document,
  win: Window,
  maxTargets: number = MOTION_CAPTURE_DEFAULTS.maxTargets,
): MotionInspectionResult {
  const { elements, truncated } = collectBoundedSubtree(rootElement, maxTargets);
  const targets = elements.map((el, idx) => extractTargetIdentity(el, win, `t-${idx}`));

  const declaredAnimations: DeclaredAnimationEntry[] = [];
  if (typeof (rootElement as { getAnimations?: unknown }).getAnimations === 'function') {
    const rawAnims = rootElement.getAnimations({ subtree: true }).slice(0, 128);
    rawAnims.forEach((an, idx) => {
      const parsed = readAnimationRecord(an, idx);
      if (parsed) {
        declaredAnimations.push(parsed);
      }
    });
  }

  const declaredCssRules: MotionInspectionResult['declaredCssRules'] = [];
  for (const el of elements) {
    const cs = win.getComputedStyle(el);
    const hasTr =
      cs.transitionDuration && cs.transitionDuration !== '0s' && cs.transitionProperty !== 'none';
    const hasAnim = cs.animationName && cs.animationName !== 'none';
    if (hasTr || hasAnim) {
      declaredCssRules.push({
        selector: buildShortSelector(el),
        transition:
          `${cs.transitionProperty} ${cs.transitionDuration} ${cs.transitionTimingFunction} ${cs.transitionDelay}`.trim(),
        animation:
          `${cs.animationName} ${cs.animationDuration} ${cs.animationTimingFunction} ${cs.animationDelay}`.trim(),
        transformOrigin: cs.transformOrigin || '50% 50% 0px',
      });
    }
  }

  const keyframeRules: Array<{ name: string; cssText: string }> = [];
  const unavailableItems: MotionUnavailableItem[] = [];
  const warnings: string[] = [];

  if (truncated) {
    warnings.push(
      `Subtree truncated at ${maxTargets} target elements to bound observation overhead.`,
    );
  }

  const frameReport = inspectFramesAndStylesheets(doc, 0);
  for (const inaccessibleSheet of frameReport.inaccessibleStylesheets) {
    unavailableItems.push({
      category: 'cross_origin_stylesheet',
      target: inaccessibleSheet.slice(0, 200),
      reason:
        'Cross-origin stylesheet cssRules blocked by browser CORS policy; @keyframes inside this sheet could not be inspected.',
    });
  }
  for (const frameSrc of frameReport.inaccessibleCrossOriginFrames) {
    unavailableItems.push({
      category: 'cross_origin_iframe',
      target: frameSrc.slice(0, 200),
      reason: 'Cross-origin iframe DOM and animations cannot be accessed from the parent document.',
    });
  }

  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    const visitRules = (list: CSSRuleList): void => {
      for (const rule of Array.from(list)) {
        const cssTextHead = rule.cssText.trim().slice(0, 20).toLowerCase();
        if (cssTextHead.startsWith('@keyframes') && 'name' in rule) {
          keyframeRules.push({
            name: (rule as CSSKeyframesRule).name,
            cssText: rule.cssText.slice(0, 4000),
          });
        } else if ('cssRules' in rule) {
          try {
            visitRules((rule as CSSGroupingRule).cssRules);
          } catch {
            return;
          }
        }
      }
    };
    visitRules(rules);
  }

  const canvases: MotionSpec['canvasesDetected'] = [];
  const canvasNodes = Array.from(rootElement.querySelectorAll('canvas'));
  if (rootElement.tagName.toLowerCase() === 'canvas') {
    canvasNodes.unshift(rootElement as HTMLCanvasElement);
  }
  for (const canvas of canvasNodes.slice(0, 12)) {
    if (isPageSiftElement(canvas)) continue;
    const hint = detectCanvasContextHint(canvas);
    const r = canvas.getBoundingClientRect();
    canvases.push({
      selector: buildShortSelector(canvas),
      width: Math.max(0, Math.round(r.width)),
      height: Math.max(0, Math.round(r.height)),
      contextHint: hint,
    });
    unavailableItems.push({
      category: 'canvas_gpu',
      target: buildShortSelector(canvas),
      reason:
        'Canvas/WebGL/WebGPU contexts created before PageSift attached cannot expose shader sources or uniform streams from live observation alone.',
    });
  }

  let reducedMotionPreference: 'no-preference' | 'reduce' | 'unknown' = 'unknown';
  if (typeof win.matchMedia === 'function') {
    reducedMotionPreference = win.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'reduce'
      : 'no-preference';
  }

  const detectedEngines = detectMotionLibraries(doc, win);
  if (
    declaredAnimations.length === 0 &&
    declaredCssRules.length === 0 &&
    detectedEngines.length === 0
  ) {
    warnings.push(
      'No active animations found before observation; completed load animations may have finished before PageSift attached, or motion may start only on hover/click/scroll.',
    );
  }

  return {
    rootSelector: buildShortSelector(rootElement),
    pageUrl: doc.location.href,
    pageTitle: doc.title || 'Untitled Page',
    viewport: {
      width: win.innerWidth || 1280,
      height: win.innerHeight || 800,
    },
    devicePixelRatio: win.devicePixelRatio || 1,
    scrollPosition: {
      x: win.scrollX || 0,
      y: win.scrollY || 0,
    },
    reducedMotionPreference,
    targets,
    declaredAnimations,
    declaredCssRules,
    keyframeRules: keyframeRules.slice(0, 48),
    canvases,
    detectedEngines,
    unavailableItems,
    warnings,
  };
}

export class MotionObservationSession {
  public readonly sessionId: string;
  private readonly config: MotionObservationConfig;
  private readonly maxDurationMs: number;
  private readonly maxTargets: number;
  private readonly maxSamplesPerTarget: number;
  private readonly inspection: MotionInspectionResult;
  private readonly trackedElements: Array<{ targetId: string; element: Element }> = [];
  private readonly seriesByTargetId: Record<string, ObservedTargetSeries> = {};
  private readonly lifecycleEvents: MotionLifecycleEvent[] = [];
  private readonly dynamicAnimsMap = new Map<string, DeclaredAnimationEntry>();

  private state: MotionObservationRawResult['state'] = 'completed';
  private interruptionReason: string | null = null;
  private startedAtIso = '';
  private startPerfMs = 0;
  private triggerTimestampMs: number | null = null;
  private rafId: number | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private sampleCount = 0;
  private lastSamplePerfMs = 0;
  private droppedSamplesEstimate = 0;

  public constructor(config: MotionObservationConfig) {
    this.config = config;
    this.sessionId = `mlab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.maxDurationMs = Math.max(
      250,
      Math.min(
        MOTION_CAPTURE_DEFAULTS.maxDurationMs,
        config.maxDurationMs ?? MOTION_CAPTURE_DEFAULTS.defaultDurationMs,
      ),
    );
    this.maxTargets = Math.max(
      1,
      Math.min(
        MOTION_CAPTURE_DEFAULTS.maxTargets,
        config.maxTargets ?? MOTION_CAPTURE_DEFAULTS.maxTargets,
      ),
    );
    this.maxSamplesPerTarget = Math.max(
      10,
      Math.min(
        MOTION_CAPTURE_DEFAULTS.maxSamplesPerTarget,
        config.maxSamplesPerTarget ?? MOTION_CAPTURE_DEFAULTS.maxSamplesPerTarget,
      ),
    );
    this.inspection = inspectDeclaredMotion(
      config.rootElement,
      config.doc,
      config.win,
      this.maxTargets,
    );
    const { elements } = collectBoundedSubtree(config.rootElement, this.maxTargets);
    elements.forEach((el, idx) => {
      const identity = this.inspection.targets[idx];
      if (identity) {
        this.trackedElements.push({ targetId: identity.targetId, element: el });
        this.seriesByTargetId[identity.targetId] = { identity, samples: [] };
      }
    });
  }

  public getInspection(): MotionInspectionResult {
    return this.inspection;
  }

  public start(): void {
    if (this.disposed) {
      return;
    }
    this.startedAtIso = new Date().toISOString();
    this.startPerfMs = performance.now();
    this.lastSamplePerfMs = this.startPerfMs;

    const { doc, win } = this.config;
    const events: MotionLifecycleEvent['type'][] = [
      'animationstart',
      'animationend',
      'animationcancel',
      'transitionrun',
      'transitionstart',
      'transitionend',
      'transitioncancel',
      'pointerenter',
      'pointerdown',
      'click',
      'focusin',
      'scroll',
    ];
    for (const evType of events) {
      doc.addEventListener(evType, this.handleLifecycleEvent, true);
    }
    doc.addEventListener('visibilitychange', this.handleVisibilityChange);
    win.addEventListener('pagehide', this.handlePageHide);

    this.captureFrameSample();

    this.timeoutId = setTimeout(() => {
      this.finish('completed', null);
    }, this.maxDurationMs);

    const scheduleNext = (): void => {
      if (this.disposed) return;
      if (typeof win.requestAnimationFrame === 'function') {
        this.rafId = win.requestAnimationFrame(() => {
          this.tick();
          if (!this.disposed) {
            scheduleNext();
          }
        });
      } else {
        this.rafId = setTimeout(() => {
          this.tick();
          if (!this.disposed) {
            scheduleNext();
          }
        }, 16) as unknown as number;
      }
    };
    scheduleNext();
  }

  public cancel(reason = 'Cancelled by user'): MotionObservationRawResult {
    return this.finish('cancelled', reason);
  }

  public stopEarly(): MotionObservationRawResult {
    return this.finish('completed', null);
  }

  private readonly handleVisibilityChange = (): void => {
    if (this.config.doc.visibilityState === 'hidden') {
      this.finish('partial', 'Tab became hidden during observation; saved partial samples.');
    }
  };

  private readonly handlePageHide = (): void => {
    this.finish('partial', 'Page navigated or unloaded during observation; saved partial samples.');
  };

  private readonly handleLifecycleEvent = (ev: Event): void => {
    if (this.disposed) return;
    const target = ev.target instanceof Element ? ev.target : null;
    if (target && isPageSiftElement(target)) {
      return;
    }
    if (
      target &&
      target !== this.config.rootElement &&
      !this.config.rootElement.contains(target) &&
      ev.type !== 'scroll'
    ) {
      return;
    }
    const tMs = Number((performance.now() - this.startPerfMs).toFixed(2));
    if (
      this.triggerTimestampMs === null &&
      (ev.type === 'pointerenter' ||
        ev.type === 'pointerdown' ||
        ev.type === 'click' ||
        ev.type === 'focusin' ||
        ev.type === 'scroll' ||
        ev.type === 'transitionrun' ||
        ev.type === 'animationstart')
    ) {
      this.triggerTimestampMs = tMs;
    }

    let detail = ev.type;
    if ('propertyName' in ev) {
      detail = (ev as TransitionEvent).propertyName;
    } else if ('animationName' in ev) {
      detail = (ev as AnimationEvent).animationName;
    }

    if (this.lifecycleEvents.length < 200) {
      this.lifecycleEvents.push({
        tMs,
        type: ev.type as MotionLifecycleEvent['type'],
        selector: target ? buildShortSelector(target) : 'document',
        detail,
      });
    }
  };

  private captureDynamicAnimations(): void {
    const root = this.config.rootElement;
    if (typeof (root as { getAnimations?: unknown }).getAnimations !== 'function') {
      return;
    }
    const active = root.getAnimations({ subtree: true }).slice(0, 128);
    active.forEach((an, idx) => {
      const parsed = readAnimationRecord(an, idx);
      if (!parsed) return;
      const key = `${parsed.kind}|${parsed.selector}|${parsed.name}|${parsed.propertyHint}`;
      this.dynamicAnimsMap.set(key, parsed);
    });
  }

  private captureFrameSample(): void {
    const nowPerf = performance.now();
    const tMs = Number((nowPerf - this.startPerfMs).toFixed(2));
    const dt = nowPerf - this.lastSamplePerfMs;
    if (this.sampleCount > 0 && dt > 40) {
      this.droppedSamplesEstimate += Math.max(1, Math.floor(dt / 16.67) - 1);
    }
    this.lastSamplePerfMs = nowPerf;

    const { doc, win } = this.config;
    const scrollX = win.scrollX || 0;
    const scrollY = win.scrollY || 0;
    const maxScrollY = Math.max(0, doc.documentElement.scrollHeight - (win.innerHeight || 0));
    const scrollProgressPct =
      maxScrollY > 0 ? Number(((scrollY / maxScrollY) * 100).toFixed(2)) : null;

    const readings: Array<{
      targetId: string;
      rect: DOMRect;
      cs: CSSStyleDeclaration;
      connected: boolean;
    }> = [];

    let rootDisconnected = !this.config.rootElement.isConnected;
    for (const item of this.trackedElements) {
      if (!item.element.isConnected) {
        if (item.element === this.config.rootElement) {
          rootDisconnected = true;
        }
        continue;
      }
      readings.push({
        targetId: item.targetId,
        rect: item.element.getBoundingClientRect(),
        cs: win.getComputedStyle(item.element),
        connected: true,
      });
    }

    if (rootDisconnected) {
      this.finish('partial', 'Target element was removed from the DOM during observation.');
      return;
    }

    for (const r of readings) {
      const bucket = this.seriesByTargetId[r.targetId];
      if (!bucket || bucket.samples.length >= this.maxSamplesPerTarget) {
        continue;
      }
      const opacityVal = Number.parseFloat(r.cs.opacity || '1');
      bucket.samples.push({
        tMs,
        scrollX,
        scrollY,
        scrollProgressPct,
        box: {
          x: Number(r.rect.x.toFixed(2)),
          y: Number(r.rect.y.toFixed(2)),
          width: Math.max(0, Number(r.rect.width.toFixed(2))),
          height: Math.max(0, Number(r.rect.height.toFixed(2))),
        },
        opacity: Number.isFinite(opacityVal) ? Number(opacityVal.toFixed(4)) : 1,
        transform: r.cs.transform || 'none',
        translate: (r.cs as unknown as { translate?: string }).translate || 'none',
        scale: (r.cs as unknown as { scale?: string }).scale || 'none',
        rotate: (r.cs as unknown as { rotate?: string }).rotate || 'none',
        clipPath: r.cs.clipPath || 'none',
      });
    }

    this.sampleCount += 1;
    this.captureDynamicAnimations();

    if (this.sampleCount >= this.maxSamplesPerTarget) {
      this.finish('partial', `Reached sample cap (${this.maxSamplesPerTarget} frames).`);
      return;
    }

    if (this.config.onProgress && this.sampleCount % 8 === 0) {
      this.config.onProgress({
        elapsedMs: Math.round(tMs),
        sampleCount: this.sampleCount,
        state: 'recording',
      });
    }
  }

  private tick(): void {
    if (this.disposed) {
      return;
    }
    this.captureFrameSample();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const { doc, win } = this.config;
    if (this.rafId !== null) {
      if (typeof win.cancelAnimationFrame === 'function') {
        win.cancelAnimationFrame(this.rafId);
      } else {
        clearTimeout(this.rafId);
      }
      this.rafId = null;
    }
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    const events: MotionLifecycleEvent['type'][] = [
      'animationstart',
      'animationend',
      'animationcancel',
      'transitionrun',
      'transitionstart',
      'transitionend',
      'transitioncancel',
      'pointerenter',
      'pointerdown',
      'click',
      'focusin',
      'scroll',
    ];
    for (const evType of events) {
      doc.removeEventListener(evType, this.handleLifecycleEvent, true);
    }
    doc.removeEventListener('visibilitychange', this.handleVisibilityChange);
    win.removeEventListener('pagehide', this.handlePageHide);
  }

  private finish(
    finalState: MotionObservationRawResult['state'],
    reason: string | null,
  ): MotionObservationRawResult {
    if (!this.disposed) {
      this.state = finalState;
      this.interruptionReason = reason;
      this.dispose();
    }
    const observedDurationMs = Math.max(
      0,
      Number((performance.now() - this.startPerfMs).toFixed(1)),
    );
    const measuredMeanFps =
      observedDurationMs > 20 && this.sampleCount > 1
        ? Number((((this.sampleCount - 1) * 1000) / observedDurationMs).toFixed(1))
        : null;

    const result: MotionObservationRawResult = {
      sessionId: this.sessionId,
      state: this.state,
      interruptionReason: this.interruptionReason,
      startedAtIso: this.startedAtIso || new Date().toISOString(),
      completedAtIso: new Date().toISOString(),
      observedDurationMs,
      trigger: this.config.trigger ?? 'manual',
      triggerTimestampMs: this.triggerTimestampMs,
      inspection: this.inspection,
      seriesByTargetId: this.seriesByTargetId,
      lifecycleEvents: this.lifecycleEvents,
      dynamicAnimations: Array.from(this.dynamicAnimsMap.values()),
      droppedSamplesEstimate: this.droppedSamplesEstimate,
      measuredMeanFps,
    };
    this.config.onComplete?.(result);
    return result;
  }
}

export function classifyDeclaredCategory(
  kind: DeclaredAnimationEntry['kind'],
  domain: MotionTimelineDomain,
): MotionCategory {
  if (domain === 'scroll_progress_percent' || domain === 'view_progress_percent') {
    return 'scroll_driven';
  }
  return kind;
}

export function evidenceClassForDeclared(
  _kind: DeclaredAnimationEntry['kind'],
): MotionEvidenceClass {
  return 'declared';
}
