import assert from 'node:assert/strict'
import test from 'node:test'
import { parseObjectSpecs } from './objects'

function parse(fields: unknown[]) {
  return parseObjectSpecs([{ path: 'objects/inspection.json', content: JSON.stringify({
    type: 'record_type', key: 'inspection', name: 'Inspection',
    fields: [{ id: 'details', fields }],
  }) }])
}

test('app objects refuse choice definitions whose options would be silently discarded', () => {
  const result = parse([{ id: 'status', type: 'select', label: 'Status', options: ['Planned', 'Completed'] }])
  assert.equal(result.recordTypes.length, 0)
  assert.match(result.errors.join('; '), /choice option/)
})

test('app objects enforce cross-field validation before publishing a record type', () => {
  const result = parse([{ id: 'name', type: 'text', label: 'Name' }, { id: 'name', type: 'text', label: 'Duplicate' }])
  assert.equal(result.recordTypes.length, 0)
  assert.match(result.errors.join('; '), /[Dd]uplicate/)
})

test('app objects preserve canonical choice values and labels', () => {
  const options = [{ value: 'planned', label: 'Planned' }, { value: 'completed', label: 'Completed' }]
  const field = { id: 'status', type: 'select', label: 'Status', validation: { options } }
  const result = parse([field])
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.recordTypes[0]?.fields, [{ id: 'details', fields: [field] }])
})
