import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";

/* ------------------------------------------------------------------ */
/* Timesheet weeks                                                     */
/* ------------------------------------------------------------------ */

export const TIMESHEET_WEEK_BUILT_IN_EXPR: Record<string, SQL> = {
  employee_name: sql`employee.display_name`,
  week_start: sql`tw.week_start`,
  status: sql`tw.status`,
  total_hours: sql`to_char(tw.total_hours, 'FM999999990.00')`,
  billable_hours: sql`to_char(tw.billable_hours, 'FM999999990.00')`,
}

export const TIMESHEET_WEEK_SORTS: Record<string, SQL> = {
  employee: sql`employee.display_name`,
  week: sql`tw.week_start`,
  status: sql`tw.status`,
  total: sql`tw.total_hours`,
  billable: sql`tw.billable_hours`,
}

function timesheetWeekFilterPredicate(clause: FilterClause): SQL | null {
  const value = Array.isArray(clause.value) ? String(clause.value[0] ?? '') : String(clause.value ?? '')
  const column = clause.key === 'status' ? sql`tw.status`
    : clause.key === 'employee_party_id' ? sql`tw.employee_party_id` : null
  if (!column) return null
  if (clause.operator === 'eq') return sql`${column} = ${value}`
  if (clause.operator === 'ne') return sql`${column} <> ${value}`
  return null
}

export function timesheetWeekWhere(view: ListViewConfig, adhoc: EntityAdhoc, orgId: string): SQL {
  const parts: SQL[] = [sql`tw.org_id = ${orgId}`]
  for (const filter of view.filters) {
    const predicate = timesheetWeekFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.status) parts.push(sql`and tw.status = ${adhoc.filters.status}`)
  if (adhoc.filters?.employee_party_id) parts.push(sql`and tw.employee_party_id = ${adhoc.filters.employee_party_id}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and employee.display_name ilike ${query}`)
  }
  return sql.join(parts, sql` `)
}
