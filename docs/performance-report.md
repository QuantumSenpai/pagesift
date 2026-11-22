# PageSift Performance Report (Chromium Extension & Optional Backend)

## Part 1: Real Chromium Extension Performance Benchmark (2,009-Node DOM Fixture)

### 1. Pre-Declared Provisional Extension Performance Budgets

| Operation | Provisional Max Budget |
| :--- | :--- |
| 1. Inspect single element (`RUN_INSPECT_ELEMENT`) | `<= 50 ms` |
| 2. Clone Page static HTML/CSS snapshot ZIP with DOMPurify & background asset fetch (`RUN_CLONE_PAGE`) | `<= 1200 ms` |
| 3. Clone Prompt local generation (`RUN_CLONE_PROMPT`) | `<= 400 ms` |
| 4. Design MD extraction & generation (`RUN_DESIGN_MD`) | `<= 400 ms` |
| 5. Assets discovery & background-fetched ZIP packaging (`RUN_ASSETS_EXTRACT`) | `<= 500 ms` |
| 6. Colors extraction & 5-format export (`RUN_COLORS_EXTRACT`) | `<= 250 ms` |
| 7. Fonts & `@font-face` extraction (`RUN_FONTS_EXTRACT`) | `<= 250 ms` |
| 10. Real Screenshot Capture visible PNG (`RUN_CAPTURE`) | `<= 1500 ms` |
| 14. Local Design & WCAG Contrast Review (`RUN_DESIGN_REVIEW`) | `<= 350 ms` |
| 15. Public Tech Stack Detection (`RUN_TECH_STACK`) | `<= 150 ms` |
| Overlay idle page footprint (before open / after close) | `0` injected DOM nodes |
| Activity History paginated query (`300+` entries, page size `25`) | `<= 50 ms` |
| Activity History multi-filter query (`domain + tool + search`, `300+` entries) | `<= 50 ms` |
| Activity History UI render (page 1 of `25` rows) | `<= 100 ms` |

### 2. Extension Benchmark Environment & Fixture

- **Reproducible Command**:
  ```bash
  npm run bench:extension
  ```
- **Script**: `scripts/extension-benchmark.ts`
- **Hardware & OS**: Apple M5 (10 cores, 16 GiB RAM), macOS `darwin arm64 (27.2.0)`
- **Browser Runtime**: Real Chromium (`HeadlessChrome/159.0.0.0`) with unpacked Manifest V3 extension loaded from `dist/extension`
- **Fixture Size**: `500` structured card components (`2,009` total DOM elements) with CSS Grid, Flexbox, sticky header, and custom properties.

### 3. Measured Extension Tool Timings

| Operation | Provisional Budget | Measured Latency | Status |
| :--- | :--- | :--- | :--- |
| 1. Inspect single element | `<= 50 ms` | `4.30 ms` | Pass |
| 2. Clone Page static HTML/CSS snapshot ZIP (DOMPurify + background fetch) | `<= 1200 ms` | `16.38 ms` | Pass |
| 3. Clone Prompt local generation | `<= 400 ms` | `13.83 ms` | Pass |
| 4. Design MD extraction & generation | `<= 400 ms` | `16.65 ms` | Pass |
| 5. Assets discovery & background-fetched ZIP packaging | `<= 500 ms` | `3.81 ms` | Pass |
| 6. Colors extraction & 5-format export | `<= 250 ms` | `10.45 ms` | Pass |
| 7. Fonts & `@font-face` extraction | `<= 250 ms` | `4.72 ms` | Pass |
| 10. Real Screenshot Capture (`visible` PNG via `captureVisibleTab`) | `<= 1500 ms` | `204.74 ms` | Pass |
| 14. Local Design & WCAG Contrast Review | `<= 350 ms` | `7.54 ms` | Pass |
| 15. Public Tech Stack Detection | `<= 150 ms` | `1.55 ms` | Pass |

### 4. Measured Overlay Overhead & Activity History Latency (Real Chromium)

Measured directly in real Chromium against `dist/extension` (`pagesift_local_db v3`, `305` total persisted activity records across 4 domains and 7 tools):

| Measurement | Provisional Budget | Measured Result | Status |
| :--- | :--- | :--- | :--- |
| Idle page DOM injection (before overlay activation) | `0` nodes | `0` nodes (`#pagesift-root-host` absent) | Pass |
| Expanded On-Page Overlay Shadow DOM footprint | Lightweight | `1` host element, `77` Shadow DOM nodes | Pass |
| Page DOM cleanup after closing overlay | `0` leaked nodes | `0` nodes (`#pagesift-root-host` removed) | Pass |
| External font / CDN network requests during session | `0` requests | `0` external requests | Pass |
| `QUERY_ACTIVITY_HISTORY` page 1 (`25` of `305` entries) | `<= 50 ms` | `1.9 ms` | Pass |
| `QUERY_ACTIVITY_HISTORY` multi-filter (`domain + tool + search`) | `<= 50 ms` | `1.5 ms` | Pass |
| Persistent Dashboard Activity History UI render (`25` rows) | `<= 100 ms` | `21 ms` | Pass |

- **Enforced Safety & Resource Limits**:
  - Full-page screenshot stitching: `MAX_CAPTURE_CANVAS_DIM_PX = 32768` physical pixels, `MAX_WEBP_DIMENSION_PX = 16383` for WebP encoding, `MAX_FULL_PAGE_TILES = 40`, minimum `550 ms` inter-tile interval (`MIN_CAPTURE_INTERVAL_MS`).
  - Privileged background asset fetching: concurrency `4`, per-request timeout `10s`, streaming byte limits `5 MiB` per asset and `25 MiB` total archive.
  - Activity History retention bounds: default `90 days` retention window (`7 / 30 / 90 / 365` configurable), `500` max entries, max URL `512` chars, max title `160` chars, max summary `240` chars.
  - NVIDIA AI sanitized context limits: max depth `5`, max array length `40`, max object keys `40`, max string length `1,000` chars, max total payload `24 KiB`.

---

## Part 2: Optional PostgreSQL Backend Load Test

### 1. Setup & Workload
- **Reproducible Command**: `npm run loadtest` (`scripts/load-test.ts`)
- **Runtime & Database**: Node.js `v26.9.0`, PostgreSQL `17.11` (isolated local cluster, `DB_POOL_MAX=25`)
- **Seeded Dataset**: `10` accounts, `50` projects, `500` seeded `design_reference` artifacts
- **Workload**: `1,500` HTTP requests at concurrency `25` (`30%` list artifact metadata, `30%` get artifact detail+body, `20%` list projects, `10%` get settings, `10%` create artifact write transaction)

### 2. Measured Backend Results vs. Provisional Targets

| Metric | Provisional Target | Measured Result | Status |
| :--- | :--- | :--- | :--- |
| Error Rate | `0.00%` | `0.00%` (`0` errors) | Pass |
| Throughput | `>= 250 req/sec` | `4,722.41 req/sec` | Pass |
| p50 Latency | `<= 25 ms` | `4.75 ms` | Pass |
| p95 Latency | `<= 75 ms` | `8.58 ms` | Pass |
| p99 Latency | `<= 150 ms` | `12.59 ms` | Pass |
