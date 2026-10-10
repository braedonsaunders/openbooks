import assert from 'node:assert/strict'
import test from 'node:test'
import { managesOthersTime, resolveNewTimesheetStart } from './new-timesheet.ts'

const OWN = '11111111-1111-4111-8111-111111111111'
const FIRST = '22222222-2222-4222-8222-222222222222'
const inScope = async (id: string) => id
const outOfScope = async () => null

test('a self-service time enterer is never handed another employee\'s week', async () => {
  const selfService = managesOthersTime((p) => ['time.self', 'time.clock'].includes(p))
  assert.equal(selfService, false)
  assert.deepEqual(
    await resolveNewTimesheetStart({ canManage: true, managesOthersTime: selfService, linkedEmployeeId: null, pinInScope: inScope, firstActiveEmployeeId: FIRST }),
    { employeeId: null, refusal: 'unlinked' },
  )
  assert.deepEqual(
    await resolveNewTimesheetStart({ canManage: true, managesOthersTime: selfService, linkedEmployeeId: OWN, pinInScope: outOfScope, firstActiveEmployeeId: FIRST }),
    { employeeId: null, refusal: 'linkedOutOfScope' },
  )
})

test('a linked login always starts its own week, manager or not', async () => {
  for (const manages of [true, false]) {
    assert.deepEqual(
      await resolveNewTimesheetStart({ canManage: true, managesOthersTime: manages, linkedEmployeeId: OWN, pinInScope: inScope, firstActiveEmployeeId: FIRST }),
      { employeeId: OWN, refusal: null },
    )
  }
})

test('only managers of other people\'s time seed from the first active employee', async () => {
  const manager = managesOthersTime((p) => ['time.manage', 'time.approve'].includes(p))
  assert.equal(manager, true)
  assert.equal(managesOthersTime((p) => ['time.self', 'time.approve', 'time.crew.enter'].includes(p)), false, 'entering anyone else\'s time needs time.manage')
  assert.deepEqual(
    await resolveNewTimesheetStart({ canManage: true, managesOthersTime: manager, linkedEmployeeId: null, pinInScope: inScope, firstActiveEmployeeId: FIRST }),
    { employeeId: FIRST, refusal: null },
  )
  assert.deepEqual(
    await resolveNewTimesheetStart({ canManage: true, managesOthersTime: manager, linkedEmployeeId: null, pinInScope: inScope, firstActiveEmployeeId: null }),
    { employeeId: null, refusal: 'noEmployees' },
    'an organization with no employees names that remedy instead of linking the page to itself',
  )
})

test('a reader without time.manage gets neither a target nor a refusal', async () => {
  assert.deepEqual(
    await resolveNewTimesheetStart({ canManage: false, managesOthersTime: false, linkedEmployeeId: OWN, pinInScope: inScope, firstActiveEmployeeId: FIRST }),
    { employeeId: null, refusal: null },
  )
})
