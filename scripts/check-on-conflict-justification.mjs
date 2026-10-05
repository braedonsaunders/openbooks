#!/usr/bin/env node
/** Refuse ignored insert conflicts without a nearby explanation of why they are benign. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ts = createRequire(import.meta.url)('typescript')
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE = /\.[cm]?[jt]sx?$/
const EXCLUDED = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.ts$|^(?:engine\/src\/testing|web\/testing)\//

/** Keep offsets while excluding SQL comments and quoted values from keyword recognition. */
function sqlKeywords(text, comment) {
  return text.replace(/--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'/g,
    (part, offset) => {
      if (part.startsWith('--') || part.startsWith('/*')) comment(offset, part)
      return part.replace(/[^\r\n]/g, ' ')
    })
}

export function unjustifiedConflicts(text, path = 'source.ts') {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const comments = new Set()
  const violations = []
  const conflicts = []
  function addComment(offset, content) {
    if (content.replace(/^(?:\/\/|\/\*|--)|\*\/$/g, '').trim()) {
      const endLine = source.getLineAndCharacterOfPosition(offset + content.length).line
      comments.add(endLine)
    }
  }
  function check(offset) {
    const line = source.getLineAndCharacterOfPosition(offset).line
    if (![line, line - 1, line - 2, line - 3].some((candidate) => comments.has(candidate))) {
      violations.push({ path, line: line + 1 })
    }
  }
  function visit(node) {
    for (const range of [...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? [])]) addComment(range.pos, text.slice(range.pos, range.end))
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'onConflictDoNothing') {
      for (const range of ts.getLeadingCommentRanges(text, node.expression.expression.end) ?? []) {
        addComment(range.pos, text.slice(range.pos, range.end))
      }
      conflicts.push(node.expression.name.getStart(source))
    }
    const tagged = ts.isTaggedTemplateExpression(node)
    const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)
    if (tagged || literal) {
      const quoted = ts.isStringLiteral(node)
      const start = node.getStart(source) + (quoted ? 1 : 0)
      const raw = text.slice(start, node.end - (quoted ? 1 : 0))
      const keywords = sqlKeywords(raw, (offset, content) => addComment(start + offset, content))
      if (tagged || /\binsert\s+into\b/i.test(keywords)) {
        const pattern = /\bon\s+conflict\b(?:(?!\bon\s+conflict\b|\bdo\s+update\b|;)[\s\S])*?\bdo\s+nothing\b/gi
        for (const match of keywords.matchAll(pattern)) conflicts.push(start + match.index)
      }
      if (tagged) return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  for (const offset of new Set(conflicts)) check(offset)
  return violations
}

export function scanTree(root = ROOT) {
  const paths = execFileSync('git', ['ls-files', '-z', '--', 'engine', 'web', 'packages', 'schema', 'scripts', 'integrations'],
    { cwd: root, encoding: 'utf8' }).split('\0').filter((path) => SOURCE.test(path) && !EXCLUDED.test(path))
  return paths.flatMap((path) => unjustifiedConflicts(readFileSync(resolve(root, path), 'utf8'), path))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = scanTree()
  for (const hit of violations) console.error(`${hit.path}:${hit.line}: ignored insert conflict needs a nearby benign-conflict explanation`)
  if (violations.length) process.exitCode = 1
  else console.log('Insert conflict justification: no unexplained ignored writes.')
}
