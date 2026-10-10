import { PayrollError } from './error.ts';
import type { PayRunType } from './run-contracts.ts';

export const ASSIGNMENT_RUN_APPLICABILITIES = ['standard_runs', 'regular_only', 'periodic_and_final'] as const;
export type AssignmentRunApplicability = typeof ASSIGNMENT_RUN_APPLICABILITIES[number];

/** Assignment windows determine dates; this policy determines eligible run types. */
export function assignmentAppliesToRun(policy: unknown, runType: PayRunType): boolean {
  if (policy !== 'standard_runs' && policy !== 'regular_only' && policy !== 'periodic_and_final') {
    throw new PayrollError('The recurring pay-component assignment has no supported pay-run applicability — end it and save a replacement with an explicit applicability before recalculating.');
  }
  if (!['regular', 'supplemental', 'termination', 'bonus', 'retro'].includes(runType)) {
    throw new PayrollError('The payroll run type is unsupported — select a supported native pay run before recalculating.');
  }
  return runType === 'regular' || (policy === 'standard_runs' && (runType === 'supplemental' || runType === 'termination'))
    || (policy === 'periodic_and_final' && runType === 'termination');
}

/** Validate every candidate, including assignments excluded from this run. */
export function applicableAssignedComponents<T extends Record<string, unknown>>(rows: readonly T[], runType: PayRunType): T[] {
  return rows.filter(row => assignmentAppliesToRun(row.run_applicability, runType));
}
