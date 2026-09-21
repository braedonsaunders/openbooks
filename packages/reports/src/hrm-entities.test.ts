import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { REPORT_ENTITIES, REPORT_ENTITY_MAP } from './entities'
import { HRM_REPORT_ENTITIES } from './hrm-entities'
import { REPORT_AS_OF } from './report-as-of'
import { compileCustomQuery } from './custom-query'
import { BUILT_IN_REPORT_DEFINITION_MAP } from './built-ins'
import { validateCustomQuery } from './validate'

// Slice G pins: the workforce entities ride the shared catalog (and
// therefore the builder, saved views and card studio, which all derive from
// REPORT_ENTITIES), each behind the hrm feature gate and its domain read
// permission — enforced generically at every run path, so the pins below
// assert the declaration, never a private gate. The process checklist
// entity (0193) carries hrm.process.read: checklist state is governed by
// the process gate, not the employment one.

const HRM_KEYS = [
  'hrm_headcount',
  'hrm_employment_history',
  'hrm_change_requests',
  'hrm_positions',
  'hrm_processes',
  'hrm_leave_absences',
  'hrm_requisitions',
  'hrm_applications',
  'hrm_reviews',
  'hrm_goals',
  'hrm_turnover',
  'hrm_benefit_enrollments',
  'automations',
  'automation_runs',
  'hrm_action_reasons',
  'hrm_rate_schedule_lines',
  'hrm_per_diem_entries',
  'hrm_comp_class_split',
  'hrm_certified_runs',
  'hrm_compliance_findings',
  'hrm_pay_bands',
  'hrm_comp_cycle_lines',
  'hrm_headcount_plan_lines',
  'hrm_pay_gap_snapshots',
] as const

const HRM_PERMISSIONS: Record<(typeof HRM_KEYS)[number], string> = {
  hrm_headcount: 'hrm.employment.read',
  hrm_employment_history: 'hrm.employment.read',
  hrm_change_requests: 'hrm.employment.read',
  hrm_positions: 'hrm.position.read',
  hrm_processes: 'hrm.process.read',
  hrm_leave_absences: 'hrm.leave.read',
  hrm_benefit_enrollments: 'hrm.benefits.read',
  hrm_requisitions: 'hrm.recruiting.read',
  hrm_applications: 'hrm.recruiting.read',
  hrm_reviews: 'hrm.performance.read',
  hrm_goals: 'hrm.performance.read',
  hrm_turnover: 'hrm.retention.read',
  // HR-16 begin: recipe and run-log entities ride the automations read
  // grant; the reason vocabulary rides the employment read grant.
  automations: 'automations.read',
  automation_runs: 'automations.read',
  hrm_action_reasons: 'hrm.employment.read',
  // HR-16 end
  // HR-13 begin
  hrm_rate_schedule_lines: 'hrm.construction.read',
  hrm_per_diem_entries: 'hrm.construction.read',
  hrm_comp_class_split: 'hrm.construction.read',
  hrm_certified_runs: 'hrm.construction.read',
  hrm_compliance_findings: 'hrm.construction.read',
  // HR-13 end
  // HR-12 begin
  hrm_pay_bands: 'hrm.compensation.read',
  hrm_comp_cycle_lines: 'hrm.compensation.read',
  hrm_headcount_plan_lines: 'hrm.compensation.read',
  hrm_pay_gap_snapshots: 'hrm.compensation.read',
  // HR-12 end
}

test('workforce entities are registered on the shared catalog exactly once', () => {
  assert.equal(HRM_REPORT_ENTITIES.length, HRM_KEYS.length)
  for (const key of HRM_KEYS) {
    const entity = REPORT_ENTITY_MAP[key]
    assert.ok(entity, `${key} must be in REPORT_ENTITY_MAP`)
    assert.equal(REPORT_ENTITIES.filter((e) => e.key === key).length, 1, `${key} registered twice`)
  }
})

