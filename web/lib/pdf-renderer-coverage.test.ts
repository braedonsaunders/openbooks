import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const webRoot = join(repoRoot, 'web')

/**
 * Every API route that can reach the Chromium PDF renderer must answer a
 * renderer outage with the named 503 refusal (rendererUnavailableResponse,
 * isRendererUnavailable, or rendererStatusResponse for bulk routes that
 * cannot map a thrown error) — never a generic 500/422 or an unhandled
 * throw.
 *
 * The route list is DERIVED, not hand-listed: seeds are the files that call
 * the two Chromium render entry points (renderHtmlDocumentPdf,
 * mergeAndPrintPdf), reachability is tracked per exported SYMBOL (so a route
 * importing a non-render helper from a render module — payroll settings
 * importing stubPasswordPolicy from payroll-outputs — does NOT flag), and
 * every route whose static import closure reaches a render-capable symbol
 * must reference the mapper. A new route that renders a PDF without mapping
 * the outage fails here until it maps it.
 *
 * Notes on precision:
 * - Imports resolve through re-export barrels by NAME, so a route importing
 *   pdfkit-only helpers from '@openbooks/pdf' (report-pdf.ts) does NOT flag:
 *   only the Chromium entry names lead to the seed modules.
 * - Dynamic import() is ignored: the one dynamic render-module load among
 *   routes (documents/actions → invoice-backup) uses requireInvoiceBackup,
 *   which checks packet existence and never renders. A dynamic import that
 *   DOES render from a route would need its own mapping assertion.
 * - web/instrumentation.node.ts renders (flow PDF attachments) but is a
 *   background cron, not a route: the typed error propagates with its remedy
 *   in the message rather than mapping to an HTTP status.
 */

const RENDER_ENTRIES = new Set(['renderHtmlDocumentPdf', 'mergeAndPrintPdf'])
const MAPPER_RE = /rendererUnavailableResponse|isRendererUnavailable|rendererStatusResponse/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

const sourceCache = new Map<string, string>()
function source(path: string): string {
  let text = sourceCache.get(path)
  if (text === undefined) {
    text = readFileSync(path, 'utf8')
    sourceCache.set(path, text)
  }
  return text
}

/** All non-test sources that can participate in the web import graph. */
const graphFiles = walk(webRoot)
  .concat(walk(join(repoRoot, 'packages', 'pdf', 'src')))
  .concat(walk(join(repoRoot, 'engine', 'src')))
const graphSet = new Set(graphFiles)

function probe(candidate: string): string | null {
  if (graphSet.has(candidate)) return candidate
  return null
}

/** Resolve an import specifier to a graph file, or null for externals. */
function resolveSpecifier(importer: string, spec: string): string | null {
  if (spec === 'server-only' || spec.startsWith('node:') || spec.startsWith('data:')) return null
  if (spec.startsWith('@/')) {
    return probe(join(webRoot, `${spec.slice(2)}.ts`)) ?? probe(join(webRoot, spec.slice(2), 'index.ts'))
  }
  if (spec.startsWith('.')) {
    const base = resolve(dirname(importer), spec)
    return probe(base) ?? probe(`${base}.ts`) ?? probe(join(base, 'index.ts'))
  }
  if (spec === '@openbooks/pdf') return probe(join(repoRoot, 'packages', 'pdf', 'src', 'index.ts'))
  if (spec.startsWith('@openbooks/pdf/')) {
    return probe(join(repoRoot, 'packages', 'pdf', 'src', `${spec.slice('@openbooks/pdf/'.length)}.ts`))
  }
  if (spec.startsWith('@openbooks/engine/')) {
    const rest = spec.slice('@openbooks/engine/'.length)
    return probe(join(repoRoot, 'engine', rest)) ?? probe(join(repoRoot, 'engine', `${rest}.ts`))
  }
  const officeMatch = /^@openbooks\/([^/]+)\/(.+)$/.exec(spec)
  if (officeMatch) {
    const [, pkg, rest] = officeMatch as unknown as [string, string, string]
    return probe(join(repoRoot, 'packages', pkg, rest)) ?? probe(join(repoRoot, 'packages', pkg, `${rest}.ts`))
  }
  // External packages (next/server, drizzle-orm, next-intl, …).
  return null
}

