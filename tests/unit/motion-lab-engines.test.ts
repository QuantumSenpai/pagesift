import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  buildAllowlistedNvidiaContext,
  buildNvidiaEgressPreview,
} from '../../src/extension/ai/nvidia-client.js';
import {
  analyzeNumericSampleSeries,
  buildMotionSpecFromObservation,
  decomposeCssTransform,
} from '../../src/extension/engines/motion-analysis-engine.js';
import {
  generateMotionExports,
  sanitizeCssValue,
} from '../../src/extension/engines/motion-codegen-engine.js';
import {
  buildLabeledContactSheetHtml,
  checkMotionCaptureCompatibility,
  compareFrameSequences,
  compareMotionSpecs,
  estimateRepeatCaptureNoiseFloor,
  type MotionRgbaFrame,
} from '../../src/extension/engines/motion-compare-engine.js';
import {
  buildReanimateHandoffRecipe,
  importReanimateJsonText,
  importReanimateZipBytes,
  validateImportedMediaDescriptor,
} from '../../src/extension/engines/motion-import-engine.js';
import type { MotionObservationRawResult } from '../../src/extension/engines/motion-observation-engine.js';
import {
  MOTION_CAPABILITY_MATRIX,
  MOTION_SPEC_SCHEMA_VERSION,
  motionSpecSchema,
} from '../../src/extension/engines/motion-spec.js';
import { validateMessageEnvelope } from '../../src/extension/protocol/messages.js';
import {
  LOCAL_DB_VERSION,
  LocalExtensionStorage,
  QuotaExceededStorageError,
} from '../../src/extension/storage/idb-storage.js';

function createSolidFrame(
  tMs: number,
  width: number,
  height: number,
  xBox: number,
): MotionRgbaFrame {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const inside = x >= xBox && x < xBox + 6 && y >= 2 && y < 8;
      rgba[idx] = inside ? 13 : 15;
      rgba[idx + 1] = inside ? 148 : 18;
      rgba[idx + 2] = inside ? 136 : 20;
      rgba[idx + 3] = 255;
    }
  }
  return { tMs, width, height, rgba };
}

