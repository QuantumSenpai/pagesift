import type {
  ExtensionMessageResponse,
  MessageOperation,
  RuntimeMessageEnvelope,
} from '../protocol/messages.js';

interface ChromeOptionsApis {
  runtime?: {
    sendMessage: (msg: RuntimeMessageEnvelope) => Promise<ExtensionMessageResponse>;
  };
}

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
    const exportSel = document.getElementById('opt-export-format') as HTMLSelectElement | null;
    const colorSel = document.getElementById('opt-color-format') as HTMLSelectElement | null;
    const twSel = document.getElementById('opt-tailwind-version') as HTMLSelectElement | null;
    const modelInput = document.getElementById('opt-nvidia-model') as HTMLInputElement | null;

    if (exportSel && s['defaultExportFormat']) {
      exportSel.value = s['defaultExportFormat'];
    }
    if (colorSel && s['colorFormat']) {
      colorSel.value = s['colorFormat'];
    }
    if (twSel && s['tailwindVersion']) {
      twSel.value = s['tailwindVersion'];
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
  }

  if (usageRes.ok && outputEl) {
    outputEl.textContent = JSON.stringify(usageRes.data, null, 2);
  }
}

function initOptionsPage(): void {
  const outputEl = document.getElementById('options-output');
  const backupArea = document.getElementById('backup-json-textarea') as HTMLTextAreaElement | null;

  document.getElementById('save-settings-btn')?.addEventListener('click', () => {
    void (async () => {
      const exportSel = document.getElementById('opt-export-format') as HTMLSelectElement | null;
      const colorSel = document.getElementById('opt-color-format') as HTMLSelectElement | null;
      const twSel = document.getElementById('opt-tailwind-version') as HTMLSelectElement | null;
      const modelInput = document.getElementById('opt-nvidia-model') as HTMLInputElement | null;

      const res = await sendOptionsMessage('UPDATE_SETTINGS', {
        settings: {
          defaultExportFormat: exportSel?.value ?? 'markdown',
          colorFormat: colorSel?.value ?? 'hex',
          tailwindVersion: twSel?.value ?? 'v4',
          nvidiaModelId: modelInput?.value.trim() ?? '',
        },
      });
      if (outputEl) {
        outputEl.textContent = JSON.stringify(res, null, 2);
      }
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
      await loadOptionsState();
    })();
  });

  document.getElementById('clear-nvidia-key-btn')?.addEventListener('click', () => {
    void (async () => {
      const res = await sendOptionsMessage('CLEAR_NVIDIA_API_KEY');
      if (outputEl) {
        outputEl.textContent = JSON.stringify(res, null, 2);
      }
      await loadOptionsState();
    })();
  });

  document.getElementById('refresh-usage-btn')?.addEventListener('click', () => {
    void loadOptionsState();
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
    })();
  });

  document.getElementById('download-backup-btn')?.addEventListener('click', () => {
    void (async () => {
      const res = await sendOptionsMessage('EXPORT_DB_BACKUP');
      if (!res.ok) {
        if (outputEl) {
          outputEl.textContent = JSON.stringify(res, null, 2);
        }
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
    })();
  });

  document.getElementById('import-backup-btn')?.addEventListener('click', () => {
    void (async () => {
      try {
        const parsed = JSON.parse(backupArea?.value || '{}') as unknown;
        const res = await sendOptionsMessage('IMPORT_DB_BACKUP', { backup: parsed });
        if (outputEl) {
          outputEl.textContent = JSON.stringify(res, null, 2);
        }
      } catch (err: unknown) {
        if (outputEl) {
          outputEl.textContent = JSON.stringify(
            { error: err instanceof Error ? err.message : 'Invalid JSON' },
            null,
            2,
          );
        }
      }
    })();
  });

  document.getElementById('clear-all-data-btn')?.addEventListener('click', () => {
    void (async () => {
      const res = await sendOptionsMessage('CLEAR_ALL_LOCAL_DATA');
      if (outputEl) {
        outputEl.textContent = JSON.stringify(res, null, 2);
      }
      await loadOptionsState();
    })();
  });

  void loadOptionsState();
}

if (typeof document !== 'undefined') {
  initOptionsPage();
}
