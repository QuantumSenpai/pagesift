import { deflateSync, zipSync } from 'fflate';
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT_DIR = process.cwd();
const OUT_DIR = path.join(ROOT_DIR, 'dist', 'extension');
const ZIP_PATH = path.join(ROOT_DIR, 'dist', 'pagesift-extension.zip');

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.byteLength; i += 1) {
    c ^= buf[i] ?? 0;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.byteLength, false);
  for (let i = 0; i < 4; i += 1) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.byteLength);
  view.setUint32(8 + data.byteLength, crc32(crcInput), false);
  return out;
}

function generateSolidIconPng(size: number): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, size, false);
  ihdrView.setUint32(4, size, false);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowStride = size * 4 + 1;
  const rawPixels = new Uint8Array(rowStride * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * rowStride;
    rawPixels[rowStart] = 0;
    for (let x = 0; x < size; x += 1) {
      const px = rowStart + 1 + x * 4;
      const isBorder = x < 2 || y < 2 || x >= size - 2 || y >= size - 2;
      rawPixels[px] = isBorder ? 15 : 59;
      rawPixels[px + 1] = isBorder ? 23 : 130;
      rawPixels[px + 2] = isBorder ? 42 : 246;
      rawPixels[px + 3] = 255;
    }
  }

  const zlibHeader = new Uint8Array([0x78, 0x9c]);
  const compressed = deflateSync(rawPixels, { level: 6 });
  let s1 = 1;
  let s2 = 0;
  for (let i = 0; i < rawPixels.byteLength; i += 1) {
    s1 = (s1 + (rawPixels[i] ?? 0)) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  const adler = new Uint8Array(4);
  new DataView(adler.buffer).setUint32(0, ((s2 << 16) | s1) >>> 0, false);

  const idatPayload = new Uint8Array(2 + compressed.byteLength + 4);
  idatPayload.set(zlibHeader, 0);
  idatPayload.set(compressed, 2);
  idatPayload.set(adler, 2 + compressed.byteLength);

  const ihdrChunk = makePngChunk('IHDR', ihdr);
  const idatChunk = makePngChunk('IDAT', idatPayload);
  const iendChunk = makePngChunk('IEND', new Uint8Array(0));

  const total =
    signature.byteLength + ihdrChunk.byteLength + idatChunk.byteLength + iendChunk.byteLength;
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of [signature, ihdrChunk, idatChunk, iendChunk]) {
    png.set(part, offset);
    offset += part.byteLength;
  }
  return png;
}

function collectDirectoryFilesForZip(
  baseDir: string,
  currentDir: string = baseDir,
): Record<string, Uint8Array> {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  const out: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(out, collectDirectoryFilesForZip(baseDir, fullPath));
    } else if (entry.isFile()) {
      const rel = path.relative(baseDir, fullPath).split(path.sep).join('/');
      out[rel] = new Uint8Array(fs.readFileSync(fullPath));
    }
  }
  return out;
}

async function buildExtension(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, 'icons'), { recursive: true });

  await esbuild.build({
    entryPoints: {
      'service-worker': path.join(ROOT_DIR, 'src/extension/background/service-worker.ts'),
      'content-script': path.join(ROOT_DIR, 'src/extension/content/content-script.ts'),
      workspace: path.join(ROOT_DIR, 'src/extension/ui/workspace.ts'),
      options: path.join(ROOT_DIR, 'src/extension/ui/options.ts'),
    },
    outdir: OUT_DIR,
    bundle: true,
    format: 'iife',
    target: ['chrome120'],
    platform: 'browser',
    minify: false,
    sourcemap: false,
    legalComments: 'none',
  });

  fs.copyFileSync(
    path.join(ROOT_DIR, 'src/extension/ui/workspace.html'),
    path.join(OUT_DIR, 'workspace.html'),
  );
  fs.copyFileSync(
    path.join(ROOT_DIR, 'src/extension/ui/options.html'),
    path.join(OUT_DIR, 'options.html'),
  );

  for (const size of [16, 48, 128]) {
    fs.writeFileSync(path.join(OUT_DIR, 'icons', `icon-${size}.png`), generateSolidIconPng(size));
  }

  const manifest = {
    manifest_version: 3,
    name: 'PageSift',
    version: '1.0.0',
    description:
      'Free, open-source local web inspection, design token extraction, static page snapshot, and DESIGN.md toolkit.',
    permissions: ['activeTab', 'tabs', 'storage', 'downloads', 'unlimitedStorage'],
    host_permissions: ['<all_urls>'],
    background: {
      service_worker: 'service-worker.js',
    },
    action: {
      default_title: 'Open PageSift Workspace',
      default_popup: 'workspace.html',
      default_icon: {
        '16': 'icons/icon-16.png',
        '48': 'icons/icon-48.png',
        '128': 'icons/icon-128.png',
      },
    },
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
    icons: {
      '16': 'icons/icon-16.png',
      '48': 'icons/icon-48.png',
      '128': 'icons/icon-128.png',
    },
    content_scripts: [
      {
        matches: ['http://*/*', 'https://*/*'],
        js: ['content-script.js'],
        run_at: 'document_idle',
      },
    ],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self';",
    },
  };

  fs.writeFileSync(
    path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  const zipInputs = collectDirectoryFilesForZip(OUT_DIR);
  const zipBytes = zipSync(zipInputs, { level: 9 });
  fs.writeFileSync(ZIP_PATH, zipBytes);

  process.stdout.write(
    JSON.stringify({
      event: 'extension_build_completed',
      unpackedDir: OUT_DIR,
      zipPath: ZIP_PATH,
      zipSizeBytes: zipBytes.byteLength,
      fileCount: Object.keys(zipInputs).length,
    }) + '\n',
  );
}

buildExtension().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'Extension build failed';
  process.stderr.write(JSON.stringify({ event: 'extension_build_failed', message }) + '\n');
  process.exit(1);
});
