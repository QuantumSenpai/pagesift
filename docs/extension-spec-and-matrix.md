# PageSift Extension Specification and 15-Tool Feature Matrix

## 1. Core Product Principles

1. **100% Free, Local-First, Open-Source Chrome Extension (Manifest V3)**:
   - No mandatory login, no subscription gates, and no mandatory backend or PostgreSQL dependency.
   - All 15 tools and Local Research Activity History execute completely locally inside the browser extension.
2. **Isolated Extension Storage**:
   - **IndexedDB (`pagesift_local_db v3`)**: Stores saved projects, multi-page captures, artifacts (`DESIGN.md`, rebuild prompts, token exports, asset manifests, snapshots, screenshots, design reviews, tech stack reports), recoverable background jobs, and sanitized explicit PageSift activity history (`v1` -> `v2` -> `v3` additive migrations; `schemaVersion: 2` backup export with backwards-compatible `v1` and `v2` import).
   - **`chrome.storage.local`**: Stores small non-secret preferences (theme, default export formats, sidebar collapse state, activity history recording toggle, retention window, first-use notice state, optional NVIDIA model ID).
   - **`chrome.storage.session`**: Stores the user's optional NVIDIA API key (`nvapi-...`) and active responsive preview session state in memory for the current browser session only.
   - **Strict Boundary**: PageSift never writes extension data or API keys into an inspected website's `localStorage`, `sessionStorage`, `IndexedDB`, cookies, or DOM globals.
3. **Optional Backend Compatibility**:
   - The Fastify/PostgreSQL backend in `src/` remains intact, tested, and optional for teams that want self-hosted cloud sync later.

---

## 2. Extension Architecture

- **`src/extension/protocol/`**: Zod-validated runtime message schemas (`schemaVersion: 1`), strict sender authorization (`validateSenderAuthorization`), document binding (`documentId`), and cancellation routing.
- **`src/extension/storage/`**:
  - `activity-history.ts`: Zod activity schema, strict URL/title/options/summary/error sanitizers, session ID builder, and local `Today`/`Yesterday`/date grouping.
  - `idb-storage.ts`: Versioned IndexedDB wrapper (`v1` -> `v2` -> `v3` adding `activities` store with 5 indexes), worker-wake recovery for both `jobs` and `activities`, paginated/filtered activity queries with non-body `getKey()` artifact link checks, retention pruning, transactional writes, quota classification, and atomic backup export/import.
  - `settings-storage.ts`: Validated `chrome.storage.local` preferences and `chrome.storage.session` NVIDIA API key management.
- **`src/extension/engines/`**: Modular engines for all 15 tools plus optional NVIDIA NIM adapter (`src/extension/ai/nvidia-client.ts`).
- **`src/extension/content/`**:
  - `content-script.ts`: Idle-until-invoked content script managing `documentId` binding, hover/selection/measure overlays, reversible edit history, capture preparation/restoration, and responsive scroll sync.
  - `overlay-dashboard.ts`: Isolated Shadow DOM On-Page Overlay Dashboard (`#pagesift-root-host[data-pagesift-root="true"]`) with bundled local fonts, expand/minimize/close/reopen, 15-tool search, in-page result summaries, picker auto-minimize/restore, site-scoped recent activity, and full-dashboard handoff.
- **`src/extension/background/`**: Manifest V3 service worker (`service-worker.ts`) handling `chrome.action.onClicked` overlay toggle (with restricted-page fallback), single-flight `ensureInitialized()` recovery, activity lifecycle recording, real screenshot capture, background asset fetching, responsive window lifecycle, IndexedDB operations, and optional NVIDIA API calls.
- **`src/extension/ui/`**:
  - `design-system.css`: Solid-color Midnight (`#00001E`) and Warm Paper (`#FDFDFC`) design system with `#0057FF` Electric Blue interaction accent and bundled `Instrument Sans` + `IBM Plex Mono` `@font-face` rules.
  - `workspace.html` / `workspace.ts` / `tool-renderers.ts`: Persistent dashboard with collapsible sidebar, **Tools**, **Activity History**, and **Saved Work** sections, structured views for all 15 tools, and accessible modals.
  - `options.html` / `options.ts`: Settings page for theme, export defaults, Activity History recording/retention controls, session-only NVIDIA key, live IndexedDB metrics, and backup/import/reset.

