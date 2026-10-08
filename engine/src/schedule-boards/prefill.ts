/**
 * Scheduled work offered to the editors that record actual work. A board's
 * pre-fill settings decide which editors see its published bookings: the
 * weekly timesheet, the foreman's crew sheet and the field ticket. The
 * editors add the suggestions through their own commands, so a suggestion
 * never bypasses timesheet lifecycle, crew authority or ticket approval, and
 * a booking cancelled before it is confirmed leaves nothing behind.
 */
import { sql } from "drizzle-orm";
import { div } from "../money/money.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { ScheduleError, scheduleDatabaseRefusal } from "./errors.ts";
import { requireDate } from "./spans.ts";

export type PrefillUse = "timesheets" | "crew" | "fieldTickets";

export interface ScheduledWork {
  readonly entryId: string;
  readonly boardName: string;
  readonly workerPartyId: string;
  readonly workerName: string;
  readonly onDate: string;
  readonly hours: string;
  readonly projectId: string | null;
  readonly projectTaskId: string | null;
  readonly targetLabel: string;
  readonly detail: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
}

const FLAG = { timesheets: sql`b.prefill_timesheets`, crew: sql`b.prefill_crew_time`, fieldTickets: sql`b.prefill_field_tickets` } as const;

/**
 * Published, working bookings in a date range for one person or one
 * project, from boards whose setting offers them to this editor. Callers
 * have already authorized the person or project through the editor's own
 * permissions; this read stays inside the organization.
 */
export interface ScheduledWorkQuery {
  readonly orgId: string;
  readonly use: PrefillUse;
  readonly from: string;
  readonly through: string;
  readonly workerPartyId?: string;
  readonly projectId?: string;
}

export async function scheduledWork(input: ScheduledWorkQuery): Promise<ScheduledWork[]> {
  try {
    return await withOrgTransaction(input.orgId, () => readScheduledWork(input));
  } catch (error) {
    // Before the scheduling upgrade there are no bookings to offer; the
    // editor itself keeps working.
    const refusal = scheduleDatabaseRefusal(error);
    if (refusal instanceof ScheduleError && refusal.code === "schedule_upgrade_required") return [];
    throw error;
  }
}

async function readScheduledWork(input: ScheduledWorkQuery): Promise<ScheduledWork[]> {
  const from = requireDate(input.from, "From");
  const through = requireDate(input.through, "Through");
  if (through < from) throw new ScheduleError("The range ends before it starts.", { code: "schedule_invalid_range" });
  if (input.workerPartyId !== undefined && !isUuid(input.workerPartyId)) throw new ScheduleError("The person is not recognized.", { code: "schedule_invalid" });
  if (input.projectId !== undefined && !isUuid(input.projectId)) throw new ScheduleError("The project is not recognized.", { code: "schedule_invalid" });
  if (!input.workerPartyId && !input.projectId) throw new ScheduleError("Name a person or a project.", { code: "schedule_invalid" });
  // Scheduling switched off means nothing is offered; existing bookings are preserved.
  if (!await lockAndCheckOrgFeature(db, input.orgId, "hrmShiftPlanning")) return [];
  const rows = (await db.execute<Omit<ScheduledWork, "hours"> & { minutes: number }>(sql`
    select e.id as "entryId", b.name as "boardName", e.worker_party_id as "workerPartyId", p.display_name as "workerName",
           e.starts_on::text as "onDate",
           greatest(0, (extract(epoch from e.ends_at - e.starts_at)::integer / 60) - e.break_minutes) as minutes,
           e.project_id as "projectId", e.project_task_id as "projectTaskId",
           coalesce(pr.name, cp.display_name, lo.name, sc.label, b.name) as "targetLabel", e.detail,
           to_char(e.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "startsAt",
           to_char(e.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "endsAt"
      from schedule_entries e
      join schedule_boards b on b.org_id = e.org_id and b.id = e.board_id
      join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
      left join projects pr on pr.org_id = e.org_id and pr.id = e.project_id
      left join parties cp on cp.org_id = e.org_id and cp.id = e.customer_party_id
      left join locations lo on lo.org_id = e.org_id and lo.id = e.location_id
      left join schedule_codes sc on sc.org_id = e.org_id and sc.id = e.schedule_code_id
     where e.org_id = ${input.orgId} and e.status = 'published' and ${FLAG[input.use]}
       and e.starts_on between ${from} and ${through}
       and (e.schedule_code_id is null or sc.category = 'work')
       ${input.workerPartyId ? sql`and e.worker_party_id = ${input.workerPartyId}` : sql``}
       ${input.projectId ? sql`and e.project_id = ${input.projectId}` : sql``}
     order by e.starts_on, p.display_name, e.starts_at, e.id
  `)).rows;
  return rows.map(({ minutes, ...row }) => ({ ...row, hours: div(String(minutes), "60") }));
}
