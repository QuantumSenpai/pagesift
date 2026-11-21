import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors/app-error.js';
import type { AuthService, VerifiedSessionContext } from '../services/auth-service.js';

declare module 'fastify' {
  interface FastifyRequest {
    authContext?: VerifiedSessionContext;
  }
}

export function createAuthPreHandler(authService: AuthService) {
  return async function authenticateRequest(request: FastifyRequest): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader || typeof authHeader !== 'string') {
      throw new AppError(401, 'UNAUTHORIZED', 'Missing Authorization header');
    }

    const parts = authHeader.trim().split(/\s+/);
    if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer' || !parts[1]) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authorization header must use Bearer token scheme');
    }

    const verified = await authService.verifyAccessToken(parts[1]);
    request.authContext = verified;
  };
}

export function getRequiredAuthContext(request: FastifyRequest): VerifiedSessionContext {
  if (!request.authContext) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication is required');
  }
  return request.authContext;
}
