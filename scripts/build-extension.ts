import { zipSync } from 'fflate';
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT_DIR = process.cwd();
const OUT_DIR = path.join(ROOT_DIR, 'dist', 'extension');
const ZIP_PATH = path.join(ROOT_DIR, 'dist', 'pagesift-extension.zip');
const ICONS_SRC_DIR = path.join(ROOT_DIR, 'assets', 'icons');
const REQUIRED_ICON_SIZES = [16, 32, 48, 128] as const;

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
      popup: path.join(ROOT_DIR, 'src/extension/ui/popup.ts'),
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

  for (const staticFile of ['design-system.css', 'popup.html', 'workspace.html', 'options.html']) {
    fs.copyFileSync(
      path.join(ROOT_DIR, 'src/extension/ui', staticFile),
      path.join(OUT_DIR, staticFile),
    );
  }

  for (const size of REQUIRED_ICON_SIZES) {
    const srcIcon = path.join(ICONS_SRC_DIR, `icon-${size}.png`);
    if (!fs.existsSync(srcIcon)) {
      throw new Error(`Missing required raster icon asset: ${srcIcon}`);
    }
    fs.copyFileSync(srcIcon, path.join(OUT_DIR, 'icons', `icon-${size}.png`));
  }

  const iconMap = {
    '16': 'icons/icon-16.png',
    '32': 'icons/icon-32.png',
    '48': 'icons/icon-48.png',
    '128': 'icons/icon-128.png',
  };

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
      default_title: 'PageSift — Inspect, Sift & Extract',
      default_popup: 'popup.html',
      default_icon: iconMap,
    },
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
    icons: iconMap,
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
  process.stderr.write(
    `Extension build failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
