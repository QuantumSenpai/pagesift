import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { stripSensitiveDataFromContext } from '../../src/extension/ai/nvidia-client.js';
import { BackgroundCoordinator } from '../../src/extension/background/service-worker.js';
import { fetchSingleAssetBinary } from '../../src/extension/engines/asset-fetcher.js';
import { sanitizeInlineSvgMarkup } from '../../src/extension/engines/assets-engine.js';
import { inspectElement } from '../../src/extension/engines/inspect-engine.js';
import { validateSenderAuthorization } from '../../src/extension/protocol/messages.js';
import {
  isRestrictedNetworkHostname,
  validateExternalHttpAssetUrl,
} from '../../src/extension/protocol/url-security.js';
import { LocalExtensionStorage } from '../../src/extension/storage/idb-storage.js';
import {
  ExtensionSettingsStore,
  InMemoryKeyValueArea,
  validateSafeAiEndpointUrl,
} from '../../src/extension/storage/settings-storage.js';

const EXT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('Security Hardening: SSRF, Redirects, Privilege Bypass, Replay, and XSS', () => {
  it('blocks obfuscated private, loopback, CGNAT, metadata, and IPv6-mapped URLs across asset and AI validators', () => {
    const blockedHosts = [
      '169.254.169.254',
      'metadata.google.internal',
      '0x7f000001',
      '2130706433',
      '0177.0.0.1',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      'fe80::1',
      'fc00::1',
      '10.20.30.40',
      '100.64.0.1',
      '172.16.0.5',
      '192.168.1.10',
      '0.0.0.0',
      'internal.local',
    ];
    for (const host of blockedHosts) {
      expect(isRestrictedNetworkHostname(host, false)).toBe(true);
      const formattedHost = host.includes(':') ? `[${host}]` : host;
      expect(validateExternalHttpAssetUrl(`https://${formattedHost}/asset.png`, false).ok).toBe(
        false,
      );
      expect(() =>
        validateSafeAiEndpointUrl(`https://${formattedHost}/v1/chat/completions`),
      ).toThrow();
    }

    expect(validateExternalHttpAssetUrl('https://cdn.example.com/logo.png', false).ok).toBe(true);
    expect(
      validateSafeAiEndpointUrl('https://integrate.api.nvidia.com/v1/chat/completions'),
    ).toContain('integrate.api.nvidia.com');
    expect(validateSafeAiEndpointUrl('http://127.0.0.1:11434/v1/chat/completions')).toContain(
      '127.0.0.1',
    );
  });

  it('blocks HTTP 302 SSRF redirect hops to loopback or metadata services during asset fetch', async () => {
    const blockedMetadata = await fetchSingleAssetBinary('https://cdn.example.com/hop.png', {
      allowLoopback: false,
      fetchImpl: () =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'http://169.254.169.254/latest/meta-data/iam' },
          }),
        ),
    });
    expect(blockedMetadata.ok).toBe(false);
    expect(blockedMetadata.reason).toContain('Redirect blocked');

    const blockedHexLoopback = await fetchSingleAssetBinary('https://cdn.example.com/hop2.png', {
      allowLoopback: false,
      fetchImpl: () =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'http://0x7f000001/admin' },
          }),
        ),
    });
    expect(blockedHexLoopback.ok).toBe(false);
    expect(blockedHexLoopback.reason).toContain('Redirect blocked');
  });

  it('enforces single-use AI confirmation digests and invalidates them if endpoint or payload changes', async () => {
    const storage = new LocalExtensionStorage(`pagesift_sec_replay_${Date.now()}`);
    const settingsStore = new ExtensionSettingsStore(
      new InMemoryKeyValueArea(),
      new InMemoryKeyValueArea(),
    );
    await settingsStore.setSessionNvidiaApiKey('nvapi-test-session-key-123456');

    let apiCallCount = 0;
    const coordinator = new BackgroundCoordinator({
      extensionId: EXT_ID,
      storage,
      settingsStore,
      fetchImpl: () => {
        apiCallCount += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({ choices: [{ message: { content: 'Verified response' } }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    });
    await coordinator.initialize();

    const extSender = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/workspace.html` };
    try {
      const previewRes = await coordinator.handleRuntimeMessage(
        {
          schemaVersion: 1,
          requestId: 'req-sec-prev',
          operation: 'RUN_NVIDIA_ENHANCEMENT',
          payload: {
            previewOnly: true,
            taskType: 'extract_features',
            sourceTool: 'feature_extract',
            toolOutput: { pageTitle: 'Security Audit Target' },
          },
        },
        extSender,
      );
      expect(previewRes.ok).toBe(true);
      const digest = previewRes.ok
        ? (previewRes.data as { payloadDigest: string }).payloadDigest
        : '';

      const firstExec = await coordinator.handleRuntimeMessage(
        {
          schemaVersion: 1,
          requestId: 'req-sec-exec-1',
          operation: 'RUN_NVIDIA_ENHANCEMENT',
          payload: {
            previewOnly: false,
            taskType: 'extract_features',
            sourceTool: 'feature_extract',
            toolOutput: { pageTitle: 'Security Audit Target' },
            confirmedPayloadDigest: digest,
          },
        },
        extSender,
      );
      expect(firstExec.ok).toBe(true);
      expect(apiCallCount).toBe(1);

      const replayExec = await coordinator.handleRuntimeMessage(
        {
          schemaVersion: 1,
          requestId: 'req-sec-exec-2',
          operation: 'RUN_NVIDIA_ENHANCEMENT',
          payload: {
            previewOnly: false,
            taskType: 'extract_features',
            sourceTool: 'feature_extract',
            toolOutput: { pageTitle: 'Security Audit Target' },
            confirmedPayloadDigest: digest,
          },
        },
        extSender,
      );
      expect(replayExec.ok).toBe(false);
      expect(apiCallCount).toBe(1);
    } finally {
      await storage.close();
    }
  });

  it('prevents privileged operations from page senders, strips prototype keys, sanitizes SVG payloads, and computes WCAG contrast in Inspect', () => {
    const pageSender = {
      id: EXT_ID,
      url: 'https://untrusted.example.com/page',
      tab: { id: 5, url: 'https://untrusted.example.com/page' },
    };
    for (const op of [
      'SET_NVIDIA_API_KEY',
      'GET_NVIDIA_KEY_STATUS',
      'RUN_NVIDIA_ENHANCEMENT',
      'EXPORT_DB_BACKUP',
      'CLEAR_ALL_LOCAL_DATA',
    ] as const) {
      expect(validateSenderAuthorization(pageSender, EXT_ID, op).allowed).toBe(false);
    }

    const maliciousContext = JSON.parse(
      '{"pageTitle":"Safe","accessToken":"steal-me","__proto__":{"polluted":true},"nested":{"clientSecret":"hide"}}',
    ) as Record<string, unknown>;
    const stripped = stripSensitiveDataFromContext(maliciousContext);
    expect(stripped['accessToken']).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(stripped, '__proto__')).toBe(false);
    expect((stripped['nested'] as Record<string, unknown>)['clientSecret']).toBeUndefined();

    const dom = new JSDOM(
      `<!DOCTYPE html>
      <html>
        <body style="background-color: rgb(255, 255, 255);">
          <h1 id="headline" style="color: rgb(17, 24, 39);">Contrast Check</h1>
          <svg id="evil" onload="alert(1)"><script>alert(2)</script><use xlink:href="javascript:alert(3)"></use><rect width="10" height="10"/></svg>
        </body>
      </html>`,
    );
    const svgEl = dom.window.document.getElementById('evil');
    const headlineEl = dom.window.document.getElementById('headline');
    if (!svgEl || !headlineEl) {
      throw new Error('Expected test DOM elements');
    }
    const cleanedSvg = sanitizeInlineSvgMarkup(svgEl);
    expect(cleanedSvg).not.toContain('script');
    expect(cleanedSvg).not.toContain('onload');
    expect(cleanedSvg).not.toContain('javascript:');

    const inspected = inspectElement(headlineEl, dom.window as unknown as Window);
    expect(inspected.colors.contrastRatio).toBeGreaterThan(10);
    expect(inspected.colors.contrastGrade).toBe('AAA');
  });
});
