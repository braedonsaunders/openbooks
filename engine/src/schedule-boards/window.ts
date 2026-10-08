/**
 * The people-board read model for a date window: the people in the board's
 * scope (plus anyone booked on the board from elsewhere), every live booking
 * those people hold on any board, recorded leave, and the business calendar.
 * Bookings on other boards are returned read-only so a person is never shown
 * free on one board while booked on another.
 */
import { sql, type SQL } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { addCalendarDays } from "../platform/civil-date.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { BusinessCalendarMissingError, businessCalendarOver } from "../payroll/business-calendars.ts";
import { getBoard, peopleBoardAuthority, type ScheduleActor, type ScheduleBoard } from "./boards.ts";
import { ScheduleError, scheduleDatabaseRefusal } from "./errors.ts";
import { datesBetween, localClock, requireDate } from "./spans.ts";

export interface BoardPerson {
  readonly partyId: string;
  readonly name: string;
  readonly shortCode: string | null;
  readonly jobTitle: string | null;
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly tradeName: string | null;
  /** In the board's scope; false for people booked here from elsewhere. */
  readonly inScope: boolean;
}

export interface BoardTarget {
  readonly kind: "customer" | "project" | "location" | "code";
  readonly id: string;
  readonly code: string | null;
  readonly label: string;
  /** Customer name for a project. */
  readonly context: string | null;
  /** Code colour, or null for customers, projects and locations. */
  readonly color: string | null;
  /** Unavailable codes occupy a day without counting as work. */
  readonly counts: boolean;
}

export interface BoardEntry {
  readonly id: string;
  readonly revision: number;
  readonly boardId: string;
  readonly boardName: string;
  readonly workerPartyId: string;
  readonly status: "draft" | "published";
  readonly target: BoardTarget | null;
  readonly projectTaskId: string | null;
  readonly projectTaskName: string | null;
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly detail: string | null;
  readonly notes: string | null;
  readonly spanMode: "day" | "timed";
  readonly startsOn: string;
  readonly endsOn: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly startClock: string;
  readonly endClock: string;
  readonly breakMinutes: number;
  readonly workedMinutes: number;
  readonly seriesId: string | null;
  readonly supersedesId: string | null;
  readonly updatedAt: string;
  readonly updatedByName: string | null;
}

export interface BoardAbsence {
  readonly workerPartyId: string;
  readonly onDate: string;
  readonly hours: string;
  readonly leaveTypeCode: string;
  readonly leaveTypeName: string;
}

export interface BoardDay {
  readonly date: string;
  readonly weekday: number;
  readonly isWeekend: boolean;
  readonly isHoliday: boolean;
}

export interface BoardCode {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly category: "work" | "unavailable";
  readonly color: string;
}

export interface BoardWindow {
  readonly board: ScheduleBoard;
  readonly from: string;
  readonly through: string;
  readonly days: readonly BoardDay[];
  /** Null when the business calendar answers every date; otherwise why holidays are not shown. */
  readonly calendarNotice: string | null;
  readonly people: readonly BoardPerson[];
  readonly entries: readonly BoardEntry[];
  /** Published bookings a staged draft would replace, so the board can show what changes. */
  readonly replaced: readonly string[];
  readonly absences: readonly BoardAbsence[];
  readonly codes: readonly BoardCode[];
  readonly canManage: boolean;
  readonly canPublish: boolean;
}

/** Recursive descendants of a hierarchical row, the row included. */
function treeIds(table: "subsidiaries" | "departments" | "locations", orgId: string, rootId: string): SQL {
  return sql`(with recursive tree as (
      select id from ${sql.identifier(table)} where org_id = ${orgId} and id = ${rootId}
      union all
      select child.id from ${sql.identifier(table)} child join tree on child.parent_id = tree.id where child.org_id = ${orgId}
    ) select id from tree)`;
}

