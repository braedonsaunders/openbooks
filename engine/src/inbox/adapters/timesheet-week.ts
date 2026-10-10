/**
 * HR-15 timesheet_week adapter — weeks waiting on the actor.
 *
 * Approver leg: flow gates on timesheet_week subjects (owned here so
 * flows_approval excludes them), acting through decideGate /
 * delegateGate — the same release path the timesheets surface uses.
 *
 * Own leg: my draft or rejected weeks, link-only. Submission flips entry
 * rows through the timesheets submit route's guards
 * (assertWeekSubmittable), which the inbox does not duplicate — the
 * subtitle names the remedy. Gateless submitted weeks awaiting my direct
 * approval are likewise a link: the direct approve path stamps entry rows
 * in web/lib/time-approval.ts, and a second write path here is refused by
 * the brief.
 */

import { sql } from "drizzle-orm";
import { TIMESHEET_WEEK_SUBJECT_KIND } from "../../flows/timesheet-weeks-adapter.ts";
import { decideGate, delegateGate } from "../../flows/gates.ts";
import { db } from "../../platform/db.ts";
import { parseDelegationReason } from "../delegation.ts";
import { actorPartyId, actorPendingGates, toWorklistScope } from "../guard.ts";
import type { InboxAdapter } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId, priorityForDueDate } from "../types.ts";

type OwnWeekRow = {
  id: string;
  week_start: string;
  status: string;
};

/**
 * True when a week owes no timesheet: nothing is recorded in it, and every
 * day is either covered by the person's approved leave or is not a working
 * day. Working days come from the business calendar governing the
 * employee's legal entity; where no calendar is configured this reminder
 * treats Monday to Friday as working days. The answer only decides whether
 * to nudge — it never records, approves or costs any time.
 */
