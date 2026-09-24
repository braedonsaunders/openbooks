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
import { worklistApprovals } from "../../flows/approval-worklist.ts";
import { actorPartyId } from "../guard.ts";
import { db } from "../../platform/db.ts";
import { parseDelegationReason } from "../delegation.ts";
import { toWorklistScope } from "../guard.ts";
import type { InboxAdapter } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId, priorityForDueDate } from "../types.ts";

type OwnWeekRow = {
  id: string;
  week_start: string;
  status: string;
};

export const timesheetWeekAdapter: InboxAdapter = {
  kind: "timesheet_week",
  async list(ctx: InboxListContext): Promise<InboxItem[]> {
    const out: InboxItem[] = [];
    const approvals = await worklistApprovals(ctx.orgId, ctx.actorId, toWorklistScope(ctx));
    for (const item of approvals) {
      if (item.kind !== "flow_gate" || item.gate.subjectKind !== TIMESHEET_WEEK_SUBJECT_KIND) continue;
      const gate = item.gate;
      const dueAt = gate.escalateAt ? new Date(gate.escalateAt).toISOString() : null;
      out.push({
        id: inboxItemId("timesheet_week", `gate:${gate.id}`),
        kind: "timesheet_week",
        title: gate.title,
        subtitle: `timesheet approval${gate.onBehalfOf ? ` on behalf of ${gate.onBehalfOf.name}` : ""} — waiting since ${new Date(gate.createdAt).toISOString().slice(0, 10)}`,
        dueAt,
        createdAt: new Date(gate.createdAt).toISOString(),
        priority: priorityForDueDate(dueAt, ctx.asOf),
        subjectHref: gate.href ?? "/timesheets",
        actions: [
          { key: "approve", label: "Approve", style: "primary", needsReason: false },
          { key: "reject", label: "Reject", style: "danger", needsReason: true },
          { key: "delegate", label: "Delegate", style: "secondary", needsReason: true },
        ],
        source: { kind: "timesheet_week_gate", id: gate.id },
      });
    }
    const partyId = await actorPartyId(ctx.orgId, ctx.actorId);
    if (partyId) {
      const weeks = (await db.execute<OwnWeekRow>(sql`
        select id::text as id, week_start::text as week_start, status
          from timesheet_weeks
         where org_id = ${ctx.orgId}
           and employee_party_id = ${partyId}
           and status in ('draft', 'rejected')
           and week_start < date_trunc('week', current_date)::date
         order by week_start desc
         limit 10
      `)).rows;
      for (const week of weeks) {
        const dueAt = new Date(`${week.week_start}T00:00:00Z`);
        dueAt.setUTCDate(dueAt.getUTCDate() + 7);
        out.push({
          id: inboxItemId("timesheet_week", `own:${week.id}`),
          kind: "timesheet_week",
          title: `Timesheet unsubmitted — week of ${week.week_start}`,
          subtitle:
            week.status === "rejected"
              ? "rejected — fix the flagged entries and submit the week in Timesheets"
              : "the week ended with no submission — submit it in Timesheets",
          dueAt: dueAt.toISOString(),
          createdAt: dueAt.toISOString(),
          priority: "overdue",
          subjectHref: `/timesheets?week=${week.week_start}`,
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
