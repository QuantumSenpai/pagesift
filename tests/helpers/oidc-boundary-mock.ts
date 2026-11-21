import { createHash } from 'node:crypto';
import * as http from 'node:http';
import * as jose from 'jose';

export interface MockIdentityClaimSet {
  sub: string;
  email: string;
  name: string;
  picture?: string | null;
}

export interface MockOidcBoundaryServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  issueAuthorizationCode: (params: {
    codeChallenge: string;
    claims: MockIdentityClaimSet;
  }) => string;
  close: () => Promise<void>;
}

function computeS256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

export async function startMockOidcBoundaryServer(
  expectedClientId: string,
): Promise<MockOidcBoundaryServer> {
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
  const publicJwk = await jose.exportJWK(publicKey);
  publicJwk.kid = 'mock-google-key-1';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  const pendingCodes = new Map<string, { codeChallenge: string; claims: MockIdentityClaimSet }>();
  let codeCounter = 0;
  let baseUrl = '';

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', baseUrl || 'http://127.0.0.1');

    if (req.method === 'GET' && reqUrl.pathname === '/oauth2/v3/certs') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/token') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        void (async () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          const params = new URLSearchParams(bodyText);
          const grantType = params.get('grant_type');
          const code = params.get('code');
          const codeVerifier = params.get('code_verifier');

          if (grantType !== 'authorization_code' || !code || !codeVerifier) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'invalid_request',
                error_description: 'Missing grant_type, code, or code_verifier',
              }),
            );
            return;
          }

          const record = pendingCodes.get(code);
          pendingCodes.delete(code);

          if (!record || computeS256Challenge(codeVerifier) !== record.codeChallenge) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'invalid_grant',
                error_description: 'Invalid authorization code or PKCE verifier',
              }),
            );
            return;
          }

          const nowSeconds = Math.floor(Date.now() / 1000);
          const idToken = await new jose.SignJWT({
            email: record.claims.email,
            email_verified: true,
            name: record.claims.name,
            ...(record.claims.picture ? { picture: record.claims.picture } : {}),
          })
            .setProtectedHeader({ alg: 'RS256', kid: 'mock-google-key-1', typ: 'JWT' })
            .setIssuer(baseUrl)
            .setSubject(record.claims.sub)
            .setAudience(expectedClientId)
            .setIssuedAt(nowSeconds)
            .setExpirationTime(nowSeconds + 600)
            .sign(privateKey);

          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: `provider-access-${code}`,
              token_type: 'Bearer',
              expires_in: 3600,
              id_token: idToken,
            }),
          );
        })();
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      } else {
        reject(new Error('Failed to bind mock OIDC boundary server'));
      }
    });
    server.on('error', reject);
  });

  return {
    issuer: baseUrl,
    authorizationEndpoint: `${baseUrl}/oauth2/v2/auth`,
    tokenEndpoint: `${baseUrl}/token`,
    jwksUri: `${baseUrl}/oauth2/v3/certs`,
    issueAuthorizationCode: ({ codeChallenge, claims }) => {
      codeCounter += 1;
      const code = `mock-auth-code-${codeCounter}-${Date.now()}`;
      pendingCodes.set(code, { codeChallenge, claims });
      return code;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
