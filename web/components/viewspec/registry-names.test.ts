import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { registryContracts } from '../../../scripts/widget-contracts-source.mjs'
import { FRAME_NAMES, WIDGET_NAMES } from './registry-names'

/**
 * `registry-names.ts` must say exactly what the registries contain.
 *
 * It is a mirror, and a mirror that drifts is worse than no mirror: it decides
 * whether a tenant- or agent-authored layout is accepted, so a stale entry
 * either rejects a widget that works or accepts one that throws mid-render.
 *
 * The comparison reads the registries from SOURCE rather than importing them.
 * Importing pulls a graph of ~200 React components into a plain node test —
 * which is the exact coupling the mirror exists to avoid, and reintroducing it
 * here to check the mirror would defeat the point.
 */

/** Keys declared directly on an object literal, ignoring nested ones. */
function registryKeys(source: string, declaration: string): string[] {
  const start = source.indexOf(declaration)
  assert.ok(start >= 0, `declaration not found: ${declaration}`)
  const open = source.indexOf('{', start)
  const keys: string[] = []
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const c = source[i]!
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      const from = i
      i++
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++
        i++
      }
      if (depth === 1 && /^\s*:/.test(source.slice(i + 1))) keys.push(source.slice(from + 1, i))
      continue
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i) + 1
      continue
    }
    if (c === '{' || c === '(' || c === '[') { depth++; continue }
    if (c === '}' || c === ')' || c === ']') { depth--; if (depth === 0) break; continue }
    if (depth === 1 && /[A-Za-z_$]/.test(c)) {
      const word = /^[A-Za-z0-9_$]+/.exec(source.slice(i))![0]
      if (/^\s*:/.test(source.slice(i + word.length))) keys.push(word)
      i += word.length - 1
    }
  }
  return keys
}

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

/**
 * Non-spread entries declared directly on the facade literal, with their value
 * text. This probes one literal only — it resolves no composition (the parser
 * above owns that) and exists solely for the layering guard below, which needs
 * the facade-local value bodies the contract parser does not expose.
 */
function facadeInlineEntries(source: string): Array<{ key: string; value: string }> {
  const start = source.indexOf('export const WIDGET_REGISTRY')
  assert.ok(start >= 0, 'WIDGET_REGISTRY not found in widgets.tsx')
  const out: Array<{ key: string; value: string }> = []
  const skip = (i: number): number => {
    const c = source[i]!
    if (c === '"' || c === "'" || c === '`') {
      i++
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') i++
        i++
      }
      return i + 1
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
      return i
    }
    if (c === '/' && source[i + 1] === '*') return source.indexOf('*/', i) + 2
    return i + 1
  }
  let depth = 0
  let i = source.indexOf('{', start)
  while (i < source.length) {
    const c = source[i]!
    if (c === '"' || c === "'" || c === '`' || (c === '/' && (source[i + 1] === '/' || source[i + 1] === '*'))) {
      const from = i
      const after = skip(i)
      if (depth === 1 && c !== '/' && /^\s*:/.test(source.slice(after))) {
        const key = source.slice(from + 1, after - 1)
        let v = after
        while (v < source.length && (/\s/.test(source[v]!) || source[v] === ':')) v++
        const valueStart = v
        let local = 0
        while (v < source.length) {
          const d = source[v]!
          if (d === '"' || d === "'" || d === '`' || (d === '/' && (source[v + 1] === '/' || source[v + 1] === '*'))) {
            v = skip(v)
            continue
          }
          if (local === 0 && (d === ',' || d === '}')) {
            v++
            break
          }
          if (d === '{' || d === '(' || d === '[') local++
          if (d === '}' || d === ')' || d === ']') local--
          v++
        }
        out.push({ key, value: source.slice(valueStart, v - 1) })
        i = v
        continue
      }
      i = after
      continue
    }
    if (c === '{' || c === '(' || c === '[') depth++
    if (c === '}' || c === ')' || c === ']') {
      depth--
      if (depth === 0) break
    }
    i++
  }
  return out
}

test('WIDGET_NAMES mirrors WIDGET_REGISTRY exactly', () => {
  // Composition is read with the generator's own parser — the same
  // missing/duplicate/cycle refusals that guard the prop contracts guard the
  // mirror, so the two cannot drift apart through parallel resolvers.
  const here = fileURLToPath(new URL('./widgets.tsx', import.meta.url))
  const derived = registryContracts(read('./widgets.tsx'), 'WIDGET_REGISTRY', here) as Record<
    string,
    { props: string[]; open: boolean }
  >
  assert.ok(Object.keys(derived).length > 300, 'the registry parse found almost nothing')
  const actual = Object.keys(derived)
  const missing = actual.filter((name) => !WIDGET_NAMES.has(name))
  const extra = [...WIDGET_NAMES].filter((name) => !actual.includes(name))
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] })
})

test('FRAME_NAMES mirrors FRAME_REGISTRY exactly', () => {
  const actual = registryKeys(read('./blocks.tsx'), 'const FRAME_REGISTRY')
  const missing = actual.filter((name) => !FRAME_NAMES.has(name))
  const extra = [...FRAME_NAMES].filter((name) => !actual.includes(name))
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] })
})

test('every name is a slug the spec schema will accept', () => {
  // The schema requires `^[a-z][a-z0-9-]*$`. A registry entry that cannot be
  // named by a spec is unreachable, which is a bug in the registry rather than
  // a fact about it.
  for (const name of [...WIDGET_NAMES, ...FRAME_NAMES]) {
    assert.match(name, /^[a-z][a-z0-9-]*$/, `${name} is not nameable from a spec`)
  }
})

/**
 * The registry stays a thin facade over cohesive families instead of
 * rotting back into a god file. The budgets below are the shape the split
 * promised: the facade composes, families render, and the layering runs one
 * way — a family that imports the facade (or its consumers) to reach the
 * registry it feeds has rebuilt the cycle the facade exists to break.
 */
test('the widget facade stays thin and families stay cohesive', () => {
  const facade = read('./widgets.tsx')
  const facadeLines = facade.split('\n').length
  assert.ok(
    facadeLines <= 200,
    `widgets.tsx is ${facadeLines} lines — the facade budget is 200; move renderers to a family`,
  )
  const dir = dirname(fileURLToPath(import.meta.url))
  for (const file of readdirSync(dir)
    .filter((name) => name.startsWith('widgets-') && name.endsWith('.tsx'))
    .sort()) {
    const source = read(`./${file}`)
    const lines = source.split('\n').length
    assert.ok(
      lines <= 500,
      `${file} is ${lines} lines — the family budget is 500; split the family before it becomes the god file again`,
    )
    for (const line of source.split('\n')) {
      const target = /from\s*'([^']+)'/.exec(line)?.[1]
      assert.ok(
        target !== './widgets' && target !== './widget-slot',
        `${file} imports '${target}' — family modules must never import the facade or its consumers`,
      )
    }
  }
})

test('facade-local entries are only the registry self-references', () => {
  // These four renderers resolve other widgets by name through WIDGET_REGISTRY
  // at render time, so they live beside the registry object. Any entry that
  // does not do that lookup belongs in a family module — the facade is
  // composition, not a second home for renderers.
  const inline = facadeInlineEntries(read('./widgets.tsx'))
  assert.ok(inline.length > 0, 'expected the documented facade-local entries')
  for (const entry of inline) {
    assert.ok(
      entry.value.includes('WIDGET_REGISTRY'),
      `'${entry.key}' is declared on the facade without resolving other widgets by name — move it to a family module`,
    )
  }
})
