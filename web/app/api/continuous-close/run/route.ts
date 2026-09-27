import { apiErrorResponse } from '@/lib/api/error-response'
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  isContinuousCloseAgentKey,
  runContinuousCloseAgent,
} from "@openbooks/engine/src/continuous-close/continuous-close.ts";
import { UnrestrictedScopeError } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
const runBody = z.object({ agentKey: z.string().refine(isContinuousCloseAgentKey) });

export const POST = defineRoute({
  permission: "admin.ai.manage",
  feature: "continuousClose",
  body: runBody,
  handler: async ({ body, authz: gate }) => {
  if (!isContinuousCloseAgentKey(body.agentKey)) {
    return NextResponse.json({ error: "invalid_agent" }, { status: 422 });
  }
  let result;
  try {
    // Manual scans are org-wide (detectors plus auto-resolution across every
    // entity): restricted callers are refused by name before anything persists.
    result = await runContinuousCloseAgent({
      orgId: gate.user.orgId,
      agentKey: body.agentKey,
      trigger: "manual",
      initiatedBy: gate.user.id,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    });
  } catch (error) {
    // The scan rechecks the continuousClose switch inside its own write
    // transaction: a disable landing after this route's preflight refuses by
    // name here instead of surfacing as an anonymous 500.
    if ((error as Error).message === "feature_disabled") {
      return NextResponse.json({ error: "feature_disabled" }, { status: 409 });
    }
    if (error instanceof UnrestrictedScopeError) {
      return apiErrorResponse(error);
    }
    throw error;
  }
  return NextResponse.json(result, { status: result.status === "failed" ? 500 : result.status === "skipped" ? 409 : 200 });
  },
});