/** People whose role or current HR assignment places them inside the board's scope. */
export function boardScopeFilter(board: Pick<ScheduleBoard, "subsidiaryId" | "departmentId" | "locationId">, orgId: string, onDate: string): SQL {
  const parts: SQL[] = [];
  if (board.subsidiaryId) parts.push(sql`p.subsidiary_id in ${treeIds("subsidiaries", orgId, board.subsidiaryId)}`);
  if (board.departmentId) {
    parts.push(sql`(er.department_id in ${treeIds("departments", orgId, board.departmentId)} or exists (
      select 1 from worker_employments we join employment_assignment_versions v on v.org_id = we.org_id and v.employment_id = we.id
       where we.org_id = p.org_id and we.worker_party_id = p.id and v.is_primary and v.recorded_until is null
         and v.effective_from <= ${onDate} and (v.effective_to is null or v.effective_to > ${onDate})
         and v.department_id in ${treeIds("departments", orgId, board.departmentId)}))`);
  }
  if (board.locationId) {
    parts.push(sql`exists (
      select 1 from worker_employments we join employment_assignment_versions v on v.org_id = we.org_id and v.employment_id = we.id
       where we.org_id = p.org_id and we.worker_party_id = p.id and v.is_primary and v.recorded_until is null
         and v.effective_from <= ${onDate} and (v.effective_to is null or v.effective_to > ${onDate})
         and v.location_id in ${treeIds("locations", orgId, board.locationId)})`);
  }
  return parts.length ? sql.join(parts, sql` and `) : sql`true`;
}

export const ENTRY_COLUMNS = sql`e.id, e.revision, e.board_id as "boardId", eb.name as "boardName", e.worker_party_id as "workerPartyId", e.status,
  e.target_kind as "targetKind", coalesce(e.customer_party_id, e.project_id, e.location_id, e.schedule_code_id) as "targetId",
  coalesce(cp.short_code, pr.code, lo.code, sc.code) as "targetCode",
  coalesce(cp.display_name, pr.name, lo.name, sc.label) as "targetLabel",
  prc.display_name as "targetContext", sc.color as "targetColor", coalesce(sc.category, 'work') = 'work' as "targetCounts",
  e.project_task_id as "projectTaskId", pt.name as "projectTaskName",
  e.department_id as "departmentId", ed.name as "departmentName", e.detail, e.notes, e.span_mode as "spanMode",
  e.starts_on::text as "startsOn", e.ends_on::text as "endsOn",
  to_char(e.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "startsAt",
  to_char(e.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "endsAt",
  e.time_zone as "timeZone", e.break_minutes as "breakMinutes",
  greatest(0, (extract(epoch from e.ends_at - e.starts_at)::integer / 60) - e.break_minutes) as "workedMinutes",
  e.series_id as "seriesId", e.supersedes_id as "supersedesId",
  to_char(e.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "updatedAt", uu.name as "updatedByName"`;

export const ENTRY_JOINS = sql`from schedule_entries e
  join schedule_boards eb on eb.org_id = e.org_id and eb.id = e.board_id
  left join parties cp on cp.org_id = e.org_id and cp.id = e.customer_party_id
  left join projects pr on pr.org_id = e.org_id and pr.id = e.project_id
  left join parties prc on prc.org_id = pr.org_id and prc.id = pr.customer_id
  left join locations lo on lo.org_id = e.org_id and lo.id = e.location_id
  left join schedule_codes sc on sc.org_id = e.org_id and sc.id = e.schedule_code_id
  left join project_tasks pt on pt.org_id = e.org_id and pt.id = e.project_task_id
  left join departments ed on ed.org_id = e.org_id and ed.id = e.department_id
  left join users uu on uu.org_id = e.org_id and uu.id = e.updated_by`;

type EntryRow = Omit<BoardEntry, "target" | "startClock" | "endClock"> & {
  targetKind: BoardTarget["kind"] | null; targetId: string | null; targetCode: string | null; targetLabel: string | null;
  targetContext: string | null; targetColor: string | null; targetCounts: boolean; timeZone: string;
};

export function shapeEntry(row: EntryRow): BoardEntry {
  const { targetKind, targetId, targetCode, targetLabel, targetContext, targetColor, targetCounts, timeZone, ...rest } = row;
  return {
    ...rest,
    target: targetKind && targetId ? {
      kind: targetKind, id: targetId, code: targetCode, label: targetLabel ?? "", context: targetContext,
      color: targetColor, counts: targetCounts,
    } : null,
    startClock: localClock(row.startsAt, timeZone),
    endClock: localClock(row.endsAt, timeZone),
  };
}

export function loadBoardWindow(actor: ScheduleActor & { boardId: string; from: string; through?: string }): Promise<BoardWindow> {
  return withOrgTransaction(actor.orgId, () => readBoardWindow(actor)).catch((error: unknown) => { throw scheduleDatabaseRefusal(error); });
}

