# PageSift Backend Documentation Sources (Context7 & Official References)

## Context7 Availability and Workflow Disclosure

- **MCP Tool Status**: Initially at session start, the Context7 MCP plugin (`antigravity-plugins-partners/plugin/context7`) was not installed, so library IDs and versioned documentation snippets were queried via the Context7 HTTP API (`https://context7.com/api/v1/search` and `https://context7.com/api/v1/<owner>/<repo>`). Following installation of the Context7 plugin during the session, the native Context7 MCP server tools (`context7_context7`: `resolve-library-id` and `query-docs`) were also executed to verify `/fastify/fastify`, `/kysely-org/kysely`, and `/panva/openid-client` signatures and patterns.
- **Cross-Verification**: All retrieved documentation was cross-checked against npm registry package metadata, TypeScript type definitions, and executable integration tests.
- **Query Hygiene**: Only public package names and API topic keywords were queried; no credentials, private source code, or user data were transmitted.

---

## Resolved Libraries and Versions

### 1. Fastify (`fastify`)
- **Context7 Library ID**: `/fastify/fastify`
- **Selected Version**: `5.12.8`
- **Documentation Topics Consulted**:
  - Custom error handling (`setErrorHandler`, `validation`, `validationContext`, status code propagation).
  - Request ID generation and structured Pino logger redaction (`requestIdHeader`, `genReqId`, `logger.redact`).
  - Body size limits (`bodyLimit`) and graceful shutdown (`fastify.close()`).
- **Supporting Links**:
  - https://github.com/fastify/fastify/blob/main/docs/Reference/Validation-and-Serialization.md
  - https://github.com/fastify/fastify/blob/main/docs/Reference/Server.md
  - https://github.com/fastify/fastify/blob/main/docs/Reference/Logging.md

### 2. Fastify CORS (`@fastify/cors`)
- **Context7 Library ID**: `/fastify/fastify-cors`
- **Selected Version**: `11.4.3`
- **Documentation Topics Consulted**:
  - Dynamic origin callback validation against an explicit allowlist (`chrome-extension://<id>` and configured local development origins).
  - Strict prohibition of wildcard origins with credentialed headers and `Vary: Origin` behavior.
- **Supporting Links**:
  - https://github.com/fastify/fastify-cors/blob/main/README.md
  - https://github.com/fastify/fastify-cors/blob/main/_autodocs/api-reference/vary.md

### 3. Fastify Helmet (`@fastify/helmet`)
- **Context7 Library ID**: `/fastify/fastify-helmet`
- **Selected Version**: `13.2.0`
- **Documentation Topics Consulted**:
  - Registering strict security headers (`contentSecurityPolicy` with `default-src 'none'`, `frame-ancestors 'none'`, `xContentTypeOptions`, `referrerPolicy`, `hsts`).
- **Supporting Links**:
  - https://github.com/fastify/fastify-helmet/blob/main/README.md
  - https://github.com/fastify/fastify-helmet/blob/main/_autodocs/api-reference/plugin.md

### 4. Fastify Rate Limit (`@fastify/rate-limit`)
- **Context7 Library ID**: `/fastify/fastify-rate-limit`
- **Selected Version**: `11.3.0`
- **Documentation Topics Consulted**:
  - Global vs. route-scoped rate limits (`config.rateLimit: { max, timeWindow }`), custom `keyGenerator`, and 429 error response formatting.
  - Documented single-instance in-memory store behavior.
- **Supporting Links**:
  - https://github.com/fastify/fastify-rate-limit/blob/main/_autodocs/configuration.md
  - https://github.com/fastify/fastify-rate-limit/blob/main/_autodocs/api-reference/rate-limit-hook.md

### 5. Fastify Swagger (`@fastify/swagger`)
- **Context7 Library ID**: `/fastify/fastify-swagger`
- **Selected Version**: `9.9.5`
- **Documentation Topics Consulted**:
  - Generating OpenAPI 3.1.0 specifications (`openapi: { openapi: '3.1.0', ... }`) from route schemas and serving `/v1/openapi.json`.
- **Supporting Links**:
  - https://github.com/fastify/fastify-swagger/blob/main/README.md
  - https://github.com/fastify/fastify-swagger/blob/main/_autodocs/api-reference/openapi-v3-generator.md