---

## 3. 15-Tool Feature Matrix

| # | Tool | Engine Module | Extension Control | Core Local Behavior | Honest Limitations |
| :- | :--- | :--- | :--- | :--- | :--- |
| 1 | **Inspect** | `src/extension/engines/inspect-engine.ts` | Overlay Picker & Dashboard Inspect | Hover/click element selection (auto-minimizes & restores overlay), safe HTML, bounding box, computed layout/typography/colors/spacing/borders/shadows/radius, accessible name/role, open shadow root traversal, excludes `[data-pagesift-root]`, JSON download & copy. | Computed styles reflect resolved cascade values, not original authored CSS selector rules. Cross-origin iframes and closed shadow roots cannot be pierced and are explicitly reported. |
| 2 | **Clone Page** | `src/extension/engines/clone-page-engine.ts` + `asset-fetcher.ts` | Overlay Handoff & Dashboard Clone Page | Exports DOMPurify-sanitized static HTML/CSS snapshot ZIP (`fflate`) with defensive CSP, privileged background asset fetching (streaming byte caps, `credentials: 'omit'`), stylesheet-relative CSS `url(...)` rewriting, safe collision-free filenames, and `isSelfContained` / `missingResources` manifests. | Static client-side HTML/CSS snapshot only; does not recreate server backends, dynamic JS runtime state, or active iframes. Archives with unavailable assets are explicitly marked `isSelfContained: false`. |
| 3 | **Clone Prompt** | `src/extension/engines/clone-prompt-engine.ts` | Overlay & Dashboard Clone Prompt | Locally generates structured rebuild prompts separating verified observations from structural assumptions (`React + Tailwind`, `HTML + CSS`, `Vue 3 + CSS`, `Generic`), with optional NVIDIA refinement (egress preview & digest confirmation required). | Local prompts are deterministic structural blueprints; optional AI refinement requires a user-supplied NVIDIA API key. |
| 4 | **Design MD** | `src/extension/engines/design-md-engine.ts` | Overlay & Dashboard Design MD | Generates deterministic `DESIGN.md` specifications covering colors, typography, spacing, radius, shadows, layout patterns, and components; combines multiple saved pages and reports cross-page token conflicts. | Token semantics (e.g. primary vs. accent) are inferred from usage frequency and element roles rather than private Figma token names. |
| 5 | **Assets** | `src/extension/engines/assets-engine.ts` + `asset-fetcher.ts` | Overlay Handoff & Dashboard Assets | Discovers images (`currentSrc`/`srcset`), `<picture>`, CSS backgrounds, DOMPurify-sanitized inline SVGs, icons, video posters, and `@font-face` URLs; fetches accessible HTTP(S) binaries into a downloadable ZIP with manifest and supports individual downloads. | Streaming media (`blob:`, `mediasource:`, HLS/DASH), 404s, and auth-protected resources are skipped and recorded in `assets-manifest.json`. |
| 6 | **Colors** | `src/extension/engines/colors-engine.ts` | Overlay & Dashboard Colors | Normalizes colors, alpha transparency, gradients, and `--*` CSS custom properties with usage evidence; downloads/copies CSS variables, JSON, SCSS, and Tailwind v3/v4 configs. | Colors inside raster images or cross-origin canvas contexts are not sampled by DOM style extraction. |
| 7 | **Fonts** | `src/extension/engines/fonts-engine.ts` | Overlay & Dashboard Fonts | Extracts declared `font-family` stacks, computed size/weight/line-height/letter-spacing usage, and accessible `@font-face` rules/URLs; distinguishes declared stacks from `FontFaceSet` verification. | OS-level font fallback substitution is only verifiable up to `FontFaceSet` availability. |
| 8 | **Measure** | `src/extension/engines/measure-engine.ts` | Overlay Picker & Dashboard Measure | Interactive box dimensions, padding/margin visualization, and element-to-element gap/distance calculation; stays aligned on scroll/resize/zoom; `Escape` cancellation and complete cleanup. | Measures layout bounding client rectangles in CSS pixels. |
| 9 | **Edit Text** | `src/extension/engines/edit-engine.ts` | Overlay Picker & Dashboard Edit Text | Explicit in-place text preview preserving nested child markup with full undo/redo/reset stack; refuses `<input type="password">` and form controls. | Local preview only; reloading the page resets live DOM edits unless exported. |
| 10 | **Capture** | `src/extension/engines/capture-engine.ts` | Overlay Handoff & Dashboard Capture | Real `chrome.tabs.captureVisibleTab` pipeline verifying target tab identity; supports visible viewport, selected area, selected element, and overlap-stitched full-page capture (`OffscreenCanvas`), DPR scaling, sticky suppression after tile 0, crop & callout annotation controls, and real PNG, JPEG, WebP, and PDF (embedded JPEG XObject) downloads. | Pages exceeding max height cap (16,384 CSS px / 32,768 canvas px; WebP 16,383 px), restricted browser pages (`chrome://`), and nested scroll containers have documented bounds. |
| 11 | **Responsive** | `src/extension/engines/responsive-engine.ts` | Overlay Handoff & Dashboard Responsive | Opens real extension-managed popup windows at selected presets or custom sizes, measures actual inner viewport dimensions, enables echo-protected throttled scroll sync, persists session in `chrome.storage.session`, and closes only extension-owned windows. | Operating systems enforce minimum/maximum popup window dimensions (actual measured inner dimensions are reported honestly). |
| 12 | **Swap Font** | `src/extension/engines/edit-engine.ts` | Overlay Picker & Dashboard Swap Font | Previews alternative font families on a selected element, similar elements, or whole page with explicit opt-in for remote HTTPS font stylesheets and full undo/redo/reset. | Remote font loading can be blocked by strict page CSP `style-src`/`font-src`. |
| 13 | **Arrange** | `src/extension/engines/edit-engine.ts` | Overlay Picker & Dashboard Arrange | Moves (`translate`), hides (`visibility: hidden`), or removes (`display: none`) elements as reversible local previews with undo/redo/reset. | Local preview via inline transform/display overrides only. |
| 14 | **Design Review** | `src/extension/engines/design-review-engine.ts` | Overlay & Dashboard Design Review | Evidence-based local audit for heading hierarchy, repetitive treatments, heavy effects, off-grid spacing, and WCAG 2.1 AA contrast failures, plus local remediation prompt and optional NVIDIA interpretation. | Heuristic audit of observable design quality only; never claims to prove AI authorship. |
| 15 | **Tech Stack** | `src/extension/engines/tech-stack-engine.ts` | Overlay & Dashboard Tech Stack | Detects frameworks, CSS libraries, UI kits, analytics, and CMS platforms from public DOM markers, asset URLs, and meta generators with evidence arrays, confidence, and uncertainty notes. | Relies strictly on public client-side signals; absence of a marker does not prove a server-side technology is absent. |

---

## 4. Verification Highlights (Zoom, Recovery & Isolation)

- **Genuine 200% Browser Zoom**: Verified in real Chromium via `chrome.tabs.setZoom(currentTabId, 2.0)` (confirmed `getZoom() === 2.0`, `scrollWidth <= innerWidth + 2`, responsive navigation menu active, zero horizontal clipping), in addition to viewports `360px`, `390px`, `768px`, `1280px`, and `1440px`.
- **Single-Flight MV3 Worker Recovery**: Real CDP `ServiceWorker.stopWorker` + wake verification confirms both `running` background jobs and `running` activity history records recover to `interrupted` while saved artifacts and active responsive sessions survive.
- **Zero Idle Footprint & Zero External Requests**: Confirmed `0` injected DOM nodes on inspected pages before activation and after close, `77` Shadow DOM nodes when expanded, and `0` external network/font requests.
