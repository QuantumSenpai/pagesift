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
  'CAPTURE_PREPARE',
  'CAPTURE_SCROLL_TO',
  'CAPTURE_RESTORE',
  'RUN_RESPONSIVE_INSPECT',
  'SET_RESPONSIVE_SYNC',
  'GET_VIEWPORT_METRICS',
  'CLOSE_RESPONSIVE_SESSION',
  'GET_RESPONSIVE_SESSION',
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
  'GET_JOB_STATUS',
  'LIST_JOBS',
  'LIST_SITE_JOBS',
  'SAVE_ARTIFACT_TO_IDB',
  'GET_ARTIFACT_FROM_IDB',
  'DELETE_ARTIFACT_FROM_IDB',
  'SAVE_CAPTURE_TO_IDB',
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
  'TOGGLE_OVERLAY_DASHBOARD',
  'UPDATE_OVERLAY_CUSTOMIZATION',
  'OPEN_FULL_DASHBOARD',
  'OPEN_OPTIONS_PAGE',
  'OPEN_SITE_RESPONSIVE_WINDOWS',
  'CAPTURE_OWN_TAB',
  'FETCH_SITE_ASSETS',
  'RECORD_LOCAL_ACTIVITY',
  'QUERY_ACTIVITY_HISTORY',
  'LIST_SITE_ACTIVITY',
  'DELETE_ACTIVITY_ENTRY',
  'DELETE_ACTIVITY_SESSION',
  'CLEAR_ACTIVITY_HISTORY',
  'PRUNE_ACTIVITY_HISTORY',
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
  'CLOSE_RESPONSIVE_SESSION',
  'GET_RESPONSIVE_SESSION',
  'RUN_CAPTURE',
  'SAVE_ARTIFACT_TO_IDB',
  'GET_ARTIFACT_FROM_IDB',
  'DELETE_ARTIFACT_FROM_IDB',
  'SAVE_CAPTURE_TO_IDB',
  'LIST_PROJECTS_FROM_IDB',
  'GET_STORAGE_USAGE',
  'GET_JOB_STATUS',
  'LIST_JOBS',
  'QUERY_ACTIVITY_HISTORY',
  'DELETE_ACTIVITY_ENTRY',
  'DELETE_ACTIVITY_SESSION',
  'CLEAR_ACTIVITY_HISTORY',
  'PRUNE_ACTIVITY_HISTORY',
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

const httpUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((val) => {
    try {
      const parsed = new URL(val);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'URL must use http:// or https://');

const captureRectSchema = z.strictObject({
  x: z.number().min(0).max(32768),
  y: z.number().min(0).max(32768),
  width: z.number().min(1).max(32768),
  height: z.number().min(1).max(32768),
});

const captureAnnotationSchema = z.strictObject({
  x: z.number().min(0).max(32768),
  y: z.number().min(0).max(32768),
  width: z.number().min(1).max(32768),
  height: z.number().min(1).max(32768),
  label: z.string().trim().max(200),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{3,8}$/, 'Annotation color must be a valid hex color'),
});

const responsiveViewportSchema = z.strictObject({
  id: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(80),
  width: z.number().int().min(240).max(3840),
  height: z.number().int().min(320).max(2160),
  category: z.enum(['mobile', 'tablet', 'laptop', 'desktop']),
});

const OPERATION_PAYLOAD_SCHEMAS: Partial<Record<MessageOperation, z.ZodType>> = {
  ACTIVATE_TOOL: z.strictObject({
    tool: toolIdSchema.default('inspect'),
  }),
  RUN_INSPECT_ELEMENT: z.strictObject({
    selector: z.string().trim().max(512).optional(),
  }),
  RUN_MEASURE: z.strictObject({
    primarySelector: z.string().trim().max(512).optional(),
    secondarySelector: z.string().trim().max(512).optional(),
  }),
  RUN_CLONE_PROMPT: z.strictObject({
    targetFramework: z
      .enum(['react_tailwind', 'html_css', 'vue_css', 'generic'])
      .default('react_tailwind'),
  }),
  RUN_ASSETS_EXTRACT: z.strictObject({
    includeZip: z.boolean().default(false),
    maxAssetCount: z.number().int().min(1).max(200).optional(),
  }),
  RUN_CLONE_PAGE: z.strictObject({
    prepareOnly: z.boolean().optional(),
    maxAssetCount: z.number().int().min(1).max(150).optional(),
  }),
  RUN_EDIT_TEXT: z.strictObject({
    selector: z.string().trim().max(512).optional(),
    text: z.string().max(4000),
  }),
  RUN_SWAP_FONT: z.strictObject({
    selector: z.string().trim().max(512).optional(),
    scope: z.enum(['element', 'similar', 'page']).default('element'),
    fontFamily: z.string().trim().min(1).max(200),
    remoteFontCssUrl: httpUrlSchema.optional(),
    allowRemoteFontLoad: z.boolean().default(false),
  }),
  RUN_ARRANGE: z.strictObject({
    selector: z.string().trim().max(512).optional(),
    action: z.enum(['move', 'hide', 'remove']).default('move'),
    dx: z.number().min(-10000).max(10000).default(0),
    dy: z.number().min(-10000).max(10000).default(0),
  }),
  RUN_CAPTURE: z.strictObject({
    mode: z.enum(['visible', 'area', 'element', 'full_page']).default('visible'),
    exportMime: z
      .enum(['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])
      .default('image/png'),
    selector: z.string().trim().max(512).optional(),
    rect: captureRectSchema.optional(),
    cropRect: captureRectSchema.optional(),
    annotations: z.array(captureAnnotationSchema).max(25).optional(),
    title: z.string().trim().max(300).optional(),
    pageUrl: httpUrlSchema.optional(),
    quality: z.number().min(0.1).max(1).optional(),
    planOnly: z.boolean().optional(),
  }),
  CAPTURE_PREPARE: z.strictObject({
    mode: z.enum(['visible', 'area', 'element', 'full_page']).default('visible'),
    selector: z.string().trim().max(512).optional(),
    rect: captureRectSchema.optional(),
  }),
  CAPTURE_SCROLL_TO: z.strictObject({
    tileIndex: z.number().int().min(0).max(50),
    scrollX: z.number().min(0).max(100000),
    scrollY: z.number().min(0).max(100000),
    hideFixed: z.boolean().default(false),
    lazyWaitMs: z.number().int().min(0).max(400).default(50),
  }),
  CAPTURE_RESTORE: z.strictObject({}),
  RUN_RESPONSIVE_INSPECT: z.strictObject({
    targetUrl: httpUrlSchema,
    openWindows: z.boolean().default(true),
    syncEnabled: z.boolean().default(true),
    customViewports: z.array(responsiveViewportSchema).min(1).max(6).optional(),
  }),
  SET_RESPONSIVE_SYNC: z.strictObject({
    enabled: z.boolean(),
  }),
  SYNC_SCROLL: z.strictObject({
    scrollXRatio: z.number().min(0).max(1),
    scrollYRatio: z.number().min(0).max(1),
  }),
  CANCEL_JOB: z.strictObject({
    jobId: z.string().trim().min(4).max(128),
  }),
  GET_JOB_STATUS: z.strictObject({
    jobId: z.string().trim().min(4).max(128),
  }),
  RUN_NVIDIA_ENHANCEMENT: z.strictObject({
    previewOnly: z.boolean().default(true),
    taskType: z.enum([
      'enhance_clone_prompt',
      'interpret_design_review',
      'explain_tech_stack',
      'extract_features',
    ]),
    modelId: z.string().trim().max(160).optional(),
    sourceTool: z
      .enum([
        'clone_prompt',
        'design_review',
        'design_md',
        'colors',
        'fonts',
        'inspect',
        'tech_stack',
        'feature_extract',
      ])
      .default('clone_prompt'),
    toolOutput: z.record(z.string(), z.unknown()).default({}),
    confirmedPayloadDigest: z.string().trim().min(16).max(128).optional(),
  }),
  TOGGLE_OVERLAY_DASHBOARD: z.strictObject({
    mode: z.enum(['toggle', 'open', 'close', 'minimize', 'action_click', 'pip']).default('toggle'),
  }),
  UPDATE_OVERLAY_CUSTOMIZATION: z.strictObject({
    theme: z.enum(['system', 'light', 'dark']).optional(),
    overlayPosition: z.enum(['bottom-center', 'bottom-right', 'top-center']).optional(),
    overlayThemeMode: z.enum(['follow', 'light', 'dark']).optional(),
    overlayPinnedTools: z.array(toolIdSchema).min(3).max(6).optional(),
  }),
  OPEN_FULL_DASHBOARD: z.strictObject({
    tool: toolIdSchema.optional(),
    autorun: z.boolean().optional(),
    section: z.enum(['tools', 'history', 'saved', 'settings']).optional(),
    mode: z.enum(['tab', 'pip']).default('tab'),
    aiTask: z
      .enum([
        'extract_features',
        'enhance_clone_prompt',
        'interpret_design_review',
        'explain_tech_stack',
      ])
      .optional(),
  }),
  OPEN_OPTIONS_PAGE: z.strictObject({}),
  OPEN_SITE_RESPONSIVE_WINDOWS: z.strictObject({
    syncEnabled: z.boolean().default(true),
    customViewports: z.array(responsiveViewportSchema).min(1).max(6).optional(),
  }),
  CAPTURE_OWN_TAB: z.strictObject({
    format: z.enum(['image/png', 'image/jpeg']).default('image/png'),
    mode: z.enum(['visible', 'full_page']).default('visible'),
  }),
  FETCH_SITE_ASSETS: z.strictObject({
    urls: z.array(httpUrlSchema).min(1).max(150),
  }),
  RECORD_LOCAL_ACTIVITY: z.strictObject({
    activityId: z.string().trim().min(4).max(128),
    tool: toolIdSchema,
    actionLabel: z.string().trim().min(1).max(120),
    sourceUrl: z.string().max(2048).optional(),
    pageTitle: z.string().max(400).optional(),
    status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
    durationMs: z.number().int().min(0).max(86_400_000).nullable().optional(),
    optionsSummary: z.record(z.string(), z.unknown()).optional(),
    resultSummary: z.string().max(500).optional(),
    linkedArtifactId: z.string().trim().min(1).max(128).nullable().optional(),
    linkedCaptureId: z.string().trim().min(1).max(128).nullable().optional(),
    errorCategory: z.string().max(120).nullable().optional(),
  }),
  QUERY_ACTIVITY_HISTORY: z.strictObject({
    origin: z.string().max(260).optional(),
    domain: z.string().max(253).optional(),
    tool: toolIdSchema.optional(),
    status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']).optional(),
    search: z.string().max(200).optional(),
    fromIso: z.string().max(64).optional(),
    toIso: z.string().max(64).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(5000).optional(),
  }),
  LIST_SITE_ACTIVITY: z.strictObject({
    limit: z.number().int().min(1).max(20).default(6),
  }),
  DELETE_ACTIVITY_ENTRY: z.strictObject({
    activityId: z.string().trim().min(1).max(128),
  }),
  DELETE_ACTIVITY_SESSION: z.strictObject({
    sessionId: z.string().trim().min(1).max(128),
  }),
  CLEAR_ACTIVITY_HISTORY: z.strictObject({}),
  PRUNE_ACTIVITY_HISTORY: z.strictObject({}),
  GET_ARTIFACT_FROM_IDB: z.strictObject({
    artifactId: z.string().trim().min(1).max(128),
  }),
  DELETE_ARTIFACT_FROM_IDB: z.strictObject({
    artifactId: z.string().trim().min(1).max(128),
  }),
};

export type ExtensionErrorCode =
  | 'INVALID_MESSAGE'
  | 'UNAUTHORIZED_SENDER'
  | 'STALE_DOCUMENT'
  | 'JOB_CANCELLED'
  | 'QUOTA_EXCEEDED'
  | 'TOOL_EXECUTION_ERROR'
  | 'AI_CONFIGURATION_ERROR'
  | 'AI_PROVIDER_ERROR'
  | 'STORAGE_ERROR'
  | 'PERMISSION_DENIED';

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

export function validateOperationPayload(
  operation: MessageOperation,
  payload: Record<string, unknown>,
  requestId: string,
):
  | { valid: true; payload: Record<string, unknown> }
  | { valid: false; response: ExtensionMessageFailure } {
  const schema = OPERATION_PAYLOAD_SCHEMAS[operation];
  if (!schema) {
    return { valid: true, payload };
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return {
      valid: false,
      response: createErrorResponse(
        requestId,
        'INVALID_MESSAGE',
        `Payload validation failed for ${operation}`,
        operation,
        parsed.error.issues.map(
          (i) => `${i.path.map(String).join('.') || 'payload'}: ${i.message}`,
        ),
      ),
    };
  }
  return { valid: true, payload: parsed.data as Record<string, unknown> };
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

  const payloadCheck = validateOperationPayload(
    parsed.data.operation,
    parsed.data.payload,
    parsed.data.requestId,
  );
  if (!payloadCheck.valid) {
    return payloadCheck;
  }

  return {
    valid: true,
    message: {
      ...parsed.data,
      payload: payloadCheck.payload,
    },
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
  required = false,
): boolean {
  if (!requestDocumentId) {
    return !required;
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
