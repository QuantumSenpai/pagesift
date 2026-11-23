# Motion Lab: Reanimate Reverse Engineering & PageSift Integration Architecture

## 1. Purpose and Methodology

This document records the reverse-engineering findings from **Reanimate** (`https://github.com/NiazMorshed2007/reanimate`, inspected at commit `3f7a55a`), cross-referenced against:
- Static AST/graph evidence from **REA** (`reanimate-rea-analysis.json`, generated via `analyze_javascript_application` over 140 files / 111 parsed JS files / 171,578 AST nodes).
- Direct source inspection of Reanimate's skill instructions, references, and runtime scripts (`skills/reanimate/SKILL.md`, `references/*.md`, `scripts/*.ts`, `scripts/inpage/*.js`).
- Current platform documentation via **Context7** (`/websites/developer_chrome_extensions`, `/websites/developer_chrome_extensions_reference_api`, `/mdn/content`).
- Current **PageSift** repository baseline (`v1.0.0`, IndexedDB `pagesift_local_db v3`, 15 tools in `toolIdSchema` + separate Feature Extract).

---

## 2. Reanimate Data Flow & Source Trace

Reanimate implements a closed-loop animation cloning and verification pipeline:

```text
Reference Input (Live URL | Video/GIF | Canvas/WebGL | Lottie/Rive)
  │
  ├─► 1. Capture Configuration (`scripts/capture.ts` CLI flags & `capture.json`)
  │      viewport, deviceScaleFactor, colorScheme, reducedMotion,
  │      selector/clip/pad, trigger (load|scroll|hover|leave|move|drag|click|none),
  │      duration, preRoll, waitBefore, fps, playbackRate, clock (real|virtual), seed, gl
  │
  ├─► 2. In-Page Instrumentation & Inspection (`capture.ts`, `inpage/clock.js`, `inpage/gl-hooks.js`)
  │      - `CTX_PROBE`: wraps `HTMLCanvasElement/OffscreenCanvas.prototype.getContext`
  │      - `TRACKER`: `requestAnimationFrame` sampler recording `t`, `scrollY`, `getBoundingClientRect()`,
  │        `opacity`, `transform`, `clipPath` → `track.json`
  │      - `INSPECT`: library detection, `document.fonts`, `@keyframes` from accessible stylesheets
  │        (cross-origin listed as `{ unreadable: href }`), `getAnimations({ subtree: true })`
  │        (kind, name, target, timing, keyframes, playState, currentTime, timeline),
  │        and up to 150 node styles → `inspect.json`
  │      - Optional `--clock virtual`: replaces `performance.now`, `Date`, `setTimeout`, `setInterval`,
  │        `requestAnimationFrame`, `Event.prototype.timeStamp`, `AnimationTimeline.prototype.currentTime`,
  │        `Math.random` (mulberry32), and pauses/seeks `document.getAnimations()` + `<video>`
  │      - Optional `--gl`: hooks WebGL 1/2, WebGPU, Canvas 2D, and `__THREE_DEVTOOLS__` → `gl.ts` → `gl/gl.json`, `gl-track.json`
  │
  ├─► 3. Frame Extraction (`capture.ts` or `scripts/frames.ts`)
  │      - Real clock: Playwright `recordVideo` (`video.webm`) → `ffmpeg` crop & frame extract
  │      - Virtual clock: deterministic per-frame `page.screenshot()` + `pngjs` bitblt crop → `video.mp4`
  │      - Video/GIF input: `ffmpeg-static` probe & extract → `frames/NNNN.png` + `frames.json`
  │
  ├─► 4. Curve & Motion Specification (`scripts/easing.ts`, `references/analysis.md`)
  │      - `easing.ts`: decomposes `matrix(...)` / `matrix3d(...)` into `tx, ty, sx, sy, rot`;
  │        detects `firstChange`/`lastChange` (1% change threshold), computes `delayMs`, `visibleDurationMs`,
  │        `overshootPct`, and fits 20+ cubic-bezier curves across `1x..2x` duration multipliers via RMSE
  │      - `spec.md`: contracts per-element static structure & timeline rows
  │
  ├─► 5. Reconstruction (`references/implementation.md`)
  │      - Emits target stack CSS/WAAPI/Framer/GSAP with `transform-origin`, `overflow`,
  │        transform order, `fill: forwards`, and `prefers-reduced-motion`
  │
  └─► 6. Comparison & Correction Loop (`scripts/compare.ts`, `scripts/sheet.ts`, `scripts/gl.ts`)
         - `compare.ts`: checks `capture.json` setup compatibility, auto-aligns first 10 frames (`±maxShift`),
           computes per-frame `pixelmatch` mismatch, optional box blur (`--blur`), consecutive-frame
           activity curves, motion window timing errors (`startS`, `endS`, `peakS`, `durationS`),
           diff PNGs, `report.json`, and `report.md`
         - `sheet.ts`: renders labeled `filmstrip` and `compare` contact sheets via Playwright Chromium
         - `easing.ts --compare-track`: computes `maxAbsDiff` / `meanAbsDiff` between reference and clone tracks
```

