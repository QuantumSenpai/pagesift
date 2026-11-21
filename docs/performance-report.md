# PageSift Performance Report (Chromium Extension & Optional Backend)

## Part 1: Real Chromium Extension Performance Benchmark (2,009-Node DOM Fixture)

### 1. Pre-Declared Provisional Extension Performance Budgets

Before running measurements in Chromium, the following per-tool latency budgets were established for a 2,000+ DOM node page:

| Operation | Provisional Max Budget |
| :--- | :--- |
| 1. Inspect single element (`RUN_INSPECT_ELEMENT`) | `<= 50 ms` |
| 2. Clone Page static HTML/CSS snapshot ZIP (`RUN_CLONE_PAGE`) | `<= 600 ms` |
| 3. Clone Prompt local generation (`RUN_CLONE_PROMPT`) | `<= 400 ms` |
| 4. Design MD extraction & generation (`RUN_DESIGN_MD`) | `<= 400 ms` |
| 5. Assets discovery & ZIP packaging (`RUN_ASSETS_EXTRACT`) | `<= 300 ms` |
| 6. Colors extraction & 5-format export (`RUN_COLORS_EXTRACT`) | `<= 250 ms` |
| 7. Fonts & `@font-face` extraction (`RUN_FONTS_EXTRACT`) | `<= 250 ms` |
| 14. Local Design & WCAG Contrast Review (`RUN_DESIGN_REVIEW`) | `<= 350 ms` |
| 15. Public Tech Stack Detection (`RUN_TECH_STACK`) | `<= 150 ms` |

### 2. Extension Benchmark Environment & Fixture

- **Reproducible Command**:
  ```bash
  npm run bench:extension
  ```
- **Script**: `scripts/extension-benchmark.ts`
- **Hardware & OS**: Apple M5 (10 cores, 16 GiB RAM), macOS `darwin arm64 (27.2.0)`
- **Browser Runtime**: Real Chromium (`Google Chrome for Testing 159.0.8154.6` / `HeadlessChrome/159.0.0.0`) with unpacked Manifest V3 extension loaded from `dist/extension`
- **Fixture Size**: `500` structured card components (`2,009` total DOM elements) with CSS Grid, Flexbox, sticky header, and custom properties.

### 3. Measured Extension Timings & Memory

| Operation | Provisional Budget | Measured Latency | Status |
| :--- | :--- | :--- | :--- |
| 1. Inspect single element | `<= 50 ms` | `4.06 ms` | Pass |
| 2. Clone Page static HTML/CSS snapshot ZIP | `<= 600 ms` | `7.34 ms` | Pass |
| 3. Clone Prompt local generation | `<= 400 ms` | `13.55 ms` | Pass |
| 4. Design MD extraction & generation | `<= 400 ms` | `17.46 ms` | Pass |
| 5. Assets discovery & ZIP packaging | `<= 300 ms` | `2.67 ms` | Pass |
| 6. Colors extraction & 5-format export | `<= 250 ms` | `10.33 ms` | Pass |
| 7. Fonts & `@font-face` extraction | `<= 250 ms` | `4.90 ms` | Pass |
| 14. Local Design & WCAG Contrast Review | `<= 350 ms` | `6.15 ms` | Pass |
| 15. Public Tech Stack Detection | `<= 150 ms` | `1.36 ms` | Pass |

- **Measured Process Memory**: `151.4 MiB` RSS / `37.7 MiB` Heap Used.

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
