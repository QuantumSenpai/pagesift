# PageSift

**PageSift** is a free, open-source, local-first Chrome Extension (Manifest V3) for web page inspection, design token extraction, static HTML/CSS snapshot export, `DESIGN.md` synthesis, rebuild prompt generation, screenshot capture, reversible live previews, design quality/contrast review, public tech stack detection, and local research activity history.

- **No mandatory login or account.**
- **No paid feature gates or subscriptions.**
- **No mandatory hosted backend or database.**
- **All 15 tools and Local Activity History execute locally inside the extension.**
- **Zero external font or CDN requests — Instrument Sans & IBM Plex Mono are bundled locally.**
- **Saved projects, artifacts, captures, and explicit PageSift activity history persist locally in IndexedDB (`pagesift_local_db v3`).**
- **Optional AI enhancement uses the user's own NVIDIA NIM API key (`chrome.storage.session`).**

An optional self-hosted Fastify + PostgreSQL 17 backend is also included in `src/` for users who want self-hosted cloud sync later.

---

## 1. Build Artifacts & Extension Installation

Running `npm run build` produces:
- **Unpacked Manifest V3 Extension**: `dist/extension/` (19 files including 7 bundled `.woff2` fonts and 4 adapted Midnight + Electric Blue PNG icons)
- **Installable Extension ZIP Archive**: `dist/pagesift-extension.zip`
- **Optional Backend Production Build**: `dist/server.js`

### Loading the Unpacked Extension in Chrome / Chromium / Brave / Edge
1. Build the extension:
   ```bash
   npm ci
   npm run build:extension
   npm run validate:extension
   ```
2. Open `chrome://extensions` in your Chromium browser.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select:
   `/Users/kyzenn/Projects/pagesift/dist/extension`
5. Pin **PageSift** in the browser toolbar and click the extension icon on any `http://` or `https://` web page to toggle the **On-Page Overlay Dashboard** directly on the page (expand, minimize, search all 15 tools, run in-page tools, inspect recent site activity, or jump into the persistent **Dashboard** and **Activity History**). Clicking the toolbar icon on restricted browser pages (`chrome://`, `file://`, Web Store) opens the persistent dashboard directly with an informative notice.

---

## 2. All 15 Included Local Tools + Local Research Activity History

