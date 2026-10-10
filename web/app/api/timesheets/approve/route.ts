import { authorizeTimeWorkspace, timeWorkFamily } from "@/lib/time-workspace";
import { z } from "zod";
import { isoDate, uuidId } from "@/lib/api/json";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { isUuid } from "../../../../lib/list-params";
import { ScopeNotFoundError } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import { approveSubmittedTimeEntries } from "../../../../lib/time-approval";
import { TimeApprovalRefusal } from "../../../../lib/time-approval-refusal";
import { TimeWorkTargetError } from "@openbooks/engine/src/projects/time-work-target.ts";
import { apiErrorResponse } from "@/lib/api/error-response";
import { isIsoDate, loadWeek, pinTimekeeper, weekStart } from "../_lib";
import { notFound } from "@/lib/api/responses";
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
 * POST { employee, week } → approve the week: submitted entries become
 * approved, stamped with the approver and timestamp. Draft entries are left
 * alone (submit them first) so approval is an explicit two-step gate.
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
    const ownedEmployee = await pinTimekeeper(
      orgId,
      body.employee,
      gate.allowedSubsidiaryIds,
    );
    if (!ownedEmployee) return bad("Employee not found");
    const week = weekStart(body.week);

    try {
      await approveSubmittedTimeEntries({
        orgId,
        actorId: user.id,
        employeePartyId: ownedEmployee,
        weekStart: week,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        workFamily: timeWorkFamily(workspaceRequest),
      });
    } catch (error) {
      if (error instanceof ScopeNotFoundError)
        return notFound("record");
      // Designed domain refusals keep their own message, code, remedy and
      // details (mapped by type, never by regex over the message).
      if (error instanceof TimeApprovalRefusal || error instanceof TimeWorkTargetError)
        return apiErrorResponse(error);
      console.error(
        "[timesheets/approve] approval transaction rolled back:",
        error,
      );
      return NextResponse.json(
        {
          error:
            "Time approval could not complete its configured financial effects. No entries were approved.",
        },
        { status: 409 },
      );
    }

    const payload = await loadWeek(
      orgId,
      ownedEmployee,
      week,
      gate.allowedSubsidiaryIds,
    );
    return NextResponse.json(payload);
  },
});
