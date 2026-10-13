import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { LOCALES } from '../i18n/config.ts'

const MESSAGES_DIR = join(import.meta.dirname)

/**
 * Object keys repeated inside one JSON object, by dotted path. JSON.parse
 * keeps the last occurrence silently, so a repeated key hides whichever
 * translation was written first.
 */
function repeatedKeys(text: string): string[] {
  const repeats: string[] = []
  const path: string[] = []
  const seen: Array<Set<string>> = []
  let pendingKey: string | null = null
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      let j = i + 1
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      const value = JSON.parse(text.slice(i, j + 1)) as string
      let k = j + 1
      while (/\s/.test(text[k] ?? '')) k += 1
      if (text[k] === ':' && seen.length > 0) {
        const keys = seen[seen.length - 1]!
        if (keys.has(value)) repeats.push([...path, value].join('.'))
        keys.add(value)
        pendingKey = value
      }
      i = j + 1
      continue
    }
    if (ch === '{') {
      path.push(pendingKey ?? '')
      seen.push(new Set())
      pendingKey = null
    } else if (ch === '}') {
      path.pop()
      seen.pop()
    } else if (ch === ',' || ch === '[') {
      pendingKey = null
    }
    i += 1
  }
  return repeats.map((key) => key.replace(/^\./, ''))
}

test('every catalog declares each key once per object', () => {
  const repeats: string[] = []
  for (const { code: locale } of LOCALES) {
    const dir = join(MESSAGES_DIR, locale)
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
      for (const key of repeatedKeys(readFileSync(join(dir, file), 'utf8'))) repeats.push(`${locale}/${file}: ${key}`)
    }
  }
  assert.deepEqual(repeats, [])
})

test('the scan reports a repeated key at its nested path', () => {
  assert.deepEqual(repeatedKeys('{"a":{"b":"x","c":"y","b":"z"},"d":["e"]}'), ['a.b'])
  assert.deepEqual(repeatedKeys('{"a":{"b":"x"},"c":{"b":"y"}}'), [])
})
