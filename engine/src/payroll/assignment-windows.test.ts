import assert from "node:assert/strict";
import test from "node:test";
import { assignmentCoveredDays, assignmentCoversPeriod } from "./assignment-windows.ts";
import { coveredPayrollLines } from './covered-payroll-lines.ts';
import { parseMoney } from '../money/brands.ts';
import { sum } from '../money/money.ts';
import type { Line } from './run-stub-records.ts';

test("a fixed assignment starting mid-period in a cross-century period prorates over 14 days", () => {
  const window = {
    effectiveFrom: "0100-01-01",
    effectiveTo: null,
    periodStart: "0099-12-25",
    periodEnd: "0100-01-07",
  };
  // Covers 01-01..01-07 (7 days) of a 14-day period — the line pays 7/14 of
  // the fixed amount instead of being silently dropped.
  assert.deepEqual(assignmentCoveredDays(window), { coveredDays: 7, periodDays: 14 });
  assert.equal(assignmentCoversPeriod(window), false);
});

test("a fully-covering cross-century assignment still pays in full", () => {
  const window = {
    effectiveFrom: "0099-12-25",
    effectiveTo: null,
    periodStart: "0099-12-25",
    periodEnd: "0100-01-07",
  };
  assert.deepEqual(assignmentCoveredDays(window), { coveredDays: 14, periodDays: 14 });
  assert.equal(assignmentCoversPeriod(window), true);
});

test('covered payroll facts preserve dated work and each configuration slice without a second proration', () => {
  const line = (amount: string, rest: Partial<Line> = {}): Line => ({ componentId: null, kind: 'earning', description: 'Native pay',
    amount: parseMoney(amount), sequence: 10, ...rest });
  const facts = [line('100', { earnedFrom: '2026-01-09', earnedTo: '2026-01-09', hours: '4' }),
    line('200', { earnedFrom: '2026-01-20', earnedTo: '2026-01-20', hours: '8' }), line('310')];
  const covered = coveredPayrollLines(facts, '2026-01-16', '2026-01-31', '2026-01-01', '2026-01-31');
  assert.equal(sum(covered.map(line => line.amount)), '360.0000');
  assert.equal(sum(covered.map(line => line.hours ?? '0')), '8.0000');
  const term = line('160', { sourceProratedByCoverage: true, sourceEffectiveFrom: '2026-01-16', sourceEffectiveTo: '2026-01-31' });
  assert.equal(coveredPayrollLines([term], '2026-01-16', '2026-01-31', '2026-01-01', '2026-01-31', true)[0]!.amount, '160.0000');
  assert.equal(coveredPayrollLines([term], '2026-01-16', '2026-01-31', '2026-01-01', '2026-01-31')[0]!.amount, '82.5806', 'existing callers retain their original period-based allocation');
  const hourlyTerm = { ...term, amount: parseMoney('400'), sourceProratedByCoverage: false };
  assert.equal(coveredPayrollLines([hourlyTerm], '2026-01-16', '2026-01-31', '2026-01-01', '2026-01-31', true)[0]!.amount,
    '206.4516', 'whole-period hourly or gross-based amounts never adopt a fixed-amount configuration denominator');
  const mixed = coveredPayrollLines([...facts, term, hourlyTerm], '2026-01-16', '2026-01-31', '2026-01-01', '2026-01-31', true);
  assert.equal(sum(mixed.map(line => line.amount)), '726.4516');
  assert.equal(sum(mixed.map(line => line.hours ?? '0')), '8.0000', 'configuration amounts cannot duplicate the dated wage hours');
  assert.deepEqual(coveredPayrollLines([term], '2026-01-01', '2026-01-15', '2026-01-01', '2026-01-31', true), []);
  assert.equal(coveredPayrollLines([line('100', { sourceEffectiveFrom: term.sourceEffectiveFrom, sourceEffectiveTo: term.sourceEffectiveTo,
    earnedFrom: '2026-01-20', earnedTo: '2026-01-20' })], '2026-01-20', '2026-01-20', '2026-01-01', '2026-01-31', true)[0]!.amount,
    '100.0000', 'known earning dates remain authoritative over configuration dates');
});
