import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { registryContracts } from '../../../scripts/widget-contracts-source.mjs'
import { FRAME_NAMES, WIDGET_NAMES } from './registry-names'

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
const parse = (source: string) => ts.createSourceFile('registry.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

/** Inspect one literal; imported composition is resolved only by registryContracts. */
function objectLiteral(source: string, name: string): ts.ObjectLiteralExpression {
  const node = parse(source).statements.filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name)
  assert.ok(node?.initializer, `${name} declaration is missing`)
  let value = node.initializer
  while (ts.isSatisfiesExpression(value) || ts.isAsExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression
  assert.ok(ts.isObjectLiteralExpression(value), `${name} must be a static object literal`)
  return value
}

function forbiddenFamilyImports(source: string): string[] {
  const forbidden: string[] = []
  function visit(node: ts.Node): void {
    let specifier: ts.Node | undefined
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0]
    if (specifier && ts.isStringLiteralLike(specifier)) {
      const path = specifier.text.replace(/\.(?:tsx?|jsx?)$/, '')
      if (path === './widgets' || path === './widget-slot') forbidden.push(specifier.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(source))
  return forbidden
}

test('WIDGET_NAMES mirrors the composed WIDGET_REGISTRY exactly', () => {
  const file = fileURLToPath(new URL('./widgets.tsx', import.meta.url))
  // The generator's parser also refuses missing, duplicate and cyclic adapters.
  const actual = Object.keys(registryContracts(read('./widgets.tsx'), 'WIDGET_REGISTRY', file))
  assert.ok(actual.length > 300, 'the registry parse found almost nothing')
  assert.deepEqual({
    missing: actual.filter((name) => !WIDGET_NAMES.has(name)),
    extra: [...WIDGET_NAMES].filter((name) => !actual.includes(name)),
  }, { missing: [], extra: [] })
  assert.equal(WIDGET_NAMES.size, actual.length, 'WIDGET_NAMES must match the registry exactly (length)')
})

test('the mirrors list every name exactly once', () => {
  // A duplicated literal collapses in the Set, so membership checks stay
  // green while the mirror lies about being generated. Count the literals
  // structurally (TypeScript AST, not text search) and require no repeats.
  for (const [setName, set] of [['WIDGET_NAMES', WIDGET_NAMES], ['FRAME_NAMES', FRAME_NAMES]] as const) {
    const node = parse(read('./registry-names.ts')).statements.filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === setName)
    assert.ok(node?.initializer, `${setName} declaration is missing`)
    const literals: string[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isStringLiteral(n)) literals.push(n.text)
      ts.forEachChild(n, visit)
    }
    visit(node.initializer)
    assert.equal(new Set(literals).size, literals.length, `${setName} lists a name twice`)
    assert.equal(literals.length, set.size, `${setName} literal count must equal its Set size`)
  }
})

test('FRAME_NAMES mirrors FRAME_REGISTRY exactly', () => {
  const actual = objectLiteral(read('./blocks.tsx'), 'FRAME_REGISTRY').properties.map((property) => {
    assert.ok(ts.isPropertyAssignment(property), 'frame registry must declare explicit keys')
    assert.ok(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name), 'frame key must be static')
    return property.name.text
  })
  assert.equal(new Set(actual).size, actual.length, 'frame registry must not duplicate keys')
  assert.deepEqual({ missing: actual.filter((name) => !FRAME_NAMES.has(name)), extra: [...FRAME_NAMES].filter((name) => !actual.includes(name)) }, { missing: [], extra: [] })
  assert.equal(FRAME_NAMES.size, actual.length, 'FRAME_NAMES must match the registry exactly (length)')
})

test('every registry name is a slug the spec schema accepts', () => {
  for (const name of [...WIDGET_NAMES, ...FRAME_NAMES]) assert.match(name, /^[a-z][a-z0-9-]*$/, `${name} cannot be named by a spec`)
})

test('the widget composition and families stay bounded without backwards imports', () => {
  assert.ok(read('./widgets.tsx').split('\n').length <= 200, 'registry exceeds 200 lines; move independent renderers to a family')
  const dir = dirname(fileURLToPath(import.meta.url))
  const families = readdirSync(dir).filter((name) => name.startsWith('widgets-') && name.endsWith('.tsx'))
  assert.ok(families.length > 0, 'no widget families found')
  for (const file of families) {
    const source = read(`./${file}`)
    assert.ok(source.split('\n').length <= 500, `${file} exceeds 500 lines; split by responsibility`)
    assert.deepEqual(forbiddenFamilyImports(source), [], `${file} must not depend on the registry or its slot consumers`)
  }
})

test('registry-local renderers resolve other widgets by name', () => {
  const inline = objectLiteral(read('./widgets.tsx'), 'WIDGET_REGISTRY').properties.filter(ts.isPropertyAssignment)
  assert.ok(inline.length > 0, 'expected the registry-dependent renderers')
  for (const entry of inline) {
    let resolvesRegistry = false
    function visit(node: ts.Node): void {
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'WIDGET_REGISTRY') resolvesRegistry = true
      ts.forEachChild(node, visit)
    }
    visit(entry.initializer)
    assert.ok(resolvesRegistry, `${entry.name.getText()} belongs in a family; it does not resolve another widget`)
  }
})

test('family boundary refuses both quote styles, extensions, reexports and dynamic imports', () => {
  for (const source of [
    "import { WIDGET_REGISTRY } from './widgets'",
    'import { WIDGET_REGISTRY } from "./widgets.tsx"',
    "export { WidgetSlot } from './widget-slot'",
    "const slot = await import('./widget-slot.js')",
  ]) assert.equal(forbiddenFamilyImports(source).length, 1, source)
  assert.deepEqual(forbiddenFamilyImports("import { str } from './widget-props'"), [])
})
