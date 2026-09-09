import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { testManifest } from './test-suite.mjs'

test('canonical tests do not split registration across top-level awaits', () => {
  const violations = []
  for (const file of testManifest().all) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const registrations = new Set()
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'node:test') continue
      const clause = statement.importClause
      if (clause?.name) registrations.add(clause.name.text)
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const binding of clause.namedBindings.elements) {
          if (['test', 'it', 'describe', 'suite'].includes((binding.propertyName ?? binding.name).text)) {
            registrations.add(binding.name.text)
          }
        }
      }
    }
    const events = []
    function visit(node) {
      // Callback awaits do not suspend module evaluation or registration.
      if (ts.isFunctionLike(node) || ts.isClassLike(node)) return
      // These dual-runner files take only the else branch in the Node suite.
      if (ts.isIfStatement(node) && node.expression.getText(source) === 'process.env.VITEST') {
        if (node.elseStatement) visit(node.elseStatement)
        return
      }
      if (ts.isAwaitExpression(node)) events.push({ kind: 'await', position: node.getStart(source) })
      if (ts.isCallExpression(node)) {
        let callee = node.expression
        while (ts.isPropertyAccessExpression(callee)) callee = callee.expression
        if (ts.isIdentifier(callee) && registrations.has(callee.text)) {
          events.push({ kind: 'test', position: node.getStart(source) })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    const tests = events.filter((event) => event.kind === 'test')
    const first = tests[0]?.position
    const last = tests.at(-1)?.position
    const gap = events.find((event) => event.kind === 'await' && event.position > first && event.position < last)
    if (gap) violations.push(`${file}:${source.getLineAndCharacterOfPosition(gap.position).line + 1}`)
  }
  // A pending test may intentionally await later setup (the WBS seam does
  // this), but registration itself must be complete before that final await.
  assert.deepEqual(violations, [],
    '--test-force-exit can omit later tests when an earlier queue drains; complete setup before registration')
})
