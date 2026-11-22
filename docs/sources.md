# PageSift Documentation & Investigation Sources

## 1. Context7 MCP Documentation Sources

The following libraries were resolved and queried through the Context7 MCP server (`context7_context7`: `resolve-library-id` and `query-docs`) and cross-checked against installed TypeScript definitions and executable checks:

1. **Playwright (`playwright@1.65.1`)**
   - **Context7 Library ID**: `/microsoft/playwright`
   - **Topics Consulted**: Loading unpacked Chromium Manifest V3 extensions with `chromium.launchPersistentContext`, `--disable-extensions-except`, `--load-extension`, retrieving MV3 background `serviceWorkers()`, `waitForEvent('serviceworker')`, and stopping/restarting MV3 service workers via CDP `ServiceWorker.enable` + `ServiceWorker.stopWorker`.
   - **Reference**: https://github.com/microsoft/playwright/blob/main/docs/src/chrome-extensions-js-python.md & https://github.com/microsoft/playwright/blob/main/tests/library/chromium/extensions.spec.ts
2. **fflate (`fflate@0.8.3`)**
   - **Context7 Library ID**: `/101arrowz/fflate`
   - **Topics Consulted**: Creating and reading ZIP archives in browser/extension and Node environments (`zipSync`, `unzipSync`, `strToU8`, `strFromU8`, compression levels).
   - **Reference**: https://github.com/101arrowz/fflate/blob/master/docs/functions/zipSync.md
3. **idb (`idb@8.0.4`)**
   - **Context7 Library ID**: `/jakearchibald/idb`
   - **Topics Consulted**: Typed IndexedDB schema definition (`DBSchema`), versioned upgrades (`openDB`, `upgrade(db, oldVersion, newVersion, transaction)`), `createObjectStore`, `createIndex`, `getKey()`, and multi-store readwrite transactions.
   - **Reference**: https://github.com/jakearchibald/idb/blob/main/README.md
4. **Fastify (`fastify@5.12.8`) & Plugins (`@fastify/cors@11.4.3`, `@fastify/helmet@13.2.0`, `@fastify/rate-limit@11.3.0`, `@fastify/swagger@9.9.5`)**
   - **Context7 Library IDs**: `/fastify/fastify`, `/fastify/fastify-cors`, `/fastify/fastify-helmet`, `/fastify/fastify-rate-limit`, `/fastify/fastify-swagger`
   - **Topics Consulted**: Custom error handlers (`setErrorHandler`), logger serializers and redaction (`serializers.req`, `redact`), and graceful shutdown (`onClose`).
5. **Kysely (`kysely@0.29.9`) & node-postgres (`pg@8.23.1`)**
   - **Context7 Library IDs**: `/kysely-org/kysely`, `/brianc/node-postgres`
   - **Topics Consulted**: `PostgresDialect`, `Migrator`, `pg.Pool` timeouts, and transactional DDL.
6. **OpenID Client (`openid-client@6.9.1`) & JOSE (`jose@6.2.18`)**
   - **Context7 Library IDs**: `/panva/openid-client`, `/panva/jose`
   - **Topics Consulted**: OAuth 2.0 Authorization Code flow with PKCE (`buildAuthorizationUrl`, `authorizationCodeGrant`, `calculatePKCECodeChallenge`) and RS256/HS256 JWT verification (`createRemoteJWKSet`, `jwtVerify`, `SignJWT`).
7. **Zod (`zod@4.6.7`) & Vitest (`vitest@5.1.1`)**
   - **Context7 Library IDs**: `/colinhacks/zod`, `/vitest-dev/vitest`
   - **Topics Consulted**: Strict vs. passthrough object validation (`z.strictObject`, `z.object`), discriminated unions for runtime messaging, and test lifecycle hooks.
8. **DOMPurify (`dompurify@3.4.18`)**
   - **Context7 Library ID**: `/cure53/dompurify`
   - **Topics Consulted**: `WHOLE_DOCUMENT` sanitization, `FORBID_TAGS` (`iframe`, `object`, `embed`, `base`, `meta`, `link`, `template`, `selectedcontent`), `FORBID_ATTR` (`srcdoc`, `action`, `formaction`), `ALLOWED_URI_REGEXP`, SVG sanitization profiles, and JSDOM/browser initialization (`createDOMPurify(window)`).
   - **Reference**: https://github.com/cure53/DOMPurify/blob/main/README.md & https://github.com/cure53/DOMPurify/wiki/Security-Goals-&-Threat-Model

---

## 2. Official Platform, Font & Provider Documentation

1. **Chrome Extensions Manifest V3 (Chrome for Developers)**
   - `chrome.action.onClicked` behavior (does not fire when `action.default_popup` is declared), `web_accessible_resources` for Shadow DOM local `.woff2` fonts and icons, `chrome.tabs.setZoom` / `getZoom`, service worker lifecycle, `chrome.runtime.onMessage` sender verification, `chrome.storage.local` / `chrome.storage.session`, `chrome.tabs.captureVisibleTab`, `chrome.downloads.download`, and `chrome.windows.create`.
   - Reference: https://developer.chrome.com/docs/extensions/reference/api/action & https://developer.chrome.com/docs/extensions/reference/api/tabs
2. **Bundled Local Typefaces (SIL Open Font License 1.1)**
   - Instrument Sans (`@fontsource/instrument-sans`) and IBM Plex Mono (`@fontsource/ibm-plex-mono`) bundled directly in `dist/extension/fonts/` for zero runtime external font requests.
3. **NVIDIA NIM Chat Completions API**
   - OpenAI-compatible endpoint `https://integrate.api.nvidia.com/v1/chat/completions` and `GET https://integrate.api.nvidia.com/v1/models`.
   - Reference: https://docs.api.nvidia.com/nim/reference/llm-apis

---

## 3. Design Direction & Reference Disclosures

- **Visual Inspiration**: Reviewed the solid dark midnight canvas, disciplined electric-blue interactive accents, fine hairline borders, and compact control hierarchy inspired by https://cloud.laravel.com while strictly using solid flat colors (zero gradients, glow, or glass effects) and zero copied branding, logos, illustrations, or text.
- **Playwright Toolbar Click Boundary**: Playwright cannot click Chromium's native browser-chrome toolbar action button directly; automated Chromium E2E verifies `manifest.json` omits `action.default_popup`, tests the exact `TOGGLE_OVERLAY_DASHBOARD` overlay toggle flow on a real web page, and unit-tests `handleActionClicked` for both supported `http(s)://` tabs and restricted `chrome://` fallback URLs.
- **Public Reference Evidence**: Publicly accessible Chrome Web Store metadata for Sitepeel (`khcjkaobanoeohahnlffnnppinoeljme`) was reviewed to confirm the 15-tool functional taxonomy. All PageSift code, UI, extraction algorithms, and branding are independently authored.
