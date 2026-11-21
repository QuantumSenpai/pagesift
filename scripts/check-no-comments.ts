import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const ROOT_DIR = process.cwd();
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.pgdata-local', 'docs']);
const IGNORED_FILES = new Set(['LICENSE', 'README.md', 'package-lock.json']);

const TS_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs']);
const HASH_COMMENT_FILES = new Set([
  'Dockerfile',
  'docker-compose.yml',
  '.env.example',
  '.gitignore',
]);

interface CommentViolation {
  filePath: string;
  line: number;
  detail: string;
}

function walkDirectory(dirPath: string): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDirectory(fullPath));
    } else if (entry.isFile() && !IGNORED_FILES.has(entry.name) && !entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }

  return results;
}

function checkTypeScriptOrJsFile(filePath: string, content: string): CommentViolation[] {
  const violations: CommentViolation[] = [];
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    content,
  );

  const templateBraceStack: number[] = [];
  let token = scanner.scan();

  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const pos = scanner.getTokenStart();
      const lineAndChar = sourceFile.getLineAndCharacterOfPosition(pos);
      violations.push({
        filePath: path.relative(ROOT_DIR, filePath),
        line: lineAndChar.line + 1,
        detail: scanner.getTokenText().slice(0, 80),
      });
    } else if (token === ts.SyntaxKind.TemplateHead) {
      templateBraceStack.push(0);
    } else if (token === ts.SyntaxKind.OpenBraceToken && templateBraceStack.length > 0) {
      const topIndex = templateBraceStack.length - 1;
      templateBraceStack[topIndex] = (templateBraceStack[topIndex] ?? 0) + 1;
    } else if (token === ts.SyntaxKind.CloseBraceToken && templateBraceStack.length > 0) {
      const topIndex = templateBraceStack.length - 1;
      const currentDepth = templateBraceStack[topIndex] ?? 0;
      if (currentDepth === 0) {
        token = scanner.reScanTemplateToken(false);
        if (token === ts.SyntaxKind.TemplateTail) {
          templateBraceStack.pop();
        }
        token = scanner.scan();
        continue;
      } else {
        templateBraceStack[topIndex] = currentDepth - 1;
      }
    }
    token = scanner.scan();
  }

  return violations;
}

function checkHashCommentFile(filePath: string, content: string): CommentViolation[] {
  const violations: CommentViolation[] = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((lineText, idx) => {
    const trimmed = lineText.trim();
    if (trimmed.startsWith('#')) {
      violations.push({
        filePath: path.relative(ROOT_DIR, filePath),
        line: idx + 1,
        detail: trimmed.slice(0, 80),
      });
    }
  });

  return violations;
}

function main(): void {
  const files = walkDirectory(ROOT_DIR);
  const violations: CommentViolation[] = [];

  for (const filePath of files) {
    const ext = path.extname(filePath);
    const base = path.basename(filePath);
    const content = fs.readFileSync(filePath, 'utf8');

    if (TS_EXTENSIONS.has(ext)) {
      violations.push(...checkTypeScriptOrJsFile(filePath, content));
    } else if (ext === '.html') {
      const lines = content.split(/\r?\n/);
      lines.forEach((lineText, idx) => {
        if (lineText.includes('<!--') || lineText.includes('-->')) {
          violations.push({
            filePath: path.relative(ROOT_DIR, filePath),
            line: idx + 1,
            detail: lineText.trim().slice(0, 80),
          });
        }
      });
    } else if (
      HASH_COMMENT_FILES.has(base) ||
      ext === '.yml' ||
      ext === '.yaml' ||
      ext === '.sql'
    ) {
      violations.push(...checkHashCommentFile(filePath, content));
      if (ext === '.sql') {
        const lines = content.split(/\r?\n/);
        lines.forEach((lineText, idx) => {
          if (lineText.includes('--') || lineText.includes('/*')) {
            violations.push({
              filePath: path.relative(ROOT_DIR, filePath),
              line: idx + 1,
              detail: lineText.trim().slice(0, 80),
            });
          }
        });
      }
    }
  }

  if (violations.length > 0) {
    for (const violation of violations) {
      process.stderr.write(
        `Comment violation in ${violation.filePath}:${violation.line} -> ${violation.detail}\n`,
      );
    }
    process.exit(1);
  }

  process.stdout.write(`Verified ${files.length} authored files contain zero comments.\n`);
}

main();
