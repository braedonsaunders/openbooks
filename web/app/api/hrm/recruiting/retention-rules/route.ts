import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  createRetentionRule,
  listRetentionRules,
} from "@openbooks/engine/src/hrm/recruiting/retention.ts";

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
  if (!(await isFeatureEnabled(orgId, "hrmRecruiting"))) return false;
  return isFeatureEnabled(orgId, "hrmCandidateRetention");
}

export const GET = defineRoute({
  permission: "hrm.recruiting.read",
  feature: "hrmCandidateRetention",
  handler: async ({ request: req, authz: gate }) => {
    try {
      const includeInactive =
        new URL(req.url).searchParams.get("includeInactive") === "1";
      const rules = await listRetentionRules({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        includeInactive,
      });
      return NextResponse.json({ rules });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmCandidateRetention",
  body: createRetentionRuleBody,
  handler: async ({ request: req, authz: gate, body: body }) => {
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
  },
});
