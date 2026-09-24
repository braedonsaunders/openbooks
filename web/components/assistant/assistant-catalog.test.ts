import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const messagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'messages')
const catalog = (locale: string, file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(messagesDir, locale, file), 'utf8'))

// F-x6-001 item 1: the /assistant empty state has English copy; catalog parity
// owns checking that every shipped locale translates the key.
const englishTitle: unknown = catalog('en', 'assistant.json').notConfiguredTitle

test('F-x6-001: assistant setup heading has English copy', () => {
  assert.equal(typeof englishTitle, 'string', 'English assistant.json must define notConfiguredTitle')
  assert.ok((englishTitle as string).trim().length > 0, 'title must not be empty')
})