test('workforce entities refuse without their gate and their own read permission', () => {
  // HR-16 begin: recipe entities ride the automations switch, the reason
  // vocabulary rides hrmActionReasons, everything else rides hrm.
  const HRM_FEATURES: Record<(typeof HRM_KEYS)[number], string> = {
    hrm_headcount: 'hrm', hrm_employment_history: 'hrm', hrm_change_requests: 'hrm',
    hrm_positions: 'hrm', hrm_processes: 'hrm', hrm_leave_absences: 'hrm',
    hrm_requisitions: 'hrm', hrm_applications: 'hrm', hrm_benefit_enrollments: 'hrm',
    hrm_reviews: 'hrm', hrm_goals: 'hrm', hrm_turnover: 'hrm',
    automations: 'automations', automation_runs: 'automations', hrm_action_reasons: 'hrmActionReasons',
    // HR-13: construction entities ride the construction switch, not the bare hrm one.
    hrm_rate_schedule_lines: 'hrmConstructionCompliance', hrm_per_diem_entries: 'hrmConstructionCompliance',
    hrm_comp_class_split: 'hrmConstructionCompliance', hrm_certified_runs: 'hrmConstructionCompliance',
    hrm_compliance_findings: 'hrmConstructionCompliance',
  }
  for (const key of HRM_KEYS) {
    const entity = REPORT_ENTITY_MAP[key]!
    assert.equal(entity.requiredPermission, HRM_PERMISSIONS[key], key)
    assert.equal(entity.featureKey, HRM_FEATURES[key], key)
    // HR-12 begin: compensation entities gate on the hrmCompensation switch.
    assert.equal(entity.featureKey, key.startsWith('hrm_pay_bands') || key.startsWith('hrm_comp_') || key.startsWith('hrm_headcount_plan_') || key.startsWith('hrm_pay_gap_') ? 'hrmCompensation' : 'hrm', key)
    // HR-12 end
  }
  // HR-16 end
})

test('workforce entities scope to one org and one legal-entity boundary', () => {
  const orgColumns: Record<(typeof HRM_KEYS)[number], string> = {
    hrm_headcount: 'hc.org_id',
    hrm_employment_history: 'ev.org_id',
    hrm_change_requests: 'r.org_id',
    hrm_positions: 'p.org_id',
    hrm_processes: 's.org_id',
    hrm_leave_absences: 'a.org_id',
    hrm_benefit_enrollments: 'e.org_id',
    hrm_requisitions: 'r.org_id',
    hrm_applications: 'a.org_id',
    hrm_reviews: 'r.org_id',
    hrm_goals: 'g.org_id',
    hrm_turnover: 't.org_id',
    // HR-16 begin
    automations: 'a.org_id',
    automation_runs: 'r.org_id',
    hrm_action_reasons: 'r.org_id',
    // HR-16 end
    // HR-13 begin
    hrm_rate_schedule_lines: 'l.org_id',
    hrm_per_diem_entries: 'e.org_id',
    hrm_comp_class_split: 'r.org_id',
    hrm_certified_runs: 'r.org_id',
    hrm_compliance_findings: 'f.org_id',
    // HR-13 end
    // HR-12 begin
    hrm_pay_bands: 'b.org_id',
    hrm_comp_cycle_lines: 'l.org_id',
    hrm_headcount_plan_lines: 'l.org_id',
    hrm_pay_gap_snapshots: 's.org_id',
    // HR-12 end
  }
  const scopeColumns: Record<(typeof HRM_KEYS)[number], string | null> = {
    hrm_headcount: 'hc.employer_subsidiary_id',
    hrm_employment_history: 'e.employer_subsidiary_id',
    hrm_change_requests: 'e.employer_subsidiary_id',
    hrm_positions: 'v.employer_subsidiary_id',
    hrm_processes: 'e.employer_subsidiary_id',
    hrm_leave_absences: 'e.employer_subsidiary_id',
    hrm_requisitions: 'r.employer_subsidiary_id',
    hrm_applications: 'r.employer_subsidiary_id',
    hrm_benefit_enrollments: 'emp.employer_subsidiary_id',
    hrm_reviews: 'e.employer_subsidiary_id',
    hrm_goals: 'e.employer_subsidiary_id',
    hrm_turnover: 'e.employer_subsidiary_id',
    // HR-16 begin: platform configuration and Setup vocabulary are org-wide
    // under an admin-only grant — no subsidiary column exists to scope.
    automations: null,
    automation_runs: null,
    hrm_action_reasons: null,
    // HR-16 end
    // HR-13 begin: employment-anchored rows clamp to the employer
    // subsidiary; org-level configuration declares no clamp (null).
    hrm_rate_schedule_lines: null,
    hrm_per_diem_entries: 'w.employer_subsidiary_id',
    hrm_comp_class_split: null,
    hrm_certified_runs: 'p.subsidiary_id',
    hrm_compliance_findings: 'w.employer_subsidiary_id',
    // HR-13 end
    // HR-12 begin
    hrm_pay_bands: 'b.employer_subsidiary_id',
    hrm_comp_cycle_lines: 'emp.employer_subsidiary_id',
    hrm_headcount_plan_lines: 'l.employer_subsidiary_id',
    hrm_pay_gap_snapshots: `(s.scope->>'employer_subsidiary_id')::uuid`,
    // HR-12 end
  }
  for (const key of HRM_KEYS) {
    const entity = REPORT_ENTITY_MAP[key]!
    assert.equal(entity.orgColumn, orgColumns[key], `${key} org column`)
    // HR-16 begin: org-wide configuration entities carry no subsidiary scope.
    const scope = scopeColumns[key]
    if (scope === null) {
      assert.equal(entity.subsidiaryScope, undefined, `${key} carries no subsidiary scope`)
    } else {
      assert.deepEqual(entity.subsidiaryScope, { column: scope }, `${key} subsidiary scope`)
    }
    // HR-16 end
    assert.deepEqual(entity.subsidiaryScope, scopeColumns[key] === null ? null : { column: scopeColumns[key] }, `${key} subsidiary scope`)
    // HR-12 begin: gap snapshots are optionally subsidiary-scoped populations — org-wide rows stay shared.
    assert.deepEqual(
      entity.subsidiaryScope,
      key === 'hrm_pay_gap_snapshots' ? { column: scopeColumns[key], sharedNull: true } : { column: scopeColumns[key] },
      `${key} subsidiary scope`,
    )
    // HR-12 end
    // Every table join is pinned to the base org: an unpinned join is how a
    // report leaks rows across tenants. The decided-at lateral reads the
    // request's own snapshot, not another table, so it carries no pin.
    const blocks = entity.from.split(/\bJOIN\b/i).slice(1)
    // HR-16 begin: single-table org-wide entities join nothing — the
    // org predicate on the base table is the whole tenant boundary.
    if (key === 'automations' || key === 'hrm_action_reasons') {
      assert.equal(blocks.length, 0, `${key} reads one org-scoped table`)
    } else {
      assert.ok(blocks.length >= 1, `${key} must join governed tables`)
    }
    // HR-16 end
    for (const block of blocks) {
      if (/LATERAL/i.test(block.split('(')[0] ?? '')) continue
      assert.match(block, /\borg_id\s*=\s*\w+\.org_id/i, `${key}: ${block.trim().slice(0, 80)}`)
    }
  }
})

