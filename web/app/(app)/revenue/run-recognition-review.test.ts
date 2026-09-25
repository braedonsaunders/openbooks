import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

// Published locale catalogs are the external contract for the review UI.
test('the review catalog is translated in every locale', () => {
  const messages = new URL('../../../messages/', import.meta.url)
  const locales = readdirSync(messages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  assert.ok(locales.length >= 7, 'every shipped locale is covered')
  const base = Object.keys(
    JSON.parse(readFileSync(new URL('en/revenue.json', messages), 'utf8')).review,
  ).sort()
  assert.ok(base.length > 0, 'the review catalog exists')
  for (const locale of locales) {
    const catalog = JSON.parse(readFileSync(new URL(`${locale}/revenue.json`, messages), 'utf8'))
    assert.deepEqual(Object.keys(catalog.review ?? {}).sort(), base, `${locale} carries every review key`)
  }
})
