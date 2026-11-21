# PageSift Backend Operations, Environment Reference, and Deployment Guide

## 1. Environment Variable Reference

The server validates all environment variables at startup in `src/config/env.ts` using Zod and exits immediately with a descriptive error if any variable is missing or invalid. Copy `.env.example` to `.env` for local development.

| Variable | Required | Default | Constraints & Description |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | No | `development` | One of `development`, `test`, `production`. |
| `HOST` | No | `127.0.0.1` | Bind address (`127.0.0.1` for local dev; `0.0.0.0` inside containers). |
| `PORT` | No | `3000` | TCP listen port (`0`–`65535`). |
| `LOG_LEVEL` | No | `info` | Pino log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`. |
| `TRUST_PROXY` | No | `false` | `true` or `false`. Set `true` only when deployed behind a trusted reverse proxy / load balancer that overwrites `X-Forwarded-For`. |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection URL (`postgresql://user:pass@host:5432/dbname`). |
| `DB_POOL_MAX` | No | `20` | Maximum PostgreSQL connections in `pg.Pool` (`1`–`100`). |
| `DB_CONNECTION_TIMEOUT_MS` | No | `5000` | Pool connection acquisition timeout in milliseconds (`100`–`60000`). |
| `DB_IDLE_TIMEOUT_MS` | No | `30000` | Idle client timeout in milliseconds (`500`–`300000`). |
| `DB_STATEMENT_TIMEOUT_MS` | No | `10000` | Per-query `statement_timeout` and `query_timeout` in milliseconds (`100`–`120000`). |
| `READINESS_TIMEOUT_MS` | No | `2000` | Maximum duration in milliseconds for `/v1/health/ready` database check (`50`–`30000`). |
| `CORS_ALLOWED_ORIGINS` | **Yes** | — | Comma-separated explicit origins (`chrome-extension://<id>,http://localhost:5173`). Wildcard `*` is rejected. |
| `ALLOWED_REDIRECT_URIS` | **Yes** | — | Comma-separated explicit OAuth redirect URIs (`https://<id>.chromiumapp.org/oauth2`). Non-loopback HTTP, wildcards, and fragments are rejected. |
| `JWT_ACCESS_SECRET` | **Yes** | — | High-entropy secret for HS256 access tokens; must be at least 32 UTF-8 bytes. |
| `ACCESS_TOKEN_TTL_SECONDS` | No | `900` | Access token lifetime in seconds (`60`–`3600`). |
| `REFRESH_TOKEN_TTL_SECONDS` | No | `2592000` | Refresh token lifetime in seconds (`300`–`7776000`, default 30 days). |
| `OAUTH_STATE_TTL_SECONDS` | No | `600` | Pending OAuth state lifetime in seconds (`60`–`1800`). |
| `OAUTH_HANDOFF_TTL_SECONDS` | No | `60` | Single-use PKCE handoff code lifetime in seconds (`15`–`300`). |
| `GOOGLE_CLIENT_ID` | **Yes** | — | Google OAuth 2.0 Client ID. |
| `GOOGLE_CLIENT_SECRET` | **Yes** | — | Google OAuth 2.0 Client Secret. |
| `GOOGLE_CALLBACK_URL` | **Yes** | — | Public URL mapped to `GET /v1/auth/oauth/google/callback`. |
| `OIDC_ISSUER` | No | `https://accounts.google.com` | Expected `iss` claim in OIDC ID tokens. |
| `OIDC_AUTHORIZATION_ENDPOINT` | No | `https://accounts.google.com/o/oauth2/v2/auth` | OIDC authorization endpoint URL. |
| `OIDC_TOKEN_ENDPOINT` | No | `https://oauth2.googleapis.com/token` | OIDC token exchange endpoint URL. |
| `OIDC_JWKS_URI` | No | `https://www.googleapis.com/oauth2/v3/certs` | OIDC JSON Web Key Set URL for RS256 ID token verification. |
| `RATE_LIMIT_GLOBAL_MAX` | No | `300` | Global per-IP request cap per window (`1`–`100000`). |
| `RATE_LIMIT_GLOBAL_WINDOW_MS` | No | `60000` | Global rate-limit window in milliseconds (`200`–`3600000`). |
| `RATE_LIMIT_AUTH_MAX` | No | `20` | Auth route per-IP request cap per window (`1`–`10000`). |
| `RATE_LIMIT_AUTH_WINDOW_MS` | No | `60000` | Auth route rate-limit window in milliseconds (`200`–`3600000`). |
| `RATE_LIMIT_WRITE_MAX` | No | `60` | Mutation route per-IP request cap per window (`1`–`10000`). |
| `RATE_LIMIT_WRITE_WINDOW_MS` | No | `60000` | Mutation route rate-limit window in milliseconds (`200`–`3600000`). |

---

## 2. Reproducible Local Development Setup

### Option A: Native Node.js + Local PostgreSQL 17
1. Install dependencies from the committed lockfile:
   ```bash
   npm ci
   ```
