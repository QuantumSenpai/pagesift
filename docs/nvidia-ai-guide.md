# PageSift Optional AI Integration Guide (NVIDIA NIM & Custom API Keys)

## 1. Overview

All 15 PageSift tools work locally without any AI credentials. For users who explicitly choose optional LLM enhancement of local `Clone Prompt` blueprints, `Design Review` findings, or `Tech Stack` summaries, PageSift includes an OpenAI-compatible client (`src/extension/ai/nvidia-client.ts`) defaulting to NVIDIA NIM while supporting user-selected provider presets or custom endpoints:

- **Supported Presets & SSRF-Safe Endpoint Validation**:
  - `nvidia`: `https://integrate.api.nvidia.com/v1/chat/completions`
  - `openai`: `https://api.openai.com/v1/chat/completions`
  - `openrouter`: `https://openrouter.ai/api/v1/chat/completions`
  - `groq`: `https://api.groq.com/openai/v1/chat/completions`
  - `custom`: User-supplied endpoint validated by `validateSafeAiEndpointUrl()` (HTTPS required for public hosts; HTTP permitted only for `127.0.0.1` / `localhost` / `[::1]`; private/link-local/metadata IP ranges rejected).
- **User-Owned Key & Model ID**:
  - No developer-owned key is bundled into `dist/extension/`, and PageSift never invents a fallback model ID.
  - The user supplies their own API key (`nvapi-...`, `sk-...`, or custom Bearer token) and chosen model ID (for example `meta/llama-3.1-70b-instruct` or `gpt-4o-mini`).
  - Provider access is governed by the user's own account terms and credits.

---

## 2. Key Storage and Privileged Boundary

1. **Session-Only Storage by Default (`chrome.storage.session`)**:
   - The user's NVIDIA API key is stored in `chrome.storage.session` (in memory for the current browser session only) and is cleared automatically when the browser exits.
   - Browser extension storage is not a hardware security vault; only enter an API key on a trusted device and browser profile.
2. **Privileged Extension-Page Enforcement**:
   - `SET_NVIDIA_API_KEY`, `CLEAR_NVIDIA_API_KEY`, `GET_NVIDIA_KEY_STATUS`, and `RUN_NVIDIA_ENHANCEMENT` require a trusted extension UI page sender (`chrome-extension://<id>/workspace.html` or `options.html`). Content scripts and inspected pages are rejected with `UNAUTHORIZED_SENDER`.
   - The API key is never written to `chrome.storage.local`, IndexedDB, exported JSON backups, snapshot ZIP archives, or console logs.

---

## 3. Data Minimization, Allowlist, and Preview/Confirmation Consistency

PageSift does **not** forward arbitrary tool outputs or trust a caller-supplied `sanitizedContext` field at the background boundary. Instead, `BackgroundCoordinator` rebuilds a compact allowlisted payload via `buildAllowlistedNvidiaContext()` for supported tasks (`enhance_clone_prompt`, `interpret_design_review`, and `explain_tech_stack`) and runs recursive sanitization across both objects and arrays:

- **Allowlisted Fields Only**:
  - `enhance_clone_prompt`: `sourceTool`, `pageTitle`, `sourceUrl`, `targetFramework`, `observations`, `assumptions`, `prompt`, `colors`/`topColors`/`palette`, `typography`/`fonts`, `spacing`/`spacingScale`, `layout`, `components`, `sections`, `markdown`.
  - `interpret_design_review`: `sourceTool`, `pageTitle`, `sourceUrl`, `findings`, `findingsCount`, `summary`, `counts`, `remediationPrompt`, `colors`, `typography`, `spacing`, `layout`.
  - `explain_tech_stack`: `sourceTool`, `pageTitle`, `sourceUrl`, `summary`, `organizedSummary`, `detections`, `uncertaintyNotes`.
- **Recursive Structural Removal (Objects & Arrays)**:
  - Recursively strips case-insensitive sensitive structural field names matching or containing `password`, `passwd`, `pwd`, `secret`, `token`, `apikey`, `authorization`, `authheader`, `cookie`, `session`, `credential`, `privatekey`, `formvalues`, `rawhtml`, `htmlcontent`, `htmlpreview`, `zipbase64`, `dataurl`, `backup`, `bearer`, `csrf`, `creditcard`, `cardnumber`, `cvv`, `ssn` at every supported nesting depth inside objects and arrays.
  - Strips `username`, `password`, query strings (`?...`), and fragments (`#...`) from HTTP(S) URLs (including URLs embedded in strings), and replaces `data:` URIs with `[omitted-data-uri]`.
  - Enforces hard structural limits: max depth `6`, max array length `30`, max object keys `40`, max string length `1,000` chars, and max serialized payload size `16,384` bytes.
- **Honest Limitation on Prose**:
  - Structural key and URL sanitization cannot guarantee detection of arbitrary secrets typed into unstructured page text or headings. Users must inspect the **Preview NVIDIA Data Egress** output before confirming transmission.
- **Mandatory Preview-to-Execution Digest Lock**:
  - Clicking **Preview NVIDIA Data Egress** (`previewOnly: true`) computes and caches a deterministic `payloadDigest` over the exact outgoing JSON.
  - Clicking **Confirm & Enhance with Optional NVIDIA AI** (`previewOnly: false`) requires `confirmedPayloadDigest` matching the exact rebuilt payload. Changing tool output or switching tools invalidates the confirmation and requires a fresh preview.

---

## 4. Reliability and Output Safety

- **Timeout & Cancellation**: Requests enforce a bounded timeout (`20,000 ms` default) and support immediate user cancellation via `AbortController` / `CANCEL_JOB`.
- **Bounded Output**: Requests set `max_tokens: 1024` and `stream: false`; responses are capped at `16,384` characters.
- **Error & Rate-Limit Handling**: Handles `HTTP 401/403`, `HTTP 404`, `HTTP 429` (surfacing `Retry-After`), malformed JSON responses, timeouts, cancellations, and at most `1` bounded retry on `HTTP 5xx`.
- **Inert Output Handling**: Completions are displayed strictly as plain text (`textContent`) and are never passed to `innerHTML`, `eval`, or privileged actions.

---

## 5. Verification Status

- Automated boundary tests (`tests/unit/extension-regressions.test.ts` and `tests/unit/extension-slice6-10-engines.test.ts`) verify recursive array/object secret removal, credential-URL stripping, depth/byte caps, preview/execution digest consistency, malformed JSON, timeout, cancellation, `401`/`404`/`429`/`503` handling, and zero AI traffic during local-only tools.
- Live calls against `https://integrate.api.nvidia.com` remain pending manual verification with a user-supplied live key.
