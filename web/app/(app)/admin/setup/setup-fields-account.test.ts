import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { LOCALE_CODES as LOCALES } from "../../../../i18n/config"

// the information-return box-rules table and dialog rendered the
// raw fields.accountId key — the generic setup surface labels every field
// via admin.setup.fields.<key> and accountId was never added, even in
// English. Every locale must label it.
const MESSAGES = join(import.meta.dirname, '..', '..', '..', '..', 'messages')

for (const locale of LOCALES) {
  test(`${locale} labels the generic setup account field`, () => {
    const catalog = JSON.parse(readFileSync(join(MESSAGES, locale, 'admin.json'), 'utf8')) as {
      setup?: { fields?: Record<string, string> }
    }
    const label = catalog.setup?.fields?.accountId
    assert.ok(label && label !== 'accountId', `${locale} is missing admin.setup.fields.accountId`)
  })
}
