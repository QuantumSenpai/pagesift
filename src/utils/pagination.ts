import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import { validateWithZod } from './validation.js';

const cursorPayloadSchema = z.strictObject({
  updatedAt: z.iso.datetime(),
  id: z.uuid(),
});

export type CursorPayload = z.infer<typeof cursorPayloadSchema>;

export const paginationQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().trim().min(1).max(512).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export function encodeCursor(payload: { updatedAt: Date | string; id: string }): string {
  const isoTimestamp =
    payload.updatedAt instanceof Date ? payload.updatedAt.toISOString() : payload.updatedAt;
  const serialized = JSON.stringify({
    updatedAt: isoTimestamp,
    id: payload.id,
  });
  return Buffer.from(serialized, 'utf8').toString('base64url');
}

export function decodeCursor(rawCursor: string): { updatedAt: Date; id: string } {
  let decodedJson: unknown;
  try {
    const text = Buffer.from(rawCursor, 'base64url').toString('utf8');
    decodedJson = JSON.parse(text) as unknown;
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid pagination cursor', [
      { field: 'cursor', issue: 'Cursor must be a valid base64url encoded pagination token' },
    ]);
  }

  const validated = validateWithZod(cursorPayloadSchema, decodedJson, 'Invalid pagination cursor');
  const parsedDate = new Date(validated.updatedAt);
  if (Number.isNaN(parsedDate.getTime())) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid pagination cursor timestamp', [
      { field: 'cursor', issue: 'Cursor timestamp is invalid' },
    ]);
  }

  return {
    updatedAt: parsedDate,
    id: validated.id,
  };
}
