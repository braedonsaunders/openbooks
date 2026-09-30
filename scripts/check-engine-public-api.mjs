/** Application imports of engine internals may only shrink. New consumers use
 * named package contracts; existing exceptions retain their exact import budget. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');

export function implementationImports(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const counts = {};
  function visit(node) {
    let specifier;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier = node.moduleSpecifier.text;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifier = node.arguments[0].text;
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) specifier = node.argument.literal.text;
    if (specifier) {
      const target = specifier.startsWith('@openbooks/engine/src/')
        ? 'engine/src/' + specifier.slice('@openbooks/engine/src/'.length)
        : specifier.startsWith('.') ? resolve(root, dirname(file), specifier).slice(root.length + 1) : undefined;
      if (target?.startsWith('engine/src/')) counts[target] = (counts[target] ?? 0) + 1;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return counts;
}

export function budgetViolations(file, source, exceptions) {
  return Object.entries(implementationImports(file, source))
    .filter(([target, count]) => count > (exceptions[file]?.[target] ?? 0))
    .map(([target]) => `${file}: ${target}; use a named @openbooks/engine package contract`);
}

function main() {
  const exceptions = JSON.parse(readFileSync(resolve(root, 'scripts/engine-internal-imports.json'), 'utf8'));
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'web'], { cwd: root, encoding: 'utf8' }).split('\0')
    .filter((file) => existsSync(resolve(root, file)) && /\.[cm]?[jt]sx?$/.test(file) && !/\.(?:test|spec)\./.test(file) && !file.startsWith('web/testing/'));
  const violations = files.flatMap((file) => budgetViolations(file, readFileSync(resolve(root, file), 'utf8'), exceptions));
  if (violations.length) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
  } else console.log('engine public API: no new application imports of implementation paths');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
