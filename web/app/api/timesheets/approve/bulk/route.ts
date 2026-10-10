import { authorizeTimeWorkspace, timeWorkFamily } from "@/lib/time-workspace";
import { z } from "zod";
import { isoDate, uuidId } from "@/lib/api/json";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { TimeApprovalRefusal } from "@/lib/time-approval-refusal";
import { TimeWorkTargetError } from "@openbooks/engine/src/projects/time-work-target.ts";
import { ScopeNotFoundError } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import { approveSubmittedTimeEntries } from "../../../../lib/time-approval";
import { APPROVALS_BULK_BATCH_MAX } from "@/lib/approvals-limits";

export const runtime = "nodejs";

const body = z.strictObject({
  weeks: z.array(z.strictObject({ employee: uuidId, week: isoDate("week must be a valid calendar date") }))
    .min(1)
    .max(APPROVALS_BULK_BATCH_MAX),
}).strict();

export interface BulkApproveWeekResult {
  employee: string
  week: string
  ok: boolean
  error?: string
  code?: string
  remedy?: string
  details?: Record<string, unknown>
}

/**
 * POST { weeks: [{ employee, week }] } → approve each submitted week through
 * the native approval command, each in its own transaction. One failure
 * never aborts the rest; every refusal answers typed (code, remedy and
 * details beside the message) so the caller reports per-week results
 * explicitly — partial success is a result, never a silent one.
 */
export const POST = defineRoute({
  authorize: authorizeTimeWorkspace("time.approve"),
  feature: { none: "The explicit workspace pins Time Tracking or Manufacturing; native commands fence every actual target." },
  body,
  invalidBodyStatus: 422,
  handler: async ({ request: workspaceRequest, authz, body: requestBody }) => {
    const { user } = authz;
    const orgId = user.orgId;
    const workFamily = timeWorkFamily(workspaceRequest);
    const results: BulkApproveWeekResult[] = [];
    for (const item of requestBody.weeks) {
      const base = { employee: item.employee, week: item.week };
      try {
        await approveSubmittedTimeEntries({
          orgId,
          actorId: user.id,
          employeePartyId: item.employee,
          weekStart: item.week,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          workFamily,
        });
        results.push({ ...base, ok: true });
      } catch (error) {
        if (error instanceof TimeApprovalRefusal) {
          results.push({
            ...base,
            ok: false,
            error: error.message,
            code: error.code,
            remedy: error.remedy,
            ...(error.details ? { details: error.details } : {}),
          });
          continue;
        }
        if (error instanceof TimeWorkTargetError) {
          results.push({ ...base, ok: false, error: error.message, code: error.code, remedy: error.remedy });
          continue;
        }
        if (error instanceof ScopeNotFoundError) {
          results.push({ ...base, ok: false, error: "not_found" });
          continue;
        }
        console.error("[timesheets/approve/bulk] approval transaction rolled back:", error);
        results.push({ ...base, ok: false, error: "Time approval could not complete its configured financial effects. No entries were approved." });
      }
    }
    return NextResponse.json({ results });
  },
});
