# PageSift Permissions and Local-Data Privacy Guide

## 1. Chrome Extension Permissions Explanation

PageSift requests the minimum Manifest V3 permissions required for local inspection, storage, and file export in `dist/extension/manifest.json`:

| Permission | Kind | Why It Is Needed |
| :--- | :--- | :--- |
| `activeTab` | Required | Grants temporary access to the currently active tab when the user invokes PageSift, enabling DOM inspection, computed style extraction, and visible tab screenshot capture without permanent all-sites background tracking. |
| `storage` | Required | Provides `chrome.storage.local` for small non-secret preferences and `chrome.storage.session` for holding an optional user-supplied NVIDIA API key in memory during the current browser session. |
| `downloads` | Required | Allows saving exported static HTML/CSS snapshot `.zip` archives, asset `.zip` bundles, `DESIGN.md` files, and PNG/JPEG/WebP/PDF captures to the user's disk. |
| `unlimitedStorage` | Required | Prevents the browser from evicting the user's saved projects, multi-page `DESIGN.md` snapshots, and high-DPI screenshots stored in the extension's local IndexedDB (`pagesift_local_db`). |
| `https://*/*`, `http://*/*` | Optional Host Permissions | Requested only when needed for cross-tab responsive viewport synchronization or fetching same-page static assets during a user-initiated snapshot export. |

### Permissions Intentionally Not Requested
- **No `debugger` permission**: PageSift does not attach the Chrome DevTools debugger banner or intercept low-level network sockets.
- **No `webRequest` or `webRequestBlocking` permission**: PageSift does not monitor background browsing traffic or strip security headers (`X-Frame-Options` / `CSP`).
- **No `<all_urls>` mandatory host permission**: PageSift does not run background collection across unvisited tabs.

---

## 2. Local-Data Privacy Guarantees

1. **Zero Browsing History or Telemetry Collection**:
   - PageSift runs strictly on demand when invoked by the user. No analytics, telemetry, crash reports, or inspected page contents are transmitted automatically.
2. **Strict Host Website Storage Isolation**:
   - PageSift stores all saved projects, artifacts, and captures inside the extension origin's IndexedDB (`chrome-extension://<id>`) and settings in `chrome.storage.local` / `chrome.storage.session`.
   - PageSift **never** writes data, tokens, or API keys into an inspected website's `localStorage`, `sessionStorage`, `IndexedDB`, cookies, or DOM globals (verified by automated Chromium E2E assertions in `tests/integration/chromium-extension-e2e.test.ts`).
3. **Sensitive Form and Password Exclusion**:
   - Both `Inspect` (`sanitizeElementHtml`) and `Clone Page` (`exportStaticPageClone`) strip `<input type="password">`, entered form `.value` attributes, `<textarea>` contents, and credit-card/password autocomplete fields before generating previews or snapshot archives.
   - `Edit Text` (`PageEditController.applyTextEdit`) refuses to mutate `<input>`, `<textarea>`, `<select>`, or `<form>` controls.
4. **Inert Handling of Untrusted Page Content**:
   - Extracted HTML, inline SVGs, CSS rules, URLs, and filenames are sanitized against `<script>`, inline `on*` event handlers, `javascript:` / `data:text/html` URLs, and `../` path traversal before rendering previews or packaging ZIP archives.