2. Copy `.env.example` to `.env` and adjust `DATABASE_URL` to point to a local development database:
   ```bash
   cp .env.example .env
   ```
3. Run database migrations:
   ```bash
   npm run migrate
   ```
4. Start the development server with hot reload (`tsx watch`):
   ```bash
   npm run dev
   ```
5. Or build and run the production bundle:
   ```bash
   npm run build
   npm start
   ```

> **Note on Automated Tests**: `npm test`, `npm run smoke`, and `npm run loadtest` do **not** require a pre-running PostgreSQL server if PostgreSQL binaries (`initdb`, `pg_ctl`) are installed locally; they automatically initialize an isolated disposable PostgreSQL cluster in `os.tmpdir()` and clean it up upon completion. If `TEST_ADMIN_DATABASE_URL` is set, they create and drop isolated disposable databases (`pagesift_test_<id>`) on that instance.

### Option B: Containerized Setup (`Dockerfile` & `docker-compose.yml`)
1. Start PostgreSQL 17 and the PageSift backend container:
   ```bash
   docker compose up --build
   ```
2. The production image (`Dockerfile`) compiles TypeScript in a build stage, prunes development dependencies, and runs `node dist/server.js` as the unprivileged `node` user (`USER node`) on `node:22-alpine`.

---

## 3. Database Migrations

Migrations are managed by Kysely (`src/db/migrator.ts` and `src/db/migrations/001_initial_schema.ts`).

- **Apply pending migrations**:
  ```bash
  npm run migrate
  ```
- **On Server Startup**: `src/server.ts` executes `runMigrationsToLatest(dbContext.db)` before binding the HTTP listener. Kysely acquires a database-level migration lock so concurrent migration attempts execute serially, and re-running migrations when already up to date is a safe no-op.

---

## 4. Backup and Restore Procedures

### Creating a Consistent Backup
Use `pg_dump` in custom compressed format (`-Fc`), which captures schema, data, indexes, and constraints consistently inside a repeatable-read snapshot:
```bash
pg_dump --format=custom --no-owner --no-privileges \
  --file="pagesift_backup_$(date -u +%Y%m%dT%H%M%SZ).dump" \
  "$DATABASE_URL"
```

### Restoring from a Backup into a Target Database
1. Verify the target `RESTORE_DATABASE_URL` points to the intended recovery database.
2. Restore with `pg_restore`:
   ```bash
   pg_restore --clean --if-exists --no-owner --no-privileges \
     --dbname="$RESTORE_DATABASE_URL" \
     pagesift_backup_YYYYMMDDTHHMMSSZ.dump
   ```
3. Run `DATABASE_URL="$RESTORE_DATABASE_URL" npm run migrate` to ensure any newer forward migrations are applied, and verify health via `GET /v1/health/ready`.

---

## 5. Deployment and Single-Instance Operational Notes

1. **Rate Limiting Scope**:
   - `@fastify/rate-limit` is configured with its in-memory store for a single-instance deployment. Rate limits (`RATE_LIMIT_GLOBAL_MAX`, `RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_WRITE_MAX`) are enforced per Node.js process instance, not globally synchronized across multiple horizontal replicas.
2. **Proxy Trust (`TRUST_PROXY`)**:
   - Leave `TRUST_PROXY=false` when the Node.js server is directly exposed or when proxy headers are not stripped by an upstream load balancer.
   - Set `TRUST_PROXY=true` only behind a reverse proxy (e.g., Envoy, ALB, Nginx, Cloudflare) that overwrites `X-Forwarded-For` so rate limiting uses the real client IP rather than a spoofable header.
3. **Health Checks and Graceful Shutdown**:
   - Configure container orchestrator liveness probes against `GET /v1/health/live` (`200 OK`).
   - Configure readiness probes against `GET /v1/health/ready` (`200 OK` when PostgreSQL responds within `READINESS_TIMEOUT_MS`, `503 Service Unavailable` otherwise).
   - On `SIGTERM` or `SIGINT`, `src/server.ts` stops accepting new connections, drains active requests, closes the PostgreSQL connection pool via Fastify's `onClose` hook, and exits with code `0` (with a 10-second hard timeout guard).

---

## 6. Rollback Strategy and Schema Compatibility

1. **Application Rollback**:
   - Because database schema changes can outlive an application container rollback, all future migrations after `001_initial_schema` must follow the **Expand-and-Contract** pattern:
     - **Expand phase**: Add nullable columns, new tables, or new indexes without dropping or renaming columns read by the currently deployed application version.
     - **Application deploy**: Deploy the new application version that writes to and reads from the expanded schema. If a rollback is needed during this window, the previous container image remains compatible with the expanded schema without running a destructive down-migration.
     - **Contract phase**: Only remove obsolete columns or constraints in a subsequent release after the new application version is stable.
2. **Destructive Down-Migration Avoidance**:
   - While `001_initial_schema.ts` defines a `down(db)` function for completeness, production rollbacks should roll back the application container image first or restore from a point-in-time backup (`pg_restore`) rather than executing table drops on live user data.
