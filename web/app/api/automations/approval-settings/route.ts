import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { saveApprovalSettings } from "@openbooks/engine/src/automations/services.ts";
import { loadApprovalSettings } from "@openbooks/engine/src/automations/approvals.ts";
import { guardPermission } from "../../../lib/authz";
import { isFeatureEnabled } from "../../../lib/features";
import { approvalSettingsBody } from "../bodies";
import { automationErrorResponse } from "../_lib";

export const runtime = "nodejs";

/** Exception-only approval tuning per subject kind (a setting, not a feature). */
export async function GET(req: Request) {
  const gate = await guardPermission("automations.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "automations"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const subjectKind = url.searchParams.get("subject");
  if (!subjectKind) return NextResponse.json({ error: "subject is required" }, { status: 400 });
  try {
    const settings = await loadApprovalSettings(gate.user.orgId, subjectKind);
    return NextResponse.json({ settings });
  } catch (e) {
    return automationErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("automations.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "automations"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, approvalSettingsBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const settings = await saveApprovalSettings({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      subjectKind: body.subjectKind,
      exceptionOnly: body.exceptionOnly,
      ...(body.thresholds ? { thresholds: body.thresholds as Record<string, unknown> } : {}),
      ...(body.autoApproveWhenNoRule != null ? { autoApproveWhenNoRule: body.autoApproveWhenNoRule } : {}),
      ...(body.delegateAfterDays !== undefined ? { delegateAfterDays: body.delegateAfterDays } : {}),
      ...(body.excludeInitiator != null ? { excludeInitiator: body.excludeInitiator } : {}),
    });
    return NextResponse.json({ settings });
  } catch (e) {
    return automationErrorResponse(e);
  }
}
