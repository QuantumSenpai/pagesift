import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as jose from 'jose';
import type { Kysely } from 'kysely';
import * as openidClient from 'openid-client';
import type { AppConfig } from '../config/env.js';
import type { DatabaseSchema } from '../db/types.js';
import { AppError } from '../errors/app-error.js';

export interface AccountDto {
  id: string;
  provider: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthTokenResult {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  account: AccountDto;
}

export interface VerifiedSessionContext {
  accountId: string;
  sessionId: string;
  account: AccountDto;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function safeEqualStrings(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left, 'utf8');
  const rightBuf = Buffer.from(right, 'utf8');
  if (leftBuf.length !== rightBuf.length) {
    return false;
  }
  return timingSafeEqual(leftBuf, rightBuf);
}

function generateHighEntropyToken(): string {
  return randomBytes(32).toString('base64url');
}

function toIsoString(val: Date | string): string {
  return val instanceof Date ? val.toISOString() : new Date(val).toISOString();
}

export function mapAccountRowToDto(row: {
  id: string;
  provider: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): AccountDto {
  return {
    id: row.id,
    provider: row.provider,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export class AuthService {
  private readonly db: Kysely<DatabaseSchema>;
  private readonly config: AppConfig;
  private readonly accessSecretKey: Uint8Array;
  private readonly oidcConfig: openidClient.Configuration;
  private readonly remoteJwks: ReturnType<typeof jose.createRemoteJWKSet>;

  public constructor(db: Kysely<DatabaseSchema>, config: AppConfig) {
    this.db = db;
    this.config = config;
    this.accessSecretKey = new TextEncoder().encode(config.JWT_ACCESS_SECRET);

    const serverMetadata: openidClient.ServerMetadata = {
      issuer: config.OIDC_ISSUER,
      authorization_endpoint: config.OIDC_AUTHORIZATION_ENDPOINT,
      token_endpoint: config.OIDC_TOKEN_ENDPOINT,
      jwks_uri: config.OIDC_JWKS_URI,
    };

    this.oidcConfig = new openidClient.Configuration(
      serverMetadata,
      config.GOOGLE_CLIENT_ID,
      config.GOOGLE_CLIENT_SECRET,
    );

    if (
      config.OIDC_TOKEN_ENDPOINT.startsWith('http://127.0.0.1') ||
      config.OIDC_TOKEN_ENDPOINT.startsWith('http://localhost')
    ) {
      openidClient.allowInsecureRequests(this.oidcConfig);
    }

    this.remoteJwks = jose.createRemoteJWKSet(new URL(config.OIDC_JWKS_URI));
  }

  public async startGoogleOAuth(params: {
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: 'S256';
  }): Promise<{
    authorizationUrl: string;
    state: string;
    expiresAt: string;
  }> {
    if (!this.config.ALLOWED_REDIRECT_URIS.includes(params.redirectUri)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Redirect URI is not allowed', [
        {
          field: 'redirectUri',
          issue: 'Redirect URI must match a configured allowed redirect destination',
        },
      ]);
    }

    const state = openidClient.randomState();
    const providerCodeVerifier = openidClient.randomPKCECodeVerifier();
    const providerCodeChallenge =
      await openidClient.calculatePKCECodeChallenge(providerCodeVerifier);

    const authorizationUrl = openidClient.buildAuthorizationUrl(this.oidcConfig, {
      redirect_uri: this.config.GOOGLE_CALLBACK_URL,
      scope: 'openid email profile',
      state,
      code_challenge: providerCodeChallenge,
      code_challenge_method: 'S256',
    });

    const expiresAt = new Date(Date.now() + this.config.OAUTH_STATE_TTL_SECONDS * 1000);

    await this.db
      .insertInto('oauth_transactions')
      .values({
        id: randomUUID(),
        state,
        provider_code_verifier: providerCodeVerifier,
        client_redirect_uri: params.redirectUri,
        client_code_challenge: params.codeChallenge,
        handoff_code_hash: null,
        account_id: null,
        expires_at: expiresAt,
        handoff_expires_at: null,
        consumed_at: null,
      })
      .execute();

    return {
      authorizationUrl: authorizationUrl.toString(),
      state,
      expiresAt: expiresAt.toISOString(),
    };
  }

  public async handleGoogleOAuthCallback(params: {
    code?: string;
    state?: string;
    error?: string;
    errorDescription?: string;
  }): Promise<{ redirectTo: string }> {
    const now = new Date();

    if (params.error !== undefined) {
      if (params.state !== undefined) {
        await this.db
          .updateTable('oauth_transactions')
          .set({ consumed_at: now })
          .where('state', '=', params.state)
          .where('consumed_at', 'is', null)
          .execute();
      }
      throw new AppError(
        400,
        'OAUTH_ERROR',
        `Identity provider returned error: ${params.error}`,
        params.errorDescription
          ? [{ field: 'error_description', issue: params.errorDescription }]
          : [],
      );
    }

    if (!params.code || !params.state) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'Missing required code or state parameter in OAuth callback',
      );
    }

    const txRow = await this.db
      .selectFrom('oauth_transactions')
      .selectAll()
      .where('state', '=', params.state)
      .executeTakeFirst();

    if (
      !txRow ||
      txRow.consumed_at !== null ||
      txRow.handoff_code_hash !== null ||
      new Date(txRow.expires_at).getTime() <= now.getTime()
    ) {
      throw new AppError(400, 'OAUTH_ERROR', 'Invalid or expired OAuth state parameter');
    }

    const callbackUrl = new URL(this.config.GOOGLE_CALLBACK_URL);
    callbackUrl.searchParams.set('code', params.code);
    callbackUrl.searchParams.set('state', params.state);

    let idToken: string | undefined;
    try {
      const tokenResponse = await openidClient.authorizationCodeGrant(
        this.oidcConfig,
        callbackUrl,
        {
          pkceCodeVerifier: txRow.provider_code_verifier,
          expectedState: params.state,
          idTokenExpected: true,
        },
      );
      idToken = tokenResponse.id_token;
    } catch {
      throw new AppError(
        401,
        'OAUTH_ERROR',
        'Failed to exchange authorization code with identity provider',
      );
    }

    if (!idToken) {
      throw new AppError(401, 'OAUTH_ERROR', 'Identity provider did not return an ID token');
    }

    let verifiedPayload: jose.JWTPayload;
    try {
      const verified = await jose.jwtVerify(idToken, this.remoteJwks, {
        issuer: this.config.OIDC_ISSUER,
        audience: this.config.GOOGLE_CLIENT_ID,
        algorithms: ['RS256'],
      });
      verifiedPayload = verified.payload;
    } catch {
      throw new AppError(401, 'OAUTH_ERROR', 'Failed to verify identity provider ID token');
    }

    const providerSubject = verifiedPayload.sub;
    const email = typeof verifiedPayload['email'] === 'string' ? verifiedPayload['email'] : null;
    const displayName =
      typeof verifiedPayload['name'] === 'string' && verifiedPayload['name'].trim().length > 0
        ? verifiedPayload['name'].trim()
        : (email ?? 'PageSift User');
    const avatarUrl =
      typeof verifiedPayload['picture'] === 'string' ? verifiedPayload['picture'] : null;

    if (!providerSubject || !email) {
      throw new AppError(
        401,
        'OAUTH_ERROR',
        'Identity provider ID token is missing required subject or email claims',
      );
    }

    const handoffCode = generateHighEntropyToken();
    const handoffCodeHash = sha256Hex(handoffCode);
    const handoffExpiresAt = new Date(Date.now() + this.config.OAUTH_HANDOFF_TTL_SECONDS * 1000);

    await this.db.transaction().execute(async (trx) => {
      const existingAccount = await trx
        .selectFrom('accounts')
        .selectAll()
        .where('provider', '=', 'google')
        .where('provider_subject', '=', providerSubject)
        .executeTakeFirst();

      let accountId: string;

      if (existingAccount) {
        accountId = existingAccount.id;
        await trx
          .updateTable('accounts')
          .set({
            email: email.toLowerCase(),
            display_name: displayName,
            avatar_url: avatarUrl,
            updated_at: now,
          })
          .where('id', '=', accountId)
          .execute();
      } else {
        const existingByEmail = await trx
          .selectFrom('accounts')
          .selectAll()
          .where('email', '=', email.toLowerCase())
          .executeTakeFirst();

        if (existingByEmail) {
          throw new AppError(
            409,
            'CONFLICT',
            'An account with this email is already linked to a different provider subject',
          );
        }

        accountId = randomUUID();
        await trx
          .insertInto('accounts')
          .values({
            id: accountId,
            provider: 'google',
            provider_subject: providerSubject,
            email: email.toLowerCase(),
            display_name: displayName,
            avatar_url: avatarUrl,
            created_at: now,
            updated_at: now,
          })
          .execute();

        await trx
          .insertInto('account_settings')
          .values({
            account_id: accountId,
            default_export_format: 'markdown',
            color_format: 'hex',
            spacing_unit: 'px',
            include_responsive_breakpoints: true,
            redact_query_params_in_urls: true,
            default_prompt_target: 'generic',
            updated_at: now,
          })
          .execute();
      }

      const updated = await trx
        .updateTable('oauth_transactions')
        .set({
          handoff_code_hash: handoffCodeHash,
          account_id: accountId,
          handoff_expires_at: handoffExpiresAt,
        })
        .where('id', '=', txRow.id)
        .where('handoff_code_hash', 'is', null)
        .where('consumed_at', 'is', null)
        .executeTakeFirst();

      if (Number(updated.numUpdatedRows) === 0) {
        throw new AppError(400, 'OAUTH_ERROR', 'OAuth state has already been processed');
      }
    });

    const redirectDestination = new URL(txRow.client_redirect_uri);
    redirectDestination.searchParams.set('handoff_code', handoffCode);
    redirectDestination.searchParams.set('state', params.state);

    return {
      redirectTo: redirectDestination.toString(),
    };
  }

