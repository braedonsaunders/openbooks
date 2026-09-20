import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const retired = ['ledger:posting', 'payroll:run', 'close:close', 'payments:payments', 'inventory:inventory']
  .map((pair) => `engine/src/${pair.replace(':', '/')}.ts`)
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .trim().split('\n').filter((file) => /\.(?:ts|tsx|mjs)$/.test(file) && existsSync(resolve(root, file)))

function target(file, specifier) {
  const at = specifier.indexOf('engine/src/')
  if (at >= 0) return specifier.slice(at).replace(/\.(?:js|ts)$/, '') + '.ts'
  if (!specifier.startsWith('.')) return null
  return relative(root, resolve(root, dirname(file), specifier)).replace(/\.(?:js|ts)$/, '') + '.ts'
}

function references(file, source) {
  const found = []
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  function isBoundaryAssertion(node) {
    if (!/(?:inventory-boundary|posting-boundary|payments-boundary|close-boundary|run-modular-boundary)\.test\.ts$/.test(file)) return false
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)
        || (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword)) return false
      if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)
        && parent.expression.expression.getText(ast) === 'assert') return true
    }
    return false
  }
  function visit(node) {
    // Includes dynamic imports, type queries, test-loader maps and embedded
    // scripts: a string naming a retired module is still an active dependency.
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (isBoundaryAssertion(node)) return
      const resolved = target(file, node.text)
      if (retired.includes(resolved)) found.push(resolved)
      else for (const path of retired) if (node.text.includes(path)) found.push(path)
    }
    if (ts.isTemplateExpression(node)) {
      for (const text of [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]) {
        for (const path of retired) if (text.includes(path)) found.push(path)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return found
}

test('retired engine entrypoints are absent and each reference census is zero', () => {
  const counts = Object.fromEntries(retired.map((path) => [path, []]))
  for (const file of files) {
    if (file === 'scripts/operation-imports.test.mjs') continue
    for (const path of references(file, readFileSync(resolve(root, file), 'utf8'))) counts[path].push(file)
  }
  for (const path of retired) {
    assert.equal(existsSync(resolve(root, path)), false, `${path} must not be restored`)
    assert.equal(counts[path].length, 0, `${path}: ${counts[path].length} retired references\n${counts[path].join('\n')}`)
    console.log(`${path}: 0 references`)
  }
})

test('census catches direct imports, dynamic imports, loader maps and embedded scripts', () => {
  const path = retired[0]
  for (const source of [
    `import { postDocument } from '@openbooks/${path}'`,
    `const x = await import('../${path}')`,
    `const mocks = [['@openbooks/${path}', 'mock:posting']]`,
    'const child = `import { postDocument } from "./' + path + '";`',
  ]) assert.deepEqual(references('scripts/example.ts', source), [path])
})

test('boundary assertions do not exempt imports in their test file', () => {
  const file = 'engine/src/ledger/posting-boundary.test.ts'
  assert.deepEqual(references(file, "assert.equal(existsSync(new URL('./posting.ts', import.meta.url)), false)"), [])
  assert.deepEqual(references(file, "import { postDocument } from './posting.ts'"), [retired[0]])
  assert.deepEqual(references(file, "assert.ok(await import('./posting.ts'))"), [retired[0]])
})
