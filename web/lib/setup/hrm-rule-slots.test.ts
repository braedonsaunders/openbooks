import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRow } from './coerce'
import { applyRuleSlotColumns, coveredSlotFields, RULE_SLOT_ENTITIES } from './hrm-rule-slots'
import { SETUP_ENTITY_BY_KEY } from './registry'

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

// OM-17 follow-up: the review-template fold strips the scale slots before
// buildRow, so the writer refused every create with "ratingScaleMin is
// required". A present fold covers its slots: buildRow skips them (required
// check and column emission alike) and the integrity check proves the scale
// with the engine's own words. A body with no fold covers nothing.
test('a present scale fold covers the review-template slots in buildRow', () => {
  const entity = SETUP_ENTITY_BY_KEY.get('hrm-review-templates')!
  const body = {
    name: 'Annual',
    ratingScale: { min: 1, max: 5, labels: ['low', 'high'] },
    isActive: true,
  }
  assert.deepEqual(
    [...coveredSlotFields('hrm-review-templates', body)].sort(),
    ['ratingScaleLabels', 'ratingScaleMax', 'ratingScaleMin'],
  )
  const covered = buildRow(entity, body, { forCreate: true, coverFoldedSlots: true })
  assert.ok(!('error' in covered), `folded slots must not block the write: ${JSON.stringify(covered)}`)
  const columns = covered.cols.map((col) => col.column).sort()
  assert.deepEqual(columns, ['is_active', 'name'], 'slot fields must never emit phantom columns')
})

test('without the opt-in or without a fold the slots still refuse by name', () => {
  const entity = SETUP_ENTITY_BY_KEY.get('hrm-review-templates')!
  const folded = { name: 'Annual', ratingScale: { min: 1, max: 5, labels: [] }, isActive: true }
  // Import paths never normalize: without the flag the loud required
  // refusal stands instead of a silently dropped scale.
  assert.deepEqual(buildRow(entity, folded, { forCreate: true }), { error: 'ratingScaleMin is required' })
  // And a scaleless create still names its missing field with the flag on.
  assert.deepEqual(
    buildRow(entity, { name: 'Annual', isActive: true }, { forCreate: true, coverFoldedSlots: true }),
    { error: 'ratingScaleMin is required' },
  )
  assert.deepEqual([...coveredSlotFields('departments', { name: 'x' })], [])
})
