/**
 * Board definitions and the authority to use them. A people board is gated
 * by Scheduling (People) and the roster permissions; a task board by Project
 * Scheduling and the project permissions. A board scoped to a subsidiary is
 * invisible to callers outside that subsidiary.
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { ScheduleError } from "./errors.ts";

export interface ScheduleActor {
  readonly orgId: string;
  readonly actorId: string;
}

export type PeopleSchedulePermission = "hrm.shifts.read" | "hrm.shifts.manage" | "hrm.shifts.approve";

export interface ScheduleBoard {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly rowKind: "people" | "tasks" | "resources";
  readonly resourceKind: "equipment" | "location" | null;
  readonly showTotals: boolean;
  readonly weekendDays: readonly string[];
  readonly cellColorRules: readonly import("./display.ts").CellColorRule[];
  readonly subsidiaryId: string | null;
  readonly subsidiaryName: string | null;
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly locationId: string | null;
  readonly locationName: string | null;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly grain: "day" | "timed";
  readonly views: readonly string[];
  readonly defaultView: string;
  readonly rangeDays: number;
  readonly weekStartsOn: number;
  readonly showWeekends: boolean;
  readonly timeZone: string;
  readonly dayStarts: string;
  readonly dayPolicyKnown: boolean;
  readonly dayEnds: string;
  readonly dayBreakMinutes: number;
  readonly publishPolicy: "live" | "staged";
  readonly prefillTimesheets: boolean;
  readonly prefillCrewTime: boolean;
  readonly prefillFieldTickets: boolean;
  readonly notifyAssignees: boolean;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export const BOARD_COLUMNS = sql`b.id, b.code, b.name, b.description, b.row_kind as "rowKind", b.resource_kind as "resourceKind",
  b.show_totals as "showTotals", b.weekend_days as "weekendDays", b.cell_color_rules as "cellColorRules",
  b.subsidiary_id as "subsidiaryId", s.name as "subsidiaryName",
  b.department_id as "departmentId", d.name as "departmentName",
  b.location_id as "locationId", l.name as "locationName",
  b.project_id as "projectId", p.name as "projectName",
  b.grain, b.views, b.default_view as "defaultView", b.range_days as "rangeDays", b.week_starts_on as "weekStartsOn",
  b.show_weekends as "showWeekends", b.time_zone as "timeZone",
  to_char(b.day_starts, 'HH24:MI') as "dayStarts", to_char(b.day_ends, 'HH24:MI') as "dayEnds",
  b.day_break_minutes as "dayBreakMinutes", b.day_policy_known as "dayPolicyKnown", b.publish_policy as "publishPolicy",
  b.prefill_timesheets as "prefillTimesheets", b.prefill_crew_time as "prefillCrewTime",
  b.prefill_field_tickets as "prefillFieldTickets", b.notify_assignees as "notifyAssignees",
  b.sort_order as "sortOrder", b.is_active as "isActive"`;

export const BOARD_JOINS = sql`from schedule_boards b
  left join subsidiaries s on s.org_id = b.org_id and s.id = b.subsidiary_id
  left join departments d on d.org_id = b.org_id and d.id = b.department_id
  left join locations l on l.org_id = b.org_id and l.id = b.location_id
  left join projects p on p.org_id = b.org_id and p.id = b.project_id`;

/** Which board families the organization has switched on. */
export async function enabledBoardKinds(orgId: string): Promise<{ people: boolean; tasks: boolean; resources: boolean }> {
  const [hrm, shifts, projects, scheduling] = await Promise.all([
    lockAndCheckOrgFeature(db, orgId, "hrm"),
    lockAndCheckOrgFeature(db, orgId, "hrmShiftPlanning"),
    lockAndCheckOrgFeature(db, orgId, "projects"),
    lockAndCheckOrgFeature(db, orgId, "projectScheduling"),
  ]);
  return { people: hrm && shifts, tasks: projects && scheduling, resources: projects && scheduling };
}

/**
 * Lock the caller's authority for a people-board command. Refuses when
 * Scheduling is switched off, the permission is missing, or the board's
 * subsidiary is outside the caller's scope.
 */
