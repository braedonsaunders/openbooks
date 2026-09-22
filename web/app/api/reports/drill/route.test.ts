import assert from 'node:assert/strict'
import test from 'node:test'
import { reportDrillErrorResponse } from '../../../../lib/report-drill-error.ts'

test('a missing accounting book is a 422, not a crash', async () => {
  const error = new Error('Accounting book is unavailable. Choose an active accounting book.')
  error.name = 'ReportBookSelectionError'
  const response = reportDrillErrorResponse(error)
  assert.equal(response.status, 422)
  assert.match((await response.json() as { error: string }).error, /Choose an active accounting book/)
})

test('named report-drill refusals are 4xx and never a crash-logged 500', async () => {
  const cases: Array<{ message: string; status: number; error: string }> = [
    { message: 'report_not_found', status: 404, error: 'report_not_found' },
    { message: 'report_entity_not_found', status: 404, error: 'report_entity_not_found' },
    { message: 'scenario_not_found', status: 404, error: 'scenario_not_found' },
    { message: 'report_drill_scope_invalid', status: 400, error: 'report_drill_scope_invalid' },
    { message: 'report_entity_forbidden', status: 403, error: 'you do not have access to this data' },
  ]
  for (const expected of cases) {
    const response = reportDrillErrorResponse(new Error(expected.message))
    assert.equal(response.status, expected.status, expected.message)
    assert.deepEqual(await response.json(), { error: expected.error })
  }
})

test('unexpected drill defects stay report_drill_failed at 500', async () => {
  const response = reportDrillErrorResponse(new TypeError('cannot read columns of undefined'))
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { error: 'report_drill_failed' })
})
