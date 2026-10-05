import "server-only";
import { analyticsQuery } from "./query";
import { sql } from "drizzle-orm";
import { subsidiaryVisibleFilter } from "../subsidiaries";

export function timeStatsSource(orgId: string, from: string, to: string, allowed: ReadonlySet<string> | null) {
  return {
    from: sql`time_entries t
      left join parties p on p.id = t.employee_party_id and p.org_id = t.org_id
      left join projects project on project.id = t.project_id and project.org_id = t.org_id`,
    // Worked reality is approved time only, with the same project/employee
    // legal-entity boundary for detail and historical aggregate reads.
    where: sql`t.org_id = ${orgId} and t.worked_on >= ${from} and t.worked_on <= ${to}
      and t.status = 'approved'
      ${subsidiaryVisibleFilter(sql`coalesce(project.subsidiary_id, p.subsidiary_id)`, allowed)}`,
  };
}

export interface HistoryHours extends Record<string, unknown> { department: string | null; total_hours: string; billable_hours: string }
export async function fetchHistoryHours(orgId: string, plans: { start: string; end: string }[], allowed: ReadonlySet<string> | null): Promise<HistoryHours[][]> {
  if (!plans.length) return [];
  const windows = sql.join(plans.map((plan, index) => sql`(${index}::integer, ${plan.start}::date, ${plan.end}::date)`), sql`, `);
  const from = plans.map((plan) => plan.start).sort()[0]!;
  const to = plans.map((plan) => plan.end).sort().at(-1)!;
  const source = timeStatsSource(orgId, from, to, allowed);
  const result = await analyticsQuery<HistoryHours & { window_index: number }>(sql`
    select periods.window_index, t.department_id as department,
      sum(t.hours)::text as total_hours,
      coalesce(sum(t.hours) filter (where t.is_billable), 0)::text as billable_hours
    from ${source.from}
    join (values ${windows}) as periods(window_index, starts_on, ends_on)
      on t.worked_on between periods.starts_on and periods.ends_on
    where ${source.where}
    group by periods.window_index, t.department_id
  `);
  return plans.map((_, index) => result.rows.filter((row) => row.window_index === index));
}
