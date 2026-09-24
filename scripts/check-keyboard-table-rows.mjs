import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const roots = ['web/app', 'web/components']
const files = []

function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) collect(target)
    else if (entry.isFile() && target.endsWith('.tsx')) files.push(target)
  }
}

for (const root of roots) collect(root)

const violations = []
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8')
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(parsed)
      const classAttribute = node.attributes.properties.find(
        (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(parsed) === 'className',
      )
      const classValue = classAttribute && ts.isJsxAttribute(classAttribute)
        ? classAttribute.initializer?.getText(parsed) ?? ''
        : ''
      const pointerCard = tag === 'div' && /cursor-pointer/.test(classValue)
      if (tag === 'tr' || tag === 'TableRow' || pointerCard) {
        const attributes = node.attributes.properties
          .filter(ts.isJsxAttribute)
          .map((attribute) => attribute.name.getText(parsed))
        if (
          attributes.includes('onClick') &&
          !attributes.some((name) => ['role', 'tabIndex', 'onKeyDown', 'onKeyUp', 'onKeyPress'].includes(name))
        ) {
          const { line } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed))
          violations.push(`${file}:${line + 1} <${tag}> has a click handler without keyboard access`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(parsed)
}

if (violations.length) {
  console.error(`Found ${violations.length} clickable table row(s) without keyboard access:`)
  for (const violation of violations) console.error(`- ${violation}`)
  process.exitCode = 1
} else {
  console.log(`Checked ${files.length} TSX files: 0 clickable table-row keyboard violations.`)
}