### 6. Kysely (`kysely`)
- **Context7 Library ID**: `/kysely-org/kysely`
- **Selected Version**: `0.29.9`
- **Documentation Topics Consulted**:
  - `PostgresDialect` configuration with `pg.Pool`.
  - Programmatic migrations via `Migrator` and `FileMigrationProvider` (`migrateToLatest`, database-level migration lock, idempotent re-application, comment-free TypeScript migration modules).
  - Transactions via `db.transaction().execute(...)` and parameterized SQL queries.
- **Supporting Links**:
  - https://github.com/kysely-org/kysely
  - https://kysely.dev/docs/migrations

### 7. node-postgres (`pg`)
- **Context7 Library ID**: `/brianc/node-postgres`
- **Selected Version**: `8.23.1`
- **Documentation Topics Consulted**:
  - `Pool` configuration (`max`, `connectionTimeoutMillis`, `idleTimeoutMillis`, `statement_timeout`, `query_timeout`) and deterministic shutdown via `pool.end()`.
- **Supporting Links**:
  - https://github.com/brianc/node-postgres/blob/master/packages/pg-pool/README.md
  - https://node-postgres.com/apis/pool

### 8. OpenID Client (`openid-client`)
- **Context7 Library ID**: `/panva/openid-client`
- **Selected Version**: `6.9.1` (selected over `arctic@3.7.0` after `npm install` flagged `arctic` and `@oslojs/*` as deprecated on npm)
- **Documentation Topics Consulted**:
  - OAuth 2.0 / OIDC Authorization Code flow with PKCE (`Configuration`, `randomState`, `randomPKCECodeVerifier`, `calculatePKCECodeChallenge`, `buildAuthorizationUrl`, `authorizationCodeGrant`, `allowInsecureRequests`).
- **Supporting Links**:
  - https://github.com/panva/openid-client/blob/main/docs/functions/buildAuthorizationUrl.md
  - https://github.com/panva/openid-client/blob/main/docs/functions/randomPKCECodeVerifier.md
  - https://github.com/panva/openid-client/blob/main/docs/functions/calculatePKCECodeChallenge.md
  - https://github.com/panva/openid-client/blob/main/docs/functions/allowInsecureRequests.md

### 9. JOSE (`jose`)
- **Context7 Library ID**: `/panva/jose`
- **Selected Version**: `6.2.18`
- **Documentation Topics Consulted**:
  - Verifying OIDC ID tokens against remote JWKS endpoints via `createRemoteJWKSet` and `jwtVerify` (checking `issuer`, `audience`, ` algorithms: ['RS256']`).
  - Signing and verifying short-lived access tokens (`SignJWT`, `jwtVerify` with `HS256` and explicit key length validation).
- **Supporting Links**:
  - https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md
  - https://github.com/panva/jose/blob/main/docs/jwt/sign/classes/SignJWT.md

### 10. Zod (`zod`)
- **Context7 Library ID**: `/colinhacks/zod`
- **Selected Version**: `4.6.7` (verified compatible API with `z.strictObject`, `z.object`, `.safeParse`, `z.infer`)
- **Documentation Topics Consulted**:
  - Strict unknown-key rejection (`z.strictObject`), discriminated unions, string length and byte validation, environment variable parsing.
- **Supporting Links**:
  - https://github.com/colinhacks/zod/blob/main/packages/docs/content/api.mdx
  - https://github.com/colinhacks/zod/blob/main/packages/docs/content/basics.mdx

### 11. Vitest (`vitest`)
- **Context7 Library ID**: `/vitest-dev/vitest`
- **Selected Version**: `5.1.1`
- **Documentation Topics Consulted**:
  - Lifecycle hooks (`beforeAll`, `afterAll`, `beforeEach`) and isolated PostgreSQL database integration test execution.
- **Supporting Links**:
  - https://github.com/vitest-dev/vitest/blob/main/docs/guide/learn/setup-teardown.md
  - https://github.com/vitest-dev/vitest/blob/main/docs/api/hooks.md

### 12. Neon PostgreSQL Official Documentation (`Neon` MCP `search_docs` / `get_doc`)
- **Documentation Topics Consulted**:
  - Connection pooling (`docs/connect/connection-pooling`): PgBouncer transaction pooling (`-pooler` hostname for `DATABASE_URL`) vs. direct connections (`DATABASE_URL_UNPOOLED`) for schema migrations, `pg_dump`/`pg_restore`, and session-level operations.
  - Preserving Neon-generated TLS/SSL query parameters (`sslmode=require`) with `node-postgres` (`pg@8.23.1`) without disabling certificate verification.
- **Supporting Links**:
  - https://neon.com/docs/connect/connection-pooling
  - https://neon.com/docs/connect/choose-connection