interface ReExport {
  names: Map<string, string> | null // null = export *; else local -> original
  from: string
}

function reExports(text: string): ReExport[] {
  const out: ReExport[] = []
  for (const match of text.matchAll(/export\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
    out.push({ names: null, from: match[1]! })
  }
  for (const match of text.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = new Map<string, string>()
    for (const part of match[1]!.split(',')) {
      const alias = /^\s*([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(part)
      if (alias) names.set(alias[2]!, alias[1]!)
      else {
        const plain = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(part)
        if (plain) names.set(plain[1]!, plain[1]!)
      }
    }
    out.push({ names, from: match[2]! })
  }
  return out
}

/** Local `export { A as B }` aliases (no from): local -> exported. */
function localExportAliases(text: string): Array<{ local: string; exported: string }> {
  const out: Array<{ local: string; exported: string }> = []
  for (const match of text.matchAll(/export\s*\{([^}]*)\}(?!\s*from\s*['"])/g)) {
    for (const part of match[1]!.split(',')) {
      const alias = /^\s*([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(part)
      if (alias) out.push({ local: alias[1]!, exported: alias[2]! })
      else {
        const plain = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(part)
        if (plain) out.push({ local: plain[1]!, exported: plain[1]! })
      }
    }
  }
  return out
}

function localValueDefs(text: string): Set<string> {
  const names = new Set<string>()
  for (const match of text.matchAll(/export\s+(?:async\s+)?(?:function|const|class|enum)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]!)
  }
  return names
}

/**
 * Follow one imported name to the file that defines it, threading through
 * re-export barrels. Falls back to the barrel itself when the name cannot be
 * threaded (a conservative edge).
 */
function resolveName(file: string, name: string, seen: Set<string> = new Set()): { file: string; name: string } {
  if (seen.has(`${file}::${name}`)) return { file, name }
  seen.add(`${file}::${name}`)
  const text = source(file)
  if (localValueDefs(text).has(name)) return { file, name }
  if (localExportAliases(text).some((alias) => alias.exported === name)) return { file, name }
  for (const re of reExports(text)) {
    if (re.names !== null && !re.names.has(name)) continue
    const target = resolveSpecifier(file, re.from)
    if (!target) continue
    const original = re.names?.get(name) ?? name
    const resolved = resolveName(target, original, seen)
    // `export *` that does not define the name: keep the barrel as the
    // conservative fallback.
    if (re.names === null && resolved.file === target && !localValueDefs(source(target)).has(original)) {
      return { file, name }
    }
    return resolved
  }
  return { file, name }
}

interface NamedImport {
  original: string
  local: string
  spec: string
}

function namedImports(text: string): NamedImport[] {
  const out: NamedImport[] = []
  for (const match of text.matchAll(/^[ \t]*import\s+(?!type\b)([^;]*?)\s+from\s*['"]([^'"]+)['"]/gm)) {
    const clause = match[1]!.trim()
    const spec = match[2]!
    const named = /\{([^}]*)\}/.exec(clause)
    if (!named) continue // default / namespace / side-effect imports
    for (const part of named[1]!.split(',')) {
      const trimmed = part.trim().replace(/^type\s+/, '')
      if (!trimmed || trimmed.startsWith('type ')) continue
      const alias = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(trimmed)
      if (alias) out.push({ original: alias[1]!, local: alias[2]!, spec })
      else {
        const plain = /^([A-Za-z_$][\w$]*)$/.exec(trimmed)
        if (plain) out.push({ original: plain[1]!, local: plain[1]!, spec })
      }
    }
  }
  return out
}

function callsRenderEntry(text: string): boolean {
  return [...RENDER_ENTRIES].some((entry) => new RegExp(`\\b${entry}\\s*\\(`).test(text))
}

/**
 * Split a seed file into segments at top-level `export` boundaries. A
 * segment matches when it calls a render entry or references an
 * already-render-capable name; every value defined in a matching segment is
 * render-capable. Fixpointed globally with the import closure below.
 */
function fileSegments(text: string): string[] {
  const starts: number[] = []
  for (const match of text.matchAll(/^export\s/mg)) starts.push(match.index ?? 0)
  if (starts.length === 0) return [text]
  const segments: string[] = []
  if (starts[0]! > 0) segments.push(text.slice(0, starts[0]))
  for (let i = 0; i < starts.length; i += 1) {
    segments.push(text.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : undefined))
  }
  return segments
}

function topLevelDefs(segment: string): Set<string> {
  const names = new Set<string>()
  for (const match of segment.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|const|class|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]!)
  }
  return names
}

function wordRef(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(text)
}

test('every route reaching the Chromium renderer maps the outage to the named 503', () => {
  const seeds = graphFiles.filter((file) => callsRenderEntry(source(file)))
  assert.ok(seeds.length > 0, 'no render entry callers found — the seed scan rotted')
  const seedSet = new Set(seeds)

  // capable: file -> render-capable local names. Fixpoint over segments (seed
  // files) and the import/re-export closure (every file).
  const capable = new Map<string, Set<string>>()
  const get = (file: string): Set<string> => {
    let set = capable.get(file)
    if (!set) {
      set = new Set()
      capable.set(file, set)
    }
    return set
  }
  const allCapableNames = (): Set<string> => {
    const names = new Set<string>(RENDER_ENTRIES)
    for (const set of capable.values()) for (const name of set) names.add(name)
    return names
  }

  for (let round = 0; round < 20; round += 1) {
    let changed = false
    const known = allCapableNames()
    const add = (file: string, name: string): void => {
      const set = get(file)
      if (!set.has(name)) {
        set.add(name)
        changed = true
      }
    }
    // Seed segments: a segment calling a render entry (or referencing a
    // render-capable name) makes every top-level value it defines
    // render-capable. topLevelDefs only matches value definitions
    // (function/const/class/enum — never interface/type), so a type sharing
    // a segment with render code stays non-capable: importing it for an
    // annotation is not reaching the renderer.
    for (const file of seedSet) {
      for (const segment of fileSegments(source(file))) {
        const matches =
          callsRenderEntry(segment) || [...known].some((name) => name !== '' && wordRef(segment, name))
        if (!matches) continue
        for (const name of topLevelDefs(segment)) add(file, name)
      }
    }
    // Import closure: a local name is render-capable when the name it
    // resolves to is render-capable where it is defined.
    for (const file of graphFiles) {
      const text = source(file)
      for (const imp of namedImports(text)) {
        const target = resolveSpecifier(file, imp.spec)
        if (!target) continue
        const resolved = resolveName(target, imp.original)
        if (get(resolved.file).has(resolved.name)) add(file, imp.local)
      }
      for (const alias of localExportAliases(text)) {
        if (get(file).has(alias.local)) add(file, alias.exported)
      }
      for (const re of reExports(text)) {
        const target = resolveSpecifier(file, re.from)
        if (!target) continue
        if (re.names === null) {
          for (const name of get(target)) add(file, name)
        } else {
          for (const [local, original] of re.names) {
            const resolved = resolveName(target, original)
            if (get(resolved.file).has(resolved.name)) add(file, local)
          }
        }
      }
    }
    if (!changed) break
  }

  const routes = graphFiles.filter(
    (file) => file.startsWith(join(webRoot, 'app', 'api')) && file.endsWith('/route.ts'),
  )
  const flagged = routes.filter((file) => get(file).size > 0)
  assert.ok(flagged.length > 0, 'no API routes reach the renderer — the derivation rotted')
  const unmapped = flagged.filter((file) => !MAPPER_RE.test(source(file)))
  assert.deepEqual(
    unmapped.map((file) => file.slice(webRoot.length + 1)).sort(),
    [],
    'routes reaching the Chromium renderer must map RendererUnavailableError via rendererUnavailableResponse/isRendererUnavailable/rendererStatusResponse',
  )
})
