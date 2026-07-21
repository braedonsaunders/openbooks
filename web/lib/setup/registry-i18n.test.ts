import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { SETUP_ENTITIES } from './registry'

const MESSAGE_ROOT = fileURLToPath(new URL('../../messages/', import.meta.url))

test('every setup registry field has a label in every shipped locale', () => {
  const fieldKeys = new Set(
    SETUP_ENTITIES.flatMap((entity) => [...entity.columns, ...entity.fields].map((field) => field.key)),
  )

  for (const locale of ['en', 'fr', 'es']) {
    const messages = JSON.parse(
      readFileSync(`${MESSAGE_ROOT}${locale}/admin.json`, 'utf8'),
    ) as { setup: { fields: Record<string, string> } }
    const missing = [...fieldKeys].filter((key) => !(key in messages.setup.fields))
    assert.deepEqual(missing, [], `${locale} is missing setup field labels`)
  }
})
