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
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { ScheduleError } from "./errors.ts";
import {
  boardHasCapability,
  boardTypeRequiredFeatures,
  SCHEDULE_CAPABILITY_FEATURES,
  type ScheduleBoardCapability,
} from "./board-types.ts";

export interface ScheduleActor {
  readonly orgId: string;
  readonly actorId: string;
}

export type PeopleSchedulePermission =
  "hrm.shifts.read" | "hrm.shifts.manage" | "hrm.shifts.approve";

export type ScheduleBoard = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly rowKind: "people" | "tasks" | "resources";
  /** The registered board type (see board-types.ts); fixed for the board's life. */
  readonly boardType: string;
  readonly resourceKind: "equipment" | "location" | null;
  readonly showTotals: boolean;
  readonly automaticDeliveryPolicy: unknown;
  readonly showHoursColumn: boolean;
  readonly distributionVisibility: "personal" | "board";
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
  readonly projectSubsidiaryId: string | null;
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
};

/** Board storage uses ISO weekday strings (Monday 1, Sunday 7); report
 * layouts use JavaScript weekdays (Sunday 0). Keep conversion at the report
 * boundary so the native window and retained board policy stay unchanged. */
export function scheduleReportWeekendDays(board: Pick<ScheduleBoard, "weekendDays">): number[] {
  return board.weekendDays.map((day) => Number(day) % 7);
}

