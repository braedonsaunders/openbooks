import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'

const folder = process.argv[2]
if (!folder) throw new Error('usage: node scripts/migrate-api-error-responses.mjs <api-folder>')
const root = resolve('web/app/api', folder)
const files = []
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (/route\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path)
  }
}
walk(root)

function identifierName(expression) {
  while (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression
  return ts.isIdentifier(expression) ? expression.text : null
}
function messageRoot(expression) {
  while (ts.isPropertyAccessExpression(expression)) expression = expression.expression
  return identifierName(expression)
}
const editsByFile = new Map()
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const edits = []
  const catchOwner = (node) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isCatchClause(parent) && parent.variableDeclaration && ts.isIdentifier(parent.variableDeclaration.name)) return parent.variableDeclaration.name.text
    }
    return null
  }
  const responseError = (node) => {
    let name = null
    const inspect = (child) => {
      if (ts.isPropertyAccessExpression(child) && child.name.text === 'message') name ??= messageRoot(child.expression)
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'String') {
        for (const arg of child.arguments) name ??= messageRoot(arg)
      }
      if (!name) ts.forEachChild(child, inspect)
    }
    inspect(node)
    return name
  }
  const hasInstanceGuard = (node, name) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (!ts.isIfStatement(parent)) continue
      let guarded = false
      const inspect = (child) => {
        if (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && identifierName(child.left) === name) guarded = true
        if (!guarded) ts.forEachChild(child, inspect)
      }
      inspect(parent.expression)
      if (guarded && parent.thenStatement.getStart(source) <= node.getStart(source) && parent.thenStatement.getEnd() >= node.getEnd()) return true
    }
    return false
  }
  const visit = (current) => {
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) && current.expression.name.text === 'json') {
      const name = catchOwner(current) ?? responseError(current)
      if (name && responseError(current)) {
        const safe = hasInstanceGuard(current, name)
        let safeStatus
        const config = current.arguments[1]
        if (safe && config && ts.isObjectLiteralExpression(config)) {
          const statusProp = config.properties.find((prop) => ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'status')
          if (statusProp && ts.isPropertyAssignment(statusProp) && ts.isNumericLiteral(statusProp.initializer)) safeStatus = Number(statusProp.initializer.text)
        }
        edits.push({ start: current.getStart(source), end: current.getEnd(), text: `apiErrorResponse(${name}${safeStatus ? `, { safeStatus: ${safeStatus} }` : ''})` })
        return
      }
    }
    ts.forEachChild(current, visit)
  }
  visit(source)
  if (edits.length) {
    if (!text.includes("apiErrorResponse")) edits.push({ start: 0, end: 0, text: "import { apiErrorResponse } from '@/lib/api/error-response'\n" })
    editsByFile.set(file, edits)
  }
}

for (const [file, edits] of editsByFile) {
  let text = readFileSync(file, 'utf8')
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
  writeFileSync(file, text)
}
console.log(`Updated ${editsByFile.size} API route files under ${folder}.`)
