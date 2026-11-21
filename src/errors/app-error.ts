export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RESOURCE_NOT_FOUND'
  | 'CONFLICT'
  | 'VERSION_CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'OAUTH_ERROR'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface ErrorDetail {
  field?: string;
  issue: string;
}

export interface PublicErrorPayload {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details: ErrorDetail[];
  };
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details: ErrorDetail[];

  public constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details: ErrorDetail[] = [],
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function formatPublicError(
  code: ErrorCode,
  message: string,
  requestId: string,
  details: ErrorDetail[] = [],
): PublicErrorPayload {
  return {
    error: {
      code,
      message,
      requestId,
      details,
    },
  };
}