### REA Static Evidence & Validated Unknowns

- **REA Evidence (`reanimate-rea-analysis.json`)**:
  - Parsed 111 JS files (`1,629,438` text bytes, `171,578` AST nodes, `1,123` findings).
  - Explicitly surfaced `16` static analysis limitations: commonJS/ESM binding recovery is static-only, 10 example HTML files under `site/public/examples/` and `site/video/` contain inline `<script>` bodies not analyzed by the JS AST pass, and `50,144` unresolved semantic graph unknowns remain.
- **Validation via Source & Runtime Semantics**:
  - Reading `capture.ts`, `clock.js`, `gl-hooks.js`, `easing.ts`, `compare.ts`, and `sheet.ts` directly verified the runtime mechanics that static AST alone does not prove:
    1. `capture.ts` depends on Playwright, `ffmpeg-static`, `pngjs`, and `pixelmatch` running in Bun/Node — **not** compatible with a Manifest V3 browser extension runtime.
    2. `clock.js` globally monkey-patches `window.Date`, `performance.now`, `requestAnimationFrame`, `setTimeout`, `Math.random`, and `AnimationTimeline.prototype.currentTime` at document start (`addInitScript`). Doing this inside a live website tab from a late-attaching extension content script would break host page state and fail to intercept already-initialized scripts/timers/WebGL contexts.
    3. `gl-hooks.js` must wrap `getContext` before page scripts execute; late attachment after a canvas context already exists cannot recover compiled shaders or draw history.
    4. `easing.ts` normalizes `(v - start) / range` and searches `k = 1.0..2.0` duration multipliers over 20 named bezier curves. For constant (`range === 0`) or scroll-linked tracks, bezier time-fitting is meaningless and must be guarded.

---

## 3. PageSift Motion Lab Architecture Map

Motion Lab adapts Reanimate's rigorous evidence-driven workflow into PageSift's 100% local-first Manifest V3 architecture without bundling Bun, Playwright, or FFmpeg.

### Existing Modules Reused
- `src/extension/protocol/messages.ts`: Typed envelope validation (`MESSAGE_SCHEMA_VERSION = 1`), sender authorization (`validateSenderAuthorization`), document binding (`verifyDocumentBinding`), and cancellation routing.
- `src/extension/storage/idb-storage.ts`: `LocalExtensionStorage` (`pagesift_local_db`) for projects, artifacts, jobs, activities, quota enforcement, and backup export/import. Upgraded cleanly from `v3` -> `v4` to add a dedicated `motion_media` binary store with quota checks and cascade deletion.
- `src/extension/storage/activity-history.ts`: Sanitized local activity recording (`motion_lab` runs logged with domain/path, selector scope, duration, status, and linked artifact ID).
- `src/extension/engines/dom-utils.ts`: `isPageSiftElement`, `PAGESIFT_ROOT_ATTR`, `buildShortSelector`, `sanitizeElementHtml`, `inspectFramesAndStylesheets`.
- `src/extension/engines/design-md-engine.ts` & `src/extension/engines/clone-prompt-engine.ts`: Integrated with MotionSpec so captured motion specifications enrich `DESIGN.md` and clone prompts.
- `src/extension/ai/nvidia-client.ts`: Optional BYOK AI motion interpretation gated behind explicit preview + payload digest confirmation.
- `src/extension/ui/theme.ts` & `src/extension/ui/design-system.css`: Obsidian Teal palette, solid surfaces, SVG icon registry, reduced-motion styling.

