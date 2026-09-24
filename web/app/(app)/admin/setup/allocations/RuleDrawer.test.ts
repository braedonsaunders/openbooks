import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mergeLinesToTargets,
  targetToLine,
} from './rule-drawer-form'

// Weight splits round-trip through the editor lines exactly like percents:
// the line keeps the weight as text and the merge preserves the target's
// server-only fields. Hand-computed against the line shape, never through
// the drawer.
test('weight targets round-trip through editor lines as text', () => {
  const line = targetToLine({
    sequence: 0,
    targetAccountId: 'a9',
    departmentId: null,
    weight: '2',
    isRemainder: false,
    label: 'W',
  })
  assert.equal(line.accountId, 'a9')
  assert.deepEqual(line.portion, { kind: 'weight', value: '2' })
  assert.equal(line.label, 'W')
})

test('merging a weight line keeps the stored subsidiary and segment', () => {
  const line = targetToLine({ sequence: 0, weight: '2', isRemainder: false })
  const merged = mergeLinesToTargets(
    [{ sequence: 0, subsidiaryId: 's1', extraDims: { region: 'emea' }, label: 'old' }],
    [{ ...line, accountId: '' }],
  )
  assert.deepEqual(merged, [
    {
      sequence: 0,
      targetAccountId: null,
      departmentId: null,
      locationId: null,
      classId: null,
      projectId: null,
      subsidiaryId: 's1',
      extraDims: { region: 'emea' },
      fixedPercent: null,
      weight: '2',
      isRemainder: false,
      label: null,
    },
  ])
})
