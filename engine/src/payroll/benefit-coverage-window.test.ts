import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFlatBenefitCoverageUnique, benefitCoverageWindow } from './benefit-coverage-window.ts';
import { coveredPayrollLines } from './covered-payroll-lines.ts';
import { parseMoney } from '../money/brands.ts';
import { sum } from '../money/money.ts';
import type { Line } from './run-stub-records.ts';

const period = { periodStart: '2026-01-04', periodEnd: '2026-01-10' };
const point = { effectiveFrom: period.periodEnd, effectiveTo: period.periodEnd };
const rule = { ...point, ruleKey: 'RETIREMENT', basis: 'per_hour' };

test('earning-date coverage remains the default and preserves dated earning facts', () => {
  const window = benefitCoverageWindow({ ...period, enrollment: point, term: point, rule });
  assert.deepEqual(window, { from: '2026-01-10', to: '2026-01-10', earningsFrom: '2026-01-10', earningsTo: '2026-01-10' });
  const lines: Line[] = [
    { componentId: null, kind: 'earning', description: 'Paid units', amount: parseMoney('700'), hours: '14', sequence: 1 },
    { componentId: null, kind: 'earning', description: 'Dated work', amount: parseMoney('300'), hours: '6', sequence: 2, earnedFrom: '2026-01-05', earnedTo: '2026-01-05' },
  ];
  const covered = coveredPayrollLines(lines, window!.earningsFrom, window!.earningsTo, period.periodStart, period.periodEnd);
  assert.equal(sum(covered.map(line => line.hours ?? '0')), '2.0000');
  assert.equal(lines[0]!.hours, '14', 'Calculation never rewrites original units');
});

test('period-end policy counts the paid period only when all configuration covers its end', () => {
  const selected = { ...rule, hoursCoverage: 'pay_period_end' as const };
  const args = { ...period, enrollment: point, term: point, rule: selected };
  assert.deepEqual(benefitCoverageWindow(args), { from: '2026-01-10', to: '2026-01-10', earningsFrom: '2026-01-04', earningsTo: '2026-01-10' });
  for (const field of ['rule', 'enrollment', 'term'] as const) {
    assert.equal(benefitCoverageWindow({ ...args, [field]: { ...args[field], effectiveTo: '2026-01-09' } }), null, `${field} ended before the selection date`);
    assert.equal(benefitCoverageWindow({ ...args, [field]: { ...args[field], effectiveFrom: '2026-01-11', effectiveTo: null } }), null, `${field} starts after the selection date`);
  }
  assert.equal(benefitCoverageWindow({ ...args, periodStart: '2026-01-11', periodEnd: '2026-01-17' }), null, 'A point election is not reused in a later period');
});

test('period-end coverage refuses unsupported bases and unknown policies', () => {
  const args = { ...period, enrollment: point, term: point, rule: { ...rule, hoursCoverage: 'pay_period_end' as const } };
  assert.throws(() => benefitCoverageWindow({ ...args, rule: { ...args.rule, basis: 'per_month' } }), /without a per-hour basis/);
  assert.throws(() => benefitCoverageWindow({ ...args, rule: { ...args.rule, hoursCoverage: 'unknown' as 'earned_dates' } }), /unsupported hours coverage policy/);
});

test('flat premiums refuse multiple dated elections instead of charging the period twice', () => {
  const before = { effectiveFrom: '2026-01-01', effectiveTo: '2026-01-09' };
  const after = { effectiveFrom: '2026-01-10', effectiveTo: null };
  const contribution = { effectiveFrom: '2026-01-01', effectiveTo: null, ruleKey: 'MEDICAL', basis: 'per_period', proration: 'none', payComponentId: 'premium' };
  const policies = [before, after].map(window => ({ planId: 'medical', rule: contribution, enrollment: window, term: window }));
  for (const basis of ['per_period', 'per_month', 'per_year']) {
    assert.throws(() => assertFlatBenefitCoverageUnique(policies.map(policy => ({ ...policy, rule: { ...policy.rule, basis } })), period.periodStart, period.periodEnd), /multiple covered elections.*pay-period boundary.*calendar-day proration/);
  }
  assert.doesNotThrow(() => assertFlatBenefitCoverageUnique(policies, '2026-01-11', '2026-01-17'));
  assert.doesNotThrow(() => assertFlatBenefitCoverageUnique(policies.map(policy => ({ ...policy, rule: { ...policy.rule, proration: 'calendar_days' } })), period.periodStart, period.periodEnd));
  assert.doesNotThrow(() => assertFlatBenefitCoverageUnique(policies.map(policy => ({ ...policy, rule: { ...policy.rule, basis: 'per_hour' } })), period.periodStart, period.periodEnd));
  assert.doesNotThrow(() => assertFlatBenefitCoverageUnique(policies.map((policy, index) => ({ ...policy, planId: `plan-${index}` })), period.periodStart, period.periodEnd));
  assert.doesNotThrow(() => assertFlatBenefitCoverageUnique(policies.map((policy, index) => ({ ...policy, rule: { ...policy.rule, payComponentId: `component-${index}` } })), period.periodStart, period.periodEnd));
});