1. **Inspect** (`src/extension/engines/inspect-engine.ts`): Hover/click element picker (auto-minimizes & restores overlay), safe HTML, bounding box, computed layout, typography, colors, spacing, borders/shadows/radius, accessible name/role, open shadow root support, and frame/stylesheet diagnostics.
2. **Clone Page** (`src/extension/engines/clone-page-engine.ts` + `asset-fetcher.ts`): Exports a DOMPurify-sanitized static HTML/CSS snapshot `.zip` archive with defensive CSP, privileged background asset fetching (streaming byte caps, `credentials: 'omit'`), stylesheet-relative CSS `url(...)` rewriting, safe collision-free filenames, and `isSelfContained` / missing-resource manifests.
3. **Clone Prompt** (`src/extension/engines/clone-prompt-engine.ts`): Generates structured rebuild prompts locally (`React + Tailwind`, `HTML + CSS`, `Vue 3 + CSS`, `Generic`), explicitly separating verified DOM observations from structural assumptions, with optional NVIDIA refinement (egress preview + digest confirmation required).
4. **Design MD** (`src/extension/engines/design-md-engine.ts`): Generates deterministic `DESIGN.md` files (colors, typography, spacing, radius, shadows, layout patterns, components, source references), combines multiple saved pages, deduplicates tokens, and reports cross-page token conflicts.
5. **Assets** (`src/extension/engines/assets-engine.ts` + `asset-fetcher.ts`): Discovers images (`currentSrc`/`srcset`), `<picture>`, CSS backgrounds, DOMPurify-sanitized inline SVGs, icons, video posters, and stylesheet-relative `@font-face` URLs; downloads individually or as a background-fetched `.zip` bundle with manifest.
6. **Colors** (`src/extension/engines/colors-engine.ts`): Normalizes colors, alpha transparency, gradients, and CSS custom properties (`--*`) with usage evidence; downloads/copies CSS variables, JSON, SCSS, Tailwind v3 config, and Tailwind v4 `@theme`.
7. **Fonts** (`src/extension/engines/fonts-engine.ts`): Reports declared font stacks, computed size/weight/line-height/letter-spacing usage, `@font-face` declarations, and `FontFaceSet` verification disclosure.
8. **Measure** (`src/extension/engines/measure-engine.ts`): Measures element dimensions, padding, margins, borders, and element-to-element horizontal/vertical distances with `Escape` cancellation and complete cleanup.
9. **Edit Text** (`src/extension/engines/edit-engine.ts`): Reversible in-place text preview preserving nested child markup with `Undo`, `Redo`, and `Reset All` (refuses to modify form inputs or passwords).
10. **Capture** (`src/extension/engines/capture-engine.ts`): Real `chrome.tabs.captureVisibleTab` pipeline for visible viewport, selected area, selected element, and overlap-stitched full-page capture (`OffscreenCanvas`) with target tab identity verification, DPR scaling, sticky suppression after tile 0, crop & callout annotations, and real PNG, JPEG, WebP, and PDF (embedded JPEG XObject) exports.
11. **Responsive** (`src/extension/engines/responsive-engine.ts`): Opens real extension-managed popup windows at selected presets (`375×812`, `768×1024`, `1280×800`, `1440×900`) or custom sizes, measures actual inner viewport dimensions, provides echo-protected throttled scroll synchronization, and closes only extension-owned preview windows on cleanup.
12. **Swap Font** (`src/extension/engines/edit-engine.ts`): Reversible font family preview on a single element, similar elements, or the whole page, with explicit user opt-in for remote HTTPS font stylesheets and full `Undo`/`Redo`/`Reset`.
13. **Arrange** (`src/extension/engines/edit-engine.ts`): Reversible element move (`translate`), hide (`visibility: hidden`), and remove (`display: none`) previews with `Undo`, `Redo`, and `Reset`.
14. **Design Review** (`src/extension/engines/design-review-engine.ts`): Evidence-based local audit for heading hierarchy, repetitive visual treatments, heavy blur/shadow effects, off-grid spacing, and WCAG 2.1 AA contrast ratios, plus a local remediation prompt and optional NVIDIA interpretation.
15. **Tech Stack** (`src/extension/engines/tech-stack-engine.ts`): Detects frameworks, CSS libraries, UI kits, and CMS platforms from public DOM markers, asset URLs, and meta generator tags with evidence arrays, confidence levels, and uncertainty disclosures.
- **Local Research Activity History** (`src/extension/storage/activity-history.ts`): Records explicit PageSift tool runs locally (never browsing history, no `history` permission, no query strings/passwords/tokens/HTML), groups by day or research session, filters by site/domain/tool/status/date/search, paginates smoothly, links to saved artifacts/captures, supports pause/delete/retention/clear, and persists across restarts.

---

## 3. Commands Reference

```bash
# Install dependencies reproducibly
npm ci

# Verify zero comments in all authored source, tests, migrations, HTML, and configs
npm run check:no-comments

# Format, lint, and type-check
npm run format:check
npm run lint
npm run typecheck

# Build both the optional backend and the Chrome extension (unpacked + ZIP)
npm run build

# Validate the built Manifest V3 package, CSP, icons, bundled fonts, and ZIP archive
npm run validate:extension

# Run all unit, PostgreSQL integration, extension integration, and real Chromium E2E tests
npm test

# Run real Chromium 2000-node extension performance benchmark
npm run bench:extension

# Run optional backend HTTP smoke test and PostgreSQL load test
npm run smoke
npm run loadtest

# Run dependency vulnerability audit
npm audit --audit-level=low
```

---

## 4. Documentation Index

- [Design System, Surface Architecture & Icon Provenance](docs/design-system-and-icon.md)
- [Extension Specification & 15-Tool Feature Matrix](docs/extension-spec-and-matrix.md)
- [Architecture and Data Flow](docs/architecture-and-data-flow.md)
- [Permissions and Local-Data Privacy Guide](docs/permissions-and-privacy.md)
- [Optional NVIDIA AI Integration Guide](docs/nvidia-ai-guide.md)
- [Performance Report (Chromium Extension & Optional Backend)](docs/performance-report.md)
- [Context7, Official Docs & Investigation Sources](docs/sources.md)
- [Optional Backend Specification](docs/backend-spec.md)
- [Optional Backend Chrome Extension Auth Guide](docs/extension-auth-guide.md)
- [Optional Backend Operations & Deployment Guide](docs/operations-and-deployment.md)
- [Optional Backend OpenAPI 3.1.0 Specification](docs/openapi.json)
- [Third-Party License Notices](THIRD_PARTY_NOTICES.md)