  public async exchangeHandoffCode(params: {
    handoffCode: string;
    state: string;
    codeVerifier: string;
    userAgent: string | null;
  }): Promise<AuthTokenResult> {
    const handoffCodeHash = sha256Hex(params.handoffCode);
    const computedChallenge = await openidClient.calculatePKCECodeChallenge(params.codeVerifier);
    const now = new Date();

    const { accountRow, sessionId, refreshToken, refreshTokenExpiresAt } = await this.db
      .transaction()
      .execute(async (trx) => {
        const txRow = await trx
          .selectFrom('oauth_transactions')
          .selectAll()
          .where('handoff_code_hash', '=', handoffCodeHash)
          .where('state', '=', params.state)
          .forUpdate()
          .executeTakeFirst();

        if (
          !txRow ||
          txRow.consumed_at !== null ||
          txRow.account_id === null ||
          txRow.handoff_expires_at === null ||
          new Date(txRow.handoff_expires_at).getTime() <= now.getTime()
        ) {
          throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired handoff code');
        }

        if (!safeEqualStrings(computedChallenge, txRow.client_code_challenge)) {
          throw new AppError(401, 'UNAUTHORIZED', 'PKCE code verifier validation failed');
        }

        await trx
          .updateTable('oauth_transactions')
          .set({ consumed_at: now })
          .where('id', '=', txRow.id)
          .execute();

        const account = await trx
          .selectFrom('accounts')
          .selectAll()
          .where('id', '=', txRow.account_id)
          .executeTakeFirst();

        if (!account) {
          throw new AppError(401, 'UNAUTHORIZED', 'Account no longer exists');
        }

        const newSessionId = randomUUID();
        const rawRefreshToken = generateHighEntropyToken();
        const refreshExpires = new Date(
          now.getTime() + this.config.REFRESH_TOKEN_TTL_SECONDS * 1000,
        );

        await trx
          .insertInto('sessions')
          .values({
            id: newSessionId,
            account_id: account.id,
            refresh_token_hash: sha256Hex(rawRefreshToken),
            user_agent: params.userAgent,
            expires_at: refreshExpires,
            revoked_at: null,
            created_at: now,
            last_used_at: now,
          })
          .execute();

        return {
          accountRow: account,
          sessionId: newSessionId,
          refreshToken: rawRefreshToken,
          refreshTokenExpiresAt: refreshExpires,
        };
      });

    const { accessToken, accessTokenExpiresAt } = await this.signAccessToken(
      accountRow.id,
      sessionId,
    );

    return {
      accessToken,
      accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
      account: mapAccountRowToDto(accountRow),
    };
  }

