import { NextResponse } from "next/server";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import {
  getRetentionOverview,
  getTurnover,
} from "@openbooks/engine/src/hrm/performance/performance-read.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { performanceErrorResponse } from "../review-cycles/_lib";

export const runtime = "nodejs";

/**
 * Retention: the cockpit panel (trailing-twelve-months turnover, the
 * regrettable count, terminated employments missing their exit record, and
 * exit records missing their interview) plus the period-by-department
 * turnover table (?departmentId narrows). HR-only through
 * hrm.retention.read. Monthly periods ending today are derived
 * server-side; the client checks res.ok before parsing.
 */
function monthPeriods(today: string): { start: string; end: string }[] {
  const [y, m] = today.split("-").map(Number);
  const periods: { start: string; end: string }[] = [];
  for (let back = 11; back >= 0; back--) {
    const end = new Date(Date.UTC(y!, m! - 1 - back + 1, 0));
    const start = new Date(Date.UTC(y!, m! - 1 - back, 1));
    periods.push({
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    });
  }
  return periods;
}

export async function GET(req: Request) {
  const gate = await guardPermission("hrm.retention.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const departmentId = new URL(req.url).searchParams.get("departmentId");
  if (departmentId !== null && !isUuid(departmentId)) {
    return NextResponse.json({ error: "departmentId must be a uuid" }, { status: 400 });
  }
  try {
    const today = await businessToday(gate.user.orgId);
    const [overview, turnover] = await Promise.all([
      getRetentionOverview({ orgId: gate.user.orgId, actorId: gate.user.id }),
      getTurnover({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        periods: monthPeriods(today),
        ...(departmentId ? { departmentId } : {}),
      }),
    ]);
    return NextResponse.json({ overview, turnover: turnover.periods });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
