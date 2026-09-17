import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const messagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'messages')
const catalog = (locale: string, file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(messagesDir, locale, file), 'utf8'))

// F-x6-001 item 1: with no AI provider configured, the /assistant empty
// state rendered its heading in English under fr (and es) because the
// notConfiguredTitle key was never translated there. Every shipped locale
// must carry its own title — never the English fallback.
for (const locale of ['fr', 'es']) {
  test(`F-x6-001: assistant setup heading is translated in ${locale}`, () => {
    const value = catalog(locale, 'assistant.json').notConfiguredTitle
    const english = catalog('en', 'assistant.json').notConfiguredTitle
    assert.equal(typeof value, 'string', `${locale}/assistant.json must define notConfiguredTitle`)
    assert.ok(value.trim().length > 0, 'title must not be empty')
    assert.notEqual(value, english, 'title must not be the English fallback')
  })
}