test('positions vacancy as-of is the catalog sentinel, bound server-side, never CURRENT_DATE', () => {
  const from = REPORT_ENTITY_MAP.hrm_positions!.from
  assert.match(from, new RegExp(REPORT_AS_OF))
  assert.doesNotMatch(from, /CURRENT_DATE/)
  // Half-open containment on all three legs (version, funding period,
  // holder assignment) plus currently-known revisions only — the same
  // contract the vacancy read resolves through temporal.ts.
  assert.match(from, /effective_from <=/)
  assert.match(from, /effective_to IS NULL OR effective_to >/)
  assert.match(from, /recorded_until IS NULL/)
  assert.match(from, /per\.starts_on <=/)
  assert.match(from, /per\.ends_on >=/)
  assert.equal(REPORT_ENTITY_MAP.hrm_positions!.defaultPeriodField, null)
})

test('headcount as-of is the catalog sentinel, bound server-side, never CURRENT_DATE', () => {
  const from = REPORT_ENTITY_MAP.hrm_headcount!.from
  assert.match(from, new RegExp(REPORT_AS_OF))
  assert.doesNotMatch(from, /CURRENT_DATE/)
  // Half-open containment mirrors temporal.ts containsDate: the version in
  // service at the as-of day started on or before it and ends after it
  // (NULL = unbounded), in both the employment and the assignment legs.
  assert.match(from, /ev\.effective_from <=/)
  assert.match(from, /ev\.effective_to IS NULL OR ev\.effective_to >/)
  assert.match(from, /pa\.effective_from <=/)
  assert.match(from, /pa\.effective_to IS NULL OR pa\.effective_to >/)
  // Only currently-known revisions count: superseded rows stay history.
  assert.match(from, /ev\.recorded_until IS NULL/)
  assert.match(from, /pa\.recorded_until IS NULL/)
})

