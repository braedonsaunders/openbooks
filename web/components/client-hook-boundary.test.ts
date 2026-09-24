import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { INBOX_KINDS } from '../../engine/src/inbox/kinds'
import { LOCALES } from '../i18n/config'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('every InboxKind has an inbox kind label in every locale', () => {
  const messages = join(webRoot, 'messages')
  const missing: string[] = []
  for (const { code: locale } of LOCALES) {
    const catalog = JSON.parse(readFileSync(join(messages, locale, 'inbox.json'), 'utf8')) as {
      kinds?: Record<string, string>
    }
    for (const kind of INBOX_KINDS) {
      if (!catalog.kinds?.[kind]?.trim()) missing.push(`${locale}: kinds.${kind}`)
    }
  }
  assert.deepEqual(missing, [])
})
