import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * Structural guards on the translation catalogs.
 *
 * These exist because the failure they catch is SILENT: the app renders the key
 * path itself ("payroll.wizard.readiness.codes.statutory.taxYear") in place of
 * the sentence, which reads as a rendering glitch rather than as a missing
 * translation, and nothing fails until somebody looks at that exact screen.
 */

const MESSAGES = join(import.meta.dirname, '..', 'messages')

const locales = readdirSync(MESSAGES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)

const catalogs = locales.flatMap((locale) =>
  readdirSync(join(MESSAGES, locale))
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({ locale, file, path: join(MESSAGES, locale, file) })),
)

/** Every key in a catalog, as the dotted path a caller would pass to `t()`. */
function walk(
  node: unknown,
  path: string[],
  visit: (key: string, path: string[], value: unknown) => void,
): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    visit(key, [...path, key], value)
    walk(value, [...path, key], visit)
  }
}

test('the catalogs are non-empty and every one parses', () => {
  assert.ok(locales.includes('en'), 'English is the source catalog and must exist')
  assert.ok(catalogs.length > 0, 'no message catalogs were found')
  for (const { path, file, locale } of catalogs) {
    assert.doesNotThrow(
      () => JSON.parse(readFileSync(path, 'utf8')),
      `${locale}/${file} is not valid JSON`,
    )
  }
})

test('no message key contains a dot, because next-intl resolves dots by nesting', () => {
  // `t('a.b')` looks up `{ a: { b } }`, NEVER a literal `"a.b"` key. A flat
  // dotted key is therefore unreachable — it looks correct in the file, passes
  // review, and renders the raw path on screen. Two separate payroll slices
  // have shipped one; this is the check that stops the third.
  const offenders: string[] = []
  for (const { locale, file, path } of catalogs) {
    walk(JSON.parse(readFileSync(path, 'utf8')), [], (key, keyPath) => {
      if (key.includes('.')) offenders.push(`${locale}/${file}: ${keyPath.join('.')}`)
    })
  }
  assert.deepEqual(
    offenders,
    [],
    `these keys can never be resolved — nest them instead:\n${offenders.join('\n')}`,
  )
})

test('no message value is an empty string', () => {
  // An empty string is indistinguishable from a rendered-but-blank label, and
  // next-intl treats it as present, so the English fallback never fires.
  const blanks: string[] = []
  for (const { locale, file, path } of catalogs) {
    walk(JSON.parse(readFileSync(path, 'utf8')), [], (_key, keyPath, value) => {
      if (typeof value === 'string' && value.trim() === '') {
        blanks.push(`${locale}/${file}: ${keyPath.join('.')}`)
      }
    })
  }
  assert.deepEqual(blanks, [], `these keys resolve to nothing:\n${blanks.join('\n')}`)
})