### New Modular Motion Lab Components
1. `src/extension/engines/motion-spec.ts`: Versioned `MotionSpec` (`schemaVersion: 1`), `EvidenceClass` (`declared | observed | inferred | unavailable`), capability matrix (`MOTION_CAPABILITY_MATRIX`), bounded capture limits (`MOTION_CAPTURE_DEFAULTS`), `MOTION.md` formatter, and comparison/import schemas.
2. `src/extension/engines/motion-observation-engine.ts`: Bounded, cancellable content-script observer capturing declared CSS/WAAPI animations (including `ScrollTimeline`/`ViewTimeline` percentage `CSSUnitValue` timelines), newly spawned hover/click transitions, batched `rAF` transform/opacity/bounds samples with measured timestamps, parent clipping/transforms, and clean teardown on completion, cancellation, target removal, tab hiding, or navigation.
3. `src/extension/engines/motion-analysis-engine.ts`: Matrix2D/3D decomposition, coordinate-space-aware deltas, constant/near-constant track guarding, stagger calculation, overshoot/settle-time metrics, and cubic-bezier curve estimation with RMSE residuals and explicit `inferred` labeling.
4. `src/extension/engines/motion-codegen-engine.ts`: Safe, sanitized CSS `@keyframes`/transitions, vanilla WAAPI codegen, and minimal reproducible HTML/CSS/JS fixture generation (zero `eval`, zero copied page scripts, strict CSS property/value allowlisting).
5. `src/extension/engines/motion-compare-engine.ts`: Compatibility-checked reference-vs-reconstruction comparator (viewport, DPR, crop, trigger, duration, timeline domain, cadence), track timing/path residuals, RGBA frame pixel diffing, raw vs aligned offset disclosure, fixture-specific thresholds, and labeled contact sheet HTML/canvas rendering.
6. `src/extension/engines/motion-import-engine.ts`: Validated bounded importer for Reanimate capture artifacts (`inspect.json`, `track.json`, `capture.json`, `frames.json`, optional `gl/gl.json` & `gl-track.json` as inert evidence) and Reanimate CLI handoff recipe generator.
7. `src/extension/engines/motion-recorder.ts`: Opt-in browser-native visual evidence recorder using optional `tabCapture` permission (`chrome.permissions.request` + `chrome.tabCapture.getMediaStreamId` with `audio: false`) or `getDisplayMedia` fallback, recorded crop/DPR metadata, measured frame timestamps, and deterministic track/stream cleanup.
8. `src/extension/content/overlay-motion-drawer.ts`: Lightweight Shadow DOM drawer for Motion Lab (Select -> Record -> Analyze -> Open in Studio) invoked from the dock header pill / PiP menu without crowding the 15-tool bar.
9. `src/extension/ui/motion-lab-panel.ts`: Full Motion Lab studio panel in `workspace.html` (Select, Inspect Declared, Observe Session, Timeline & Tracks, Isolated Preview Player with Play/Pause/Restart/Scrub/Speed/Reduced Motion, Compare Reference vs Reconstruction, Import/Handoff Reanimate, Export CSS/WAAPI/HTML/JSON/`MOTION.md`).

---

## 4. Platform Constraints & Capability Boundaries

- **Chrome `tabCapture` & User Gesture**: `chrome.tabCapture.getMediaStreamId({ targetTabId })` requires `"tabCapture"` permission and `activeTab`-style extension invocation. Putting `"tabCapture"` in `optional_permissions` avoids new install-time permission warnings and lets the user grant it explicitly via `chrome.permissions.request()` inside a click handler. Clicking an injected page button does not guarantee privileged `tabCapture` invocation on all tabs; therefore `motion-recorder.ts` surfaces explicit `PERMISSION_DENIED` / `UNSUPPORTED` states and supports `getDisplayMedia` from extension pages as an explicit fallback.
- **No `captureVisibleTab` High-FPS Abuse**: `captureVisibleTab` is rate-limited (`MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`) and remains reserved for still/full-page screenshots in `capture-engine.ts`.
- **No Global Host Clock/GL Monkey-Patching**: Live pages are observed non-invasively. Deterministic time scrubbing is restricted to PageSift's own isolated preview player or exported Reanimate CLI handoffs.
- **Cross-Origin & Pre-existing State**: Cross-origin stylesheet `@keyframes` rules, cross-origin iframes, closed shadow roots, completed load animations before attachment, and pre-existing WebGL/WebGPU contexts are reported explicitly as `unavailable` with actionable reasons.
