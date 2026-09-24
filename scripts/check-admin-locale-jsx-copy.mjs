#!/usr/bin/env node
/** Catch literal JSX copy in the audited admin surfaces. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const requireFromRoot = createRequire(new URL('../package.json', import.meta.url));
const ts = requireFromRoot('typescript-eslint-typescript');
const FILES = [
  'web/app/(app)/admin/backups/BackupManager.tsx',
  'web/app/(app)/admin/page-layouts/LayoutDrawer.tsx',
  'web/app/(app)/admin/sandboxes/SandboxManager.tsx',
];

export function findLiteralCopy(source, path = '<source>') {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings = [];
  function add(node) {
    const text = node.text.trim();
    if (!text) return;
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    findings.push({ path, line: line + 1, text });
  }
  function visit(node) {
    if (ts.isJsxText(node)) add(node);
    if (ts.isJsxExpression(node) && node.expression &&
        (ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression))) add(node.expression);
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer) &&
        ['aria-label', 'alt', 'placeholder', 'title'].includes(node.name.getText(file))) add(node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return findings;
}

export function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const findings = FILES.flatMap((path) => findLiteralCopy(readFileSync(join(root, path), 'utf8'), path));
  if (findings.length) {
    console.error('FAIL: audited admin viewer copy must come from the locale catalogs:');
    for (const finding of findings) console.error(`  ${finding.path}:${finding.line}: ${finding.text}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS: no literal JSX copy in ${FILES.length} audited admin files.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
