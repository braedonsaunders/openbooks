import { lockApprovalSubject } from "@openbooks/engine/platform/approval-routing";
import { authorizeTimeWorkspace, refuseOthersTime, timeWorkFamily } from "@/lib/time-workspace";
import {
  lockSharedTimeAuthority,
  TimeWorkTargetError,
} from "@openbooks/engine/projects/time-work-target";
import { TimeApprovalRefusal } from "@/lib/time-approval-refusal";
import { apiErrorResponse } from "@/lib/api/error-response";
import { z } from "zod";
import { isoDate, uuidId } from "@/lib/api/json";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import {
  prepareAdditionalTimeSubmission,
  type AdditionalTimeSelection,
} from "@openbooks/engine/projects/additional-time-submission";
import { isUuid } from "../../../../lib/list-params";
import { routeSubjectSubmission } from "@openbooks/engine/flows/submission-policy";
import { approveSubmittedTimeEntries } from "@/lib/time-approval";
import { TIMESHEET_WEEK_SUBJECT_KIND } from "@openbooks/engine/flows/timesheet-weeks-adapter";
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
const ordinarySubmission = z.strictObject({
  employee: uuidId,
  week: isoDate("week must be a valid calendar date"),
  // An explicit declaration that the week holds no hours (leave, no work),
  // with the reason the approver sees. Only a week with nothing recorded may
  // be declared; it then follows the same approval path as any submission.
  noHours: z.literal(true).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});
const postBodySchema0 = z.union([
  ordinarySubmission,
  z.strictObject({
    employee: uuidId,
    week: isoDate("week must be a valid calendar date"),
    selections: z
      .array(z.strictObject({ id: uuidId, updatedAt: z.string().min(1).max(40) }))
      .min(1)
      .max(250),
    reason: z.string().trim().min(10).max(500),
  }),
]);

export const runtime = "nodejs";

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 });
}

interface Body {
  employee?: string;
  week?: string;
  noHours?: true;
  reason?: string;
  selections?: AdditionalTimeSelection[];
}

