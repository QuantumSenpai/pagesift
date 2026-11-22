# PageSift Permissions and Local-Data Privacy Guide

## 1. Chrome Extension Permissions and Actual Host-Access Behavior

PageSift declares the following Manifest V3 permissions and content script matches in `dist/extension/manifest.json`:

| Manifest Entry | Scope | Why It Is Needed |
| :--- | :--- | :--- |
| `permissions: activeTab` | Required | Grants temporary access to the active tab when invoked via the toolbar icon. |
| `permissions: tabs` | Required | Allows the background service worker to inspect target tab identity (`chrome.tabs.get`), verify that the target tab has not closed or navigated away before screenshot capture, focus the intended tab, and track responsive preview tab lifecycle events (`onRemoved`, `onUpdated`). |
| `permissions: storage` | Required | Provides `chrome.storage.local` for small non-secret preferences and `chrome.storage.session` for holding an optional user-supplied NVIDIA API key and active responsive session state in memory during the current browser session. |
| `permissions: downloads` | Required | Supports saving exported ZIP archives, Markdown files, JSON backups, and PNG/JPEG/WebP/PDF captures. |
| `permissions: unlimitedStorage` | Required | Prevents browser eviction of user-saved projects, artifacts, and captures stored in local IndexedDB (`pagesift_local_db`). |
| `host_permissions: <all_urls>` | Required | Required by Chromium Manifest V3's `chrome.tabs.captureVisibleTab()` permission check (`CanCaptureVisiblePage`) when capturing from a detached Full Tab workspace (`workspace.html?tabId=...`) without an active toolbar click on the target tab, and enables background asset downloads for cross-origin stylesheets, images, and fonts during **Assets ZIP** and **Clone Page ZIP**. PageSift's service worker strictly enforces `http://` and `https://` target URLs in code (`isHttpOrHttpsUrl`) and refuses to capture or fetch `chrome://`, `file://`, `about:`, or `chrome-extension://` tabs. |
| `content_scripts: http://*/*, https://*/*` | Static Content Script | Injects PageSift's on-demand content script listener (`content-script.js`) on HTTP/HTTPS pages so tool commands from the Workspace or managed responsive preview windows can communicate with the document. PageSift does **not** claim `activeTab`-only injection while static content scripts are declared; the content script remains idle until explicitly invoked by the user and performs zero background telemetry or data collection. |

### Permissions Intentionally Not Requested
- **No `debugger` permission**: PageSift does not attach the Chrome DevTools debugger banner or intercept low-level network sockets.
- **No `webRequest` or `webRequestBlocking` permission**: PageSift does not monitor background browsing traffic or strip security headers (`X-Frame-Options` / `CSP`).
- **No `cookies`, `history`, `bookmarks`, or `nativeMessaging` permissions**: PageSift never reads browser cookies or browsing history, and external asset fetches strictly use `credentials: 'omit'`.

---

## 2. Local-Data Privacy Guarantees and Honest Boundaries

1. **Zero Browsing History or Automatic Page Uploads**:
   - PageSift runs strictly on explicit user action. No analytics, telemetry, crash reports, or inspected page contents are transmitted automatically.
   - All 15 local tools operate without login, backend connectivity, or an NVIDIA API key.
2. **Strict Host Website Storage Isolation**:
   - PageSift stores all saved projects, artifacts, captures, and job records inside the extension origin's IndexedDB (`chrome-extension://<id>`) and settings in `chrome.storage.local` / `chrome.storage.session`.
   - PageSift never writes data, tokens, or API keys into an inspected website's `localStorage`, `sessionStorage`, `IndexedDB`, cookies, or DOM globals.
   - Database credentials and Google OAuth client secrets from the optional self-hosted backend are never bundled into `dist/extension/`.
3. **Privileged Asset Fetching Boundary**:
   - External HTTP(S) asset fetching for **Assets ZIP** and **Clone Page ZIP** executes exclusively in the trusted background service worker (`src/extension/engines/asset-fetcher.ts`), never as an open fetch proxy callable by inspected pages or content scripts.
   - Requests use `credentials: 'omit'`, enforce HTTP/HTTPS scheme and redirect destination validation, bound concurrency (`4`), enforce per-request timeouts (`10s`), and enforce streaming `ReadableStream` byte limits (`5 MiB` per asset, `25 MiB` total archive) before buffering full responses.
4. **Static Snapshot Sanitization Policy (`Clone Page`)**:
   - Exported HTML and inline SVGs are sanitized using **DOMPurify (`3.4.18`)** plus explicit pre/post structural checks:
     - Strips `<script>`, `<noscript>`, `<iframe>` (including `srcdoc`), `<frame>`, `<frameset>`, `<object>`, `<embed>`, `<applet>`, `<base>`, `<meta>` (including `http-equiv="refresh"`), `<link>`, `<template>`, `<selectedcontent>`, `<portal>`, `<foreignObject>`, and SVG animation tags (`<animate>`, `<set>`, etc.).
     - Strips all inline `on*` event handlers, `srcdoc`, `action`, `formaction`, `autofocus`, `ping`, and obfuscated/encoded executable URL schemes (`javascript:`, `vbscript:`, `data:text/html`, `file:`, `chrome:`).
     - Clears values from `<input>` (including `password` and `hidden` fields) and `<textarea>` controls, and neutralizes `<form>` submission attributes.
     - Injects a defensive `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline';">` header (in addition to sanitization, never as a substitute).
     - Preserves safe `http(s)` `<a href>` navigation links with `rel="noopener noreferrer"`.
     - Reports `isSelfContained` and `residualRemoteResources` / `missingResources` honestly in `manifest.json`; never claims an archive is self-contained if remote or unavailable resources remain.
5. **Optional NVIDIA AI Data Minimization**:
   - See [docs/nvidia-ai-guide.md](nvidia-ai-guide.md) for the exact structural allowlist, recursive array/object sanitization rules, depth/byte limits, and mandatory preview/confirmation digest enforcement.