export async function peopleBoardAuthority(actor: ScheduleActor, permission: PeopleSchedulePermission, subsidiaryId: string | null): Promise<ReadonlySet<string> | null> {
  if (!await lockAndCheckOrgFeature(db, actor.orgId, "hrm") || !await lockAndCheckOrgFeature(db, actor.orgId, "hrmShiftPlanning")) {
    throw new ScheduleError("Scheduling is switched off for this organization.", {
      status: 404,
      code: "schedule_disabled",
      remedy: "Enable Human Resources and Scheduling on Company Settings → Features; existing bookings are preserved.",
    });
  }
  return lockActorCommandAuthority(db, actor.orgId, actor.actorId, subsidiaryId, permission);
}

/** Resource bookings share project scheduling authority and native asset visibility. */
export async function boardAuthority(actor: ScheduleActor, board: ScheduleBoard, mode: "read" | "manage" | "publish"): Promise<ReadonlySet<string> | null> {
  if (board.rowKind === "people") return peopleBoardAuthority(actor, mode === "read" ? "hrm.shifts.read" : mode === "publish" ? "hrm.shifts.approve" : "hrm.shifts.manage", board.subsidiaryId);
  if (board.rowKind !== "resources") throw new ScheduleError("Open this task board in the Gantt view.", { code: "schedule_wrong_board" });
  if (!await lockAndCheckOrgFeature(db, actor.orgId, "projects") || !await lockAndCheckOrgFeature(db, actor.orgId, "projectScheduling"))
    throw new ScheduleError("Project Scheduling is switched off.", { status: 404, remedy: "Enable Projects and Project Scheduling in Company Settings → Features." });
  if (board.resourceKind === "equipment") {
    if (!await lockAndCheckOrgFeature(db, actor.orgId, "equipment")) throw new ScopeNotFoundError();
    await lockActorCommandAuthority(db, actor.orgId, actor.actorId, board.subsidiaryId, mode === "read" ? "assets.read" : "assets.manage");
  }
  return lockActorCommandAuthority(db, actor.orgId, actor.actorId, board.subsidiaryId, mode === "read" ? "projects.read" : "projects.manage");
}

function visibleTo(allowed: ReadonlySet<string> | null, board: { subsidiaryId: string | null }): boolean {
  return allowed === null || board.subsidiaryId === null || allowed.has(board.subsidiaryId);
}

/** Every active board the caller may open, in display order. */
export function listBoards(actor: ScheduleActor, options: { includeArchived?: boolean } = {}): Promise<ScheduleBoard[]> {
  return withOrgTransaction(actor.orgId, () => readBoards(actor, options));
}

async function readBoards(actor: ScheduleActor, options: { includeArchived?: boolean }): Promise<ScheduleBoard[]> {
  const kinds = await enabledBoardKinds(actor.orgId);
  if (!kinds.people && !kinds.tasks) return [];
  const allowed = await actorAllowedSubsidiaryIds(db, actor.orgId, actor.actorId);
  const rows = (await db.execute<ScheduleBoard>(sql`select ${BOARD_COLUMNS} ${BOARD_JOINS}
    where b.org_id = ${actor.orgId} ${options.includeArchived ? sql`` : sql`and b.is_active`}
    order by b.sort_order, b.name, b.id`)).rows;
  return rows.filter((board) => (board.rowKind === "people" ? kinds.people : board.rowKind === "resources" ? kinds.resources : kinds.tasks) && visibleTo(allowed, board));
}

/** One board by id or code, or a not-found refusal identical for absent and out-of-scope boards. */
export async function getBoard(actor: ScheduleActor, idOrCode: string): Promise<ScheduleBoard> {
  const filter = isUuid(idOrCode) ? sql`b.id = ${idOrCode}` : sql`b.code = ${idOrCode}`;
  const board = (await db.execute<ScheduleBoard>(sql`select ${BOARD_COLUMNS} ${BOARD_JOINS}
    where b.org_id = ${actor.orgId} and ${filter}`)).rows[0];
  if (!board) throw new ScopeNotFoundError();
  const kinds = await enabledBoardKinds(actor.orgId);
  if (!(board.rowKind === "people" ? kinds.people : board.rowKind === "resources" ? kinds.resources : kinds.tasks)) throw new ScopeNotFoundError();
  const allowed = await actorAllowedSubsidiaryIds(db, actor.orgId, actor.actorId);
  if (!visibleTo(allowed, board)) throw new ScopeNotFoundError();
  return board;
}
