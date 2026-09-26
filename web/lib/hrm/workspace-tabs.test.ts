import assert from 'node:assert/strict'
import test from 'node:test'

const { hrmStripParentHref } = await import('./workspace-tabs.ts')

test('nested HRM pages select the parent job tab while keeping the query string out of the route match', () => {
  assert.equal(hrmStripParentHref('/hrm/benefits/enrolments?view=current'), '/hrm/compensation')
  assert.equal(hrmStripParentHref('/hrm/qualifications?employee=worker-7'), '/entities/employees')
  assert.equal(hrmStripParentHref('/hrm/surveys?tab=history'), '/hrm/performance')
  assert.equal(hrmStripParentHref('/hrm/positions/position-4?panel=applicants'), '/hrm/recruiting')
  assert.equal(hrmStripParentHref('/custom/unknown'), '/custom/unknown')
})
