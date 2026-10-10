import { authorizeTimeWorkspace, refuseOthersTime, timeWorkFamily } from "@/lib/time-workspace";
import { lockSharedTimeAuthority } from "@openbooks/engine/src/projects/time-work-target.ts";
import { z } from "zod";
import { isoDate, uuidId } from "@/lib/api/json";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { isUuid } from "../../../../lib/list-params";
import { cancelDispatchRuns } from "@openbooks/engine/src/flows/dispatch-result.ts";
import { TIMESHEET_WEEK_SUBJECT_KIND } from "@openbooks/engine/src/flows/timesheet-weeks-adapter.ts";
import {
  isIsoDate,
  loadWeek,
  pinTimekeeper,
  setTimesheetWeekStatus,
  weekStart,
  weekWindow,
} from "../_lib";
const postBodySchema0 = z.strictObject({
  employee: uuidId,
  week: isoDate("week must be a valid calendar date"),
});

export const runtime = "nodejs";

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 });
}

interface Body {
  employee?: string;
  week?: string;
}

/**
 * POST { employee, week } → withdraw a submitted week back to draft.
 *
 * The employee's own recall: like submit, a self-service caller withdraws
 * only their own week — sending a week back is the approver's reject, not a
 * manager's unwind. Only a submitted week can be withdrawn: approved and
 * rejected weeks are already decided, and draft or empty weeks have nothing
 * to recall. Open approval runs for the week are cancelled through the
 * native Flow path in the same transaction, and the withdrawal is audited
 * with the cancelled runs as evidence.
 */
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
    // Withdrawal is the submitter's own recall: managers send weeks back
    // through reject, exactly as submitters submit only their own weeks.
    const othersRefused = await refuseOthersTime(gate, "time.manage", ownedEmployee);
    if (othersRefused) return othersRefused;
    const week = weekStart(body.week);
    const days = weekWindow(week);

    // Fast path only: the authoritative state check happens under the header
    // lock inside the transaction, where a concurrent approval's commit is
    // visible and the loser is refused instead of auditing a phantom recall.
    const before = await loadWeek(
      orgId,
      ownedEmployee,
      week,
      gate.allowedSubsidiaryIds,
    );
    if (before.status !== "submitted")
      return bad(withdrawRefusal(before.status));

    return withOrgTransaction(orgId, async () => {
      await lockSharedTimeAuthority(db, orgId, user.id, { employeeId: ownedEmployee, from: days[0]!, through: days[6]!, requestedScope: gate.allowedSubsidiaryIds, permission: "time.manage", workFamily: timeWorkFamily(workspaceRequest) });
      // Lock the header FIRST — the same order approval uses (header, then
      // entries) — so a concurrent approval cannot deadlock against this
      // recall. The locked status is the authoritative state check: the
      // pre-transaction read above is only a fast path, and a replay that
      // passed it before the winner committed observes the decided status
      // here and is refused instead of writing a second 'withdrawn' audit
      // over a week that is no longer submitted.
      const header = (
        await db.execute<{ id: string; status: string }>(sql`
      select id, status from timesheet_weeks
       where org_id = ${orgId}
         and employee_party_id = ${ownedEmployee}
         and week_start = ${week}::date
       for update
    `)
      ).rows[0];
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
      const openRuns = (await db.execute<{ id: string }>(sql`
      select id from flow_runs
       where org_id = ${orgId}
         and subject_kind = ${TIMESHEET_WEEK_SUBJECT_KIND}
         and subject_id = ${header.id}
         and status in ('running', 'waiting')
    `)).rows.map((row) => row.id);
      await cancelDispatchRuns(orgId, openRuns, { actorId: user.id });

      // Durable recall evidence, part of the same atomic unit: withdrawing a
      // submission without it would leave hours editable again with no record
      // of who recalled the week or which approval runs died with it. An
      // audit failure rolls the withdrawal back with it.
      await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'timesheet_weeks', ${header.id}, 'update', ${JSON.stringify(
        {
          event: "withdrawn",
          actor: { kind: "user", userId: user.id },
          before: { status: header.status },
          after: { status: "draft" },
          weekStart: week,
          cancelledRuns: openRuns,
        },
      )}::jsonb, ${user.id})
    `);

      return NextResponse.json(
        await loadWeek(orgId, ownedEmployee, week, gate.allowedSubsidiaryIds),
      );
    });
  },
});

function withdrawRefusal(status: string | undefined): string {
  // Decided weeks stay decided: approved weeks reopen through the governed
  // reopen path, and rejected weeks are already back with the employee.
  if (status === "approved" || status === "rejected") {
    return "This week is already decided and cannot be withdrawn";
  }
  return "Only a submitted week can be withdrawn";
}
