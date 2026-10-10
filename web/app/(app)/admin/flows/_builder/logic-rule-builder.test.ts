import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateLogicRule, logicRuleSchema, type FlowSubjectProfile, type LogicRule } from '@openbooks/forms-core'
import { fieldPickerOptions, makeGroup, withRuleValueType } from './logic-rule-builder.ts'

const child = (field: string): LogicRule => ({ op: 'isSet', field })

test('negating a three-child AND group preserves the AND group and every child', () => {
  const children = [child('one'), child('two'), child('three')]

  assert.deepEqual(makeGroup('not', children, 'fallback', 'and'), {
    op: 'not',
    rule: { op: 'and', rules: children },
  })
})

test('negating a three-child OR group preserves the OR group and every child', () => {
  const children = [child('one'), child('two'), child('three')]

  assert.deepEqual(makeGroup('not', children, 'fallback', 'or'), {
    op: 'not',
    rule: { op: 'or', rules: children },
  })
})

test('negating an empty group keeps its source combinator', () => {
  assert.deepEqual(makeGroup('not', [], 'fallback', 'and'), {
    op: 'not',
    rule: { op: 'and', rules: [] },
  })
  assert.deepEqual(makeGroup('not', [], 'fallback', 'or'), {
    op: 'not',
    rule: { op: 'or', rules: [] },
  })
})

test('negating a one-child group unwraps the child', () => {
  const onlyChild = child('only')

  assert.deepEqual(makeGroup('not', [onlyChild], 'fallback', 'and'), {
    op: 'not',
    rule: onlyChild,
  })
  assert.deepEqual(makeGroup('not', [onlyChild], 'fallback', 'or'), {
    op: 'not',
    rule: onlyChild,
  })
})

test('creating a NOT group without a source group uses the fallback leaf', () => {
  assert.deepEqual(makeGroup('not', [], 'fallback'), {
    op: 'not',
    rule: { op: 'isSet', field: 'fallback' },
  })
})


test('numeric scalar thresholds retain decimal text and exact comparison after serialization', () => {
  const authored = withRuleValueType({ op: 'eq', field: 'value', value: '100.00' }, 'number');
  const saved = logicRuleSchema.parse(JSON.parse(JSON.stringify(authored)));
  assert.equal('value' in saved ? saved.value : null, '100.00');
  assert.equal(evaluateLogicRule(saved, { values: { value: '100.0000' }, rows: {} }), true);
  const threshold = withRuleValueType({ op: 'gt', field: 'value', value: '999999999999900.01' }, 'number');
  assert.equal(evaluateLogicRule(logicRuleSchema.parse(threshold), { values: { value: '999999999999900.02' }, rows: {} }), true);
});

test('the condition field picker shows each display label once, never label plus key', () => {
  const profile = {
    subjectKind: 'estimate',
    label: 'Estimate',
    triggers: ['on_submit'],
    actions: ['notify'],
    statuses: [],
    fields: [
      { key: 'total', label: 'Total', type: 'number' },
      { key: 'memo', label: 'Memo', type: 'text' },
    ],
    roles: [],
  } as unknown as FlowSubjectProfile
  assert.deepEqual(fieldPickerOptions(profile), [
    { value: 'total', label: 'Total' },
    { value: 'memo', label: 'Memo' },
  ])
  // The storage key stays the option value (what the engine matches on) but
  // never leaks into the visible label — "Total" reads once, not "Totaltotal".
  for (const option of fieldPickerOptions(profile)) {
    assert.ok(!('hint' in option), `no key hint may ride along, got: ${JSON.stringify(option)}`)
  }
})

test('numeric list equality stays exact while switching to a text field restores identifier semantics', () => {
  const numeric = withRuleValueType({ op: 'in', field: 'value', value: ['100.00', '200.00'] }, 'number');
  assert.equal(evaluateLogicRule(logicRuleSchema.parse(numeric), { values: { value: '100.0000' }, rows: {} }), true);
  const text = withRuleValueType({ ...numeric, field: 'code' } as LogicRule, 'text');
  assert.equal('valueType' in text, false);
  assert.equal(evaluateLogicRule(logicRuleSchema.parse(text), { values: { code: '100.0000' }, rows: {} }), false);
  const identifier = withRuleValueType({ op: 'eq', field: 'code', value: '01' }, 'text');
  assert.equal(evaluateLogicRule(identifier, { values: { code: '1' }, rows: {} }), false);
  assert.deepEqual(withRuleValueType({ op: 'isSet', field: 'value' }, 'number'), { op: 'isSet', field: 'value' });
});
