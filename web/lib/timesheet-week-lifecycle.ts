import { lockApprovalSubject } from "@openbooks/engine/platform/approval-routing";
import { refuseOthersTime, timeWorkFamily } from "@/lib/time-workspace";
import {
  lockSharedTimeAuthority,
  TimeWorkTargetError,
} from "@openbooks/engine/projects/time-work-target";
import { TimeApprovalRefusal } from "@/lib/time-approval-refusal";
import { apiErrorResponse } from "@/lib/api/error-response";
import { z } from "zod";
import { isoDate, uuidId } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import {
  prepareAdditionalTimeSubmission,
  type AdditionalTimeSelection,
} from "@openbooks/engine/projects/additional-time-submission";
import { isUuid } from "@/lib/list-params";
import { routeSubjectSubmission } from "@openbooks/engine/flows/submission-policy";
import { approveSubmittedTimeEntries } from "@/lib/time-approval";
import { cancelDispatchRuns } from "@openbooks/engine/flows/dispatch-result";
import { TIMESHEET_WEEK_SUBJECT_KIND } from "@openbooks/engine/flows/timesheet-weeks-adapter";
import { canReopenWeek, type EntryProvenance } from "@/lib/time-lifecycle";
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
} from "@/app/api/timesheets/_lib";
import type { Authz } from "@/lib/authz";

function bad(error: string, extra: Record<string, unknown> = {}, status = 422) {
  return NextResponse.json({ error, ...extra }, { status });
}

export const ordinarySubmission = z.strictObject({
  employee: uuidId.describe("Employee party id from search_timesheets."),
  week: isoDate("week must be a valid calendar date").describe(
    "Any date in the Sunday-start week.",
  ),
  // An explicit declaration that the week holds no hours (leave, no work),
  // with the reason the approver sees. Only a week with nothing recorded may
  // be declared; it then follows the same approval path as any submission.
  noHours: z
    .literal(true)
    .optional()
    .describe("Declare that the week has no hours, for example approved leave."),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe("Reason for the no-hours declaration."),
});
export const additionalTimeSubmission = z.strictObject({
  employee: uuidId.describe("Employee party id from search_timesheets."),
  week: isoDate("week must be a valid calendar date").describe(
    "Any date in the Sunday-start week.",
  ),
  selections: z
    .array(
      z
        .strictObject({
          id: uuidId.describe("Pending time entry id."),
          updatedAt: z
            .string()
            .min(1)
            .max(40)
            .describe("Current entry timestamp from get_timesheet_week."),
        })
        .describe("One pending entry to submit."),
    )
    .min(1)
    .max(250)
    .describe("Exact pending entries for an additional-time submission."),
  reason: z.string().trim().min(10).max(500).describe("Reason for submitting additional time."),
});

export const submitTimesheetBodySchema = z
  .strictObject({
    employee: ordinarySubmission.shape.employee,
    week: ordinarySubmission.shape.week,
    noHours: ordinarySubmission.shape.noHours,
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe("Reason for a no-hours declaration or additional-time submission."),
    selections: additionalTimeSubmission.shape.selections
      .optional()
      .describe("Exact pending entries for an additional-time submission."),
  })
  .superRefine((body, ctx) => {
    if (body.selections && body.noHours === true) {
      ctx.addIssue({
        code: "custom",
        path: ["noHours"],
        message: "An additional-time submission cannot declare the week has no hours.",
      });
    }
    if (body.selections && (!body.reason || body.reason.length < 10)) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Reason must be at least 10 characters for additional time.",
      });
    }
  })
  .describe("Native timesheet week submission request.");

interface SubmitBody {
  employee?: string;
  week?: string;
  noHours?: true;
  reason?: string;
  selections?: AdditionalTimeSelection[];
}

export async function handleSubmitTimesheet({
  request: workspaceRequest,
  authz: gate,
  body: routeBody,
}: {
  request: Request;
  authz: Authz;
  body: z.output<typeof submitTimesheetBodySchema>;
}) {
  const { user } = gate;
  const orgId = user.orgId;

  const body = routeBody as SubmitBody;
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
}

