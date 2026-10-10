/**
 * timesheet_approval adapter — gateless submitted weeks awaiting the actor's
 * direct approval. Flow-gated weeks stay on the timesheet_week gate leg and
 * are decided through their gates, never here: this leg lists only weeks
 * with no open approval gate, and the act-time approval refuses gate-owned
 * weeks a second time.
 *
 * Visibility mirrors the approve route's own gates: the actor holds
 * time.approve, Time Tracking is on, and the week sits inside the actor's
 * subsidiary scope. Finer rules (project visibility for another person's
 * project time) enforce at act time inside the native approval service —
 * the same service the drawer calls, so listing and acting never disagree.
 * Execution reaches that service through the context's approveTimesheetWeek
 * hook, provided by web callers; the adapter itself owns no write path.
 */

import { sql } from "drizzle-orm";
import { TIMESHEET_WEEK_SUBJECT_KIND } from "../../flows/timesheet-weeks-adapter.ts";
import { subsidiaryVisibleFilter } from "../../organization/subsidiary-scope.ts";
import { actorPermissionOn, orgFeatureOn, toWorklistScope } from "../guard.ts";
import { db, type SqlExecutor } from "../../platform/db.ts";
import type { InboxAdapter } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId, priorityForDueDate } from "../types.ts";

export interface DirectApprovalWeek {
  id: string;
  employee_party_id: string;
  person_name: string | null;
  week_start: string;
  submitted_at: string | null;
  entries: number;
  hours: string;
}

async function mayApprove(ctx: InboxListContext): Promise<boolean> {
  return (await actorPermissionOn(ctx, 'time.approve')) && (await orgFeatureOn(ctx, 'timeTracking'));
}

/**
 * Gateless submitted weeks in scope, newest submissions first. Shared by
 * the inbox leg and the timesheets bulk-approval panel so both surfaces
 * offer exactly the weeks a direct approval may consume.
 */
export async function listDirectApprovalWeeks(
  exec: SqlExecutor,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null | undefined,
  limit: number,
  id?: string,
): Promise<DirectApprovalWeek[]> {
  const { rows } = await exec.execute<DirectApprovalWeek>(sql`
    select w.id::text as id, w.employee_party_id::text as employee_party_id,
           p.display_name as person_name, w.week_start::text as week_start,
           w.submitted_at::text as submitted_at,
           (select count(*)::int from time_entries te
             where te.org_id = w.org_id and te.employee_party_id = w.employee_party_id
               and te.worked_on >= w.week_start and te.worked_on <= w.week_start + 6
               and te.status = 'submitted') as entries,
           coalesce((select sum(te.hours)::text from time_entries te
             where te.org_id = w.org_id and te.employee_party_id = w.employee_party_id
               and te.worked_on >= w.week_start and te.worked_on <= w.week_start + 6
               and te.status = 'submitted'), '0') as hours
      from timesheet_weeks w
      join parties p on p.org_id = w.org_id and p.id = w.employee_party_id
     where w.org_id = ${orgId} and w.status = 'submitted'
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds ?? null)}
       and not exists (
         select 1 from flow_gates g
          where g.org_id = w.org_id and g.subject_kind = ${TIMESHEET_WEEK_SUBJECT_KIND}
            and g.subject_id = w.id and g.status in ('pending', 'escalated'))
       ${id ? sql`and w.id = ${id}` : sql``}
     order by w.submitted_at desc nulls last, w.week_start desc, w.id
     limit ${limit}
  `);
  return rows;
}

