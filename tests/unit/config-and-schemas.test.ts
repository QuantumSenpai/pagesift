import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { AppError } from '../../src/errors/app-error.js';
import { validateArtifactContent } from '../../src/schemas/artifact-schemas.js';
import { decodeCursor, encodeCursor } from '../../src/utils/pagination.js';

const BASE_VALID_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '3000',
  LOG_LEVEL: 'info',
  TRUST_PROXY: 'false',
  DATABASE_URL: 'postgresql://pagesift:password@127.0.0.1:5432/pagesift',
  CORS_ALLOWED_ORIGINS: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,http://localhost:5173',
  ALLOWED_REDIRECT_URIS:
    'https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/oauth2,http://127.0.0.1:5173/callback',
  JWT_ACCESS_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef',
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_CALLBACK_URL: 'http://127.0.0.1:3000/v1/auth/oauth/google/callback',
};

describe('Environment configuration validation', () => {
  it('parses a valid configuration', () => {
    const config = loadConfig(BASE_VALID_ENV);
    expect(config.PORT).toBe(3000);
    expect(config.CORS_ALLOWED_ORIGINS).toEqual([
      'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'http://localhost:5173',
    ]);
    expect(config.TRUST_PROXY).toBe(false);
  });

  it('rejects wildcard CORS origins', () => {
    expect(() =>
      loadConfig({
        ...BASE_VALID_ENV,
        CORS_ALLOWED_ORIGINS: '*',
      }),
    ).toThrow(/CORS_ALLOWED_ORIGINS/);
  });

  it('rejects insecure non-loopback HTTP redirect URIs and fragments', () => {
    expect(() =>
      loadConfig({
        ...BASE_VALID_ENV,
        ALLOWED_REDIRECT_URIS: 'http://example.com/oauth2',
      }),
    ).toThrow(/ALLOWED_REDIRECT_URIS/);

    expect(() =>
      loadConfig({
        ...BASE_VALID_ENV,
        ALLOWED_REDIRECT_URIS: 'https://example.com/oauth2#fragment',
      }),
    ).toThrow(/ALLOWED_REDIRECT_URIS/);
  });

  it('rejects short JWT_ACCESS_SECRET values under 32 bytes', () => {
    expect(() =>
      loadConfig({
        ...BASE_VALID_ENV,
        JWT_ACCESS_SECRET: 'too-short-secret',
      }),
    ).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('rejects non-PostgreSQL DATABASE_URL values', () => {
    expect(() =>
      loadConfig({
        ...BASE_VALID_ENV,
        DATABASE_URL: 'mysql://localhost:3306/db',
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it('loads variables from a .env file while preserving explicit environment overrides', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagesift-env-test-'));
    const envFilePath = path.join(tempDir, '.env');

    try {
      const envContent = Object.entries({
        ...BASE_VALID_ENV,
        PORT: '4123',
        LOG_LEVEL: 'warn',
      })
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
      fs.writeFileSync(envFilePath, envContent, 'utf8');

      const configFromFile = loadConfig({}, envFilePath);
      expect(configFromFile.PORT).toBe(4123);
      expect(configFromFile.LOG_LEVEL).toBe('warn');

      const configWithOverride = loadConfig({ PORT: '5199' }, envFilePath);
      expect(configWithOverride.PORT).toBe(5199);
      expect(configWithOverride.LOG_LEVEL).toBe('warn');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('Pagination cursor encoding and decoding', () => {
  it('round-trips a valid timestamp and UUID cursor', () => {
    const now = new Date('2026-11-21T12:00:00.000Z');
    const id = '11111111-2222-4333-8444-555555555555';
    const token = encodeCursor({ updatedAt: now, id });
    const decoded = decodeCursor(token);
    expect(decoded.updatedAt.toISOString()).toBe('2026-11-21T12:00:00.000Z');
    expect(decoded.id).toBe(id);
  });

  it('rejects malformed or tampered cursors with 400 VALIDATION_ERROR', () => {
    expect(() => decodeCursor('not-valid-json')).toThrow(AppError);
    const badToken = Buffer.from(
      JSON.stringify({ updatedAt: 'not-a-date', id: 'not-a-uuid' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(badToken)).toThrow(AppError);
  });
});

describe('Versioned artifact content schemas and byte limits', () => {
  it('validates all four artifact kinds at schemaVersion 1', () => {
    const designRef = validateArtifactContent('design_reference', 1, {
      markdown: '# Design System\n\nPrimary palette and typography.',
      pageTitle: 'Example Landing Page',
      viewport: { width: 1440, height: 900 },
      sections: ['Hero', 'Features', 'Footer'],
    });
    expect(designRef.byteLength).toBeGreaterThan(10);

    const prompt = validateArtifactContent('rebuild_prompt', 1, {
      prompt: 'Rebuild the hero section using semantic HTML and responsive CSS Grid.',
      targetFramework: 'react_tailwind',
      includeLayout: true,
      includeTypography: true,
      includeColors: true,
      componentChecklist: ['Navbar', 'HeroCard'],
    });
    expect(prompt.byteLength).toBeGreaterThan(10);

    const tokens = validateArtifactContent('design_token_export', 1, {
      colors: [{ name: 'surface-primary', value: '#0f172a', usage: 'background' }],
      typography: [
        {
          role: 'heading-xl',
          fontFamily: 'Inter',
          fontSize: '48px',
          lineHeight: '56px',
          fontWeight: '700',
        },
      ],
      spacing: [{ token: 'space-4', value: '16px' }],
    });
    expect(tokens.byteLength).toBeGreaterThan(10);

    const manifest = validateArtifactContent('asset_manifest', 1, {
      assets: [
        {
          url: 'https://cdn.example.com/assets/hero.svg',
          kind: 'svg',
          mimeType: 'image/svg+xml',
          filename: 'hero.svg',
          width: 800,
          height: 600,
          altText: 'Hero diagram',
        },
      ],
    });
    expect(manifest.byteLength).toBeGreaterThan(10);
  });

  it('rejects unsupported schemaVersion values', () => {
    expect(() =>
      validateArtifactContent('design_reference', 2, {
        markdown: '# Test',
        pageTitle: 'Title',
        viewport: { width: 1200, height: 800 },
        sections: ['Main'],
      }),
    ).toThrow(AppError);
  });

  it('rejects dangerous URLs and path traversal filenames in asset_manifest', () => {
    expect(() =>
      validateArtifactContent('asset_manifest', 1, {
        assets: [
          {
            url: 'javascript:alert(1)',
            kind: 'image',
            mimeType: 'image/png',
            filename: 'safe.png',
            width: 100,
            height: 100,
            altText: null,
          },
        ],
      }),
    ).toThrow(AppError);

    expect(() =>
      validateArtifactContent('asset_manifest', 1, {
        assets: [
          {
            url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
            kind: 'image',
            mimeType: 'image/png',
            filename: 'safe.png',
            width: 100,
            height: 100,
            altText: null,
          },
        ],
      }),
    ).toThrow(AppError);

    expect(() =>
      validateArtifactContent('asset_manifest', 1, {
        assets: [
          {
            url: 'https://cdn.example.com/logo.png',
            kind: 'image',
            mimeType: 'image/png',
            filename: '../etc/passwd',
            width: 100,
            height: 100,
            altText: null,
          },
        ],
      }),
    ).toThrow(AppError);
  });

  it('rejects oversized artifact payloads exceeding the kind byte limit', () => {
    const hugeColors = Array.from({ length: 500 }, (_, idx) => ({
      name: `color-token-${idx}-${'a'.repeat(100)}`,
      value: `#${'f'.repeat(110)}`,
      usage: 'b'.repeat(115),
    }));
    const hugeTypography = Array.from({ length: 200 }, (_, idx) => ({
      role: `role-${idx}-${'c'.repeat(100)}`,
      fontFamily: 'd'.repeat(190),
      fontSize: 'e'.repeat(60),
      lineHeight: 'f'.repeat(60),
      fontWeight: 'g'.repeat(60),
    }));

    try {
      validateArtifactContent('design_token_export', 1, {
        colors: hugeColors,
        typography: hugeTypography,
        spacing: [],
      });
      expect.fail('Expected oversized design_token_export to throw PAYLOAD_TOO_LARGE');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(413);
      expect((err as AppError).code).toBe('PAYLOAD_TOO_LARGE');
    }
  });
});
