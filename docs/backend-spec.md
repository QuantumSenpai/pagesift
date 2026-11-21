# PageSift Backend Specification

## 1. Purpose and Architectural Boundary

PageSift is an independently implemented Chrome extension for inspecting web page elements, extracting design tokens and assets, generating `DESIGN.md` references and rebuild prompts, and exporting static snapshots.

### Browser vs. Server Boundary
- **Extension Responsibility (Local-First)**: DOM inspection, computed style extraction, color/typography/spacing analysis, screenshot capture, and local HTML/CSS snapshot export happen locally inside the Chrome extension without requiring a running backend.
- **Backend Responsibility**:
  1. Identity, OAuth 2.0 / OIDC authentication with PKCE, and session management.
  2. Explicit, schema-validated account settings.
  3. Project organization with strict account ownership enforcement.
  4. Explicitly saved project artifacts (`design_reference`, `rebuild_prompt`, `design_token_export`, `asset_manifest`) with versioned schemas, separated metadata/body storage, byte limits, and optimistic concurrency control.
  5. Operational endpoints (`/v1/health/live`, `/v1/health/ready`, `/v1/openapi.json`), structured redacted logs, rate limiting, and graceful shutdown.
- **Out of Scope / Prohibited in Backend**:
  - Server-side browsing, arbitrary URL fetching, or headless browsers.
  - Automatic or background upload of inspected pages or browsing history.
  - Executing or rendering uploaded HTML/scripts on the API origin.
  - Storing binary screenshots, font binaries, or full website archives in PostgreSQL.

---

## 2. Recorded Assumptions and Stack Decisions