test('headcount refuses to compile without the server-side as-of day', () => {
  const entity = REPORT_ENTITY_MAP.hrm_headcount!
  assert.throws(
    () =>
      compileCustomQuery(entity, {
        entity: entity.key,
        mode: 'rows',
        columns: ['subsidiary', 'headcount'],
        filters: null,
        limit: 10,
      }, '00000000-0000-4000-8000-000000000001'),
    /requires asOf/,
  )
  const compiled = compileCustomQuery(entity, {
    entity: entity.key,
    mode: 'rows',
    columns: ['subsidiary', 'headcount'],
    filters: null,
    limit: 10,
  }, '00000000-0000-4000-8000-000000000001', { asOf: '2026-09-01' })
  assert.doesNotMatch(compiled.text, new RegExp(REPORT_AS_OF))
  assert.ok(compiled.values.includes('2026-09-01'), 'as-of binds as a parameter')
  assert.match(compiled.text, /WHERE hc\.org_id = \$1/)
})

test('subsidiary scope clamps to the reader allowlist, and an empty one matches nothing', () => {
  const entity = REPORT_ENTITY_MAP.hrm_employment_history!
  const scoped = compileCustomQuery(entity, {
    entity: entity.key,
    mode: 'rows',
    columns: ['person', 'status'],
    filters: null,
    limit: 10,
  }, '00000000-0000-4000-8000-000000000001', { allowedSubsidiaryIds: ['11111111-1111-4111-8111-111111111111'] })
  assert.match(scoped.text, /e\.employer_subsidiary_id = ANY\(/)
  const none = compileCustomQuery(entity, {
    entity: entity.key,
    mode: 'rows',
    columns: ['person', 'status'],
    filters: null,
    limit: 10,
  }, '00000000-0000-4000-8000-000000000001', { allowedSubsidiaryIds: [] })
  assert.match(none.text, /FALSE/)
})

test('history and register expose the filters the views promise', () => {
  const history = REPORT_ENTITY_MAP.hrm_employment_history!
  assert.equal(history.defaultPeriodField, 'effective_from')
  const filtered = compileCustomQuery(history, {
    entity: history.key,
    mode: 'rows',
    columns: ['person', 'status', 'effective_from'],
    filters: {
      combinator: 'and',
      rules: [
        { field: 'status', op: 'eq', value: 'active' },
        { field: 'effective_from', op: 'gte', value: '2026-01-01' },
        { field: 'effective_to', op: 'is_null' },
      ],
    },
    limit: 10,
  }, '00000000-0000-4000-8000-000000000001')
  assert.match(filtered.text, /ev\.status = /)

  const register = REPORT_ENTITY_MAP.hrm_change_requests!
  assert.equal(register.defaultPeriodField, 'created_at')
  const scoped = compileCustomQuery(register, {
    entity: register.key,
    mode: 'rows',
    columns: ['status', 'kind', 'submitted_at'],
    filters: {
      combinator: 'and',
      rules: [
        { field: 'status', op: 'eq', value: 'pending_approval' },
        { field: 'created_at', op: 'gte', value: '2026-01-01' },
      ],
    },
    limit: 10,
  }, '00000000-0000-4000-8000-000000000001')
  assert.match(scoped.text, /r\.status = /)
})

test('workforce entities carry no money columns', () => {
  // Headcount and FTE are counts, never currency: denominating them as money
  // would drag the mixed-currency refusal machinery into a headcount.
  for (const key of HRM_KEYS) {
    for (const column of REPORT_ENTITY_MAP[key]!.columns) {
      assert.notEqual(column.kind, 'money', `${key}.${column.key} must not be money`)
    }
  }
})

test('headcount statement preset is a valid hrm-gated summary with an org total', () => {
  const preset = BUILT_IN_REPORT_DEFINITION_MAP['headcount-statement']
  assert.ok(preset, 'headcount-statement must be seeded')
  assert.equal(preset.query.entity, 'hrm_headcount')
  assert.doesNotThrow(() => validateCustomQuery(preset.query))
  assert.equal(preset.query.mode, 'summarize')
  assert.deepEqual(
    (preset.query.breakouts ?? []).map((b) => b.column),
    ['subsidiary', 'department'],
  )
  const measures = (preset.query.measures ?? []).map((m) => `${m.fn}:${m.column}`)
  assert.ok(measures.includes('sum:headcount'), 'statement sums headcount')
  assert.ok(measures.includes('sum:fte_total'), 'statement sums FTE')
  // The org total is the shared summary band over those two sums (Total
  // headcount / Total FTE) — no bespoke total row, so the ExportData
  // conversion carries it to PDF/CSV/XLSX untouched.
  assert.equal(preset.query.groupBy ?? null, null)
  const entity = REPORT_ENTITY_MAP[preset.query.entity]!
  assert.equal(entity.requiredPermission, 'hrm.employment.read')
  assert.equal(entity.featureKey, 'hrm')
})
