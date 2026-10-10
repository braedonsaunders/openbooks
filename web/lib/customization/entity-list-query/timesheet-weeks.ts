import { orderResourcesVisible } from "@openbooks/engine/src/manufacturing/workspace.ts";
import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";
import { subsidiaryVisibleFilter } from "../../subsidiaries";
import { pushCustomFieldFilter, uuidOrFalse } from "../list-query";

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
  if (clause.key !== 'status') {
    const refused = uuidOrFalse(value)
    if (refused) return refused
  }
  if (clause.operator === 'eq') return sql`${column} = ${value}`
  if (clause.operator === 'ne') return sql`${column} <> ${value}`
  return null
}

export function timesheetWeekWhere(
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): SQL {
  const parts: SQL[] = [sql`tw.org_id = ${orgId}`]
  parts.push(subsidiaryVisibleFilter(sql`employee.subsidiary_id`, allowedSubsidiaryIds ?? null))
  // A week is one approval unit. Hide it in full if any target is outside the viewer's current resource scope.
  parts.push(sql`and not exists (
    select 1 from time_entries entry
    left join projects project on project.org_id=entry.org_id and project.id=entry.project_id
    left join mfg_work_orders work on work.org_id=entry.org_id and work.id=entry.work_order_id
    where entry.org_id=tw.org_id and entry.employee_party_id=tw.employee_party_id
      and entry.worked_on>=tw.week_start and entry.worked_on<tw.week_start+7
      and ((entry.project_id is not null and (project.id is null or not (true ${subsidiaryVisibleFilter(sql`project.subsidiary_id`,allowedSubsidiaryIds ?? null)})))
        or (entry.work_order_id is not null and (work.id is null or not (true ${subsidiaryVisibleFilter(sql`work.subsidiary_id`,allowedSubsidiaryIds ?? null)} ${orderResourcesVisible(allowedSubsidiaryIds ?? null,'work')}))))
  )`)
  for (const filter of view.filters) {
    if (pushCustomFieldFilter(parts, filter, null)) continue
    const predicate = timesheetWeekFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.status) parts.push(sql`and tw.status = ${adhoc.filters.status}`)
  if (adhoc.filters?.employee_party_id) {
    const refused = uuidOrFalse(adhoc.filters.employee_party_id)
    parts.push(refused ? sql`and ${refused}` : sql`and tw.employee_party_id = ${adhoc.filters.employee_party_id}`)
  }
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and employee.display_name ilike ${query}`)
  }
  return sql.join(parts, sql` `)
}
