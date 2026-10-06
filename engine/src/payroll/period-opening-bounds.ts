import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../platform/db.ts';
import { cmp } from '../money/money.ts';
import { PayrollError } from './error.ts';

/** Before rollout no period payment can be admitted; existing annual entry remains available. */
export async function annualPeriodOpeningBounds(tx: SqlExecutor, orgId: string, employeeIds: readonly string[], taxYear: number) {
  const available = (await tx.execute<{ available: boolean }>(sql`select to_regclass('public.payroll_period_openings') is not null as available`)).rows[0]?.available;
  if (!available) return new Map<string, Record<string, string>>();
  const rows = (await tx.execute<{ employee_party_id: string; annual_bounds: Record<string, string> }>(sql`
    select employee_party_id,annual_bounds from payroll_period_openings where org_id=${orgId} and tax_year=${taxYear}
     and employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(employeeIds)}::jsonb)::uuid)`)).rows;
  return new Map(rows.map((row) => [row.employee_party_id, row.annual_bounds]));
}

export function assertAnnualPeriodOpeningBounds(input: {
  bounds: Readonly<Record<string, string>>;
  annualColumns: Readonly<Record<string, string>>;
  programs: Readonly<Record<string, string>>;
  columnLabels: Readonly<Record<string, string>>;
}): void {
  for (const [key, minimum] of Object.entries(input.bounds)) {
    const program = key.startsWith('program:') ? key.slice(8) : null;
    const amount = program !== null ? input.programs[program] ?? '0' : input.annualColumns[key];
    if (amount === undefined || cmp(amount, minimum) < 0) {
      throw new PayrollError(`${input.columnLabels[key] ?? key} cannot be reduced below the ${minimum} already attributed to same-period payments — correct the unused period amounts in Payroll opening balances first`);
    }
  }
}
