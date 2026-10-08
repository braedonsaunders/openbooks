import assert from 'node:assert/strict'
import test from 'node:test'
import { projectScheduleBody } from './project-schedule-input'

const projectId = '47df30a3-4fd1-4570-bb67-09641053ee3b'
const resourceId = '65fa9dc7-228f-4e19-8bf1-17d52efeb78d'

test('the task editor contract accepts native resource assignments and real effective dates', () => {
  const parsed = projectScheduleBody.parse({ projectId, action: 'createTask', input: {
    name: ' Inspect pump ', taskType: 'task', startDate: '2026-10-08', endDate: '2026-10-09',
    resourceAssignments: [{ resourceId, units: 1.5, role: 'Technician' }],
  } })
  assert.equal(parsed.action, 'createTask')
  if (parsed.action === 'createTask') assert.equal(parsed.input.name, 'Inspect pump')
})

test('blank tasks, nonexistent dates and untyped resource references refuse at the command boundary', () => {
  for (const input of [
    { name: ' ' }, { name: 'Task', startDate: '2026-02-30' },
    { name: 'Task', resourceAssignments: [{ resourceId: 'unknown', units: 1 }] },
    { name: 'Task', resourceAssignments: [{ resourceId, units: 0 }] },
    { name: 'Task', unexpected: true },
  ]) assert.equal(projectScheduleBody.safeParse({ projectId, action: 'createTask', input }).success, false)
  assert.equal(projectScheduleBody.safeParse({ projectId, action: 'updateTask', taskId: resourceId, patch: { name: '' } }).success, false)
})
