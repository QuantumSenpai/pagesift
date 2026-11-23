import { z } from 'zod';
import { toolIdSchema } from '../protocol/messages.js';

export const MAX_ACTIVITY_URL_LEN = 512;
export const MAX_ACTIVITY_TITLE_LEN = 160;
export const MAX_ACTIVITY_SUMMARY_LEN = 240;
export const MAX_ACTIVITY_ERROR_LEN = 80;
export const MAX_ACTIVITY_OPTION_VAL_LEN = 80;
export const DEFAULT_ACTIVITY_RETENTION_DAYS = 90;
export const DEFAULT_ACTIVITY_MAX_ENTRIES = 500;

export const activityStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

export type ActivityStatus = z.infer<typeof activityStatusSchema>;

export const localActivitySchema = z.strictObject({
  id: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  tool: toolIdSchema,
  actionLabel: z.string().trim().min(1).max(120),
  sourceUrl: z.string().max(MAX_ACTIVITY_URL_LEN),
  sourceOrigin: z.string().max(260),
  sourceDomain: z.string().max(253),
  pageTitle: z.string().max(MAX_ACTIVITY_TITLE_LEN),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  durationMs: z.number().int().min(0).max(86_400_000).nullable(),
  status: activityStatusSchema,
  optionsSummary: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  resultSummary: z.string().max(MAX_ACTIVITY_SUMMARY_LEN),
  linkedArtifactId: z.string().min(1).max(128).nullable(),
  linkedCaptureId: z.string().min(1).max(128).nullable(),
  errorCategory: z.string().max(MAX_ACTIVITY_ERROR_LEN).nullable(),
});

export type LocalActivityRecord = z.infer<typeof localActivitySchema>;

export interface ActivityQueryFilter {
  origin?: string | undefined;
  domain?: string | undefined;
  tool?: string | undefined;
  status?: ActivityStatus | undefined;
  search?: string | undefined;
  fromIso?: string | undefined;
  toIso?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface ActivityQueryItem extends LocalActivityRecord {
  linkedResourceStatus: 'present' | 'removed' | 'none';
}

export interface ActivityQueryResult {
  items: ActivityQueryItem[];
  totalMatching: number;
  hasMore: boolean;
  domains: string[];
}

const ALLOWED_OPTION_KEYS = new Set([
  'mode',
  'exportMime',
  'targetFramework',
  'action',
  'scope',
  'selector',
  'primarySelector',
  'secondarySelector',
  'includeZip',
  'syncEnabled',
  'viewportCount',
  'format',
  'exportFormat',
  'fontFamily',
  'trigger',
  'durationMs',
  'maxDurationMs',
  'sourceKind',
  'recordVideo',
]);

const SENSITIVE_KEY_PATTERN =
  /pass|secret|token|cookie|auth|api[_-]?key|bearer|session|credential|jwt|html|base64|dataurl|body|input/i;

function stripControlChars(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 32 && code !== 127) {
      out += input[i] ?? '';
    } else if (code === 9 || code === 10 || code === 13) {
      out += ' ';
    }
  }
  return out;
}

export function sanitizeActivitySourceUrl(rawUrl: string): {
  sourceUrl: string;
  sourceOrigin: string;
  sourceDomain: string;
} {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        sourceUrl: 'about:restricted',
        sourceOrigin: '',
        sourceDomain: '',
      };
    }
    const cleanOrigin = `${parsed.protocol}//${parsed.host}`;
    const cleanPath = parsed.pathname || '/';
    const combined = `${cleanOrigin}${cleanPath}`.slice(0, MAX_ACTIVITY_URL_LEN);
    return {
      sourceUrl: combined,
      sourceOrigin: cleanOrigin.slice(0, 260),
      sourceDomain: parsed.hostname.toLowerCase().slice(0, 253),
    };
  } catch {
    return {
      sourceUrl: 'about:unknown',
      sourceOrigin: '',
      sourceDomain: '',
    };
  }
}

export function sanitizeActivityTitle(rawTitle: string): string {
  const cleaned = stripControlChars(rawTitle).replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, MAX_ACTIVITY_TITLE_LEN) || 'Untitled Page';
}

export function sanitizeActivitySummary(rawSummary: string): string {
  const withoutDataUrls = rawSummary.replace(
    /data:[a-z0-9/+.-]+;base64,[A-Za-z0-9+/=]+/gi,
    '[binary-omitted]',
  );
  const withoutSecrets = withoutDataUrls.replace(
    /(?:nvapi-|GOCSPX-|Bearer\s+)[A-Za-z0-9._-]+/gi,
    '[redacted]',
  );
  return stripControlChars(withoutSecrets)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ACTIVITY_SUMMARY_LEN);
}

export function sanitizeActivityErrorCategory(rawError: string | null | undefined): string | null {
  if (!rawError) {
    return null;
  }
  const cleaned = stripControlChars(rawError)
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, MAX_ACTIVITY_ERROR_LEN) : null;
}

export function sanitizeActivityOptions(
  rawOptions: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
  if (!rawOptions) {
    return {};
  }
  const safe: Record<string, string | number | boolean> = {};
  let totalChars = 0;

  for (const [key, value] of Object.entries(rawOptions)) {
    if (!ALLOWED_OPTION_KEYS.has(key) || SENSITIVE_KEY_PATTERN.test(key)) {
      continue;
    }
    if (typeof value === 'boolean') {
      safe[key] = value;
      totalChars += key.length + 5;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      safe[key] = value;
      totalChars += key.length + String(value).length;
    } else if (typeof value === 'string') {
      const cleaned = stripControlChars(value)
        .replace(/data:[a-z0-9/+.-]+;base64,[A-Za-z0-9+/=]+/gi, '[binary]')
        .replace(/https?:\/\/[^\s]+/gi, (match) => sanitizeActivitySourceUrl(match).sourceUrl)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_ACTIVITY_OPTION_VAL_LEN);
      if (cleaned.length > 0 && totalChars + key.length + cleaned.length <= 320) {
        safe[key] = cleaned;
        totalChars += key.length + cleaned.length;
      }
    }
  }
  return safe;
}

export function buildResearchSessionId(sourceDomain: string, utcIsoDate: string): string {
  const dayKey = utcIsoDate.slice(0, 10);
  const safeDomain = (sourceDomain || 'local')
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '-')
    .slice(0, 48);
  return `rsess-${dayKey}-${safeDomain}`;
}

export function groupDateLabelForLocalDisplay(utcIso: string, nowDate: Date = new Date()): string {
  const target = new Date(utcIso);
  if (Number.isNaN(target.getTime())) {
    return 'Earlier';
  }
  const startOfToday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
  const startOfTarget = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const diffDays = Math.round(
    (startOfToday.getTime() - startOfTarget.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (diffDays === 0) {
    return 'Today';
  }
  if (diffDays === 1) {
    return 'Yesterday';
  }
  return target.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
