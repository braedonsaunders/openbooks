import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
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

test('WIDGET_NAMES mirrors WIDGET_REGISTRY exactly', () => {
  const actual = registryKeys(read('./widgets.tsx'), 'export const WIDGET_REGISTRY')
  assert.equal(new Set(actual).size, actual.length, 'the registry must not declare a key twice')
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
