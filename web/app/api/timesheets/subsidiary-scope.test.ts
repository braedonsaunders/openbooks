import assert from 'node:assert/strict'
import test from 'node:test'
import { subsidiaryScopeAllows } from '@openbooks/engine/src/organization/subsidiary-scope.ts'

test('timesheet subsidiary checks allow only the selected entity for restricted callers', () => {
  const scope = new Set(['subsidiary-a'])

  assert.equal(subsidiaryScopeAllows(scope, 'subsidiary-a'), true)
  assert.equal(subsidiaryScopeAllows(scope, 'subsidiary-b'), false)
  assert.equal(subsidiaryScopeAllows(scope, null), false)
  assert.equal(subsidiaryScopeAllows(new Set(), 'subsidiary-a'), false)
  assert.equal(subsidiaryScopeAllows(null, 'subsidiary-b'), true)
})