1. **Modular Monolith Stack**:
   - **Runtime**: Node.js LTS (`>=22.0.0`, tested on local Node.js runtime and packaged for Node 22 LTS Alpine in Docker).
   - **Language**: TypeScript with strict compiler flags (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`).
   - **HTTP Server**: Fastify v5 (`fastify`, `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/swagger`).
   - **Database & Migrations**: PostgreSQL 17 with `pg` (`Pool`) and `kysely` (`PostgresDialect`, `Migrator`, `FileMigrationProvider`). Kysely TypeScript migrations satisfy the zero-comment requirement while providing transactional, lock-protected, idempotent schema migrations.
   - **Authentication**: Google OpenID Connect / OAuth 2.0 Authorization Code flow with double-layer PKCE (extension-to-backend PKCE + backend-to-Google PKCE) implemented with `openid-client` (`Configuration`, `randomState`, `randomPKCECodeVerifier`, `calculatePKCECodeChallenge`, `buildAuthorizationUrl`, `authorizationCodeGrant`) and `jose` (`createRemoteJWKSet`, `jwtVerify`, `SignJWT`).
   - **Validation**: `zod` strict schemas for startup environment configuration, request bodies, query parameters, path parameters, versioned artifact payloads, and responses.
2. **Single-Instance Rate Limiting**:
   - Rate limiting uses `@fastify/rate-limit` in-memory store, explicitly documented as enforced per Node.js process instance (no Redis added without demonstrated multi-replica requirement).
3. **Comment-Free Authored Code Policy**:
   - All authored TypeScript files, tests, migrations, and configuration files contain zero comments, enforced by an AST/lexer verification check (`npm run check:no-comments`).

---

## 3. Data Ownership and Database Schema

All timestamps use `TIMESTAMPTZ` stored and serialized in UTC ISO-8601 format. Every user-owned table has explicit foreign-key constraints with deterministic cascade cleanup (`ON DELETE CASCADE`).

### Tables
1. `accounts`
   - `id` (`UUID PRIMARY KEY`)
   - `provider` (`TEXT NOT NULL`, default `'google'`)
   - `provider_subject` (`TEXT NOT NULL`)
   - `email` (`TEXT NOT NULL`)
   - `display_name` (`TEXT NOT NULL`)
   - `avatar_url` (`TEXT NULL`)
   - `created_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
   - `updated_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
   - Unique constraints: `UNIQUE (provider, provider_subject)`, `UNIQUE (email)`
2. `account_settings`
   - `account_id` (`UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE`)
   - `default_export_format` (`TEXT NOT NULL`, allowed: `'markdown' | 'json' | 'html_css'`)
   - `color_format` (`TEXT NOT NULL`, allowed: `'hex' | 'rgb' | 'hsl' | 'oklch'`)
   - `spacing_unit` (`TEXT NOT NULL`, allowed: `'px' | 'rem'`)
   - `include_computed_Defaults` -> `include_responsive_breakpoints` (`BOOLEAN NOT NULL`)
   - `redact_query_params_in_urls` (`BOOLEAN NOT NULL`)
   - `default_prompt_target` (`TEXT NOT NULL`, allowed: `'generic' | 'react_tailwind' | 'html_css' | 'vue_css'`)
   - `updated_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
3. `oauth_transactions`
   - `id` (`UUID PRIMARY KEY`)
   - `state` (`TEXT NOT NULL UNIQUE`)
   - `provider_code_verifier` (`TEXT NOT NULL`)
   - `client_redirect_uri` (`TEXT NOT NULL`)
   - `client_code_challenge` (`TEXT NOT NULL`)
   - `handoff_code_hash` (`TEXT NULL UNIQUE`)
   - `account_id` (`UUID NULL REFERENCES accounts(id) ON DELETE CASCADE`)
   - `expires_at` (`TIMESTAMPTZ NOT NULL`)
   - `handoff_expires_at` (`TIMESTAMPTZ NULL`)
   - `consumed_at` (`TIMESTAMPTZ NULL`)
   - `created_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
   - Index: `idx_oauth_transactions_expires_at` on `(expires_at)`
4. `sessions`
   - `id` (`UUID PRIMARY KEY`)
   - `account_id` (`UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE`)
   - `refresh_token_hash` (`TEXT NOT NULL UNIQUE`)
   - `user_agent` (`TEXT NULL`)
   - `expires_at` (`TIMESTAMPTZ NOT NULL`)
   - `revoked_at` (`TIMESTAMPTZ NULL`)
   - `created_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
   - `last_used_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
   - Index: `idx_sessions_account_id_active` on `(account_id, revoked_at, expires_at)`
5. `projects`
   - `id` (`UUID PRIMARY KEY`)
   - `account_id` (`UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE`)
   - `name` (`TEXT NOT NULL`)
   - `description` (`TEXT NOT NULL DEFAULT ''`)
   - `source_domain` (`TEXT NULL`)
   - `version` (`INTEGER NOT NULL DEFAULT 1`)
   - `created_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
   - `updated_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
   - Unique constraint: `UNIQUE (account_id, name)`
   - Index: `idx_projects_account_updated_id` on `(account_id, updated_at DESC, id DESC)`
6. `artifacts` (Metadata table — queried during list operations without touching large payload bodies)
   - `id` (`UUID PRIMARY KEY`)
   - `project_id` (`UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE`)
   - `account_id` (`UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE`)
   - `kind` (`TEXT NOT NULL`, allowed: `'design_reference' | 'rebuild_prompt' | 'design_token_export' | 'asset_manifest'`)
   - `title` (`TEXT NOT NULL`)
   - `schema_version` (`INTEGER NOT NULL`)
   - `source_url` (`TEXT NULL`)
   - `byte_length` (`INTEGER NOT NULL`)
   - `content_sha256` (`TEXT NOT NULL`)
   - `version` (`INTEGER NOT NULL DEFAULT 1`)
   - `created_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
   - `updated_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
   - Index: `idx_artifacts_project_updated_id` on `(project_id, account_id, updated_at DESC, id DESC)`
   - Index: `idx_artifacts_project_kind_updated_id` on `(project_id, account_id, kind, updated_at DESC, id DESC)`
7. `artifact_bodies` (Separated payload table — loaded only on single-artifact retrieve/create/update)
   - `artifact_id` (`UUID PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE`)
   - `body_json` (`JSONB NOT NULL`)

---

## 4. Concurrency, Pagination, and Byte Limits

### Concurrency Policy (Optimistic Concurrency Control)
- Both `projects` and `artifacts` maintain an integer `version` column starting at `1` and incrementing by `1` on every update.
- `PATCH /v1/projects/:projectId` and `PUT /v1/projects/:projectId/artifacts/:artifactId` require `expectedVersion` (integer `>= 1`) in the request body.
- Updates execute `WHERE id = $1 AND account_id = $2 AND version = $3`. If the record exists for that owner but `version !== expectedVersion`, the server rejects the update with `409 Conflict` (`code: "VERSION_CONFLICT"`), preventing silent overwrite of concurrent user edits.
- If the resource does not exist or belongs to another account, the server returns `404 Not Found` (`code: "RESOURCE_NOT_FOUND"`), preventing cross-account existence leaks.

### Pagination Policy
- Cursor-based pagination with deterministic ordering: `ORDER BY updated_at DESC, id DESC`.
- Query parameters:
  - `limit`: integer from `1` to `100` (default `20`).
  - `cursor`: opaque base64url-encoded JSON `{ updatedAt: string, id: string }` validated by Zod. Invalid cursors return `400 Bad Request` (`code: "VALIDATION_ERROR"`).
- Response envelope: `{ items: T[], nextCursor: string | null }`.

### Payload & Byte Limits
- Global Fastify JSON body limit: `524,288` bytes (512 KiB).
- Per-artifact serialized `content` byte limit (`Buffer.byteLength(JSON.stringify(content), 'utf8')`):
  - `design_reference`: max `262,144` bytes (256 KiB), `markdown` field max `200,000` chars.
  - `rebuild_prompt`: max `131,072` bytes (128 KiB), `prompt` field max `100,000` chars.
  - `design_token_export`: max `262,144` bytes (256 KiB), bounded token collections.
  - `asset_manifest`: max `262,144` bytes (256 KiB), max `500` asset metadata entries (URLs/dimensions/MIME types only; binary data and `data:` URLs are rejected).

---

## 5. Endpoint Contracts (`/v1`)

### Standard Error Response
All non-2xx responses return:
```json
{
  "error": {
    "code": "MACHINE_READABLE_CODE",
    "message": "Safe human-readable summary",
    "requestId": "req-uuid",
    "details": []
  }
}
```

### Operational Endpoints
- `GET /v1/health/live` -> `200 OK` `{ "status": "ok", "timestamp": "..." }`
- `GET /v1/health/ready` -> `200 OK` `{ "status": "ready", "database": "up", "latencyMs": 1, "timestamp": "..." }` or `503 Service Unavailable` (`code: "DEPENDENCY_UNAVAILABLE"`) if PostgreSQL check fails or exceeds timeout (`READINESS_TIMEOUT_MS`).
- `GET /v1/openapi.json` -> `200 OK` OpenAPI 3.1.0 JSON document.

### Authentication & Account Endpoints
- `POST /v1/auth/oauth/google/start`
  - Body: `{ "redirectUri": "https://<ext-id>.chromiumapp.org/oauth2", "codeChallenge": "<base64url-s256>", "codeChallengeMethod": "S256" }`
  - Validates `redirectUri` against `ALLOWED_REDIRECT_URIS`.
  - Response: `200 OK` `{ "authorizationUrl": "https://...", "state": "...", "expiresAt": "..." }`
- `GET /v1/auth/oauth/google/callback?code=...&state=...`
  - Exchanges provider `code` via Arctic `OAuth2Client`, verifies OIDC ID token via `jose` against remote JWKS, upserts `accounts` and default `account_settings` in a transaction, generates a 60-second single-use PKCE-locked `handoff_code`, and returns `302 Found` to `<client_redirect_uri>?handoff_code=<code >&state=<state>`.
- `POST /v1/auth/token/exchange`
  - Body: `{ "handoffCode": "...", "state": "...", "codeVerifier": "..." }`
  - Atomically consumes the handoff code, verifies `BASE64URL(SHA256(codeVerifier)) === client_code_challenge`, creates a session row, and returns `200 OK`:
    `{ "accessToken": "...", "accessTokenExpiresAt": "...", "refreshToken": "...", "refreshTokenExpiresAt": "...", "account": { ... } }`
- `POST /v1/auth/token/refresh`
  - Body: `{ "refreshToken": "..." }`
  - Rotates the refresh token in a transaction and returns `200 OK` with new tokens.
- `POST /v1/auth/signout` (Authenticated)
  - Body: `{ "allSessions"?: boolean }`
  - Revokes current session (or all account sessions) and returns `204 No Content`.
- `GET /v1/account` (Authenticated)
  - Returns `200 OK` `{ "account": { "id", "email", "displayName", "avatarUrl", "provider", "createdAt", "updatedAt" } }`.
- `DELETE /v1/account` (Authenticated)
  - Deletes the authenticated account and cascades deletion across sessions, settings, projects, artifacts, and artifact bodies in a transaction. Returns `204 No Content`.

### Account Settings Endpoints
- `GET /v1/account/settings` (Authenticated)
  - Returns `200 OK` `{ "settings": { "defaultExportFormat", "colorFormat", "spacingUnit", "includeResponsiveBreakpoints", "redactQueryParamsInUrls", "defaultPromptTarget", "updatedAt" } }`.
- `PUT /v1/account/settings` (Authenticated)
  - Strict validation of allowed keys and enum/boolean values; rejects unknown keys.
  - Returns `200 OK` `{ "settings": { ... } }`.

### Projects Endpoints
- `POST /v1/projects` (Authenticated) -> `201 Created` `{ "project": { ... } }`
- `GET /v1/projects` (Authenticated, query: `limit`, `cursor`) -> `200 OK` `{ "items": [...], "nextCursor": ... }`
- `GET /v1/projects/:projectId` (Authenticated) -> `200 OK` `{ "project": { ... } }`
- `PATCH /v1/projects/:projectId` (Authenticated, body requires `expectedVersion`) -> `200 OK` `{ "project": { ... } }`
- `DELETE /v1/projects/:projectId` (Authenticated) -> `204 No Content`

### Saved Artifacts Endpoints
- `POST /v1/projects/:projectId/artifacts` (Authenticated)
  - Validates project ownership, versioned artifact schema (`kind`, `schemaVersion: 1`, `title`, `sourceUrl`, `content`), and byte limits.
  - Inserts metadata into `artifacts` and payload into `artifact_bodies` within a transaction.
  - Returns `201 Created` `{ "artifact": { ...metadata, "content": { ... } } }`.
- `GET /v1/projects/:projectId/artifacts` (Authenticated, query: `limit`, `cursor`, `kind`?)
  - Queries only `artifacts` metadata table (never joins or loads `artifact_bodies`).
  - Returns `200 OK` `{ "items": [ ...metadataWithoutContent ], "nextCursor": ... }`.
- `GET /v1/projects/:projectId/artifacts/:artifactId` (Authenticated)
  - Joins `artifacts` and `artifact_bodies` for the owned project and artifact.
  - Returns `200 OK` `{ "artifact": { ...metadata, "content": { ... } } }`.
- `PUT /v1/projects/:projectId/artifacts/:artifactId` (Authenticated, body requires `expectedVersion`)
  - Validates ownership, optimistic concurrency (`expectedVersion`), versioned schema, and byte limits; updates `artifacts` and `artifact_bodies` in a transaction.
  - Returns `200 OK` `{ "artifact": { ...metadata, "content": { ... } } }`.
- `DELETE /v1/projects/:projectId/artifacts/:artifactId` (Authenticated)
  - Enforces ownership and deletes the artifact (cascading to `artifact_bodies`).
  - Returns `204 No Content`.

---

## 6. Acceptance Criteria

1. Zero comments in all authored source, migration, test, and configuration files.
2. Fresh database migrations apply cleanly and re-applying them is a safe no-op.
3. All authentication, ownership, cross-account isolation, concurrency conflict, validation, byte-limit, rate-limit, readiness failure, and deletion cascade behaviors are verified by automated integration tests against a real isolated PostgreSQL instance.
4. OpenAPI specification at `/v1/openapi.json` matches actual implemented route responses.
5. Reproducible load test executed against seeded PostgreSQL data with p50/p95/p99 latency and throughput reported against pre-declared targets.
