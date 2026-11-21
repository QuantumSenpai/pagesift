import type { z } from 'zod';
import { AppError, type ErrorDetail } from '../errors/app-error.js';

export function validateWithZod<T>(
  schema: z.ZodType<T>,
  data: unknown,
  message = 'Request validation failed',
): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const details: ErrorDetail[] = parsed.error.issues.map((issue) => {
      const pathString = issue.path.map((segment) => String(segment)).join('.');
      return pathString.length > 0
        ? { field: pathString, issue: issue.message }
        : { issue: issue.message };
    });
    throw new AppError(400, 'VALIDATION_ERROR', message, details);
  }
  return parsed.data;
}
