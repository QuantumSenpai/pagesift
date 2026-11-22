import { z } from 'zod';

export const ALLOWED_NVIDIA_ENDPOINTS = [
  'https://integrate.api.nvidia.com/v1/chat/completions',
] as const;

export const extensionSettingsSchema = z.strictObject({
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  defaultExportFormat: z.enum(['markdown', 'json', 'html_css']).default('markdown'),
  colorFormat: z.enum(['hex', 'rgb', 'hsl', 'oklch']).default('hex'),
  spacingUnit: z.enum(['px', 'rem']).default('px'),
  tailwindVersion: z.enum(['v3', 'v4']).default('v4'),
  includeResponsiveBreakpoints: z.boolean().default(true),
  redactSensitiveQueryParams: z.boolean().default(true),
  defaultPromptTarget: z
    .enum(['generic', 'react_tailwind', 'html_css', 'vue_css'])
    .default('react_tailwind'),
  nvidiaEndpoint: z
    .enum(ALLOWED_NVIDIA_ENDPOINTS)
    .default('https://integrate.api.nvidia.com/v1/chat/completions'),
  nvidiaModelId: z.string().trim().max(160).default(''),
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
    if (trimmed.length < 12 || trimmed.length > 256 || /\s/.test(trimmed)) {
      throw new Error('NVIDIA API key must be a non-empty token between 12 and 256 characters');
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
