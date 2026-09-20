import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  getLeaveRequest,
  getOwnLeaveRequest,
  leaveToday,
  payrollBankBalances,
  timeBalanceAsOf,
} from "@openbooks/engine/src/hrm/leave-read.ts";
import { can, getAuthz } from "../../../../../lib/authz";
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
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await isFeatureEnabled(authz.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "request id must be a uuid" }, { status: 400 });
  try {
    const request = can(authz, "hrm.leave.read")
      ? await getLeaveRequest({ orgId: authz.user.orgId, actorId: authz.user.id, requestId: id })
      : await getOwnLeaveRequest({ orgId: authz.user.orgId, actorId: authz.user.id, requestId: id });
    const asOf = await leaveToday(authz.user.orgId);
    const time = await timeBalanceAsOf(db, authz.user.orgId, request.employmentId, request.leaveTypeId, asOf);
    const value = await payrollBankBalances(authz.user.orgId, request.workerPartyId, { asOf });
    return NextResponse.json({ request, timeBalance: time, valueBalances: value, asOf });
  } catch (e) {
    return leaveErrorResponse(e);
  }
}
