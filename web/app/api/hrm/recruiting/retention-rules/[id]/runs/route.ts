import { NextResponse } from "next/server";
import { evaluateRetentionRule, listRetentionRuns } from "@openbooks/engine/src/hrm/recruiting/retention.ts";
import { guardPermission } from "../../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../../lib/features";
import { recruitingErrorResponse } from "../../../_lib";

export const runtime = "nodejs";

/**
 * Retention runs: GET lists the run ledger, POST evaluates the rule once
 * (manage gate in the service — the daily tick calls the same service).
 * Every evaluation appends exactly one run row. 404s while hrm,
 * hrmRecruiting, or hrmCandidateRetention is off.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.read");
  if (gate instanceof NextResponse) return gate;
  if (
    !(await isFeatureEnabled(gate.user.orgId, "hrm")) ||
    !(await isFeatureEnabled(gate.user.orgId, "hrmRecruiting")) ||
    !(await isFeatureEnabled(gate.user.orgId, "hrmCandidateRetention"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  try {
    const runs = await listRetentionRuns({ orgId: gate.user.orgId, actorId: gate.user.id, ruleId: id });
    return NextResponse.json({ runs });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  if (
    !(await isFeatureEnabled(gate.user.orgId, "hrm")) ||
    !(await isFeatureEnabled(gate.user.orgId, "hrmRecruiting")) ||
    !(await isFeatureEnabled(gate.user.orgId, "hrmCandidateRetention"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  try {
    const run = await evaluateRetentionRule({ orgId: gate.user.orgId, actorId: gate.user.id, ruleId: id });
    return NextResponse.json({ run }, { status: 201 });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
