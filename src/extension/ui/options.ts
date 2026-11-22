import type {
  ExtensionMessageResponse,
  MessageOperation,
  RuntimeMessageEnvelope,
} from '../protocol/messages.js';
import { AI_PROVIDER_PRESETS, type AiProviderPreset } from '../storage/settings-storage.js';
import {
  applyThemePreference,
  bindGlobalTapFeedback,
  readCachedTheme,
  type ThemePreference,
} from './theme.js';

interface ChromeOptionsApis {
  runtime?: {
    sendMessage: (msg: RuntimeMessageEnvelope) => Promise<ExtensionMessageResponse>;
  };
}

let lastFocusedBeforeModal: HTMLElement | null = null;

async function sendOptionsMessage(
  operation: MessageOperation,
  payload: Record<string, unknown> = {},
): Promise<ExtensionMessageResponse> {
  const chromeApi = (globalThis as unknown as { chrome?: ChromeOptionsApis }).chrome ?? {};
  if (!chromeApi.runtime?.sendMessage) {
    throw new Error('Extension runtime messaging unavailable');
  }
  return chromeApi.runtime.sendMessage({
    schemaVersion: 1,
    requestId: `opt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    operation,
    payload,
  });
}

function setBanner(message: string, tone: 'neutral' | 'success' | 'error' = 'neutral'): void {
  const el = document.getElementById('options-status-banner');
  if (!el) {
    return;
  }
  el.textContent = message;
  el.className = tone === 'neutral' ? 'status-line' : `status-line ${tone}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function openClearModal(): void {
  const modal = document.getElementById('confirm-clear-modal');
  const cancelBtn = document.getElementById('confirm-clear-cancel-btn');
  lastFocusedBeforeModal =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal?.classList.add('open');
  cancelBtn?.focus();
}

function closeClearModal(): void {
  const modal = document.getElementById('confirm-clear-modal');
  modal?.classList.remove('open');
  lastFocusedBeforeModal?.focus();
  lastFocusedBeforeModal = null;
}

async function loadOptionsState(): Promise<void> {
  const outputEl = document.getElementById('options-output');
  const keyStatusEl = document.getElementById('nvidia-key-status');

  const [settingsRes, keyRes, usageRes] = await Promise.all([
    sendOptionsMessage('GET_SETTINGS'),
    sendOptionsMessage('GET_NVIDIA_KEY_STATUS'),
    sendOptionsMessage('GET_STORAGE_USAGE'),
  ]);

  if (settingsRes.ok) {
    const s = (settingsRes.data as { settings: Record<string, unknown> }).settings;
    const themeSel = document.getElementById('opt-theme') as HTMLSelectElement | null;
    const overlayPosSel = document.getElementById(
      'opt-overlay-position',
    ) as HTMLSelectElement | null;
    const overlayThemeSel = document.getElementById(
      'opt-overlay-theme',
    ) as HTMLSelectElement | null;
    const exportSel = document.getElementById('opt-export-format') as HTMLSelectElement | null;
    const colorSel = document.getElementById('opt-color-format') as HTMLSelectElement | null;
    const twSel = document.getElementById('opt-tailwind-version') as HTMLSelectElement | null;
    const promptSel = document.getElementById('opt-prompt-target') as HTMLSelectElement | null;
    const aiProviderSel = document.getElementById('opt-ai-provider') as HTMLSelectElement | null;
    const aiEndpointInput = document.getElementById('opt-ai-endpoint') as HTMLInputElement | null;
    const modelInput = document.getElementById('opt-nvidia-model') as HTMLInputElement | null;
    const recordCheck = document.getElementById('opt-record-history') as HTMLInputElement | null;
    const retentionSel = document.getElementById('opt-retention-days') as HTMLSelectElement | null;

    const themePref: ThemePreference =
      s['theme'] === 'light' || s['theme'] === 'dark' || s['theme'] === 'system'
        ? s['theme']
        : readCachedTheme();
    applyThemePreference(themePref);
    if (themeSel) themeSel.value = themePref;
    if (overlayPosSel && typeof s['overlayPosition'] === 'string') {
      overlayPosSel.value = s['overlayPosition'];
    }
    if (overlayThemeSel && typeof s['overlayThemeMode'] === 'string') {
      overlayThemeSel.value = s['overlayThemeMode'];
    }
    if (exportSel && typeof s['defaultExportFormat'] === 'string') {
      exportSel.value = s['defaultExportFormat'];
    }
    if (colorSel && typeof s['colorFormat'] === 'string') {
      colorSel.value = s['colorFormat'];
    }
    if (twSel && typeof s['tailwindVersion'] === 'string') {
      twSel.value = s['tailwindVersion'];
    }
    if (promptSel && typeof s['defaultPromptTarget'] === 'string') {
      promptSel.value = s['defaultPromptTarget'];
    }
    if (aiProviderSel && typeof s['aiProviderPreset'] === 'string') {
      aiProviderSel.value = s['aiProviderPreset'];
    }
    if (aiEndpointInput && typeof s['nvidiaEndpoint'] === 'string') {
      aiEndpointInput.value = s['nvidiaEndpoint'];
    }
    if (modelInput && typeof s['nvidiaModelId'] === 'string') {
      modelInput.value = s['nvidiaModelId'];
    }
    if (recordCheck && typeof s['recordActivityHistory'] === 'boolean') {
      recordCheck.checked = s['recordActivityHistory'];
    }
    if (retentionSel && typeof s['activityRetentionDays'] === 'number') {
      retentionSel.value = String(s['activityRetentionDays']);
    }
  }

  if (keyRes.ok && keyStatusEl) {
    const st = (keyRes.data as { status: { hasSessionKey: boolean; maskedPreview: string | null } })
      .status;
    keyStatusEl.textContent = st.hasSessionKey
      ? `Status: Active in session (${st.maskedPreview ?? 'masked'})`
      : 'Status: No API key set';
    keyStatusEl.className = st.hasSessionKey ? 'tag positive' : 'tag';
  }

  if (usageRes.ok) {
    const usage = (
      usageRes.data as {
        usage: {
          projectCount: number;
          artifactCount: number;
          captureCount: number;
          activityCount?: number;
          usedBytes: number;
        };
      }
    ).usage;
    const projEl = document.getElementById('stat-projects');
    const artEl = document.getElementById('stat-artifacts');
    const capEl = document.getElementById('stat-captures');
    const actEl = document.getElementById('stat-activities');
    const bytesEl = document.getElementById('stat-bytes');
    if (projEl) projEl.textContent = String(usage.projectCount);
    if (artEl) artEl.textContent = String(usage.artifactCount);
    if (capEl) capEl.textContent = String(usage.captureCount);
    if (actEl) actEl.textContent = String(usage.activityCount ?? 0);
    if (bytesEl) bytesEl.textContent = formatBytes(usage.usedBytes);
    if (outputEl) {
      outputEl.textContent = JSON.stringify(usageRes.data, null, 2);
    }
  }
}

function initOptionsPage(): void {
  bindGlobalTapFeedback(document);
  applyThemePreference(readCachedTheme());

  const outputEl = document.getElementById('options-output');
  const backupArea = document.getElementById('backup-json-textarea') as HTMLTextAreaElement | null;

  document.getElementById('opt-theme')?.addEventListener('change', (event) => {
    const val = (event.target as HTMLSelectElement).value as ThemePreference;
    applyThemePreference(val);
    void sendOptionsMessage('UPDATE_SETTINGS', { settings: { theme: val } }).then((res) => {
      if (res.ok) {
        setBanner(`Theme preference updated to ${val}.`, 'success');
      }
    });
  });

  document.getElementById('opt-ai-provider')?.addEventListener('change', (event) => {
    const presetKey = (event.target as HTMLSelectElement).value as AiProviderPreset;
    const preset = AI_PROVIDER_PRESETS[presetKey];
    const epInput = document.getElementById('opt-ai-endpoint') as HTMLInputElement | null;
    const modelInput = document.getElementById('opt-nvidia-model') as HTMLInputElement | null;
    if (preset.endpoint && epInput) {
      epInput.value = preset.endpoint;
    }
    if (preset.defaultModel && modelInput) {
      modelInput.value = preset.defaultModel;
    }
  });

  document.getElementById('opt-record-history')?.addEventListener('change', (event) => {
    const enabled = (event.target as HTMLInputElement).checked;
    void sendOptionsMessage('UPDATE_SETTINGS', {
      settings: { recordActivityHistory: enabled },
    }).then((res) => {
      if (res.ok) {
        setBanner(
          enabled
            ? 'Local PageSift activity recording enabled.'
            : 'Local PageSift activity recording paused. Future actions will not be recorded.',
          'success',
        );
      }
    });
  });

  document.getElementById('opt-retention-days')?.addEventListener('change', (event) => {
    const days = Number.parseInt((event.target as HTMLSelectElement).value, 10);
    if (!Number.isFinite(days)) {
      return;
    }
    void sendOptionsMessage('UPDATE_SETTINGS', {
      settings: { activityRetentionDays: days },
    }).then((res) => {
      if (res.ok) {
        setBanner(`Activity history retention updated to ${days} days.`, 'success');
      }
    });
  });

  document.getElementById('prune-history-btn')?.addEventListener('click', () => {
    void (async () => {
      const res = await sendOptionsMessage('PRUNE_ACTIVITY_HISTORY');
      if (outputEl) {
        outputEl.textContent = JSON.stringify(res, null, 2);
      }
      if (res.ok) {
        const count = (res.data as { deletedCount: number }).deletedCount;
        setBanner(`Retention cleanup removed ${count} older activity entries.`, 'success');
        await loadOptionsState();
      } else {
        setBanner(`Cleanup failed: ${res.error.message}`, 'error');
      }
    })();
  });

  document.getElementById('clear-history-btn')?.addEventListener('click', () => {
    void (async () => {
      const res = await sendOptionsMessage('CLEAR_ACTIVITY_HISTORY');
      if (outputEl) {
        outputEl.textContent = JSON.stringify(res, null, 2);
      }
      if (res.ok) {
        setBanner(
          'Cleared local activity history. Saved projects and artifacts were kept.',
          'success',
        );
        await loadOptionsState();
      } else {
        setBanner(`Clear history failed: ${res.error.message}`, 'error');
      }
    })();
  });

  const saveAllSettings = async (msgText: string): Promise<void> => {
    const themeSel = document.getElementById('opt-theme') as HTMLSelectElement | null;
    const overlayPosSel = document.getElementById(
      'opt-overlay-position',
    ) as HTMLSelectElement | null;
    const overlayThemeSel = document.getElementById(
      'opt-overlay-theme',
    ) as HTMLSelectElement | null;
    const exportSel = document.getElementById('opt-export-format') as HTMLSelectElement | null;
    const colorSel = document.getElementById('opt-color-format') as HTMLSelectElement | null;
    const twSel = document.getElementById('opt-tailwind-version') as HTMLSelectElement | null;
    const promptSel = document.getElementById('opt-prompt-target') as HTMLSelectElement | null;
    const aiProviderSel = document.getElementById('opt-ai-provider') as HTMLSelectElement | null;
    const aiEndpointInput = document.getElementById('opt-ai-endpoint') as HTMLInputElement | null;
    const modelInput = document.getElementById('opt-nvidia-model') as HTMLInputElement | null;
    const recordCheck = document.getElementById('opt-record-history') as HTMLInputElement | null;
    const retentionSel = document.getElementById('opt-retention-days') as HTMLSelectElement | null;

    const theme = (themeSel?.value as ThemePreference | undefined) ?? 'light';
    applyThemePreference(theme);

    const res = await sendOptionsMessage('UPDATE_SETTINGS', {
      settings: {
        theme,
        overlayPosition: overlayPosSel?.value ?? 'bottom-center',
        overlayThemeMode: overlayThemeSel?.value ?? 'follow',
        defaultExportFormat: exportSel?.value ?? 'markdown',
        colorFormat: colorSel?.value ?? 'hex',
        tailwindVersion: twSel?.value ?? 'v4',
        defaultPromptTarget: promptSel?.value ?? 'react_tailwind',
        aiProviderPreset: aiProviderSel?.value ?? 'nvidia',
        nvidiaEndpoint: aiEndpointInput?.value.trim() || AI_PROVIDER_PRESETS.nvidia.endpoint,
        nvidiaModelId: modelInput?.value.trim() || 'nvidia/nemotron-3.5-bolt-e4b',
        recordActivityHistory: recordCheck?.checked ?? true,
        activityRetentionDays: Number.parseInt(retentionSel?.value ?? '90', 10) || 90,
      },
    });
    if (outputEl) {
      outputEl.textContent = JSON.stringify(res, null, 2);
    }
    setBanner(res.ok ? msgText : `Save failed: ${res.error.message}`, res.ok ? 'success' : 'error');
  };

  document.getElementById('save-settings-btn')?.addEventListener('click', () => {
    void saveAllSettings('Preferences saved locally.');
  });

  document.getElementById('save-ai-config-btn')?.addEventListener('click', () => {
    void saveAllSettings('AI provider settings saved locally.');
  });

  document.getElementById('set-nvidia-key-btn')?.addEventListener('click', () => {
    void (async () => {
      const input = document.getElementById('nvidia-api-key-input') as HTMLInputElement | null;
      const rawKey = input?.value.trim() ?? '';
      const res = await sendOptionsMessage('SET_NVIDIA_API_KEY', { apiKey: rawKey });
      if (input) {
        input.value = '';
      }
      if (outputEl) {
        outputEl.textContent = JSON.stringify(res, null, 2);
      }
      setBanner(
        res.ok
          ? 'Session API key saved in memory for this browser session.'
          : `Key error: ${res.error.message}`,
        res.ok ? 'success' : 'error',
      );
      await loadOptionsState();
    })();
  });

  document.getElementById('clear-nvidia-key-btn')?.addEventListener('click', () => {
    void (async () => {
      const res = await sendOptionsMessage('CLEAR_NVIDIA_API_KEY');
      if (outputEl) {
        outputEl.textContent = JSON.stringify(res, null, 2);
      }
      setBanner('Session API key cleared from memory.', 'success');
      await loadOptionsState();
    })();
  });

  document.getElementById('refresh-usage-btn')?.addEventListener('click', () => {
    void loadOptionsState().then(() => {
      setBanner('Refreshed local IndexedDB storage metrics.', 'success');
    });
  });

  document.getElementById('export-backup-btn')?.addEventListener('click', () => {
    void (async () => {
      const res = await sendOptionsMessage('EXPORT_DB_BACKUP');
      if (res.ok && backupArea) {
        const bundle = (res.data as { backup: unknown }).backup;
        backupArea.value = JSON.stringify(bundle, null, 2);
      }
      if (outputEl) {
        outputEl.textContent = JSON.stringify(res, null, 2);
      }
      setBanner(
        res.ok ? 'Backup JSON loaded below (session keys excluded).' : res.error.message,
        res.ok ? 'success' : 'error',
      );
    })();
  });

  document.getElementById('download-backup-btn')?.addEventListener('click', () => {
    void (async () => {
      const res = await sendOptionsMessage('EXPORT_DB_BACKUP');
      if (!res.ok) {
        if (outputEl) {
          outputEl.textContent = JSON.stringify(res, null, 2);
        }
        setBanner(`Backup export failed: ${res.error.message}`, 'error');
        return;
      }
      const bundle = (res.data as { backup: unknown }).backup;
      const jsonText = JSON.stringify(bundle, null, 2);
      if (backupArea) {
        backupArea.value = jsonText;
      }
      const blob = new Blob([jsonText], { type: 'application/json;charset=utf-8' });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `pagesift-backup-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
      }, 30000);
      if (outputEl) {
        outputEl.textContent = JSON.stringify(
          { event: 'backup_download_started', filename: anchor.download, byteLength: blob.size },
          null,
          2,
        );
      }
      setBanner(`Backup download started: ${anchor.download}`, 'success');
    })();
  });

  document.getElementById('import-backup-file')?.addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file || !backupArea) {
      return;
    }
    void file.text().then((text) => {
      backupArea.value = text;
      setBanner(`Loaded ${file.name} into backup editor. Click Import Backup to restore.`);
    });
  });

  document.getElementById('import-backup-btn')?.addEventListener('click', () => {
    void (async () => {
      try {
        const parsed = JSON.parse(backupArea?.value || '{}') as unknown;
        const res = await sendOptionsMessage('IMPORT_DB_BACKUP', { backup: parsed });
        if (outputEl) {
          outputEl.textContent = JSON.stringify(res, null, 2);
        }
        setBanner(
          res.ok
            ? 'Backup imported cleanly into IndexedDB.'
            : `Import failed: ${res.error.message}`,
          res.ok ? 'success' : 'error',
        );
        await loadOptionsState();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid JSON';
        if (outputEl) {
          outputEl.textContent = JSON.stringify({ error: msg }, null, 2);
        }
        setBanner(`Import failed: ${msg}`, 'error');
      }
    })();
  });

  document.getElementById('clear-all-data-btn')?.addEventListener('click', () => {
    openClearModal();
  });

  document.getElementById('confirm-clear-cancel-btn')?.addEventListener('click', () => {
    closeClearModal();
  });

  document.getElementById('confirm-clear-modal')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      closeClearModal();
    }
  });

  document.getElementById('confirm-clear-proceed-btn')?.addEventListener('click', () => {
    void (async () => {
      closeClearModal();
      const res = await sendOptionsMessage('CLEAR_ALL_LOCAL_DATA');
      if (outputEl) {
        outputEl.textContent = JSON.stringify(res, null, 2);
      }
      setBanner(
        res.ok ? 'All local IndexedDB data cleared.' : `Clear failed: ${res.error.message}`,
        res.ok ? 'success' : 'error',
      );
      await loadOptionsState();
    })();
  });

  window.addEventListener('keydown', (event) => {
    const modal = document.getElementById('confirm-clear-modal');
    if (event.key === 'Escape' && modal?.classList.contains('open')) {
      event.preventDefault();
      closeClearModal();
    }
  });

  void loadOptionsState();
}

if (typeof document !== 'undefined') {
  initOptionsPage();
}
