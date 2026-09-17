import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

// F-t07-003 pickers: both drawers label the warehouse column through
// common.labels.warehouse — a missing key leaks a raw key into the grid
// (the F-t07-004 class of defect). Every locale must label it.
const MESSAGES = join(import.meta.dirname, '..', 'messages')
const LOCALES = ['en', 'fr', 'de', 'es', 'pt-BR', 'ja', 'zh']

for (const locale of LOCALES) {
  test(`${locale} labels the line warehouse picker`, () => {
    const catalog = JSON.parse(readFileSync(join(MESSAGES, locale, 'common.json'), 'utf8')) as {
      labels?: Record<string, string>
    }
    const label = catalog.labels?.warehouse
    assert.ok(label && label !== 'warehouse' && !label.includes('.'), `${locale} is missing common.labels.warehouse`)
  })
}
