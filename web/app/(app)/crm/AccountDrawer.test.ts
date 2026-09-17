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
