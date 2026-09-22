import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

/**
 * Every message key a view asks for must exist in the English catalog.
 *
 * This is a silent failure by construction. next-intl answers a miss by
 * RETURNING THE KEY PATH, so a wrong key renders as text and nothing throws,
 * nothing logs at the level anyone watches, and the page looks fine to
 * whoever shipped it. The org chart shipped with twelve of them: its stat
 * tiles were captioned HRM.ORGCHART.HEADCOUNT, HRM.ORGCHART.VACANCIES and
 * HRM.ORGCHART.LAYERS on the live page, and the tree's own strings ("Vacant",
 * "Span of control") were raw keys too — because the loader read
 * `orgChart.<name>` where the catalog carries `orgChart.labels.<name>`. The
 * payslip explanation on /me was the same mistake: eleven labels one segment
 * too high. A sweep of the whole app found 53.
 *
 * What it checks: a literal key passed to a translator bound by
 * `useTranslations('ns')` / `getTranslations('ns')` resolves to a string (or
 * to an object of strings, which several callers pass wholesale) in
 * `messages/en`.
 *
 * What it deliberately does NOT check, and why that is safe:
 *  - computed keys (`t(\`kinds.\${kind}\`)`) — the value is not known here,
 *    and those call sites guard themselves with `t.has(...)`;
 *  - the exact namespace of a translator that arrived as a FUNCTION
 *    PARAMETER. Those keys are still checked, against every namespace the
 *    file binds — weaker than checking the right one, and much stronger than
 *    skipping them.
 *
 * Non-English catalogs are not checked here: `lib/messages-catalog.test.ts`
 * owns locale parity, and a key missing from fr falls back to en rather than
 * rendering a key path.
 */

const WEB_ROOT = join(import.meta.dirname, '..')
const MESSAGES_EN = join(WEB_ROOT, 'messages', 'en')
const ROOTS = ['app', 'components', 'lib'] as const

/** A key we can check: plain identifier-ish path segments only. */
const CHECKABLE_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

function loadCatalogs(): Map<string, unknown> {
  // The namespace -> file mapping is the index's export object, which renames
  // several catalogs (`data: dataIo`, `accountingHome`). Reading the index is
  // the only way to agree with what next-intl actually serves.
  const index = readFileSync(join(MESSAGES_EN, 'index.ts'), 'utf8')
  const imports = new Map<string, string>()
  for (const match of index.matchAll(/import\s+(\w+)\s+from\s+'\.\/([\w.-]+)\.json'/g)) {
    imports.set(match[1]!, match[2]!)
  }
  const body = index.slice(index.indexOf('export default {'))
  const catalogs = new Map<string, unknown>()
  for (const match of body.matchAll(/^\s*(\w+)(?:\s*:\s*(\w+))?\s*,\s*$/gm)) {
    const namespace = match[1]!
    const file = imports.get(match[2] ?? namespace)
    if (!file) continue
    catalogs.set(namespace, JSON.parse(readFileSync(join(MESSAGES_EN, `${file}.json`), 'utf8')))
  }
  return catalogs
}

const CATALOGS = loadCatalogs()

function resolves(namespace: string, key: string): boolean {
  // A namespace may itself be dotted (`useTranslations('ui.pagination')`).
  const segments = [...namespace.split('.'), ...key.split('.')]
  let node: unknown = CATALOGS.get(segments.shift()!)
  for (const segment of segments) {
    if (node === null || typeof node !== 'object') return false
    if (!(segment in (node as Record<string, unknown>))) return false
    node = (node as Record<string, unknown>)[segment]
  }
  if (typeof node === 'string' || Array.isArray(node)) return true
  // Several callers read a whole leaf object of strings (a label bag).
  return (
    typeof node === 'object' &&
    node !== null &&
    Object.values(node as Record<string, unknown>).every((value) => typeof value === 'string')
  )
}

function sourceFiles(): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path)
    }
  }
  for (const root of ROOTS) walk(join(WEB_ROOT, root))
  return files
}

interface Scope {
  /** Translator name -> namespace, declared in this scope. */
  translators: Map<string, string>
  /** Function parameters declared here — a translator may arrive as one. */
  params: Set<string>
  /** Other bindings declared here. They shadow an outer translator. */
  locals: Set<string>
}

/** `useTranslations('x')` / `await getTranslations('x')` -> 'x'. */
function namespaceOf(initializer: ts.Expression | undefined): string | null {
  let expression = initializer
  if (expression && ts.isAwaitExpression(expression)) expression = expression.expression
  if (!expression || !ts.isCallExpression(expression)) return null
  const callee = expression.expression
  const name = ts.isIdentifier(callee) ? callee.text : null
  if (name !== 'useTranslations' && name !== 'getTranslations') return null
  const argument = expression.arguments[0]
  if (!argument || !ts.isStringLiteralLike(argument)) return null
  return argument.text
}

type Resolution = { kind: 'translator'; namespace: string } | { kind: 'param' } | { kind: 'other' }

