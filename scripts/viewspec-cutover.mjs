#!/usr/bin/env node
/**
 * Delete the native render branch from every converted page.
 *
 * During the conversion each page carried two implementations: the original
 * JSX, and a `?__viewspec=1` branch rendering the spec. That was deliberate —
 * the native branch is the control the conformance harness diffs against, and
 * without it the comparison has nothing to say. Once every page is green and
 * the golden baseline is captured, the control has done its job and the second
 * implementation is just a second implementation.
 *
 * The transform, per page:
 *   - keep everything before the `__viewspec` guard (param unwrapping)
 *   - unwrap the guard's body: it becomes the whole component
 *   - delete the native branch that followed it
 *   - drop imports nothing references any more
 *
 * The `<meta name="x-viewspec-render">` marker STAYS. It stops being a
 * branch selector and becomes a staleness guard: with one implementation left,
 * a server running a pre-cutover build serves the old native page at the same
 * url, and that page would diff cleanly against a golden captured from the
 * native branch. The marker is the only thing that tells those two apart.
 *
 *   node scripts/viewspec-cutover.mjs --check      # report, change nothing
 *   node scripts/viewspec-cutover.mjs <file>...    # transform named files
 *   node scripts/viewspec-cutover.mjs              # transform every page
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const GUARD = /^[ \t]*if \(\s*(?:searchParams && )?\(?await searchParams\)?\??\.__viewspec === ['"]1['"]\s*\) \{|^[ \t]*if \(sp0?\.__viewspec === ['"]1['"]\) \{/m

/** Index just past the `{` that opens the enclosing block, and its match. */
function matchBrace(src, openIndex) {
  let depth = 0
  for (let i = openIndex; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++
        i++
      }
      continue
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

function transform(src, file) {
  const guard = src.match(GUARD)
  if (!guard) return { skipped: 'no __viewspec guard' }
  const guardStart = guard.index
  const guardOpen = src.indexOf('{', guardStart)
  const guardEnd = matchBrace(src, guardOpen)
  if (guardEnd < 0) return { skipped: 'unbalanced guard' }

  // The enclosing function: scan back for `export default async function`.
  const fnStart = src.lastIndexOf('export default', guardStart)
  if (fnStart < 0) return { skipped: 'no default export before guard' }
  const fnOpen = src.indexOf('{', src.indexOf(')', src.indexOf('(', fnStart)))
  const bodyOpen = (() => {
    // The component's body brace is the first `{` at depth 0 after the
    // parameter list AND after any return-type annotation.
    let i = fnStart
    let depth = 0
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') depth--
      else if (src[i] === '{' && depth === 0) return i
    }
    return -1
  })()
  if (bodyOpen < 0 || bodyOpen > guardStart) return { skipped: 'could not find body brace' }
  const bodyEnd = matchBrace(src, bodyOpen)
  if (bodyEnd < 0) return { skipped: 'unbalanced body' }

  const preamble = src.slice(bodyOpen + 1, guardStart)          // param unwrapping
  const inner = src.slice(guardOpen + 1, guardEnd)              // the spec render
  const dedented = inner.replace(/^ {4}/gm, '  ').replace(/^\n/, '')
  const body = `${preamble.replace(/\s+$/, '')}\n${dedented.replace(/\s+$/, '')}\n`

  let out = src.slice(0, bodyOpen + 1) + body + src.slice(bodyEnd)

  out = out.replace(
    /\{\/\* Proof-of-path marker for the conformance harness; hoisted to <head>\. \*\/\}/g,
    '{/* Hoisted to <head>. The conformance harness reads it to tell a current\n          build from a pre-cutover one still serving the old native page. */}',
  )
  return { out }
}

/** The file with comments and string literals blanked out.
 *
 *  Usage has to be judged against CODE. The first version of this tested the
 *  raw text, and kept three imports on the banking page alive because a
 *  trailing comment — itself made stale by this very transform — still named
 *  them. An import retained by a comment is dead code with a citation. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
}

/** Drop imported bindings the transformed file no longer mentions. */
function pruneImports(src) {
  const lines = src.split('\n')
  const kept = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+(['"][^'"]+['"])/)
    if (!m) {
      const d = line.match(/^import\s+(type\s+)?(\w+)(?:\s*,\s*\{([^}]*)\})?\s+from\s+(['"][^'"]+['"])/)
      if (d && !d[3]) {
        const rest = codeOnly(src.replace(line, ''))
        if (!new RegExp(`\\b${d[2]}\\b`).test(rest)) continue
      }
      kept.push(line)
      continue
    }
    const rest = codeOnly(src.replace(line, ''))
    const names = m[2]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
      .filter((n) => {
        const local = n.split(/\s+as\s+/).pop().trim().replace(/^type\s+/, '')
        return new RegExp(`\\b${local.replace(/[$]/g, '\\$')}\\b`).test(rest)
      })
    if (names.length === 0) continue
    kept.push(`import ${m[1] ?? ''}{ ${names.join(', ')} } from ${m[3]}`)
  }
  return kept.join('\n')
}

const args = process.argv.slice(2)
const check = args.includes('--check')
const files = args.filter((a) => !a.startsWith('--'))
const targets = files.length
  ? files
  : execSync(`grep -rl "__viewspec" "web/app/(app)" --include=page.tsx`, { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)

let done = 0
const skipped = []
for (const file of targets) {
  const src = readFileSync(file, 'utf8')
  const { out, skipped: why } = transform(src, file)
  if (why) { skipped.push(`${file}: ${why}`); continue }
  const pruned = pruneImports(out)
  if (!check) writeFileSync(file, pruned)
  done++
}
console.log(`${check ? 'would transform' : 'transformed'}: ${done}`)
if (skipped.length) {
  console.log(`skipped: ${skipped.length}`)
  for (const s of skipped) console.log(`  ${s}`)
}
