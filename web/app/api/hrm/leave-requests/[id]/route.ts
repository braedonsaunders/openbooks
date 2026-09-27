import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  getLeaveRequest,
  getOwnLeaveRequest,
  leaveToday,
  payrollBankBalances,
  timeBalanceAsOf,
} from "@openbooks/engine/src/hrm/leave-read.ts";
import { can } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { leaveErrorResponse } from "../_lib";

export const runtime = "nodejs";

/**
 * Single leave request with the balances the drawer shows: TIME (policy
 * accrual in hours) and VALUE (payroll banks for the worker) — each labelled
 * with its unit so the two are never conflated. Managers read through the
 * employment gate; self-service reads only the caller's own requests.
 */
export const GET = defineRoute({
  public: "session",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: authz, params: routeParams }) => {
    if (!(await isFeatureEnabled(authz.user.orgId, "hrm"))) {
      return notFound("record");
    }
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "request id must be a uuid" },
        { status: 400 },
      );
    try {
      const request = can(authz, "hrm.leave.read")
        ? await getLeaveRequest({
            orgId: authz.user.orgId,
            actorId: authz.user.id,
            requestId: id,
          })
        : await getOwnLeaveRequest({
            orgId: authz.user.orgId,
            actorId: authz.user.id,
            requestId: id,
          });
      const asOf = await leaveToday(authz.user.orgId);
      const time = await timeBalanceAsOf(
        db,
        authz.user.orgId,
        request.employmentId,
        request.leaveTypeId,
        asOf,
      );
      const value = await payrollBankBalances(
        authz.user.orgId,
        request.workerPartyId,
        { asOf },
      );
      return NextResponse.json({
        request,
        timeBalance: time,
        valueBalances: value,
        asOf,
      });
    } catch (e) {
      return leaveErrorResponse(e);
    }
  },
});