async function readBoardWindow(actor: ScheduleActor & { boardId: string; from: string; through?: string }): Promise<BoardWindow> {
  const board = await getBoard(actor, actor.boardId);
  if (board.rowKind !== "people") throw new ScheduleError("This board schedules project tasks.", { code: "schedule_wrong_board", remedy: "Open it in the Gantt view." });
  const allowed = await peopleBoardAuthority(actor, "hrm.shifts.read", board.subsidiaryId);
  const from = requireDate(actor.from, "Window start");
  const through = actor.through ? requireDate(actor.through, "Window end") : addCalendarDays(from, board.rangeDays - 1);
  const dates = datesBetween(from, through);
  const orgId = actor.orgId;

  const [canManage, canPublish] = await Promise.all([
    peopleBoardAuthority(actor, "hrm.shifts.manage", board.subsidiaryId).then(() => true, () => false),
    peopleBoardAuthority(actor, "hrm.shifts.approve", board.subsidiaryId).then(() => true, () => false),
  ]);

  const people = (await db.execute<BoardPerson>(sql`
    select p.id as "partyId", p.display_name as name, p.short_code as "shortCode", er.job_title as "jobTitle",
           er.department_id as "departmentId", d.name as "departmentName", tr.name as "tradeName",
           (${boardScopeFilter(board, orgId, from)}) as "inScope"
      from parties p
      join employee_roles er on er.org_id = p.org_id and er.party_id = p.id
      left join departments d on d.org_id = er.org_id and d.id = er.department_id
      left join trades tr on tr.org_id = er.org_id and tr.id = er.trade_id
     where p.org_id = ${orgId} and p.is_active and er.is_active
       and (er.hired_on is null or er.hired_on <= ${through})
       and (er.terminated_on is null or er.terminated_on >= ${from})
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowed)}
       and ((${boardScopeFilter(board, orgId, from)}) or exists (
         select 1 from schedule_entries x where x.org_id = p.org_id and x.board_id = ${board.id} and x.worker_party_id = p.id
            and x.status <> 'cancelled' and x.starts_on <= ${through} and x.ends_on >= ${from}))
     order by p.display_name, p.id
  `)).rows;

  const personIds = people.map((person) => person.partyId);
  const personFilter = personIds.length ? sql`= any(${`{${personIds.join(",")}}`}::uuid[])` : sql`is null and false`;

  const rawEntries = (await db.execute<EntryRow>(sql`select ${ENTRY_COLUMNS} ${ENTRY_JOINS}
    where e.org_id = ${orgId} and e.worker_party_id ${personFilter} and e.status <> 'cancelled'
      and e.starts_on <= ${through} and e.ends_on >= ${from}
      and (e.status = 'published' or e.board_id = ${board.id})
    order by e.starts_at, e.id`)).rows;
  const entries = rawEntries.map(shapeEntry);
  const replaced = entries.filter((entry) => entry.status === "draft" && entry.supersedesId).map((entry) => entry.supersedesId!);

  const absences = (await db.execute<BoardAbsence>(sql`
    select we.worker_party_id as "workerPartyId", a.on_date::text as "onDate", sum(a.hours)::text as hours,
           t.code as "leaveTypeCode", t.name as "leaveTypeName"
      from hrm_absences a
      join worker_employments we on we.org_id = a.org_id and we.id = a.employment_id
      join hrm_leave_types t on t.org_id = a.org_id and t.id = a.leave_type_id
     where a.org_id = ${orgId} and we.worker_party_id ${personFilter} and a.on_date between ${from} and ${through}
     group by we.worker_party_id, a.on_date, t.code, t.name
    having sum(a.hours) <> 0
     order by 2, 1
  `)).rows;

  const codes = (await db.execute<BoardCode>(sql`select id, code, label, category, color from schedule_codes
    where org_id = ${orgId} and is_active order by sort_order, code`)).rows;

  let calendarNotice: string | null = null;
  let calendar: Awaited<ReturnType<typeof businessCalendarOver>> | null = null;
  try {
    calendar = await businessCalendarOver(orgId, board.subsidiaryId, from, through);
  } catch (error) {
    if (!(error instanceof BusinessCalendarMissingError)) throw error;
    calendarNotice = "Holidays are not shown because no business calendar covers these dates. Add one in Setup → Business calendars.";
  }
  const days = dates.map((date) => {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const answer = calendar?.day(date);
    const isoWeekday = weekday === 0 ? 7 : weekday;
    return {
      date,
      weekday,
      // Weekends come from the business calendar too; without one the notice
      // above says why no day is marked.
      isWeekend: answer ? answer.weekendDays.has(isoWeekday) : false,
      isHoliday: answer?.isHoliday ?? false,
    };
  });

  return { board, from, through, days, calendarNotice, people, entries, replaced, absences, codes, canManage, canPublish };
}
