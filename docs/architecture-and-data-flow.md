# PageSift Architecture and Data Flow

## 1. Local-First Extension Architecture (Manifest V3)

PageSift is architected as a self-contained Chromium Manifest V3 extension where all 15 inspection, extraction, capture, editing, and export tools run locally inside the user's browser without requiring an account, subscription, or running backend server.

```mermaid
flowchart TD
    subgraph InspectedTab["Inspected Web Page Tab (HTTP/HTTPS)"]
        DOM["Page DOM, Open Shadow Roots & CSSOM"]
        CS["Content Script (content-script.ts)"]
        Overlay["Shadow-DOM Overlay (#pagesift-root-host)"]
        Engines["15 Local Tool Engines (src/extension/engines/*)"]
        CS --> Overlay
        CS --> Engines
        Engines --> DOM
    end

    subgraph ExtensionOrigin["Extension Origin (chrome-extension://<id>)"]
        SW["MV3 Background Service Worker (service-worker.ts)"]
        WS["Workspace UI (workspace.html / workspace.ts)"]
        OPT["Options UI (options.html / options.ts)"]
        IDB[("IndexedDB (pagesift_local_db v2)")]
        LocalStore[("chrome.storage.local (Preferences)")]
        SessionStore[("chrome.storage.session (Optional NVIDIA Key)")]

        WS <-->|"Typed Validated Messages"| SW
        OPT <-->|"Privileged Messages"| SW
        SW <--> IDB
        SW <--> LocalStore
        SW <--> SessionStore
    end

    subgraph OptionalExternal["Optional User-Configured Services"]
        NIM["NVIDIA NIM API (integrate.api.nvidia.com)"]
        Backend["Optional Self-Hosted Fastify/PostgreSQL Backend (/v1)"]
    end

    WS <-->|"Tab-Bound Runtime Messages (documentId)"| CS
    SW <-->|"Tab Coordination & Capture"| CS
    SW -.->|"Explicit User Action Only (Sanitized Context)"| NIM
```

---

## 2. Component Separation and Responsibilities

### A. Content Script (`src/extension/content/content-script.ts`)
- Generates a per-document `documentId` token at injection time. All document-bound operations require a matching `documentId` and reject missing or stale bindings with `STALE_DOCUMENT`.
- Renders interactive hover/selection/measurement overlays inside an isolated Shadow DOM host (`#pagesift-root-host` with `data-pagesift-root="true"`). All extraction and capture engines filter out `[data-pagesift-root]` so PageSift never inspects or screenshots its own UI.
- Coordinates DOM preparation, tile scrolling, and guaranteed `finally` restoration (`CAPTURE_PREPARE`, `CAPTURE_SCROLL_TO`, `CAPTURE_RESTORE`) for background-driven screenshot capture without accepting test fallback data in production paths.
- Emits throttled, echo-suppressed `SYNC_SCROLL` events when registered in an active responsive preview session (`SET_RESPONSIVE_SYNC`), and reports actual inner/outer viewport metrics (`GET_VIEWPORT_METRICS`).
- Maintains a per-document `PageEditController` stack for reversible `Edit Text`, `Swap Font`, and `Arrange` previews with full `Undo`, `Redo`, and `Reset All`, automatically cleaning up listeners and mutations on `Escape` or `pagehide`.

### B. Background Service Worker (`src/extension/background/service-worker.ts`)
- Registers top-level `chrome.runtime.onInstalled`, `chrome.runtime.onStartup`, `chrome.runtime.onMessage`, `chrome.tabs.onRemoved`, `chrome.tabs.onUpdated`, and `chrome.windows.onRemoved` listeners synchronously at worker startup.
- Validates every incoming message envelope and operation-specific payload against Zod schemas (`schemaVersion: 1`) and verifies sender authorization via `validateSenderAuthorization`.
- Persists real `LocalJobRecord` entries in IndexedDB for long-running capture, clone, and asset archive operations, routes active `CANCEL_JOB` signals to `AbortController` instances, and runs `recoverInterruptedJobs()` on worker wake-up.
- Runs real screenshot capture (`chrome.tabs.captureVisibleTab` + target tab verification + `OffscreenCanvas` stitching/cropping/annotation/encoding + binary PDF JPEG XObject assembly), privileged HTTP(S) asset fetching (`asset-fetcher.ts` with streaming byte limits and `credentials: 'omit'`), responsive preview window lifecycle & session persistence, IndexedDB storage/backup operations, and optional NVIDIA NIM requests with mandatory egress preview digest confirmation.

### C. Extension-Owned UI Pages (`workspace.html`, `options.html`)
- **`workspace.html` / `workspace.ts`**: Action popup and full-tab workspace (**Open Full Tab** button so popup dismissal never interrupts long-running work) providing controls for all 15 tools, real screenshot preview + crop/annotation controls, responsive preset/custom window launcher + sync toggle + cleanup button, real file download and clipboard copy controls across outputs, project/artifact/capture persistence in IndexedDB, reversible edit controls (`Undo`/`Redo`/`Reset`), and optional NVIDIA egress preview & confirmed invocation.
- **`options.html` / `options.ts`**: Manages default export preferences (`chrome.storage.local`), session-only NVIDIA API key configuration (`chrome.storage.session`), IndexedDB byte-usage reporting, downloadable JSON backup export, and validated atomic backup import/reset.

### D. Optional Self-Hosted Backend (`src/app.ts`, `src/server.ts`)
- Preserved as an optional Fastify + PostgreSQL 17 modular monolith for users who wish to self-host cloud project/artifact storage later. The Chrome extension does not depend on this server to run any of its 15 tools.
