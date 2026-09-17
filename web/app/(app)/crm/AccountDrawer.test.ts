import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./AccountDrawer.tsx', import.meta.url), 'utf8')

test('lead/prospect owner picker uses the translated crm unassigned label', () => {
  assert.doesNotMatch(
    source,
    /labels\.unassigned/,
    'the owner empty option must not reference common.labels.unassigned: the key exists in no locale, so the picker renders the raw key',
  )
  assert.match(
    source,
    /\{t\('unassigned'\)\}/,
    'the owner empty option must use the reviewed crm.unassigned label shipped in every locale',
  )
})

test('lead/prospect first save carries the party revision token', () => {
  assert.match(
    source,
    /fetch\(`\/api\/parties\/\$\{party\.id\}`[\s\S]*?expectedUpdatedAt:\s*party\.updated_at/,
    'the identity PATCH must echo the loaded updated_at revision: /api/parties/[id] answers 409 without it, so a token-less first save can never succeed',
  )
})