/** POST { employee, week } → move the week's draft entries to submitted. */
export const POST = defineRoute({
  authorize: authorizeTimeWorkspace("time.manage"),
  feature: {
    none: "The explicit workspace pins Time Tracking or Manufacturing; native commands fence every actual target.",
  },
  body: postBodySchema0,
  handler: async ({ request: workspaceRequest, authz: gate, body: routeBody }) => {
    const { user } = gate;
    const orgId = user.orgId;

    const body = routeBody as Body;
    if (!body.employee || !isUuid(body.employee)) return bad("Invalid employee");
    if (!body.week || !isIsoDate(body.week)) return bad("Invalid week");
    const ownedEmployee = await pinTimekeeper(orgId, body.employee, gate.allowedSubsidiaryIds);
    if (!ownedEmployee) return bad("Employee not found");
    // A self-service caller submits only their own week.
    const othersRefused = await refuseOthersTime(gate, "time.manage", ownedEmployee);
    if (othersRefused) return othersRefused;
    if (body.noHours === true && !body.reason)
      return bad("A reason is required to declare a week with no hours");
    const week = weekStart(body.week);
    const days = weekWindow(week);

    let flow: Awaited<ReturnType<typeof routeSubjectSubmission>>["dispatch"];
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
        const header = await ensureTimesheetWeek(
          orgId,
          ownedEmployee,
          week,
          user.id,
          gate.allowedSubsidiaryIds,
        );
        await lockApprovalSubject(orgId, TIMESHEET_WEEK_SUBJECT_KIND, header.id);
        const additional = body.selections
          ? await prepareAdditionalTimeSubmission(db, {
              orgId,
              actorId: user.id,
              employeePartyId: ownedEmployee,
              weekStart: week,
              selections: body.selections,
              requestedScope: gate.allowedSubsidiaryIds,
              workFamily: timeWorkFamily(workspaceRequest),
            })
          : null;
        if (!additional)
          await lockSharedTimeAuthority(db, orgId, user.id, {
            employeeId: ownedEmployee,
            from: days[0]!,
            through: days[6]!,
            requestedScope: gate.allowedSubsidiaryIds,
            permission: "time.manage",
            workFamily: timeWorkFamily(workspaceRequest),
          });
        const selectionIds = additional?.entries.map((entry) => entry.id);
        const moved = await db.execute<{ id: string }>(sql`
        update time_entries
           set status = 'submitted', rejection_reason = null,
               updated_at = now(), updated_by = ${user.id}
         where org_id = ${orgId}
           and employee_party_id = ${ownedEmployee}
           and worked_on >= ${days[0]} and worked_on <= ${days[6]}
           and status in ('draft', 'rejected')
           ${selectionIds ? sql`and id = any(${`{${selectionIds.join(",")}}`}::uuid[])` : sql``}
         returning id
      `);
        if (selectionIds && moved.rows.length !== selectionIds.length) {
          throw new TimeWorkTargetError(
            "The selected time changed before submission.",
            409,
            "additional_time_selection_changed",
            "Reload the week and review the pending entries again.",
          );
        }

        // Every submission uses tenant Flows; zero gates releases immediately.
        // A resubmission while gates are open would raise a duplicate set of
        // gates beside the live ones, and a submission with no movable entries
        // would raise runs and gates for nothing. Refuse both before the
        // header stamp and the dispatch; throwing rolls the flip back.
        await assertWeekSubmittable(orgId, header.id, moved.rowCount ?? 0, {
          declaredNoHours: body.noHours === true,
        });
        if (body.noHours === true) {
          // A declaration over approved leave names the absence it records:
          // re-derived here (never trusted from the client) so the audit
          // carries the leave the approver must see.
          const leaveRequests = await weekLeaveCover(orgId, ownedEmployee, days[0]!, days[6]!);
          const audited = (
            await db.execute<{ id: string }>(
              sql`
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
          `,
              "objects",
            )
          )[0];
          if (!audited)
            throw new Error("the no-hours declaration was not recorded — nothing was submitted");
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
        if (additional) {
          const audited = (
            await db.execute<{ id: string }>(
              sql`
            insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'timesheet_weeks', ${additional.headerId}, 'update',
              ${JSON.stringify({
                event: "additional_time_submitted",
                reason: body.reason,
                before: {
                  status: additional.headerStatus,
                  approval: additional.priorApproval,
                },
                after: { status: "submitted" },
                entries: additional.entries,
                unchangedEarlierApprovedTime: true,
              })}::jsonb, ${user.id}) returning id
          `,
              "objects",
            )
          )[0];
          if (!audited) throw new Error("Additional-time submission evidence was not recorded.");
        }

        const {
          dispatch: dispatched,
          policy,
          submissionId,
        } = await routeSubjectSubmission({
          orgId,
          actorId: user.id,
          subjectKind: TIMESHEET_WEEK_SUBJECT_KIND,
          subjectId: header.id,
        });
        if (policy.kind === "ungated")
          await approveSubmittedTimeEntries({
            orgId,
            actorId: user.id,
            employeePartyId: ownedEmployee,
            weekStart: week,
            allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
            workFamily: timeWorkFamily(workspaceRequest),
            submissionId,
          });
        return dispatched;
      });
    } catch (error) {
      if (error instanceof TimeApprovalRefusal || error instanceof TimeWorkTargetError)
        return apiErrorResponse(error);
      const message = error instanceof Error ? error.message : String(error);
      if (/nothing to submit/i.test(message)) {
        return NextResponse.json({ error: message }, { status: 422 });
      }
      throw error;
    }

    const payload = await loadWeek(orgId, ownedEmployee, week, gate.allowedSubsidiaryIds);
    return NextResponse.json({
      ...payload,
      gated: flow.gatesCreated > 0,
      runId: flow.runs.find((run) => run.status === "waiting")?.runId ?? null,
    });
  },
});
