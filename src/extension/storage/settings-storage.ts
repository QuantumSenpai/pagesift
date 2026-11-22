import { z } from 'zod';

export const ALLOWED_NVIDIA_ENDPOINTS = [
  'https://integrate.api.nvidia.com/v1/chat/completions',
] as const;

export const AI_PROVIDER_PRESETS = {
  nvidia: {
    label: 'NVIDIA NIM',
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    defaultModel: 'meta/llama-3.1-70b-instruct',
  },
  openai: {
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
  },
  openrouter: {
    label: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'openai/gpt-4o-mini',
  },
  groq: {
    label: 'Groq',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  custom: {
    label: 'Custom OpenAI-Compatible API',
    endpoint: '',
    defaultModel: '',
  },
} as const;

export type AiProviderPreset = keyof typeof AI_PROVIDER_PRESETS;

export function validateSafeAiEndpointUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('AI endpoint URL must be a valid URL');
  }
  if (parsed.username || parsed.password) {
    throw new Error('AI endpoint URL must not embed credentials');
  }
  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  if (parsed.protocol === 'https:') {
    if (
      hostname.endsWith('.local') ||
      hostname === '169.254.169.254' ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
    ) {
      throw new Error('Private or link-local HTTPS AI endpoints are blocked for security');
    }
    return parsed.toString();
  }
  if (parsed.protocol === 'http:' && isLoopback) {
    return parsed.toString();
  }
  throw new Error('Remote AI endpoint must use https:// (or http://localhost for local runtimes)');
}

const overlayToolIdSchema = z.enum([
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

export const extensionSettingsSchema = z.strictObject({
  theme: z.enum(['system', 'light', 'dark']).default('light'),
  overlayPosition: z.enum(['bottom-center', 'bottom-right', 'top-center']).default('bottom-center'),
  overlayThemeMode: z.enum(['follow', 'light', 'dark']).default('follow'),
  overlayPinnedTools: z
    .array(overlayToolIdSchema)
    .min(3)
    .max(6)
    .default(['inspect', 'tech_stack', 'colors', 'fonts', 'capture']),
  defaultExportFormat: z.enum(['markdown', 'json', 'html_css']).default('markdown'),
  colorFormat: z.enum(['hex', 'rgb', 'hsl', 'oklch']).default('hex'),
  spacingUnit: z.enum(['px', 'rem']).default('px'),
  tailwindVersion: z.enum(['v3', 'v4']).default('v4'),
  includeResponsiveBreakpoints: z.boolean().default(true),
  redactSensitiveQueryParams: z.boolean().default(true),
  recordActivityHistory: z.boolean().default(true),
  activityRetentionDays: z.number().int().min(7).max(365).default(90),
  activityMaxEntries: z.number().int().min(50).max(2000).default(500),
  activityFirstUseNoticeDismissed: z.boolean().default(false),
  sidebarCollapsed: z.boolean().default(false),
  defaultPromptTarget: z
    .enum(['generic', 'react_tailwind', 'html_css', 'vue_css'])
    .default('react_tailwind'),
  aiProviderPreset: z.enum(['nvidia', 'openai', 'openrouter', 'groq', 'custom']).default('nvidia'),
  nvidiaEndpoint: z
    .string()
    .trim()
    .max(512)
    .default(ALLOWED_NVIDIA_ENDPOINTS[0])
    .refine((val) => {
      try {
        validateSafeAiEndpointUrl(val);
        return true;
      } catch {
        return false;
      }
    }, 'AI endpoint must be a safe https:// URL or localhost endpoint'),
  nvidiaModelId: z.string().trim().max(160).default('meta/llama-3.1-70b-instruct'),
});

export type ExtensionSettings = z.infer<typeof extensionSettingsSchema>;

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = extensionSettingsSchema.parse({});

export interface KeyValueArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

const SETTINGS_STORAGE_KEY = 'pagesift_settings_v1';
const NVIDIA_SESSION_KEY = 'pagesift_nvidia_session_api_key';

export class InMemoryKeyValueArea implements KeyValueArea {
  private readonly store = new Map<string, unknown>();

  public get(keys: string | string[]): Promise<Record<string, unknown>> {
    const keyList = Array.isArray(keys) ? keys : [keys];
    const result: Record<string, unknown> = {};
    for (const key of keyList) {
      if (this.store.has(key)) {
        result[key] = this.store.get(key);
      }
    }
    return Promise.resolve(result);
  }

  public set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      this.store.set(key, structuredClone(value));
    }
    return Promise.resolve();
  }

  public remove(keys: string | string[]): Promise<void> {
    const keyList = Array.isArray(keys) ? keys : [keys];
    for (const key of keyList) {
      this.store.delete(key);
    }
    return Promise.resolve();
  }
}

export class ExtensionSettingsStore {
  private readonly localArea: KeyValueArea;
  private readonly sessionArea: KeyValueArea;

  public constructor(localArea: KeyValueArea, sessionArea: KeyValueArea) {
    this.localArea = localArea;
    this.sessionArea = sessionArea;
  }

  public async getSettings(): Promise<ExtensionSettings> {
    const raw = await this.localArea.get(SETTINGS_STORAGE_KEY);
    const stored = raw[SETTINGS_STORAGE_KEY];
    if (!stored || typeof stored !== 'object') {
      return DEFAULT_EXTENSION_SETTINGS;
    }
    const parsed = extensionSettingsSchema.safeParse(stored);
    return parsed.success ? parsed.data : DEFAULT_EXTENSION_SETTINGS;
  }

  public async updateSettings(partial: unknown): Promise<ExtensionSettings> {
    const current = await this.getSettings();
    const merged = {
      ...current,
      ...(typeof partial === 'object' && partial !== null ? partial : {}),
    };
    const validated = extensionSettingsSchema.parse(merged);
    await this.localArea.set({ [SETTINGS_STORAGE_KEY]: validated });
    return validated;
  }

  public async setSessionNvidiaApiKey(apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    if (trimmed.length < 8 || trimmed.length > 512 || /\s/.test(trimmed)) {
      throw new Error('API key must be a non-empty token between 8 and 512 characters');
    }
    await this.sessionArea.set({ [NVIDIA_SESSION_KEY]: trimmed });
  }

  public async getSessionNvidiaApiKey(): Promise<string | null> {
    const raw = await this.sessionArea.get(NVIDIA_SESSION_KEY);
    const val = raw[NVIDIA_SESSION_KEY];
    return typeof val === 'string' && val.length > 0 ? val : null;
  }

  public async clearSessionNvidiaApiKey(): Promise<void> {
    await this.sessionArea.remove(NVIDIA_SESSION_KEY);
  }

  public async getNvidiaKeyStatus(): Promise<{
    hasSessionKey: boolean;
    maskedPreview: string | null;
  }> {
    const key = await this.getSessionNvidiaApiKey();
    if (!key) {
      return { hasSessionKey: false, maskedPreview: null };
    }
    const prefix = key.slice(0, 6);
    const suffix = key.slice(-4);
    return {
      hasSessionKey: true,
      maskedPreview: `${prefix}...${suffix}`,
    };
  }
}
