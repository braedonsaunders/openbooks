/**
 * Booking targets: where a booked person goes. A target is always a native
 * record — a customer, a project (optionally one of its tasks), a location,
 * or an organization schedule code — never free text, so travel, reports and
 * timesheets read the same identity the scheduler picked.
 */
import { sql, type SQL } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { getBoard, peopleBoardAuthority, type ScheduleActor } from "./boards.ts";
import { ScheduleError } from "./errors.ts";
import type { BoardTarget } from "./window.ts";

export interface TargetRef {
  readonly kind: BoardTarget["kind"];
  readonly id: string;
}

export interface ResolvedTarget {
  readonly kind: BoardTarget["kind"];
  readonly customerPartyId: string | null;
  readonly projectId: string | null;
  readonly projectTaskId: string | null;
  readonly locationId: string | null;
  readonly scheduleCodeId: string | null;
  readonly label: string;
}

const KINDS = new Set(["customer", "project", "location", "code"]);

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** Rank exact code matches first, then code prefixes, then name matches. */
function rank(code: SQL, label: SQL, query: string): SQL {
  const exact = query.toLowerCase();
  return sql`case when lower(${code}) = ${exact} then 0 when lower(${code}) like ${`${escapeLike(exact)}%`} then 1
    when lower(${label}) like ${`${escapeLike(exact)}%`} then 2 else 3 end`;
}

export function searchTargets(actor: ScheduleActor & { boardId: string; query: string; limit?: number }): Promise<BoardTarget[]> {
  return withOrgTransaction(actor.orgId, () => findTargets(actor));
}

async function findTargets(actor: ScheduleActor & { boardId: string; query: string; limit?: number }): Promise<BoardTarget[]> {
  const board = await getBoard(actor, actor.boardId);
  const allowed = await peopleBoardAuthority(actor, "hrm.shifts.read", board.subsidiaryId);
  const query = actor.query.trim().slice(0, 80);
  const limit = Math.min(Math.max(actor.limit ?? 12, 1), 40);
  const pattern = `%${escapeLike(query.toLowerCase())}%`;
  const orgId = actor.orgId;
  const match = (code: SQL, label: SQL) => query ? sql`(lower(coalesce(${code}, '')) like ${pattern} or lower(${label}) like ${pattern})` : sql`true`;

  const rows = (await db.execute<BoardTarget & { score: number }>(sql`
    select * from (
      select 'code' as kind, sc.id, sc.code, sc.label, null::text as context, sc.color, sc.category = 'work' as counts,
             ${rank(sql`sc.code`, sql`sc.label`, query)} as score, 0 as family
        from schedule_codes sc where sc.org_id = ${orgId} and sc.is_active and ${match(sql`sc.code`, sql`sc.label`)}
      union all
      select 'customer', p.id, p.short_code, p.display_name, null, null, true,
             ${rank(sql`p.short_code`, sql`p.display_name`, query)}, 1
        from parties p join customer_roles cr on cr.org_id = p.org_id and cr.party_id = p.id
       where p.org_id = ${orgId} and p.is_active ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowed, { orgWideNull: true })}
         and ${match(sql`p.short_code`, sql`p.display_name`)}
      union all
      select 'project', pr.id, pr.code, pr.name, c.display_name, null, true,
             ${rank(sql`pr.code`, sql`pr.name`, query)}, 2
        from projects pr left join parties c on c.org_id = pr.org_id and c.id = pr.customer_id
       where pr.org_id = ${orgId} and pr.is_active and pr.status = 'active'
         ${subsidiaryVisibleFilter(sql`pr.subsidiary_id`, allowed, { orgWideNull: true })}
         and (${match(sql`pr.code`, sql`pr.name`)} or ${query ? sql`lower(coalesce(c.short_code, '')) like ${pattern}` : sql`false`})
      union all
      select 'location', l.id, l.code, l.name, null, null, true,
             ${rank(sql`l.code`, sql`l.name`, query)}, 3
        from locations l where l.org_id = ${orgId} and l.is_active
         ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed, { orgWideNull: true })}
         and ${match(sql`l.code`, sql`l.name`)}
    ) found order by score, family, label limit ${limit}
  `)).rows;
  return rows.map(({ score: _score, ...target }) => target);
}

export interface ProjectTaskOption {
  readonly id: string;
  readonly code: string | null;
  readonly name: string;
}

export function listProjectTaskOptions(actor: ScheduleActor & { boardId: string; projectId: string }): Promise<ProjectTaskOption[]> {
  return withOrgTransaction(actor.orgId, () => readProjectTaskOptions(actor));
}

