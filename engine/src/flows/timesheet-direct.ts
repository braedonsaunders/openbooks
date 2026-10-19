import { sql, type SQL } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import type { GateSubsidiaryScope, WorklistAudience } from "./gates.ts";
import { TIMESHEET_WEEK_SUBJECT_KIND } from "./timesheet-weeks-adapter.ts";

/**
 * Gateless submitted timesheet weeks awaiting a direct approval — the fourth
 * leg of the approvals union. Flow-gated weeks stay on the gate leg and are
 * decided through their gates; this leg lists only weeks with no open
 * approval gate, and the act-time service refuses gate-owned weeks again.
 *
 * One predicate feeds the union rows, the union counts, and the inbox
 * adapter's list/count, so the badge, the tab bubble, and the tab rows
 * cannot disagree. Visibility mirrors the approve route's own gates: Time
 * Tracking is on, the actor holds time.approve (enforced by callers through
 * the union scope, as with the budgets leg), and the week sits inside the
 * actor's subsidiary scope.
 *
 * Separation of duties is part of the predicate, not just the act-time
 * refusal: the actor whose person party owns the week cannot approve it
 * while the org's time-approval policy prevents self-approval (the default
 * when no policy row exists), so their own weeks never inflate the badge.
 * Single-id resolution (the act path's re-check) skips the self exclusion
 * so a barred week reports its precise refusal instead of "not found". The
 * organization audience (the oversight view of every waiting week) skips
 * it too, and each row reports whether the actor may decide it.
 */

/**
 * One gateless submitted week, in database-row shape — the same columns the
 * inbox adapter has always listed, so both readers map one row type.
 */
export type DirectTimesheetWeek = {
  id: string;
  employee_party_id: string;
  person_name: string | null;
  week_start: string;
  submitted_at: string | null;
  created_at: string;
  entries: number;
  hours: string;
  /**
   * The actor may decide this week under the org's time-approval policy:
   * false only when separation of duties bars them as its timekeeper. The
   * caller's own listing excludes those weeks, so there it is always true;
   * the organization listing keeps them and reports the bar per row.
   */
  actor_may_approve: boolean;
};

export interface DirectTimesheetWindow {
  prefix?: number;
  kind?: string;
  query?: string;
  /** Resolve one week by id for the act path (skips the self exclusion). */
  id?: string;
  /**
   * `organization` lists every gateless submitted week in scope, the
   * actor's own included (each row reports actor_may_approve);
   * `caller` (the default) applies the self exclusion.
   */
  audience?: WorklistAudience;
}

function directTimesheetWhere(
  orgId: string,
  actorId: string,
  allowedSubsidiaryIds: GateSubsidiaryScope,
  kind?: string,
  query?: string,
  id?: string,
): SQL {
  const needle = query?.trim().toLowerCase();
  return sql`w.org_id = ${orgId} and w.status = 'submitted'
    and not exists (
      select 1 from flow_gates g
       where g.org_id = w.org_id and g.subject_kind = ${TIMESHEET_WEEK_SUBJECT_KIND}
         and g.subject_id = w.id and g.status in ('pending', 'escalated')
    )
    -- A week belongs to a timekeeper, mirroring the approve route's own
    -- rule: an active person party, or an employee party holding an active
    -- employment. Anything else refuses at act time, so listing it would
    -- put unactionable rows on the badge.
    and p.is_active
    and (p.kind = 'person' or (p.kind = 'employee' and exists (
      select 1 from employee_roles r
       where r.org_id = p.org_id and r.party_id = p.id and r.is_active
    )))
    ${id ? sql`and w.id = ${id}` : sql``}
    ${kind && kind !== TIMESHEET_WEEK_SUBJECT_KIND ? sql`and false` : sql``}
    ${needle ? sql`and position(${needle} in lower(concat_ws(' ', p.display_name, w.week_start::text))) > 0` : sql``}
    ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds ?? null)}`;
}

/**
 * The shared SoD condition: the actor may decide the week unless the org's
 * time-approval policy prevents self-approval and the week is their own.
 */
function directTimesheetActorMayApprove(orgId: string, actorId: string): SQL {
  return sql`(
    not coalesce((
      select prevent_self_approval from time_approval_policies
       where org_id = ${orgId} and is_active
         and effective_from <= current_date
         and (effective_to is null or effective_to >= current_date)
       order by effective_from desc limit 1
    ), true)
    or w.employee_party_id is distinct from (
      select party_id from users where id = ${actorId} and org_id = ${orgId}
    )
  )`;
}

/** The shared SoD exclusion, applied to every caller listing/count read. */
function directTimesheetSelfExclusion(orgId: string, actorId: string, audience?: WorklistAudience): SQL {
  if (audience === "organization") return sql``;
  return sql`and ${directTimesheetActorMayApprove(orgId, actorId)}`;
}

function directTimesheetColumns(orgId: string, actorId: string): SQL {
  return sql`${directTimesheetActorMayApprove(orgId, actorId)} as actor_may_approve,
    w.id::text as id, w.employee_party_id::text as employee_party_id,
    p.display_name as person_name, w.week_start::text as week_start,
    w.submitted_at::text as submitted_at, w.created_at::text as created_at,
    (select count(*)::int from time_entries te
      where te.org_id = w.org_id and te.employee_party_id = w.employee_party_id
        and te.worked_on >= w.week_start and te.worked_on <= w.week_start + 6
        and te.status = 'submitted') as entries,
    coalesce((select sum(te.hours)::text from time_entries te
      where te.org_id = w.org_id and te.employee_party_id = w.employee_party_id
        and te.worked_on >= w.week_start and te.worked_on <= w.week_start + 6
        and te.status = 'submitted'), '0') as hours`;
}

export async function worklistDirectTimesheets(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  allowedSubsidiaryIds: GateSubsidiaryScope,
  window?: DirectTimesheetWindow,
): Promise<DirectTimesheetWeek[]> {
  const rows = (await exec.execute<DirectTimesheetWeek>(sql`
    select ${directTimesheetColumns(orgId, actorId)}
      from timesheet_weeks w
      join parties p on p.org_id = w.org_id and p.id = w.employee_party_id
     where ${directTimesheetWhere(orgId, actorId, allowedSubsidiaryIds, window?.kind, window?.query, window?.id)}
     ${window?.id ? sql`` : directTimesheetSelfExclusion(orgId, actorId, window?.audience)}
     order by w.submitted_at nulls last, w.week_start, w.id
     ${window?.prefix != null ? sql`limit ${window.prefix}` : sql``}
  `)).rows;
  return rows;
}

export async function worklistDirectTimesheetCount(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  allowedSubsidiaryIds: GateSubsidiaryScope,
  kind?: string,
  query?: string,
  audience?: WorklistAudience,
): Promise<number> {
  const rows = (await exec.execute<{ n: string }>(sql`
    select count(*) as n
      from timesheet_weeks w
      join parties p on p.org_id = w.org_id and p.id = w.employee_party_id
     where ${directTimesheetWhere(orgId, actorId, allowedSubsidiaryIds, kind, query)}
     ${directTimesheetSelfExclusion(orgId, actorId, audience)}
  `)).rows;
  return Number(rows[0]?.n ?? 0);
}

/** The union kind key for direct weeks, shared with the gate leg's chip. */
export const DIRECT_TIMESHEET_UNION_KIND = TIMESHEET_WEEK_SUBJECT_KIND;
