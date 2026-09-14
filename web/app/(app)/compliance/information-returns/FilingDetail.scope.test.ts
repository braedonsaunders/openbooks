import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./[id]/view.ts', import.meta.url), 'utf8')

test('information-return detail loader forwards subsidiary scope to the filing read', () => {
  assert.match(source, /loadFiling\(orgId,\s*id,\s*authz\.allowedSubsidiaryIds\)/)
  assert.doesNotMatch(source, /loadFiling\(orgId,\s*id\)/)
})