async function readProjectTaskOptions(actor: ScheduleActor & { boardId: string; projectId: string }): Promise<ProjectTaskOption[]> {
  const board = await getBoard(actor, actor.boardId);
  const allowed = await peopleBoardAuthority(actor, "hrm.shifts.read", board.subsidiaryId);
  if (!isUuid(actor.projectId)) throw new ScheduleError("Choose a project first.", { code: "schedule_invalid_target" });
  const project = (await db.execute<{ id: string }>(sql`select id from projects where org_id = ${actor.orgId} and id = ${actor.projectId}
    ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed, { orgWideNull: true })}`)).rows[0];
  if (!project) return [];
  return (await db.execute<ProjectTaskOption>(sql`select id, code, name from project_tasks
    where org_id = ${actor.orgId} and project_id = ${actor.projectId} and status = 'open'
    order by schedule_order, code nulls last, name`)).rows;
}

/**
 * Validate a target for a write: it exists in this organization, is active,
 * sits inside the caller's subsidiary scope, and a task belongs to its
 * project. A missing or foreign target refuses rather than booking nowhere.
 */
export async function resolveTarget(
  executor: SqlExecutor,
  orgId: string,
  allowed: ReadonlySet<string> | null,
  target: TargetRef | null,
  projectTaskId: string | null,
): Promise<ResolvedTarget | null> {
  if (target === null) {
    if (projectTaskId) throw new ScheduleError("A task needs its project.", { code: "schedule_invalid_target", remedy: "Pick the project, then the task." });
    return null;
  }
  if (!KINDS.has(target.kind) || !isUuid(target.id)) {
    throw new ScheduleError("The booking target is not recognized.", { code: "schedule_invalid_target", remedy: "Pick a customer, project, location or schedule code from the list." });
  }
  const unavailable = () => new ScheduleError("The booking target is not available.", {
    code: "schedule_invalid_target",
    remedy: "It may be inactive or outside your access; pick another target.",
  });
  const empty = { customerPartyId: null, projectId: null, projectTaskId: null, locationId: null, scheduleCodeId: null };
  if (target.kind === "code") {
    if (projectTaskId) throw new ScheduleError("Only project bookings name a task.", { code: "schedule_invalid_target" });
    const row = (await executor.execute<{ label: string }>(sql`select label from schedule_codes
      where org_id = ${orgId} and id = ${target.id} and is_active for share`)).rows[0];
    if (!row) throw unavailable();
    return { ...empty, kind: "code", scheduleCodeId: target.id, label: row.label };
  }
  if (target.kind === "customer") {
    if (projectTaskId) throw new ScheduleError("Only project bookings name a task.", { code: "schedule_invalid_target" });
    const row = (await executor.execute<{ label: string }>(sql`select p.display_name as label from parties p
      join customer_roles cr on cr.org_id = p.org_id and cr.party_id = p.id
      where p.org_id = ${orgId} and p.id = ${target.id} and p.is_active
      ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowed, { orgWideNull: true })} for share of p`)).rows[0];
    if (!row) throw unavailable();
    return { ...empty, kind: "customer", customerPartyId: target.id, label: row.label };
  }
  if (target.kind === "location") {
    if (projectTaskId) throw new ScheduleError("Only project bookings name a task.", { code: "schedule_invalid_target" });
    const row = (await executor.execute<{ label: string }>(sql`select name as label from locations
      where org_id = ${orgId} and id = ${target.id} and is_active
      ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed, { orgWideNull: true })} for share`)).rows[0];
    if (!row) throw unavailable();
    return { ...empty, kind: "location", locationId: target.id, label: row.label };
  }
  const project = (await executor.execute<{ label: string }>(sql`select name as label from projects
    where org_id = ${orgId} and id = ${target.id} and is_active and status = 'active'
    ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed, { orgWideNull: true })} for share`)).rows[0];
  if (!project) throw unavailable();
  if (projectTaskId) {
    if (!isUuid(projectTaskId)) throw new ScheduleError("The task is not recognized.", { code: "schedule_invalid_target" });
    const task = (await executor.execute(sql`select id from project_tasks where org_id = ${orgId} and project_id = ${target.id}
      and id = ${projectTaskId} and status = 'open' for share`)).rows[0];
    if (!task) throw new ScheduleError("The task is not open on this project.", { code: "schedule_invalid_target", remedy: "Pick an open task of the selected project." });
  }
  return { ...empty, kind: "project", projectId: target.id, projectTaskId, label: project.label };
}