/** What the innermost binding of `name` is at this point in the file. */
function lookup(scopes: Scope[], name: string): Resolution {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i]!
    const namespace = scope.translators.get(name)
    if (namespace !== undefined) return { kind: 'translator', namespace }
    if (scope.params.has(name)) return { kind: 'param' }
    if (scope.locals.has(name)) return { kind: 'other' }
  }
  return { kind: 'other' }
}

interface Finding {
  file: string
  namespace: string
  key: string
}

function scan(file: string): { missing: Finding[]; shadowedCalls: number } {
  const text = readFileSync(file, 'utf8')
  if (!text.includes('useTranslations') && !text.includes('getTranslations')) {
    return { missing: [], shadowedCalls: 0 }
  }
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const missing: Finding[] = []
  let shadowedCalls = 0
  const scopes: Scope[] = [{ translators: new Map(), params: new Set(), locals: new Set() }]
  // Names this file binds to a translator ANYWHERE. A parameter of the same
  // name is a translator handed to a helper; a parameter named `f` in a
  // ViewSpec file is the field accessor and has nothing to do with i18n.
  const translatorNames = new Set<string>()
  const fileNamespaces = new Set<string>()
  for (const match of text.matchAll(
    /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:getTranslations|useTranslations)\(\s*['"]([^'"]+)['"]/g,
  )) {
    translatorNames.add(match[1]!)
    fileNamespaces.add(match[2]!)
  }

  const declaresScope = (node: ts.Node): boolean =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isBlock(node) ||
    ts.isSourceFile(node)

  const visit = (node: ts.Node): void => {
    const opened = declaresScope(node) && !ts.isSourceFile(node)
    if (opened) scopes.push({ translators: new Map(), params: new Set(), locals: new Set() })

    // Parameters shadow an outer translator of the same name, and we cannot
    // know what namespace the caller passed.
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      const scope = scopes[scopes.length - 1]!
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name)) scope.params.add(parameter.name.text)
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const scope = scopes[scopes.length - 1]!
      const namespace = namespaceOf(node.initializer)
      if (namespace !== null) scope.translators.set(node.name.text, namespace)
      else scope.locals.add(node.name.text)
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression
      let name: string | null = null
      if (ts.isIdentifier(callee)) name = callee.text
      else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        ['has', 'raw', 'rich', 'markup'].includes(callee.name.text)
      ) {
        name = callee.expression.text
      }
      if (name !== null) {
        const resolved = lookup(scopes, name)
        const argument = node.arguments[0]
        const literal =
          argument && ts.isStringLiteralLike(argument) && !ts.isTemplateExpression(argument)
            ? argument.text
            : null
        const checkable = literal !== null && CHECKABLE_KEY.test(literal)
        if (resolved.kind === 'param' && checkable && translatorNames.has(name)) {
          // A translator handed to a helper: its namespace is the caller's.
          // Every such helper in this repo is called from the same file, so
          // the key must resolve under one of the namespaces the file binds.
          // Checking all of them is weaker than checking the right one and
          // stronger than counting the case and looking away.
          shadowedCalls += 1
          if (![...fileNamespaces].some((ns) => resolves(ns, literal!))) {
            missing.push({
              file: relative(WEB_ROOT, file),
              namespace: `(translator parameter \`${name}\`)`,
              key: literal!,
            })
          }
        } else if (
          resolved.kind === 'translator' &&
          checkable &&
          !resolves(resolved.namespace, literal!)
        ) {
          missing.push({ file: relative(WEB_ROOT, file), namespace: resolved.namespace, key: literal! })
        }
      }
    }

    ts.forEachChild(node, visit)
    if (opened) scopes.pop()
  }

  ts.forEachChild(source, visit)
  return { missing, shadowedCalls }
}

test('every literal message key a view asks for exists in the English catalog', () => {
  const missing: Finding[] = []
  let shadowedCalls = 0
  for (const file of sourceFiles()) {
    const result = scan(file)
    missing.push(...result.missing)
    shadowedCalls += result.shadowedCalls
  }
  // Deduplicate: the same wrong key is usually read from several call sites,
  // and a list with eleven copies of one mistake reads as eleven mistakes.
  const unique = [...new Map(missing.map((f) => [`${f.file}|${f.namespace}|${f.key}`, f])).values()]
  assert.deepEqual(
    unique,
    [],
    `message keys with no entry in messages/en (next-intl renders these as the key path):\n` +
      unique.map((f) => `  ${f.file}: ${f.namespace}.${f.key}`).join('\n'),
  )
  // `shadowedCalls` is not asserted on. It counts translator-as-parameter
  // call sites, which ARE checked above (against every namespace the file
  // binds) — asserting a ceiling on it would be a test of the checker's
  // current reach rather than of the property worth guarding.
  void shadowedCalls
})

test('the checker can actually fail', () => {
  assert.equal(resolves('hrm', 'orgChart.labels.headcount'), true)
  // The exact shape that shipped: one segment too high.
  assert.equal(resolves('hrm', 'orgChart.headcount'), false)
  assert.equal(resolves('hrm', 'nope.not.a.key'), false)
  assert.equal(resolves('notANamespace', 'title'), false)
})