describe('Motion Lab engines, schemas, safety & storage', () => {
  it('defines capability matrix across all 7 categories cleanly', () => {
    const categories = MOTION_CAPABILITY_MATRIX.map((c) => c.category);
    expect(categories).toEqual([
      'css_animation',
      'css_transition',
      'waapi',
      'js_driven',
      'scroll_driven',
      'canvas_gpu',
      'imported',
    ]);
    const gpu = MOTION_CAPABILITY_MATRIX.find((c) => c.category === 'canvas_gpu');
    expect(gpu?.status).toBe('unavailable');
    expect(gpu?.evidenceClass).toBe('unavailable');
  });

  it('decomposes 2D & 3D CSS transform matrices accurately', () => {
    const t2d = decomposeCssTransform('matrix(1.5, 0, 0, 1.5, 42.5, -18)');
    expect(t2d.translateX).toBeCloseTo(42.5, 2);
    expect(t2d.translateY).toBeCloseTo(-18, 2);
    expect(t2d.scaleX).toBeCloseTo(1.5, 2);
    expect(t2d.scaleY).toBeCloseTo(1.5, 2);
    expect(t2d.rotateDeg).toBeCloseTo(0, 2);

    const rot = decomposeCssTransform('matrix(0, 1, -1, 0, 10, 20)');
    expect(rot.translateX).toBeCloseTo(10, 2);
    expect(rot.rotateDeg).toBeCloseTo(90, 1);

    const noneT = decomposeCssTransform('none');
    expect(noneT.scaleX).toBe(1);
    expect(noneT.translateX).toBe(0);
  });

  it('infers easing candidates with low RMSE for ease-out motion and marks constant series', () => {
    const pts: Array<{ tMs: number; value: number }> = [];
    for (let i = 0; i <= 20; i += 1) {
      const p = i / 20;
      const eased = 1 - Math.pow(1 - p, 3);
      pts.push({ tMs: 100 + p * 400, value: eased * 120 });
    }
    const analysis = analyzeNumericSampleSeries(pts);
    expect(analysis.hasMotion).toBe(true);
    expect(analysis.isConstant).toBe(false);
    expect(analysis.visibleDurationMs).toBeGreaterThan(250);
    expect(analysis.inferredEasings.length).toBeGreaterThan(0);
    expect(analysis.inferredEasings[0]?.rmse ?? 1).toBeLessThan(0.1);
    expect(analysis.directionHint).toBe('forward');

    const staticAnalysis = analyzeNumericSampleSeries([
      { tMs: 0, value: 1 },
      { tMs: 50, value: 1 },
      { tMs: 100, value: 1 },
    ]);
    expect(staticAnalysis.hasMotion).toBe(false);
    expect(staticAnalysis.isConstant).toBe(true);
    expect(staticAnalysis.inferredEasings).toEqual([]);
  });

  it('builds validated MotionSpec distinguishing declared, observed, inferred & unavailable tracks with scroll domain', () => {
    const t1Identity = {
      targetId: 't-1',
      selector: '#card-1',
      tagName: 'div',
      role: 'article',
      accessibleName: 'Card 1',
      insideOpenShadowRoot: false,
      initialBox: { x: 20, y: 40, width: 200, height: 120 },
      transformOrigin: '50% 50% 0px',
      clippingAncestors: [{ selector: '#cards', overflowX: 'hidden', overflowY: 'auto' }],
      nestedTransformAncestors: [],
    };
    const t2Identity = {
      targetId: 't-2',
      selector: '#card-2',
      tagName: 'div',
      role: 'article',
      accessibleName: 'Card 2',
      insideOpenShadowRoot: false,
      initialBox: { x: 240, y: 40, width: 200, height: 120 },
      transformOrigin: '50% 50% 0px',
      clippingAncestors: [],
      nestedTransformAncestors: [],
    };

    const raw: MotionObservationRawResult = {
      sessionId: 'sess-unit-1',
      state: 'completed',
      startedAtIso: new Date().toISOString(),
      completedAtIso: new Date().toISOString(),
      observedDurationMs: 1200,
      interruptionReason: null,
      trigger: 'hover',
      triggerTimestampMs: 80,
      inspection: {
        pageUrl: 'https://example.test/cards',
        pageTitle: 'Cards Fixture',
        viewport: { width: 1280, height: 800 },
        devicePixelRatio: 2,
        scrollPosition: { x: 0, y: 0 },
        reducedMotionPreference: 'no-preference',
        rootSelector: '#cards',
        targets: [t1Identity, t2Identity],
        declaredAnimations: [
          {
            animationId: 'waapi-scroll-1',
            selector: '#card-1',
            kind: 'waapi',
            name: 'parallax',
            propertyHint: 'transform',
            timelineDomain: 'scroll_progress_percent',
            currentTimeMs: null,
            progressPct: 0,
            playState: 'running',
            composite: 'replace',
            durationMs: 100,
            delayMs: 0,
            endDelayMs: 0,
            iterations: 1,
            direction: 'normal',
            fillMode: 'both',
            easing: 'linear',
            keyframes: [
              { offset: 0, computedOffset: 0, value: 'translateY(0px)' },
              { offset: 1, computedOffset: 1, value: 'translateY(-40px)' },
            ],
          },
        ],
        declaredCssRules: [],
        keyframeRules: [],
        canvases: [{ selector: '#shader-bg', width: 640, height: 320, contextHint: 'webgl2' }],
        detectedEngines: ['ScrollTimeline / ViewTimeline', 'WebGL/Canvas'],
        unavailableItems: [
          {
            category: 'css_animation',
            target: 'https://cdn.other.test/theme.css',
            reason: 'Cross-origin stylesheet blocked reading @keyframes rules.',
          },
          {
            category: 'canvas_gpu',
            target: '#shader-bg',
            reason:
              'Pre-existing GPU context cannot expose compiled shaders after late attachment.',
          },
        ],
        warnings: [],
      },
      lifecycleEvents: [
        {
          tMs: 100,
          selector: '#card-2',
          type: 'transitionstart',
          detail: 'opacity',
        },
      ],
      dynamicAnimations: [],
      seriesByTargetId: {
        't-1': {
          identity: t1Identity,
          samples: Array.from({ length: 12 }, (_, i) => ({
            tMs: i * 40,
            scrollX: 0,
            scrollY: 0,
            scrollProgressPct: i * 8,
            transform: `matrix(1, 0, 0, 1, 0, ${(i * 2).toFixed(1)})`,
            translate: 'none',
            scale: 'none',
            rotate: 'none',
            clipPath: 'none',
            opacity: i / 11,
            box: { x: 20, y: 40 + i * 2, width: 200, height: 120 },
          })),
        },
        't-2': {
          identity: t2Identity,
          samples: Array.from({ length: 12 }, (_, i) => ({
            tMs: 80 + i * 40,
            scrollX: 0,
            scrollY: 0,
            scrollProgressPct: null,
            transform: 'none',
            translate: 'none',
            scale: 'none',
            rotate: 'none',
            clipPath: 'none',
            opacity: Math.min(1, i / 10),
            box: { x: 240, y: 40, width: 200, height: 120 },
          })),
        },
      },
      droppedSamplesEstimate: 0,
      measuredMeanFps: 59.8,
    };

    const spec = buildMotionSpecFromObservation(raw);
    const parsed = motionSpecSchema.parse(spec);
    expect(parsed.schemaVersion).toBe(MOTION_SPEC_SCHEMA_VERSION);
    expect(parsed.tracks.some((t) => t.timelineDomain === 'scroll_progress_percent')).toBe(true);
    expect(parsed.tracks.some((t) => t.evidenceClass === 'inferred')).toBe(true);
    expect(parsed.unavailableItems.length).toBeGreaterThanOrEqual(2);

    const exportsOut = generateMotionExports(parsed);
    expect(exportsOut.cssCode).toContain('@keyframes');
    expect(exportsOut.waapiCode).toContain('.animate(');
    expect(exportsOut.htmlDemo.toLowerCase()).toContain('<!doctype html>');
    expect(exportsOut.motionMd).toContain('# MOTION.md:');
    expect(exportsOut.motionMd).toContain('#shader-bg');
  });

  it('sanitizes dangerous CSS payloads and rejects unsafe XSS strings in codegen', () => {
    expect(sanitizeCssValue('translateX(20px)')).toBe('translateX(20px)');
    expect(sanitizeCssValue('url(javascript:alert(1))')).toBeNull();
    expect(sanitizeCssValue('expression(alert(1))')).toBeNull();
    expect(sanitizeCssValue('<script>alert(1)</script>')).toBeNull();
  });

  it('enforces comparison setup compatibility, raw vs offset-aligned diffs, noise floor, and contact sheets', () => {
    const framesRef = [0, 1, 2, 3, 4].map((i) => createSolidFrame(i * 50, 32, 16, 4 + i * 3));
    const framesShifted = [0, 1, 2, 3, 4].map((i) =>
      createSolidFrame(i * 50 + 50, 32, 16, 4 + i * 3),
    );
    const diff = compareFrameSequences(framesRef, framesShifted);
    expect(diff.rawMeanMismatchPct).toBeGreaterThan(0);
    expect(diff.alignedMeanMismatchPct).toBeLessThanOrEqual(diff.rawMeanMismatchPct);
    expect(diff.alignedOffsetMs).not.toBe(0);

    const noise = estimateRepeatCaptureNoiseFloor(framesRef, framesRef);
    expect(noise.meanMismatchPct).toBe(0);

    const compat = checkMotionCaptureCompatibility(
      {
        viewport: { width: 1280, height: 800 },
        devicePixelRatio: 2,
        cropRect: { x: 0, y: 0, width: 200, height: 200 },
        trigger: 'hover',
        durationMs: 1000,
        timelineDomain: 'time_ms',
      },
      {
        viewport: { width: 390, height: 844 },
        devicePixelRatio: 1,
        cropRect: null,
        trigger: 'click',
        durationMs: 1000,
        timelineDomain: 'scroll_progress_percent',
      },
    );
    expect(compat.compatible).toBe(false);
    expect(compat.mismatches.length).toBeGreaterThanOrEqual(4);

    const sampleSpec = importReanimateJsonText(
      JSON.stringify({
        durationMs: 600,
        targets: [{ selector: '.hero', startMs: 0, endMs: 600 }],
      }),
      'track.json',
    ).spec;
    const uncompared = compareMotionSpecs(sampleSpec, null);
    expect(uncompared.status).toBe('not_compared');
    const sheetHtml = buildLabeledContactSheetHtml(uncompared, '.hero');
    expect(sheetHtml).toContain('Status: not_compared');
  });

  it('validates & imports safe Reanimate ZIP/JSON while rejecting traversal/executables and bad media', () => {
    const encoder = new TextEncoder();
    const safeZip = zipSync({
      'capture.json': encoder.encode(
        JSON.stringify({
          url: 'https://demo.example.com',
          viewport: { width: 1280, height: 720 },
          deviceScaleFactor: 2,
          durationMs: 1200,
          fps: 60,
        }),
      ),
      'inspect.json': encoder.encode(
        JSON.stringify({
          title: 'Hero Card',
          animations: [{ name: 'fadeUp', target: '.hero', type: 'css', duration: 600, delay: 0 }],
          inaccessibleStylesheets: 1,
        }),
      ),
      '../evil.js': encoder.encode('alert(1)'),
      'payload.html': encoder.encode('<script>alert(1)</script>'),
    });

    const imported = importReanimateZipBytes(safeZip);
    expect(imported.spec.tracks.length).toBe(1);
    expect(imported.rejectedEntries).toEqual(['../evil.js', 'payload.html']);
    expect(imported.spec.unavailableItems.length).toBe(1);

    const handoff = buildReanimateHandoffRecipe(imported.spec);
    expect(handoff.cliCommand).toContain('--clock virtual');

    const badMedia = validateImportedMediaDescriptor({
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      byteLength: 1000,
    });
    expect(badMedia.valid).toBe(false);
  });

  it('upgrades IndexedDB from v3 to v4 preserving data, enforcing quota, and cascading motion_media deletes', async () => {
    const dbName = `pagesift_v3_upgrade_${Date.now()}`;
    const v3db = await openDB(dbName, 3, {
      upgrade(db) {
        db.createObjectStore('projects', { keyPath: 'id' }).createIndex('by-updated', 'updatedAt');
        const art = db.createObjectStore('artifacts', { keyPath: 'id' });
        art.createIndex('by-project', 'projectId');
        art.createIndex('by-updated', 'updatedAt');
        art.createIndex('by-kind', 'kind');
        db.createObjectStore('captures', { keyPath: 'id' }).createIndex('by-project', 'projectId');
        db.createObjectStore('jobs', { keyPath: 'id' }).createIndex('by-status', 'status');
        const act = db.createObjectStore('activities', { keyPath: 'id' });
        act.createIndex('by-startedAt', 'startedAt');
        act.createIndex('by-origin', 'sourceOrigin');
        act.createIndex('by-tool', 'tool');
        act.createIndex('by-status', 'status');
        act.createIndex('by-session', 'sessionId');
      },
    });
    const nowIso = new Date().toISOString();
    await v3db.put('projects', {
      id: 'proj-existing',
      name: 'Preserved Project',
      description: 'Before v4',
      sourceDomain: 'example.com',
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    v3db.close();

    expect(LOCAL_DB_VERSION).toBe(4);
    const storage = new LocalExtensionStorage(dbName, 2048);
    const projects = await storage.listProjects();
    expect(projects.map((p) => p.id)).toContain('proj-existing');

    const mediaSaved = await storage.saveMotionMedia({
      id: 'mm-1',
      projectId: 'proj-existing',
      sessionId: 'sess-1',
      kind: 'frame',
      mimeType: 'image/png',
      width: 100,
      height: 50,
      durationMs: 0,
      tMs: 120,
      bytes: new Uint8Array(64),
      createdAt: nowIso,
    });
    expect(mediaSaved.byteLength).toBe(64);
    expect((await storage.getStorageUsage()).motionMediaCount).toBe(1);

    await expect(
      storage.saveMotionMedia({
        id: 'mm-too-big',
        projectId: 'proj-existing',
        sessionId: 'sess-1',
        kind: 'video',
        mimeType: 'video/webm',
        width: 1280,
        height: 720,
        durationMs: 3000,
        tMs: 0,
        bytes: new Uint8Array(4096),
        createdAt: nowIso,
      }),
    ).rejects.toThrow(QuotaExceededStorageError);

    await storage.deleteProject('proj-existing');
    expect(await storage.getMotionMedia('mm-1')).toBeUndefined();
    await storage.close();
  });

  it('validates motion_lab runtime messages and AI explain_motion allowlist sanitization', () => {
    const envCheck = validateMessageEnvelope({
      schemaVersion: 1,
      requestId: 'motion-req-1',
      operation: 'START_MOTION_OBSERVATION',
      tabId: 5,
      documentId: 'doc-12345',
      payload: { trigger: 'hover', durationMs: 3000, selector: '.btn' },
    });
    expect(envCheck.valid).toBe(true);

    const ctx = buildAllowlistedNvidiaContext({
      taskType: 'explain_motion',
      sourceTool: 'motion_lab',
      toolOutput: {
        pageTitle: 'Secret ?token=abc',
        sourceUrl: 'https://user:pass@site.test/app?auth=123',
        rootSelector: '.hero',
        password: 'leak',
        rawHtml: '<script>evil()</script>',
      },
    });
    expect(ctx['password']).toBeUndefined();
    expect(ctx['rawHtml']).toBeUndefined();
    expect(ctx['sourceUrl']).toBe('https://site.test/app');

    const preview = buildNvidiaEgressPreview({
      modelId: 'meta/llama-3.1-8b-instruct',
      taskType: 'explain_motion',
      sanitizedContext: ctx,
    });
    expect(preview.fieldsLeavingDevice).not.toContain('password');
  });
});
