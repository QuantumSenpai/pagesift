import type { AssetBinaryFetcher, AssetBinaryFetchResult } from './assets-engine.js';

export interface PrivilegedAssetFetchOptions {
  maxConcurrency?: number;
  timeoutMs?: number;
  maxSingleAssetBytes?: number;
  maxTotalBytes?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onProgress?: (update: {
    completed: number;
    total: number;
    totalBytesDownloaded: number;
    currentUrl: string;
  }) => void;
}

export const DEFAULT_MAX_CONCURRENCY = 4;
export const DEFAULT_ASSET_TIMEOUT_MS = 10000;
export const DEFAULT_MAX_SINGLE_ASSET_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_ASSETS_BYTES = 25 * 1024 * 1024;

export function isAllowedHttpAssetUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function readResponseWithByteLimit(
  response: Response,
  maxBytes: number,
  abortController: AbortController,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string }> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const declaredLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      abortController.abort();
      return {
        ok: false,
        reason: `Declared Content-Length (${declaredLength} bytes) exceeds limit (${maxBytes} bytes)`,
      };
    }
  }

  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      return {
        ok: false,
        reason: `Response size (${buf.byteLength} bytes) exceeds limit (${maxBytes} bytes)`,
      };
    }
    return { ok: true, bytes: buf };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalRead = 0;

  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      const chunk = result.value;
      totalRead += chunk.byteLength;
      if (totalRead > maxBytes) {
        await reader.cancel();
        abortController.abort();
        return {
          ok: false,
          reason: `Streamed response exceeded byte limit (${maxBytes} bytes)`,
        };
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalRead);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: combined };
}

export async function fetchSingleAssetBinary(
  url: string,
  options: {
    timeoutMs?: number;
    maxBytes?: number;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<AssetBinaryFetchResult> {
  if (!isAllowedHttpAssetUrl(url)) {
    return {
      ok: false,
      reason: 'Only http:// and https:// asset URLs are allowed',
    };
  }

  if (options.signal?.aborted) {
    return { ok: false, reason: 'Asset fetch cancelled by user' };
  }

  const timeoutMs = Math.max(500, Math.min(30000, options.timeoutMs ?? DEFAULT_ASSET_TIMEOUT_MS));
  const maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_MAX_SINGLE_ASSET_BYTES);
  const fetchFn = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const onExternalAbort = (): void => {
    controller.abort();
  };
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
    });

    if (response.url && !isAllowedHttpAssetUrl(response.url)) {
      controller.abort();
      return {
        ok: false,
        reason: `Redirect destination protocol rejected for ${url}`,
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        reason: `HTTP ${response.status} ${response.statusText || 'Error'}`.trim(),
      };
    }

    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    const readResult = await readResponseWithByteLimit(response, maxBytes, controller);
    if (!readResult.ok) {
      return { ok: false, reason: readResult.reason };
    }

    return {
      ok: true,
      bytes: readResult.bytes,
      ...(contentType ? { mimeType: contentType } : {}),
    };
  } catch (err: unknown) {
    if (options.signal?.aborted) {
      return { ok: false, reason: 'Asset fetch cancelled by user' };
    }
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, reason: `Asset fetch timed out after ${timeoutMs}ms` };
    }
    const detail = err instanceof Error ? err.message : 'Network error';
    return { ok: false, reason: `Asset fetch failed: ${detail}` };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

export async function prefetchAssetsBatch(
  urls: string[],
  options: PrivilegedAssetFetchOptions = {},
): Promise<Map<string, AssetBinaryFetchResult>> {
  const uniqueUrls = Array.from(new Set(urls));
  const maxConcurrency = Math.max(
    1,
    Math.min(8, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY),
  );
  const maxSingleAssetBytes = options.maxSingleAssetBytes ?? DEFAULT_MAX_SINGLE_ASSET_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_ASSETS_BYTES;

  const results = new Map<string, AssetBinaryFetchResult>();
  let nextIndex = 0;
  let completedCount = 0;
  let totalBytesDownloaded = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < uniqueUrls.length) {
      if (options.signal?.aborted) {
        return;
      }
      const idx = nextIndex;
      nextIndex += 1;
      const targetUrl = uniqueUrls[idx];
      if (!targetUrl) {
        continue;
      }

      const remainingBudget = maxTotalBytes - totalBytesDownloaded;
      if (remainingBudget <= 0) {
        results.set(targetUrl, {
          ok: false,
          reason: `Total export byte limit (${maxTotalBytes} bytes) reached`,
        });
        completedCount += 1;
        options.onProgress?.({
          completed: completedCount,
          total: uniqueUrls.length,
          totalBytesDownloaded,
          currentUrl: targetUrl,
        });
        continue;
      }

      const perRequestCap = Math.min(maxSingleAssetBytes, remainingBudget);
      const res = await fetchSingleAssetBinary(targetUrl, {
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        maxBytes: perRequestCap,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });

      if (res.ok && res.bytes) {
        if (totalBytesDownloaded + res.bytes.byteLength > maxTotalBytes) {
          results.set(targetUrl, {
            ok: false,
            reason: `Total export byte limit (${maxTotalBytes} bytes) reached`,
          });
        } else {
          totalBytesDownloaded += res.bytes.byteLength;
          results.set(targetUrl, res);
        }
      } else {
        results.set(targetUrl, res);
      }

      completedCount += 1;
      options.onProgress?.({
        completed: completedCount,
        total: uniqueUrls.length,
        totalBytesDownloaded,
        currentUrl: targetUrl,
      });
    }
  };

  const workerCount = Math.min(maxConcurrency, uniqueUrls.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function createCachedBatchFetcher(
  prefetched: Map<string, AssetBinaryFetchResult>,
): AssetBinaryFetcher {
  return (url: string): Promise<AssetBinaryFetchResult> => {
    const entry = prefetched.get(url);
    if (!entry) {
      return Promise.resolve({
        ok: false,
        reason: 'Asset was not fetched or exceeded batch limits',
      });
    }
    return Promise.resolve(entry);
  };
}
