import assert from 'node:assert/strict'
import test from 'node:test'
import { applyRuleSlotColumns, RULE_SLOT_ENTITIES } from './hrm-rule-slots'

// Generated slot columns are readable prefills and must never be written;
// the folded jsonb objects must always be written. Both entities share the
// rule, so both are pinned.
test('generated slot columns are stripped and folded rule objects are appended', () => {
  const cols = [
    { column: 'name', value: 'Onboarding' },
    { column: 'applies_employer_subsidiary_id', value: null },
    { column: 'applies_department_id', value: null },
  ]
  const res = applyRuleSlotColumns('hrm-process-templates', { appliesTo: { employer_subsidiary_id: null, department_id: null } }, cols)
  assert.ok(!('error' in res))
  assert.deepEqual(res.cols, [
    { column: 'name', value: 'Onboarding' },
    { column: 'applies_to', value: { employer_subsidiary_id: null, department_id: null } },
  ])
})

test('leave policies persist all three rules and none of their eight slots', () => {
  const cols = RULE_SLOT_ENTITIES['leave-policies']!.generated.map((column) => ({ column, value: null }))
  cols.push({ column: 'minimum_notice_days', value: 0 as unknown as null })
  const res = applyRuleSlotColumns(
    'leave-policies',
    {
      appliesTo: { employer_subsidiary_id: null, department_id: null },
      accrualRule: { kind: 'per_year', hours: '120' },
      carryoverRule: { kind: 'carry_up_to', hours: '40', expires_after_days: 90 },
    },
    cols,
  )
  assert.ok(!('error' in res))
  assert.deepEqual(res.cols.map((col) => col.column), ['minimum_notice_days', 'applies_to', 'accrual_rule', 'carryover_rule'])
})

test('an edit that folds no rule leaves the stored rules alone', () => {
  const res = applyRuleSlotColumns('leave-policies', { minimumNoticeDays: 3 }, [{ column: 'minimum_notice_days', value: 3 }])
  assert.ok(!('error' in res))
  assert.deepEqual(res.cols, [{ column: 'minimum_notice_days', value: 3 }])
})

test('a JSON string rule from an API caller is parsed; a malformed one is refused by name', () => {
  const ok = applyRuleSlotColumns('leave-policies', { accrualRule: '{"kind":"none"}' }, [])
  assert.ok(!('error' in ok))
  assert.deepEqual(ok.cols, [{ column: 'accrual_rule', value: { kind: 'none' } }])
  const bad = applyRuleSlotColumns('leave-policies', { accrualRule: '{nope' }, [])
  assert.deepEqual(bad, { error: 'accrualRule must be valid JSON' })
  const scalar = applyRuleSlotColumns('leave-policies', { carryoverRule: 'none' }, [])
  assert.deepEqual(scalar, { error: 'carryoverRule must be valid JSON' })
  const array = applyRuleSlotColumns('leave-policies', { appliesTo: [] }, [])
  assert.deepEqual(array, { error: 'appliesTo must be a JSON object' })
})

test('entities without rule slots pass through untouched', () => {
  const cols = [{ column: 'name', value: 'x' }]
  const res = applyRuleSlotColumns('departments', { name: 'x' }, cols)
  assert.ok(!('error' in res))
  assert.deepEqual(res.cols, cols)
})
