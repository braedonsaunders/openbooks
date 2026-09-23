import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// A component that calls a client-only hook must itself be a client module.
// pagination.tsx called useReportOverlayOptional() without 'use client', and
// because a server ModuleView renders it, every paginated server page (/inbox,
// /close) fell into Next's error boundary. Derived, never hand-listed: every
// web module importing a use* hook from navigation-provider must carry the
// directive.
const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

const HOOK_IMPORT =
  /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*navigation-provider['"]/g

function importsClientHook(source: string): boolean {
  for (const match of source.matchAll(HOOK_IMPORT)) {
    const names = match[1]!.split(',').map((part) => part.trim().replace(/^type\s+/, ''))
    if (names.some((name) => /^use[A-Z]/.test(name))) return true
  }
  return false
}

function isClientModule(source: string): boolean {
  const firstStatement = source.replace(/^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '')
  return /^['"]use client['"]/.test(firstStatement)
}

test('every module calling a navigation-provider hook is a client module', () => {
  const offenders = walk(webRoot)
    .filter((path) => {
      const source = readFileSync(path, 'utf8')
      return importsClientHook(source) && !isClientModule(source)
    })
    .map((path) => relative(webRoot, path))
  assert.deepEqual(offenders, [], "these modules call client hooks without 'use client'")
})

test('the scan sees the pagination hook call it exists to protect', () => {
  const source = readFileSync(join(here, 'pagination.tsx'), 'utf8')
  assert.equal(importsClientHook(source), true)
  assert.equal(isClientModule(source), true)
})

// Every inbox source kind renders a translated label (view.ts looks up
// `kinds.<kind>`); a kind without one throws MISSING_MESSAGE at render.
// Derived from the engine's InboxKind union so a new source can't ship
// unlabelled.
test('every InboxKind has an inbox kind label in every locale', () => {
  const types = readFileSync(join(webRoot, '..', 'engine', 'src', 'inbox', 'types.ts'), 'utf8')
  const union = types.match(/export type InboxKind =([\s\S]*?);/)
  assert.ok(union, 'InboxKind union not found')
  const kinds = [...union[1]!.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!)
  assert.ok(kinds.length > 10, `expected the inbox kinds, found ${kinds.length}`)
  const messages = join(webRoot, 'messages')
  const locales = readdirSync(messages).filter((name) => statSync(join(messages, name)).isDirectory())
  const missing: string[] = []
  for (const locale of locales) {
    const catalog = JSON.parse(readFileSync(join(messages, locale, 'inbox.json'), 'utf8')) as {
      kinds?: Record<string, string>
    }
    for (const kind of kinds) {
      if (!catalog.kinds?.[kind]?.trim()) missing.push(`${locale}: kinds.${kind}`)
    }
  }
  assert.deepEqual(missing, [])
})
