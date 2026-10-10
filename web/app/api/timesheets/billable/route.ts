import { authorizeTimeWorkspace, timeWorkFamily } from "@/lib/time-workspace";
import { lockSharedTimeAuthority, TimeWorkTargetError } from "@openbooks/engine/src/projects/time-work-target.ts";
import { TimeApprovalRefusal } from "@/lib/time-approval-refusal";
import { apiErrorResponse } from "@/lib/api/error-response";
import { z } from "zod";
import { isoDate, uuidId } from "@/lib/api/json";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { isUuid } from "../../../../lib/list-params";
import {
  customKey,
  isIsoDate,
  loadWeek,
  pinTimekeeper,
  weekStart,
  weekWindow,
} from "../_lib";

const lineSchema = z.strictObject({
  projectId: uuidId.nullable(),
  itemId: uuidId.nullable(),
  timeTypeId: uuidId.nullable(),
  departmentId: uuidId.nullable(),
  memo: z.string().max(500).nullable(),
  custom: z.record(z.string(), z.unknown()).nullish(),
});
const postBodySchema0 = z.strictObject({
  employee: uuidId,
  week: isoDate("week must be a valid calendar date"),
  line: lineSchema,
  isBillable: z.boolean(),
});

export const runtime = "nodejs";

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 });
}

interface Body {
  employee?: string;
  week?: string;
  line?: {
    projectId?: string | null;
    itemId?: string | null;
    timeTypeId?: string | null;
    departmentId?: string | null;
    memo?: string | null;
    custom?: Record<string, unknown> | null;
  };
  isBillable?: boolean;
}

/**
 * POST { employee, week, line, isBillable } → let an approver mark a submitted
 * review-grid line billable or non-billable (a write-off) before approval.
 *
 * The edit rides the native time-entry update path: only entries still
 * `submitted` flip, every flip is audited per entry (who changed the flag,
 * before/after), and the approval that follows snapshots bill rates off the
 * final flag — non-billable lines are approved for cost but skipped by the
 * bill-rate snapshot, exactly as if they had been entered that way.
 *
 * Approved or invoiced lines refuse by name: approved-but-unbilled lines
 * change through reopen or amendment, and billed lines change on the invoice
 * (credit memo), never by rewriting posted time.
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
    if (!body.line || typeof body.isBillable !== "boolean")
      return bad("A review line and its billable flag are required");
    const ownedEmployee = await pinTimekeeper(
      orgId,
      body.employee,
      gate.allowedSubsidiaryIds,
    );
    if (!ownedEmployee) return bad("Employee not found");
    const week = weekStart(body.week);
    const days = weekWindow(week);
    const line = body.line;
    const wantCustom = customKey(line.custom ?? null);

    try {
      return await withOrgTransaction(orgId, async () => {
        await lockSharedTimeAuthority(db, orgId, user.id, { employeeId: ownedEmployee, from: days[0]!, through: days[6]!, requestedScope: gate.allowedSubsidiaryIds, permission: "time.approve", workFamily: timeWorkFamily(workspaceRequest) });
        // Candidate lines: project time only (production lines never bill),
        // amendment offsets excluded — an approver never retargets a
        // correction entry, and custom values are matched in code below
        // (jsonb key order cannot be compared canonically in SQL).
        const candidates = (await db.execute<{
          id: string;
          status: string;
          is_billable: boolean;
          custom: Record<string, unknown> | null;
          billing_status: string | null;
          invoiced_by_line_id: string | null;
        }>(sql`
          select id, status, is_billable, custom, billing_status, invoiced_by_line_id
            from time_entries
           where org_id = ${orgId}
             and employee_party_id = ${ownedEmployee}
             and worked_on >= ${days[0]} and worked_on <= ${days[6]}
             and work_order_id is null
             and amends_entry_id is null
             and corrects_entry_id is null
             and project_id is not distinct from ${line.projectId ?? null}
             and item_id is not distinct from ${line.itemId ?? null}
             and time_type_id is not distinct from ${line.timeTypeId ?? null}
             and department_id is not distinct from ${line.departmentId ?? null}
             and memo is not distinct from ${line.memo ?? null}
           for update
        `)).rows.filter((row) => customKey(row.custom) === wantCustom);

        const billed = candidates.filter(
          (row) => row.billing_status === "billed" || row.invoiced_by_line_id !== null,
        );
        if (billed.length > 0) {
          throw new TimeApprovalRefusal(
            "this line is already billed — correct the invoice with a credit memo instead of changing the timesheet",
            "line_billed", 409,
            "Correct billed time on the invoice (credit memo and rebill); the timesheet line is locked.",
          );
        }
        const submitted = candidates.filter((row) => row.status === "submitted");
        if (submitted.length === 0) {
          if (candidates.some((row) => row.status === "approved")) {
            throw new TimeApprovalRefusal(
              "this line is already approved — reopen or amend the week to change it",
              "line_approved", 409,
              "Reopen or amend the week to change approved hours.",
            );
          }
          throw new TimeApprovalRefusal(
            "this line has no submitted entries — submit the week before changing it",
            "nothing_submitted", 422,
            "Submit the week before changing its billable flags.",
          );
        }
        const targets = submitted.filter((row) => row.is_billable !== body.isBillable);
        if (targets.length === 0) {
          return NextResponse.json(
            await loadWeek(orgId, ownedEmployee, week, gate.allowedSubsidiaryIds),
          );
        }
        // The conditional UPDATE is the claim: the row count must equal the
        // locked targets, or a concurrent decision moved an entry and the
        // whole unit rolls back instead of half-flipping the line.
        const moved = await db.execute(sql`
          update time_entries
             set is_billable = ${body.isBillable},
                 updated_by = ${user.id}, updated_at = now()
           where org_id = ${orgId}
             and id = any(${`{${targets.map((row) => row.id).join(",")}}`}::uuid[])
             and status = 'submitted'
        `);
        if ((moved.rowCount ?? 0) !== targets.length) {
          throw new TimeApprovalRefusal(
            "One or more time entries are unavailable. Reload before changing billable flags.",
            "entries_unavailable", 409,
            "Reload the week and try again — an entry changed while the line was prepared.",
          );
        }
        // Durable per-entry evidence, part of the same atomic unit: who
        // changed the billable flag with its before/after, so a write-off at
        // approval traces to its approver. An audit failure rolls the flips
        // back with it.
        for (const row of targets) {
          await db.execute(sql`
            insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'time_entries', ${row.id}, 'update', ${JSON.stringify({
              event: "billable_changed",
              actor: { kind: "user", userId: user.id },
              before: { is_billable: row.is_billable },
              after: { is_billable: body.isBillable },
              weekStart: week,
            })}::jsonb, ${user.id})
          `);
        }
        return NextResponse.json(
          await loadWeek(orgId, ownedEmployee, week, gate.allowedSubsidiaryIds),
        );
      });
    } catch (error) {
      if (error instanceof TimeApprovalRefusal || error instanceof TimeWorkTargetError)
        return apiErrorResponse(error);
      throw error;
    }
  },
});
