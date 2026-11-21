import { z } from 'zod';
import type { ArtifactKind } from '../db/types.js';
import { AppError } from '../errors/app-error.js';
import { validateWithZod } from '../utils/validation.js';

export const ARTIFACT_MAX_BYTES: Record<ArtifactKind, number> = {
  design_reference: 262144,
  rebuild_prompt: 131072,
  design_token_export: 262144,
  asset_manifest: 262144,
};

export const safeHttpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    {
      message: 'URL must be a valid http:// or https:// URL',
    },
  );

const safeFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      !name.includes('..') &&
      !name.includes('/') &&
      !name.includes('\\') &&
      !name.includes('\u0000'),
    {
      message: 'Filename must not contain path separators, parent traversal, or null bytes',
    },
  );

export const designReferenceV1ContentSchema = z.strictObject({
  markdown: z.string().trim().min(1).max(200000),
  pageTitle: z.string().trim().min(1).max(300),
  viewport: z.strictObject({
    width: z.number().int().min(100).max(10000),
    height: z.number().int().min(100).max(10000),
  }),
  sections: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
});

export const rebuildPromptV1ContentSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(100000),
  targetFramework: z.enum(['generic', 'react_tailwind', 'html_css', 'vue_css']),
  includeLayout: z.boolean(),
  includeTypography: z.boolean(),
  includeColors: z.boolean(),
  componentChecklist: z.array(z.string().trim().min(1).max(200)).max(100),
});

export const designTokenExportV1ContentSchema = z
  .strictObject({
    colors: z
      .array(
        z.strictObject({
          name: z.string().trim().min(1).max(120),
          value: z.string().trim().min(1).max(120),
          usage: z.string().trim().min(1).max(120).optional(),
        }),
      )
      .max(500),
    typography: z
      .array(
        z.strictObject({
          role: z.string().trim().min(1).max(120),
          fontFamily: z.string().trim().min(1).max(200),
          fontSize: z.string().trim().min(1).max(64),
          lineHeight: z.string().trim().min(1).max(64),
          fontWeight: z.string().trim().min(1).max(64),
        }),
      )
      .max(200),
    spacing: z
      .array(
        z.strictObject({
          token: z.string().trim().min(1).max(120),
          value: z.string().trim().min(1).max(64),
        }),
      )
      .max(200),
  })
  .refine((val) => val.colors.length > 0 || val.typography.length > 0 || val.spacing.length > 0, {
    message: 'Design token export must include at least one color, typography, or spacing token',
  });

export const assetManifestV1ContentSchema = z.strictObject({
  assets: z
    .array(
      z.strictObject({
        url: safeHttpUrlSchema,
        kind: z.enum(['image', 'svg', 'icon', 'video_poster', 'stylesheet']),
        mimeType: z
          .string()
          .trim()
          .min(3)
          .max(120)
          .regex(/^[a-zA-Z0-9!#$&-^_.+]+\/[a-zA-Z0-9!#$&-^_.+]+$/, 'Invalid MIME type format'),
        filename: safeFilenameSchema,
        width: z.number().int().min(1).max(20000).nullable(),
        height: z.number().int().min(1).max(20000).nullable(),
        altText: z.string().max(500).nullable(),
      }),
    )
    .min(1)
    .max(500),
});

export function validateArtifactContent(
  kind: ArtifactKind,
  schemaVersion: number,
  rawContent: unknown,
): { validatedContent: unknown; serializedJson: string; byteLength: number } {
  if (schemaVersion !== 1) {
    throw new AppError(400, 'VALIDATION_ERROR', `Unsupported schemaVersion ${schemaVersion}`, [
      {
        field: 'schemaVersion',
        issue: `Artifact kind '${kind}' currently supports schemaVersion 1`,
      },
    ]);
  }

  let validatedContent: unknown;
  switch (kind) {
    case 'design_reference':
      validatedContent = validateWithZod(
        designReferenceV1ContentSchema,
        rawContent,
        'Invalid design_reference artifact content',
      );
      break;
    case 'rebuild_prompt':
      validatedContent = validateWithZod(
        rebuildPromptV1ContentSchema,
        rawContent,
        'Invalid rebuild_prompt artifact content',
      );
      break;
    case 'design_token_export':
      validatedContent = validateWithZod(
        designTokenExportV1ContentSchema,
        rawContent,
        'Invalid design_token_export artifact content',
      );
      break;
    case 'asset_manifest':
      validatedContent = validateWithZod(
        assetManifestV1ContentSchema,
        rawContent,
        'Invalid asset_manifest artifact content',
      );
      break;
  }

  const serializedJson = JSON.stringify(validatedContent);
  const byteLength = Buffer.byteLength(serializedJson, 'utf8');
  const maxBytes = ARTIFACT_MAX_BYTES[kind];

  if (byteLength > maxBytes) {
    throw new AppError(
      413,
      'PAYLOAD_TOO_LARGE',
      `Artifact content exceeds maximum size of ${maxBytes} bytes for kind '${kind}'`,
      [
        {
          field: 'content',
          issue: `Serialized content is ${byteLength} bytes, exceeding limit of ${maxBytes} bytes`,
        },
      ],
    );
  }

  return {
    validatedContent,
    serializedJson,
    byteLength,
  };
}
