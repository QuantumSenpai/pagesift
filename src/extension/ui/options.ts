import type {
  ExtensionMessageResponse,
  MessageOperation,
  RuntimeMessageEnvelope,
} from '../protocol/messages.js';
import { applyThemePreference, readCachedTheme, type ThemePreference } from './theme.js';

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
  el.className = tone === 'neutral' ? 'status-banner' : `status-banner ${tone}`;
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
    const s = (settingsRes.data as { settings: Record<string, string> }).settings;
    const themeSel = document.getElementById('opt-theme') as HTMLSelectElement | null;
    const exportSel = document.getElementById('opt-export-format') as HTMLSelectElement | null;
    const colorSel = document.getElementById('opt-color-format') as HTMLSelectElement | null;
    const twSel = document.getElementById('opt-tailwind-version') as HTMLSelectElement | null;
    const promptSel = document.getElementById('opt-prompt-target') as HTMLSelectElement | null;
    const modelInput = document.getElementById('opt-nvidia-model') as HTMLInputElement | null;

    const themePref: ThemePreference =
      s['theme'] === 'light' || s['theme'] === 'dark' || s['theme'] === 'system'
        ? s['theme']
        : readCachedTheme();
    applyThemePreference(themePref);
    if (themeSel) {
      themeSel.value = themePref;
    }
    if (exportSel && s['defaultExportFormat']) {
      exportSel.value = s['defaultExportFormat'];
    }
    if (colorSel && s['colorFormat']) {
      colorSel.value = s['colorFormat'];
    }
    if (twSel && s['tailwindVersion']) {
      twSel.value = s['tailwindVersion'];
    }
    if (promptSel && s['defaultPromptTarget']) {
      promptSel.value = s['defaultPromptTarget'];
    }
    if (modelInput && typeof s['nvidiaModelId'] === 'string') {
      modelInput.value = s['nvidiaModelId'];
    }
  }

  if (keyRes.ok && keyStatusEl) {
    const st = (keyRes.data as { status: { hasSessionKey: boolean; maskedPreview: string | null } })
      .status;
    keyStatusEl.textContent = st.hasSessionKey
      ? `Status: Active in session (${st.maskedPreview ?? 'masked'})`
      : 'Status: No API key set';
    keyStatusEl.className = st.hasSessionKey ? 'pill success' : 'pill';
  }

  if (usageRes.ok) {
    const usage = (
      usageRes.data as {
        usage: {
          projectCount: number;
          artifactCount: number;
          captureCount: number;
          estimatedBytes: number;
        };
      }
    ).usage;
    const projEl = document.getElementById('stat-projects');
    const artEl = document.getElementById('stat-artifacts');
    const capEl = document.getElementById('stat-captures');
    const bytesEl = document.getElementById('stat-bytes');
    if (projEl) projEl.textContent = String(usage.projectCount);
    if (artEl) artEl.textContent = String(usage.artifactCount);
    if (capEl) capEl.textContent = String(usage.captureCount);
    if (bytesEl) bytesEl.textContent = formatBytes(usage.estimatedBytes);
    if (outputEl) {
      outputEl.textContent = JSON.stringify(usageRes.data, null, 2);
    }
  }
}

function initOptionsPage(): void {
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

  document.getElementById('save-settings-btn')?.addEventListener('click', () => {
    void (async () => {
      const themeSel = document.getElementById('opt-theme') as HTMLSelectElement | null;
      const exportSel = document.getElementById('opt-export-format') as HTMLSelectElement | null;
      const colorSel = document.getElementById('opt-color-format') as HTMLSelectElement | null;
      const twSel = document.getElementById('opt-tailwind-version') as HTMLSelectElement | null;
      const promptSel = document.getElementById('opt-prompt-target') as HTMLSelectElement | null;
      const modelInput = document.getElementById('opt-nvidia-model') as HTMLInputElement | null;

      const theme = (themeSel?.value as ThemePreference | undefined) ?? 'system';
      applyThemePreference(theme);

      const res = await sendOptionsMessage('UPDATE_SETTINGS', {
        settings: {
          theme,
          defaultExportFormat: exportSel?.value ?? 'markdown',
          colorFormat: colorSel?.value ?? 'hex',
          tailwindVersion: twSel?.value ?? 'v4',
          defaultPromptTarget: promptSel?.value ?? 'react_tailwind',
          nvidiaModelId: modelInput?.value.trim() ?? '',
        },
      });
      if (outputEl) {
        outputEl.textContent = JSON.stringify(res, null, 2);
      }
      setBanner(
        res.ok ? 'Preferences saved locally.' : `Save failed: ${res.error.message}`,
        res.ok ? 'success' : 'error',
      );
    })();
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
          ? 'NVIDIA session API key saved in memory for this browser session.'
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
      setBanner('NVIDIA session API key cleared from memory.', 'success');
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
      setBanner(`Loaded ${file.name} into backup editor. Click Import JSON Backup to restore.`);
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