async function weekNeedsNoTimesheet(ctx: InboxListContext, partyId: string, weekStartIso: string): Promise<boolean> {
  const exec = ctx.exec ?? db;
  const facts = (await exec.execute<{ entries: number; subsidiary_id: string | null; leave_days: string[] | null }>(sql`
    select
      (select count(*)::int from time_entries te
        where te.org_id = ${ctx.orgId} and te.employee_party_id = ${partyId}
          and te.worked_on >= ${weekStartIso}::date and te.worked_on <= ${weekStartIso}::date + 6) as entries,
      coalesce(
        (select min(e.employer_subsidiary_id::text) from worker_employments e
          where e.org_id = ${ctx.orgId} and e.worker_party_id = ${partyId}
         having count(distinct e.employer_subsidiary_id) = 1),
        (select p.subsidiary_id::text from parties p where p.org_id = ${ctx.orgId} and p.id = ${partyId})
      ) as subsidiary_id,
      (select array_agg(distinct day::date::text)
         from generate_series(${weekStartIso}::date, ${weekStartIso}::date + 6, interval '1 day') day
        where exists (
          select 1 from hrm_leave_requests r
            join worker_employments e on e.id = r.employment_id and e.org_id = r.org_id
           where r.org_id = ${ctx.orgId} and e.worker_party_id = ${partyId}
             and r.status = 'approved' and day::date between r.starts_on and r.ends_on)) as leave_days
  `)).rows[0];
  if (!facts || facts.entries > 0) return false;
  const leave = new Set(facts.leave_days ?? []);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(`${weekStartIso}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
  let isWorkingDay: (date: string) => boolean;
  try {
    const { businessCalendarOver } = await import("../../payroll/business-calendars.ts");
    const calendar = await businessCalendarOver(ctx.orgId, facts.subsidiary_id, days[0]!, days[6]!);
    isWorkingDay = (date) => calendar.day(date).isBusinessDay;
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    if (name !== "BusinessCalendarMissingError" && name !== "SubsidiaryCalendarMismatchError") throw error;
    isWorkingDay = (date) => {
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      return weekday >= 1 && weekday <= 5;
    };
  }
  return days.every((date) => leave.has(date) || !isWorkingDay(date));
}

export const timesheetWeekAdapter: InboxAdapter = {
  kind: "timesheet_week",
  async list(ctx: InboxListContext): Promise<InboxItem[]> {
    const out: InboxItem[] = [];
    for (const gate of await actorPendingGates(ctx)) {
      if (gate.subjectKind !== TIMESHEET_WEEK_SUBJECT_KIND) continue;
      const dueAt = gate.escalateAt ? new Date(gate.escalateAt).toISOString() : null;
      out.push({
        id: inboxItemId("timesheet_week", `gate:${gate.id}`),
        kind: "timesheet_week",
        title: gate.title,
        subtitle: `timesheet approval${gate.onBehalfOf ? ` on behalf of ${gate.onBehalfOf.name}` : ""} — waiting since ${new Date(gate.createdAt).toISOString().slice(0, 10)}`,
        dueAt,
        createdAt: new Date(gate.createdAt).toISOString(),
        priority: priorityForDueDate(dueAt, ctx.asOf, ctx.timeZone),
        subjectHref: gate.href ?? "/timesheets",
        actions: [
          { key: "approve", label: "Approve", style: "primary", needsReason: false },
          { key: "reject", label: "Reject", style: "danger", needsReason: true },
          { key: "delegate", label: "Delegate", style: "secondary", needsReason: true },
        ],
        source: { kind: "timesheet_week_gate", id: gate.id },
      });
    }
    const partyId = await actorPartyId(ctx);
    if (partyId) {
      // Timesheet weeks run Sunday through Saturday. A week is owed once it
      // has fully ended on the organization's business calendar: its
      // following Sunday is on or before today. The submission is due that
      // Sunday, so it reads as due on that day and overdue only after it —
      // never on the week's own last day, and never by the database
      // server's clock or its Monday-based week.
      const today = ctx.asOf.slice(0, 10);
      const weeks = (await db.execute<OwnWeekRow>(sql`
        select id::text as id, week_start::text as week_start, status
          from timesheet_weeks
         where org_id = ${ctx.orgId}
           and employee_party_id = ${partyId}
           and status in ('draft', 'rejected')
           and week_start + 7 <= ${today}::date
         order by week_start desc
         limit 10
      `)).rows;
      for (const week of weeks) {
        // A week with nothing recorded in which every working day was
        // approved leave or a non-working calendar day owes no timesheet.
        if (await weekNeedsNoTimesheet(ctx, partyId, week.week_start)) continue;
        const dueAt = new Date(`${week.week_start}T00:00:00Z`);
        dueAt.setUTCDate(dueAt.getUTCDate() + 7);
        const dueDay = dueAt.toISOString().slice(0, 10);
        out.push({
          id: inboxItemId("timesheet_week", `own:${week.id}`),
          kind: "timesheet_week",
          title: `Timesheet unsubmitted — week of ${week.week_start}`,
          subtitle:
            week.status === "rejected"
              ? "rejected — fix the flagged entries and submit the week in Timesheets"
              : "the week ended with no submission — submit it in Timesheets, or declare it a no-hours week with a reason if you did not work",
          dueAt: dueDay,
          createdAt: dueAt.toISOString(),
          priority: priorityForDueDate(dueDay, ctx.asOf, ctx.timeZone),
          // Open the week itself: the timesheets page opens a week's
          // drawer from `timesheet=<employee>:<week start>`, the same id
          // its list rows emit, so the link lands on this exact timesheet.
          subjectHref: `/timesheets?timesheet=${partyId}:${week.week_start}`,
          actions: [],
          source: { kind: "timesheet_week", id: week.id },
        });
      }
    }
    return out;
  },
  async act(ctx, sourceId, actionKey, reason): Promise<void> {
    // The session's subsidiary boundary rides into the write authority (see
    // flows_approval): deciding by id refuses out-of-scope work by name.
    const allowedSubsidiaryIds = toWorklistScope(ctx).allowedSubsidiaryIds;
    if (sourceId.startsWith("gate:")) {
      const gateId = sourceId.slice("gate:".length);
      if (actionKey === "approve") {
        await decideGate({ gateId, decision: "approved", userId: ctx.actorId, comment: reason, allowedSubsidiaryIds });
        return;
      }
      if (actionKey === "reject") {
        await decideGate({ gateId, decision: "rejected", userId: ctx.actorId, comment: reason, allowedSubsidiaryIds });
        return;
      }
      if (actionKey === "delegate") {
        const delegation = parseDelegationReason(reason);
        await delegateGate(gateId, ctx.actorId, delegation.toUserId, allowedSubsidiaryIds, delegation.note);
        return;
      }
    }
    throw new Error(
      `action ${JSON.stringify(actionKey)} is not available here — submit the week in Timesheets`,
    );
  },
};
