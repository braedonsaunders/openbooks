import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const messagesDir = join(dir, '..', '..', '..', 'messages')
const locales = ['de', 'en', 'es', 'fr', 'ja', 'pt-BR', 'zh'] as const

const catalog = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(messagesDir, locale, 'ar.json'), 'utf8'))

function at(locale: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
      locale,
    )
}

// UX-01: /collections promised the overdue chase list (it borrowed the AR
// cockpit description) while rendering only recurring/subscription/dunning
// configuration. The page now describes itself as configuration and links to
// the real worklist on /ar. Every locale needs both strings — a missing key
// renders the raw path, and an English paste reads as a glitch.
for (const locale of locales) {
  test(`collections worklist copy exists in ${locale}`, () => {
    for (const key of ['collections.pageDescription', 'collections.worklistCta'] as const) {
      const value = at(catalog(locale), key)
      assert.equal(typeof value, 'string', `${locale} ${key} must exist`)
      assert.ok((value as string).trim().length > 0, `${locale} ${key} must not be empty`)
    }
  })
}

for (const locale of locales.filter((candidate) => candidate !== 'en')) {
  test(`collections worklist copy is translated in ${locale}`, () => {
    for (const key of ['collections.pageDescription', 'collections.worklistCta'] as const) {
      assert.notEqual(
        at(catalog(locale), key),
        at(catalog('en'), key),
        `${locale} ${key} must not be the English fallback`,
      )
    }
  })
}

const viewSource = readFileSync(join(dir, 'view.ts'), 'utf8')
const sectionsSource = readFileSync(join(dir, 'sections.tsx'), 'utf8')

test('the collections loader no longer borrows the AR worklist description', () => {
  assert.doesNotMatch(viewSource, /cockpit\.description/)
  assert.match(viewSource, /collections\.pageDescription/)
})

test('the collections spec binds the /ar worklist link into the shell', () => {
  assert.match(viewSource, /worklistHref/)
  assert.match(viewSource, /worklistLabel/)
  assert.match(viewSource, /'\/ar'/)
})

test('the collections shell links to the worklist when the reader may open it', () => {
  assert.match(sectionsSource, /worklistHref/)
  assert.match(sectionsSource, /href=\{worklistHref\}/)
  assert.match(sectionsSource, /\{worklistLabel\}/)
})
