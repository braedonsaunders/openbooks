import { authorizeTimeWorkspace, timeWorkFamily } from "@/lib/time-workspace";
import { lockSharedTimeAuthority } from "@openbooks/engine/src/projects/time-work-target.ts";
import { z } from "zod";
import { isoDate, uuidId } from "@/lib/api/json";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { isUuid } from "../../../../lib/list-params";
import {
  isIsoDate,
  loadWeek,
  pinTimesheetEmployee,
  setTimesheetWeekStatus,
  weekStart,
  weekWindow,
} from "../_lib";
const postBodySchema0 = z.strictObject({
  employee: uuidId,
  week: isoDate("week must be a valid calendar date"),
  // An omitted reason reaches the named refusal below; a supplied reason
  // must still have the exact wire shape the reader returned.
  reason: z.string().trim().min(3, "A rejection reason is required").max(500, "Rejection reason is too long").optional(),
});

export const runtime = "nodejs";

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 });
}

interface Body {
  employee?: string;
  week?: string;
  reason?: string;
}

/**
 * POST { employee, week, reason } → bounce a submitted week back to the person
 * who entered it.
 *
 * The reason is required and stored on the rows. A rejection that only flips a
 * status leaves the employee guessing at what to fix, and leaves no record of
 * why an approver declined — the documented decision is the point.
 */
export const POST = defineRoute({
  authorize: authorizeTimeWorkspace("time.approve"),
  feature: { none: "The explicit workspace pins Time Tracking or Manufacturing; native commands fence every actual target." },
  body: postBodySchema0,
  handler: async ({ request: workspaceRequest, authz: gate, body: routeBody }) => {
    const { user } = gate;
    const orgId = user.orgId;

    const body = routeBody as Body;
    if (!body.employee || !isUuid(body.employee))
      return bad("Invalid employee");
    if (!body.week || !isIsoDate(body.week)) return bad("Invalid week");
    const ownedEmployee = await pinTimesheetEmployee(
      orgId,
      body.employee,
      gate.allowedSubsidiaryIds,
    );
    if (!ownedEmployee) return bad("Employee not found");
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 3) return bad("A rejection reason is required");
    if (reason.length > 500) return bad("Rejection reason is too long");

    const week = weekStart(body.week);
    const days = weekWindow(week);

    // Fast path only: the authoritative state check happens under the header
    // lock inside the transaction, where a concurrent rejection's commit is
    // visible and the replay loser is refused with the original reason intact.
    // A replayed rejection names the recorded decision either way — never the
    // replayed reason.
    const before = await loadWeek(
      orgId,
      ownedEmployee,
      week,
      gate.allowedSubsidiaryIds,
    );
    if (before.status !== "submitted") {
      if (before.status === "rejected" && before.rejectionReason) {
        return bad(
          `Week already rejected: ${before.rejectionReason} — submit the week again to re-decide it`,
        );
      }
      return bad("Only a submitted week can be rejected");
    }

    try {
      return await withOrgTransaction(orgId, async () => {
        await lockSharedTimeAuthority(db, orgId, user.id, { employeeId: ownedEmployee, from: days[0]!, through: days[6]!, requestedScope: gate.allowedSubsidiaryIds, permission: "time.approve", workFamily: timeWorkFamily(workspaceRequest) });
        // The locked header is the claim, not the pre-transaction read: a
        // replay that passed the fast path before the winner committed
        // observes rejected here and is refused before it can overwrite the
        // recorded reason with zero submitted rows changed.
        const header = (
          await db.execute<{
            id: string;
            status: string;
            rejection_reason: string | null;
          }>(sql`
        select id, status, rejection_reason from timesheet_weeks
         where org_id = ${orgId}
           and employee_party_id = ${ownedEmployee}
           and week_start = ${week}::date
         for update
      `)
        ).rows[0];
        if (!header || header.status !== "submitted") {
          if (header?.status === "rejected") {
            return bad(
              `Week already rejected${header.rejection_reason ? `: ${header.rejection_reason}` : ""} — submit the week again to re-decide it`,
            );
          }
          return bad("Only a submitted week can be rejected");
        }
        await setTimesheetWeekStatus(
          orgId,
          ownedEmployee,
          week,
          "rejected",
          user.id,
          reason,
          gate.allowedSubsidiaryIds,
        );
        // Conditional update: the flipped-row count is the proof anything was
        // submitted. Zero means the header said submitted but no entry was —
        // throwing rolls the header stamp back instead of recording a reason
        // over an empty rejection.
        const moved = await db.execute(sql`
        update time_entries
           set status = 'rejected', rejection_reason = ${reason},
               approved_by = null, approved_at = null,
               updated_by = ${user.id}, updated_at = now()
         where org_id = ${orgId}
           and employee_party_id = ${ownedEmployee}
           and worked_on >= ${days[0]} and worked_on <= ${days[6]}
           and status = 'submitted'`);
        // A week declared as having no hours carries no entries at all;
        // rejecting it returns the declaration to the employee.
        const declaredNoHours = (moved.rowCount ?? 0) === 0 && ((await db.execute<{ n: number }>(sql`
          select count(*)::int as n from time_entries
           where org_id = ${orgId} and employee_party_id = ${ownedEmployee}
             and worked_on >= ${days[0]} and worked_on <= ${days[6]}`)).rows[0]?.n ?? 0) === 0;
        if ((moved.rowCount ?? 0) === 0 && !declaredNoHours) {
          throw new Error(
            "Nothing to reject — the week has no submitted entries",
          );
        }
        // Durable decision evidence, part of the same atomic unit: the
        // documented reason is the point of a rejection, so it rides with the
        // before/after status. An audit failure rolls the rejection back
        // with it.
        await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'timesheet_weeks', ${header.id}, 'update', ${JSON.stringify(
          {
            event: "rejected",
            actor: { kind: "user", userId: user.id },
            before: { status: header.status },
            after: { status: "rejected" },
            reason,
            weekStart: week,
          },
        )}::jsonb, ${user.id})
      `);

        return NextResponse.json(
          await loadWeek(orgId, ownedEmployee, week, gate.allowedSubsidiaryIds),
        );
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/nothing to reject/i.test(message)) {
        return NextResponse.json({ error: message }, { status: 422 });
      }
      throw error;
    }
  },
});
