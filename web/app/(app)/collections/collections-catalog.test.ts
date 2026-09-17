import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const messagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'messages')
const catalog = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(messagesDir, locale, 'ar.json'), 'utf8'))

function leaves(value: unknown, prefix: string, out: Array<[string, string]>) {
  if (typeof value === 'string') out.push([prefix, value])
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) leaves(child, prefix ? `${prefix}.${key}` : key, out)
  }
}

function at(locale: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (
    node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined
  ), locale)
}

// F-x6-001 item 3: the /collections recurring surface (tabs, form, table,
// empty state) rendered entirely in English under fr because fr/ar.json had
// no collections section at all. Every English string in the filed surface
// must have a real fr translation.
const sections = ['tabs', 'errors', 'recurring'] as const
// Document-number examples, proper nouns, and words spelled identically in
// French ("Cadence", "Cron") are the same string in every locale.
const LOCALE_INVARIANT = new Set([
  'recurring.templateDocPlaceholder',
  'recurring.cronLabel',
  'recurring.cadenceLabel',
  'recurring.table.cadence',
])
for (const section of sections) {
  test(`F-x6-001: collections.${section} is translated in fr`, () => {
    const en = catalog('en')
    const fr = catalog('fr')
    const wanted: Array<[string, string]> = []
    leaves(at(en, `collections.${section}`), '', wanted)
    assert.ok(wanted.length > 0, `en collections.${section} must exist as reference`)
    for (const [path, english] of wanted) {
      const value = at(fr, `collections.${section}.${path}`)
      assert.equal(typeof value, 'string', `fr collections.${section}.${path} must be translated`)
      assert.ok((value as string).trim().length > 0, `fr collections.${section}.${path} must not be empty`)
      if (!LOCALE_INVARIANT.has(`${section}.${path}`)) {
        assert.notEqual(value, english, `fr collections.${section}.${path} must not be the English fallback`)
      }
    }
  })
}
