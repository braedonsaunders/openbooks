import assert from 'node:assert/strict'
import test from 'node:test'
import {
  preparedListSource,
  preparedListSources,
} from './prepared-sources'

/**
 * HR and self-service collections render through the shared registered
 * list. Each entry below names the authorized loader's collection field
 * and its stable identity field; the shared renderer refuses a spec whose
 * rows do not match, so a typo here fails loudly at render, never as a
 * silently empty table. All of these are loader-resolved windows, so the
 * browser never searches or reslices them again.
 */
const EXPECTED = {
  hrm_benefits_windows: {
    route: '/hrm/benefits',
    rowsField: 'windowRows',
    rowKeyField: 'id',
  },
  hrm_benefits_enrolments: {
    route: '/hrm/benefits',
    rowsField: 'enrollmentRows',
    rowKeyField: 'id',
  },
  hrm_compensation_bands: {
    route: '/hrm/compensation',
    rowsField: 'bands',
    rowKeyField: 'id',
  },
  hrm_compensation_cycles: {
    route: '/hrm/compensation',
    rowsField: 'cycles',
    rowKeyField: 'id',
  },
  hrm_compensation_plans: {
    route: '/hrm/compensation',
    rowsField: 'plans',
    rowKeyField: 'id',
  },
  hrm_compensation_cycle_lines: {
    route: '/hrm/compensation/cycles',
    rowsField: 'lines',
    rowKeyField: 'id',
  },
  hrm_compensation_plan_lines: {
    route: '/hrm/compensation/plans',
    rowsField: 'lines',
    rowKeyField: 'id',
  },
  hrm_compliance_findings: {
    route: '/hrm/compliance',
    rowsField: 'findings',
    rowKeyField: 'id',
  },
  hrm_compliance_schedules: {
    route: '/hrm/compliance',
    rowsField: 'schedules',
    rowKeyField: 'id',
  },
  hrm_compliance_runs: {
    route: '/hrm/compliance',
    rowsField: 'runs',
    rowKeyField: 'id',
  },
  hrm_compliance_classes: {
    route: '/hrm/compliance',
    rowsField: 'classes',
    rowKeyField: 'id',
  },
  hrm_compliance_entries: {
    route: '/hrm/compliance',
    rowsField: 'entries',
    rowKeyField: 'id',
  },
  hrm_qualifications_ledger: {
    route: '/hrm/qualifications',
    rowsField: 'rows',
    rowKeyField: 'id',
  },
  hrm_qualifications_requirements: {
    route: '/hrm/qualifications',
    rowsField: 'requirements',
    rowKeyField: 'id',
  },
  hrm_qualifications_coverage: {
    route: '/hrm/qualifications',
    rowsField: 'coverageRows',
    rowKeyField: 'employmentId',
  },
  hrm_qualifications_alerts: {
    route: '/hrm/qualifications',
    rowsField: 'alerts',
    rowKeyField: 'id',
  },
  me_overview_employments: {
    route: '/me',
    rowsField: 'employments',
    rowKeyField: 'employmentId',
  },
  me_overview_steps: {
    route: '/me',
    rowsField: 'steps',
    rowKeyField: 'id',
  },
  me_overview_requests: {
    route: '/me',
    rowsField: 'requests',
    rowKeyField: 'id',
  },
  me_overview_qualifications: {
    route: '/me',
    rowsField: 'qualifications',
    rowKeyField: 'id',
  },
  me_overview_pay: {
    route: '/me',
    rowsField: 'payStubs',
    rowKeyField: 'id',
  },
  me_benefits_elections: {
    route: '/me/benefits',
    rowsField: 'elections',
    rowKeyField: 'id',
  },
  me_benefits_windows: {
    route: '/me/benefits',
    rowsField: 'windows',
    rowKeyField: 'id',
  },
  me_compensation_statements: {
    route: '/me/compensation',
    rowsField: 'statements',
    rowKeyField: 'id',
  },
  me_one_on_ones_upcoming: {
    route: '/me/one-on-ones',
    rowsField: 'upcoming',
    rowKeyField: 'id',
  },
  me_one_on_ones_past: {
    route: '/me/one-on-ones',
    rowsField: 'past',
    rowKeyField: 'id',
  },
  me_one_on_ones_requests: {
    route: '/me/one-on-ones',
    rowsField: 'requests',
    rowKeyField: 'id',
  },
  me_reviews_self: {
    route: '/me/reviews',
    rowsField: 'selfRows',
    rowKeyField: 'reviewId',
  },
  me_reviews_shared: {
    route: '/me/reviews',
    rowsField: 'sharedRows',
    rowKeyField: 'reviewId',
  },
  me_reviews_goals: {
    route: '/me/reviews',
    rowsField: 'goalRows',
    rowKeyField: 'id',
  },
  me_team_roster: {
    route: '/me/team',
    rowsField: 'roster',
    rowKeyField: 'employmentId',
  },
  me_team_steps: {
    route: '/me/team',
    rowsField: 'teamSteps',
    rowKeyField: 'id',
  },
  me_team_leave: {
    route: '/me/team',
    rowsField: 'pendingLeave',
    rowKeyField: 'id',
  },
  me_team_changes: {
    route: '/me/team',
    rowsField: 'pendingChanges',
    rowKeyField: 'id',
  },
  me_team_owed: {
    route: '/me/team',
    rowsField: 'owedReviews',
    rowKeyField: 'reviewId',
  },
} as const

for (const [key, want] of Object.entries(EXPECTED)) {
  test(`hr/me collection source ${key} names its loader collection and identity`, () => {
    const source = preparedListSource(key)
    assert.equal(source.mode, 'loaded')
    assert.equal(source.clientSearch, false)
    assert.equal(source.route, want.route)
    assert.equal(source.rowsField, want.rowsField)
    assert.equal(source.rowKeyField, want.rowKeyField)
  })
}

test('hr/me collection sources stay distinct per collection', () => {
  const pairs = Object.entries(EXPECTED).map(
    ([key, want]) => `${preparedListSource(key).route} ${want.rowsField}`,
  )
  assert.equal(new Set(pairs).size, pairs.length)
  assert.ok(
    Object.keys(preparedListSources()).length >= Object.keys(EXPECTED).length,
  )
})
