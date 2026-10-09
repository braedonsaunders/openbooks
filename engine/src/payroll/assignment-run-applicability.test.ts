import assert from 'node:assert/strict';
import test from 'node:test';
import { assignmentAppliesToRun, applicableAssignedComponents } from './assignment-run-applicability.ts';
import type { PayRunType } from './run-contracts.ts';

test('standard assignments preserve regular, supplemental and termination pay without repeating on one-off runs', () => {
  for (const type of ['regular', 'supplemental', 'termination', 'bonus', 'retro'] as PayRunType[]) {
    assert.equal(assignmentAppliesToRun('standard_runs', type), ['regular', 'supplemental', 'termination'].includes(type));
    assert.equal(assignmentAppliesToRun('regular_only', type), type === 'regular');
  }
});

test('unknown or absent assignment policy refuses even when the run would exclude the assignment', () => {
  for (const value of [undefined, null, '', 'all_pay_runs', 'REGULAR_ONLY']) {
    assert.throws(() => applicableAssignedComponents([{ run_applicability: value }], 'bonus'), /supported pay-run applicability/);
  }
  assert.throws(() => assignmentAppliesToRun('standard_runs', 'other' as PayRunType), /run type is unsupported/);
});

test('filtering preserves source values and effective dates without mutating assignments', () => {
  const rows = [{ id: 'regular', run_applicability: 'regular_only', override: '0.0000', effective_from: '2026-01-01' },
    { id: 'standard', run_applicability: 'standard_runs', override: '-12.3400', effective_from: '2026-01-05' }];
  const original = structuredClone(rows);
  assert.deepEqual(applicableAssignedComponents(rows, 'supplemental'), [rows[1]]);
  assert.deepEqual(applicableAssignedComponents(rows, 'regular'), rows);
  assert.deepEqual(rows, original);
});
