import { sourceTimeAvailableSql } from "../projects/source-time-availability.ts";
import { sql } from "drizzle-orm";
import { sum } from "../money/money.ts";
import { db } from "../platform/db.ts";

/**
 * Approved time this run prices as wages. The Scope tab's approved-hours
 * preview, the readiness zero-hours warning, and the wage-pricing phase of
 * calculation all read through here, so the Scope tab can never preview
 * hours Calculate will not pick up: entries another run already claimed,
 * and time types excluded from wages, are invisible to all three.
 *
 * Bounds are civil dates on both sides. Callers pass whatever their run row
 * carries (a YYYY-MM-DD string from a ::text projection or the Date object
 * node-pg parses a date column into); both spell the same calendar day, and
 * binding the normalized day keeps period-edge entries independent of the
 * database session time zone.
 */
export interface WageTimeEntry {
  id: string;
  employeePartyId: string;
  workedOn: string;
  hours: string;
  timeTypeId: string | null;
  projectId: string | null;
  departmentId: string | null;
  itemId: string | null;
  classification: string;
  multiplier: string;
  typeName: string;
  itemName: string | null;
  itemAccountId: string | null;
  itemAccountNumber: string | null;
  itemAccountName: string | null;
}

function periodDay(value: string | Date): string {
  const day = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`pay period bound is not a civil date: ${day}`);
  }
  return day;
}

export async function loadWageTimeEntries(
  tx: Pick<typeof db, "execute">,
  input: {
    orgId: string;
    employeePartyIds: readonly string[];
    periodStart: string | Date;
    periodEnd: string | Date;
    documentId: string;
  },
): Promise<WageTimeEntry[]> {
  if (input.employeePartyIds.length === 0) return [];
  const periodStart = periodDay(input.periodStart);
  const periodEnd = periodDay(input.periodEnd);
  const rows = await tx.execute<{
    id: string;
    employee_party_id: string;
    worked_on: string;
    hours: string;
    time_type_id: string | null;
    project_id: string | null;
    department_id: string | null;
    item_id: string | null;
    classification: string;
    multiplier: string;
    type_name: string;
    item_name: string | null;
    item_account_id: string | null;
    item_account_number: string | null;
    item_account_name: string | null;
  }>(
    sql`
    select te.id, te.employee_party_id, te.hours, te.worked_on, te.project_id, te.department_id, te.time_type_id, te.item_id,
           coalesce(tt.classification, 'regular') as classification,
           coalesce(tt.cost_multiplier, 1) as multiplier, coalesce(tt.name, 'Regular') as type_name,
           i.name as item_name, i.payroll_expense_account_id as item_account_id,
           a.number as item_account_number, a.name as item_account_name
      from time_entries te
      left join time_types tt on tt.id = te.time_type_id and tt.org_id = te.org_id
      left join items i on i.id = te.item_id and i.org_id = te.org_id
      left join accounts a on a.id = i.payroll_expense_account_id and a.org_id = i.org_id
     where te.org_id = ${input.orgId}
       and te.employee_party_id = any(${`{${[...new Set(input.employeePartyIds)].join(",")}}`}::uuid[])
       and te.status = 'approved'
       and (${sourceTimeAvailableSql(sql`te.custom`)} or te.payroll_batch_ref = ${input.documentId})
       and te.worked_on between ${periodStart} and ${periodEnd}
       and (te.payroll_batch_ref is null or te.payroll_batch_ref = ${input.documentId})
       and coalesce(tt.exclude_from_wages, false) = false
  `,
    "objects",
  );
  return rows.map((row) => ({
    id: String(row.id),
    employeePartyId: String(row.employee_party_id),
    // Passed through untouched (the driver parses dates): the wage pricer
    // groups and stamps from this exact value, so no normalization here.
    workedOn: row.worked_on,
    hours: String(row.hours),
    timeTypeId: row.time_type_id ? String(row.time_type_id) : null,
    projectId: row.project_id ? String(row.project_id) : null,
    departmentId: row.department_id ? String(row.department_id) : null,
    itemId: row.item_id ? String(row.item_id) : null,
    classification: String(row.classification),
    multiplier: String(row.multiplier),
    typeName: String(row.type_name),
    itemName: row.item_name ?? null,
    itemAccountId: row.item_account_id ? String(row.item_account_id) : null,
    itemAccountNumber: row.item_account_number ?? null,
    itemAccountName: row.item_account_name ?? null,
  }));
}

/** Approved wage hours per employee, for roster previews that sum rather than price. */
export function sumWageHoursByEmployee(
  rows: readonly Pick<WageTimeEntry, "employeePartyId" | "hours">[],
): Map<string, string> {
  const byEmployee = new Map<string, string[]>();
  for (const row of rows) {
    const bucket = byEmployee.get(row.employeePartyId);
    if (bucket) bucket.push(row.hours);
    else byEmployee.set(row.employeePartyId, [row.hours]);
  }
  return new Map([...byEmployee].map(([employee, hours]) => [employee, sum(hours)]));
}