export const reopenTimesheetBodySchema = z
  .strictObject({
    employee: uuidId.describe("Employee party id from search_timesheets."),
    week: isoDate("week must be a valid calendar date").describe(
      "Any date in the Sunday-start week.",
    ),
  })
  .describe("Native timesheet week reopen request.");

interface ReopenBody {
  employee?: string;
  week?: string;
}

export async function handleReopenTimesheet({
  request: workspaceRequest,
  authz: gate,
  body: routeBody,
}: {
  request: Request;
  authz: Authz;
  body: z.output<typeof reopenTimesheetBodySchema>;
}) {
  const { user } = gate;
  const orgId = user.orgId;

  const body = routeBody as ReopenBody;
  if (!body.employee || !isUuid(body.employee)) return bad("Invalid employee");
  if (!body.week || !isIsoDate(body.week)) return bad("Invalid week");
  const employee = await pinTimekeeper(orgId, body.employee, gate.allowedSubsidiaryIds);
  if (!employee) return bad("Employee not found");
  const week = weekStart(body.week);
  const days = weekWindow(week);
  const weekFrom = days[0]!;
  const weekTo = days[6]!;

  // Fast path only: the authoritative state check happens under the header
  // lock inside the transaction, where a concurrent reopen's commit is
  // visible and the loser is refused instead of auditing a phantom unwind.
  const before = await loadWeek(orgId, employee, week, gate.allowedSubsidiaryIds);
  if (before.status !== "approved") return bad("Only an approved week can be reopened");

  return withOrgTransaction(orgId, async () => {
    await lockSharedTimeAuthority(db, orgId, user.id, {
      employeeId: employee,
      from: weekFrom,
      through: weekTo,
      requestedScope: gate.allowedSubsidiaryIds,
      permission: "time.reopen",
      workFamily: timeWorkFamily(workspaceRequest),
    });
    // Lock the header FIRST — the same order approval uses (header, then
    // entries) — so a concurrent approval cannot deadlock against this
    // reopen. The locked status is the authoritative state check: the
    // pre-transaction read above is only a fast path, and a replay that
    // passed it before the winner committed observes draft here and is
    // refused instead of writing a second 'reopened' audit over a week that
    // is already draft.
    const header = (
      await db.execute<{ id: string; status: string }>(
        sql`
      select id, status from timesheet_weeks
       where org_id = ${orgId}
         and employee_party_id = ${employee}
         and week_start = ${week}::date
       for update
    `,
        "objects",
      )
    )[0];
    if (!header || header.status !== "approved") {
      return bad("Only an approved week can be reopened");
    }

    const rows = await db.execute<{
      invoiced_by_line_id: string | null;
      payroll_batch_ref: string | null;
      cost_journal_entry_id: string | null;
      production_consumed_operation_id: string | null;
      overhead_journal_entry_id: string | null;
      field_ticket_id: string | null;
      billing_status: "unbilled" | "billed";
    }>(
      sql`
      select invoiced_by_line_id, payroll_batch_ref, cost_journal_entry_id,
             overhead_journal_entry_id, production_consumed_operation_id, field_ticket_id, billing_status
        from time_entries
       where org_id = ${orgId}
         and employee_party_id = ${employee}
         and worked_on >= ${weekFrom} and worked_on <= ${weekTo}
         and status = 'approved'
       for update`,
      "objects",
    );

    const entries: EntryProvenance[] = rows.map((r) => ({
      invoicedByLineId: r.invoiced_by_line_id,
      payrollBatchRef: r.payroll_batch_ref,
      costJournalEntryId: r.cost_journal_entry_id,
      productionConsumedOperationId: r.production_consumed_operation_id,
      overheadJournalEntryId: r.overhead_journal_entry_id,
      fieldTicketId: r.field_ticket_id,
      billingStatus: r.billing_status,
    }));

    const decision = canReopenWeek(entries);
    if (!decision.allowed) {
      return bad("This week can no longer be reopened", {
        reasons: decision.reasons,
        lockedCount: decision.lockedCount,
      });
    }

    // Weeks carrying amendment history correct forward only. Reopening would
    // return an amended original to draft, where the weekly save deletes or
    // replaces it under a new id — orphaning the offset into phantom negative
    // hours with no original to negate. Inspect the link in both directions:
    // offsets pointing back at an original, and originals pointed at by an
    // offset. Either side makes the week append-only.
    const offsets = (
      await db.execute<{ n: number }>(
        sql`
      select count(*)::int as n
        from time_entries entry
       where entry.org_id = ${orgId}
         and entry.employee_party_id = ${employee}
         and entry.worked_on >= ${weekFrom} and worked_on <= ${weekTo}
         and (
           entry.amends_entry_id is not null or entry.corrects_entry_id is not null
           or exists (
             select 1 from time_entries contra
              where contra.org_id = entry.org_id
                and contra.amends_entry_id = entry.id
           )
         )`,
        "objects",
      )
    )[0]!.n;
    if (Number(offsets) > 0) {
      return bad(
        "This week carries amendment offsets — correct it with a new amendment, not a reopen",
        {
          reasons: ["amended"],
          lockedCount: Number(offsets),
        },
      );
    }

    // Clear the approval stamp with the status: a row reading "draft" while it
    // still names an approver would misreport who signed off on what. The
    // header locked at the top of this transaction is the audit before-image:
    // it was verified approved under the lock, so the audit names the state
    // this unwind actually transitions from.
    await setTimesheetWeekStatus(
      orgId,
      employee,
      week,
      "draft",
      user.id,
      null,
      gate.allowedSubsidiaryIds,
    );
    await db.execute(sql`
      update time_entries
         set status = 'draft', approved_by = null, approved_at = null,
             rejection_reason = null, updated_by = ${user.id}, updated_at = now()
       where org_id = ${orgId}
         and employee_party_id = ${employee}
         and worked_on >= ${weekFrom} and worked_on <= ${weekTo}
         and status = 'approved'`);
    // Durable unwind evidence, part of the same atomic unit: unwinding an
    // approval without it would leave hours editable again with no record of
    // who cleared the sign-off. An audit failure rolls the reopen back with it.
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'timesheet_weeks', ${header.id}, 'update', ${JSON.stringify({
        event: "reopened",
        actor: { kind: "user", userId: user.id },
        before: { status: header.status },
        after: { status: "draft" },
        weekStart: week,
      })}::jsonb, ${user.id})
    `);

    return NextResponse.json(await loadWeek(orgId, employee, week, gate.allowedSubsidiaryIds));
  });
}

export const withdrawTimesheetBodySchema = z
  .strictObject({
    employee: uuidId.describe("Employee party id from search_timesheets."),
    week: isoDate("week must be a valid calendar date").describe(
      "Any date in the Sunday-start week.",
    ),
  })
  .describe("Native timesheet week withdrawal request.");

interface WithdrawBody {
  employee?: string;
  week?: string;
}

export async function handleWithdrawTimesheet({
  request: workspaceRequest,
  authz: gate,
  body: routeBody,
}: {
  request: Request;
  authz: Authz;
  body: z.output<typeof withdrawTimesheetBodySchema>;
}) {
  const { user } = gate;
  const orgId = user.orgId;

  const body = routeBody as WithdrawBody;
  if (!body.employee || !isUuid(body.employee)) return bad("Invalid employee");
  if (!body.week || !isIsoDate(body.week)) return bad("Invalid week");
  const ownedEmployee = await pinTimekeeper(orgId, body.employee, gate.allowedSubsidiaryIds);
  if (!ownedEmployee) return bad("Employee not found");
  // Withdrawal is the submitter's own recall: managers send weeks back
  // through reject, exactly as submitters submit only their own weeks.
  const othersRefused = await refuseOthersTime(gate, "time.manage", ownedEmployee);
  if (othersRefused) return othersRefused;
  const week = weekStart(body.week);
  const days = weekWindow(week);

  // Fast path only: the authoritative state check happens under the header
  // lock inside the transaction, where a concurrent approval's commit is
  // visible and the loser is refused instead of auditing a phantom recall.
  const before = await loadWeek(orgId, ownedEmployee, week, gate.allowedSubsidiaryIds);
  if (before.status !== "submitted") return bad(withdrawRefusal(before.status));

  return withOrgTransaction(orgId, async () => {
    await lockSharedTimeAuthority(db, orgId, user.id, {
      employeeId: ownedEmployee,
      from: days[0]!,
      through: days[6]!,
      requestedScope: gate.allowedSubsidiaryIds,
      permission: "time.manage",
      workFamily: timeWorkFamily(workspaceRequest),
    });
    // Lock the header FIRST — the same order approval uses (header, then
    // entries) — so a concurrent approval cannot deadlock against this
    // recall. The locked status is the authoritative state check: the
    // pre-transaction read above is only a fast path, and a replay that
    // passed it before the winner committed observes the decided status
    // here and is refused instead of writing a second 'withdrawn' audit
    // over a week that is no longer submitted.
    const header = (
      await db.execute<{ id: string; status: string }>(
        sql`
      select id, status from timesheet_weeks
       where org_id = ${orgId}
         and employee_party_id = ${ownedEmployee}
         and week_start = ${week}::date
       for update
    `,
        "objects",
      )
    )[0];
    if (!header || header.status !== "submitted") {
      return bad(withdrawRefusal(header?.status));
    }

    await db.execute(sql`
      update time_entries
         set status = 'draft', rejection_reason = null,
             updated_by = ${user.id}, updated_at = now()
       where org_id = ${orgId}
         and employee_party_id = ${ownedEmployee}
         and worked_on >= ${days[0]} and worked_on <= ${days[6]}
         and status = 'submitted'`);
    await setTimesheetWeekStatus(
      orgId,
      ownedEmployee,
      week,
      "draft",
      user.id,
      null,
      gate.allowedSubsidiaryIds,
    );

    // Cancel the week's open approval runs through the native Flow path in
    // this same transaction: a recalled week must not keep gates waiting
    // on approvers, and terminal runs (decided, failed) are never touched.
    const openRuns = (
      await db.execute<{ id: string }>(
        sql`
      select id from flow_runs
       where org_id = ${orgId}
         and subject_kind = ${TIMESHEET_WEEK_SUBJECT_KIND}
         and subject_id = ${header.id}
         and status in ('running', 'waiting')
    `,
        "objects",
      )
    ).map((row) => row.id);
    await cancelDispatchRuns(orgId, openRuns, { actorId: user.id });

    // Durable recall evidence, part of the same atomic unit: withdrawing a
    // submission without it would leave hours editable again with no record
    // of who recalled the week or which approval runs died with it. An
    // audit failure rolls the withdrawal back with it.
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'timesheet_weeks', ${header.id}, 'update', ${JSON.stringify({
        event: "withdrawn",
        actor: { kind: "user", userId: user.id },
        before: { status: header.status },
        after: { status: "draft" },
        weekStart: week,
        cancelledRuns: openRuns,
      })}::jsonb, ${user.id})
    `);

    return NextResponse.json(await loadWeek(orgId, ownedEmployee, week, gate.allowedSubsidiaryIds));
  });
}

function withdrawRefusal(status: string | undefined): string {
  // Decided weeks stay decided: approved weeks reopen through the governed
  // reopen path, and rejected weeks are already back with the employee.
  if (status === "approved" || status === "rejected") {
    return "This week is already decided and cannot be withdrawn";
  }
  return "Only a submitted week can be withdrawn";
}
