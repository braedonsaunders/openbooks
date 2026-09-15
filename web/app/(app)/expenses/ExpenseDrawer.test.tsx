import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./ExpenseDrawer.tsx', import.meta.url), 'utf8')

test('expense voids carry the exact document revision token required by the void API', () => {
  assert.match(
    source,
    /\/void`,\s*\{\s*method:\s*'POST'[\s\S]*?JSON\.stringify\(\{\s*reason,\s*expectedUpdatedAt/,
    'the void action must echo the loaded revision: /api/documents/[id]/void answers 409 without it, so a token-less void can never succeed',
  )
})
