# PageSift Permissions and Local-Data Privacy Guide

## 1. Chrome Extension Permissions and Actual Host-Access Behavior

PageSift declares the following Manifest V3 permissions and content script matches in `dist/extension/manifest.json`:

| Manifest Entry | Scope | Why It Is Needed |
| :--- | :--- | :--- |
| `permissions: activeTab` | Required | Grants temporary access to the active tab when invoked via the toolbar icon (`chrome.action.onClicked`). |
| `permissions: tabs` | Required | Allows the background service worker to inspect target tab identity (`chrome.tabs.get`), verify target tab stability before screenshot capture, open the full dashboard tab, and track responsive preview window lifecycle events. |
| `permissions: storage` | Required | Provides `chrome.storage.local` for small non-secret preferences (theme, export defaults, sidebar state, history recording/retention preferences) and `chrome.storage.session` for holding an optional user-supplied NVIDIA API key and active responsive session state in memory. |
| `permissions: downloads` | Required | Supports saving exported ZIP archives, Markdown files, JSON backups, and PNG/JPEG/WebP/PDF captures. |
| `permissions: unlimitedStorage` | Required | Prevents browser eviction of user-saved projects, artifacts, captures, and explicit PageSift activity history stored in local IndexedDB (`pagesift_local_db v4`). |
| `optional_permissions: tabCapture` | Opt-In Only | Requested only when the user explicitly clicks visual video recording in **Motion Lab** (`workspace.html`). Video capture disables audio (`audio: false`), stops all media tracks on completion/cancel/error, and falls back to `getDisplayMedia` or returns explicit permission/unsupported states without breaking Motion Lab metadata extraction. |
| `host_permissions: <all_urls>` | Required | Required by Chromium Manifest V3's `chrome.tabs.captureVisibleTab()` permission check (`CanCaptureVisiblePage`) when capturing from a detached dashboard tab (`workspace.html?tabId=...`), and enables background asset downloads for cross-origin stylesheets, images, and fonts during **Assets ZIP** and **Clone Page ZIP**. PageSift's service worker strictly enforces `http://` and `https://` target URLs in code (`isHttpOrHttpsUrl`) and refuses `chrome://`, `file://`, `about:`, or `chrome-extension://` tabs. |
| `content_scripts: http://*/*, https://*/*` | Static Content Script | Injects PageSift's on-demand content script listener (`content-script.js`) on HTTP/HTTPS pages so toolbar clicks can open the Shadow DOM overlay and dashboard commands can communicate with the document. While idle, the content script injects **zero** DOM nodes, makes **zero** network requests, and records **zero** browsing events. |
| `web_accessible_resources` | Local Assets Only | Exposes only PageSift's 7 bundled `.woff2` local font files (`fonts/*`) and `icons/icon-32.png` to `http://*/*` and `https://*/*` so the Shadow DOM overlay renders offline without any external CDN requests. |

### Permissions Intentionally Not Requested
- **No `history` permission**: PageSift never reads or tracks Chrome's browser history.
- **No `debugger` permission**: PageSift does not attach the Chrome DevTools debugger banner or intercept low-level network sockets.
- **No `webRequest` or `webRequestBlocking` permission**: PageSift does not monitor background browsing traffic or strip security headers (`X-Frame-Options` / `CSP`).
- **No `cookies`, `bookmarks`, or `nativeMessaging` permissions**: PageSift never reads browser cookies or bookmarks, and external asset fetches strictly use `credentials: 'omit'`.

---

## 2. Local Research Activity History Privacy Model (`IndexedDB v3`)

PageSift's **Activity History** (`src/extension/storage/activity-history.ts`) is strictly a local log of explicit PageSift tool runs — **never** a browsing-history tracker:

1. **Explicit Tool Actions Only**:
   - Entries are created only when the user explicitly runs one of PageSift's 15 tools (from the on-page overlay or persistent dashboard).
   - Visiting tabs, switching tabs, scrolling, or passive browsing never creates an activity entry.
2. **Strict Metadata Sanitization Before Persistence**:
   - **URLs**: Basic-auth credentials (`user:pass@`), query strings (`?token=...`), and fragments (`#hash`) are stripped before storage; only `origin + pathname` (truncated to 512 chars) is stored. Non-HTTP(S) URLs normalize to `about:restricted`.
   - **Options**: Only an explicit allowlist of non-sensitive option keys (`mode`, `exportMime`, `targetFramework`, `action`, `scope`, `selector`, `format`, `fontFamily`, etc.) is stored. Keys matching sensitive patterns (`password`, `secret`, `token`, `cookie`, `auth`, `api_key`, `bearer`, `html`, `base64`, `body`, `input`) are rejected.
   - **Summaries & Errors**: `data:...;base64,...` blobs, `nvapi-` / `GOCSPX-` / `Bearer` tokens, and raw URLs in error categories are stripped before storage. Full page HTML, form values, passwords, and binary files are never written to activity records.
3. **Truthful Timing Semantics**:
   - Timestamps are stored in UTC ISO-8601 and displayed in the user's local timezone (`Today`, `Yesterday`, or localized date).
   - `durationMs` is measured using monotonic `performance.now()` over the tool execution itself and is explicitly labeled **Action duration** in the UI — never active reading or browsing time.
4. **Full User Control & Separation from Saved Work**:
   - Users can pause recording immediately (`Record new actions` toggle in Activity History or Settings) without losing existing data.
   - Users can delete single entries, delete an entire research session, apply retention pruning (`7 / 30 / 90 / 365 days`, capped at `500` entries by default), or clear all activity history via a confirmation modal while keeping Saved Projects, Artifacts, and Captures untouched.
   - If a user deletes a saved artifact referenced by a history entry, the history entry stays valid and clearly indicates `Saved result removed`.

---

## 3. Local Storage Isolation, Asset Fetching & Sanitization Guarantees

1. **Zero Automatic Page Uploads or Telemetry**: All 15 tools and Activity History work completely offline with zero external requests (verified `0` external requests in Chromium).
2. **Strict Host Website Isolation**: All projects, artifacts, captures, jobs, and activity entries stay inside `chrome-extension://<id>` IndexedDB (`pagesift_local_db v3`). PageSift never writes extension data or API keys into inspected sites' `localStorage`, `sessionStorage`, `IndexedDB`, cookies, or DOM globals.
3. **Privileged Asset Fetching Boundary**: External HTTP(S) asset fetching (`asset-fetcher.ts`) runs only in the background worker with `credentials: 'omit'`, scheme/redirect validation, concurrency `4`, `10s` timeout, and streaming byte limits (`5 MiB` per asset, `25 MiB` total).
4. **Static Snapshot Sanitization (`Clone Page`)**: Exported HTML and inline SVGs are sanitized via **DOMPurify (`3.4.18`)** plus structural checks stripping scripts, `<iframe>`/`srcdoc`, active embeds, `on*` handlers, obfuscated executable URLs, and sensitive form/password/hidden input values, paired with a defensive CSP meta tag and honest `isSelfContained` / `missingResources` manifests.
5. **Optional NVIDIA AI Data Minimization**: See [docs/nvidia-ai-guide.md](nvidia-ai-guide.md) for the structural allowlist, recursive redaction rules, and mandatory egress preview confirmation digest.
