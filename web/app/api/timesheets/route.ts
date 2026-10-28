import { authorizeTimeWorkspace, refuseOthersTime, timeWorkFamily } from "@/lib/time-workspace";
import { saveBodySchema, saveTimesheetEntries } from "@/lib/time-entry-write";
import { lockSharedTimeAuthority } from "@openbooks/engine/projects/time-work-target";
import { defineRoute } from "@/lib/api/route";
import { notFound, unprocessable } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { lockScopeRow, ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { isUuid } from "@/lib/list-params";
import { isIsoDate, loadWeek, pinTimekeeper, weekStart, weekWindow } from "./_lib";

export const runtime = "nodejs";

/** GET ?employee=&week= → the week's grid rows + status. */
export const GET = defineRoute({
  authorize: authorizeTimeWorkspace("time.read"),
  feature: {
    none: "The explicit workspace pins Time Tracking or Manufacturing; native commands fence every actual target.",
  },
  handler: async ({ request, authz }) => {
    const orgId = authz.user.orgId;

    const url = new URL(request.url);
    const employee = url.searchParams.get("employee");
    const weekParam = url.searchParams.get("week");
    if (!employee || !isUuid(employee)) return unprocessable("Invalid employee");
    if (!weekParam || !isIsoDate(weekParam)) return unprocessable("Invalid week");

    const ownedEmployee = await pinTimekeeper(orgId, employee, authz.allowedSubsidiaryIds);
    if (!ownedEmployee) return unprocessable("Employee not found");
    // A self-service caller reads only their own week.
    const othersRefused = await refuseOthersTime(authz, "time.read", ownedEmployee);
    if (othersRefused) return othersRefused;
    try {
      return await withOrgTransaction(orgId, async () => {
        const days = weekWindow(weekStart(weekParam));
        await lockSharedTimeAuthority(db, orgId, authz.user.id, {
          employeeId: ownedEmployee,
          from: days[0]!,
          through: days[6]!,
          requestedScope: authz.allowedSubsidiaryIds,
          permission: "time.read",
          workFamily: timeWorkFamily(request),
        });
        await lockScopeRow(db, orgId, "party", ownedEmployee, authz.allowedSubsidiaryIds, "share");
        const payload = await loadWeek(
          orgId,
          ownedEmployee,
          weekStart(weekParam),
          authz.allowedSubsidiaryIds,
        );
        return NextResponse.json(payload);
      });
    } catch (error) {
      if (error instanceof ScopeNotFoundError) return notFound("timesheet week");
      throw error;
    }
  },
});

/**
 * Save the week: replace this employee+week's editable time_entries from the
 * submitted grid. For each grid row × day with hours > 0 we upsert one entry;
 * a row carrying a memo but no hours is an explicit no-hours declaration and
 * persists as one zero-hour entry on the week's Sunday; entries in the week
 * no longer represented are deleted. Only draft/rejected
 * entries are ever touched — approved and submitted entries are left intact so
 * a save never silently overwrites an approval (or an in-flight submission).
 */

const save = defineRoute({
  authorize: authorizeTimeWorkspace("time.manage"),
  feature: {
    none: "The explicit workspace pins Time Tracking or Manufacturing; native commands fence every actual target.",
  },
  body: saveBodySchema,
  invalidBodyStatus: 422,
  handler: saveTimesheetEntries,
});

export const PUT = save;
export const POST = save;
