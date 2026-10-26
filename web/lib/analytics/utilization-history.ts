import "server-only";
import { analyticsQuery } from "./query";
import { sql } from "drizzle-orm";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import { utcDateFromParts } from "@openbooks/engine/platform/business-date/module";

export interface HistoryWindow {
  /** Inclusive ISO start of one prior window. */
  start: string;
  /** Inclusive ISO end of one prior window. */
  end: string;
  /** The window's end month as `YYYY-MM`, for month labels. */
  endYm: string;
}

/**
 * Rolling prior windows behind a selected range, each the range's own
 * month-length, newest first. A window always runs start ≤ end: the end is
 * the last day of the month `periodMonths` before the range end's month,
 * and the start is that window's first day — month underflow normalizes
 * across year boundaries instead of producing a reversed or wrong-year
 * window. Pure date math (no DB); the dashboard labels and deduplicates.
 */
export function planHistoryWindows(
  rangeFrom: string,
  rangeTo: string,
  count = 5,
): { periodMonths: number; windows: HistoryWindow[] } {
  const rangeStart = new Date(rangeFrom + "T00:00:00Z");
  const rangeEnd = new Date(rangeTo + "T00:00:00Z");
  const periodMonths =
    (rangeEnd.getUTCFullYear() - rangeStart.getUTCFullYear()) * 12 +
    (rangeEnd.getUTCMonth() - rangeStart.getUTCMonth()) +
    1;
  const ymd = (d: Date) =>
    `${String(d.getUTCFullYear()).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const out: HistoryWindow[] = [];
  for (let i = 1; i <= count; i++) {
    // utcDateFromParts keeps literal years 0001-0099 that Date.UTC would
    // remap onto 1900-1999.
    const pEnd = utcDateFromParts(
      rangeEnd.getUTCFullYear(),
      rangeEnd.getUTCMonth() - i * periodMonths + 1,
      0,
    );
    const pStart = utcDateFromParts(
      pEnd.getUTCFullYear(),
      pEnd.getUTCMonth() - periodMonths + 1,
      1,
    );
    out.push({
      start: ymd(pStart),
      end: ymd(pEnd),
      endYm: `${pEnd.getUTCFullYear()}-${String(pEnd.getUTCMonth() + 1).padStart(2, "0")}`,
    });
  }
  return { periodMonths, windows: out };
}

export function timeStatsSource(
  orgId: string,
  from: string,
  to: string,
  allowed: ReadonlySet<string> | null,
) {
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

export interface HistoryHours extends Record<string, unknown> {
  department: string | null;
  total_hours: string;
  billable_hours: string;
}
export async function fetchHistoryHours(
  orgId: string,
  plans: { start: string; end: string }[],
  allowed: ReadonlySet<string> | null,
): Promise<HistoryHours[][]> {
  if (!plans.length) return [];
  const windows = sql.join(
    plans.map((plan, index) => sql`(${index}::integer, ${plan.start}::date, ${plan.end}::date)`),
    sql`, `,
  );
  const from = plans.map((plan) => plan.start).sort()[0]!;
  const to = plans
    .map((plan) => plan.end)
    .sort()
    .at(-1)!;
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
