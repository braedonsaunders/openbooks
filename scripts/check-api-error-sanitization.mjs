import ts from 'typescript'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const apiRoot = join(root, 'web/app/api')
const files = []
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (/route\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path)
  }
}
walk(apiRoot)

const violations = []
function identifierName(expression) {
  while (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression
  return ts.isIdentifier(expression) ? expression.text : null
}
for (const file of files) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const responses = []
  const collect = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ['json', 'Response'].includes(node.expression.name.text)) responses.push(node)
    ts.forEachChild(node, collect)
  }
  collect(source)
  const containsRawCaughtMessage = (node) => {
    let found = false
    const visit = (child) => {
      if (ts.isPropertyAccessExpression(child) && child.name.text === 'message') found = true
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'String' && child.arguments.some((arg) => identifierName(arg) !== null)) found = true
      if (!found) ts.forEachChild(child, visit)
    }
    visit(node)
    return found
  }
  for (const response of responses) {
    if (response.arguments[0] && containsRawCaughtMessage(response.arguments[0])) {
      const { line } = source.getLineAndCharacterOfPosition(response.getStart(source))
      violations.push(`${relative(root, file)}:${line + 1}`)
    }
  }
}
if (violations.length) {
  console.error(`Raw caught error messages serialized by API responses:\n${violations.join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`API error sanitization check passed (${files.length} route handlers scanned).`)
}
