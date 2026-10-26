import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

export type TimesheetWeekStatus = "draft" | "submitted" | "approved" | "rejected";

export interface TimesheetWeekKey {
  employeePartyId: string;
  /** Sunday that opens the week (ISO date). */
  weekStart: string;
}

/** Sunday that opens the week containing an ISO calendar date. */
export function timesheetWeekStart(isoDate: string): string {
  const day = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) throw new Error(`invalid calendar date ${isoDate}`);
  day.setUTCDate(day.getUTCDate() - day.getUTCDay());
  return day.toISOString().slice(0, 10);
}

/**
 * The weekly header rows for a set of (employee, week) pairs, created on demand.
 *
 * A week becomes a record the first time anything touches it, whether the
 * timesheet editor, a field clock or a connector loading time, so the id an
 * approval flow, the inbox or a data-subject export needs always exists.
 *
 * A header created now inherits the state of the hours it covers rather than
 * assuming they are new: time arrives from imports and connectors as well as
 * the editor, and defaulting such a week to 'draft' would report approved
 * time as unsubmitted and re-offer it for approval. Existing headers are never
 * changed. Idempotent: concurrent creators race to the same unique
 * (org, employee, week) and the loser reads the winner's row.
 */
export async function ensureTimesheetWeeks(
  orgId: string,
  weeks: readonly TimesheetWeekKey[],
  actorId: string | null = null,
): Promise<
  Map<string, { id: string; status: TimesheetWeekStatus; rejectionReason: string | null }>
> {
  const unique = new Map<string, TimesheetWeekKey>();
  for (const week of weeks) {
    if (week.weekStart !== timesheetWeekStart(week.weekStart)) {
      throw new Error(`timesheet week ${week.weekStart} does not start on a Sunday`);
    }
    unique.set(timesheetWeekKey(week), week);
  }
  const result = new Map<
    string,
    { id: string; status: TimesheetWeekStatus; rejectionReason: string | null }
  >();
  const keys = [...unique.values()];
  for (let index = 0; index < keys.length; index += 500) {
    const batch = keys.slice(index, index + 500);
    const pairs = sql.join(
      batch.map((week) => sql`(${week.employeePartyId}::uuid, ${week.weekStart}::date)`),
      sql`, `,
    );
    await db.execute(sql`
      insert into timesheet_weeks
        (org_id, employee_party_id, week_start, status,
         approved_by, approved_at, rejection_reason, created_by, updated_by)
      select ${orgId}, wanted.employee_party_id, wanted.week_start,
             coalesce(seed.status, 'draft'), seed.approved_by, seed.approved_at,
             seed.rejection_reason, ${actorId}, ${actorId}
        from (values ${pairs}) as wanted(employee_party_id, week_start)
        cross join lateral (
          select case
                   when count(*) = 0 then null
                   when bool_and(te.status = 'approved') then 'approved'
                   when bool_or(te.status = 'submitted') then 'submitted'
                   when bool_or(te.status = 'rejected') then 'rejected'
                   else 'draft'
                 end as status,
                 (array_agg(te.approved_by) filter (where te.approved_by is not null))[1] as approved_by,
                 max(te.approved_at) as approved_at,
                 (array_agg(te.rejection_reason) filter (where te.rejection_reason is not null))[1] as rejection_reason
            from time_entries te
           where te.org_id = ${orgId}
             and te.employee_party_id = wanted.employee_party_id
             and te.worked_on >= wanted.week_start
             and te.worked_on <= wanted.week_start + 6
        ) seed
      -- A concurrent creator already opened this week; its row and workflow state stand.
      on conflict (org_id, employee_party_id, week_start) do nothing
    `);
    const rows = await db.execute<{
      id: string;
      employee_party_id: string;
      week_start: string;
      status: TimesheetWeekStatus;
      rejection_reason: string | null;
    }>(
      sql`
      select tw.id, tw.employee_party_id, to_char(tw.week_start, 'YYYY-MM-DD') as week_start,
             tw.status, tw.rejection_reason
        from timesheet_weeks tw
        join (values ${pairs}) as wanted(employee_party_id, week_start)
          on wanted.employee_party_id = tw.employee_party_id and wanted.week_start = tw.week_start
       where tw.org_id = ${orgId}
    `,
      "objects",
    );
    for (const row of rows) {
      result.set(
        timesheetWeekKey({ employeePartyId: row.employee_party_id, weekStart: row.week_start }),
        {
          id: row.id,
          status: row.status,
          rejectionReason: row.rejection_reason,
        },
      );
    }
    const missing = batch.filter((week) => !result.has(timesheetWeekKey(week)));
    if (missing.length > 0) {
      throw new Error(
        `timesheet week headers could not be created for ${missing.length} employee weeks (first: ${missing[0]!.employeePartyId} ${missing[0]!.weekStart})`,
      );
    }
  }
  return result;
}

export function timesheetWeekKey(week: TimesheetWeekKey): string {
  return `${week.employeePartyId}\0${week.weekStart}`;
}