  public async refreshSession(params: {
    refreshToken: string;
    userAgent: string | null;
  }): Promise<AuthTokenResult> {
    const incomingHash = sha256Hex(params.refreshToken);
    const now = new Date();

    const { accountRow, sessionId, newRefreshToken, newRefreshExpiresAt } = await this.db
      .transaction()
      .execute(async (trx) => {
        const sessionRow = await trx
          .selectFrom('sessions')
          .selectAll()
          .where('refresh_token_hash', '=', incomingHash)
          .forUpdate()
          .executeTakeFirst();

        if (
          !sessionRow ||
          sessionRow.revoked_at !== null ||
          new Date(sessionRow.expires_at).getTime() <= now.getTime()
        ) {
          throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired refresh token');
        }

        const account = await trx
          .selectFrom('accounts')
          .selectAll()
          .where('id', '=', sessionRow.account_id)
          .executeTakeFirst();

        if (!account) {
          throw new AppError(401, 'UNAUTHORIZED', 'Account not found for session');
        }

        const rotatedRefreshToken = generateHighEntropyToken();
        const rotatedExpiresAt = new Date(
          now.getTime() + this.config.REFRESH_TOKEN_TTL_SECONDS * 1000,
        );

        await trx
          .updateTable('sessions')
          .set({
            refresh_token_hash: sha256Hex(rotatedRefreshToken),
            expires_at: rotatedExpiresAt,
            last_used_at: now,
            user_agent: params.userAgent ?? sessionRow.user_agent,
          })
          .where('id', '=', sessionRow.id)
          .execute();

        return {
          accountRow: account,
          sessionId: sessionRow.id,
          newRefreshToken: rotatedRefreshToken,
          newRefreshExpiresAt: rotatedExpiresAt,
        };
      });

    const { accessToken, accessTokenExpiresAt } = await this.signAccessToken(
      accountRow.id,
      sessionId,
    );

    return {
      accessToken,
      accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
      refreshToken: newRefreshToken,
      refreshTokenExpiresAt: newRefreshExpiresAt.toISOString(),
      account: mapAccountRowToDto(accountRow),
    };
  }

