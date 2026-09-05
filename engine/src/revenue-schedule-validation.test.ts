import assert from 'node:assert/strict';
import test from 'node:test';
import { addDays, computeRecognitionSchedule, RevenueRecognitionError, type RecognitionInput } from './revenue-recognition.ts';

const base: RecognitionInput = { total: '1200', method: 'straight_line_even', startOn: '2026-01-01', termPeriods: 12 };

test('recognition schedules reject invalid financial dates, intervals and method instead of coercing them', () => {
  for (const value of ['2026-02-30', '2026-13-01', '0000-01-01', '2026-1-1', 'invalid', '']) {
    assert.throws(() => computeRecognitionSchedule({ ...base, startOn: value }), RevenueRecognitionError);
    assert.throws(() => computeRecognitionSchedule({ ...base, endOn: value }), RevenueRecognitionError);
  }
  for (const value of [NaN, Infinity, 1.5, -1]) {
    assert.throws(() => computeRecognitionSchedule({ ...base, termPeriods: value }), RevenueRecognitionError);
    assert.throws(() => computeRecognitionSchedule({ ...base, periodOffset: value }), RevenueRecognitionError);
  }
  assert.throws(() => computeRecognitionSchedule({ ...base, termPeriods: 0 }), RevenueRecognitionError);
  assert.throws(() => computeRecognitionSchedule({ ...base, method: 'unknown' as RecognitionInput['method'] }), RevenueRecognitionError);
  assert.throws(() => computeRecognitionSchedule({ ...base, startOffsetDays: 0.5 }), RevenueRecognitionError);
  assert.throws(() => computeRecognitionSchedule({ ...base, startOn: '9999-12-01', termPeriods: 2 }), RevenueRecognitionError);
  assert.throws(() => addDays('0001-01-01', -1), RevenueRecognitionError);
});

test('recognition preserves early Gregorian leap years and exact negative day offsets', () => {
  assert.equal(addDays('0096-02-28', 1), '0096-02-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  const plan = computeRecognitionSchedule({ ...base, method: 'straight_line_daily', startOn: '0096-02-01', endOn: '0096-03-01', total: '3000' });
  assert.deepEqual(plan.map(row => row.planned), ['2900.0000', '100.0000']);
});

test('recognition events require real calendar month starts', () => {
  for (const periodMonth of ['2026-02-30', '2026-02-15', 'invalid', '0000-01-01']) {
    assert.throws(() => computeRecognitionSchedule({ ...base, method: 'usage', events: [{ periodMonth, amount: '100' }] }), RevenueRecognitionError);
  }
});

test('recognition percentages refuse out-of-range values instead of clamping financial instructions', () => {
  for (const percent of ['-1', '101', 'invalid']) {
    assert.throws(() => computeRecognitionSchedule({ ...base, initialAmountPercent: percent }), RevenueRecognitionError);
    assert.throws(() => computeRecognitionSchedule({ ...base, method: 'percent_complete', percentComplete: percent }), RevenueRecognitionError);
  }
});
