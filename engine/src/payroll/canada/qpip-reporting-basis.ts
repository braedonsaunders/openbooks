import { sql, type SQL } from "drizzle-orm";
import { PayrollError } from "../error.ts";

/** Year-end QPIP wages come only from the committed program-specific basis. */
export function qpipReportingBasisColumns(factors: SQL): SQL {
  const basis = sql`case when jsonb_typeof(${factors}->'IE_QPIP') = 'string'
    and (${factors}->>'IE_QPIP') ~ '^-?[0-9]+([.][0-9]{1,4})?$'
    then (${factors}->>'IE_QPIP')::numeric end`;
  return sql`sum(${basis}) as qpip_insurable,
    count(*) filter (where ${basis} is null)::int as invalid_qpip_bases`;
}

export function assertQpipReportingBasis(employeeName: string, invalidBases: number): void {
  if (invalidBases !== 0)
    throw new PayrollError(
      `${employeeName}: committed payroll is missing valid program-specific QPIP wage evidence. Review the retained pay run and use the governed payroll reversal and replacement workflow before generating T4 or RL-1 slips.`,
    );
}