  public async verifyAccessToken(bearerToken: string): Promise<VerifiedSessionContext> {
    let payload: jose.JWTPayload;
    try {
      const verified = await jose.jwtVerify(bearerToken, this.accessSecretKey, {
        issuer: 'pagesift-backend',
        audience: 'pagesift-api',
        algorithms: ['HS256'],
      });
      payload = verified.payload;
    } catch {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired access token');
    }

    const accountId = payload.sub;
    const sessionId = typeof payload['sid'] === 'string' ? payload['sid'] : null;

    if (!accountId || !sessionId) {
      throw new AppError(401, 'UNAUTHORIZED', 'Access token is missing required session claims');
    }

    const now = new Date();
    const row = await this.db
      .selectFrom('sessions')
      .innerJoin('accounts', 'accounts.id', 'sessions.account_id')
      .select([
        'sessions.id as session_id',
        'sessions.revoked_at as session_revoked_at',
        'sessions.expires_at as session_expires_at',
        'accounts.id as id',
        'accounts.provider as provider',
        'accounts.email as email',
        'accounts.display_name as display_name',
        'accounts.avatar_url as avatar_url',
        'accounts.created_at as created_at',
        'accounts.updated_at as updated_at',
      ])
      .where('sessions.id', '=', sessionId)
      .where('sessions.account_id', '=', accountId)
      .executeTakeFirst();

    if (
      !row ||
      row.session_revoked_at !== null ||
      new Date(row.session_expires_at).getTime() <= now.getTime()
    ) {
      throw new AppError(401, 'UNAUTHORIZED', 'Session has expired or has been revoked');
    }

    return {
      accountId: row.id,
      sessionId: row.session_id,
      account: mapAccountRowToDto(row),
    };
  }

  public async signOut(params: {
    accountId: string;
    sessionId: string;
    allSessions: boolean;
  }): Promise<void> {
    const now = new Date();
    let query = this.db
      .updateTable('sessions')
      .set({ revoked_at: now })
      .where('account_id', '=', params.accountId)
      .where('revoked_at', 'is', null);

    if (!params.allSessions) {
      query = query.where('id', '=', params.sessionId);
    }

    await query.execute();
  }

  public async getAccountById(accountId: string): Promise<AccountDto> {
    const row = await this.db
      .selectFrom('accounts')
      .selectAll()
      .where('id', '=', accountId)
      .executeTakeFirst();

    if (!row) {
      throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Account not found');
    }

    return mapAccountRowToDto(row);
  }

  public async deleteAccount(accountId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const deleted = await trx
        .deleteFrom('accounts')
        .where('id', '=', accountId)
        .executeTakeFirst();

      if (Number(deleted.numDeletedRows) === 0) {
        throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Account not found');
      }
    });
  }

  private async signAccessToken(
    accountId: string,
    sessionId: string,
  ): Promise<{ accessToken: string; accessTokenExpiresAt: Date }> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expSeconds = nowSeconds + this.config.ACCESS_TOKEN_TTL_SECONDS;
    const accessTokenExpiresAt = new Date(expSeconds * 1000);

    const accessToken = await new jose.SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(accountId)
      .setIssuer('pagesift-backend')
      .setAudience('pagesift-api')
      .setIssuedAt(nowSeconds)
      .setExpirationTime(expSeconds)
      .sign(this.accessSecretKey);

    return { accessToken, accessTokenExpiresAt };
  }
}
