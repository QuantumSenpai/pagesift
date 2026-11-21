# PageSift Optional NVIDIA AI Integration Guide

## 1. Overview

All 15 PageSift tools work 100% locally without any AI credentials. For users who want optional LLM enhancement of local `Clone Prompt` blueprints or `Design Review` findings, PageSift includes a small, strict adapter (`src/extension/ai/nvidia-client.ts`) targeting NVIDIA's OpenAI-compatible NIM API.

- **Verified Endpoint Allowlist**:
  - `https://integrate.api.nvidia.com/v1/chat/completions`
- **User-Owned Key & Model ID**:
  - No developer-owned key is bundled, and PageSift never invents a fallback model ID.
  - The user supplies their own NVIDIA API key (`nvapi-...`) and their chosen catalog model ID (for example `meta/llama-3.1-70b-instruct` from https://build.nvidia.com).
  - Provider access is governed by the user's own NVIDIA account terms and credits; PageSift does not assume provider access is free.

---

## 2. Key Storage and Security Boundaries

1. **Session-Only Storage by Default (`chrome.storage.session`)**:
   - The user's NVIDIA API key is stored in `chrome.storage.session`, which resides in memory for the current browser session only and is cleared automatically when the browser exits.
   - **Important Disclosure**: Browser extension storage is not a hardware security vault; only enter an API key on a trusted device and browser profile.
2. **Restricted to Privileged Extension Contexts**:
   - `SET_NVIDIA_API_KEY`, `CLEAR_NVIDIA_API_KEY`, `GET_NVIDIA_KEY_STATUS`, and `RUN_NVIDIA_ENHANCEMENT` are enforced by `validateSenderAuthorization` in `src/extension/protocol/messages.ts` as privileged extension-page-only operations (`chrome-extension://<id>/workspace.html` or `options.html`).
   - Content scripts and inspected web pages cannot read the API key, check key status, or trigger AI requests.
   - The API key is never written to `chrome.storage.local`, IndexedDB, exported JSON backups, snapshot ZIP archives, or console logs.

---

## 3. Data Egress Transparency

Before sending any request to `https://integrate.api.nvidia.com/v1/chat/completions`, users can click **"Preview NVIDIA Data Egress"** in the Workspace UI (`buildNvidiaEgressPreview`), which displays the exact sanitized JSON payload that will leave the device:

- **What Leaves the Device**:
  - Compact extracted structural summary (`pageTitle`, `targetFramework`, top normalized hex colors, primary font families, spacing scale numbers, layout/component observations, or design review finding summaries).
- **What Is Explicitly Excluded**:
  - Form input values, `<textarea>` contents, and passwords.
  - Cookies, `Authorization` headers, and session tokens.
  - Sensitive URL query parameters and fragments (`?token=...#...` are stripped from any URL in the context).
  - Full raw page HTML dumps.

---

## 4. Reliability and Output Safety

- **Timeout & Cancellation**: Requests enforce a bounded timeout (`20,000 ms` default) and support immediate user cancellation via `AbortController`.
- **Bounded Output**: Requests set `max_tokens: 1024` and `stream: false`, and responses are capped at `16,384` characters.
- **Error & Rate-Limit Handling**:
  - `HTTP 401 / 403`: Reports authentication failure and prompts the user to check their NVIDIA API key.
  - `HTTP 404`: Reports that the specified model ID was not found in the NVIDIA catalog.
  - `HTTP 429`: Reports rate limiting and surfaces `Retry-After` when present.
  - `HTTP 5xx`: Performs at most `1` bounded retry before returning a structured error.
- **Inert Output Handling**: Model completions are rendered strictly as plain text (`textContent`) inside `<pre id="tool-output">` and are never passed to `innerHTML`, `eval`, or privileged extension actions.

---

## 5. Setup and Manual Verification Steps

1. Open PageSift Options (`chrome-extension://<id>/options.html`).
2. Enter your chosen NVIDIA catalog model ID (e.g., `meta/llama-3.1-70b-instruct`) under **Optional NVIDIA Catalog Model ID** and click **Save Preferences**.
3. Enter your NVIDIA API key (`nvapi-...`) under **Optional NVIDIA NIM Session API Key** and click **Set Session Key**.
4. Open PageSift Workspace on any inspected page, run **3. Clone Prompt** or **14. Design Review** locally, click **Preview NVIDIA Data Egress** to inspect the outgoing payload, and click **Enhance with Optional NVIDIA AI**.

> **Verification Status Note**: The NVIDIA client boundary, endpoint allowlist, payload sanitization, retry/timeout/abort handling, and HTTP 200/401/404/429/503 responses are verified via controlled boundary tests in `tests/unit/extension-slice6-10-engines.test.ts`. Live external calls against `https://integrate.api.nvidia.com` require user-supplied credentials and are marked pending manual verification with a live key.
