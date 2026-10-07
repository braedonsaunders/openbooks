import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { isUuid } from "../../../../lib/list-params";
import { ScopeNotFoundError } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import {
  amendLockedWeek,
  amendTimeEntry,
} from "../../../../lib/time-amendment";
import {
  isIsoDate,
  loadWeek,
  pinTimesheetEmployee,
  pinTimesheetEntryEmployee,
  weekStart,
} from "../_lib";
import { notFound } from "@/lib/api/responses";
const postBodySchema0 = z.union([
  z.strictObject({ entryId: uuidId }),
  z.strictObject({
    employee: uuidId,
    week: isoDate("week must be a valid calendar date"),
  }),
]);

export const runtime = "nodejs";

/**
 * POST { entryId } or { employee, week } → create offsetting draft entries
 * that amend consumed originals. Used when reopen is refused because the
 * hours are already invoiced, paid, costed or ticketed.
 */
export const POST = defineRoute({
  permission: "time.reopen",
  feature: "timeTracking",
  body: postBodySchema0,
  handler: async ({ request: _req, authz: gate, body: routeBody }) => {
    const body = routeBody as {
      entryId?: string;
      employee?: string;
      week?: string;
    };
    try {
      if (body.entryId) {
        if (!isUuid(body.entryId)) {
          return NextResponse.json({ error: "Invalid entry" }, { status: 422 });
        }
        const sourceEmployee = await pinTimesheetEntryEmployee(
          gate.user.orgId,
          body.entryId,
          gate.allowedSubsidiaryIds,
        );
        if (!sourceEmployee) {
          return NextResponse.json(
            { error: "Entry not found" },
            { status: 422 },
          );
        }
        const result = await amendTimeEntry(
          gate.user.orgId,
          gate.user.id,
          body.entryId,
          gate.allowedSubsidiaryIds,
        );
        return NextResponse.json(result, { status: 201 });
      }
      if (!body.employee || !isUuid(body.employee)) {
        return NextResponse.json(
          { error: "Invalid employee" },
          { status: 422 },
        );
      }
      if (!body.week || !isIsoDate(body.week)) {
        return NextResponse.json({ error: "Invalid week" }, { status: 422 });
      }
      const ownedEmployee = await pinTimesheetEmployee(
        gate.user.orgId,
        body.employee,
        gate.allowedSubsidiaryIds,
      );
      if (!ownedEmployee) {
        return NextResponse.json(
          { error: "Employee not found" },
          { status: 422 },
        );
      }
      const week = weekStart(body.week);
      const result = await amendLockedWeek(
        gate.user.orgId,
        gate.user.id,
        ownedEmployee,
        week,
        gate.allowedSubsidiaryIds,
      );
      const payload = await loadWeek(
        gate.user.orgId,
        ownedEmployee,
        week,
        gate.allowedSubsidiaryIds,
      );
      return NextResponse.json({ ...payload, ...result }, { status: 201 });
    } catch (e) {
      if (e instanceof ScopeNotFoundError)
        return notFound("record");
      return apiErrorResponse(e);
    }
  },
});
