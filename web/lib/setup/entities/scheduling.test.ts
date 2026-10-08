import assert from 'node:assert/strict'
import test from 'node:test'
import { SCHEDULING_ENTITIES } from './scheduling'

test('board settings descriptors can cross the server/client boundary without executable hooks', () => {
  function assertSerializable(value: unknown): void {
    assert.notEqual(typeof value, 'function')
    if (value && typeof value === 'object') for (const child of Object.values(value)) assertSerializable(child)
  }
  assertSerializable(SCHEDULING_ENTITIES)
  assert.deepEqual(JSON.parse(JSON.stringify(SCHEDULING_ENTITIES)), SCHEDULING_ENTITIES)
})
