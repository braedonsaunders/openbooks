import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import { leaveToday, leaveBalancesForEmployment } from "@openbooks/engine/hrm/leave-read";
import { subHours } from "@openbooks/engine/hrm/leave-math";
import { guardPermission } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { leaveErrorResponse } from "../leave-requests/_lib";

export const runtime = "nodejs";

const EXACT_HOURS = /^-?\d+(\.\d{1,2})?$/;

/**
 * Per-employee, per-leave-type balances for the record-absence form:
 * entitlement, taken, pending and remaining as of a date, read through the
 * same entitlement engine the filing gate uses. With hours and leaveTypeId
 * the response also carries the exact remaining-after effect, computed here
 * with the native decimal math — never client floats. Readers and
 * recorders both read it; the engine re-checks the employment.
 */
export const GET = defineRoute({
  authorize: async () => {
    const read = await guardPermission("hrm.leave.read");
    return read instanceof NextResponse && read.status === 403
      ? await guardPermission("hrm.leave.manage")
      : read;
  },
  feature: "hrm",
  handler: async ({ request: req, authz: gate }) => {
    const url = new URL(req.url);
    const employmentId = url.searchParams.get("employmentId");
    if (!employmentId || !isUuid(employmentId)) {
      return NextResponse.json({ error: "employmentId must be a valid id" }, { status: 400 });
    }
    const asOfParam = url.searchParams.get("asOf");
    const hoursParam = url.searchParams.get("hours");
    const leaveTypeId = url.searchParams.get("leaveTypeId");
    if (leaveTypeId !== null && !isUuid(leaveTypeId)) {
      return NextResponse.json({ error: "leaveTypeId must be a valid id" }, { status: 400 });
    }
    if (hoursParam !== null && !EXACT_HOURS.test(hoursParam)) {
      return NextResponse.json(
        { error: "hours must be an exact decimal with at most 2 fraction digits" },
        { status: 400 },
      );
    }
    try {
      const asOf = asOfParam ?? (await leaveToday(gate.user.orgId));
      const balances = await leaveBalancesForEmployment(
        db,
        gate.user.orgId,
        gate.user.id,
        employmentId,
        asOf,
      );
      let effect: { leaveTypeId: string; remainingAfter: string | null } | null = null;
      if (leaveTypeId !== null && hoursParam !== null) {
        const current = balances.find((entry) => entry.leaveTypeId === leaveTypeId);
        effect = {
          leaveTypeId,
          remainingAfter:
            current && current.remaining !== null ? subHours(current.remaining, hoursParam) : null,
        };
      }
      return NextResponse.json({ balances, asOf, effect });
    } catch (e) {
      return leaveErrorResponse(e);
    }
  },
});
