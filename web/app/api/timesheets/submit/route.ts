import { authorizeTimeWorkspace, refuseOthersTime, timeWorkFamily } from "@/lib/time-workspace";
import { lockSharedTimeAuthority } from "@openbooks/engine/src/projects/time-work-target.ts";
import { z } from "zod";
import { isoDate, uuidId } from "@/lib/api/json";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { isUuid } from "../../../../lib/list-params";
import { runRecordFlows } from "@openbooks/engine/src/flows/run.ts";
import { TIMESHEET_WEEK_SUBJECT_KIND } from "@openbooks/engine/src/flows/timesheet-weeks-adapter.ts";
import {
  assertWeekSubmittable,
  ensureTimesheetWeek,
  isIsoDate,
  loadWeek,
  pinTimekeeper,
  setTimesheetWeekStatus,
  weekLeaveCover,
  weekStart,
  weekWindow,
} from "../_lib";
const postBodySchema0 = z.strictObject({
  employee: uuidId,
  week: isoDate("week must be a valid calendar date"),
  // An explicit declaration that the week holds no hours (leave, no work),
  // with the reason the approver sees. Only a week with nothing recorded may
  // be declared; it then follows the same approval path as any submission.
  noHours: z.literal(true).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

export const runtime = "nodejs";

class SubmissionFlowError extends Error {
  constructor() {
    super("timesheet submission workflow failed");
    this.name = "SubmissionFlowError";
  }
}

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 });
}

interface Body {
  employee?: string;
  week?: string;
  noHours?: true;
  reason?: string;
}

/** POST { employee, week } → move the week's draft entries to submitted. */
export const POST = defineRoute({
  authorize: authorizeTimeWorkspace("time.manage"),
  feature: { none: "The explicit workspace pins Time Tracking or Manufacturing; native commands fence every actual target." },
  body: postBodySchema0,
  handler: async ({ request: workspaceRequest, authz: gate, body: routeBody }) => {
    const { user } = gate;
    const orgId = user.orgId;

    const body = routeBody as Body;
    if (!body.employee || !isUuid(body.employee))
      return bad("Invalid employee");
    if (!body.week || !isIsoDate(body.week)) return bad("Invalid week");
    const ownedEmployee = await pinTimekeeper(
      orgId,
      body.employee,
      gate.allowedSubsidiaryIds,
    );
    if (!ownedEmployee) return bad("Employee not found");
    // A self-service caller submits only their own week.
    const othersRefused = await refuseOthersTime(gate, "time.manage", ownedEmployee);
    if (othersRefused) return othersRefused;
    if (body.noHours === true && !body.reason) return bad("A reason is required to declare a week with no hours");
    const week = weekStart(body.week);
    const days = weekWindow(week);

    let flow: Awaited<ReturnType<typeof runRecordFlows>>;
    try {
      // 'rejected' resubmits as well as 'draft'. A rejection is a request to fix
      // and send back, so excluding it left a bounced week with no route forward —
      // the employee could edit it but never submit it again. The approver's note
      // is cleared on resubmission so a stale reason cannot outlive the fix.
      //
      // Keep the entry update, week header, and flow dispatch in one transaction.
      // Flow runs and their durable outbox effects participate in the ambient
      // tenant transaction, so a failed dispatch rolls back every submission
      // write instead of compensating with a second, failure-prone update.
      flow = await withOrgTransaction(orgId, async () => {
        await lockSharedTimeAuthority(db, orgId, user.id, { employeeId: ownedEmployee, from: days[0]!, through: days[6]!, requestedScope: gate.allowedSubsidiaryIds, permission: "time.manage", workFamily: timeWorkFamily(workspaceRequest) });
        const moved = await db.execute(sql`
        update time_entries
           set status = 'submitted', rejection_reason = null,
               updated_at = now(), updated_by = ${user.id}
         where org_id = ${orgId}
           and employee_party_id = ${ownedEmployee}
           and worked_on >= ${days[0]} and worked_on <= ${days[6]}
           and status in ('draft', 'rejected')
      `);

        // Hand the submission to Flows, exactly as documents do. A flow that
        // raises approval gates OWNS the week: it stays submitted until the
        // gates resolve, and the engine calls the release handler with the
        // outcome. When no flow matches, the built-in approve endpoint remains
        // the route — flows ADD routing (who, quorum, escalation), they do not
        // become mandatory.
        const header = await ensureTimesheetWeek(
          orgId,
          ownedEmployee,
          week,
          user.id,
          gate.allowedSubsidiaryIds,
        );
        // A resubmission while gates are open would raise a duplicate set of
        // gates beside the live ones, and a submission with no movable entries
        // would raise runs and gates for nothing. Refuse both before the
        // header stamp and the dispatch; throwing rolls the flip back.
        await assertWeekSubmittable(orgId, header.id, moved.rowCount ?? 0, { declaredNoHours: body.noHours === true });
        if (body.noHours === true) {
          // A declaration over approved leave names the absence it records:
          // re-derived here (never trusted from the client) so the audit
          // carries the leave the approver must see.
          const leaveRequests = await weekLeaveCover(orgId, ownedEmployee, days[0]!, days[6]!);
          const audited = (await db.execute<{ id: string }>(sql`
            insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'timesheet_weeks', ${header.id}, 'update', ${JSON.stringify({
              event: "no_hours_declared",
              before: { status: header.status },
              after: { status: "submitted" },
              reason: body.reason,
              leaveRequests: leaveRequests.map((leave) => ({
                requestId: leave.requestId,
                leaveType: leave.leaveType,
                from: leave.from,
                to: leave.to,
              })),
            })}::jsonb, ${user.id})
            returning id
          `)).rows[0];
          if (!audited) throw new Error("the no-hours declaration was not recorded — nothing was submitted");
        }
        await setTimesheetWeekStatus(
          orgId,
          ownedEmployee,
          week,
          "submitted",
          user.id,
          null,
          gate.allowedSubsidiaryIds,
        );

        const dispatched = await runRecordFlows(
          { kind: "on_submit" },
          TIMESHEET_WEEK_SUBJECT_KIND,
          header.id,
          { orgId, userId: user.id },
        );
        // Fail closed: an on_submit flow that errored (e.g. resolved to zero
        // approvers) must not leave the week looking routed when nobody was
        // asked. Throwing reaches withOrgTransaction's rollback boundary.
        if (dispatched.failed) throw new SubmissionFlowError();
        return dispatched;
      });
    } catch (error) {
      if (error instanceof SubmissionFlowError) {
        return NextResponse.json(
          {
            error:
              "The approval workflow for this timesheet could not start. Nothing was submitted.",
          },
          { status: 409 },
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/pending approval workflow/i.test(message)) {
        return NextResponse.json({ error: message }, { status: 409 });
      }
      if (/nothing to submit/i.test(message)) {
        return NextResponse.json({ error: message }, { status: 422 });
      }
      throw error;
    }

    const payload = await loadWeek(
      orgId,
      ownedEmployee,
      week,
      gate.allowedSubsidiaryIds,
    );
    return NextResponse.json({
      ...payload,
      gated: flow.gatesCreated > 0,
      runId: flow.runs.find((run) => run.status === "waiting")?.runId ?? null,
    });
  },
});
