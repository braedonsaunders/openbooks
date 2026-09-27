import { z } from "zod";
import { isoDate } from "@/lib/api/json";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { isUuid } from "../../../../lib/list-params";
import { ScopeNotFoundError } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import { approveSubmittedTimeEntries } from "../../../../lib/time-approval";
import { isIsoDate, loadWeek, pinTimesheetEmployee, weekStart } from "../_lib";
import { notFound } from "@/lib/api/responses";
const postBodySchema0 = z.strictObject({
  employee: z.string().uuid("employee must be a valid id"),
  week: isoDate("week must be a valid calendar date"),
});

export { runtime } from "@/lib/api/route";

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
  permission: "time.approve",
  feature: "timeTracking",
  body: postBodySchema0,
  handler: async ({ request: _req, authz: gate, body: routeBody }) => {
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
    const week = weekStart(body.week);

    try {
      await approveSubmittedTimeEntries({
        orgId,
        actorId: user.id,
        employeePartyId: ownedEmployee,
        weekStart: week,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      });
    } catch (error) {
      if (error instanceof ScopeNotFoundError)
        return notFound("record");
      const message = error instanceof Error ? error.message : String(error);
      // Guard rejections carry their own sentence: nothing submitted (422), or
      // the week's approval workflow still owns it (409). Anything else is a
      // failed financial-effects unit, rolled back together.
      if (/already approved/i.test(message)) {
        return NextResponse.json({ error: message }, { status: 409 });
      }
      if (/no submitted entries|timesheet week not found/i.test(message)) {
        return NextResponse.json({ error: message }, { status: 422 });
      }
      if (/pending approval workflow/i.test(message)) {
        return NextResponse.json({ error: message }, { status: 409 });
      }
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
