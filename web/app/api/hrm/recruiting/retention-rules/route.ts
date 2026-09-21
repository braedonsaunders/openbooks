import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { createRetentionRule, listRetentionRules } from "@openbooks/engine/src/hrm/recruiting/retention.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { recruitingErrorResponse } from "../_lib";
import { createRetentionRuleBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Retention-rule collection: GET lists rules, POST creates one (manage
 * gate in the service). 404s while hrm, hrmRecruiting, or
 * hrmCandidateRetention is off.
 */
async function depthGate(orgId: string) {
  if (!(await isFeatureEnabled(orgId, "hrm"))) return false;
  if (!(await isFeatureEnabled(orgId, "hrmRecruiting"))) return false;
  return isFeatureEnabled(orgId, "hrmCandidateRetention");
}

export async function GET(req: Request) {
  const gate = await guardPermission("hrm.recruiting.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await depthGate(gate.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
    const rules = await listRetentionRules({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      includeInactive,
    });
    return NextResponse.json({ rules });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await depthGate(gate.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createRetentionRuleBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const rule = await createRetentionRule({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      name: body.name,
      regionScope: body.regionScope,
      basis: body.basis,
      retainMonths: body.retainMonths,
      action: body.action,
      consentExtensionLeadDays: body.consentExtensionLeadDays,
    });
    return NextResponse.json({ rule }, { status: 201 });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
