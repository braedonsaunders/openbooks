import ts from 'typescript'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Refuse raw caught-error messages while permitting public validation prose.
 * Symbols preserve lexical scope: a callback's issue.message is not the
 * enclosing catch variable, even when the identifiers happen to match. */
export function scanText(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const host = ts.createCompilerHost({ noLib: true, noResolve: true })
  host.getSourceFile = (name) => name === file ? source : undefined
  const program = ts.createProgram([file], { noLib: true, noResolve: true }, host)
  const checker = program.getTypeChecker()
  const caught = new Set()
  const assignments = []
  const responses = []
  const symbol = (node) => ts.isIdentifier(node) ? checker.getSymbolAtLocation(node) : undefined
  const unwrap = (node) => {
    while (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression
    return node
  }
  function collect(node) {
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      const binding = symbol(node.variableDeclaration.name)
      if (binding) caught.add(binding)
    }
    if (ts.isVariableDeclaration(node) && node.initializer) assignments.push([node.name, node.initializer])
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) assignments.push([node.left, node.right])
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'json') responses.push(node)
    ts.forEachChild(node, collect)
  }
  collect(source)
  function referencesCaught(node) {
    if (caught.has(symbol(node))) return true
    return Boolean(ts.forEachChild(node, referencesCaught))
  }
  function rawMessage(node) {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'message' && referencesCaught(node.expression)) return true
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'message' && referencesCaught(node.expression)) return true
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'String' && node.arguments.some(referencesCaught)) return true
    return Boolean(ts.forEachChild(node, rawMessage))
  }
  // Follow aliases of the caught object without confusing a safe message
  // or a shadowed callback binding with that object.
  let changed = true
  while (changed) {
    changed = false
    for (const [name, value] of assignments) {
      const binding = symbol(name)
      if (!binding) continue
      if (caught.has(symbol(unwrap(value))) && !caught.has(binding)) {
        caught.add(binding); changed = true
      }
    }
  }
  return responses.filter((response) => response.arguments[0] && rawMessage(response.arguments[0]))
    .map((response) => source.getLineAndCharacterOfPosition(response.getStart(source)).line + 1)
}

function main() {
  const root = process.cwd()
  const files = []
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/route\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path)
    }
  }
  walk(join(root, 'web/app/api'))
  const violations = files.flatMap((file) => scanText(file, readFileSync(file, 'utf8')).map((line) => `${relative(root, file)}:${line}`))
  if (violations.length) {
    console.error(`Raw caught error messages serialized by API responses:\n${violations.join('\n')}`)
    process.exitCode = 1
  } else console.log(`API error sanitization check passed (${files.length} route handlers scanned).`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
