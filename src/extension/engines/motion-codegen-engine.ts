import { generateMotionMd, type MotionSpec, type MotionTrack } from './motion-spec.js';

const SAFE_CSS_PROPERTY_ALLOWLIST = new Set([
  'opacity',
  'transform',
  'translate',
  'scale',
  'rotate',
  'transform-origin',
  'clip-path',
  'filter',
  'background-color',
  'color',
  'border-color',
  'box-shadow',
  'width',
  'height',
]);

const UNSAFE_CSS_VALUE_RE = /url\s*\(|expression\s*\(|javascript:|@import|<script|<\/style/i;

export function sanitizeCssValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 400 || UNSAFE_CSS_VALUE_RE.test(trimmed)) {
    return null;
  }
  return trimmed.replace(/[<>]/g, '');
}

function sanitizeSafeIdentifier(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 48) || fallback;
}

function escapeHtmlText(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface GeneratedMotionExports {
  cssCode: string;
  waapiCode: string;
  htmlDemo: string;
  motionMd: string;
  reconstructionPrompt: string;
  unsupportedTracks: Array<{ trackId: string; selector: string; property: string; reason: string }>;
}

function resolveTrackTiming(track: MotionTrack): {
  durationMs: number;
  delayMs: number;
  easing: string;
  fillMode: string;
  iterations: string;
  fromCssVal: string;
  toCssVal: string;
  cssProp: string;
} | null {
  if (!track.replaySupported) {
    return null;
  }
  const durationMs = Math.max(50, Math.round(track.durationMs ?? 500));
  const delayMs = Math.max(0, Math.round(track.delayMs ?? 0));
  const easing =
    sanitizeCssValue(
      track.declaredEasing ??
        track.inferredEasings[0]?.cssEasing ??
        'cubic-bezier(0.22, 1, 0.36, 1)',
    ) ?? 'ease-out';
  const fillMode =
    track.fillMode && /^[a-z-]+$/i.test(track.fillMode) ? track.fillMode : 'forwards';
  const iterations =
    track.iterations === 'infinite'
      ? 'infinite'
      : typeof track.iterations === 'number' && track.iterations > 0
        ? String(track.iterations)
        : '1';

  let cssProp = track.property;
  let fromVal = String(track.fromValue ?? '');
  let toVal = String(track.toValue ?? '');

  if (track.property === 'translateX') {
    cssProp = 'transform';
    fromVal = `translateX(${fromVal})`;
    toVal = `translateX(${toVal})`;
  } else if (track.property === 'translateY') {
    cssProp = 'transform';
    fromVal = `translateY(${fromVal})`;
    toVal = `translateY(${toVal})`;
  } else if (track.property === 'scaleX' || track.property === 'scaleY') {
    cssProp = 'transform';
    const axis = track.property === 'scaleX' ? 'scaleX' : 'scaleY';
    fromVal = `${axis}(${fromVal})`;
    toVal = `${axis}(${toVal})`;
  } else if (track.property === 'rotate') {
    cssProp = 'transform';
    fromVal = `rotate(${fromVal})`;
    toVal = `rotate(${toVal})`;
  } else if (track.keyframes.length >= 2) {
    const firstParts = String(track.keyframes[0]?.value ?? '').split(':');
    const lastParts = String(track.keyframes[track.keyframes.length - 1]?.value ?? '').split(':');
    const propName = (firstParts[0] ?? '').trim();
    if (SAFE_CSS_PROPERTY_ALLOWLIST.has(propName)) {
      cssProp = propName;
      fromVal = firstParts.slice(1).join(':').trim();
      toVal = lastParts.slice(1).join(':').trim();
    }
  }

  if (!SAFE_CSS_PROPERTY_ALLOWLIST.has(cssProp)) {
    return null;
  }
  const safeFrom = sanitizeCssValue(fromVal);
  const safeTo = sanitizeCssValue(toVal);
  if (!safeFrom || !safeTo) {
    return null;
  }

  return {
    durationMs,
    delayMs,
    easing,
    fillMode,
    iterations,
    fromCssVal: safeFrom,
    toCssVal: safeTo,
    cssProp,
  };
}

export function generateMotionExports(spec: MotionSpec): GeneratedMotionExports {
  const cssBlocks: string[] = [];
  const waapiBlocks: string[] = [];
  const demoFixtures: Array<{
    className: string;
    label: string;
    width: number;
    height: number;
    transformOrigin: string;
    keyframeName: string;
    cssProp: string;
    fromCssVal: string;
    toCssVal: string;
    durationMs: number;
    delayMs: number;
    easing: string;
    iterations: string;
    fillMode: string;
    evidenceClass: string;
  }> = [];
  const unsupportedTracks: GeneratedMotionExports['unsupportedTracks'] = [];

  const targetOriginById = new Map(spec.targets.map((t) => [t.targetId, t]));

  const replayableTracks = spec.tracks.slice(0, 24);
  replayableTracks.forEach((track, idx) => {
    const resolved = resolveTrackTiming(track);
    if (!resolved) {
      unsupportedTracks.push({
        trackId: track.trackId,
        selector: track.selector,
        property: track.property,
        reason:
          track.unsupportedReason ??
          `Property "${track.property}" or timeline "${track.timelineDomain}" cannot be exported into standalone CSS/WAAPI.`,
      });
      return;
    }

    const targetMeta = targetOriginById.get(track.targetId);
    const origin = sanitizeCssValue(targetMeta?.transformOrigin ?? '50% 50% 0px') ?? '50% 50% 0px';
    const safeClass = sanitizeSafeIdentifier(`motion-target-${idx + 1}`, `target-${idx + 1}`);
    const kfName = sanitizeSafeIdentifier(`ps-kf-${idx + 1}-${track.property}`, `ps-kf-${idx + 1}`);

    cssBlocks.push(
      `@keyframes ${kfName} {\n` +
        `  from { ${resolved.cssProp}: ${resolved.fromCssVal}; }\n` +
        `  to { ${resolved.cssProp}: ${resolved.toCssVal}; }\n` +
        `}\n` +
        `.${safeClass} {\n` +
        `  transform-origin: ${origin};\n` +
        `  animation: ${kfName} ${resolved.durationMs}ms ${resolved.easing} ${resolved.delayMs}ms ${resolved.iterations} ${resolved.fillMode};\n` +
        `}`,
    );

    waapiBlocks.push(
      `const el${idx + 1} = document.querySelector(${JSON.stringify('.' + safeClass)});\n` +
        `if (el${idx + 1} && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {\n` +
        `  el${idx + 1}.style.transformOrigin = ${JSON.stringify(origin)};\n` +
        `  el${idx + 1}.animate(\n` +
        `    [\n` +
        `      { ${JSON.stringify(resolved.cssProp)}: ${JSON.stringify(resolved.fromCssVal)} },\n` +
        `      { ${JSON.stringify(resolved.cssProp)}: ${JSON.stringify(resolved.toCssVal)} }\n` +
        `    ],\n` +
        `    {\n` +
        `      duration: ${resolved.durationMs},\n` +
        `      delay: ${resolved.delayMs},\n` +
        `      easing: ${JSON.stringify(resolved.easing)},\n` +
        `      iterations: ${resolved.iterations === 'infinite' ? 'Infinity' : resolved.iterations},\n` +
        `      fill: ${JSON.stringify(resolved.fillMode)}\n` +
        `    }\n` +
        `  );\n` +
        `}`,
    );

    demoFixtures.push({
      className: safeClass,
      label: `${track.selector} (${track.property} · ${track.evidenceClass})`,
      width: Math.max(48, Math.min(480, Math.round(targetMeta?.initialBox.width || 220))),
      height: Math.max(36, Math.min(200, Math.round(targetMeta?.initialBox.height || 64))),
      transformOrigin: origin,
      keyframeName: kfName,
      cssProp: resolved.cssProp,
      fromCssVal: resolved.fromCssVal,
      toCssVal: resolved.toCssVal,
      durationMs: resolved.durationMs,
      delayMs: resolved.delayMs,
      easing: resolved.easing,
      iterations: resolved.iterations,
      fillMode: resolved.fillMode,
      evidenceClass: track.evidenceClass,
    });
  });

  const cssCode =
    cssBlocks.length > 0
      ? `${cssBlocks.join('\n\n')}\n\n@media (prefers-reduced-motion: reduce) {\n  ${demoFixtures.map((f) => `.${f.className}`).join(', ')} {\n    animation: none !important;\n    transition: none !important;\n  }\n}\n`
      : '/* No exportable CSS keyframe tracks available in this MotionSpec. */\n';

  const waapiCode =
    waapiBlocks.length > 0
      ? `(() => {\n${waapiBlocks.join('\n\n')}\n})();\n`
      : '// No exportable WAAPI tracks available in this MotionSpec.\n';

  const fixtureStyles = demoFixtures
    .map(
      (f) =>
        `.${f.className} { width: ${f.width}px; height: ${f.height}px; transform-origin: ${f.transformOrigin}; border: 1px solid #115e59; background: #0b2626; color: #f3f4f6; border-radius: 8px; display: flex; align-items: center; padding: 8px 12px; font-size: 12px; }`,
    )
    .join('\n      ');

  const fixtureNodes =
    demoFixtures.length > 0
      ? demoFixtures
          .map(
            (f) =>
              `<div class="fixture-item ${escapeHtmlText(f.className)}">${escapeHtmlText(f.label)}</div>`,
          )
          .join('\n        ')
      : '<div class="fixture-empty">No replayable motion tracks in this specification.</div>';

  const safeTitle = escapeHtmlText(spec.environment.pageTitle || spec.rootSelector);
  const waapiSerialized = JSON.stringify(
    demoFixtures.map((f) => ({
      selector: `.${f.className}`,
      keyframes: [{ [f.cssProp]: f.fromCssVal }, { [f.cssProp]: f.toCssVal }],
      options: {
        duration: f.durationMs,
        delay: f.delayMs,
        easing: f.easing,
        iterations: f.iterations === 'infinite' ? null : Number(f.iterations),
        fill: f.fillMode,
      },
    })),
  ).replace(/</g, '\\u003c');

  const htmlDemo = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>PageSift Motion Lab Fixture: ${safeTitle}</title>
    <style>
      body { margin: 0; padding: 24px; background: #0f1214; color: #f3f4f6; font-family: system-ui, sans-serif; }
      .notice { font-size: 12px; color: #94a0ad; margin-bottom: 16px; }
      .controls { display: flex; gap: 8px; margin-bottom: 16px; }
      button { background: #0d9488; color: #ffffff; border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-weight: 600; }
      .stage { display: flex; flex-direction: column; gap: 12px; padding: 20px; border: 1px solid #262d35; border-radius: 10px; background: #171b1f; overflow: hidden; }
      ${fixtureStyles}
      @media (prefers-reduced-motion: reduce) { .fixture-item { animation: none !important; transition: none !important; } }
    </style>
  </head>
  <body>
    <h1>Minimal Reproducible Visual Fixture (${safeTitle})</h1>
    <p class="notice">Generated by PageSift Motion Lab from observed/declared tracks. Placeholder boxes represent target geometry; this is not a full page clone.</p>
    <div class="controls">
      <button id="replay-btn" type="button">Replay</button>
    </div>
    <div class="stage" id="stage">
      ${fixtureNodes}
    </div>
    <script>
      const specs = ${waapiSerialized};
      function playAll() {
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        for (const item of specs) {
          const el = document.querySelector(item.selector);
          if (!el) continue;
          el.getAnimations().forEach((a) => a.cancel());
          if (!reduce) {
            const opts = { ...item.options, iterations: item.options.iterations === null ? Infinity : item.options.iterations };
            el.animate(item.keyframes, opts);
          }
        }
      }
      document.getElementById('replay-btn').addEventListener('click', playAll);
      playAll();
    </script>
  </body>
</html>
`;

  const motionMd = generateMotionMd(spec);
  const reconstructionPrompt = [
    `# Motion Reconstruction Prompt (${spec.rootSelector})`,
    '',
    'Reconstruct the documented motion below while distinguishing **declared** CSS/WAAPI facts from **inferred** curve estimates:',
    '',
    motionMd,
    '## Generated CSS Reference',
    '```css',
    cssCode.trim(),
    '```',
  ].join('\n');

  return {
    cssCode,
    waapiCode,
    htmlDemo,
    motionMd,
    reconstructionPrompt,
    unsupportedTracks,
  };
}
