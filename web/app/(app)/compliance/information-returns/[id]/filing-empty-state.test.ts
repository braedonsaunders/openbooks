import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

// F-t04-009: a computed 1099-NEC filing with 0 recipients kept showing the
// pre-compute "Nothing computed yet" empty state under the Computed banner.
// The empty state must distinguish never-computed (draft) from
// computed-with-no-recipients.
const MESSAGES = join(import.meta.dirname, '..', '..', '..', '..', '..', 'messages')
const LOCALES = ['en', 'es', 'fr']

for (const locale of LOCALES) {
  test(`${locale} labels the computed-with-no-recipients empty state`, () => {
    const catalog = JSON.parse(readFileSync(join(MESSAGES, locale, 'compliance.json'), 'utf8')) as {
      informationReturns?: Record<string, string>
    }
    const label = catalog.informationReturns?.computedNoRecipients
    assert.ok(label && label !== 'computedNoRecipients', `${locale} is missing compliance.informationReturns.computedNoRecipients`)
  })
}

test('the worksheet empty state respects a completed compute', () => {
  const source = readFileSync(new URL('./FilingWorksheet.tsx', import.meta.url), 'utf8')
  assert.match(source, /computedNoRecipients/)
})