export const BOARD_COLUMNS = sql`b.id, b.code, b.name, b.description, b.row_kind as "rowKind", b.board_type as "boardType", b.resource_kind as "resourceKind",
  b.automatic_delivery_policy as "automaticDeliveryPolicy", b.show_totals as "showTotals", b.show_hours_column as "showHoursColumn", b.distribution_visibility as "distributionVisibility", b.weekend_days as "weekendDays", b.cell_color_rules as "cellColorRules",
  b.subsidiary_id as "subsidiaryId", s.name as "subsidiaryName",
  b.department_id as "departmentId", d.name as "departmentName",
  b.location_id as "locationId", l.name as "locationName",
  b.project_id as "projectId", p.name as "projectName", p.subsidiary_id as "projectSubsidiaryId",
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
export async function enabledBoardKinds(
  orgId: string,
): Promise<{ people: boolean; tasks: boolean; resources: boolean }> {
  const [hrm, shifts, projects, scheduling] = await Promise.all([
    lockAndCheckOrgFeature(db, orgId, "hrm"),
    lockAndCheckOrgFeature(db, orgId, "hrmShiftPlanning"),
    lockAndCheckOrgFeature(db, orgId, "projects"),
    lockAndCheckOrgFeature(db, orgId, "projectScheduling"),
  ]);
  return {
    people: hrm && shifts,
    tasks: projects && scheduling,
    resources: projects && scheduling,
  };
}

/**
 * Lock the caller's authority for a people-board command. Refuses when
 * Scheduling is switched off, the permission is missing, or the board's
 * subsidiary is outside the caller's scope.
 */
export async function peopleBoardAuthority(
  actor: ScheduleActor,
  permission: PeopleSchedulePermission,
  subsidiaryId: string | null,
): Promise<ReadonlySet<string> | null> {
  if (
    !(await lockAndCheckOrgFeature(db, actor.orgId, "hrm")) ||
    !(await lockAndCheckOrgFeature(db, actor.orgId, "hrmShiftPlanning"))
  ) {
    throw new ScheduleError("Scheduling is switched off for this organization.", {
      status: 404,
      code: "schedule_disabled",
      remedy:
        "Enable Human Resources and Scheduling on Company Settings → Features; existing bookings are preserved.",
    });
  }
  return lockActorCommandAuthority(db, actor.orgId, actor.actorId, subsidiaryId, permission);
}

/**
 * Lock the caller's authority for a dispatch-board command. Dispatch boards
 * book technicians for service visits, so they answer to the service
 * permissions rather than the shift-planning ones; Scheduling and Service
 * dispatch must both be on.
 */
async function dispatchBoardAuthority(
  actor: ScheduleActor,
  board: ScheduleBoard,
  mode: "read" | "manage" | "publish",
): Promise<ReadonlySet<string> | null> {
  if (
    !(await lockAndCheckOrgFeature(db, actor.orgId, "hrm")) ||
    !(await lockAndCheckOrgFeature(db, actor.orgId, "hrmShiftPlanning")) ||
    !(await lockAndCheckOrgFeature(db, actor.orgId, "serviceDispatch"))
  ) {
    throw new ScheduleError("Service dispatch is switched off for this organization.", {
      status: 404,
      code: "schedule_disabled",
      remedy:
        "Enable Human Resources, Scheduling and Service dispatch on Company Settings → Features; existing bookings are preserved.",
    });
  }
  return lockActorCommandAuthority(
    db,
    actor.orgId,
    actor.actorId,
    board.subsidiaryId,
    mode === "read" ? "service.read" : "service.dispatch",
  );
}

/** Resource bookings share project scheduling authority and native asset visibility. */
export async function boardAuthority(
  actor: ScheduleActor,
  board: ScheduleBoard,
  mode: "read" | "manage" | "publish",
): Promise<ReadonlySet<string> | null> {
  if (board.rowKind === "people" && boardHasCapability(board, "dispatch"))
    return dispatchBoardAuthority(actor, board, mode);
  if (board.rowKind === "people")
    return peopleBoardAuthority(
      actor,
      mode === "read"
        ? "hrm.shifts.read"
        : mode === "publish"
          ? "hrm.shifts.approve"
          : "hrm.shifts.manage",
      board.subsidiaryId,
    );
  if (board.rowKind !== "resources")
    throw new ScheduleError("Open this task board in the Gantt view.", {
      code: "schedule_wrong_board",
    });
  if (
    !(await lockAndCheckOrgFeature(db, actor.orgId, "projects")) ||
    !(await lockAndCheckOrgFeature(db, actor.orgId, "projectScheduling"))
  )
    throw new ScheduleError("Project Scheduling is switched off.", {
      status: 404,
      remedy: "Enable Projects and Project Scheduling in Company Settings → Features.",
    });
  if (board.resourceKind === "equipment") {
    if (!(await lockAndCheckOrgFeature(db, actor.orgId, "equipment")))
      throw new ScopeNotFoundError();
    await lockActorCommandAuthority(
      db,
      actor.orgId,
      actor.actorId,
      board.subsidiaryId,
      mode === "read" ? "assets.read" : "assets.manage",
    );
  }
  return lockActorCommandAuthority(
    db,
    actor.orgId,
    actor.actorId,
    board.subsidiaryId,
    mode === "read" ? "projects.read" : "projects.manage",
  );
}

function visibleTo(
  allowed: ReadonlySet<string> | null,
  board: { subsidiaryId: string | null },
): boolean {
  return allowed === null || board.subsidiaryId === null || allowed.has(board.subsidiaryId);
}

/** Every active board the caller may open, in display order. */
export function listBoards(
  actor: ScheduleActor,
  options: { includeArchived?: boolean; generalOnly?: boolean; projectId?: string } = {},
): Promise<ScheduleBoard[]> {
  return withOrgTransaction(actor.orgId, () => readBoards(actor, options));
}

/** Whether every feature a board's type is built around is switched on. */
async function boardTypeEnabled(
  orgId: string,
  board: Pick<ScheduleBoard, "boardType">,
): Promise<boolean> {
  for (const feature of boardTypeRequiredFeatures(board.boardType)) {
    if (!(await lockAndCheckOrgFeature(db, orgId, feature))) return false;
  }
  return true;
}

async function readBoards(
  actor: ScheduleActor,
  options: { includeArchived?: boolean; generalOnly?: boolean; projectId?: string },
): Promise<ScheduleBoard[]> {
  const kinds = await enabledBoardKinds(actor.orgId);
  if (!kinds.people && !kinds.tasks) return [];
  const allowed = await actorAllowedSubsidiaryIds(db, actor.orgId, actor.actorId);
  const rows = await db.execute<ScheduleBoard>(
    sql`select ${BOARD_COLUMNS} ${BOARD_JOINS}
    where b.org_id = ${actor.orgId} ${options.generalOnly ? sql`and b.row_kind <> 'tasks' and b.project_id is null` : sql``} ${options.projectId ? sql`and b.project_id=${options.projectId}` : sql``} ${options.includeArchived ? sql`` : sql`and b.is_active`}
    order by b.sort_order, b.name, b.id`,
    "objects",
  );
  const canReadProjects =
    rows.some((board) => board.projectId) &&
    kinds.tasks &&
    (await actorHasPermission(db, actor.orgId, actor.actorId, "projects.read"));
  const typeEnabled = new Map<string, boolean>();
  for (const type of new Set(rows.map((board) => board.boardType)))
    typeEnabled.set(type, await boardTypeEnabled(actor.orgId, { boardType: type }));
  return rows
    .filter((board) => typeEnabled.get(board.boardType) !== false)
    .filter(
      (board) =>
        (board.rowKind === "people"
          ? kinds.people
          : board.rowKind === "resources"
            ? kinds.resources
            : kinds.tasks) &&
        visibleTo(allowed, board) &&
        (!board.projectId ||
          (canReadProjects &&
            (allowed === null ||
              (board.projectSubsidiaryId !== null && allowed.has(board.projectSubsidiaryId))))),
    );
}

/** One board by id or code, or a not-found refusal identical for absent and out-of-scope boards. */
export async function getBoard(actor: ScheduleActor, idOrCode: string): Promise<ScheduleBoard> {
  const filter = isUuid(idOrCode) ? sql`b.id = ${idOrCode}` : sql`b.code = ${idOrCode}`;
  const board = (
    await db.execute<ScheduleBoard>(
      sql`select ${BOARD_COLUMNS} ${BOARD_JOINS}
    where b.org_id = ${actor.orgId} and ${filter}`,
      "objects",
    )
  )[0];
  if (!board) throw new ScopeNotFoundError();
  const kinds = await enabledBoardKinds(actor.orgId);
  if (
    !(board.rowKind === "people"
      ? kinds.people
      : board.rowKind === "resources"
        ? kinds.resources
        : kinds.tasks)
  )
    throw new ScopeNotFoundError();
  if (!(await boardTypeEnabled(actor.orgId, board))) throw new ScopeNotFoundError();
  const allowed = await actorAllowedSubsidiaryIds(db, actor.orgId, actor.actorId);
  if (
    board.projectId &&
    (!kinds.tasks ||
      (allowed !== null &&
        (board.projectSubsidiaryId === null || !allowed.has(board.projectSubsidiaryId))))
  )
    throw new ScopeNotFoundError();
  if (!visibleTo(allowed, board)) throw new ScopeNotFoundError();
  if (board.projectId)
    await lockActorCommandAuthority(
      db,
      actor.orgId,
      actor.actorId,
      board.projectSubsidiaryId,
      "projects.read",
    );
  return board;
}

/**
 * Refuse a command that needs a capability the board's type does not
 * declare, or whose capability features are switched off.
 */
export async function requireBoardCapability(
  actor: ScheduleActor,
  board: ScheduleBoard,
  capability: ScheduleBoardCapability,
): Promise<void> {
  if (!boardHasCapability(board, capability)) {
    throw new ScheduleError("This board's type does not offer that capability.", {
      code: "schedule_capability_unavailable",
      remedy:
        capability === "dispatch"
          ? "Assign service visits on a dispatch board."
          : "Use a shift roster board for recurring patterns, shift requests, governed publication and attendance.",
    });
  }
  for (const feature of SCHEDULE_CAPABILITY_FEATURES[capability]) {
    if (!(await lockAndCheckOrgFeature(db, actor.orgId, feature))) {
      throw new ScheduleError("A feature this board capability needs is switched off.", {
        status: 404,
        code: "schedule_capability_disabled",
        remedy: "Enable it on Company Settings → Features; existing history is preserved.",
      });
    }
  }
}
