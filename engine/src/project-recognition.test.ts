import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLaborPostingGroups } from './project-recognition.ts'
import { add, neg } from './money.ts'

test('labor posting groups preserve exact totals by work date and subsidiary', () => {
  const groups = buildLaborPostingGroups([
    { timeEntryId: 'a', projectId: 'p1', subsidiaryId: 's1', workedOn: '2026-01-31', standardCostAmount: '100.1234' },
    { timeEntryId: 'b', projectId: 'p1', subsidiaryId: 's1', workedOn: '2026-01-31', standardCostAmount: '20.0001' },
    { timeEntryId: 'c', projectId: 'p2', subsidiaryId: 's1', workedOn: '2026-01-31', standardCostAmount: '30.0000' },
    { timeEntryId: 'd', projectId: 'p1', subsidiaryId: 's1', workedOn: '2026-02-01', standardCostAmount: '40.0000' },
    { timeEntryId: 'e', projectId: 'p1', subsidiaryId: 's2', workedOn: '2026-01-31', standardCostAmount: '50.0000' },
  ])
  assert.equal(groups.length, 3)
  const januaryS1 = groups.find((group) => group.postingDate === '2026-01-31' && group.subsidiaryId === 's1')!
  assert.equal(januaryS1.byProject.get('p1'), '120.1235')
  assert.equal(januaryS1.byProject.get('p2'), '30.0000')
  assert.equal(januaryS1.total, '150.1235')
  assert.equal(add(januaryS1.total, neg(januaryS1.total)), '0.0000')
})

test('zero standard cost creates no posting group', () => {
  assert.deepEqual(buildLaborPostingGroups([
    { timeEntryId: 'a', projectId: 'p1', subsidiaryId: null, workedOn: '2026-01-31', standardCostAmount: '0.0000' },
  ]), [])
})
