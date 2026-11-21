import { unzipSync } from 'fflate';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { verifyCaptureBinaryAndDimensions } from '../src/extension/engines/capture-engine.js';

const ROOT_DIR = process.cwd();
const EXT_DIR = path.join(ROOT_DIR, 'dist', 'extension');
const ZIP_PATH = path.join(ROOT_DIR, 'dist', 'pagesift-extension.zip');

const REQUIRED_FILES = [
  'manifest.json',
  'service-worker.js',
  'content-script.js',
  'workspace.html',
  'workspace.js',
  'options.html',
  'options.js',
  'icons/icon-16.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
];

function main(): void {
  if (!fs.existsSync(EXT_DIR)) {
    throw new Error('dist/extension directory does not exist. Run npm run build:extension first.');
  }
  if (!fs.existsSync(ZIP_PATH)) {
    throw new Error('dist/pagesift-extension.zip does not exist.');
  }

  for (const relPath of REQUIRED_FILES) {
    const full = path.join(EXT_DIR, relPath);
    if (!fs.existsSync(full)) {
      throw new Error(`Missing required extension build file: ${relPath}`);
    }
  }

  const manifestRaw = fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw) as {
    manifest_version: number;
    name: string;
    version: string;
    permissions: string[];
    background?: { service_worker?: string };
    content_security_policy?: { extension_pages?: string };
  };

  if (manifest.manifest_version !== 3) {
    throw new Error('Manifest must declare manifest_version: 3');
  }
  if (manifest.background?.service_worker !== 'service-worker.js') {
    throw new Error('Manifest must configure background.service_worker = service-worker.js');
  }

  const forbiddenPermissions = ['debugger', 'webRequest', 'webRequestBlocking', '<all_urls>'];
  for (const perm of manifest.permissions) {
    if (forbiddenPermissions.includes(perm)) {
      throw new Error(`Manifest contains prohibited default permission: ${perm}`);
    }
  }

  const csp = manifest.content_security_policy?.extension_pages ?? '';
  if (!csp.includes("script-src 'self'") || csp.includes('unsafe-eval')) {
    throw new Error(`Insecure extension_pages Content Security Policy: ${csp}`);
  }

  for (const size of [16, 48, 128] as const) {
    const iconBytes = fs.readFileSync(path.join(EXT_DIR, 'icons', `icon-${size}.png`));
    const dataUrl = `data:image/png;base64,${iconBytes.toString('base64')}`;
    const verified = verifyCaptureBinaryAndDimensions(dataUrl);
    if (verified.width !== size || verified.height !== size) {
      throw new Error(
        `icon-${size}.png has invalid dimensions ${verified.width}x${verified.height}`,
      );
    }
  }

  const zipBytes = new Uint8Array(fs.readFileSync(ZIP_PATH));
  const unzipped = unzipSync(zipBytes);
  const zipFileNames = Object.keys(unzipped);
  for (const reqFile of REQUIRED_FILES) {
    if (!zipFileNames.includes(reqFile)) {
      throw new Error(`ZIP package is missing required file: ${reqFile}`);
    }
  }

  process.stdout.write(
    JSON.stringify({
      event: 'extension_package_validated',
      manifestVersion: manifest.manifest_version,
      permissions: manifest.permissions,
      verifiedFiles: REQUIRED_FILES.length,
      zipSizeBytes: zipBytes.byteLength,
    }) + '\n',
  );
}

main();
