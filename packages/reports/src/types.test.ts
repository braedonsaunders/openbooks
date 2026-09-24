import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { pickUuid } from './types'

test('pickUuid keeps real UUIDs, either case', () => {
  assert.equal(pickUuid('00000000-0000-4000-8000-000000000001'), '00000000-0000-4000-8000-000000000001')
  assert.equal(pickUuid('A8098C1A-F86E-11DA-BD1A-00112444BE52'), 'A8098C1A-F86E-11DA-BD1A-00112444BE52')
})

test('pickUuid drops 36-character non-UUIDs the old shape kept', () => {
  assert.equal(pickUuid('-'.repeat(36)), null)
  assert.equal(pickUuid('0'.repeat(36)), null)
  assert.equal(pickUuid('000000000000400080000000000000010000'), null)
})

test('pickUuid drops empty and non-string inputs', () => {
  assert.equal(pickUuid(''), null)
  assert.equal(pickUuid(null), null)
  assert.equal(pickUuid(undefined), null)
  assert.equal(pickUuid(42), null)
  assert.equal(pickUuid({}), null)
})
