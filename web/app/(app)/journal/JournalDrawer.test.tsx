import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./JournalDrawer.tsx', import.meta.url), 'utf8')

test('journal voids carry the revision token required by the void API', () => {
  assert.match(
    source,
    /\/void`,\s*\{[\s\S]*?JSON\.stringify\(\{\s*reason,\s*expectedUpdatedAt/,
    'the void action must echo the canonical revision: /api/documents/[id]/void answers 409 without it, so a token-less void can never succeed',
  )
})
