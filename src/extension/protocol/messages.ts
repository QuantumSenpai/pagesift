import { z } from 'zod';

export const MESSAGE_SCHEMA_VERSION = 1;

export const toolIdSchema = z.enum([
  'inspect',
  'clone_page',
  'clone_prompt',
  'design_md',
  'assets',
  'colors',
  'fonts',
  'measure',
  'edit_text',
  'capture',
  'responsive',
  'swap_font',
  'arrange',
  'design_review',
  'tech_stack',
]);

export type ToolId = z.infer<typeof toolIdSchema>;

export const messageOperationSchema = z.enum([
  'PING_CONTENT',
  'GET_DOCUMENT_CONTEXT',
  'ACTIVATE_TOOL',
  'DEACTIVATE_TOOLS',
  'RUN_INSPECT_ELEMENT',
  'RUN_CLONE_PAGE',
  'RUN_CLONE_PROMPT',
  'RUN_DESIGN_MD',
  'RUN_ASSETS_EXTRACT',
  'RUN_COLORS_EXTRACT',
  'RUN_FONTS_EXTRACT',
  'RUN_MEASURE',
  'RUN_EDIT_TEXT',
  'RUN_CAPTURE',
  'RUN_RESPONSIVE_INSPECT',
  'RUN_SWAP_FONT',
  'RUN_ARRANGE',
  'RUN_DESIGN_REVIEW',
  'RUN_TECH_STACK',
  'EDIT_UNDO',
  'EDIT_REDO',
  'EDIT_RESET',
  'SYNC_SCROLL',
  'CANCEL_JOB',
  'JOB_PROGRESS',
  'SAVE_ARTIFACT_TO_IDB',
  'LIST_PROJECTS_FROM_IDB',
  'GET_STORAGE_USAGE',
  'EXPORT_DB_BACKUP',
  'IMPORT_DB_BACKUP',
  'CLEAR_ALL_LOCAL_DATA',
  'GET_SETTINGS',
  'UPDATE_SETTINGS',
  'SET_NVIDIA_API_KEY',
  'CLEAR_NVIDIA_API_KEY',
  'GET_NVIDIA_KEY_STATUS',
  'RUN_NVIDIA_ENHANCEMENT',
]);

export type MessageOperation = z.infer<typeof messageOperationSchema>;

const PRIVILEGED_EXTENSION_PAGE_OPERATIONS = new Set<MessageOperation>([
  'EXPORT_DB_BACKUP',
  'IMPORT_DB_BACKUP',
  'CLEAR_ALL_LOCAL_DATA',
  'UPDATE_SETTINGS',
  'SET_NVIDIA_API_KEY',
  'CLEAR_NVIDIA_API_KEY',
  'GET_NVIDIA_KEY_STATUS',
  'RUN_NVIDIA_ENHANCEMENT',
  'RUN_RESPONSIVE_INSPECT',
]);

export const runtimeMessageEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(MESSAGE_SCHEMA_VERSION),
  requestId: z.string().trim().min(4).max(128),
  operation: messageOperationSchema,
  tabId: z.number().int().min(0).optional(),
  frameId: z.number().int().min(0).optional(),
  documentId: z.string().trim().min(4).max(128).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type RuntimeMessageEnvelope = z.infer<typeof runtimeMessageEnvelopeSchema>;

export type ExtensionErrorCode =
  | 'INVALID_MESSAGE'
  | 'UNAUTHORIZED_SENDER'
  | 'STALE_DOCUMENT'
  | 'JOB_CANCELLED'
  | 'QUOTA_EXCEEDED'
  | 'TOOL_EXECUTION_ERROR'
  | 'AI_CONFIGURATION_ERROR'
  | 'AI_PROVIDER_ERROR'
  | 'STORAGE_ERROR';

export interface ExtensionMessageSuccess<T = unknown> {
  ok: true;
  schemaVersion: typeof MESSAGE_SCHEMA_VERSION;
  requestId: string;
  operation: MessageOperation;
  documentId?: string;
  data: T;
}