function toItem(ctx: InboxListContext, row: DirectApprovalWeek): InboxItem {
  const submittedAt = row.submitted_at ? new Date(row.submitted_at).toISOString() : new Date().toISOString();
  const person = row.person_name ?? 'unknown person';
  return {
    id: inboxItemId('timesheet_approval', row.id),
    kind: 'timesheet_approval',
    title: `Approve timesheet — ${person}, week of ${row.week_start}`,
    subtitle: row.entries === 0
      ? `no-hours declaration submitted ${submittedAt.slice(0, 10)}`
      : `${row.entries} submitted ${row.entries === 1 ? 'line' : 'lines'} · ${row.hours}h — waiting since ${submittedAt.slice(0, 10)}`,
    dueAt: null,
    createdAt: submittedAt,
    priority: priorityForDueDate(null, ctx.asOf, ctx.timeZone),
    subjectHref: `/timesheets?timesheet=${row.employee_party_id}:${row.week_start}`,
    actions: [{ key: 'approve', label: 'Approve', style: 'primary' as const, needsReason: false }],
    source: { kind: 'timesheet_approval', id: row.id },
  };
}

export const timesheetApprovalAdapter: InboxAdapter = {
  kind: 'timesheet_approval',
  async list(ctx: InboxListContext): Promise<InboxItem[]> {
    if (!(await mayApprove(ctx))) return [];
    const exec: SqlExecutor = ctx.exec ?? db;
    const rows = await listDirectApprovalWeeks(exec, ctx.orgId, toWorklistScope(ctx).allowedSubsidiaryIds ?? null, 50);
    return rows.map((row) => toItem(ctx, row));
  },
  async count(ctx: InboxListContext): Promise<number> {
    if (!(await mayApprove(ctx))) return 0;
    const exec: SqlExecutor = ctx.exec ?? db;
    const scope = toWorklistScope(ctx);
    const rows = (await exec.execute<{ n: number }>(sql`
      select count(*)::int as n
        from timesheet_weeks w
        join parties p on p.org_id = w.org_id and p.id = w.employee_party_id
       where w.org_id = ${ctx.orgId} and w.status = 'submitted'
         ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, scope.allowedSubsidiaryIds ?? null)}
         and not exists (
           select 1 from flow_gates g
            where g.org_id = w.org_id and g.subject_kind = ${TIMESHEET_WEEK_SUBJECT_KIND}
              and g.subject_id = w.id and g.status in ('pending', 'escalated'))
    `)).rows[0];
    return rows?.n ?? 0;
  },
  async lookup(ctx: InboxListContext, sourceId: string): Promise<InboxItem | null> {
    if (!(await mayApprove(ctx))) return null;
    const exec: SqlExecutor = ctx.exec ?? db;
    const rows = await listDirectApprovalWeeks(exec, ctx.orgId, toWorklistScope(ctx).allowedSubsidiaryIds ?? null, 1, sourceId);
    const row = rows[0];
    return row ? toItem(ctx, row) : null;
  },
  async act(ctx, sourceId, actionKey): Promise<void> {
    // The session's subsidiary boundary rides into the write authority (see
    // flows_approval): deciding by id refuses out-of-scope work by name.
    if (actionKey !== 'approve') {
      throw new Error(
        `action ${JSON.stringify(actionKey)} is not available here — open the week in Timesheets`,
      );
    }
    const approve = ctx.approveTimesheetWeek;
    if (!approve) {
      throw new Error('direct timesheet approval is not wired for this caller — approve the week in Timesheets');
    }
    // Re-resolve through the source's own gate: a week that resolved, was
    // decided elsewhere, or left the actor's scope is NOT_FOUND, never a leak.
    if (!(await mayApprove(ctx))) {
      throw new Error('inbox item not found — it may already be decided or outside your scope');
    }
    const exec: SqlExecutor = ctx.exec ?? db;
    const rows = await listDirectApprovalWeeks(exec, ctx.orgId, toWorklistScope(ctx).allowedSubsidiaryIds ?? null, 1, sourceId);
    const row = rows[0];
    if (!row) {
      throw new Error('inbox item not found — it may already be decided or outside your scope');
    }
    await approve({ employeePartyId: row.employee_party_id, weekStart: row.week_start });
  },
};
