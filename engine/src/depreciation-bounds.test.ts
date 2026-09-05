import assert from 'node:assert/strict';
import test from 'node:test';
import { computeScheduleByFormula, BUILTIN_FORMULAS } from './depreciation-formula.ts';
import { computeSchedule } from './depreciation.ts';
import { toUnits } from './money.ts';

// Zero basis proves validation without running an unsafe billion-period loop.
for (const life of [0, -1, 1.5, NaN, Infinity, 1_000_000_000]) {
  test(`depreciation refuses invalid life ${life} before the zero-basis shortcut`, () => {
    assert.throws(() => computeScheduleByFormula({ cost:'0', salvage:'0', lifePeriods:life, formula:BUILTIN_FORMULAS.straight_line }), /period|life/i);
    assert.throws(() => computeSchedule({ cost:'0', salvage:'0', lifeMonths:life, method:'straight_line', inServiceOn:'2026-01-01' }), /period|life/i);
  });
}
for (const periods of [0, -1, 1.5, NaN, Infinity, 1_000_000_000]) {
  test(`depreciation refuses invalid convention window ${periods} before zero basis`, () => {
    assert.throws(() => computeScheduleByFormula({ cost:'0', salvage:'0', lifePeriods:12, formula:BUILTIN_FORMULAS.straight_line, firstFractionPeriods:periods, firstPeriodFraction:'0.5' }), /period|window/i);
  });
}
test('maximum useful life preserves exact depreciation with a convention extension', () => {
  const rows = computeSchedule({ cost:'12000.01', salvage:'0.01', lifeMonths:12000, method:'straight_line', inServiceOn:'2026-01-01', convention:'half_year' });
  assert.equal(rows.length,12006);
  assert.equal(rows.reduce((sum,row)=>sum+toUnits(row.planned),0n),toUnits('12000'));
  assert.equal(rows.at(-1)?.netBookValue,'0.0100');
});
