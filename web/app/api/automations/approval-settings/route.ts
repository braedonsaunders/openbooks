import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { saveApprovalSettings } from "@openbooks/engine/src/automations/services.ts";
import { loadApprovalSettings } from "@openbooks/engine/src/automations/approvals.ts";
import { approvalSettingsBody } from "../bodies";
import { automationErrorResponse } from "../_lib";


export const runtime = "nodejs";

/** Exception-only approval tuning per subject kind (a setting, not a feature). */
export const GET = defineRoute({
  permission: "automations.read",
  feature: "automations",
  handler: async ({ request: req, authz: gate }) => {
    const url = new URL(req.url);
    const subjectKind = url.searchParams.get("subject");
    if (!subjectKind)
      return NextResponse.json(
        { error: "subject is required" },
        { status: 400 },
      );
    try {
      const settings = await loadApprovalSettings(gate.user.orgId, subjectKind);
      return NextResponse.json({ settings });
    } catch (e) {
      return automationErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "automations.manage",
  feature: "automations",
  body: approvalSettingsBody,
  handler: async ({ request: _req, authz: gate, body: routeBody }) => {
    const body = routeBody;
    try {
      const settings = await saveApprovalSettings({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        subjectKind: body.subjectKind,
        exceptionOnly: body.exceptionOnly,
        ...(body.thresholds
          ? { thresholds: body.thresholds as Record<string, unknown> }
          : {}),
        ...(body.autoApproveWhenNoRule != null
          ? { autoApproveWhenNoRule: body.autoApproveWhenNoRule }
          : {}),
        ...(body.delegateAfterDays !== undefined
          ? { delegateAfterDays: body.delegateAfterDays }
          : {}),
        ...(body.excludeInitiator != null
          ? { excludeInitiator: body.excludeInitiator }
          : {}),
      });
      return NextResponse.json({ settings });
    } catch (e) {
      return automationErrorResponse(e);
    }
  },
});