export interface ExtensionMessageFailure {
  ok: false;
  schemaVersion: typeof MESSAGE_SCHEMA_VERSION;
  requestId: string;
  operation?: MessageOperation;
  error: {
    code: ExtensionErrorCode;
    message: string;
    details?: string[];
  };
}

export type ExtensionMessageResponse<T = unknown> =
  | ExtensionMessageSuccess<T>
  | ExtensionMessageFailure;

export interface SenderContextInfo {
  id?: string | undefined;
  url?: string | undefined;
  origin?: string | undefined;
  tab?: { id?: number | undefined; url?: string | undefined } | undefined;
  frameId?: number | undefined;
}

export interface ValidatedSenderResult {
  allowed: boolean;
  isExtensionPage: boolean;
  isContentScript: boolean;
  reason?: string;
}

export function validateMessageEnvelope(
  raw: unknown,
):
  | { valid: true; message: RuntimeMessageEnvelope }
  | { valid: false; response: ExtensionMessageFailure } {
  const parsed = runtimeMessageEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    const requestId =
      typeof raw === 'object' &&
      raw !== null &&
      'requestId' in raw &&
      typeof (raw as { requestId?: unknown }).requestId === 'string'
        ? (raw as { requestId: string }).requestId
        : 'unknown-request';

    return {
      valid: false,
      response: {
        ok: false,
        schemaVersion: MESSAGE_SCHEMA_VERSION,
        requestId,
        error: {
          code: 'INVALID_MESSAGE',
          message: 'Runtime message failed schema validation',
          details: parsed.error.issues.map(
            (i) => `${i.path.map(String).join('.') || 'message'}: ${i.message}`,
          ),
        },
      },
    };
  }

  return {
    valid: true,
    message: parsed.data,
  };
}

export function validateSenderAuthorization(
  sender: SenderContextInfo,
  expectedExtensionId: string,
  operation: MessageOperation,
): ValidatedSenderResult {
  if (!sender.id || sender.id !== expectedExtensionId) {
    return {
      allowed: false,
      isExtensionPage: false,
      isContentScript: false,
      reason: 'Sender extension ID does not match PageSift extension identity',
    };
  }

  const extensionOriginPrefix = `chrome-extension://${expectedExtensionId}/`;
  const senderUrl = sender.url ?? '';
  const isExtensionPage = senderUrl.startsWith(extensionOriginPrefix);
  const isContentScript =
    !isExtensionPage &&
    sender.tab !== undefined &&
    typeof sender.tab.id === 'number' &&
    (senderUrl.startsWith('http://') || senderUrl.startsWith('https://'));

  if (!isExtensionPage && !isContentScript) {
    return {
      allowed: false,
      isExtensionPage: false,
      isContentScript: false,
      reason: 'Sender is neither a trusted extension page nor an active HTTP(S) content script',
    };
  }

  if (PRIVILEGED_EXTENSION_PAGE_OPERATIONS.has(operation) && !isExtensionPage) {
    return {
      allowed: false,
      isExtensionPage,
      isContentScript,
      reason: `Operation ${operation} requires a privileged extension UI page sender`,
    };
  }

  return {
    allowed: true,
    isExtensionPage,
    isContentScript,
  };
}

export function verifyDocumentBinding(
  requestDocumentId: string | undefined,
  currentDocumentId: string,
): boolean {
  if (!requestDocumentId) {
    return true;
  }
  return requestDocumentId === currentDocumentId;
}

export function createSuccessResponse<T>(
  message: RuntimeMessageEnvelope,
  data: T,
  currentDocumentId?: string,
): ExtensionMessageSuccess<T> {
  return {
    ok: true,
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    requestId: message.requestId,
    operation: message.operation,
    ...(currentDocumentId ? { documentId: currentDocumentId } : {}),
    data,
  };
}

export function createErrorResponse(
  requestId: string,
  code: ExtensionErrorCode,
  errorMessage: string,
  operation?: MessageOperation,
  details?: string[],
): ExtensionMessageFailure {
  return {
    ok: false,
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    requestId,
    ...(operation ? { operation } : {}),
    error: {
      code,
      message: errorMessage,
      ...(details ? { details } : {}),
    },
  };
}
