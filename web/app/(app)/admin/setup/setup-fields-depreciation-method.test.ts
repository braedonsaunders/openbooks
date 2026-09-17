import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

// F-t07-004: the asset-category form rendered the raw
// admin.setup.fields.defaultDepreciationMethodId key — the generic setup
// surface labels every field via admin.setup.fields.<key> and this one was
// never added, even in English. Every locale must label it.
const MESSAGES = join(import.meta.dirname, '..', '..', '..', '..', 'messages')
const LOCALES = ['en', 'fr', 'de', 'es', 'pt-BR', 'ja', 'zh']

for (const locale of LOCALES) {
  test(`${locale} labels the generic setup depreciation-method field`, () => {
    const catalog = JSON.parse(readFileSync(join(MESSAGES, locale, 'admin.json'), 'utf8')) as {
      setup?: { fields?: Record<string, string> }
    }
    const label = catalog.setup?.fields?.defaultDepreciationMethodId
    assert.ok(
      label && label !== 'defaultDepreciationMethodId',
      `${locale} is missing admin.setup.fields.defaultDepreciationMethodId`,
    )
  })
}
